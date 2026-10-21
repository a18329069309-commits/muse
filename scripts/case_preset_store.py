"""Query source-bound narrative cases and same-recording music windows.

No media copying, model calls, semantic inference, or current artistic approval.
Case status is declared evidence checked here, never inferred from popularity.
"""
import argparse
from contextlib import closing
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3

from route_music_cues import expand_music_cues
from segment_library import digest_file, terms
from registered_library_connection import readonly_registered_library


CONDITION_KEYS = {"narrative_function", "perspective", "relationship", "control_state",
                  "control_change", "threat_resolved", "expectation_state", "era",
                  "dialogue_density", "knowledge_state"}
STORY_KEYS = CONDITION_KEYS - {"narrative_function", "era", "dialogue_density"}
HARD_STORY_KEYS = STORY_KEYS - {"perspective"}
# Only explicit class labels are hard relationship facts; descriptions need semantic review.
RELATIONSHIP_CLASSES = {"family": "family", "mother_daughter": "family", "romantic": "romantic"}
STATUSES = {"research", "observed", "approved"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS works(work_id TEXT PRIMARY KEY,title TEXT NOT NULL,
 split TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episodes(episode_id TEXT PRIMARY KEY,
 work_id TEXT NOT NULL REFERENCES works(work_id),media_status TEXT NOT NULL,
 source_sha256 TEXT,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS packs(pack_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,status TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS windows(pack_id TEXT NOT NULL REFERENCES packs(pack_id),
 window_id TEXT NOT NULL,segment_id TEXT NOT NULL,start_s REAL NOT NULL,end_s REAL NOT NULL,
 record_json TEXT NOT NULL,PRIMARY KEY(pack_id,window_id));
CREATE TABLE IF NOT EXISTS cases(case_id TEXT PRIMARY KEY,
 episode_id TEXT NOT NULL REFERENCES episodes(episode_id),status TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conditions(case_id TEXT NOT NULL REFERENCES cases(case_id),
 key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(case_id,key));
CREATE INDEX IF NOT EXISTS condition_lookup ON conditions(key,value,case_id);
CREATE INDEX IF NOT EXISTS case_episode ON cases(episode_id);
CREATE INDEX IF NOT EXISTS episode_source_hash ON episodes(source_sha256);
CREATE VIRTUAL TABLE IF NOT EXISTS case_text USING fts5(case_id UNINDEXED,words);
"""
SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS theme_bundles(theme_bundle_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_identities(work_id TEXT NOT NULL REFERENCES works(work_id),
 identity TEXT NOT NULL,PRIMARY KEY(work_id,identity));
CREATE INDEX IF NOT EXISTS work_identity_lookup ON work_identities(identity,work_id);
CREATE TABLE IF NOT EXISTS theme_members(theme_bundle_id TEXT NOT NULL REFERENCES theme_bundles(theme_bundle_id),
 pack_id TEXT NOT NULL REFERENCES packs(pack_id),PRIMARY KEY(theme_bundle_id,pack_id));
CREATE INDEX IF NOT EXISTS theme_pack_lookup ON theme_members(pack_id,theme_bundle_id);
CREATE TABLE IF NOT EXISTS sound_packs(sound_pack_id TEXT PRIMARY KEY,status TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sound_members(sound_pack_id TEXT NOT NULL REFERENCES sound_packs(sound_pack_id),
 member_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(sound_pack_id,member_id));
CREATE TABLE IF NOT EXISTS case_themes(case_id TEXT NOT NULL REFERENCES cases(case_id),
 theme_bundle_id TEXT NOT NULL REFERENCES theme_bundles(theme_bundle_id),PRIMARY KEY(case_id,theme_bundle_id));
CREATE TABLE IF NOT EXISTS case_sounds(case_id TEXT NOT NULL REFERENCES cases(case_id),
 sound_pack_id TEXT NOT NULL REFERENCES sound_packs(sound_pack_id),PRIMARY KEY(case_id,sound_pack_id));
CREATE INDEX IF NOT EXISTS case_theme_lookup ON case_themes(theme_bundle_id,case_id);
CREATE INDEX IF NOT EXISTS case_sound_lookup ON case_sounds(sound_pack_id,case_id);
CREATE TABLE IF NOT EXISTS case_sequences(case_id TEXT PRIMARY KEY REFERENCES cases(case_id),sequence_key TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sequence_lookup ON case_sequences(sequence_key,case_id);
CREATE TABLE IF NOT EXISTS sequence_steps(case_id TEXT NOT NULL REFERENCES cases(case_id),
 position INTEGER NOT NULL,narrative_function TEXT NOT NULL,PRIMARY KEY(case_id,position));
CREATE INDEX IF NOT EXISTS sequence_step_lookup ON sequence_steps(narrative_function,case_id,position);
CREATE TABLE IF NOT EXISTS sequence_conditions(case_id TEXT NOT NULL REFERENCES cases(case_id),
 position INTEGER NOT NULL,phase TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,
 PRIMARY KEY(case_id,position,phase,key));
"""


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"nonempty_{name}_required")
    return value.strip()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("valid_sha256_required")
    return value


def source_range(value):
    if (not isinstance(value, list) or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in value)
            or not 0 <= value[0] < value[1]):
        raise ValueError("valid_source_range_required")
    return value


def known_conditions(value):
    if not isinstance(value, dict) or set(value) - CONDITION_KEYS:
        raise ValueError("invalid_case_conditions")
    result = {}
    for key, item in value.items():
        if item is None or item == "unknown":
            continue
        if key == "threat_resolved":
            if not isinstance(item, bool):
                raise ValueError("threat_resolved_must_be_boolean_or_null")
        else:
            item = text(item, key)
        result[key] = item
    return result


def readonly(filename):
    if not Path(filename).is_file():
        raise ValueError("database_missing")
    connection = sqlite3.connect(Path(filename).resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def init_store(filename):
    Path(filename).resolve().parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(filename)) as db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2):
            raise ValueError("unsupported_case_store_schema")
        sequence_index_missing = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sequence_steps'").fetchone() is None
        db.executescript(SCHEMA)
        db.executescript(SCHEMA_V2)
        if sequence_index_missing:
            for case_id, record in db.execute("SELECT case_id,record_json FROM cases").fetchall():
                db.executemany("INSERT INTO sequence_steps VALUES(?,?,?)", [
                    (case_id, position, step["narrative_function"])
                    for position, step in enumerate(json.loads(record).get("story_sequence", []))])
        for work_id, record in db.execute("SELECT work_id,record_json FROM works").fetchall():
            db.executemany("INSERT OR IGNORE INTO work_identities VALUES(?,?)",
                           [(work_id, value) for value in work_identities(json.loads(record))])
        if version != 2:
            db.execute("PRAGMA user_version=2")
        db.commit()
    return {"schema_version": 1, "store_schema_version": 2, "status": "initialized"}


def file_binding(binding, base, hash_cache=None):
    path = (base / text(binding.get("path"), "path")).resolve()
    expected = sha(binding.get("sha256"))
    io_path = path
    value = str(path)
    if os.name == "nt" and len(value) >= 260 and not value.startswith("\\\\?\\"):
        io_path = Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)
    before = io_path.stat() if io_path.is_file() else None
    if not before:
        raise ValueError("evidence_file_missing_or_hash_changed")
    signature = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    cached = hash_cache.get(str(path)) if hash_cache is not None else None
    actual = cached[1] if cached and cached[0] == signature else digest_file(io_path)
    after = io_path.stat()
    if actual != expected or signature != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("evidence_file_missing_or_hash_changed")
    if hash_cache is not None:
        hash_cache[str(path)] = (signature, actual)
    return {**binding, "path": str(path), "sha256": expected}


def bound_audio_evidence(evidence, source_hash, interval, base, hash_cache=None):
    if (evidence.get("source_sha256") != source_hash or evidence.get("source_range") != interval
            or evidence.get("actual_audio_processed") is not True
            or not evidence.get("observations") or not evidence.get("files")):
        raise ValueError("observed_pack_requires_bound_window_audio_evidence")
    return {**evidence, "files": [file_binding(binding, base, hash_cache) for binding in evidence["files"]]}


def id_list(value, name, maximum=20):
    if (not isinstance(value, list) or len(value) > maximum
            or any(not isinstance(item, str) or not item.strip() for item in value)
            or len(set(value)) != len(value)):
        raise ValueError(f"invalid_{name}")
    return value


def work_identities(record):
    values = ["alias:" + alias for alias in id_list(record.get("identity_aliases", []), "work_identity_aliases")]
    if record.get("official_series_id") is not None:
        values.append("official_series:" + text(record["official_series_id"], "official_series_id"))
    return values


def heldout_clause(identity_isolation=False):
    clause = ("w.split!='heldout' AND NOT EXISTS(SELECT 1 FROM episodes h JOIN works hw ON hw.work_id=h.work_id "
              "WHERE h.source_sha256=e.source_sha256 AND hw.split='heldout')")
    if identity_isolation:
        clause += (" AND NOT EXISTS(SELECT 1 FROM work_identities i JOIN work_identities hi ON hi.identity=i.identity "
                   "JOIN works hw ON hw.work_id=hi.work_id WHERE i.work_id=w.work_id AND hw.split='heldout')")
    return clause


def story_sequence(value):
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("invalid_story_sequence")
    seen, result = set(), []
    for step in value:
        if not isinstance(step, dict):
            raise ValueError("invalid_story_step")
        step_id = text(step.get("step_id"), "story_step_id")
        if step_id in seen:
            raise ValueError("duplicate_story_step_id")
        seen.add(step_id)
        result.append({**step, "step_id": step_id,
            "narrative_function": text(step.get("narrative_function"), "story_step_function"),
            "before": known_conditions(step.get("before", {})), "after": known_conditions(step.get("after", {}))})
    return result


def variant_evidence(evidence, hashes, base, hash_cache=None):
    if (evidence.get("source_sha256s") != hashes or evidence.get("actual_audio_processed") is not True
            or not evidence.get("observations") or not evidence.get("files")):
        raise ValueError("variant_requires_bound_actual_audio_evidence")
    return {**evidence, "files": [file_binding(binding, base, hash_cache) for binding in evidence["files"]]}


def import_bundles(db, document, base):
    for item in document.get("theme_bundles", []):
        bundle_id = text(item.get("theme_bundle_id"), "theme_bundle_id")
        pack_ids = id_list(item.get("music_pack_ids", []), "theme_music_pack_ids")
        if len(pack_ids) < 2:
            raise ValueError("theme_requires_multiple_recording_packs")
        packs = {pack_id: db.execute("SELECT source_sha256 FROM packs WHERE pack_id=?", (pack_id,)).fetchone()
                 for pack_id in pack_ids}
        if not all(packs.values()):
            raise ValueError("theme_music_pack_missing")
        relations = item.get("variant_relations", [])
        if not isinstance(relations, list) or len(relations) > 20:
            raise ValueError("invalid_variant_relations")
        checked = []
        for relation in relations:
            before, after = relation.get("from_pack_id"), relation.get("to_pack_id")
            if before not in packs or after not in packs or before == after or packs[before][0] == packs[after][0]:
                raise ValueError("variant_requires_distinct_bound_recordings")
            text(relation.get("relation"), "variant_relation")
            status = relation.get("status", "research")
            if status not in STATUSES:
                raise ValueError("invalid_variant_status")
            evidence = relation.get("evidence", {})
            hashes = [packs[before][0], packs[after][0]]
            if status in ("observed", "approved"):
                evidence = variant_evidence(evidence, hashes, base)
            if status == "approved":
                review = evidence.get("review", {})
                if (review.get("status") != "approved" or not review.get("reviewer") or not review.get("reason")
                        or review.get("source_sha256s") != hashes):
                    raise ValueError("approved_variant_requires_bound_review")
            checked.append({**relation, "status": status, "source_sha256s": hashes, "evidence": evidence})
        db.execute("INSERT OR REPLACE INTO theme_bundles VALUES(?,?)",
                   (bundle_id, dump({**item, "music_pack_ids": pack_ids, "variant_relations": checked})))
        db.execute("DELETE FROM theme_members WHERE theme_bundle_id=?", (bundle_id,))
        db.executemany("INSERT INTO theme_members VALUES(?,?)", [(bundle_id, pack_id) for pack_id in pack_ids])
    for item in document.get("sound_packs", []):
        pack_id = text(item.get("sound_pack_id"), "sound_pack_id")
        status = item.get("status", "research")
        if status not in STATUSES:
            raise ValueError("invalid_sound_pack_status")
        members = item.get("members", [])
        if not isinstance(members, list) or not 1 <= len(members) <= 20:
            raise ValueError("sound_pack_requires_1_to_20_members")
        id_list([member.get("member_id") for member in members], "sound_member_ids")
        checked = []
        for member in members:
            source_hash = sha(member.get("source_sha256"))
            interval = source_range(member.get("source_range"))
            text(member.get("asset_id"), "sound_asset_id")
            text(member.get("segment_id"), "sound_segment_id")
            if member.get("sound_role") not in ("physical", "foley", "dramatic", "transition", "ambience"):
                raise ValueError("invalid_sound_role")
            anchor = member.get("source_anchor_seconds")
            if anchor is not None and (isinstance(anchor, bool) or not isinstance(anchor, (int, float))
                                      or not math.isfinite(anchor) or not interval[0] <= anchor < interval[1]):
                raise ValueError("sound_anchor_outside_source_window")
            old = db.execute("SELECT record_json FROM sound_members WHERE sound_pack_id=? AND member_id=?",
                             (pack_id, member["member_id"])).fetchone()
            if old and any(json.loads(old[0]).get(key) != member.get(key) for key in (
                    "asset_id", "segment_id", "source_sha256", "source_range")):
                raise ValueError("changed_sound_member_requires_new_id")
            evidence = member.get("listening_evidence", {})
            if status in ("observed", "approved"):
                evidence = bound_audio_evidence(evidence, source_hash, interval, base)
            if status == "approved":
                review = evidence.get("review", {})
                if (review.get("status") != "approved" or not review.get("reviewer") or not review.get("reason")
                        or review.get("source_sha256") != source_hash or review.get("source_range") != interval):
                    raise ValueError("approved_sound_requires_window_bound_review")
            clean_status = member.get("clean_content_status", "unknown")
            if clean_status not in ("unknown", "verified", "contaminated"):
                raise ValueError("invalid_sound_clean_content_status")
            clean_evidence = member.get("cleanliness_evidence", {})
            if clean_status == "verified":
                clean_evidence = bound_audio_evidence(clean_evidence, source_hash, interval, base)
                if clean_evidence.get("unwanted_speech_absent") is not True or clean_evidence.get("unwanted_music_absent") is not True:
                    raise ValueError("clean_sound_requires_contamination_check")
            checked.append({**member, "listening_evidence": evidence, "clean_content_status": clean_status,
                            "cleanliness_evidence": clean_evidence})
        db.execute("INSERT OR REPLACE INTO sound_packs VALUES(?,?,?)", (pack_id, status, dump({**item, "status": status, "members": checked})))
        db.execute("DELETE FROM sound_members WHERE sound_pack_id=?", (pack_id,))
        db.executemany("INSERT INTO sound_members VALUES(?,?,?)", [(pack_id, member["member_id"], dump(member)) for member in checked])


def validate_case_development(db, case):
    sequence = story_sequence(case.get("story_sequence", []))
    theme_ids = id_list(case.get("theme_bundle_ids", []), "case_theme_bundle_ids")
    sound_ids = id_list(case.get("sound_pack_ids", []), "case_sound_pack_ids")
    pack_ids = set(case.get("music_pack_ids", []))
    for bundle_id in theme_ids:
        if not db.execute("SELECT 1 FROM theme_bundles WHERE theme_bundle_id=?", (bundle_id,)).fetchone():
            raise ValueError("case_theme_bundle_missing")
        pack_ids.update(row[0] for row in db.execute("SELECT pack_id FROM theme_members WHERE theme_bundle_id=?", (bundle_id,)))
    for pack_id in sound_ids:
        if not db.execute("SELECT 1 FROM sound_packs WHERE sound_pack_id=?", (pack_id,)).fetchone():
            raise ValueError("case_sound_pack_missing")
    preset = case.get("development_preset", {"steps": []})
    if not isinstance(preset, dict) or not isinstance(preset.get("steps"), list) or len(preset["steps"]) > 20:
        raise ValueError("invalid_development_preset")
    id_list([step.get("step_id") for step in preset["steps"]], "development_step_ids")
    event_ids = None
    if "source_events" in case:
        events = case["source_events"]
        if not isinstance(events, list) or len(events) > 20 or any(not isinstance(event, dict) for event in events):
            raise ValueError("invalid_case_source_events")
        event_ids = set(id_list([event.get("event_id") for event in events], "case_source_event_ids"))
        interval = source_range(case["source_range"])
        for event in events:
            span = source_range(event.get("source_range"))
            if not interval[0] <= span[0] < span[1] <= interval[1]:
                raise ValueError("source_event_outside_case")
            if "observation_ids" in event:
                observations = id_list(event["observation_ids"], "source_event_observation_ids")
                if not observations or "observation_ids" in case.get("evidence", {}) and not set(observations) <= set(case["evidence"]["observation_ids"]):
                    raise ValueError("source_event_observations_not_bound_to_case")
    positions = {step["step_id"]: index for index, step in enumerate(sequence)}
    previous = -1
    for step in preset["steps"]:
        position = positions.get(step.get("story_step_id"), -1)
        if position < previous or position == -1:
            raise ValueError("development_requires_ordered_story_binding")
        previous = position
        if event_ids is not None and step.get("source_event_id") is not None and step["source_event_id"] not in event_ids:
            raise ValueError("development_source_event_not_bound_to_case")
        text(step.get("action"), "development_action")
        text(step.get("anchor"), "development_anchor")
        offset = step.get("offset_seconds", 0)
        if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset):
            raise ValueError("finite_relative_offset_required")
        if not set(id_list(step.get("music_pack_ids", []), "development_music_pack_ids")) <= pack_ids:
            raise ValueError("development_music_pack_not_bound_to_case")
        if not set(id_list(step.get("sound_pack_ids", []), "development_sound_pack_ids")) <= set(sound_ids):
            raise ValueError("development_sound_pack_not_bound_to_case")
        refs = step.get("window_refs", [])
        if not isinstance(refs, list) or len(refs) > 20:
            raise ValueError("invalid_development_window_refs")
        for ref in refs:
            if ref.get("pack_id") not in pack_ids or not db.execute("SELECT 1 FROM windows WHERE pack_id=? AND window_id=?",
                    (ref.get("pack_id"), ref.get("window_id"))).fetchone():
                raise ValueError("development_window_missing_or_unbound")
    return sequence, preset, theme_ids, sound_ids


