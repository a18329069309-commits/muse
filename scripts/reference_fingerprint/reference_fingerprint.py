"""Finite local excerpt index and JSON matching with pinned audfprint source."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "upstream"))
import audfprint_analyze
import audfprint_match
import hash_table

UPSTREAM_SHA = "cb03ba99feafd41b8874307f0f4e808a6ce34362"
SR = 11025


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fingerprint(analyzer, wave, shifts):
    sets = []
    for shift in range(shifts):
        sample_offset = int(shift / shifts * analyzer.n_hop)
        peaks = analyzer.find_peaks(wave[sample_offset:], SR)
        sets.append(audfprint_analyze.landmarks2hashes(analyzer.peaks2landmarks(peaks)))
    return np.unique(np.concatenate(sets), axis=0)


def build(args, analyzer):
    assets = read_json(args.manifest)["assets"]
    table = hash_table.HashTable(hashbits=18, depth=20)
    records = []
    seen = set()
    for asset in assets:
        asset_id, path = asset["asset_id"], Path(asset["path"])
        if asset_id in seen:
            raise ValueError("Duplicate asset_id: " + asset_id)
        seen.add(asset_id)
        digest = sha256(path)
        if digest != asset["sha256"]:
            raise ValueError("Source SHA256 mismatch: " + asset_id)
        start, stop = asset["source_range"]
        if not 0 <= start < stop:
            raise ValueError("Invalid source_range: " + asset_id)
        wave, _ = librosa.load(str(path), sr=SR, mono=True, offset=start, duration=stop - start)
        if len(wave) < SR * (stop - start - 0.05):
            raise ValueError("Source range extends past decoded audio: " + asset_id)
        hashes = fingerprint(analyzer, wave, shifts=1)
        table.store(asset_id, hashes)
        records.append({**asset, "path": str(path.resolve()), "hash_count": len(hashes), "decoded_seconds": len(wave) / SR})
    index = Path(args.index)
    index.parent.mkdir(parents=True, exist_ok=True)
    table.save(str(index))
    result = {"operation": "build", "upstream_commit": UPSTREAM_SHA, "sr": SR, "density": 20, "index_shifts": 1, "hashbits": 18, "depth": 20, "assets": records, "index_sha256": sha256(index)}
    index.with_suffix(".manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def match(args, analyzer):
    index = Path(args.index)
    manifest = read_json(index.with_suffix(".manifest.json"))
    if manifest["index_sha256"] != sha256(index) or manifest["upstream_commit"] != UPSTREAM_SHA:
        raise ValueError("Index provenance mismatch")
    if not 0 <= args.source_in_seconds < args.source_out_seconds:
        raise ValueError("Invalid query source range")
    wave, _ = librosa.load(args.query, sr=SR, mono=True, offset=args.source_in_seconds, duration=args.source_out_seconds - args.source_in_seconds)
    if len(wave) < SR * (args.source_out_seconds - args.source_in_seconds - 0.05):
        raise ValueError("Query range extends past decoded audio")
    hashes = fingerprint(analyzer, wave, shifts=4)
    table = hash_table.HashTable(str(index))
    matcher = audfprint_match.Matcher()
    matcher.window = 2
    matcher.exact_count = True
    matcher.find_time_range = True
    results = matcher.match_hashes(table, hashes)
    by_id = {a["asset_id"]: a for a in manifest["assets"]}
    matches = []
    for row in results:
        asset_id = table.names[int(row[0])]
        asset = by_id[asset_id]
        offset = float(row[2]) * analyzer.n_hop / SR + asset["source_range"][0]
        matches.append({"asset_id": asset_id, "path": asset["path"], "sha256": asset["sha256"], "query_start_maps_to_source_seconds": offset, "consistent_hash_count": int(row[1]), "raw_shared_hash_count": int(row[3]), "matched_query_support_seconds": [float(row[5]) * analyzer.n_hop / SR, float(row[6]) * analyzer.n_hop / SR]})
    return {"operation": "match", "upstream_commit": UPSTREAM_SHA, "query": str(Path(args.query).resolve()), "query_sha256": sha256(args.query), "query_source_range": [args.source_in_seconds, args.source_out_seconds], "sr": SR, "query_shifts": 4, "match_window_frames": 2, "min_consistent_hashes": 5, "query_hash_count": len(hashes), "matches": matches, "scene_fit_verified": False, "scope": "same-recording excerpt identity and timing; not semantic similarity, lyrics or artistic acceptance"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    builder = sub.add_parser("build")
    builder.add_argument("--manifest", required=True)
    finder = sub.add_parser("match")
    finder.add_argument("--query", required=True)
    finder.add_argument("--source-in-seconds", type=float, required=True)
    finder.add_argument("--source-out-seconds", type=float, required=True)
    for command in (builder, finder):
        command.add_argument("--index", required=True)
        command.add_argument("--out", required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    analyzer = audfprint_analyze.Analyzer(density=20)
    result = build(args, analyzer) if args.command == "build" else match(args, analyzer)
    result["wall_seconds"] = time.perf_counter() - started
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"operation": args.command, "out": str(output.resolve()), "wall_seconds": result["wall_seconds"], "count": len(result.get("matches", result.get("assets", [])))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
