"""Observe actual candidate windows, cache raw predictions, never select music.

Accepts the jobs produced by prepare_candidate_windows.py, including its cue map.
Only the provider receives PCM and a neutral prompt; story and asset names stay out.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import time

import numpy as np
import soundfile as sf

PROMPT = ("Describe the audio excerpt in ordinary prose. Focus on the dominant sound sources, "
          "the rhythmic foundation or absence of a pulse, recurring musical phrases and any audible development, "
          "and whether a voice is present and how it is delivered. State what is uncertain. "
          "Do not infer a video, story, title or artist. Do not transcribe lyrics, give numerical tempo "
          "or exact timestamps, or assess artistic suitability. Keep the description concise.")
PREPROCESS = {"sampling_rate_hz": 16000, "channels": 1, "dtype": "little_endian_float32",
              "gain": "only_limit_peak_above_0.85", "padding": "none"}


def sha_file(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def json_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def decode_job(job):
    if any(not isinstance(job.get(key), str) or not job[key].strip()
           for key in ("segment_id", "asset_id", "path")):
        raise ValueError("actual_window_job_identity_required")
    window = job.get("source_range")
    if (not isinstance(window, list) or len(window) != 2
            or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in window)
            or not 0 <= window[0] < window[1] or window[1] - window[0] > 30):
        raise ValueError("source_window_must_be_positive_and_at_most_30_seconds")
    path = Path(job["path"]).resolve(strict=True)
    expected_sha = job.get("source_sha256")
    if not re.fullmatch("[0-9a-f]{64}", str(expected_sha)) or sha_file(path) != expected_sha:
        raise ValueError("source_file_sha256_mismatch")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "2", "-i", str(path),
        "-ss", str(window[0]), "-t", str(window[1] - window[0]), "-map", "0:a:0", "-ar", "16000",
        "-ac", "1", "-f", "f32le", "pipe:1"], check=True, capture_output=True, timeout=45).stdout
    wave = np.frombuffer(raw, dtype="<f4").copy()
    if (not 0 < len(wave) <= 30 * 16000 or not np.isfinite(wave).all()
            or abs(len(wave) - round((window[1] - window[0]) * 16000)) > 1):
        raise ValueError("actual_pcm_length_or_finiteness_mismatch")
    peak = float(np.max(np.abs(wave)))
    gain = min(1.0, .85 / peak) if peak else 1.0
    if gain != 1.0:
        wave = (wave * gain).astype("<f4")
    if sha_file(path) != expected_sha:
        raise ValueError("source_changed_during_decode")
    return wave, {"segment_id": job["segment_id"], "asset_id": job["asset_id"], "source_path": str(path),
                  "source_sha256": expected_sha, "source_range": window, "sample_rate_hz": 16000,
                  "samples": len(wave), "gain_applied": gain,
                  "pcm_sha256": hashlib.sha256(wave.tobytes()).hexdigest(),
                  "signal": {"exact_zero": not bool(np.any(wave)), "peak": float(np.max(np.abs(wave))),
                             "rms": float(np.sqrt(np.mean(wave.astype("float64") ** 2)))}}


def checked_prediction(prediction, pcm_sha):
    execution = prediction.get("execution", {})
    if (not isinstance(prediction.get("raw_observation"), str) or not prediction["raw_observation"].strip()
            or execution.get("actual_audio_processed") is not True
            or execution.get("processor_pcm_sha256") != pcm_sha
            or any(type(execution.get(k)) is not int or execution[k] < 1
                   for k in ("encoder_forward_count", "head_forward_count"))
            or not isinstance(prediction.get("generation_termination"), dict)
            or any(type(prediction["generation_termination"].get(k)) is not bool for k in (
                "max_tokens_reached", "max_time_threshold_reached", "last_token_is_configured_eos"))):
        raise ValueError("actual_input_and_forward_prediction_evidence_required")
    # Provider text and additional fields cannot grant qualifications or decisions.
    return {key: prediction[key] for key in ("raw_observation", "execution", "generation_termination")}


def completion_status(prediction):
    stop = prediction["generation_termination"]
    return ("complete" if stop["last_token_is_configured_eos"] and not stop["max_tokens_reached"]
            and not stop["max_time_threshold_reached"] else "incomplete")


def preserved_input(cache_dir, key, wave, pcm_sha):
    path = (cache_dir / (key + ".wav")).resolve()
    if not path.exists():
        sf.write(path, wave, 16000, subtype="FLOAT")
    saved, rate = sf.read(path, dtype="float32")
    if (rate != 16000 or saved.ndim != 1 or len(saved) != len(wave)
            or hashlib.sha256(saved.astype("<f4").tobytes()).hexdigest() != pcm_sha):
        raise ValueError("preserved_actual_input_pcm_mismatch")
    return {"path": str(path), "sha256": sha_file(path), "samples": len(saved),
            "sample_rate_hz": rate, "pcm_sha256": pcm_sha}


def warnings(prediction, signal):
    text = prediction["raw_observation"]
    notes = ["unqualified_model_prediction"]
    if (not signal["exact_zero"] and re.search(r"\bsilent\b|\bno audible (?:sound|audio)\b|\bno sound", text, re.I)):
        notes.append("nonzero_pcm_model_mentions_silence_requires_review")
    if re.search(r"\bstereo\b", text, re.I):
        notes.append("mono_input_model_mentions_stereo_requires_review")
    if re.search(r"\b\d+(?:\.\d+)?\s*bpm\b", text, re.I):
        notes.append("model_reported_unrequested_unverified_numeric_tempo")
    termination = prediction["generation_termination"]
    if termination.get("max_tokens_reached") or termination.get("max_time_threshold_reached"):
        notes.append("generation_budget_reached_observation_may_be_incomplete")
    if not termination["last_token_is_configured_eos"]:
        notes.append("generation_did_not_end_with_eos")
    return notes


def observe_jobs(jobs_path, provider, cache_dir, output_path=None):
    started = time.monotonic()
    jobs_path, cache_dir = Path(jobs_path).resolve(strict=True), Path(cache_dir)
    jobs_bytes = jobs_path.read_bytes()
    document = json.loads(jobs_bytes.decode("utf-8-sig"))
    jobs = document.get("jobs")
    if (document.get("schema_version") != 1 or not isinstance(jobs, list) or not 1 <= len(jobs) <= 20
            or any(not isinstance(job, dict) for job in jobs)
            or len({job.get("segment_id") for job in jobs}) != len(jobs)):
        raise ValueError("one_to_twenty_unique_actual_window_jobs_required")
    if output_path is not None and Path(output_path).exists():
        raise FileExistsError("use_a_new_report_path")
    if not isinstance(provider.binding, dict) or not provider.binding:
        raise ValueError("actual_provider_binding_required")
    ffmpeg = subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True, timeout=10).stdout.splitlines()[0].decode()
    binding = json.loads(json.dumps(provider.binding, allow_nan=False))
    preprocess = {**PREPROCESS, "decoder_version": ffmpeg}
    prompt_sha = hashlib.sha256(PROMPT.encode()).hexdigest()
    result = {"schema_version": 1, "jobs_file": {"path": str(jobs_path), "sha256": hashlib.sha256(jobs_bytes).hexdigest()},
              "binding": binding, "prompt": PROMPT, "prompt_sha256": prompt_sha, "preprocessing": preprocess,
              "scope": "raw_music_observations_not_director_decisions", "records": [], "model_calls": 0,
              "cache_hits": 0, "qualified": False, "scopes": [], "selected": False,
              "artistic_approval": False, "generation_calls": 0, "cloud_uploads": 0}
    cache_dir.mkdir(parents=True, exist_ok=True)
    for job in jobs:
        wave, identity = decode_job(job)
        inputs = {"pcm_sha256": identity["pcm_sha256"], "binding": binding,
                  "prompt_sha256": prompt_sha, "preprocessing": preprocess}
        key, hit, completion_derived = json_sha(inputs), False, False
        cached = cache_dir / (key + ".json")
        if cached.exists():
            entry = json.loads(cached.read_text("utf-8"))
            if (entry.get("inputs") != inputs or entry.get("cache_key") != key
                    or entry.get("prediction_sha256") != json_sha(entry.get("prediction"))):
                raise ValueError("cache_identity_or_prediction_integrity_mismatch")
            prediction, hit = checked_prediction(entry["prediction"], identity["pcm_sha256"]), True
            completion_derived = "completion_status" not in entry
            if entry.get("completion_status", completion_status(prediction)) != completion_status(prediction):
                raise ValueError("cache_completion_state_mismatch")
            result["cache_hits"] += 1
        else:
            prediction = checked_prediction(provider.observe(wave, PROMPT), identity["pcm_sha256"])
            result["model_calls"] += 1
            with cached.open("x", encoding="utf-8") as stream:
                json.dump({"cache_key": key, "inputs": inputs, "prediction": prediction,
                           "completion_status": completion_status(prediction),
                           "prediction_sha256": json_sha(prediction)}, stream, ensure_ascii=False, indent=2, allow_nan=False)
        if sha_file(identity["source_path"]) != identity["source_sha256"]:
            raise ValueError("source_changed_during_observation")
        result["records"].append({**identity, **prediction, "cache_key": key, "cache_hit": hit,
            "input_audio": preserved_input(cache_dir, key, wave, identity["pcm_sha256"]),
            "completion_status": completion_status(prediction),
            "cache_completion_metadata_derived_from_original_termination": completion_derived,
            "warnings": warnings(prediction, identity["signal"]), "qualified": False, "scopes": [],
            "selected": False, "artistic_approval": False})
    if sha_file(jobs_path) != result["jobs_file"]["sha256"]:
        raise ValueError("jobs_changed_during_observation")
    incomplete = sum(row["completion_status"] == "incomplete" for row in result["records"])
    result.update(status="needs_observation_repair" if incomplete else "observed_pending_director_review",
                  incomplete_observations=incomplete, elapsed_seconds=time.monotonic() - started)
    if output_path is not None:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return result


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_cli


@gpu_slot_guard(lambda: 'cuda:0', lambda: slot_binding_from_cli())
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_slot_arguments(parser)
    for name in ("jobs", "weights", "deps", "cache", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    from music_flamingo_runtime import MusicFlamingoObserver
    result = observe_jobs(args.jobs, MusicFlamingoObserver(args.weights, args.deps), args.cache, args.out)
    print(json.dumps({"out": str(args.out.resolve()), "model_calls": result["model_calls"],
                      "cache_hits": result["cache_hits"], "selected": False}))


if __name__ == "__main__":
    main()
