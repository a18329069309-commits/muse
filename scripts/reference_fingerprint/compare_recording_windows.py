"""Compare a real mixed excerpt with pinned candidate recordings, without approval.

Uses the vendored, unmodified Snoop2023 strict-NCC implementation. A correlation
peak is evidence for review, not an automatic song identity or aesthetic verdict.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time

import numpy as np


UPSTREAM = Path(__file__).parent / "candidate_upstream"


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def load_upstream():
    provenance = json.loads((UPSTREAM / "UPSTREAM.json").read_text(encoding="utf-8"))
    for item in provenance["files"]:
        if digest(UPSTREAM / item["file"]) != item["sha256"]:
            raise ValueError("upstream_identity_changed")
    spec = importlib.util.spec_from_file_location("pinned_candidate_compare", UPSTREAM / "compare_candidate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, provenance


def valid_range(value):
    if (not isinstance(value, list) or len(value) != 2 or
            any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value)
            or not 0 <= value[0] < value[1]):
        raise ValueError("invalid_source_range")
    return value


def compare(query, query_range, candidates, harmonic=False):
    started = time.monotonic()
    module, provenance = load_upstream()
    query_range = valid_range(query_range)
    if not 1 <= len(candidates) <= 20:
        raise ValueError("require_one_to_twenty_explicit_candidates")
    ids = [item["asset_id"] for item in candidates]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate_candidate_id")
    rate = 11025
    query = Path(query).resolve()
    query_hash = digest(query)

    def read(path, bounds):
        samples = module.load_audio(path, rate, 120, 5000, bounds[0], bounds[1] - bounds[0])
        if len(samples) < round((bounds[1] - bounds[0]) * rate) - 2:
            raise ValueError("source_window_truncated")
        if not np.isfinite(samples).all():
            raise ValueError("nonfinite_audio")
        return samples

    original = read(query, query_range)
    variants = {"original_bandpass": original}
    if harmonic:
        variants["harmonic_bandpass"] = module.librosa.effects.harmonic(original, margin=8)
    results = []
    for candidate in candidates:
        path = Path(candidate["path"]).resolve()
        actual_hash = digest(path)
        if actual_hash != candidate["sha256"]:
            raise ValueError("candidate_identity_changed")
        bounds = valid_range(candidate["source_range"])
        source = read(path, bounds)
        row = {"asset_id": candidate["asset_id"], "path": str(path), "sha256": actual_hash,
               "source_range": bounds, "comparisons": []}
        for name, excerpt in variants.items():
            if len(source) < len(excerpt):
                raise ValueError("candidate_window_shorter_than_query")
            if np.linalg.norm(excerpt - excerpt.mean()) < 1e-10:
                row["comparisons"].append({"variant": name, "status": "no_query_variance"})
                continue
            scores = module.sliding_ncc(source, excerpt)
            peak = int(np.argmax(np.abs(scores)))
            mask = np.ones(len(scores), dtype=bool)
            mask[max(0, peak - len(excerpt)):min(len(mask), peak + len(excerpt) + 1)] = False
            other = np.abs(scores[mask])
            row["comparisons"].append({"variant": name, "status": "measured",
                "query_start_maps_to_source_seconds": bounds[0] + peak / rate,
                "query_end_maps_to_source_seconds": bounds[0] + (peak + len(excerpt)) / rate,
                "best_absolute_ncc": float(abs(scores[peak])),
                "other_positions_abs_p99": float(np.quantile(other, .99)) if len(other) else None,
                "independent_background_positions": int(len(other))})
        if digest(path) != actual_hash:
            raise ValueError("candidate_changed_during_comparison")
        results.append(row)
    if digest(query) != query_hash:
        raise ValueError("query_changed_during_comparison")
    return {"schema_version": 1, "operation": "candidate_recording_comparison",
        "query": str(query), "query_sha256": query_hash, "source_range": query_range,
        "sample_rate": rate, "bandpass_hz": [120, 5000],
        "upstream_revision": provenance["revision"], "candidates": results,
        "identity_verified": False, "song_title_inferred": False, "scene_fit_verified": False,
        "scope": "explicit candidate comparison; require wrong-source and neighboring-window controls",
        "api_calls": 0, "wall_seconds": time.monotonic() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", type=Path, required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--harmonic", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("output_exists_use_new_path")
    candidates = json.loads(args.candidates.read_text(encoding="utf-8-sig"))["assets"]
    result = compare(args.query, [args.start, args.end], candidates, args.harmonic)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"report": str(args.out), "candidate_count": len(result["candidates"]),
                      "identity_verified": False, "wall_seconds": result["wall_seconds"]}))


if __name__ == "__main__":
    main()
