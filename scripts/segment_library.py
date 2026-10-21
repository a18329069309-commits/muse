"""Import real audio pointers into SQLite and retrieve unapproved segment candidates.

import --db library.sqlite --catalog assets.json --segments segments.json [--rehash]
query --db library.sqlite [--text WORDS] [--function FUNCTION] [--phase PHASE]

Catalog accepts {tracks: [...]} or {assets: [...]}; segments accepts {segments: [...]}.
Each segment needs segment_id, asset_id, source_sha256, source_start_seconds,
source_end_seconds. Optional phase is an observed musical phase, not a genre.
No media is copied, model called, or artistic approval inferred. Reverify selected
files before rendering: query reports the last import's integrity snapshot only.
Optional sung discovery recalls unknown windows with fulltrack voice hints; it
never promotes those windows to verified singing, language, or lyric evidence.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import time

from registered_library_connection import readonly_registered_library


# Query vocabulary translates explicit requests, never adds labels to recordings.
# These editorial aliases are not learned audio semantics or a suitability verdict.
FUNCTION_ALIASES = {
    "violent-crisis": ("生死危机", "暴力危机", "正面袭击"),
    "fantasy-battle": ("西幻战斗", "奇幻战斗", "魔法交战"),
    "power-awakening": ("超能力觉醒", "力量觉醒"),
    "action-resolve": ("决意反击", "战斗决心"),
    "action-under-dialogue": ("对白下的战斗", "战斗对白铺底"),
    "pursuit": ("追逐追击", "逃亡追逐"),
    "victim-empathy": ("儿童创伤", "受害者共情", "心疼孩子"),
    "vulnerable-acceptance": ("担心不被喜欢", "担心不被接纳", "请求接纳"),
    "tender-reassurance": ("温柔安慰", "亲情安慰"),
    "care-and-closeness": ("照料亲近", "照顾伤口"),
    "regret-memory": ("前世悔恨", "悔恨回忆"),
    "family-coercion": ("家庭胁迫", "亲人逼迫"),
    "financial-threat": ("经济威胁", "财务威胁"),
    "ritual-authority": ("仪式威压", "神明威压"),
    "supernatural-approach": ("超自然逼近", "诡异逼近"),
    "waiting-for-danger": ("等待危险", "危险尚未到来"),
    "mourning-vigil": ("哀悼守候", "悲伤守夜"),
    "supernatural-grief": ("异质哀伤", "超自然哀伤"),
    "bittersweet-release": ("悲喜交织的放手", "伤感放手"),
    "grief-with-hope": ("悲伤中有希望", "哀伤与希望"),
}
ALIAS_LOOKUP = {alias.casefold(): key for key, values in FUNCTION_ALIASES.items() for alias in (key, *values)}
AMBIGUOUS_FUNCTIONS = {"紧张", "危机", "高燃", "悲伤", "爽感", "tension", "sad"}


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS assets (
      asset_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, family_id TEXT,
      path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
      duration REAL NOT NULL, sample_rate INTEGER NOT NULL, channels INTEGER NOT NULL,
      commercial_allowed INTEGER NOT NULL, blocked INTEGER NOT NULL,
      checked_at REAL NOT NULL, record_json TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS segments (
      segment_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id),
      source_sha256 TEXT NOT NULL, start_s REAL NOT NULL, end_s REAL NOT NULL,
      phase TEXT NOT NULL, listening_status TEXT NOT NULL, record_json TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS functions (
      segment_id TEXT NOT NULL REFERENCES segments(segment_id), function TEXT NOT NULL,
      PRIMARY KEY(segment_id, function))""",
    "CREATE INDEX IF NOT EXISTS functions_lookup ON functions(function, segment_id)",
    "CREATE INDEX IF NOT EXISTS segments_asset ON segments(asset_id)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS segment_text USING fts5(segment_id UNINDEXED, words)",
]


def read_records(filename, names):
    document = json.loads(Path(filename).read_text(encoding="utf-8-sig"))
    records = document if isinstance(document, list) else next(
        (document[name] for name in names if name in document), None)
    if not isinstance(records, list):
        raise ValueError(f"Expected an array or one of {names}: {filename}")
    return records


