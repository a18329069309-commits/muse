"""Verify a downloaded MTG batch and incrementally build a fresh library snapshot.

Only new audio is hashed/probed/fully decoded. Old SQLite rows and case metadata
are preserved through backup; uploader tags never become listening approval.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import time

import segment_library as library
from acquire_mtg_shards import checksum_map


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def read_licenses(path):
    result = {}
    for block in path.read_text(encoding="utf-8").split("\n\n"):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        identity = re.fullmatch(r"(.*) by (.*) from Jamendo: (https?://\S+)", lines[1])
        terms = re.fullmatch(r"Available under a (.*) license: (https?://\S+)", lines[2])
        if terms is None:
            terms = re.fullmatch(r"Available under (License Art Libre): (https?://\S+)", lines[2])
        if identity and terms:
            result[int(Path(lines[0]).stem)] = {"title": identity[1], "creator": identity[2],
                "source_page": identity[3], "license": terms[1], "license_url": terms[2],
                "license_source_block": block.strip()}
    return result


def source_records(source_db):
    with closing(sqlite3.connect(source_db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        records = {int(row["source_track_id"].split("_")[-1]): dict(row)
                   for row in db.execute("SELECT * FROM source_tracks")}
        for row in db.execute("SELECT source_track_id,tag FROM track_tags"):
            identifier = int(row["source_track_id"].split("_")[-1])
            records[identifier].setdefault("source_tags", []).append(row["tag"])
    return records


def pinned_provenance(acquisition_file, acquisition):
    base = f"https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/{acquisition['official_revision']}/"
    files = {"audio_licenses.txt": "audio_licenses.txt",
             "raw_30s_cleantags_50artists.tsv": "data/raw_30s_cleantags_50artists.tsv",
             "raw_30s_audio-low_sha256_tracks.txt": "data/download/raw_30s_audio-low_sha256_tracks.txt",
             "raw_30s_audio-low_sha256_tars.txt": "data/download/raw_30s_audio-low_sha256_tars.txt"}
    hashes = {}
    evidence = acquisition.get("source_metadata", [])
    for name, relative in files.items():
        entries = [row for row in evidence if row.get("url") == base + relative]
        path = acquisition_file.parent / "provenance" / name
        if (len(entries) != 1 or not re.fullmatch(r"[a-f0-9]{64}", entries[0].get("sha256", ""))
                or library.digest_file(path) != entries[0]["sha256"]):
            raise ValueError("pinned_source_metadata_integrity_mismatch")
        hashes[str(path.resolve())] = entries[0]["sha256"]
    rows = {}
    with (acquisition_file.parent / "provenance/raw_30s_cleantags_50artists.tsv").open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, delimiter="\t")
        if next(reader) != ["TRACK_ID", "ARTIST_ID", "ALBUM_ID", "PATH", "DURATION", "TAGS"]:
            raise ValueError("unexpected_official_metadata_header")
        for row in reader:
            identifier = int(row[0].split("_")[-1])
            if len(row) < 6 or identifier in rows:
                raise ValueError("invalid_or_duplicate_official_metadata_row")
            rows[identifier] = {"row": row, "metadata_sha256": hashlib.sha256(json.dumps(
                row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()}
    provenance = acquisition_file.parent / "provenance"
    return rows, checksum_map(provenance / "raw_30s_audio-low_sha256_tracks.txt"), checksum_map(
        provenance / "raw_30s_audio-low_sha256_tars.txt"), hashes


def validate_source_row(source, expected):
    row = expected["row"]
    if (source["metadata_sha256"] != expected["metadata_sha256"]
            or [source[key] for key in ("source_track_id", "source_artist_id", "source_album_id", "source_archive_path")] != row[:4]
            or source["duration_seconds"] != float(row[4])
            or sorted(source.get("source_tags", [])) != sorted(row[5:])):
        raise ValueError("source_database_row_differs_from_pinned_metadata")


def inspect_record(record, audio_root):
    path = Path(record["path"]).resolve()
    if not path.is_relative_to(audio_root) or not path.is_file():
        raise ValueError("acquired_audio_must_exist_inside_batch_audio_root")
    before = path.stat()
    if (record.get("individual_official_sha256_verified") is not True
            or library.digest_file(path) != record.get("source_sha256")
            or before.st_size != record.get("file_size_bytes")):
        raise ValueError("acquired_audio_integrity_mismatch")
    duration, rate, channels = library.probe_file(path)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("invalid_actual_audio_duration")
    decode = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-threads", "1",
        "-i", str(path), "-map", "0:a:0", "-f", "null", "-"], stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", timeout=90)
    if decode.returncode:
        raise ValueError("full_audio_decode_failed")
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("acquired_audio_changed_during_validation")
    return {**record, "path": str(path), "duration_seconds": duration,
            "sample_rate_hz": rate, "channels": channels, "full_decode": True}


def validate_recording_range(acquisition, record):
    """A complete author-checksummed member is independent of an incomplete archive."""
    if (acquisition.get("complete_recordings") is not True
            or acquisition.get("complete_archive") is not False or acquisition.get("complete") is True
            or acquisition.get("failures") != []):
        raise ValueError("complete_recording_range_scope_required")
    official_bases = {"https://cdn.freesound.org/mtg-jamendo/raw_30s/audio-low/",
                      "https://essentia.upf.edu/documentation/datasets/mtg-jamendo/raw_30s/audio-low/"}
    if acquisition.get("archive_source") not in official_bases:
        raise ValueError("official_recording_range_source_required")
    proof = record.get("range_evidence", {})
    try:
        header = base64.b64decode(proof["header_bytes_base64"], validate=True)
        if len(header) != 512:
            raise ValueError("invalid_tar_header_size")
        member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        offset, total = proof["header_offset"], proof["archive_total_bytes"]
        size = record["file_size_bytes"]
        if (type(offset) is not int or offset < 0 or offset % 512 or type(size) is not int or size <= 0
                or type(total) is not int or total < offset + 512 + size or not member.isfile()
                or member.name != record["official_member_path"] or member.size != size):
            raise ValueError("invalid_complete_member")
        response = proof["response"]
        if (response.get("http_status") != 206 or not proof.get("archive_etag")
                or response.get("etag") != proof["archive_etag"]
                or response.get("content_range") != f"bytes {offset + 512}-{offset + 511 + size}/{total}"
                or proof.get("source_url") != acquisition["archive_source"] + record["source_archive"]):
            raise ValueError("invalid_range_response")
    except (KeyError, TypeError, ValueError, tarfile.TarError) as error:
        raise ValueError("complete_recording_range_evidence_invalid") from error


def prepare_batch(acquisition_file, source_db, base_db, base_catalog, base_segments, out, workers=6):
    started = time.perf_counter()
    acquisition_file, source_db, base_db, base_catalog, base_segments, out = map(Path,
        (acquisition_file, source_db, base_db, base_catalog, base_segments, out))
    if isinstance(workers, bool) or not isinstance(workers, int) or not 1 <= workers <= 8:
        raise ValueError("workers_must_be_integer_from_1_to_8")
    if out.exists():
        raise ValueError("fresh_snapshot_directory_required")
    acquisition = read_json(acquisition_file)
    if (not isinstance(acquisition.get("records"), list) or not acquisition["records"]
            or not re.fullmatch(r"[a-f0-9]{40}", acquisition.get("official_revision", ""))):
        raise ValueError("pinned_acquisition_records_required")
    recording_ranges = acquisition.get("schema") == "official-mtg-recording-range-acquisition-v1"
    if not recording_ranges and (acquisition.get("complete") is not True or acquisition.get("failures") != []):
        raise ValueError("complete_verified_acquisition_required")
    inputs = [acquisition_file, source_db, base_db, base_catalog, base_segments]
    input_hashes = {str(p.resolve()): library.digest_file(p) for p in inputs}
    old_assets = library.read_records(base_catalog, ("assets", "tracks"))
    old_segments = library.read_records(base_segments, ("segments",))
    old_ids = {a.get("asset_id", a.get("track_id")): a for a in old_assets}
    with closing(sqlite3.connect(base_db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        actual_old = dict(db.execute("SELECT asset_id,source_sha256 FROM assets"))
        actual_segments = {row[0]: json.loads(row[1]) for row in db.execute("SELECT segment_id,record_json FROM segments")}
    if len(old_ids) != len(old_assets) or actual_old != {k: v["source_sha256"] for k, v in old_ids.items()}:
        raise ValueError("base_catalog_and_database_identity_mismatch")
    expected_segments = {row["segment_id"]: {"listening_status": "pending", **row} for row in old_segments}
    if len(expected_segments) != len(old_segments) or expected_segments != actual_segments:
        raise ValueError("base_segments_and_database_records_mismatch")
    metadata = source_records(source_db)
    license_file = acquisition_file.parent / "provenance/audio_licenses.txt"
    pinned_rows, track_hashes, archive_hashes, metadata_hashes = pinned_provenance(acquisition_file, acquisition)
    input_hashes.update(metadata_hashes)
    licenses = read_licenses(license_file)
    input_hashes[str(license_file.resolve())] = library.digest_file(license_file)
    records = acquisition["records"]
    track_ids = [r.get("source_track_id") for r in records]
    if any(type(i) is not int for i in track_ids) or len(set(track_ids)) != len(track_ids):
        raise ValueError("unique_integer_acquired_track_ids_required")
    for record in records:
        if recording_ranges:
            validate_recording_range(acquisition, record)
        if (track_hashes.get(record.get("official_member_path")) != record.get("source_sha256")
                or archive_hashes.get(record.get("source_archive")) != record.get("source_archive_sha256")):
            raise ValueError("acquisition_record_differs_from_publisher_checksums")
        source, expected = metadata.get(record["source_track_id"]), pinned_rows.get(record["source_track_id"])
        if source is not None:
            if expected is None:
                raise ValueError("source_database_row_missing_from_pinned_metadata")
            validate_source_row(source, expected)
    audio_root = (acquisition_file.parent / "audio").resolve()
    decoded, failures = [], []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(inspect_record, record, audio_root): record for record in records}
        for count, future in enumerate(as_completed(jobs), 1):
            try:
                decoded.append(future.result())
            except Exception as error:
                failures.append({"source_track_id": jobs[future]["source_track_id"],
                                 "error": str(error), "error_type": type(error).__name__})
            if count % 100 == 0:
                print(json.dumps({"inspected": count, "valid_full_decodes": len(decoded),
                                  "failed_media": len(failures)}), flush=True)
    assets, segments, quarantined, reused = [], [], [], []
    for record in sorted(decoded, key=lambda r: r["source_track_id"]):
        identifier = record["source_track_id"]
        source, terms = metadata.get(identifier), licenses.get(identifier)
        if not source or not terms:
            quarantined.append({"source_track_id": identifier, "reason": "source_metadata_or_license_missing"})
            continue
        if record["official_member_path"].replace(".low.mp3", ".mp3") != source["source_archive_path"]:
            raise ValueError("official_member_and_metadata_path_mismatch")
        asset_id = f"mtg-full-low-{identifier}"
        if asset_id in old_ids:
            if old_ids[asset_id]["source_sha256"] != record["source_sha256"]:
                raise ValueError("existing_asset_id_has_different_audio")
            reused.append(asset_id)
            continue
        tags = sorted(source.get("source_tags", []))
        asset = {"asset_id": asset_id, "asset_kind": "music", "family_id": f"mtg-track-{identifier}",
            "source_track_id": source["source_track_id"], "source_collection": "mtg-jamendo-raw_30s-audio-low",
            "source_artist_id": source["source_artist_id"], "source_album_id": source["source_album_id"],
            **terms, "local_path": record["path"], "source_sha256": record["source_sha256"],
            "duration_seconds": record["duration_seconds"], "sample_rate_hz": record["sample_rate_hz"],
            "channels": record["channels"], "file_size_bytes": record["file_size_bytes"],
            "source_archive": record["source_archive"], "source_archive_sha256": record["source_archive_sha256"],
            "source_archive_url": acquisition["archive_source"] + record["source_archive"],
            "official_member_path": record["official_member_path"], "full_decode": True,
            "individual_official_sha256_verified": True, "license_evidence": str(license_file.resolve()),
            "source_tags": tags, "genre_preferences": [t.partition("---")[2] for t in tags if t.startswith("genre---")],
            "instrument_preferences": [t.partition("---")[2] for t in tags if t.startswith("instrument---")],
            "source_moods": [t.partition("---")[2] for t in tags if t.startswith("mood/theme---")],
            "metadata_evidence": {"source_metadata_sha256": source["metadata_sha256"],
                "source_db_path": str(source_db.resolve()), "source_git_revision": acquisition["official_revision"],
                "method": "official_uploader_tags_not_scene_or_auditory_assessment"},
            "source_quality": "research_discovery_low_bitrate", "audio_extent": "full_source_recording",
            "vocal_presence": "unknown", "narrative_functions": [], "listening_status": "pending",
            "commercial_use_allowed": False, "usage_scope": "research_noncommercial",
            "artistic_approval": False, "production_approved": False}
        if "instrument---voice" in tags:
            asset["fulltrack_voice_annotation"] = {"label": "voice",
                "source_kind": "official_uploader_tag", "scope": "whole_recording_not_source_window",
                "evidence": asset["metadata_evidence"], "lyrics_verified": False}
        assets.append(asset)
        if recording_ranges:
            asset.update(acquisition_scope="verified_complete_recording_range",
                         source_archive_official_sha256_verified=False,
                         recording_range_evidence=record["range_evidence"])
        segments.append({"segment_id": asset_id + "-full-recording", "asset_id": asset_id,
            "source_sha256": asset["source_sha256"], "source_start_seconds": 0,
            "source_end_seconds": asset["duration_seconds"], "phase": "unknown", "tags": tags,
            "description": " ".join(tags), "vocal_presence": "unknown", "narrative_functions": [],
            "listening_status": "pending", "segment_kind": "whole_recording", "artistic_approval": False})
    if not assets:
        raise ValueError("no_new_valid_assets_to_import")
    out.mkdir(parents=True)
    write_json(out / "new-assets.json", {"assets": assets})
    write_json(out / "new-segments.json", {"segments": segments})
    # Normalize old relative pointers without reopening their audio or changing observations.
    merged_assets = [{**a, "local_path": a["local_path"] if Path(a["local_path"]).is_absolute()
                     else str((base_catalog.resolve().parent / a["local_path"]).resolve())}
                     for a in old_assets] + assets
    write_json(out / "catalog-assets.json", {"assets": merged_assets})
    write_json(out / "segments.json", {"segments": old_segments + segments})
    database = out / "segments.sqlite"
    with closing(sqlite3.connect(base_db.resolve().as_uri() + "?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(database)) as target:
            source.backup(target)
    imported = library.import_library(database, out / "new-assets.json", out / "new-segments.json")
    if any(library.digest_file(Path(p)) != h for p, h in input_hashes.items()):
        raise ValueError("input_snapshot_changed_during_preparation")
    music = [a for a in merged_assets if a.get("asset_kind") == "music"]
    generated = [a for a in music if str(a.get("asset_id", "")).startswith("generated-")]
    stock = [a for a in music if a not in generated]
    report = {"status": "partial_batch_indexed" if failures or quarantined else "new_batch_indexed",
        "input_hashes": input_hashes, "acquired_records": len(records), "valid_full_decodes": len(decoded),
        "failed_media": failures, "quarantined_metadata": quarantined, "existing_asset_ids_reused": reused,
        "new_asset_ids": len(assets), "new_unique_file_hashes": len({a["source_sha256"] for a in assets}),
        "new_file_hashes_not_in_base": len({a["source_sha256"] for a in assets} - set(actual_old.values())),
        "old_asset_ids_preserved": len(old_assets), "old_segments_preserved": len(old_segments),
        "music_asset_ids": len(music), "music_unique_file_hashes": len({a["source_sha256"] for a in music}),
        "stock_asset_ids": len(stock), "stock_unique_file_hashes": len({a["source_sha256"] for a in stock}),
        "generated_candidates_separate": len(generated), "verified_distinct_compositions": "unknown",
        "new_voice_source_tag_count": sum("instrument---voice" in a["source_tags"] for a in assets),
        "import": imported, "old_audio_rehashed_or_decoded": 0, "seconds": time.perf_counter() - started,
        "pinned_metadata_and_source_rows_verified": True,
        "listening_status": "pending", "production_approval": False, "cloud_uploads": 0, "model_calls": 0}
    write_json(out / "prepare-library-report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("acquisition", "source-db", "base-db", "base-catalog", "base-segments", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    report = prepare_batch(args.acquisition, args.source_db, args.base_db, args.base_catalog,
                           args.base_segments, args.out, args.workers)
    print(json.dumps({k: report[k] for k in ("status", "new_asset_ids", "stock_unique_file_hashes", "seconds")}), flush=True)


if __name__ == "__main__":
    main()
