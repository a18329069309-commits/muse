"""Offline SenseVoice/Silero analysis of a prepared episode; no word alignment.

Uses existing packages and a complete local SenseVoice model directory. This is
analysis only: no audio generation, network requests, or artistic approval.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import time


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_args


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--manifest", type=Path, required=True)
    result.add_argument("--model-dir", type=Path, required=True)
    result.add_argument("--out", type=Path, required=True)
    result.add_argument("--device", default="cpu")
    add_slot_arguments(result)
    result.add_argument("--language", choices=("auto", "zh", "en", "yue", "ja", "ko"), default="auto")
    return result


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepared_audio(root, value):
    if not isinstance(value, str) or not value:
        raise ValueError("Manifest must name prepared local audio.")
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Prepared audio must exist inside the manifest directory.")
    return path


def preflight(args):
    if not re.fullmatch(r"cpu|cuda(?::\d+)?", args.device):
        raise ValueError("Device must be cpu, cuda, or cuda:N.")
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or manifest.get("has_source_audio") is not True:
        raise ValueError("A prepared v1 manifest with source audio is required.")
    if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("source_sha256", "")):
        raise ValueError("Manifest requires a source SHA-256.")
    timeline = manifest.get("timeline", {})
    samples = timeline.get("duration_samples")
    if timeline.get("sample_rate") != 48000 or type(samples) is not int or samples <= 0:
        raise ValueError("Manifest requires a positive integer 48 kHz timeline.")
    duration = manifest.get("video", {}).get("duration_seconds")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or abs(duration - samples / 48000) > 1 / 48000:
        raise ValueError("Video duration and audio timeline disagree.")
    original = prepared_audio(manifest_path.parent, manifest.get("original_audio"))
    analysis = prepared_audio(manifest_path.parent, manifest.get("analysis_audio"))
    model = args.model_dir.resolve()
    weights = model / "model.pt"
    if not model.is_dir() or not weights.is_file() or weights.stat().st_size == 0:
        raise ValueError("An existing nonempty local model.pt is required; downloads are disabled.")
    out = args.out.resolve()
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError("Output directory must be empty; use a new directory.")
    return manifest, original, analysis, model, out


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def analyze(args):
    manifest, original, audio, model_dir, out = preflight(args)
    for key in ("HF_HUB_OFFLINE", "MODELSCOPE_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        os.environ[key] = "1"
    import numpy as np
    import soundfile as sf
    import torch
    from funasr import AutoModel
    from silero_vad import load_silero_vad, get_speech_timestamps

    data, rate = sf.read(audio, dtype="float32")
    info = sf.info(original)
    sample_count = manifest["timeline"]["duration_samples"]
    if rate != 16000 or data.ndim != 1 or abs(len(data) - round(sample_count / 3)) > 1:
        raise ValueError("Analysis audio must be 16 kHz mono with the prepared duration.")
    if info.samplerate != 48000 or info.channels != 2 or info.frames != sample_count:
        raise ValueError("Original audio must match the manifest: 48 kHz stereo, exact sample count.")
    if not np.all(np.isfinite(data)):
        raise ValueError("Analysis audio contains nonfinite samples.")
    versions = {name: importlib.metadata.version(name) for name in ("funasr", "silero-vad", "torch", "soundfile", "numpy")}
    identity = {"source_video_sha256": manifest["source_sha256"],
                "source_identity_basis": "prepared_manifest; source video not rehashed by this tool",
                "analysis_audio_sha256": sha256(audio), "original_audio_sha256": sha256(original),
                "manifest_sha256": sha256(args.manifest.resolve())}
    model_identity = {"model_directory": str(model_dir), "model_sha256": sha256(model_dir / "model.pt"),
                      "package_versions": versions, "device": args.device, "language_setting": args.language,
                      "offline": True, "trust_remote_code": False}
    out.mkdir(parents=True, exist_ok=True)
    peak, square_sum, over = 0.0, 0.0, 0
    windows = []
    with sf.SoundFile(original) as stream:
        for index, block in enumerate(stream.blocks(blocksize=48000, dtype="float32", always_2d=True)):
            if not np.all(np.isfinite(block)):
                raise ValueError("Original audio contains nonfinite samples.")
            absolute = np.abs(block)
            block_sum = float(np.sum(block.astype("float64") ** 2))
            block_peak = float(absolute.max())
            peak = max(peak, block_peak)
            square_sum += block_sum
            over += int(np.sum(absolute > 1))
            windows.append({"start_seconds": index, "end_seconds": min(index + len(block) / 48000, sample_count / 48000),
                            "rms_dbfs": 10 * math.log10(max(block_sum / block.size, 1e-24)), "sample_peak": block_peak})
    write_json(out / "audio-analysis.json", {**identity, "sample_rate": 48000, "channels": 2,
        "samples_per_channel": sample_count, "original_subtype": info.subtype,
        "sample_peak_linear": peak, "sample_peak_dbfs": 20 * math.log10(max(peak, 1e-12)),
        "rms_dbfs": 10 * math.log10(max(square_sum / (sample_count * 2), 1e-24)),
        "samples_over_full_scale": over, "bgm_sfx_presence": "unknown_no_auditory_verification",
        "one_second_windows": windows})
    torch.set_num_threads(2)
    started = time.perf_counter()
    vad = load_silero_vad().eval()
    timestamps = get_speech_timestamps(torch.from_numpy(data), vad, sampling_rate=rate,
        threshold=0.5, min_speech_duration_ms=250, min_silence_duration_ms=100,
        speech_pad_ms=30, return_seconds=False)
    intervals = [{"start_seconds": item["start"] / rate, "end_seconds": item["end"] / rate} for item in timestamps]
    write_json(out / "dialogue-activity.json", {**identity, "model": "silero-vad", "package_version": versions["silero-vad"],
        "device": "cpu", "status": "automatically_detected_not_human_reviewed", "word_alignment": False,
        "wall_seconds": time.perf_counter() - started, "dialogue_intervals": intervals,
        "detected_speech_seconds": sum(item["end_seconds"] - item["start_seconds"] for item in intervals),
        "limitations": "Speech-like activity includes narration and can miss or falsely detect dialogue."})
    del vad
    started = time.perf_counter()
    model = AutoModel(model=str(model_dir), device=args.device, ncpu=2,
        trust_remote_code=False, disable_update=True, disable_pbar=True, disable_log=True)
    load_seconds = time.perf_counter() - started
    started = time.perf_counter()
    segments = []
    for begin in range(0, len(data), int(11.5 * rate)):
        end = min(begin + 12 * rate, len(data))
        result = model.generate(input=data[begin:end], fs=rate, cache={}, language=args.language,
            use_itn=True, batch_size=1, disable_pbar=True)
        raw = result[0].get("text", "") if result else ""
        segments.append({"chunk_start_seconds": begin / rate, "chunk_end_seconds": end / rate,
            "raw_text": raw, "text": re.sub(r"<\|[^|]+\|>", "", raw).strip(),
            "verification": "machine_transcript_not_manually_verified"})
    write_json(out / "transcript.json", {"schema_version": 1, **identity, **model_identity,
        "model_load_wall_seconds": load_seconds, "transcription_wall_seconds": time.perf_counter() - started,
        "audio_duration_seconds": len(data) / rate, "timestamp_precision": "chunk_bounds_only_not_word_or_action_alignment",
        "segments": segments, "notes": ["Overlapping chunks can repeat or truncate words; proper names need review.",
            "ASR language, emotion and event tags do not establish plot, BGM/SFX presence, or music quality.",
            "No words or action timestamps are inferred from chunk boundaries."]})
    summary = {"status": "local_machine_analysis_complete_not_listening_approved", **identity, **model_identity,
               "duration_seconds": sample_count / 48000, "asr_chunks": len(segments), "vad_intervals": len(intervals),
               "outputs": ["audio-analysis.json", "dialogue-activity.json", "transcript.json"], "network_submission": False}
    write_json(out / "analysis-report.json", summary)
    print(json.dumps({"status": summary["status"], "duration_seconds": summary["duration_seconds"],
                      "asr_chunks": len(segments), "language": args.language}, ensure_ascii=False))


if __name__ == "__main__":
    analyze(parser().parse_args())
