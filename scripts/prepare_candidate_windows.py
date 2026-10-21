"""Prepare bounded actual-source CLAP jobs from a pending reranked candidate pool.

pending-audio-reranked.json --limit 3 --windows 6 --out NEW_JOBS.json
Windows are recall probes, not phase annotations, full-song auditions or selections.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess

import clap_segment_features as clap


def source_range(value):
    if (not isinstance(value, list) or len(value) != 2 or any(isinstance(x, bool)
            or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value)
            or not 0 <= value[0] < value[1]):
        raise ValueError("invalid_source_range")
    return value


def probe_duration(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True, timeout=30)
    document = json.loads(result.stdout)
    duration = float(document["format"]["duration"])
    if not document.get("streams") or not math.isfinite(duration) or duration <= 0:
        raise ValueError("actual_audio_duration_required")
    return duration


def sample_range(window):
    start, end = math.ceil(window[0] * 48000), math.floor(window[1] * 48000)
    if start >= end:
        raise ValueError("source_range_contains_no_full_48k_sample")
    return start, end


def seconds_range(window):
    start, end = window
    if end / 48000 - start / 48000 > 10:
        end -= 1  # Keep the existing encoder's strict floating-point <=10 contract.
    return (start, end), [start / 48000, end / 48000]


def candidate_windows(parent, encoded, count):
    start, end = sample_range(parent)
    width = min(480000, end-start)
    if count == 1:
        positions = [start + (end-start-width)//2]
    else:
        positions = [start + round((end-start-width)*i/(count-1)) for i in range(count)]
    windows = sorted(set((position, position+width) for position in positions))
    if encoded is not None:
        original = sample_range(encoded)
        if original not in windows:
            if len(windows) < count:
                windows.append(original)
            else:
                nearest = min(range(len(windows)), key=lambda i: abs(sum(windows[i])-sum(original)))
                windows[nearest] = original
    return sorted(set(seconds_range(window)[0] for window in windows))


def prepare_candidate_windows(input_path, output_path, limit=3, windows=6):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError("limit_must_be_integer_from_1_to_20")
    if isinstance(windows, bool) or not isinstance(windows, int) or not 1 <= windows <= 12:
        raise ValueError("windows_must_be_integer_from_1_to_12")
    input_path, output_path = Path(input_path), Path(output_path)
    if output_path.exists():
        raise ValueError("refusing_to_overwrite_output")
    raw = input_path.read_bytes()
    document = json.loads(raw.decode("utf-8-sig"))
    if document.get("schema_version") != 1 or not isinstance(document.get("cues"), list):
        raise ValueError("pending_reranked_cues_required")
    sources, identities, jobs, mappings, seen_cues = {}, {}, {}, [], set()
    for cue in document["cues"]:
        cue_id, pool = cue.get("cue_id"), cue.get("candidate_pool")
        if (not isinstance(cue_id, str) or not cue_id.strip() or cue_id in seen_cues
                or not isinstance(pool, list)):
            raise ValueError("unique_cue_and_candidate_pool_required")
        seen_cues.add(cue_id)
        cue_mapping = {"cue_id": cue_id, "candidate_windows": [], "unexpanded_candidates": max(0, len(pool)-limit)}
        for candidate in pool[:limit]:
            if not isinstance(candidate, dict) or any(not isinstance(candidate.get(key), str)
                    or not candidate[key].strip() for key in ["asset_id", "local_path", "family_id"]):
                raise ValueError("actual_candidate_identity_required")
            asset_id, sha = candidate["asset_id"], candidate.get("source_sha256")
            if not re.fullmatch("[0-9a-f]{64}", str(sha)):
                raise ValueError("invalid_source_sha256")
            parent = source_range(candidate.get("source_range"))
            path = Path(candidate["local_path"]).resolve(strict=True)
            file_key = os.path.normcase(str(path))
            identity = (file_key, sha, candidate["family_id"])
            if asset_id in identities and identities[asset_id] != identity:
                raise ValueError("conflicting_asset_identity")
            identities[asset_id] = identity
            if file_key not in sources:
                sources[file_key] = {"path": str(path), "source_sha256": clap.digest(path),
                                     "duration_seconds": probe_duration(path)}
            actual = sources[file_key]
            if actual["source_sha256"] != sha:
                raise ValueError("stale_source_sha256")
            if parent[1] > actual["duration_seconds"]:
                raise ValueError("source_range_exceeds_actual_duration")
            encoded, original_status = None, "not_present"
            if candidate.get("encoded_window") is not None:
                original = candidate["encoded_window"]
                if (not isinstance(original, dict) or original.get("asset_id") != asset_id
                        or original.get("source_sha256") != sha):
                    raise ValueError("encoded_window_identity_mismatch")
                prior = source_range(original.get("source_range"))
                if prior[1]-prior[0] > 10 or prior[1] > actual["duration_seconds"]:
                    raise ValueError("invalid_encoded_window_bounds")
                original_status = "outside_allowed_range"
                if parent[0] <= prior[0] and prior[1] <= parent[1]:
                    encoded, original_status = prior, "included"
            refs = []
            for sample_window in candidate_windows(parent, encoded, windows):
                sample_window, window = seconds_range(sample_window)
                key = (asset_id, sha, *sample_window)
                if key not in jobs:
                    segment_id = "candidate-window-" + clap.json_digest(list(key))[:24]
                    jobs[key] = {"segment_id": segment_id, "asset_id": asset_id, "path": actual["path"],
                        "source_sha256": sha, "source_range": window, "source_sample_range_48k": list(sample_window),
                        "listening_status": "pending"}
                refs.append(jobs[key]["segment_id"])
            cue_mapping["candidate_windows"].append({"asset_id": asset_id, "family_id": candidate["family_id"],
                "source_sha256": sha, "allowed_source_range": parent, "job_segment_ids": refs,
                "original_encoded_window": original_status})
        mappings.append(cue_mapping)
    if not jobs:
        raise ValueError("no_selected_candidate_windows")
    result = {"schema_version": 1, "jobs": list(jobs.values()), "candidate_pool_asset_ids": sorted(identities),
        "input_file": {"path": str(input_path.resolve()), "sha256": hashlib.sha256(raw).hexdigest()},
        "cues": mappings, "sources": list(sources.values()), "limit_per_cue": limit,
        "maximum_windows_per_candidate": windows, "sample_grid_hz": 48000,
        "source_integrity": "verified_once_for_preparation_reverify_before_encoding_or_adoption",
        "artistic_approval": False, "production_approval": False, "phase_classification": False,
        "listening_status": "pending", "generation_calls": 0, "cloud_uploads": 0}
    clap.validate_jobs(result, verify_audio=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--windows", type=int, default=6)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = prepare_candidate_windows(args.input, args.out, args.limit, args.windows)
    print(json.dumps({"out": str(args.out.resolve()), "actual_jobs": len(result["jobs"]),
                      "unique_files_verified": len(result["sources"]), "artistic_approval": False}))


if __name__ == "__main__":
    main()
