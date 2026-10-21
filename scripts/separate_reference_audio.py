"""Bounded BandIt v2 reference separation using an existing inference implementation.

Outputs are analysis candidates, not approved music or verified singing stems.
The supplied model directory contains the upstream bandit_v2 Python package.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_inputs(args):
    if not 0 <= args.start < args.end or args.end - args.start > 30:
        raise ValueError("Require an actual source window of at most 30 seconds")
    for path in (args.input, args.weights, args.config):
        if not Path(path).is_file():
            raise ValueError("Required local input is absent: " + str(path))
    if sha256(args.weights) != args.weights_sha256:
        raise ValueError("Checkpoint SHA256 mismatch; do not load")
    if not (Path(args.model_dir) / "bandit_v2/bandit.py").is_file():
        raise ValueError("An existing BandIt v2 inference model package is required")
    if Path(args.out).exists() and any(Path(args.out).iterdir()):
        raise ValueError("Use a new empty output directory")


def decode_window(source, start, end, rate=48000):
    command = ["ffmpeg", "-v", "error", "-nostdin", "-ss", str(start),
               "-i", str(source), "-t", str(end-start), "-map", "0:a:0",
               "-af", f"aresample={rate}:async=1:first_pts=0", "-ac", "2",
               "-f", "f32le", "pipe:1"]
    return subprocess.run(command, capture_output=True, check=True, timeout=60).stdout


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_args


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def separate(args):
    validate_inputs(args)
    import numpy as np
    import soundfile as sf
    import torch
    import yaml

    sys.path.insert(0, str(Path(args.model_dir).resolve()))
    # Import only the inference model; no training service or platform CLI.
    from bandit_v2.bandit import Bandit

    started = time.perf_counter()
    torch.set_num_threads(2)
    config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    if config["kwargs"]["stems"] != ["speech", "music", "sfx"]:
        raise ValueError("Expected the documented cinematic three-stem model")
    model = Bandit(**config["kwargs"])
    # Only the explicitly hash-verified, author-hosted checkpoint is loaded.
    checkpoint = torch.load(args.weights, map_location="cpu", weights_only=False)
    state = checkpoint.get("state_dict", checkpoint)
    if any(key.startswith("model.") for key in state):
        state = {key.removeprefix("model."): value for key, value in state.items()
                 if key.startswith("model.")}
    model.load_state_dict(state, strict=True)
    model.to(args.device).eval()
    del checkpoint, state
    rate = int(config["audio"]["sample_rate"])
    if rate != 48000:
        raise ValueError("Reference adapter requires the documented 48kHz model")
    encoded = decode_window(args.input, args.start, args.end, rate)
    mix = np.frombuffer(encoded, dtype="<f4").reshape(-1, 2).copy()
    expected = round((args.end-args.start) * rate)
    if abs(len(mix)-expected) > 1 or not np.isfinite(mix).all():
        raise ValueError("Actual input audio must cover the requested source window")
    # Fixed batch of one, overlapping chunks: memory does not scale with the window.
    chunk = int(config["audio"]["chunk_size"])
    step = chunk // 2
    total = len(mix)
    sums = np.zeros((3, 2, total), dtype=np.float32)
    counts = np.zeros(total, dtype=np.float32)
    ramp = np.minimum(np.arange(chunk) + 1, np.arange(chunk, 0, -1)).astype(np.float32)
    ramp /= ramp.max()
    if args.device.startswith("cuda"):
        torch.cuda.reset_peak_memory_stats()
    with torch.inference_mode():
        for start in range(0, total, step):
            length = min(chunk, total-start)
            audio = np.zeros((2, chunk), dtype=np.float32)
            audio[:, :length] = mix[start:start+length].T
            prediction = model(torch.from_numpy(audio[None]).to(args.device))[0].float().cpu().numpy()
            if prediction.shape != (3, 2, chunk) or not np.isfinite(prediction).all():
                raise ValueError("Unexpected or non-finite actual model output")
            weights = ramp[:length].copy()
            if start == 0:
                weights[:step] = 1
            if start+length == total:
                weights[max(0, length-step):] = 1
            sums[:, :, start:start+length] += prediction[:, :, :length] * weights
            counts[start:start+length] += weights
            if start+length == total:
                break
    estimates = sums / counts[None, None, :]
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    stems = []
    for index, name in enumerate(config["kwargs"]["stems"]):
        path = output / (name + "-analysis.wav")
        data = estimates[index].T
        sf.write(path, data, rate, subtype="FLOAT")
        stems.append({"kind": name, "path": str(path.resolve()), "sha256": sha256(path),
                      "samples": total, "peak": float(np.max(np.abs(data))),
                      "rms": float(np.sqrt(np.mean(data**2))), "status": "analysis_candidate"})
    record = {"backend": "BandIt-v2-pretrained", "input": str(Path(args.input).resolve()),
              "input_sha256": sha256(args.input), "source_range": [args.start, args.end],
              "input_pcm_sha256": hashlib.sha256(encoded).hexdigest(),
              "weights_sha256": args.weights_sha256, "config_sha256": sha256(args.config),
              "model_code_sha256": sha256(Path(args.model_dir)/"bandit_v2/bandit.py"),
              "device": args.device, "torch_version": torch.__version__, "training": False,
              "sample_rate": rate, "channels": 2, "samples": total, "stems": stems,
              "wall_seconds": time.perf_counter()-started,
              "peak_gpu_bytes": torch.cuda.max_memory_allocated() if args.device.startswith("cuda") else None,
              "reconstruction_rms": float(np.sqrt(np.mean((estimates.sum(axis=0).T-mix)**2))),
              "lyrics_verified": False, "artistic_approval": False,
              "decode_timeline_policy": "aresample:first_pts=0 aligns decoder priming with the source-window origin",
              "notes": ["Three-stem separation is not separate dialogue and singing classification",
                        "No clean-source, semantic or audible-quality approval is inferred"]}
    (output/"separation-record.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "model-dir", "weights", "weights-sha256", "config", "out"):
        parser.add_argument("--"+name, required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda:0"], default="cuda:0")
    add_slot_arguments(parser)
    result = separate(parser.parse_args())
    print(json.dumps({"status": "analysis_candidate", "wall_seconds": result["wall_seconds"],
                      "samples": result["samples"], "peak_gpu_bytes": result["peak_gpu_bytes"]}))


if __name__ == "__main__":
    main()