def text_value(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonempty string")
    return value.strip()


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_file(path):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "format=duration:stream=sample_rate,channels", "-of", "json", str(path),
    ], capture_output=True, text=True, check=True, timeout=30)
    probe = json.loads(result.stdout)
    audio = probe["streams"][0]
    duration, rate, channels = float(probe["format"]["duration"]), int(audio["sample_rate"]), int(audio["channels"])
    if not math.isfinite(duration) or duration <= 0 or rate <= 0 or channels <= 0:
        raise ValueError(f"Invalid audio: {path}")
    return duration, rate, channels


def commercial_use(record):
    # A conservative catalog gate, not a legal opinion or asset redistribution grant.
    license_name = str(record.get("license") or "").strip()
    evidence = record.get("license_evidence") or record.get("license_url")
    terms = license_name + " " + str(record.get("license_url", ""))
    if not license_name or not evidence or re.search(r"\bNC\b|non.?commercial|非商用|禁止商用", terms, re.I):
        return False
    if record.get("commercial_use_allowed") is False:
        return False
    return record.get("commercial_use_allowed") is True or license_name.upper() in {
        "CC0", "CC0 1.0", "CC BY 3.0", "CC BY 4.0", "CC BY-SA 4.0",
    }


def terms(text):
    # English tokens + Chinese bigrams: lexical recall, not semantic understanding.
    result = re.findall(r"[a-z0-9]+", text.lower())
    for run in re.findall(r"[\u3400-\u9fff]+", text):
        result.extend([run] if len(run) == 1 else [run[i:i + 2] for i in range(len(run) - 1)])
    return list(dict.fromkeys(result))


def search_words(asset, segment):
    fields = [asset.get(key) for key in ("title", "narrative_functions", "substyles", "timbre", "genre_preferences")]
    fields += [segment.get(key) for key in ("description", "purpose", "tags", "narrative_functions", "phase")]
    return " ".join(terms(json.dumps(fields, ensure_ascii=False)))


