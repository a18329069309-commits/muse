#!/usr/bin/env python3
"""Find a query audio segment inside a candidate recording using strict NCC."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import butter, fftconvolve, sosfiltfilt


def load_audio(
    path: Path,
    sample_rate: int,
    low_hz: float,
    high_hz: float,
    offset: float = 0.0,
    duration: float | None = None,
) -> np.ndarray:
    audio, _ = librosa.load(path, sr=sample_rate, mono=True, offset=offset, duration=duration)
    sos = butter(6, [low_hz, high_hz], btype="bandpass", fs=sample_rate, output="sos")
    return sosfiltfilt(sos, audio).astype(np.float64)


def sliding_ncc(reference: np.ndarray, query: np.ndarray) -> np.ndarray:
    if query.size > reference.size:
        raise ValueError("Query must be shorter than the candidate recording")
    centered_query = query - query.mean()
    query_norm = np.linalg.norm(centered_query)
    if query_norm == 0:
        raise ValueError("Query has zero variance")
    dots = fftconvolve(reference, centered_query[::-1], mode="valid")
    n = query.size
    prefix = np.concatenate(([0.0], np.cumsum(reference)))
    prefix_sq = np.concatenate(([0.0], np.cumsum(reference * reference)))
    sums = prefix[n:] - prefix[:-n]
    sums_sq = prefix_sq[n:] - prefix_sq[:-n]
    variances = np.maximum(sums_sq - (sums * sums / n), 0.0)
    denom = np.sqrt(variances) * query_norm
    return np.divide(dots, denom, out=np.zeros_like(dots), where=denom > 1e-12)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("query", type=Path, help="Extracted source segment")
    parser.add_argument("candidate", type=Path, help="Full candidate recording")
    parser.add_argument("--sample-rate", type=int, default=11025)
    parser.add_argument("--low-hz", type=float, default=120.0)
    parser.add_argument("--high-hz", type=float, default=5000.0)
    parser.add_argument("--query-start", type=float, default=0.0)
    parser.add_argument("--query-duration", type=float)
    parser.add_argument("--candidate-start", type=float, default=0.0)
    parser.add_argument("--candidate-duration", type=float)
    parser.add_argument(
        "--include-paths",
        action="store_true",
        help="Include absolute local paths in the JSON result; disabled by default for privacy.",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.sample_rate <= 0:
        raise SystemExit("--sample-rate must be greater than zero")
    if not 0 < args.low_hz < args.high_hz < args.sample_rate / 2:
        raise SystemExit("Require 0 < --low-hz < --high-hz < Nyquist frequency")
    for label, value in (("query start", args.query_start), ("candidate start", args.candidate_start)):
        if value < 0:
            raise SystemExit(f"{label} must be zero or greater")
    for label, value in (("query duration", args.query_duration), ("candidate duration", args.candidate_duration)):
        if value is not None and value <= 0:
            raise SystemExit(f"{label} must be greater than zero")

    query_path = args.query.expanduser().resolve()
    candidate_path = args.candidate.expanduser().resolve()
    for path in (query_path, candidate_path):
        if not path.is_file():
            raise SystemExit(f"Audio not found: {path}")
    query = load_audio(
        query_path,
        args.sample_rate,
        args.low_hz,
        args.high_hz,
        args.query_start,
        args.query_duration,
    )
    candidate = load_audio(
        candidate_path,
        args.sample_rate,
        args.low_hz,
        args.high_hz,
        args.candidate_start,
        args.candidate_duration,
    )
    scores = sliding_ncc(candidate, query)
    peak_index = int(np.argmax(np.abs(scores)))
    peak = float(scores[peak_index])
    abs_scores = np.abs(scores)
    mask = np.ones(abs_scores.size, dtype=bool)
    radius = query.size
    mask[max(0, peak_index - radius):min(mask.size, peak_index + radius + 1)] = False
    background = abs_scores[mask] if mask.any() else abs_scores
    result = {
        "query": query_path.name,
        "candidate": candidate_path.name,
        "sample_rate": args.sample_rate,
        "bandpass_hz": [args.low_hz, args.high_hz],
        "query_duration_seconds": query.size / args.sample_rate,
        "best_start_seconds": args.candidate_start + peak_index / args.sample_rate,
        "best_end_seconds": args.candidate_start + (peak_index + query.size) / args.sample_rate,
        "best_ncc": peak,
        "best_absolute_ncc": abs(peak),
        "other_positions_abs_median": float(np.median(background)),
        "other_positions_abs_p99": float(np.quantile(background, 0.99)),
    }
    if args.include_paths:
        result["query_path"] = str(query_path)
        result["candidate_path"] = str(candidate_path)
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.expanduser().resolve().write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
