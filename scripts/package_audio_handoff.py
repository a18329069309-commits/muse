"""Portable, content-addressed frozen audio handoff. Python standard library only.

This exports bytes and evidence, never grants sound, use, lyric or listening approval.
Existing media and frozen databases are read-only; each export uses new directories.
"""
import argparse
import hashlib
import json
import re
import time
import zipfile
from pathlib import Path

GIB = 1024 ** 3
BLOCK = 8 * 1024 ** 2
SHA = re.compile(r"^[0-9a-f]{64}$")


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(BLOCK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def collect_resources(manifest_path, manifest, manifest_sha):
    resources = []

    def add(binding, role, refs):
        expected = binding.get("sha256", "").lower()
        if not SHA.fullmatch(expected):
            raise ValueError("resource_sha256_required:" + role)
        source = Path(binding["path"]).resolve()
        suffix = source.suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
            suffix = ".bin"
        resources.append({"path": str(source), "sha256": expected,
                          "expected_bytes": binding.get("bytes"), "suffix": suffix,
                          "role": role, "refs": refs})

    for index, row in enumerate(manifest["audio_files"]):
        add(row, "audio", {"manifest_pointer": f"#/audio_files/{index}",
                           "library": row["library"], "asset_id": row["asset_id"]})
    for name, library in manifest["libraries"].items():
        for kind, binding in library["bindings"].items():
            add(binding, "frozen_library", {"library": name, "binding_kind": kind,
                                          "publication_id": library["publication_id"]})
    for index, row in enumerate(manifest.get("source_evidence_files", [])):
        add(row, "source_evidence", {"manifest_pointer": f"#/source_evidence_files/{index}"})
    add({"path": str(manifest_path), "sha256": manifest_sha}, "external_manifest", {})
    return resources


class StoredVolumes:
    def __init__(self, output, limit, start_ordinal=0):
        self.output, self.limit = Path(output), limit
        self.archive = None
        self.ordinal = start_ordinal
        self.entries = []
        self.members = []
        self.reserved = 22  # End-of-central-directory; conservative per-entry reservation below.

    def close(self):
        if not self.archive:
            return
        self.archive.close()
        actual = self.current.stat().st_size
        if actual > self.limit:
            raise ValueError("archive_exceeds_limit")
        checksum = file_sha(self.current)
        # Shared drives may allow create/read but forbid rename/delete. No rename is
        # needed: content identity comes from the complete SHA256 in the manifest.
        self.entries.append({"archive_id": f"volume-{self.ordinal:03d}", "file": self.current.name,
                             "bytes": actual, "sha256": checksum, "compression": "ZIP_STORED",
                             "member_count": len(self.members)})
        self.archive = None

    def add(self, source, member, expected_sha, expected_bytes=None):
        source = Path(source)
        size = source.stat().st_size
        if expected_bytes is not None and size != expected_bytes:
            raise ValueError("resource_size_changed:" + expected_sha)
        # Local header + central-directory entry + ZIP64 extras and directory reserve.
        # All names are ASCII. 256 deliberately exceeds zipfile's actual per-entry overhead.
        reservation = size + 2 * len(member.encode("ascii")) + 256
        if reservation + 22 > self.limit:
            raise ValueError("single_resource_exceeds_volume_limit:" + expected_sha)
        if self.archive and self.reserved + reservation > self.limit:
            self.close()
        if not self.archive:
            self.ordinal += 1
            self.current = self.output / f"audio-resources-{self.ordinal:03d}.zip"
            self.archive = zipfile.ZipFile(self.current, "x", compression=zipfile.ZIP_STORED,
                                           allowZip64=True)
            self.members, self.reserved = [], 22
        info = zipfile.ZipInfo(member, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.file_size = size
        digest, copied = hashlib.sha256(), 0
        with source.open("rb") as reader, self.archive.open(info, "w", force_zip64=True) as writer:
            for chunk in iter(lambda: reader.read(BLOCK), b""):
                digest.update(chunk)
                writer.write(chunk)
                copied += len(chunk)
        if copied != size or digest.hexdigest() != expected_sha:
            raise ValueError("resource_sha256_mismatch:" + expected_sha)
        self.reserved += reservation
        self.members.append(member)
        return {"archive_id": f"volume-{self.ordinal:03d}", "member": member,
                "sha256": expected_sha, "bytes": copied, "input_sha256_verified_while_copying": True}


def verify_bundle(bundle_manifest):
    manifest_path = Path(bundle_manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    archive_root = Path(manifest["bundle_directory"]).resolve()
    resources = {row["sha256"]: row for row in manifest["resources"]}
    checked = set()
    actual_total = 0
    for volume in manifest["volumes"]:
        filename = volume["file"]
        if Path(filename).name != filename:
            raise ValueError("unsafe_archive_name")
        archive = Path(volume["path"]).resolve() if volume.get("path") else archive_root / filename
        if archive.stat().st_size != volume["bytes"] or archive.stat().st_size > manifest["max_archive_bytes"]:
            raise ValueError("bundle_archive_size_changed")
        if file_sha(archive) != volume["sha256"]:
            raise ValueError("bundle_archive_sha256_mismatch")
        expected_members = {row["member"]: row for row in resources.values()
                            if row["archive_id"] == volume["archive_id"]}
        with zipfile.ZipFile(archive, "r") as reader:
            names = reader.namelist()
            if len(names) != len(set(names)) or set(names) != set(expected_members):
                raise ValueError("bundle_member_set_changed")
            for member, row in expected_members.items():
                info = reader.getinfo(member)
                if info.compress_type != zipfile.ZIP_STORED or info.file_size != row["bytes"]:
                    raise ValueError("bundle_member_contract_changed")
                digest, size = hashlib.sha256(), 0
                with reader.open(info) as stream:
                    for chunk in iter(lambda: stream.read(BLOCK), b""):
                        digest.update(chunk)
                        size += len(chunk)
                if digest.hexdigest() != row["sha256"] or size != row["bytes"]:
                    raise ValueError("bundle_member_sha256_mismatch")
                checked.add(row["sha256"])
                actual_total += size
    if checked != set(resources):
        raise ValueError("bundle_resources_missing")
    return {"status": "verified", "missing_resources": 0, "resource_count": len(checked),
            "uncompressed_resource_bytes": actual_total, "archive_count": len(manifest["volumes"]),
            "archive_and_member_sha256_verified": True, "qualification_granted": False,
            "actual_model_requests": 0, "paid_calls": 0}


def recover_closed_volumes(directory, expected, limit):
    """Keep immutable complete volumes read-only; never adopt an unknown member.

    Payload hashes are reverified by the final full bundle audit before publication.
    A volume with any stale/unknown manifest or member is rebuilt from normal inputs.
    """
    volumes, recovered, rejected = [], {}, []
    largest_ordinal = 0
    for archive in sorted(Path(directory).resolve().glob("audio-resources-*.zip")):
        ordinal = re.fullmatch(r"audio-resources-(\d+)\.zip", archive.name)
        if not ordinal:
            continue
        try:
            if archive.stat().st_size > limit:
                raise ValueError("oversize")
            objects, names = {}, set()
            with zipfile.ZipFile(archive, "r") as reader:
                for info in reader.infolist():
                    match = re.fullmatch(r"objects/([0-9a-f]{2})/([0-9a-f]{64})\.[a-z0-9]{1,10}", info.filename)
                    if not match or info.filename in names or match[1] != match[2][:2]:
                        raise ValueError("unknown_member")
                    checksum = match[2]
                    source = expected.get(checksum)
                    if not source or checksum in recovered or checksum in objects \
                            or info.compress_type != zipfile.ZIP_STORED \
                            or source["expected_bytes"] is not None and info.file_size != source["expected_bytes"]:
                        raise ValueError("stale_unknown_or_duplicate_object")
                    names.add(info.filename)
                    objects[checksum] = {"archive_id": f"volume-{int(ordinal[1]):03d}",
                         "member": info.filename, "sha256": checksum, "bytes": info.file_size,
                         "role": source["role"], "input_sha256_verified_while_copying": False,
                         "identity_basis": "read_only_previous_run_member_reverified_in_final_archive_audit",
                         "recovered_read_only_archive": True}
            if not objects:
                raise ValueError("empty_volume")
            volumes.append({"archive_id": f"volume-{int(ordinal[1]):03d}", "file": archive.name,
                           "path": str(archive), "bytes": archive.stat().st_size,
                           "sha256": file_sha(archive), "compression": "ZIP_STORED",
                           "member_count": len(objects), "recovered_read_only_archive": True})
            recovered.update(objects)
            largest_ordinal = max(largest_ordinal, int(ordinal[1]))
        except (ValueError, OSError, zipfile.BadZipFile) as error:
            rejected.append({"path": str(archive), "reason": str(error)})
    return volumes, recovered, rejected, largest_ordinal


GUIDE = """# Audio handoff / 音频资源交接

This archive transfers candidate recordings, frozen library snapshots and provenance;
it does not approve sound quality, usage, lyrics, transient timing, or finished scoring.

1. Keep all ZIP volumes and `audio-bundle-manifest.json` together. The manifest lists
   final archive SHA256, member SHA256, original resource references and publication IDs.
2. Run `python package_audio_handoff.py verify --manifest audio-bundle-manifest.json`.
   `bundle_directory` is the export's location. Read-only recovered volumes can have an
   explicit `path` at a prior export; collect those listed volumes as well. When moving
   all ZIP files together, write a separate relocation copy of this handoff manifest,
   update `bundle_directory`, and remove/update each volume's explicit `path`. Preserve the
   original manifest and verification receipt.
3. Each payload member is `objects/<sha-prefix>/<sha256>.<suffix>`. Use SHA256 to resolve
   frozen database assets, original media and evidence references. The original external
   resource manifest, assets, segments, presets, publication and SQLite snapshots are
   included as unchanged, hash-bound payloads. Publisher HTML retains source/license
   statements; inspect the specific recording's license and usage scope before use.
4. Extract only expected content-addressed members into a NEW directory. Never overwrite
   the original S drive media, original evidence or old frozen SQLite databases. Do not
   rewrite a database's paths in place: use a host SHA->relocated path resolver, or generate
   a NEW snapshot/publication with validated paths and new hashes for the receiving host.
5. `resource_aliases` links each source/asset/library reference to one deduplicated object.
   File presence or decode evidence does not grant human/AI listening approval. Current
   diagnostic/pending qualifications remain pending; all production restrictions apply.

无需重新下载或安装模型。目录变更使用独立 SHA 路径映射，不篡改已冻结数据库。
"""


def package_manifest(manifest_file, output_dir, report_dir, max_archive_bytes=GIB, reuse_dir=None):
    started = time.monotonic()
    if not 512 <= max_archive_bytes <= GIB:
        raise ValueError("volume_limit_must_be_between_512_bytes_and_one_GiB")
    manifest_path = Path(manifest_file).resolve()
    raw = manifest_path.read_bytes()
    external_sha = hashlib.sha256(raw).hexdigest()
    external = json.loads(raw.decode("utf-8"))
    if external.get("kind") != "external_frozen_audio_resource_manifest":
        raise ValueError("frozen_resource_manifest_required")
    sources = collect_resources(manifest_path, external, external_sha)
    output, reports = Path(output_dir).resolve(), Path(report_dir).resolve()
    if output == reports or output.exists() or reports.exists():
        raise ValueError("new_distinct_export_and_report_directories_required")
    output.mkdir(parents=True)
    reports.mkdir(parents=True)
    # The audit ledger can be regenerated while a multi-GiB export is in flight.
    # Export exactly the raw manifest read at entry, not a later mutable path value.
    frozen_manifest = output / f"{external_sha}.source-manifest.json"
    frozen_manifest.write_bytes(raw)
    for row in sources:
        if row["role"] == "external_manifest":
            row["original_path"] = row["path"]
            row["path"] = str(frozen_manifest)
    guide = output / "RESTORE.md"
    guide.write_text(GUIDE, encoding="utf-8")
    guide_sha = file_sha(guide)
    sources.append({"path": str(guide), "sha256": guide_sha, "expected_bytes": guide.stat().st_size,
                    "suffix": ".md", "role": "restore_guide", "refs": {}})
    recovered_volumes, recovered, recovery_rejected, last_ordinal = recover_closed_volumes(reuse_dir,
        {row["sha256"]: row for row in sources}, max_archive_bytes) if reuse_dir else ([], {}, [], 0)
    volumes = StoredVolumes(output, max_archive_bytes, last_ordinal)
    try:
        missing = [row for row in sources if not Path(row["path"]).is_file()]
        if missing:
            raise ValueError("missing_resources:" + str(len(missing)))
        resources, aliases = dict(recovered), []
        for index, row in enumerate(sources):
            checksum = row["sha256"]
            if checksum not in resources:
                member = f"objects/{checksum[:2]}/{checksum}{row['suffix']}"
                resources[checksum] = {**volumes.add(row["path"], member, checksum, row["expected_bytes"]),
                                       "role": row["role"]}
            elif not resources[checksum].get("recovered_read_only_archive"):
                if file_sha(row["path"]) != checksum:
                    raise ValueError("duplicate_resource_sha256_mismatch:" + checksum)
                if row["expected_bytes"] is not None and Path(row["path"]).stat().st_size != row["expected_bytes"]:
                    raise ValueError("duplicate_resource_size_changed:" + checksum)
            aliases.append({"original_path": row.get("original_path", row["path"]), "sha256": checksum,
                            "role": row["role"], "refs": row["refs"]})
            if (index + 1) % 100 == 0:
                print(json.dumps({"stage": "copy_and_hash", "completed": index + 1,
                                  "total": len(sources), "unique_objects": len(resources)}), flush=True)
        volumes.close()
        bundle = {"schema_version": 1, "kind": "frozen_audio_handoff_bundle",
                  "bundle_directory": str(output), "max_archive_bytes": max_archive_bytes,
                  "source_manifest": {"path": str(frozen_manifest), "sha256": external_sha,
                                      "original_input_path": str(manifest_path)},
                  "library_publications": {name: {"publication_id": row["publication_id"],
                                             "counts": row["counts"], "bindings": row["bindings"],
                                             "review_qualification": row.get("review_qualification")}
                                           for name, row in external["libraries"].items()},
                  "volumes": recovered_volumes + volumes.entries, "resources": list(resources.values()), "resource_aliases": aliases,
                  "media_count": len(external["audio_files"]),
                  "unique_media_sha256": len({row["sha256"] for row in external["audio_files"]}),
                  "media_bytes": sum(row["bytes"] for row in external["audio_files"]),
                  "source_evidence_count": len(external.get("source_evidence_files", [])),
                  "qualification_granted": False, "frozen_database_modified": False,
                  "actual_model_requests": 0, "paid_calls": 0}
        bundle_file = output / "audio-bundle-manifest.json"
        write_json(bundle_file, bundle)
        print(json.dumps({"stage": "verify_archive_and_members", "archives": len(bundle["volumes"])}), flush=True)
        verified = verify_bundle(bundle_file)
        receipt = {**verified, "bundle_manifest": {"path": str(bundle_file), "sha256": file_sha(bundle_file)},
                   "media_count": bundle["media_count"], "unique_media_sha256": bundle["unique_media_sha256"],
                   "media_bytes": bundle["media_bytes"], "source_evidence_count": bundle["source_evidence_count"],
                   "archive_bytes": sum(row["bytes"] for row in bundle["volumes"]),
                   "source_rows_verified": len(sources), "duplicate_objects_omitted": len(sources) - len(resources),
                   "recovered_read_only_volumes": len(recovered_volumes), "recovered_objects": len(recovered),
                   "recovery_rejected_volumes": recovery_rejected,
                   "elapsed_seconds": round(time.monotonic() - started, 3), "volumes": bundle["volumes"]}
        write_json(reports / "audio-bundle-manifest.json", bundle)
        write_json(reports / "audio-bundle-verification.json", receipt)
        write_json(output / "verification.json", receipt)
        return receipt
    except Exception as error:
        if volumes.archive:
            volumes.archive.close()
        write_json(reports / "failed-export.json", {"status": "failed", "reason": str(error),
                   "source_manifest_sha256": external_sha, "qualification_granted": False,
                   "elapsed_seconds": round(time.monotonic() - started, 3)})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack")
    pack.add_argument("--manifest", required=True)
    pack.add_argument("--output", required=True)
    pack.add_argument("--report-dir", required=True)
    pack.add_argument("--max-bytes", type=int, default=GIB)
    pack.add_argument("--reuse-dir", help="Read-only closed volumes from a previous interrupted export")
    verify = commands.add_parser("verify")
    verify.add_argument("--manifest", required=True)
    args = parser.parse_args()
    result = package_manifest(args.manifest, args.output, args.report_dir, args.max_bytes, args.reuse_dir) \
        if args.command == "pack" else verify_bundle(args.manifest)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