def import_library(db_path, catalog, segment_file=None, rehash=False):
    assets = read_records(catalog, ("assets", "tracks"))
    segments = read_records(segment_file, ("segments",)) if segment_file else []
    database = Path(db_path).resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    report = {"hashed": 0, "reused_integrity": 0, "skipped_metadata_only": [], "imported_assets": 0, "imported_segments": 0}
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
            raise ValueError("Unsupported database schema")
        for statement in SCHEMA:
            connection.execute(statement)
        connection.execute("PRAGMA user_version=1")
        seen = set()
        for item in assets:
            asset_id = text_value(item.get("asset_id", item.get("track_id")), "asset_id")
            if asset_id in seen:
                raise ValueError(f"Duplicate asset_id: {asset_id}")
            seen.add(asset_id)
            old = connection.execute("SELECT * FROM assets WHERE asset_id=?", (asset_id,)).fetchone()
            if not item.get("local_path"):
                if old:
                    raise ValueError(f"Existing asset lost its path: {asset_id}")
                report["skipped_metadata_only"].append(asset_id)
                continue
            path = (Path(catalog).resolve().parent / item["local_path"]).resolve()
            if not path.is_file():
                raise ValueError(f"Missing audio file: {asset_id}")
            stat = path.stat()
            claimed = item.get("source_sha256")
            if claimed is not None and (not isinstance(claimed, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", claimed)):
                raise ValueError(f"Invalid source_sha256: {asset_id}")
            claimed = claimed.lower() if claimed else None
            if (not rehash and old and old["path"] == str(path) and old["size"] == stat.st_size
                    and old["mtime_ns"] == stat.st_mtime_ns and (not claimed or claimed == old["source_sha256"])):
                digest = old["source_sha256"]
                duration, rate, channels = old["duration"], old["sample_rate"], old["channels"]
                checked_at = old["checked_at"]
                report["reused_integrity"] += 1
            else:
                digest = digest_file(path)
                duration, rate, channels = probe_file(path)
                after = path.stat()
                if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
                    raise ValueError(f"Audio changed during import: {asset_id}")
                checked_at = time.time()
                report["hashed"] += 1
            if claimed and digest != claimed:
                raise ValueError(f"File hash mismatch: {asset_id}")
            if old and old["source_sha256"] != digest:
                raise ValueError(f"Changed audio requires a new asset_id: {asset_id}")
            family = item.get("family_id", item.get("source_family")) or None
            if old and old["family_id"] and family != old["family_id"]:
                raise ValueError(f"Conflicting family_id: {asset_id}")
            record = {**(json.loads(old["record_json"]) if old else {}), **item,
                      "source_sha256": digest, "local_path": str(path), "duration_seconds": duration,
                      "sample_rate_hz": rate, "channels": channels}
            record.setdefault("listening_status", "pending")
            connection.execute("""INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(asset_id) DO UPDATE SET family_id=excluded.family_id,path=excluded.path,
              size=excluded.size,mtime_ns=excluded.mtime_ns,duration=excluded.duration,
              sample_rate=excluded.sample_rate,channels=excluded.channels,
              commercial_allowed=excluded.commercial_allowed,blocked=excluded.blocked,
              checked_at=excluded.checked_at,record_json=excluded.record_json""",
              (asset_id, digest, family, str(path), stat.st_size, stat.st_mtime_ns, duration, rate, channels,
               int(commercial_use(record)), int(bool(record.get("content_rejected"))), checked_at,
               json.dumps(record, ensure_ascii=False)))
            # Metadata changes refresh text without rereading media.
            for row in connection.execute("SELECT segment_id,record_json FROM segments WHERE asset_id=?", (asset_id,)).fetchall():
                connection.execute("UPDATE segment_text SET words=? WHERE segment_id=?",
                                   (search_words(record, json.loads(row["record_json"])), row["segment_id"]))
            report["imported_assets"] += 1
        seen = set()
        for item in segments:
            segment_id = text_value(item.get("segment_id"), "segment_id")
            if segment_id in seen:
                raise ValueError(f"Duplicate segment_id: {segment_id}")
            seen.add(segment_id)
            asset = connection.execute("SELECT * FROM assets WHERE asset_id=?", (text_value(item.get("asset_id"), "asset_id"),)).fetchone()
            if not asset or item.get("source_sha256") != asset["source_sha256"]:
                raise ValueError(f"Segment must bind to an imported audio hash: {segment_id}")
            start, end = item.get("source_start_seconds"), item.get("source_end_seconds")
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= asset["duration"]:
                raise ValueError(f"Invalid or out-of-source range: {segment_id}")
            old = connection.execute("SELECT * FROM segments WHERE segment_id=?", (segment_id,)).fetchone()
            if old and (old["asset_id"], old["source_sha256"], old["start_s"], old["end_s"]) != (item["asset_id"], item["source_sha256"], start, end):
                raise ValueError(f"Changed source pointer requires a new segment_id: {segment_id}")
            record = {**(json.loads(old["record_json"]) if old else {}), **item}
            record.setdefault("listening_status", "pending")
            phase = text_value(record.get("phase") or "unlabelled", "phase")
            listening = text_value(record["listening_status"], "listening_status")
            vocal = record.get("vocal_presence", "unknown")
            if vocal not in ("unknown", "instrumental", "sung", "nonverbal_vocal"):
                raise ValueError(f"Invalid vocal_presence: {segment_id}")
            if vocal != "unknown" and not record.get("vocal_evidence"):
                raise ValueError(f"Known vocal_presence needs source-window evidence: {segment_id}")
            functions = record.get("narrative_functions", [])
            if not isinstance(functions, list) or any(not isinstance(v, str) or not v.strip() for v in functions):
                raise ValueError(f"narrative_functions must be a list of strings: {segment_id}")
            connection.execute("""INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(segment_id) DO UPDATE SET phase=excluded.phase,
              listening_status=excluded.listening_status,record_json=excluded.record_json""",
              (segment_id, item["asset_id"], item["source_sha256"], start, end, phase, listening, json.dumps(record, ensure_ascii=False)))
            connection.execute("DELETE FROM functions WHERE segment_id=?", (segment_id,))
            connection.executemany("INSERT INTO functions VALUES(?,?)", [(segment_id, f) for f in set(functions)])
            connection.execute("DELETE FROM segment_text WHERE segment_id=?", (segment_id,))
            connection.execute("INSERT INTO segment_text VALUES(?,?)", (segment_id, search_words(json.loads(asset["record_json"]), record)))
            report["imported_segments"] += 1
        connection.commit()
        report["stored_assets"] = connection.execute("SELECT count(*) FROM assets").fetchone()[0]
        report["stored_unique_hashes"] = connection.execute("SELECT count(DISTINCT source_sha256) FROM assets").fetchone()[0]
        report["stored_explicit_families"] = connection.execute("SELECT count(DISTINCT family_id) FROM assets").fetchone()[0]
        report["stored_segments"] = connection.execute("SELECT count(*) FROM segments").fetchone()[0]
        report["production_asset_candidates"] = connection.execute("SELECT count(*) FROM assets WHERE commercial_allowed=1 AND blocked=0").fetchone()[0]
        return report
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def query_library(db_path, text="", function=None, phase=None, limit=5, avoid_families=(),
                  expand_functions=False, asset_kind=None, substyle=None, timbre=None,
                  min_duration=None, max_duration=None, min_energy=None,
                  min_dialogue_space=None, vocals=None, exclude_cases=(),
                  usage_scope="production_commercial", discover_unknown_functions=False,
                  candidate_segment_ids=None, discover_unknown_vocals=False, preserve_source_windows=False,
                  candidate_scope=None, excluded_tags=()):
    if usage_scope not in ("production_commercial", "research_noncommercial"):
        raise ValueError("Invalid usage_scope")
    if not isinstance(discover_unknown_functions, bool):
        raise ValueError("discover_unknown_functions must be boolean")
    if not isinstance(discover_unknown_vocals, bool):
        raise ValueError("discover_unknown_vocals must be boolean")
    if not isinstance(preserve_source_windows, bool):
        raise ValueError("preserve_source_windows must be boolean")
    if discover_unknown_vocals and vocals != "sung":
        raise ValueError("Vocal discovery requires vocals=sung")
    if discover_unknown_functions and (not isinstance(function, str) or not function.strip()
            or function.strip().casefold() in AMBIGUOUS_FUNCTIONS
            or re.search(r"不要|避免|不需要|不是|\b(without|not|no)\b", function, re.I)):
        raise ValueError("Function discovery requires a specific story function")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    if candidate_segment_ids is not None and (
            not isinstance(candidate_segment_ids, list) or not 1 <= len(candidate_segment_ids) <= 100
            or any(not isinstance(s, str) or not s.strip() for s in candidate_segment_ids)
            or len(set(candidate_segment_ids)) != len(candidate_segment_ids)):
        raise ValueError("candidate_segment_ids must be 1 to 100 unique nonempty strings")
    if candidate_scope is not None:
        if candidate_segment_ids is not None or not preserve_source_windows:
            raise ValueError("candidate_scope requires source windows and no legacy candidate IDs")
        if (not isinstance(candidate_scope, list) or len(candidate_scope) > 500000
                or any(not isinstance(row, dict) or not isinstance(row.get('segment_id'), str)
                       or not row['segment_id'].strip() or not isinstance(row.get('diversity_key'), str)
                       or not row['diversity_key'].strip()
                       or any(isinstance(row.get(key, 0), bool) or not isinstance(row.get(key, 0), int)
                              or row.get(key, 0) < 0 for key in ('preference', 'usage_count'))
                       for row in candidate_scope)
                or len({row['segment_id'] for row in candidate_scope}) != len(candidate_scope)):
            raise ValueError("candidate_scope requires unique bound segment IDs and nonnegative preference metadata")
    if len(text) > 1000:
        raise ValueError("text must be at most 1000 characters")
    if not isinstance(exclude_cases, (list, tuple)) or any(not isinstance(case, str) or not case.strip() for case in exclude_cases):
        raise ValueError("exclude_cases must be a list or tuple of nonempty case IDs")
    if (not isinstance(excluded_tags, (list, tuple)) or len(excluded_tags) > 30
            or any(not isinstance(tag, str) or not 1 <= len(tag) <= 120 or not re.fullmatch(r"[\w-]+(?: [\w-]+)*", tag)
                   or re.search(r"不要|避免|不需要|不是|不用|\b(without|not|no)\b", tag, re.I) for tag in excluded_tags)
            or len(set(excluded_tags)) != len(excluded_tags)):
        raise ValueError("excluded_tags must be unique exact metadata labels, not negative prose")
    for label, value in (("min_duration", min_duration), ("max_duration", max_duration)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
            raise ValueError(f"{label} must be a finite nonnegative number")
    if min_duration is not None and max_duration is not None and min_duration > max_duration:
        raise ValueError("min_duration cannot exceed max_duration")
    for label, value in (("min_energy", min_energy), ("min_dialogue_space", min_dialogue_space)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5):
            raise ValueError(f"{label} must be an integer from 1 to 5")
    if asset_kind not in (None, "music", "sfx", "ambience") or vocals not in (None, "instrumental", "sung", "nonverbal_vocal", "unknown"):
        raise ValueError("Invalid asset_kind or vocals filter")
    expansion = {"enabled": bool(expand_functions), "dictionary_version": 1, "method": "explicit_function_alias_not_audio_semantics", "original_text": text, "original_function": function}
    unresolved = None
    if expand_functions:
        function = ALIAS_LOOKUP.get(function.casefold(), function) if function else None
        resolved = ALIAS_LOOKUP.get(text.strip().casefold())
        if resolved:
            if function and function != resolved:
                unresolved = "conflicting_explicit_function_requests"
            else:
                function, text = resolved, ""
        elif text.strip().casefold() in AMBIGUOUS_FUNCTIONS and not function:
            unresolved = "ambiguous_function_query_needs_specific_story_task"
    if re.search(r"不要|避免|不需要|不是|\b(without|not|no)\b", expansion["original_text"], re.I):
        unresolved = "negated_text_query_needs_positive_structured_filters"
    expansion["resolved_function"] = function
    started = time.perf_counter()
    connection = readonly_registered_library(db_path)
    connection.row_factory = sqlite3.Row
    try:
        where = ["a.blocked=0", "s.listening_status NOT IN ('rejected','failed')"]
        if usage_scope == "production_commercial":
            where.append("a.commercial_allowed=1")
        if unresolved:
            where.append("0")
        parameters = []
        query_terms = terms(text)
        if text.strip() and not query_terms:
            raise ValueError("text contains no searchable terms")
        if query_terms:
            source = "SELECT segment_id,bm25(segment_text) score FROM segment_text WHERE segment_text MATCH ?"
            parameters.append(" OR ".join('"' + term + '"' for term in query_terms))
        else:
            source = "SELECT segment_id,0.0 score FROM segments"
        if function:
            matching = "EXISTS(SELECT 1 FROM functions f WHERE f.segment_id=s.segment_id AND f.function=?)"
            if discover_unknown_functions:
                matching = f"({matching} OR NOT EXISTS(SELECT 1 FROM functions f WHERE f.segment_id=s.segment_id))"
            where.append(matching)
            parameters.append(function)
        if candidate_segment_ids is not None:
            where.append("s.segment_id IN (" + ",".join("?" for _ in candidate_segment_ids) + ")")
            parameters.extend(candidate_segment_ids)
        if phase:
            where.append("s.phase=?")
            parameters.append(phase)
        if asset_kind:
            where.append("json_extract(a.record_json,'$.asset_kind')=?")
            parameters.append(asset_kind)
        if excluded_tags:
            labels = [tag.casefold() for tag in excluded_tags]
            placeholders = ','.join('?' for _ in labels)
            where.append(f"NOT EXISTS(SELECT 1 FROM functions blocked WHERE blocked.segment_id=s.segment_id AND lower(blocked.function) IN ({placeholders}))")
            parameters.extend(labels)
            for document in ('a.record_json', 's.record_json'):
                for field in ('tags', 'narrative_functions', 'substyles', 'timbre'):
                    where.append(f"NOT EXISTS(SELECT 1 FROM json_each({document},'$.{field}') blocked WHERE lower(blocked.value) IN ({placeholders}))")
                    parameters.extend(labels)
        for field, value in (("substyles", substyle), ("timbre", timbre)):
            if value:
                where.append(f"EXISTS(SELECT 1 FROM json_each(a.record_json,'$.{field}') j WHERE j.value=?)")
                parameters.append(value)
        for operator, value in ((">=", min_duration), ("<=", max_duration)):
            if value is not None:
                where.append(f"s.end_s-s.start_s {operator} ?")
                parameters.append(value)
        for field, value in (("energy", min_energy), ("dialogue_space", min_dialogue_space)):
            if value is not None:
                # Only a missing segment field inherits; explicit null means unknown.
                source_json = f"CASE WHEN json_type(s.record_json,'$.{field}') IS NULL THEN a.record_json ELSE s.record_json END"
                expression = f"json_extract(({source_json}),'$.{field}')"
                where.append(f"json_type(({source_json}),'$.{field}') IN ('integer','real') AND {expression} BETWEEN ? AND 5")
                parameters.append(value)
        if vocals:
            vocal_match = "coalesce(json_extract(s.record_json,'$.vocal_presence'),'unknown')=?"
            if discover_unknown_vocals:
                vocal_match = (f"({vocal_match} OR (coalesce(json_extract(s.record_json,'$.vocal_presence'),'unknown')='unknown' "
                               "AND json_extract(a.record_json,'$.fulltrack_voice_annotation.label')='voice'))")
            where.append(vocal_match)
            parameters.append(vocals)
        if avoid_families:
            # A renamed/misclassified alias cannot bypass a family's recording ban.
            where.append("a.source_sha256 NOT IN (SELECT source_sha256 FROM assets WHERE "
                         "coalesce(family_id,asset_id) IN (" + ",".join("?" for _ in avoid_families) + "))")
            parameters.extend(avoid_families)
        if exclude_cases:
            where.append("coalesce(json_extract(s.record_json,'$.case_id'),'') NOT IN (" + ",".join("?" for _ in exclude_cases) + ")")
            parameters.extend(exclude_cases)
        sql = f"""WITH hits AS MATERIALIZED ({source})
          SELECT s.*,a.family_id,a.path,a.sample_rate,a.checked_at,a.commercial_allowed,a.record_json asset_json,hits.score
          FROM hits JOIN segments s USING(segment_id) JOIN assets a USING(asset_id)
          WHERE {' AND '.join(where)} ORDER BY score,s.segment_id"""
        if candidate_scope is not None:
            # JSON1 is a bound, read-only allowlist. Plot/known-sound conflicts
            # have been removed by the host before limiting the indexed query;
            # no unbounded audio decode or repeated per-family SQL is needed.
            sql = f"""WITH hits AS MATERIALIZED ({source}),
              scope AS MATERIALIZED (SELECT json_extract(value,'$.segment_id') segment_id,
                json_extract(value,'$.diversity_key') diversity_key,
                coalesce(json_extract(value,'$.preference'),0) preference,
                coalesce(json_extract(value,'$.usage_count'),0) usage_count FROM json_each(?)),
              eligible AS (SELECT s.*,a.family_id,a.path,a.sample_rate,a.checked_at,a.commercial_allowed,
                a.record_json asset_json,hits.score,scope.diversity_key,scope.preference,scope.usage_count,
                row_number() OVER(PARTITION BY scope.diversity_key ORDER BY hits.score,s.segment_id) family_rank
                FROM scope JOIN segments s USING(segment_id) JOIN assets a USING(asset_id) JOIN hits USING(segment_id)
                WHERE {' AND '.join(where)})
              SELECT * FROM eligible ORDER BY preference,family_rank,score,usage_count,segment_id LIMIT ?"""
            # The lexical MATCH placeholder precedes scope; all remaining
            # filters follow it, exactly as in the legacy query.
            position = 1 if query_terms else 0
            parameters.insert(position, json.dumps(candidate_scope, ensure_ascii=False))
            parameters.append(limit)
        rows = connection.execute(sql, parameters)
        if candidate_segment_ids is not None and not query_terms:
            positions = {segment_id: index for index, segment_id in enumerate(candidate_segment_ids)}
            rows = sorted(rows, key=lambda row: positions[row['segment_id']])
        candidates = []
        seen_families, seen_recordings = set(), set()
        for row in rows:
            family_phase = (row["family_id"] or row["asset_id"], row["phase"])
            recording_phase = (row["source_sha256"], row["phase"])
            if not preserve_source_windows and (family_phase in seen_families or recording_phase in seen_recordings):
                continue
            seen_families.add(family_phase)
            seen_recordings.add(recording_phase)
            asset, segment = json.loads(row["asset_json"]), json.loads(row["record_json"])
            candidates.append({"segment_id": row["segment_id"], "asset_id": row["asset_id"],
                "family_id": row["family_id"], "source_sha256": row["source_sha256"], "local_path": row["path"],
                "source_range": [row["start_s"], row["end_s"]], "sample_rate_hz": row["sample_rate"],
                "requested_function": function,
                "function_match_status": "not_requested" if not function else
                    "indexed_label_match" if function in segment.get("narrative_functions", []) else "unlabelled_candidate",
                "phase": row["phase"], "listening_status": row["listening_status"],
                "vocal_match_status": "not_requested" if not vocals else
                    "pending_fulltrack_voice_hint" if segment.get("vocal_presence", "unknown") == "unknown" and discover_unknown_vocals
                    else "indexed_window_label_match",
                "usage_scope": usage_scope, "commercial_catalog_eligible": bool(row["commercial_allowed"]),
                "output_use_status": "not_certified_by_retrieval",
                "asset_metadata": {key: asset.get(key) for key in ("title", "asset_kind", "narrative_functions", "substyles", "timbre", "energy", "dialogue_space", "tag_status", "fulltrack_voice_annotation")},
                "score_type": "lexical_bm25_not_audio_or_quality", "score": row["score"],
                "integrity_checked_at": row["checked_at"], "license": asset.get("license"),
                "license_evidence": asset.get("license_evidence", asset.get("license_url")), "record": segment})
            if len(candidates) == limit:
                break
        return {"task": "segment_candidate_retrieval_not_auditory_acceptance", "schema_version": 1,
                "candidates": candidates, "gaps": [] if candidates else [unresolved or "no_eligible_matching_segment"],
                "query_expansion": expansion,
                "excluded_tags": list(excluded_tags), "excluded_tag_scope": "indexed_metadata_not_actual_sound_or_usage_approval",
                "discover_unknown_functions": discover_unknown_functions,
                "discover_unknown_vocals": discover_unknown_vocals,
                "candidate_order": "eligible_verified_family_rounds_then_lexical_and_usage_hint" if candidate_scope is not None else
                    "upstream_id_order_not_artistic_acceptance" if candidate_segment_ids is not None and not query_terms else "lexical_score",
                **({"eligible_scope_size": len(candidate_scope), "scope_filtered_before_limit": True,
                    "family_scope_supplied_by_host": True} if candidate_scope is not None else {}),
                "excluded_case_ids": list(exclude_cases),
                "usage_scope": usage_scope,
                "query_ms": (time.perf_counter() - started) * 1000, "audio_files_read": 0,
                "integrity_scope": "last_import_snapshot_reverify_selected_sources_before_render"}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("import")
    ingest.add_argument("--db", required=True)
    ingest.add_argument("--catalog", required=True)
    ingest.add_argument("--segments")
    ingest.add_argument("--rehash", action="store_true")
    query = commands.add_parser("query")
    query.add_argument("--db", required=True)
    query.add_argument("--db-sha256")
    query.add_argument("--text", default="")
    query.add_argument("--function")
    query.add_argument("--candidate-segment-id", action="append", dest="candidate_segment_ids")
    query.add_argument("--phase")
    query.add_argument("--limit", type=int, default=5)
    query.add_argument("--avoid-family", action="append", default=[])
    query.add_argument("--exclude-case", action="append", default=[])
    query.add_argument("--exclude-tag", action="append", default=[])
    query.add_argument("--expand-functions", action="store_true")
    query.add_argument("--discover-unknown-functions", action="store_true",
                       help="Include unlabelled candidates for a specific task; never writes narrative labels")
    query.add_argument("--asset-kind", choices=["music", "sfx", "ambience"])
    query.add_argument("--usage-scope", choices=["production_commercial", "research_noncommercial"], default="production_commercial")
    query.add_argument("--substyle")
    query.add_argument("--timbre")
    query.add_argument("--min-duration", type=float)
    query.add_argument("--max-duration", type=float)
    query.add_argument("--min-energy", type=int)
    query.add_argument("--min-dialogue-space", type=int)
    query.add_argument("--vocals", choices=["unknown", "instrumental", "sung", "nonverbal_vocal"])
    query.add_argument("--discover-unknown-vocals", action="store_true",
                       help="Recall unknown windows with a whole-recording voice annotation; never verifies sung words")
    args = parser.parse_args()
    try:
        if args.command == "import":
            result = import_library(args.db, args.catalog, args.segments, args.rehash)
        else:
            library = {"path": str(Path(args.db).resolve()), "sha256": args.db_sha256} if Path(args.db).suffix.lower() == ".json" else args.db
            result = query_library(library, args.text, args.function, args.phase, args.limit, args.avoid_family,
                                   args.expand_functions, args.asset_kind, args.substyle, args.timbre,
                                   args.min_duration, args.max_duration, args.min_energy, args.min_dialogue_space, args.vocals, args.exclude_case,
                                   args.usage_scope, args.discover_unknown_functions, args.candidate_segment_ids, args.discover_unknown_vocals,
                                   excluded_tags=args.exclude_tag)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, KeyError, IndexError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
