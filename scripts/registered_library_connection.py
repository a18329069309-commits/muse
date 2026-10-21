"""Read a legacy library or an explicit frozen-base/registered-window descriptor.

This adapter does not identify recordings, listen, qualify materials, or publish.
Existing callers are not switched to it by merely importing this module.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3


KIND = "frozen_base_registered_windows"
TABLES = ("assets", "segments", "functions", "segment_text")


def _reference(reference):
    if (not isinstance(reference, dict) or not isinstance(reference.get("path"), str)
            or not isinstance(reference.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", reference.get("sha256", ""))):
        raise ValueError("registered_library_file_binding_required")
    path = Path(reference["path"])
    if not path.is_absolute():
        raise ValueError("registered_library_absolute_path_required")
    if (str(path).startswith("\\\\") or (os.name == "nt"
            and ctypes.windll.kernel32.GetDriveTypeW(str(path.anchor)) == 4)):
        raise ValueError("registered_library_local_files_required")
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise ValueError("registered_library_unbound_sqlite_sidecar")
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    after = path.stat()
    if ((before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
            or digest.hexdigest() != reference["sha256"]):
        raise ValueError("registered_library_file_identity_changed")
    return path.resolve()


def _validate_delta(connection):
    for table in TABLES:
        base = connection.execute(f"PRAGMA frozen.table_info({table})").fetchall()
        delta = connection.execute(f"PRAGMA delta.table_info({table})").fetchall()
        if not base or [tuple(row) for row in base] != [tuple(row) for row in delta]:
            raise ValueError("registered_library_schema_mismatch")
    if connection.execute("SELECT * FROM delta.assets EXCEPT SELECT * FROM frozen.assets LIMIT 1").fetchone():
        raise ValueError("registered_library_parent_asset_changed")
    if connection.execute("SELECT 1 FROM delta.segments JOIN frozen.segments USING(segment_id) LIMIT 1").fetchone():
        raise ValueError("registered_library_duplicate_window_identity")
    invalid = connection.execute("""SELECT 1 FROM delta.segments s
        LEFT JOIN frozen.assets a USING(asset_id)
        LEFT JOIN delta.assets d USING(asset_id)
        WHERE a.asset_id IS NULL OR d.asset_id IS NULL OR a.blocked<>0
        OR s.source_sha256<>a.source_sha256 OR NOT(0<=s.start_s AND s.start_s<s.end_s AND s.end_s<=a.duration)
        OR s.phase<>'unknown' OR s.listening_status<>'pending' LIMIT 1""").fetchone()
    if invalid or connection.execute("SELECT 1 FROM delta.functions LIMIT 1").fetchone():
        raise ValueError("registered_library_unqualified_window_required")
    orphan = connection.execute("""SELECT 1 FROM delta.segment_text t LEFT JOIN delta.segments s USING(segment_id)
        WHERE s.segment_id IS NULL LIMIT 1""").fetchone()
    missing = connection.execute("""SELECT 1 FROM delta.segments s LEFT JOIN delta.segment_text t USING(segment_id)
        GROUP BY s.segment_id HAVING count(t.segment_id)<>1 LIMIT 1""").fetchone()
    if orphan or missing:
        raise ValueError("registered_library_window_text_coverage_mismatch")
    for row in connection.execute("SELECT * FROM delta.segments"):
        record = json.loads(row["record_json"])
        if (record.get("segment_id") != row["segment_id"] or record.get("asset_id") != row["asset_id"]
                or record.get("source_sha256") != row["source_sha256"]
                or [record.get("source_start_seconds"), record.get("source_end_seconds")]
                != [row["start_s"], row["end_s"]]
                or record.get("phase") != "unknown" or record.get("listening_status") != "pending"
                or record.get("vocal_presence") != "unknown" or record.get("narrative_functions") != []):
            raise ValueError("registered_library_window_record_mismatch")
        parents = connection.execute("""SELECT record_json FROM frozen.segments
            WHERE asset_id=? AND source_sha256=? AND start_s<=? AND end_s>=?""",
            (row["asset_id"], row["source_sha256"], row["start_s"], row["end_s"])).fetchall()
        cases = {json.loads(parent[0]).get("case_id") for parent in parents} - {None}
        if len(cases) > 1 or record.get("case_id") != next(iter(cases), None):
            raise ValueError("registered_library_window_case_provenance_mismatch")


def readonly_registered_library(library):
    """Return a SQLite connection; callers retain their existing query/guards."""
    descriptor_binding = None
    if isinstance(library, dict) and "path" in library:
        descriptor_binding = library
        descriptor_path = _reference(descriptor_binding)
        if descriptor_path.suffix.lower() != ".json":
            raise ValueError("registered_library_explicit_descriptor_required")
        library = json.loads(descriptor_path.read_text(encoding="utf-8-sig"))
    if isinstance(library, (str, Path)):
        if Path(library).suffix.lower() == ".json":
            raise ValueError("registered_library_descriptor_binding_required")
        connection = sqlite3.connect(Path(library).resolve().as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        return connection
    if (not isinstance(library, dict) or library.get("schema_version") != 1
            or library.get("kind") != KIND):
        raise ValueError("registered_library_explicit_descriptor_required")
    base, delta = _reference(library.get("base_db")), _reference(library.get("delta_db"))
    if base == delta:
        raise ValueError("registered_library_distinct_files_required")
    connection = sqlite3.connect(":memory:", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("ATTACH DATABASE ? AS frozen", (base.as_uri() + "?mode=ro",))
        connection.execute("ATTACH DATABASE ? AS delta", (delta.as_uri() + "?mode=ro",))
        connection.execute("BEGIN")
        connection.execute("SELECT count(*) FROM frozen.assets").fetchone()
        connection.execute("SELECT count(*) FROM delta.assets").fetchone()
        _validate_delta(connection)
        connection.execute("CREATE TEMP VIEW assets AS SELECT * FROM frozen.assets")
        connection.execute("CREATE TEMP VIEW segments AS SELECT * FROM frozen.segments UNION ALL SELECT * FROM delta.segments")
        connection.execute("CREATE TEMP VIEW functions AS SELECT * FROM frozen.functions UNION ALL SELECT * FROM delta.functions")
        connection.execute("CREATE VIRTUAL TABLE temp.segment_text USING fts5(segment_id UNINDEXED, words)")
        connection.execute("INSERT INTO temp.segment_text SELECT segment_id,words FROM frozen.segment_text")
        connection.execute("INSERT INTO temp.segment_text SELECT segment_id,words FROM delta.segment_text")
        # Verify the actual files again after constructing the logical snapshot.
        _reference(library["base_db"])
        _reference(library["delta_db"])
        if descriptor_binding is not None:
            _reference(descriptor_binding)
        connection.execute("PRAGMA query_only=ON")
        return connection
    except BaseException:
        connection.close()
        raise