def import_store(filename, document, base_dir=None, evidence_checker=None):
    if document.get("schema_version") not in (1, 2):
        raise ValueError("schema_version_1_or_2_required")
    base = Path(base_dir or ".").resolve()
    check = evidence_checker or file_binding
    init_store(filename)
    with closing(sqlite3.connect(filename)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        for item in document.get("works", []):
            work_id = text(item.get("work_id"), "work_id")
            if item.get("split", "research") not in ("research", "calibration", "heldout"):
                raise ValueError("invalid_work_split")
            old = db.execute("SELECT split,record_json FROM works WHERE work_id=?", (work_id,)).fetchone()
            if old and old[0] != item.get("split", "research"):
                raise ValueError("work_split_is_immutable")
            prior = json.loads(old[1]) if old else {}
            if prior.get("official_series_id") and "official_series_id" in item and item["official_series_id"] != prior["official_series_id"]:
                raise ValueError("official_series_identity_is_immutable")
            record = {**prior, **item, "split": item.get("split", "research")}
            record["identity_aliases"] = list(dict.fromkeys([*prior.get("identity_aliases", []),
                *id_list(item.get("identity_aliases", []), "work_identity_aliases")]))
            db.execute("INSERT OR REPLACE INTO works VALUES(?,?,?,?)",
                       (work_id, text(item.get("title"), "title"), record["split"], dump(record)))
            db.executemany("INSERT OR IGNORE INTO work_identities VALUES(?,?)",
                           [(work_id, value) for value in work_identities(record)])
        for item in document.get("episodes", []):
            episode_id = text(item.get("episode_id"), "episode_id")
            status = item.get("media_status", "metadata_only")
            if status not in ("metadata_only", "acquired", "local_verified", "observed"):
                raise ValueError("invalid_episode_media_status")
            record = dict(item)
            if status != "metadata_only":
                record["source_video"] = check(item.get("source_video", {}), base)
            source_hash = record.get("source_video", {}).get("sha256")
            if source_hash is not None:
                sha(source_hash)
            old = db.execute("SELECT work_id,source_sha256 FROM episodes WHERE episode_id=?", (episode_id,)).fetchone()
            if old and (old[0] != item["work_id"] or (old[1] and old[1] != source_hash)):
                raise ValueError("changed_episode_identity_requires_new_id")
            db.execute("INSERT OR REPLACE INTO episodes VALUES(?,?,?,?,?)",
                       (episode_id, text(item.get("work_id"), "work_id"), status, source_hash, dump(record)))
        for item in document.get("packs", []):
            pack_id, asset_id = text(item.get("pack_id"), "pack_id"), text(item.get("asset_id"), "asset_id")
            source_hash = sha(item.get("source_sha256"))
            status = item.get("status", "research")
            if status not in STATUSES:
                raise ValueError("invalid_pack_status")
            old = db.execute("SELECT asset_id,source_sha256 FROM packs WHERE pack_id=?", (pack_id,)).fetchone()
            if old and tuple(old) != (asset_id, source_hash):
                raise ValueError("changed_pack_source_requires_new_id")
            windows = item.get("windows", [])
            if not isinstance(windows, list) or not 1 <= len(windows) <= 12:
                raise ValueError("pack_requires_1_to_12_windows")
            seen = set()
            for window in windows:
                segment_id = text(window.get("segment_id"), "segment_id")
                start, end = source_range(window.get("source_range"))
                window_id = window.get("window_id", f"{segment_id}:{start}:{end}")
                text(window_id, "window_id")
                if window_id in seen:
                    raise ValueError("duplicate_pack_window")
                seen.add(window_id)
                old_window = db.execute("SELECT segment_id,start_s,end_s FROM windows WHERE pack_id=? AND window_id=?",
                                        (pack_id, window_id)).fetchone()
                if old_window and tuple(old_window) != (segment_id, start, end):
                    raise ValueError("changed_window_requires_new_id")
                if status in ("observed", "approved"):
                    window["listening_evidence"] = bound_audio_evidence(window.get("listening_evidence", {}), source_hash, [start, end], base)
                    if status == "approved":
                        review = window["listening_evidence"].get("review", {})
                        if (review.get("status") != "approved" or not review.get("reviewer") or not review.get("reason")
                                or review.get("source_sha256") != source_hash or review.get("source_range") != [start, end]):
                            raise ValueError("approved_pack_requires_window_bound_review")
                if window.get("words_evidence", {}).get("evidence_files"):
                    window["words_evidence"] = {**window["words_evidence"], "evidence_files": [
                        check(binding, base) for binding in window["words_evidence"]["evidence_files"]]}
            db.execute("INSERT OR REPLACE INTO packs VALUES(?,?,?,?,?)",
                       (pack_id, asset_id, source_hash, status, dump({**item, "status": status})))
            db.execute("DELETE FROM windows WHERE pack_id=?", (pack_id,))
            for window in windows:
                start, end = window["source_range"]
                window_id = window.get("window_id", f"{window['segment_id']}:{start}:{end}")
                db.execute("INSERT INTO windows VALUES(?,?,?,?,?,?)",
                           (pack_id, window_id, window["segment_id"], start, end, dump({**window, "window_id": window_id})))
        import_bundles(db, document, base)
        for item in document.get("cases", []):
            case_id, episode_id = text(item.get("case_id"), "case_id"), text(item.get("episode_id"), "episode_id")
            status = item.get("status", "research")
            if status not in STATUSES:
                raise ValueError("invalid_case_status")
            conditions = known_conditions(item.get("conditions", {}))
            episode = db.execute("SELECT * FROM episodes WHERE episode_id=?", (episode_id,)).fetchone()
            if not episode:
                raise ValueError("case_episode_missing")
            interval = source_range(item.get("source_range"))
            evidence = dict(item.get("evidence", {}))
            if status in ("observed", "approved"):
                if (episode["media_status"] == "metadata_only"
                        or evidence.get("source_video_sha256") != episode["source_sha256"]
                        or evidence.get("source_range") != interval
                        or evidence.get("actual_audio_processed") is not True
                        or evidence.get("actual_video_processed") is not True
                        or not evidence.get("observations") or not evidence.get("files")):
                    raise ValueError("observed_case_requires_bound_audio_visual_evidence")
                evidence["files"] = [check(binding, base) for binding in evidence["files"]]
            if status == "approved":
                review = evidence.get("review", {})
                if (review.get("status") != "approved" or not review.get("reviewer") or not review.get("reason")
                        or review.get("source_video_sha256") != episode["source_sha256"]
                        or review.get("source_range") != interval):
                    raise ValueError("approved_case_requires_window_bound_review")
            actions = item.get("sound_actions", [])
            if not isinstance(actions, list) or len(actions) > 20:
                raise ValueError("invalid_sound_actions")
            for action in actions:
                text(action.get("anchor"), "relative_action_anchor")
                text(action.get("action"), "sound_action")
                if not isinstance(action.get("offset_seconds", 0), (float, int)) or isinstance(action.get("offset_seconds", 0), bool) or not math.isfinite(action.get("offset_seconds", 0)):
                    raise ValueError("finite_relative_offset_required")
            pack_ids = item.get("music_pack_ids", [])
            if not isinstance(pack_ids, list) or len(pack_ids) > 5 or len(set(pack_ids)) != len(pack_ids):
                raise ValueError("invalid_case_music_pack_ids")
            for pack_id in pack_ids:
                if not db.execute("SELECT 1 FROM packs WHERE pack_id=?", (pack_id,)).fetchone():
                    raise ValueError("case_music_pack_missing")
            old = db.execute("SELECT record_json FROM cases WHERE case_id=?", (case_id,)).fetchone()
            if old:
                prior = json.loads(old[0])
                if prior["episode_id"] != episode_id or prior["source_range"] != interval:
                    raise ValueError("changed_case_identity_requires_new_id")
            sequence, preset, theme_ids, sound_ids = validate_case_development(db, item)
            record = {**item, "status": status, "evidence": evidence, "story_sequence": sequence,
                      "development_preset": preset, "theme_bundle_ids": theme_ids, "sound_pack_ids": sound_ids}
            db.execute("INSERT OR REPLACE INTO cases VALUES(?,?,?,?)", (case_id, episode_id, status, dump(record)))
            db.execute("DELETE FROM conditions WHERE case_id=?", (case_id,))
            db.executemany("INSERT INTO conditions VALUES(?,?,?)", [(case_id, key, dump(value)) for key, value in conditions.items()])
            db.execute("DELETE FROM case_text WHERE case_id=?", (case_id,))
            db.execute("INSERT INTO case_text VALUES(?,?)", (case_id, " ".join(terms(dump([item.get("description", ""), item.get("style_tags", [])])))))
            for table in ("case_sequences", "sequence_steps", "sequence_conditions", "case_themes", "case_sounds"):
                db.execute(f"DELETE FROM {table} WHERE case_id=?", (case_id,))
            if sequence:
                db.execute("INSERT INTO case_sequences VALUES(?,?)", (case_id, dump([step["narrative_function"] for step in sequence])))
                db.executemany("INSERT INTO sequence_steps VALUES(?,?,?)", [
                    (case_id, position, step["narrative_function"]) for position, step in enumerate(sequence)])
                db.executemany("INSERT INTO sequence_conditions VALUES(?,?,?,?,?)", [
                    (case_id, index, phase, key, dump(value)) for index, step in enumerate(sequence)
                    for phase in ("before", "after") for key, value in step[phase].items()])
            db.executemany("INSERT INTO case_themes VALUES(?,?)", [(case_id, bundle_id) for bundle_id in theme_ids])
            db.executemany("INSERT INTO case_sounds VALUES(?,?)", [(case_id, pack_id) for pack_id in sound_ids])
    return report_store(filename)


def report_store(filename):
    with closing(readonly(filename)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        eligible = heldout_clause("work_identities" in tables)
        counts = {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] if table in tables else 0
            for table in ("works", "episodes", "cases", "packs", "windows", "theme_bundles", "sound_packs",
                          "sound_members", "case_sequences", "case_themes", "case_sounds")}
        counts["development_presets"] = db.execute("SELECT count(*) FROM cases "
            "WHERE json_array_length(json_extract(record_json,'$.development_preset.steps'))>0").fetchone()[0]
        checked = {kind: {status: 0 for status in ("observed", "approved")}
                   for kind in ("cases", "music_windows", "sound_windows", "variant_relations")}
        cache = {}
        for row in db.execute("SELECT c.record_json,e.record_json FROM cases c JOIN episodes e USING(episode_id) WHERE c.status!='research'"):
            case, episode = json.loads(row[0]), json.loads(row[1])
            try:
                file_binding(episode["source_video"], Path("."), cache)
                for binding in case["evidence"]["files"]:
                    file_binding(binding, Path("."), cache)
                checked["cases"][case["status"]] += 1
            except (ValueError, OSError):
                pass
        for row in db.execute("SELECT p.status,p.source_sha256,w.record_json FROM packs p JOIN windows w USING(pack_id) WHERE p.status!='research'"):
            window = json.loads(row[2])
            try:
                bound_audio_evidence(window.get("listening_evidence", {}), row[1], window["source_range"], Path("."), cache)
                checked["music_windows"][row[0]] += 1
            except (ValueError, OSError):
                pass
        if "sound_packs" in tables:
            for row in db.execute("SELECT p.status,m.record_json FROM sound_packs p JOIN sound_members m USING(sound_pack_id) WHERE p.status!='research'"):
                member = json.loads(row[1])
                try:
                    bound_audio_evidence(member.get("listening_evidence", {}), member["source_sha256"], member["source_range"], Path("."), cache)
                    checked["sound_windows"][row[0]] += 1
                except (ValueError, OSError):
                    pass
            for row in db.execute("SELECT theme_bundle_id FROM theme_bundles"):
                for relation in bound_theme(db, row[0], cache)["variant_relations"]:
                    if relation["historical_variant_verified"]:
                        checked["variant_relations"][relation["status"]] += 1
        return {"schema_version": 1, "store_schema_version": db.execute("PRAGMA user_version").fetchone()[0],
            "status": "store_report", "counts": counts,
            "sequence_case_count": counts["case_sequences"], "development_preset_count": counts["development_presets"],
            "sequence_match_modes": ["exact", "ordered_compatible"] if "sequence_steps" in tables else ["exact"],
            "theme_bundle_count": counts["theme_bundles"], "sound_pack_count": counts["sound_packs"],
            "bound_historical_evidence_counts": checked, "qualification_scope": "bound_records_and_files_only",
            "story_sequence_catalog": [json.loads(row[0]) for row in db.execute(
                "SELECT DISTINCT s.sequence_key FROM case_sequences s JOIN cases c USING(case_id) "
                "JOIN episodes e USING(episode_id) JOIN works w USING(work_id) WHERE " + eligible +
                " ORDER BY s.sequence_key LIMIT 200")]
                if "case_sequences" in tables else [],
            "case_statuses": dict(db.execute("SELECT status,count(*) FROM cases GROUP BY status")),
            "sound_pack_statuses": dict(db.execute("SELECT status,count(*) FROM sound_packs GROUP BY status")) if "sound_packs" in tables else {},
            "work_splits": dict(db.execute("SELECT split,count(*) FROM works GROUP BY split")),
            "condition_vocabulary": [{"field": row[0], "value": json.loads(row[1])} for row in db.execute(
                "SELECT DISTINCT x.key,x.value FROM conditions x JOIN cases c USING(case_id) "
                "JOIN episodes e USING(episode_id) JOIN works w USING(work_id) WHERE " + eligible + " "
                "ORDER BY x.key,x.value LIMIT 200")],
            "store_sha256": digest_file(filename), "artistic_approval": False}


def window_candidate(pack, window, case, cue, library, hash_cache):
    candidate = {"cue_id": cue["cue_id"], "case_id": case["case_id"], "pack_id": pack["pack_id"],
                 "window_id": window["window_id"], "segment_id": window["segment_id"], "asset_id": pack["asset_id"],
                 "source_sha256": pack["source_sha256"], "source_range": window["source_range"],
                 "case_source_range": window["source_range"], "library_allowed_source_range": None,
                 "words_evidence": window.get("words_evidence"), "phase": window.get("phase", "unknown"),
                 "source_relation": window.get("source_relation"),
                 "human_review_record": window.get("human_review_record"),
                 "original_recording_evidence": window.get("original_recording_evidence")}
    if window.get('source_relation') == 'reviewed_same_recording_window':
        candidate.update(reference_use_source_range=window.get('reference_use_source_range'),
                         ready_source_range=window.get('ready_source_range'),
                         recording_identity_source=window.get('recording_identity_source'))
    gaps, valid = [], False
    if library is None:
        gaps.append("music_library_not_bound")
    else:
        row = library.execute("SELECT s.asset_id,s.source_sha256,s.start_s,s.end_s,a.source_sha256 AS asset_hash,a.path,a.duration,a.blocked "
                              "FROM segments s JOIN assets a USING(asset_id) WHERE s.segment_id=?", (window["segment_id"],)).fetchone()
        if not row:
            gaps.append("library_segment_missing")
        else:
            candidate["library_allowed_source_range"] = [row["start_s"], row["end_s"]]
            if (row["asset_id"] != pack["asset_id"] or row["source_sha256"] != pack["source_sha256"]
                    or row["asset_hash"] != pack["source_sha256"]):
                gaps.append("stale_source_identity")
            elif not row["start_s"] <= window["source_range"][0] < window["source_range"][1] <= min(row["end_s"], row["duration"]):
                gaps.append("pack_window_outside_library_segment")
            elif row["blocked"]:
                gaps.append("library_asset_rejected")
            else:
                try:
                    source = file_binding({"path": row["path"], "sha256": pack["source_sha256"]}, Path("."), hash_cache)
                    candidate["local_path"] = source["path"]
                    valid = True
                except (ValueError, OSError):
                    gaps.append("source_file_missing_or_hash_changed")
    words = window.get("words_evidence") or {}
    verified_words = (words.get("content_status") == "verified" and words.get("source_sha256") == pack["source_sha256"]
                      and words.get("source_range") == window["source_range"] and words.get("vocal_presence") == "sung"
                      and isinstance(words.get("actual_words"), str) and bool(words["actual_words"].strip())
                      and words.get("vocal_language") not in (None, "", "unknown")
                      and words.get("complete_phrase") is True and words.get("actual_audio_processed") is True
                      and bool(words.get("reviewer")) and bool(words.get("evidence_files")))
    if verified_words:
        try:
            for binding in words["evidence_files"]:
                file_binding(binding, Path("."), hash_cache)
        except (ValueError, OSError):
            verified_words = False
    if cue.get("music_role") == "words_candidate":
        if not verified_words:
            gaps.append("actual_complete_words_window_unverified")
        elif cue.get("vocal_language", "unknown") not in ("unknown", words["vocal_language"]):
            gaps.append("words_language_mismatch")
    pack_listening_checked = False
    if pack["status"] in ("observed", "approved"):
        try:
            bound_audio_evidence(window.get("listening_evidence", {}), pack["source_sha256"], window["source_range"], Path("."), hash_cache)
            pack_listening_checked = True
        except (ValueError, OSError):
            gaps.append("pack_listening_evidence_missing_or_hash_changed")
    if (window.get('source_relation') == 'reviewed_same_recording_window'
            and 'contaminated' in (pack.get('clean_content_status'), window.get('clean_content_status'))):
        gaps.append('music_source_content_contaminated')
    eligible = (valid and "words_language_mismatch" not in gaps
                and 'music_source_content_contaminated' not in gaps
                and (pack["status"] == "research" or pack_listening_checked))
    candidate["applicability"] = {"source_integrity_verified": valid,
        "historical_words_verified": bool(verified_words), "case_status": case["status"],
        "pack_status": pack["status"], "current_review_required": True,
        "pack_listening_record_checked": pack_listening_checked,
        "eligible_for_current_review": eligible, "formal_adoption_allowed": False,
        "status": "candidate_pending_current_review" if eligible else "blocked_source_or_evidence"}
    candidate["unresolved_gaps"] = gaps
    return candidate


def case_query_sql(known, exclusions, style_text, limit, sequence=None, identity_isolation=False,
                   sequence_match="exact", optional_steps=(), defer_limit=False):
    """Use condition postings for identity lookup; apply weak style before LIMIT."""
    params, style_join, style_order = [], "", ""
    style_tokens = terms(style_text)[:20]
    if style_tokens:
        style_join = " LEFT JOIN (SELECT case_id FROM case_text WHERE case_text MATCH ?) style ON style.case_id=c.case_id"
        params.append(" OR ".join('"' + token + '"' for token in style_tokens))
        style_order = ",style.case_id IS NOT NULL DESC"
    postings = []
    compatible = bool(sequence) and sequence_match == "ordered_compatible"
    if compatible:
        for function in dict.fromkeys(step["narrative_function"] for step in sequence if step["step_id"] not in optional_steps):
            postings.append("SELECT case_id FROM sequence_steps INDEXED BY sequence_step_lookup WHERE narrative_function=?")
            params.append(function)
    elif sequence:
        postings.append("SELECT case_id FROM case_sequences INDEXED BY sequence_lookup WHERE sequence_key=?")
        params.append(dump([step["narrative_function"] for step in sequence]))
    else:
        for key, value in known.items():
            postings.append("SELECT case_id FROM conditions INDEXED BY condition_lookup WHERE key=? AND value=?")
            params.extend([key, dump(value)])
    where = ["c.case_id IN (" + " INTERSECT ".join(postings) + ")", heldout_clause(identity_isolation)]

    def exclude_conflict(table, key, value, position=None, phase=None):
        if key == "perspective":
            return  # Different viewpoint prose needs semantic review, not string equality.
        suffix, extra = "x.value!=?", [dump(value)]
        if key == "relationship":
            relationship_class = RELATIONSHIP_CLASSES.get(value)
            if relationship_class is None:
                return
            conflicting = [dump(label) for label, category in RELATIONSHIP_CLASSES.items() if category != relationship_class]
            suffix, extra = "x.value IN (" + ",".join("?" for _ in conflicting) + ")", conflicting
        coordinates = "" if position is None else " AND x.position=? AND x.phase=?"
        where.append(f"NOT EXISTS(SELECT 1 FROM {table} x WHERE x.case_id=c.case_id" + coordinates + " AND x.key=? AND " + suffix + ")")
        params.extend(([] if position is None else [position, phase]) + [key] + extra)

    if sequence:
        for key, value in known.items():
            if key in STORY_KEYS:
                exclude_conflict("conditions", key, value)
        relationship_labels = [step[phase]["relationship"] for step in sequence for phase in ("before", "after") if "relationship" in step[phase]]
        if "relationship" in known:
            relationship_labels.append(known["relationship"])
        relationship_labels = [label for label in relationship_labels if label in RELATIONSHIP_CLASSES]
        if len({RELATIONSHIP_CLASSES[label] for label in relationship_labels}) == 1:
            for table in ("conditions", "sequence_conditions"):
                exclude_conflict(table, "relationship", relationship_labels[0])
        if compatible:
            for key in ("threat_resolved",):
                values = {step[phase][key] for step in sequence for phase in ("before", "after") if key in step[phase]}
                if key in known:
                    values.add(known[key])
                if len(values) == 1:
                    exclude_conflict("sequence_conditions", key, next(iter(values)))
        for position, step in enumerate(sequence if not compatible else []):
            for phase in ("before", "after"):
                for key, value in step[phase].items():
                    if key in STORY_KEYS:
                        exclude_conflict("sequence_conditions", key, value, position, phase)
    if not isinstance(exclusions, list):
        raise ValueError("exclude_case_conditions_must_be_object_array")
    for exclusion in exclusions:
        forbidden = known_conditions(exclusion)
        if not forbidden:
            raise ValueError("empty_or_unknown_exclusion")
        clauses = []
        for key, value in forbidden.items():
            clauses.append("EXISTS(SELECT 1 FROM conditions x WHERE x.case_id=c.case_id AND x.key=? AND x.value=?)")
            params.extend([key, dump(value)])
        where.append("NOT(" + " AND ".join(clauses) + ")")
    sql = ("SELECT c.* FROM cases c JOIN episodes e USING(episode_id) JOIN works w USING(work_id)" + style_join
           + " WHERE " + " AND ".join(where)
           + " ORDER BY c.status='approved' DESC,c.status='observed' DESC" + style_order + ",c.case_id")
    # Compatible cases must pass ordered alignment before the case limit is applied.
    return (sql, params) if compatible or defer_limit else (sql + " LIMIT ?", [*params, limit])


def compatible_step_pairs(requested, reference, optional_steps):
    def agrees(current, prior):
        return current["narrative_function"] == prior["narrative_function"] and not any(
            key in prior[phase] and prior[phase][key] != value and
            (key != "relationship" or (RELATIONSHIP_CLASSES.get(value) is not None and
             RELATIONSHIP_CLASSES.get(prior[phase][key]) is not None and
             RELATIONSHIP_CLASSES[value] != RELATIONSHIP_CLASSES[prior[phase][key]]))
            for phase in ("before", "after") for key, value in current[phase].items() if key in HARD_STORY_KEYS)

    def rank(pairs):
        facts = sum(prior[phase].get(key) == value for i, j in pairs
                    for current, prior in [(requested[i], reference[j])]
                    for phase in ("before", "after") for key, value in current[phase].items())
        return len(pairs), facts, tuple((-i, -j) for i, j in pairs)

    @lru_cache(None)
    def align(i, j):
        if i == len(requested):
            return ()
        if j == len(reference):
            return () if all(step["step_id"] in optional_steps for step in requested[i:]) else None
        options = [align(i, j + 1)]
        if requested[i]["step_id"] in optional_steps:
            options.append(align(i + 1, j))
        if agrees(requested[i], reference[j]):
            tail = align(i + 1, j + 1)
            if tail is not None:
                options.append(((i, j), *tail))
        valid = [option for option in options if option is not None]
        return max(valid, key=rank) if valid else None

    return align(0, 0)


def perspective_context(current, reference):
    return {"target": current.get("perspective"), "reference": reference.get("perspective"),
            "assessment": "not_performed"}


def structure_match(requested, reference, known, case_conditions, sequence_match="exact", optional_steps=()):
    pairs = compatible_step_pairs(requested, reference, optional_steps) if sequence_match == "ordered_compatible" else tuple(zip(range(len(requested)), range(len(reference))))
    if pairs is None:
        return None
    steps = []
    for i, j in pairs:
        current, prior = requested[i], reference[j]
        matched, unknown, differences = {}, {}, {}
        for phase in ("before", "after"):
            matched[phase] = {key: value for key, value in current[phase].items() if prior[phase].get(key) == value}
            unknown[phase] = [key for key in current[phase] if key not in prior[phase]]
            differences[phase] = [key for key, value in current[phase].items() if key in prior[phase] and prior[phase][key] != value]
        steps.append({"target_story_step_id": current["step_id"], "reference_story_step_id": prior["step_id"],
                      "narrative_function": current["narrative_function"], "matched_conditions": matched,
                      "perspective_context": {phase: perspective_context(current[phase], prior[phase]) for phase in ("before", "after")},
                      "unknown_reference_conditions": unknown, "noncritical_differences": differences})
        if sequence_match == "ordered_compatible":
            steps[-1].update(target_position=i, reference_position=j)
    result = {"mode": "ordered_structure" if requested else "exact_conditions", "steps": steps,
            "perspective_context": perspective_context(known, case_conditions),
            "matched_conditions": {key: value for key, value in known.items() if case_conditions.get(key) == value},
            "unknown_reference_conditions": [key for key in known if key not in case_conditions],
            "critical_conflicts_excluded": True, "semantic_assessment": "not_performed"}
    if sequence_match == "ordered_compatible":
        result.update(mode=sequence_match,
            skipped_target_steps=[{"target_story_step_id": step["step_id"], "narrative_function": step["narrative_function"],
                "target_position": i, "reason": "explicitly_optional", "conditions": {phase: step[phase] for phase in ("before", "after")}}
                for i, step in enumerate(requested) if i not in {pair[0] for pair in pairs}],
            skipped_reference_steps=[{"reference_story_step_id": step["step_id"], "narrative_function": step["narrative_function"],
                "reference_position": j, "reason": "extra_reference_event", "conditions": {phase: step[phase] for phase in ("before", "after")}}
                for j, step in enumerate(reference) if j not in {pair[1] for pair in pairs}],
            required_target_story_step_ids=[step["step_id"] for step in requested if step["step_id"] not in optional_steps])
    return result


def bound_theme(db, bundle_id, hash_cache):
    bundle = json.loads(db.execute("SELECT record_json FROM theme_bundles WHERE theme_bundle_id=?", (bundle_id,)).fetchone()[0])
    relations = []
    for relation in bundle.get("variant_relations", []):
        checked, gaps = False, []
        if relation["status"] in ("observed", "approved"):
            try:
                hashes = [db.execute("SELECT source_sha256 FROM packs WHERE pack_id=?", (relation[key],)).fetchone()[0]
                          for key in ("from_pack_id", "to_pack_id")]
                variant_evidence(relation["evidence"], hashes, Path("."), hash_cache)
                checked = True
            except (ValueError, OSError):
                gaps.append("variant_evidence_missing_or_hash_changed")
        relations.append({**relation, "historical_variant_verified": checked, "unresolved_gaps": gaps,
                          "current_review_required": True, "formal_adoption_allowed": False})
    return {**bundle, "variant_relations": relations, "formal_adoption_allowed": False}


def sound_candidates(db, case, cue, library, hash_cache, usage_scope):
    candidates = []
    columns = {row[1] for row in library.execute("PRAGMA table_info(assets)")} if library else set()
    for pack_id in case.get("sound_pack_ids", []):
        pack = json.loads(db.execute("SELECT record_json FROM sound_packs WHERE sound_pack_id=?", (pack_id,)).fetchone()[0])
        for member in pack["members"]:
            pointer = {"pack_id": pack_id, "status": pack["status"], "asset_id": member["asset_id"],
                       "source_sha256": member["source_sha256"]}
            candidate = window_candidate(pointer, {**member, "window_id": member["member_id"]}, case,
                                         {"cue_id": cue["cue_id"]}, library, hash_cache)
            candidate.update(sound_pack_id=pack_id, member_id=member["member_id"], sound_role=member["sound_role"],
                             source_anchor_seconds=member.get("source_anchor_seconds"))
            if library and candidate["applicability"]["source_integrity_verified"]:
                candidate["local_path"] = library.execute("SELECT path FROM assets WHERE asset_id=?", (member["asset_id"],)).fetchone()[0]
            scope_allowed = usage_scope == "research_noncommercial"
            if library and "commercial_allowed" in columns:
                asset = library.execute("SELECT commercial_allowed FROM assets WHERE asset_id=?", (member["asset_id"],)).fetchone()
                scope_allowed = scope_allowed or bool(asset and asset[0])
            candidate["applicability"]["usage_scope_eligible"] = scope_allowed
            if not scope_allowed:
                candidate["unresolved_gaps"].append("sound_usage_scope_not_eligible")
            clean = False
            if member.get("clean_content_status") == "verified":
                try:
                    evidence = member.get("cleanliness_evidence", {})
                    bound_audio_evidence(evidence, member["source_sha256"], member["source_range"], Path("."), hash_cache)
                    clean = evidence.get("unwanted_speech_absent") is True and evidence.get("unwanted_music_absent") is True
                except (ValueError, OSError):
                    pass
            candidate["applicability"]["historical_clean_content_verified"] = clean
            if not clean:
                candidate["unresolved_gaps"].append("sound_clean_content_unverified")
            if member.get("clean_content_status") == "contaminated" or not scope_allowed:
                candidate["applicability"]["eligible_for_current_review"] = False
                candidate["applicability"]["status"] = "blocked_source_or_evidence"
            candidates.append(candidate)
    return candidates


def source_format_lookup(binding, db, hash_cache):
    """Join a bound sidecar to readonly episode identity; never change the case DB."""
    def read_bound(value):
        checked = file_binding(value, Path("."), hash_cache)
        return json.loads(Path(checked["path"]).read_text(encoding="utf-8-sig"))

    document = read_bound(binding)
    source = read_bound(document.get("source_manifest", {}))
    if document.get("schema_version") != 1 or not isinstance(document.get("entries"), list) or not isinstance(source.get("entries"), list):
        raise ValueError("source_format_manifest_required")

    def indexed(rows):
        result = {}
        for row in rows:
            if not row.get("episode_id") or row["episode_id"] in result:
                raise ValueError("source_format_duplicate_episode")
            result[row["episode_id"]] = row
        return result

    formats, sources, cache = indexed(document["entries"]), indexed(source["entries"]), {}

    def lookup(episode_id):
        if episode_id in cache:
            return cache[episode_id]
        row, original = formats.get(episode_id), sources.get(episode_id)
        episode = db.execute("SELECT work_id,source_sha256,record_json FROM episodes WHERE episode_id=?", (episode_id,)).fetchone()
        if not row or not original or not episode:
            raise ValueError("source_format_episode_missing")
        if (any(row.get(key) != original.get(key) for key in ("episode_id", "work_id", "source_version", "split", "episode_number", "platform", "platform_series_id"))
                or row.get("work_id") != episode["work_id"] or row.get("source_video_sha256") != episode["source_sha256"]
                or original.get("sha256") != episode["source_sha256"]):
            raise ValueError("source_format_episode_source_mismatch")
        media = json.loads(episode["record_json"]).get("source_video", {})
        if media.get("sha256") != episode["source_sha256"] or not media.get("path"):
            raise ValueError("source_format_episode_source_mismatch")
        media = {**media, "path": str(Path(media["path"]).resolve())}
        receipt = read_bound(row.get("probe_receipt", {}))
        source_proof, probe = receipt.get("source", {}), receipt.get("probe", {})
        size = Path(media["path"]).stat().st_size
        if (any(not value or Path(value).resolve() != Path(media["path"]) for value in
                (original.get("video"), row.get("source_video_path"), source_proof.get("path")))
                or receipt.get("schema_version") != 1 or receipt.get("episode_id") != episode_id
                or receipt.get("exit_code") != 0 or receipt.get("error") or row.get("source_hash_verified") is not True
                or source_proof.get("sha256_verified") is not True or source_proof.get("sha256") != episode["source_sha256"]
                or source_proof.get("size_bytes") != size or str(probe.get("format", {}).get("size")) != str(size)
                or not receipt.get("ffprobe", {}).get("version") or not receipt.get("ffprobe", {}).get("path")
                or not isinstance(probe.get("streams"), list)):
            raise ValueError("source_format_probe_receipt_mismatch")
        stream = next((item for item in probe["streams"] if item.get("codec_type") == "video"), None)
        display, rotation = None, None
        if stream:
            def ratio(value):
                parts = re.split(r"[:/]", str(value))
                try:
                    return float(parts[0]) / float(parts[1]) if len(parts) == 2 and float(parts[0]) > 0 and float(parts[1]) > 0 else None
                except (ValueError, ZeroDivisionError):
                    return None
            width, height = stream.get("width"), stream.get("height")
            sar = ratio(stream.get("sample_aspect_ratio"))
            display = width * sar / height if width and height and sar else ratio(stream.get("display_aspect_ratio"))
            raw_rotation = next((item["rotation"] for item in stream.get("side_data_list", []) if "rotation" in item), stream.get("tags", {}).get("rotate", 0))
            try:
                rotation = float(raw_rotation)
            except (ValueError, TypeError):
                rotation = None
            if rotation is None or not math.isfinite(rotation) or abs(rotation / 90 - round(rotation / 90)) >= .00001:
                display = None
            elif abs(round(rotation / 90)) % 2 and display:
                display = 1 / display
            if (row.get("raw_width") != width or row.get("raw_height") != height
                    or row.get("sample_aspect_ratio") != stream.get("sample_aspect_ratio")
                    or row.get("raw_display_aspect_ratio") != stream.get("display_aspect_ratio")):
                raise ValueError("source_format_metadata_mismatch")
        orientation = "unknown" if display is None or not math.isfinite(display) or display <= 0 else "square" if abs(display - 1) <= .01 else "vertical" if display < 1 else "horizontal"
        if row.get("orientation") != orientation or row.get("rotation_degrees") != rotation or row.get("display_aspect_ratio") != display:
            raise ValueError("source_format_metadata_mismatch")
        cache[episode_id] = {"episode_id": episode_id, "source_video_sha256": episode["source_sha256"],
            "orientation": orientation, "probe_receipt": row["probe_receipt"],
            "reference_role": "primary_vertical_reference" if orientation == "vertical" else "auxiliary_horizontal_reference" if orientation == "horizontal" else "format_unknown_or_square_reference",
            "content_orientation": "unknown", "content_orientation_basis": "not_inferred_from_container",
            "source_hash_verified_for_current_query": False, "formal_adoption_allowed": False}
        return cache[episode_id]

    return lookup


def query_store(filename, request, library_db=None):
    if request.get("schema_version") not in (1, 2):
        raise ValueError("schema_version_1_or_2_required")
    sha(request.get("source_video_sha256"))
    if request.get("usage_scope") not in ("production_commercial", "research_noncommercial"):
        raise ValueError("invalid_usage_scope")
    prefer_vertical = request.get("prefer_vertical", False)
    if not isinstance(prefer_vertical, bool):
        raise ValueError("prefer_vertical_boolean_required")
    if prefer_vertical and not request.get("source_format_manifest"):
        raise ValueError("source_format_binding_required")
    limit = request.get("limit", 5)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError("limit_must_be_1_to_50")
    sequence_match = request.get("sequence_match", "exact")
    if sequence_match not in ("exact", "ordered_compatible"):
        raise ValueError("invalid_sequence_match")
    if sequence_match == "ordered_compatible" and request["schema_version"] != 2:
        raise ValueError("ordered_compatible_requires_schema_v2")
    # Nullable API fields do not create phantom words tasks.
    cues = [{key: value for key, value in cue.items() if value is not None} for cue in request.get("cues", [])]
    cues = expand_music_cues({"cues": cues})
    if not cues:
        raise ValueError("at_least_one_cue_required")
    store_hash = digest_file(filename)
    library_hash = digest_file(library_db) if library_db else None
    if request.get("library_sha256") is not None and request["library_sha256"] != library_hash:
        raise ValueError("case_library_identity_mismatch")
    library_input = ({"path": str(Path(library_db).resolve()), "sha256": library_hash}
                     if library_db and Path(library_db).suffix.lower() == ".json" else library_db)
    routes, coverage, all_gaps, hash_cache = [], [], [], {}
    library = readonly_registered_library(library_input) if library_db else None
    try:
        with closing(readonly(filename)) as db:
            formats = source_format_lookup(request["source_format_manifest"], db, hash_cache) if request.get("source_format_manifest") else None
            store_version = db.execute("PRAGMA user_version").fetchone()[0]
            identities_available = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_identities'").fetchone() is not None
            sequence_index_available = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sequence_steps'").fetchone() is not None
            for cue in cues:
                cue_id, gaps = cue["cue_id"], []
                requested = dict(cue.get("case_conditions", {}))
                known = known_conditions(requested)
                function = text(cue.get("function"), "cue_function")
                if known.get("narrative_function", function) != function:
                    raise ValueError("conflicting_case_and_cue_function")
                known["narrative_function"] = function
                sequence = story_sequence(cue.get("story_sequence", []))
                optional_steps = id_list(cue.get("optional_story_step_ids", []), "optional_story_step_ids")
                if optional_steps and sequence_match != "ordered_compatible":
                    raise ValueError("optional_story_steps_require_compatible_mode")
                if set(optional_steps) - {step["step_id"] for step in sequence}:
                    raise ValueError("optional_story_step_not_in_sequence")
                required_steps = [step for step in sequence if step["step_id"] not in optional_steps]
                if sequence and not required_steps:
                    raise ValueError("at_least_one_required_story_step")
                if set(requested) - set(known):
                    gaps.append("unknown_requested_case_conditions")
                rows = []
                sequence_has_conditions = any(set(step[phase]) & HARD_STORY_KEYS for step in sequence for phase in ("before", "after"))
                if sequence and store_version < 2:
                    gaps.append("ordered_structure_requires_store_v2")
                elif sequence_match == "ordered_compatible" and not sequence:
                    gaps.append("compatible_story_sequence_required")
                elif sequence_match == "ordered_compatible" and not sequence_index_available:
                    gaps.append("compatible_sequence_index_requires_init")
                elif not (set(known) & (HARD_STORY_KEYS if sequence else STORY_KEYS)) and len(required_steps) < 2 and not sequence_has_conditions:
                    gaps.append("explicit_story_conditions_required")
                else:
                    sql, params = case_query_sql(known, cue.get("exclude_case_conditions", []), cue.get("style_text", ""), limit,
                                                 sequence, identities_available, sequence_match, optional_steps, defer_limit=prefer_vertical)
                    for row in db.execute(sql, params):
                        case = json.loads(row["record_json"])
                        match = structure_match(sequence, case.get("story_sequence", []), known,
                                                case.get("conditions", {}), sequence_match, optional_steps)
                        if match is not None:
                            rows.append((case, match))
                        if len(rows) == limit and not prefer_vertical:
                            break
                    if prefer_vertical:
                        # SQL hard exclusions and ordered story alignment have already passed.
                        rows.sort(key=lambda item: {"vertical": 0, "horizontal": 1}.get(formats(item[0]["episode_id"])["orientation"], 2))
                        rows = rows[:limit]
                if not rows:
                    gaps.append("no_eligible_case")
                    if sequence_match == "ordered_compatible":
                        gaps.append("no_ordered_compatible_case")
                count, valid_count, eligible_count, words_count = 0, 0, 0, 0
                for case, match in rows:
                    episode_record = json.loads(db.execute("SELECT record_json FROM episodes WHERE episode_id=?", (case["episode_id"],)).fetchone()[0])
                    source_format = formats(case["episode_id"]) if formats else None
                    if source_format:
                        # Only selected cases read the complete source; sorting uses bound metadata and stat.
                        episode_record = json.loads(db.execute("SELECT record_json FROM episodes WHERE episode_id=?", (case["episode_id"],)).fetchone()[0])
                        media = file_binding(episode_record["source_video"], Path("."), hash_cache)
                        if media["sha256"] != source_format["source_video_sha256"]:
                            raise ValueError("source_format_episode_source_mismatch")
                        source_format = {**source_format, "source_hash_verified_for_current_query": True}
                    themes = [bound_theme(db, bundle_id, hash_cache) for bundle_id in case.get("theme_bundle_ids", [])]
                    sounds = sound_candidates(db, case, cue, library, hash_cache, request["usage_scope"])
                    pack_ids = list(dict.fromkeys([*case.get("music_pack_ids", []),
                        *(pack_id for bundle in themes for pack_id in bundle["music_pack_ids"])]))
                    action_map = [{**action, "cue_id": cue_id, "story_beat_ids": cue.get("story_beat_ids", []),
                                   "required_action_ids": cue.get("required_action_ids", []),
                                   "target_binding_status": "relative_template_needs_current_anchor"} for action in case.get("sound_actions", [])]
                    for pack_id in pack_ids or [None]:
                        candidates = []
                        route_gaps = []
                        route_gaps.extend(gap for sound in sounds for gap in sound["unresolved_gaps"])
                        route_gaps.extend(gap for theme in themes for relation in theme["variant_relations"] for gap in relation["unresolved_gaps"])
                        if case["status"] != "approved":
                            route_gaps.append("reference_case_not_approved")
                        reference_evidence_checked = False
                        if case["status"] in ("observed", "approved"):
                            try:
                                episode_record = json.loads(db.execute("SELECT record_json FROM episodes WHERE episode_id=?", (case["episode_id"],)).fetchone()[0])
                                file_binding(episode_record["source_video"], Path("."), hash_cache)
                                for evidence_file in case["evidence"]["files"]:
                                    file_binding(evidence_file, Path("."), hash_cache)
                                reference_evidence_checked = True
                            except (ValueError, OSError):
                                route_gaps.append("reference_evidence_file_missing_or_hash_changed")
                        if pack_id is None:
                            route_gaps.append("case_has_no_music_pack")
                        else:
                            pack = json.loads(db.execute("SELECT record_json FROM packs WHERE pack_id=?", (pack_id,)).fetchone()[0])
                            for window_row in db.execute("SELECT record_json FROM windows WHERE pack_id=? ORDER BY start_s,end_s,window_id", (pack_id,)):
                                window = json.loads(window_row[0])
                                candidate = window_candidate(pack, window, case, cue, library, hash_cache)
                                candidates.append(candidate)
                                count += 1
                                valid_count += int(candidate["applicability"]["source_integrity_verified"])
                                eligible_count += int(candidate["applicability"]["eligible_for_current_review"])
                                words_count += int(candidate["applicability"]["historical_words_verified"])
                                route_gaps.extend(candidate["unresolved_gaps"])
                        routes.append({"route_id": f"{cue_id}:{case['case_id']}:{pack_id or 'no-pack'}", "cue_id": cue_id,
                            "case_ids": [case["case_id"]], "music_pack_id": pack_id, "beat_action_map": action_map,
                            **({"source_format": source_format} if source_format else {}),
                            "source_candidates": candidates, "case_evidence": case.get("evidence", {}),
                            "reference_source": episode_record.get("source_video"), "reference_case_range": case["source_range"],
                            "structure_match": match, "development_preset": case.get("development_preset", {"steps": []}),
                            "reference_source_events": case.get("source_events", []),
                            "theme_bundles": themes, "sound_candidates": sounds,
                            "applicability": {"matched_conditions": match["matched_conditions"], "case_status": case["status"],
                                              "reference_evidence_record_checked": reference_evidence_checked,
                                              "current_review_required": True, "formal_adoption_allowed": False},
                            "unresolved_gaps": sorted(set(route_gaps))})
                if rows and not valid_count:
                    gaps.append("no_integrity_verified_source")
                elif rows and not eligible_count:
                    gaps.append("no_eligible_source_for_current_review")
                coverage.append({"cue_id": cue_id, "case_count": len(rows), "source_candidate_count": count,
                                 "integrity_verified_count": valid_count, "eligible_for_current_review_count": eligible_count,
                                 "historical_words_verified_count": words_count,
                                 "gaps": gaps})
                if sequence_match == "ordered_compatible":
                    coverage[-1].update(sequence_match=sequence_match,
                        required_target_story_step_ids=[step["step_id"] for step in required_steps])
                all_gaps.extend({"cue_id": cue_id, "gap": gap} for gap in gaps)
    finally:
        if library is not None:
            library.close()
    if digest_file(filename) != store_hash:
        raise ValueError("case_store_changed_during_query")
    if library_db and digest_file(library_db) != library_hash:
        raise ValueError("case_library_changed_during_query")
    if isinstance(library_input, dict):
        with closing(readonly_registered_library(library_input)):
            pass
    return {"schema_version": request["schema_version"], "store_schema_version": store_version,
            "status": "routes_pending_review" if any(c["eligible_for_current_review_count"] for c in coverage)
            else "cases_without_usable_source" if routes else "no_eligible_case", "source_video_sha256": request["source_video_sha256"],
            "store_sha256": store_hash, "library_sha256": library_hash, "routes": routes,
            **({"source_format_policy": {"source_format_manifest": request["source_format_manifest"],
                 "prefer_vertical": prefer_vertical, "story_hard_exclusions_preserved": True,
                 "priority_evidence": "bound_sidecar_db_identity_probe_and_source_stat",
                 "source_full_hash_scope": "selected_case_sources",
                 "horizontal_role": "auxiliary", "formal_adoption_allowed": False}} if formats else {}),
            "coverage": {"requested_cue_count": len(cues), "matched_cue_count": sum(c["case_count"] > 0 for c in coverage),
                         "items": coverage, "heldout_excluded": True},
            "gaps": all_gaps, "formal_adoption_allowed": False, "artistic_approval": False}


def hydrate_semantic_routes(filename, request, library_db=None):
    """Hydrate verified host mappings from their actual case, never from model pack IDs."""
    source_hash = sha(request.get("source_video_sha256"))
    store_hash = digest_file(filename)
    if request.get("store_sha256") != store_hash:
        raise ValueError("semantic_case_store_identity_mismatch")
    if request.get("usage_scope") not in ("research_noncommercial", "production_commercial"):
        raise ValueError("invalid_usage_scope")
    library_hash = digest_file(library_db) if library_db else None
    if library_hash != request.get("library_sha256"):
        raise ValueError("semantic_library_identity_mismatch")
    cues = {cue["cue_id"]: cue for cue in request["cues"]}
    cache, routes = {}, []
    library_input = ({"path": str(Path(library_db).resolve()), "sha256": library_hash}
                     if library_db and Path(library_db).suffix.lower() == ".json" else library_db)
    library = readonly_registered_library(library_input) if library_db else None
    try:
        with closing(readonly(filename)) as db:
            for base in request["routes"]:
                binding = base["reference_case_binding"]
                if (Path(binding["database"]["path"]).resolve() != Path(filename).resolve()
                        or binding["database"]["sha256"] != store_hash
                        or base["case_ids"] != [binding["case_id"]] or base["cue_id"] not in cues):
                    raise ValueError("semantic_reference_case_binding_mismatch")
                row = db.execute("SELECT c.record_json,e.record_json,w.record_json FROM cases c "
                    "JOIN episodes e USING(episode_id) JOIN works w USING(work_id) WHERE c.case_id=?",
                    (binding["case_id"],)).fetchone()
                if not row or hashlib.sha256(row[0].encode()).hexdigest() != binding["record_sha256"]:
                    raise ValueError("reference_case_changed_or_missing")
                case, episode, work = map(json.loads, row)
                if work.get("split") == "heldout":
                    raise ValueError("heldout_case_cannot_be_consumed")
                if (base["reference_work_id"] != work["work_id"] or base["reference_episode_id"] != episode["episode_id"]
                        or base["reference_source"] != episode["source_video"]
                        or base["reference_case_range"] != case["source_range"]):
                    raise ValueError("semantic_reference_source_or_range_mismatch")
                file_binding(episode["source_video"], Path("."), cache)
                evidence = file_binding(base["structure_match"]["semantic_evidence"], Path("."), cache)
                raw = json.loads(Path(evidence["path"]).read_text(encoding="utf-8-sig"))
                steps = base["structure_match"]["steps"]
                host_record = False
                if raw.get('execution_kind') == 'codex_host_authored_record':
                    request_path = Path(evidence['path']).parent / 'request.json'
                    request_binding = next((item for item in raw.get('evidence_files', []) if Path(item.get('path', '')).resolve() == request_path.resolve()), None)
                    if not request_binding:
                        raise ValueError('paired_semantic_host_request_required')
                    checked_request = file_binding(request_binding, Path('.'), cache)
                    host_request = json.loads(Path(checked_request['path']).read_text(encoding='utf-8-sig'))
                    payload = host_request.get('payload', {})
                    backend = raw.get('backend', {})
                    canonical_payload = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                    host_record = (raw.get('inference_claim') == 'host_record_import_not_api_inference'
                        and backend.get('protocol') == 'codex_host_file' and backend.get('backend_id') == 'codex-host'
                        and backend == host_request.get('backend') == payload.get('backend')
                        and raw.get('model') == raw.get('model_revision') == backend.get('model_revision')
                        and raw.get('backend_id') == backend.get('backend_id')
                        and raw.get('request_sha256') == host_request.get('request_sha256') == hashlib.sha256(canonical_payload.encode()).hexdigest()
                        and payload.get('role') == 'ordered_reference_case_semantic_comparison'
                        and payload.get('source_video_sha256') == source_hash
                        and raw.get('actual_video_processed') is False and raw.get('qualified') is False
                        and raw.get('artistic_approval') is False and raw.get('production_approval') is False
                        and raw.get('scopes') == [] and raw.get('input_bindings') == payload.get('input_bindings')
                        and raw.get('evidence_files') == [request_binding, *payload.get('input_bindings', [])])
                    if not host_record:
                        raise ValueError('semantic_host_request_identity_mismatch')
                    for item in raw['evidence_files']:
                        file_binding(item, Path('.'), cache)
                if (not host_record and raw.get("actual_runtime_executed") is not True or raw.get("actual_input_processed") is not True
                        or raw.get("actual_audio_processed") is not False or raw.get("completion_status") != "complete"
                        or raw.get("source_video_sha256") != source_hash
                        or not any(d.get("case_id") == case["case_id"] and d.get("cue_id") == base["cue_id"]
                            and d.get("verdict") == "applicable" and d.get("steps") == steps
                            for d in raw.get("value", {}).get("decisions", []))):
                    raise ValueError("actual_case_comparison_response_required")
                cue = cues[base["cue_id"]]
                query_binding = file_binding(base["semantic_query_binding"], Path("."), cache)
                actual_query = json.loads(Path(query_binding["path"]).read_text(encoding="utf-8-sig"))
                if (actual_query.get("source_video_sha256") != source_hash or actual_query.get("store_sha256") != store_hash
                        or cue not in actual_query.get("cues", []) or not any(
                            value.get("sha256") == query_binding["sha256"] and value.get("path")
                            and Path(value["path"]).resolve() == Path(query_binding["path"]).resolve()
                            for value in raw.get("evidence_files", []))):
                    raise ValueError("semantic_current_query_binding_mismatch")
                if host_record:
                    data = payload.get('input', {}).get('data', {})
                    pool_binding = file_binding(data.get('recalled_candidates', {}), Path('.'), cache)
                    pool = json.loads(Path(pool_binding['path']).read_text(encoding='utf-8-sig'))
                    exported = next((item for group in pool.get('cues', []) if group.get('cue_id') == cue['cue_id']
                                     for item in group.get('candidates', []) if item.get('case_id') == case['case_id']), None)
                    reference_input = ({'case_id': exported['case_id'], 'work_title': exported['work']['title'],
                        **{key: exported[key] for key in ('reference_case_binding', 'source_video', 'source_range', 'description',
                            'conditions', 'story_sequence', 'development_preset', 'evidence_summary', 'music_pack_ids')},
                        'unresolved_gaps': exported['unresolved_gaps'][:3]} if exported else None)
                    checks = {'query': data.get('current_query') == base['semantic_query_binding'], 'cue': data.get('current_cue') == cue,
                        'store': file_binding(data.get('frozen_case_store', {}), Path('.'), cache) == file_binding(binding['database'], Path('.'), cache),
                        'pool_source': pool.get('source_video_sha256') == source_hash, 'pool_store': pool.get('store_sha256') == store_hash,
                        'reference_request': reference_input in data.get('references', []),
                        'pool_evidence': any(file_binding(item, Path('.'), cache) == pool_binding for item in raw.get('input_bindings', [])),
                        'reference_identity': bool(exported) and exported['reference_case_binding'] == binding,
                        'reference_steps': bool(exported) and exported['story_sequence'] == case['story_sequence'],
                        'reference_conditions': bool(exported) and exported['conditions'] == case['conditions']}
                    if not all(checks.values()):
                        raise ValueError('semantic_host_candidate_pool_mismatch:' + ','.join(key for key, valid in checks.items() if not valid))
                target_steps, reference_steps = cue["story_sequence"], case["story_sequence"]
                last_target, last_reference = -1, -1
                for mapped in steps:
                    ti = next((i for i, s in enumerate(target_steps) if s["step_id"] == mapped["target_story_step_id"]), -1)
                    ri = next((i for i, s in enumerate(reference_steps) if s["step_id"] == mapped["reference_story_step_id"]), -1)
                    if ti <= last_target or ri <= last_reference:
                        raise ValueError("semantic_step_order_or_identity_invalid")
                    if (not mapped["semantic_basis"].strip() or not mapped["current_condition_quote"].strip()
                            or not mapped["reference_condition_quote"].strip()
                            or mapped["current_condition_quote"] not in dump(target_steps[ti])
                            or mapped["reference_condition_quote"] not in dump(reference_steps[ri])):
                        raise ValueError("semantic_condition_quote_not_in_actual_record")
                    if (mapped["critical_conflicts"] or mapped["target_relationship"] in ("family", "romance")
                            and mapped["target_relationship"] != mapped["reference_relationship"]
                            or mapped["target_threat"] == "unresolved" and mapped["reference_threat"] == "resolved"):
                        raise ValueError("critical_story_conflict")
                    for step, state in ((target_steps[ti], mapped["target_threat"]), (reference_steps[ri], mapped["reference_threat"])):
                        end = step.get("after", {}).get("threat_resolved")
                        if end is False and state != "unresolved" or end is True and state != "resolved":
                            raise ValueError("semantic_threat_class_contradicts_record")
                    relationship_classes = {'family': 'family', 'mother_daughter': 'family', 'romantic': 'romance',
                        'romance': 'romance', 'hostile': 'hostile', 'institutional': 'institutional', 'other': 'other'}
                    for step, state in ((target_steps[ti], mapped['target_relationship']), (reference_steps[ri], mapped['reference_relationship'])):
                        for phase in ('before', 'after'):
                            actual = relationship_classes.get(step.get(phase, {}).get('relationship'))
                            if actual and actual != state:
                                raise ValueError('semantic_relationship_class_contradicts_record')
                    last_target, last_reference = ti, ri
                if not steps:
                    raise ValueError("actual_ordered_semantic_basis_required")
                # A local semantic match never grants its music windows the whole long arc.
                mapped_positions = [i for i, step in enumerate(target_steps) if any(
                    row['target_story_step_id'] == step['step_id'] for row in steps)]
                groups = []
                for position in mapped_positions:
                    if groups and position == groups[-1][-1] + 1:
                        groups[-1].append(position)
                    else:
                        groups.append([position])
                target_scopes = []
                for group in groups:
                    full = len(group) == len(target_steps)
                    start = cue['target_range'][0] if full else target_steps[group[0]].get('event_anchor', {}).get('target_seconds')
                    end = (cue['target_range'][1] if group[-1] == len(target_steps) - 1 else
                           target_steps[group[-1] + 1].get('event_anchor', {}).get('target_seconds'))
                    if (isinstance(start, (int, float)) and not isinstance(start, bool)
                            and isinstance(end, (int, float)) and not isinstance(end, bool)
                            and cue['target_range'][0] <= start < end <= cue['target_range'][1]):
                        target_scopes.append(([start, end], [target_steps[i]['step_id'] for i in group]))
                themes = [bound_theme(db, key, cache) for key in case.get("theme_bundle_ids", [])]
                sounds = sound_candidates(db, case, cue, library, cache, request["usage_scope"])
                pack_ids = list(dict.fromkeys([*case.get("music_pack_ids", []),
                    *(key for theme in themes for key in theme["music_pack_ids"])]))
                for pack_id in pack_ids or [None]:
                    candidates, gaps = [], list(base.get("unresolved_gaps", []))
                    gaps = [g for g in gaps if g != "case_has_no_music_pack"]
                    if pack_id is None:
                        gaps.append("case_has_no_music_pack")
                    else:
                        pack = json.loads(db.execute("SELECT record_json FROM packs WHERE pack_id=?", (pack_id,)).fetchone()[0])
                        for window_row in db.execute("SELECT record_json FROM windows WHERE pack_id=? ORDER BY start_s,end_s,window_id", (pack_id,)):
                            window = json.loads(window_row[0])
                            candidate = window_candidate(pack, window, case, cue, library, cache)
                            if "contaminated" in (pack.get("clean_content_status"), window.get("clean_content_status")):
                                candidate["unresolved_gaps"].append("music_source_content_contaminated")
                                candidate["applicability"].update(eligible_for_current_review=False, status="blocked")
                            if candidate.get("source_relation") not in ("reviewed_reference_match", "reviewed_same_recording_window"):
                                candidate["unresolved_gaps"].append("reference_original_recording_unresolved")
                            if target_scopes:
                                candidates.extend({**candidate, 'allowed_target_range': interval,
                                    'mapped_target_story_step_ids': ids} for interval, ids in target_scopes)
                            else:
                                candidate['unresolved_gaps'].append('semantic_candidate_target_boundary_pending')
                                candidate['applicability'] = {**candidate['applicability'], 'eligible_for_current_review': False}
                                candidates.append(candidate)
                        if not candidates:
                            gaps.append("bound_music_pack_has_no_source_windows")
                    gaps.extend(g for c in [*candidates, *sounds] for g in c["unresolved_gaps"])
                    gaps.extend(g for t in themes for r in t["variant_relations"] for g in r["unresolved_gaps"])
                    routes.append({**base, "route_id": f"{cue['cue_id']}:{case['case_id']}:{pack_id or 'no-pack'}:semantic",
                        "music_pack_id": pack_id, "source_candidates": candidates, "sound_candidates": sounds,
                        "theme_bundles": themes, "reference_case_range": case["source_range"],
                        "unresolved_gaps": sorted(set(gaps)), "material_binding_checked": True,
                        "applicability": {**base["applicability"], "current_review_required": True, "formal_adoption_allowed": False}})
    finally:
        if library is not None:
            library.close()
    if digest_file(filename) != store_hash or library_db and digest_file(library_db) != library_hash:
        raise ValueError("semantic_material_store_changed_during_hydration")
    if isinstance(library_input, dict):
        with closing(readonly_registered_library(library_input)):
            pass
    return {"status": "semantic_materials_pending_current_review", "routes": routes, "store_sha256": store_hash,
        "library_sha256": library_hash, "formal_adoption_allowed": False, "artistic_approval": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "import", "query", "report", "hydrate-semantic"):
        command = commands.add_parser(name)
        command.add_argument("--db", required=True, type=Path)
        command.add_argument("--out", "--output", dest="out", type=Path)
        if name in ("import", "query", "hydrate-semantic"):
            command.add_argument("--input", "--request", dest="input", required=True, type=Path)
        if name in ("query", "hydrate-semantic"):
            command.add_argument("--library-db", type=Path)
    args = parser.parse_args()
    if args.command == "init":
        result = init_store(args.db)
    elif args.command == "report":
        result = report_store(args.db)
    else:
        document = json.loads(args.input.read_text(encoding="utf-8-sig"))
        result = (import_store(args.db, document, args.input.parent) if args.command == "import"
            else hydrate_semantic_routes(args.db, document, args.library_db) if args.command == "hydrate-semantic"
            else query_store(args.db, document, args.library_db))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(dump({"status": result["status"], "path": str(args.out.resolve())}))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
