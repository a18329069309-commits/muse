import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest

import registered_library_connection as registered
import segment_library


def binding(path):
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class RegisteredLibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.base, self.delta, self.full = (self.root / name for name in ("base.sqlite", "delta.sqlite", "full.sqlite"))
        with sqlite3.connect(self.base) as db:
            for statement in segment_library.SCHEMA:
                db.execute(statement)
            for index, (asset, kind, blocked) in enumerate((
                    ("music", "music", 0), ("sfx", "sfx", 0), ("amb", "ambience", 0),
                    ("original", "music", 0), ("blocked", "music", 1))):
                sha = hashlib.sha256(asset.encode()).hexdigest()
                metadata = {"asset_kind": kind, "title": asset, "energy": 4, "dialogue_space": 3,
                            "fulltrack_voice_annotation": {"label": "voice"}, "substyles": ["period"],
                            "timbre": ["piano"], "license": {"status": "unknown"}}
                db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (asset, sha, asset, str(self.root / (asset + ".wav")), 1, 0, 40, 48000, 2, 0,
                            blocked, 1, json.dumps(metadata)))
                record = {"segment_id": asset + "-base", "asset_id": asset, "source_sha256": sha,
                          "source_start_seconds": 0, "source_end_seconds": 30, "phase": "rise",
                          "listening_status": "pending", "vocal_presence": "unknown",
                          "narrative_functions": ["pressure"], "case_id": asset + "-case"}
                db.execute("INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)",
                           (record["segment_id"], asset, sha, 0, 30, "rise", "pending", json.dumps(record)))
                db.execute("INSERT INTO functions VALUES(?,?)", (record["segment_id"], "pressure"))
                db.execute("INSERT INTO segment_text VALUES(?,?)", (record["segment_id"], "piano impact wind period"))
        db.close()
        with sqlite3.connect(self.delta) as db:
            for statement in segment_library.SCHEMA:
                db.execute(statement)
            db.execute("ATTACH DATABASE ? AS frozen", (str(self.base),))
            for asset in ("music", "sfx", "amb"):
                db.execute("INSERT INTO assets SELECT * FROM frozen.assets WHERE asset_id=?", (asset,))
                sha = hashlib.sha256(asset.encode()).hexdigest()
                record = {"segment_id": asset + "-new", "asset_id": asset, "source_sha256": sha,
                          "source_start_seconds": 10, "source_end_seconds": 20, "phase": "unknown",
                          "listening_status": "pending", "vocal_presence": "unknown",
                          "narrative_functions": [], "case_id": asset + "-case"}
                db.execute("INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)",
                           (record["segment_id"], asset, sha, 10, 20, "unknown", "pending", json.dumps(record)))
                db.execute("INSERT INTO segment_text VALUES(?,?)", (record["segment_id"], "piano impact wind period unknown"))
        db.close()
        with sqlite3.connect(self.base) as source, sqlite3.connect(self.full) as target:
            source.backup(target)
            target.execute("ATTACH DATABASE ? AS extra", (str(self.delta),))
            target.execute("INSERT INTO segments SELECT * FROM extra.segments")
            target.execute("INSERT INTO segment_text SELECT * FROM extra.segment_text")
        source.close(); target.close()
        self.descriptor = {"schema_version": 1, "kind": registered.KIND,
                           "base_db": binding(self.base), "delta_db": binding(self.delta)}

    def tearDown(self):
        self.directory.cleanup()

    def modify_delta(self, sql, values=()):
        with sqlite3.connect(self.delta) as db:
            db.execute(sql, values)
        db.close()
        self.descriptor["delta_db"] = binding(self.delta)

    def test_legacy_single_file_read_and_readonly(self):
        with registered.readonly_registered_library(self.base) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM assets").fetchone()[0], 5)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE assets SET blocked=0")
        db.close()

    def test_direct_music_sfx_ambience_fts_and_hard_filter_equivalence(self):
        query = types.FunctionType(segment_library.query_library.__code__,
            {**segment_library.__dict__, "readonly_registered_library":
                lambda *args: registered.readonly_registered_library(self.descriptor)},
            argdefs=segment_library.query_library.__defaults__)
        requests = [{"asset_kind": kind} for kind in ("music", "sfx", "ambience")]
        requests += [{"asset_kind": kind, "text": word} for kind, word in
                     (("music", "piano"), ("sfx", "impact"), ("ambience", "wind"))]
        requests += [{"asset_kind": "music", "phase": "unknown"},
                     {"asset_kind": "music", "min_duration": 15},
                     {"asset_kind": "music", "min_energy": 4, "min_dialogue_space": 3},
                     {"asset_kind": "music", "vocals": "sung", "discover_unknown_vocals": True},
                     {"asset_kind": "music", "avoid_families": ["music"]},
                     {"asset_kind": "music", "exclude_cases": ["music-case"]},
                     {"candidate_segment_ids": ["music-new", "original-base"], "preserve_source_windows": True}]
        for request in requests:
            with self.subTest(request=request):
                args = {**request, "limit": 20, "usage_scope": "research_noncommercial"}
                original = segment_library.query_library(self.full, **args)
                combined = query(self.full, **args)
                original.pop("query_ms"); combined.pop("query_ms")
                self.assertEqual(original, combined)
                self.assertNotIn("blocked", {item["asset_id"] for item in combined["candidates"]})
                self.assertTrue(all(item["output_use_status"] == "not_certified_by_retrieval"
                                    for item in combined["candidates"]))

    def test_original_and_unknown_windows_keep_exact_pointer_rows(self):
        db = registered.readonly_registered_library(self.descriptor)
        for sid in ("original-base", "music-new"):
            row = db.execute("SELECT * FROM segments WHERE segment_id=?", (sid,)).fetchone()
            with sqlite3.connect(self.full) as original:
                expected = original.execute("SELECT * FROM segments WHERE segment_id=?", (sid,)).fetchone()
            original.close()
            self.assertEqual(tuple(row), expected)
        self.assertEqual(db.execute("SELECT listening_status FROM segments WHERE segment_id='music-new'").fetchone()[0], "pending")
        with self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM segments")
        db.close()

    def test_base_or_delta_sha_changed_rejects(self):
        for key in ("base_db", "delta_db"):
            with self.subTest(key=key):
                descriptor = {**self.descriptor, key: {**self.descriptor[key], "sha256": "0" * 64}}
                with self.assertRaisesRegex(ValueError, "file_identity_changed"):
                    registered.readonly_registered_library(descriptor)

    def test_nonempty_wal_cannot_change_rows_outside_the_bound_database_sha(self):
        writer = sqlite3.connect(self.base)
        unexpected = None
        try:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.descriptor["base_db"] = binding(self.base)
            writer.execute("UPDATE assets SET blocked=1 WHERE asset_id='original'")
            writer.commit()
            self.assertEqual(binding(self.base), self.descriptor["base_db"])
            self.assertGreater(Path(str(self.base) + "-wal").stat().st_size, 0)
            with self.assertRaisesRegex(ValueError, "unbound_sqlite_sidecar"):
                unexpected = registered.readonly_registered_library(self.descriptor)
        finally:
            if unexpected is not None:
                unexpected.close()
            writer.close()

    def test_combined_connection_fts_stays_in_memory(self):
        db = registered.readonly_registered_library(self.descriptor)
        try:
            self.assertEqual(db.execute("PRAGMA temp_store").fetchone()[0], 2)
        finally:
            db.close()

    def test_combined_connection_holds_both_read_snapshots(self):
        db = registered.readonly_registered_library(self.descriptor)
        try:
            for file in (self.base, self.delta):
                writer = sqlite3.connect(file, timeout=0.025)
                try:
                    writer.execute("UPDATE assets SET blocked=1 WHERE asset_id='music'")
                    with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                        writer.commit()
                finally:
                    writer.rollback(); writer.close()
        finally:
            db.close()

    def test_descriptor_required_delta_cannot_masquerade_as_combined(self):
        for invalid in ({"base_db": self.descriptor["base_db"]}, {**self.descriptor, "kind": "other"}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "explicit_descriptor_required"):
                registered.readonly_registered_library(invalid)
        with self.assertRaisesRegex(ValueError, "distinct_files_required"):
            registered.readonly_registered_library({**self.descriptor, "delta_db": self.descriptor["base_db"]})

    def test_hash_bound_json_descriptor_is_read_and_bare_json_is_rejected(self):
        file = self.root / "registered-library.json"
        file.write_text(json.dumps(self.descriptor), encoding="utf-8")
        db = registered.readonly_registered_library(binding(file))
        try:
            self.assertEqual(db.execute("SELECT count(*) FROM segments").fetchone()[0], 8)
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "descriptor_binding_required"):
            registered.readonly_registered_library(file)

    def test_descriptor_bytes_changed_rejects_before_loading_its_databases(self):
        file = self.root / "registered-library.json"
        file.write_text(json.dumps(self.descriptor), encoding="utf-8")
        reference = binding(file)
        file.write_text(json.dumps({**self.descriptor, "kind": "other"}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "file_identity_changed"):
            registered.readonly_registered_library(reference)

    def test_changed_parent_asset_rejects(self):
        self.modify_delta("UPDATE assets SET blocked=1 WHERE asset_id='music'")
        with self.assertRaisesRegex(ValueError, "parent_asset_changed"):
            registered.readonly_registered_library(self.descriptor)

    def test_duplicate_source_window_rejects(self):
        self.modify_delta("UPDATE segments SET segment_id='music-base' WHERE segment_id='music-new'")
        with self.assertRaisesRegex(ValueError, "duplicate_window_identity"):
            registered.readonly_registered_library(self.descriptor)

    def test_outside_source_range_rejects(self):
        self.modify_delta("UPDATE segments SET end_s=41 WHERE segment_id='music-new'")
        with self.assertRaisesRegex(ValueError, "unqualified_window_required"):
            registered.readonly_registered_library(self.descriptor)

    def test_missing_fts_window_rejects(self):
        self.modify_delta("DELETE FROM segment_text WHERE segment_id='music-new'")
        with self.assertRaisesRegex(ValueError, "window_text_coverage_mismatch"):
            registered.readonly_registered_library(self.descriptor)

    def test_false_source_record_or_case_provenance_rejects(self):
        for field, value, error in (("source_sha256", "0" * 64, "window_record_mismatch"),
                                    ("case_id", "other-case", "case_provenance_mismatch")):
            with self.subTest(field=field):
                with sqlite3.connect(self.delta) as db:
                    original = db.execute("SELECT record_json FROM segments WHERE segment_id='music-new'").fetchone()[0]
                    record = json.loads(original); record[field] = value
                    db.execute("UPDATE segments SET record_json=? WHERE segment_id='music-new'", (json.dumps(record),))
                db.close()
                self.descriptor["delta_db"] = binding(self.delta)
                with self.assertRaisesRegex(ValueError, error):
                    registered.readonly_registered_library(self.descriptor)
                self.modify_delta("UPDATE segments SET record_json=? WHERE segment_id='music-new'", (original,))


if __name__ == "__main__":
    unittest.main()
