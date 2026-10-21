"""Bounded actual-audio research observer, never a professional review qualification.

Consumes local audio jobs; retains raw model prose plus exact input/forward receipts.
Existing MusicFlamingoObserver handles the validated NF4/CPU-encoder load path.
No transcript/JSON repair, source identity inference, or human approval is performed.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time


def sha(file):
    result = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_cli


@gpu_slot_guard(lambda: 'cuda:0', lambda: slot_binding_from_cli())
def main():
    parser = argparse.ArgumentParser()
    add_slot_arguments(parser)
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--weights", required=True)
    parser.add_argument("--deps", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    supplied = json.loads(Path(args.jobs).read_text("utf-8-sig"))
    jobs = supplied.get("jobs", [])
    if not jobs or len(jobs) > 16:
        raise ValueError("a bounded batch of 1-16 local audio windows is required")
    if len({row.get("id") for row in jobs}) != len(jobs):
        raise ValueError("unique job IDs required")
    out = Path(args.output).resolve()
    if out.exists():
        raise ValueError("preserve old outputs; use a new run directory")
    out.mkdir(parents=True)
    from music_flamingo_runtime import MusicFlamingoObserver
    import numpy as np
    import soundfile as sf
    observer = MusicFlamingoObserver(args.weights, args.deps, max_new_tokens=160, max_job_seconds=45)
    prompt = ("This input is mono audio. In at most 70 words, report audible speech, singing or wordless "
              "vocals, music, and physical sound effects or silence. Mention whether music changes or "
              "stays steady and whether transient effects are foreground or quiet. Do not infer a plot, "
              "lyrics you cannot hear, stereo placement, a song identity, or aesthetic approval. "
              "Say uncertain where needed. Use short plain prose.")
    report = {"schema_version": 1, "status": "running", "qualified": False,
              "qualification_scope": "unverified_actual_audio_research_observations",
              "audio_review_accepted": False, "professional_review_available": False,
              "downloads": 0, "cloud_uploads": 0, "paid_calls": 0,
              "jobs_binding": {"path": str(Path(args.jobs).resolve()), "sha256": sha(args.jobs)},
              "runtime_script_binding": {"path": str(Path(__file__).resolve()), "sha256": sha(__file__)},
              "observer_binding": observer.binding, "prompt": prompt, "jobs": []}
    write(out / "report.json", report)
    started = time.monotonic()
    for job in jobs:
        source = Path(job["path"]).resolve()
        digest = sha(source)
        if job.get("sha256", job.get("input_sha256")) not in (None, digest):
            raise ValueError("audio source SHA changed")
        bounds = job.get("source_range")
        if bounds is not None and (len(bounds) != 2 or not all(math.isfinite(x) for x in bounds)
                                  or bounds[0] < 0 or not 0 < bounds[1] - bounds[0] <= 30):
            raise ValueError("source window must have positive finite duration <=30 seconds")
        identity = hashlib.sha256(str(job["id"]).encode("utf-8")).hexdigest()[:16]
        prepared = out / "inputs" / f"{identity}.wav"
        prepared.parent.mkdir(exist_ok=True)
        command = [args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        if bounds is not None:
            command += ["-ss", str(bounds[0])]
        command += ["-i", str(source)]
        if bounds is not None:
            command += ["-t", str(bounds[1] - bounds[0])]
        command += ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", str(prepared)]
        subprocess.run(command, check=True, capture_output=True, timeout=60)
        wave, rate = sf.read(prepared, dtype="float32", always_2d=False)
        if rate != 16000 or wave.ndim != 1 or not 0 < len(wave) <= 480000 or not np.isfinite(wave).all():
            raise ValueError("prepared audio violates bounded PCM contract")
        if bounds is not None and abs(len(wave) - round((bounds[1] - bounds[0]) * rate)) > 1:
            raise ValueError("complete requested input window was not decoded")
        peak = float(np.max(np.abs(wave)))
        rms = float(np.sqrt(np.mean(np.square(wave, dtype=np.float64))))
        row = {"id": job["id"], "source_binding": {"path": str(source), "sha256": digest},
               "source_range": bounds or [0, len(wave) / rate],
               "input_audio": {"path": str(prepared), "sha256": sha(prepared),
                               "sample_rate": rate, "samples": len(wave),
                               "pcm_sha256": hashlib.sha256(wave.astype("<f4").tobytes()).hexdigest()},
               "objective_pcm": {"digital_zero": not bool(np.any(wave)), "peak": peak, "rms": rms,
                                 "peak_dbfs": 20 * math.log10(max(peak, 1e-12)),
                                 "rms_dbfs": 20 * math.log10(max(rms, 1e-12))}}
        began = time.monotonic()
        try:
            row.update(observer.observe(wave, prompt))
            row["status"] = "observed_pending_validation"
        except Exception as error:
            row.update(status="failed", failure={"type": type(error).__name__, "message": str(error)})
        row["elapsed_seconds"] = time.monotonic() - began
        if sha(source) != digest:
            raise ValueError("source changed while executing actual audio observer")
        row["qualified"] = False
        report["jobs"].append(row)
        report["elapsed_seconds"] = time.monotonic() - started
        write(out / "report.json", report)
        print(json.dumps({"id": row["id"], "status": row["status"],
                          "actual_audio_processed": row.get("execution", {}).get("actual_audio_processed", False),
                          "elapsed_seconds": row["elapsed_seconds"]}), flush=True)
    report["status"] = "actual_audio_batch_complete_pending_validation"
    report["actual_observation_count"] = sum(row.get("execution", {}).get("actual_audio_processed") is True
                                             for row in report["jobs"])
    write(out / "report.json", report)


if __name__ == "__main__":
    main()
