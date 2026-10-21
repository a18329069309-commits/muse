"""Freeze source-bound completed research cases for recall; never grant production approval."""
import argparse
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
import time
from pathlib import Path

import case_preset_store as store
import corpus_materials as materials


TABLE_KEYS = {"works": "work_id", "episodes": "episode_id", "cases": "case_id", "packs": "pack_id",
              "theme_bundles": "theme_bundle_id", "sound_packs": "sound_pack_id"}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def load_bytes(filename):
    data = native_path(filename).read_bytes()
    return data, json.loads(data.decode("utf-8-sig"))


def native_path(filename):
    filename = str(Path(filename).resolve())
    if os.name == "nt" and not filename.startswith("\\\\?\\"):
        filename = "\\\\?\\UNC\\" + filename[2:] if filename.startswith("\\\\") else "\\\\?\\" + filename
    return Path(filename)


def binding(filename):
    filename = Path(filename).resolve()
    return {"path": str(filename), "sha256": store.digest_file(native_path(filename))}


def write_new(filename, value):
    with Path(filename).open("xb") as output:
        output.write(encoded(value))
    return binding(filename)


def complete(coverage):
    return (isinstance(coverage, dict) and coverage.get("complete_processed") is True
            and coverage.get("missing_ranges") == [] and coverage.get("unclassified_ranges") == [])


class Evidence:
    def __init__(self, canonical_paths=False):
        self.cache = {}
        self.files = {}
        self.lookups = {}
        self.documents = {}
        self.canonical_paths = canonical_paths
        self.bound_work_aliases = {}

    def check(self, item, base=Path(".")):
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            key = ("" if Path(item["path"]).is_absolute() else str(base), item["path"], item.get("sha256"))
            if key in self.lookups:
                return {**item, "path": self.lookups[key]}
        if not isinstance(item, dict) or not item.get("path"):
            raise ValueError("snapshot_file_binding_required")
        declared = item["path"] if Path(item["path"]).is_absolute() else str(Path(base).resolve() / item["path"])
        resolved = str(Path(declared).resolve())
        result = store.file_binding({**item, "path": str(native_path(resolved))}, Path("."), self.cache)
        result["path"] = resolved if self.canonical_paths else declared
        self.files[(resolved, result["sha256"])] = result
        self.lookups[key] = result["path"]
        return result

    def document(self, item):
        if not isinstance(item, dict) or not item.get("path"):
            raise ValueError("snapshot_file_binding_required")
        resolved = str(Path(item["path"]).resolve())
        expected = store.sha(item.get("sha256"))
        io_path = native_path(resolved)
        before = io_path.stat() if io_path.is_file() else None
        if before is None:
            raise ValueError("evidence_file_missing_or_hash_changed")
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        signature = tuple(getattr(before, field) for field in fields)
        key = (resolved, expected)
        cached = self.documents.get(key)
        if cached and cached[0] == signature:
            self.check(item)
            return deepcopy(cached[1])
        self.documents.pop(key, None)
        data = io_path.read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        after = io_path.stat()
        if signature != tuple(getattr(after, field) for field in fields):
            raise ValueError("snapshot_input_changed_during_read")
        if actual != expected:
            raise ValueError("evidence_file_missing_or_hash_changed")
        document = json.loads(data.decode("utf-8-sig"))
        # Share this verified read with the existing binding checker for this publication only.
        self.cache[str(io_path.resolve())] = (signature, actual)
        self.check(item)
        self.documents[key] = (signature, document)
        return deepcopy(document)

    def tree(self, value, base):
        if isinstance(value, list):
            for child in value:
                self.tree(child, base)
        elif isinstance(value, dict):
            if "path" in value and "sha256" in value:
                self.check(value, base)
            for child in value.values():
                self.tree(child, base)


def subset(document, accepted):
    """Keep only admitted episodes and their reachable material records, including step references."""
    result = {"schema_version": 2, **{table: [] for table in TABLE_KEYS}}
    result["cases"] = [deepcopy(row) for row in document.get("cases", []) if row["episode_id"] in accepted]
    episode_ids = {row["episode_id"] for row in result["cases"]}
    result["episodes"] = [deepcopy(row) for row in document.get("episodes", []) if row["episode_id"] in episode_ids]
    work_ids = {row["work_id"] for row in result["episodes"]}
    result["works"] = [deepcopy(row) for row in document.get("works", []) if row["work_id"] in work_ids]
    refs = {key: set() for key in ("music_pack_ids", "theme_bundle_ids", "sound_pack_ids")}
    def collect(value):
        if isinstance(value, list):
            for child in value: collect(child)
        elif isinstance(value, dict):
            for key, child in value.items():
                if key in refs: refs[key].update(child)
                else: collect(child)
    collect(result["cases"])
    result["theme_bundles"] = [deepcopy(row) for row in document.get("theme_bundles", [])
                               if row["theme_bundle_id"] in refs["theme_bundle_ids"]]
    collect(result["theme_bundles"])
    result["packs"] = [deepcopy(row) for row in document.get("packs", []) if row["pack_id"] in refs["music_pack_ids"]]
    result["sound_packs"] = [deepcopy(row) for row in document.get("sound_packs", [])
                             if row["sound_pack_id"] in refs["sound_pack_ids"]]
    return result


def validate_document(document, accepted, evidence, base, original_cases, allow_new_cases=True):
    works = {row["work_id"]: row for row in document["works"]}
    episodes = {row["episode_id"]: row for row in document["episodes"]}
    for episode_id, episode in episodes.items():
        row = accepted[episode_id]
        if (episode["work_id"] != row["work_id"] or episode.get("media_status", "metadata_only") == "metadata_only"
                or episode.get("source_video", {}).get("sha256") != row["source_video_sha256"]
                or works[episode["work_id"]].get("split") != row["split"]):
            raise ValueError("snapshot_episode_identity_or_split_invalid")
        source = evidence.check(episode["source_video"], base)
        if Path(source["path"]).resolve() != Path(row["video"]).resolve():
            raise ValueError("snapshot_episode_source_path_changed")
        episode["source_video"] = source
    for case in document["cases"]:
        episode = episodes[case["episode_id"]]
        ev = case.get("evidence", {})
        if (ev.get("source_video_sha256") != episode["source_video"]["sha256"]
                or ev.get("source_range") != case.get("source_range") or not ev.get("files")):
            raise ValueError("snapshot_case_source_evidence_required")
        interval = store.source_range(case.get("source_range"))
        duration = accepted[case["episode_id"]]["duration_seconds"]
        if interval[0] < 0 or interval[1] > duration:
            raise ValueError("snapshot_case_outside_episode")
        previous = original_cases.get(case["case_id"])
        if not allow_new_cases and previous is None:
            raise ValueError("snapshot_work_case_missing_episode_result")
        if previous and any(previous.get(key) != case.get(key) for key in ("episode_id", "source_range", "status")):
            raise ValueError("snapshot_case_identity_or_status_changed")
        original_cases.setdefault(case["case_id"], deepcopy(case))
        ev["files"] = [evidence.check(item, base) for item in ev["files"]]
    evidence.tree(document, base)
    for work_id, work in works.items():
        evidence.bound_work_aliases.setdefault(work_id, set()).update(work.get("identity_aliases", []))


def merge(target, document):
    for table, key in TABLE_KEYS.items():
        for row in document[table]:
            previous = target[table].get(row[key])
            if previous and table in ("packs", "theme_bundles", "sound_packs") and previous != row:
                raise ValueError("snapshot_material_id_conflict")
            if previous and table == "works":
                if previous["split"] != row["split"] or previous.get("official_series_id") != row.get("official_series_id"):
                    raise ValueError("snapshot_work_identity_changed")
                row = {**previous, **row, "identity_aliases": list(dict.fromkeys(
                    [*previous.get("identity_aliases", []), *row.get("identity_aliases", [])]))}
            target[table][row[key]] = deepcopy(row)


def bound_record_equal(table, current, previous, evidence):
    if current == previous:
        return True
    if table == "works" and current and previous:
        admitted = evidence.bound_work_aliases.get(current.get("work_id"), set())
        return (set(current.get("identity_aliases", [])) == admitted
                and set(previous.get("identity_aliases", [])).issubset(admitted)
                and {key: value for key, value in current.items() if key != "identity_aliases"}
                    == {key: value for key, value in previous.items() if key != "identity_aliases"})
    if table != "episodes" or not current or not previous:
        return False
    left, right = previous.get("source_video", {}), current.get("source_video", {})
    if ({key: value for key, value in left.items() if key != "path"}
            != {key: value for key, value in right.items() if key != "path"}):
        return False
    left, right = evidence.check(left), evidence.check(right)
    if not os.path.samefile(native_path(left["path"]), native_path(right["path"])):
        return False
    return {**previous, "source_video": current["source_video"]} == current


def validate_isolation(research, heldout):
    identities = {identity for work in heldout["works"].values() for identity in store.work_identities(work)}
    hashes = {row["source_video"]["sha256"] for row in heldout["episodes"].values()}
    if (any(identities.intersection(store.work_identities(work)) for work in research["works"].values())
            or any(row["source_video"]["sha256"] in hashes for row in research["episodes"].values())):
        raise ValueError("snapshot_heldout_identity_leak")


def validate_rule_sources(rule, work_case_ids, research):
    case_ids = set(rule["case_ids"])
    if not case_ids.issubset(work_case_ids):
        raise ValueError("snapshot_rule_wrong_work_cases")
    expected_works = {research["episodes"][research["cases"][case_id]["episode_id"]]["work_id"] for case_id in case_ids}
    if "work_ids" in rule and set(rule["work_ids"]) != expected_works:
        raise ValueError("snapshot_rule_source_identity_invalid")
    sources = rule.get("source_case_evidence", [rule])
    covered = set()
    for source in sources:
        ids = set(source.get("case_ids", []))
        if not ids or not ids.issubset(case_ids) or not source.get("evidence_files"):
            raise ValueError("snapshot_rule_source_identity_invalid")
        for case_id in ids:
            case = research["cases"][case_id]
            media = research["episodes"][case["episode_id"]]["source_video"]
            if (source.get("source_video_sha256") != media["sha256"] or source.get("source_range") != case["source_range"]
                    or source.get("source_observation_status") != case["status"]
                    or (source.get("source_video") or {}).get("sha256") != media["sha256"]
                    or Path((source.get("source_video") or {}).get("path", "")).resolve() != Path(media["path"]).resolve()):
                raise ValueError("snapshot_rule_source_identity_invalid")
        covered.update(ids)
    if covered != case_ids:
        raise ValueError("snapshot_rule_source_identity_invalid")


def inherit_historical_rules(published, prior_publications, output):
    """Keep actual old synthesis only when every referenced current case is identical."""
    if not prior_publications:
        return published
    evidence, gaps, inherited = Evidence(), [], []
    current_rules = evidence.check(published['research']['rules_db'])
    current_cases = evidence.check(published['research']['cases_db'])
    with closing(store.readonly(current_rules['path'])) as db:
        rules = {row['rule_id']: row for text, in db.execute('SELECT record_json FROM rules') if (row := json.loads(text))}
    with closing(store.readonly(current_cases['path'])) as db:
        current = {table: {row[TABLE_KEYS[table]]: row for text, in db.execute('SELECT record_json FROM ' + table)
                          if (row := json.loads(text))} for table in ('works', 'episodes', 'cases')}
    for reference in prior_publications:
        prior = evidence.document(reference)
        if prior.get('kind') != 'frozen_research_snapshot' or prior.get('formal_adoption_allowed') is not False:
            raise ValueError('historical_research_publication_required')
        inputs = evidence.document(prior['inputs']['verified'])
        sources = {row['work_id']: row for row in inputs['work_sources']
                   if row.get('nuwa_synthesis_completed') is True and row.get('state_status') == 'research_aggregated'}
        old_rules = evidence.check(prior['research']['rules_db'])
        old_cases = evidence.check(prior['research']['cases_db'])
        with closing(store.readonly(old_rules['path'])) as db:
            missing = [json.loads(text) for text, in db.execute('SELECT record_json FROM rules')
                       if json.loads(text)['rule_id'] not in rules]
        with closing(store.readonly(old_cases['path'])) as db:
            for rule in missing:
                ids = set(rule.get('case_ids', []))
                original = {key: (json.loads(row[0]) if (row := db.execute('SELECT record_json FROM cases WHERE case_id=?', (key,)).fetchone())
                                  else None) for key in ids}
                if not ids or any(original[key] != current['cases'].get(key) for key in ids):
                    gaps.append({'rule_id': rule['rule_id'], 'reason': 'historical_case_definition_needs_revalidate'}); continue
                works = {current['episodes'][current['cases'][key]['episode_id']]['work_id'] for key in ids}
                if not works.issubset(sources):
                    gaps.append({'rule_id': rule['rule_id'], 'reason': 'historical_successful_nuwa_source_required'}); continue
                for work in works:
                    source = sources[work]
                    result = evidence.document(source['result'])
                    if result.get('rule_synthesis', {}).get('nuwa_synthesis_completed') is not True:
                        raise ValueError('historical_nuwa_result_not_completed')
                    evidence.check(source['rule_index'])
                if rule.get('status') != 'research' or rule.get('production_approval') is not False:
                    raise ValueError('historical_research_rule_status_required')
                validate_rule_sources(rule, ids, current)
                evidence.tree(rule, Path(old_rules['path']).parent)
                rules[rule['rule_id']] = rule
                inherited.append({'rule_id': rule['rule_id'], 'prior_publication': reference,
                                  'source_works': [sources[work] for work in sorted(works)],
                                  'case_ids': sorted(ids), 'source_record_unchanged': True})
    for item in evidence.files.values():
        store.file_binding({**item, 'path': str(native_path(item['path']))}, Path('.'), evidence.cache)
    result = deepcopy(published)
    record = {'kind': 'historical_research_rule_inheritance', 'inherited': inherited, 'needs_revalidate': gaps,
              'no_new_model_calls': True, 'qualification_granted': False,
              'current_failed_aggregation_not_reclassified': True}
    result['historical_rule_inheritance'] = write_new(Path(output) / 'historical-rule-inheritance.json', record)
    if inherited:
        target = Path(output) / 'research-rules-with-history.sqlite'
        materials.write_rule_index(target, {'rules': list(rules.values())})
        result['research']['rules_db'] = binding(target)
        result['consumer']['cases']['rules_db'] = str(target)
        result['rule_count'] = len(rules)
    return result


def frozen_input(output, name, filename, expected=None):
    data, value = load_bytes(filename)
    sha256 = hashlib.sha256(data).hexdigest()
    if expected is not None and sha256 != expected:
        raise ValueError("snapshot_config_state_identity_mismatch")
    target = output / name
    with target.open("xb") as file: file.write(data)
    return value, {"origin_path": str(Path(filename).resolve()), "snapshot": binding(target)}


def publish_research_snapshot(batch_config, output_dir):
    """Read a point-in-time batch state and publish into an exclusively new directory."""
    started_at, clock = datetime.now(timezone.utc).isoformat(), time.monotonic()
    implementation = {"publisher": binding(__file__), "case_store": binding(store.__file__),
                      "rule_store": binding(materials.__file__)}
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    config, config_receipt = frozen_input(output, "batch-config.json", batch_config)
    checkpoint = Path(config["checkpoint_root"])
    state, state_receipt = frozen_input(output, "batch-state.json", checkpoint / "batch-state.json")
    manifest, manifest_receipt = frozen_input(output, "media-manifest.json", config["manifest_file"],
                                               state["identity"]["manifest_sha256"])
    evidence = Evidence()
    format_binding = evidence.check(config["source_format_manifest"]) if config.get("source_format_manifest") else None
    rows = {}
    for row in manifest["entries"]:
        source_hash = row.get("source_video_sha256", row.get("sha256"))
        if row.get("sha256", source_hash) != source_hash:
            raise ValueError("snapshot_media_hash_fields_conflict")
        rows[row["episode_id"]] = {**row, "source_video_sha256": source_hash,
                                  "video": str((Path(config["manifest_file"]).parent / row["video"]).resolve())}
    if len(rows) != len(manifest["entries"]): raise ValueError("snapshot_duplicate_episode")
    dispute_path = checkpoint / "source-identity-disputes.json"
    disputes, dispute_receipt = {}, None
    if dispute_path.exists():
        document, dispute_receipt = frozen_input(output, "source-identity-disputes.json", dispute_path)
        if document.get("schema_version") != 1 or document.get("kind") != "source_identity_dispute_sidecar":
            raise ValueError("snapshot_identity_sidecar_invalid")
        for row in document["entries"]:
            if row["episode_id"] in disputes: raise ValueError("snapshot_identity_sidecar_duplicate")
            disputes[row["episode_id"]] = row
    accepted, imports, excluded, original_cases = {}, [], [], {}
    for episode_id, item in sorted(state.get("episodes", {}).items()):
        if item.get("status") not in ("research_processed", "heldout_processed"):
            excluded.append({"episode_id": episode_id, "state_status": item.get("status"), "reason": "episode_not_processed"})
            continue
        row = rows.get(episode_id)
        if not row or row.get("source_video_sha256") != item.get("source_sha256") or row.get("work_id") != item.get("work_id"):
            raise ValueError("snapshot_processed_episode_not_source_bound")
        split = row.get("split")
        if split not in ("research", "heldout") or split != item.get("split") or (split == "heldout") != (item["status"] == "heldout_processed"):
            raise ValueError("snapshot_processed_split_invalid")
        for related in disputes.values():
            if related.get("work_id") == row["work_id"] and (related.get("identity_status") != "resolved"
                    or related.get("current_research_input_eligible") is not True):
                raise ValueError("snapshot_source_identity_disputed")
        dispute = disputes.get(episode_id)
        if dispute:
            resolution = dispute.get("resolution") or {}
            if (dispute.get("source_video_sha256") != item["source_sha256"] or dispute.get("work_id") != item["work_id"]
                    or dispute.get("identity_status") != "resolved" or dispute.get("current_research_input_eligible") is not True
                    or resolution.get("source_video_sha256") != item["source_sha256"] or not resolution.get("evidence_files")):
                raise ValueError("snapshot_source_identity_disputed")
            evidence.tree(resolution, dispute_path.parent)
        elif item.get("identity_dispute_requires_resolution") is True or item.get("identity_review", {}).get("status") in ("identity_disputed", "disputed"):
            raise ValueError("snapshot_source_identity_resolution_required")
        record = evidence.document(item.get("result"))
        if not complete(item.get("coverage")) or not complete(record.get("coverage")):
            raise ValueError("snapshot_complete_coverage_required")
        if (record.get("episode_id") != episode_id or record.get("work_id") != row["work_id"]
                or record.get("source_video_sha256") != item["source_sha256"]
                or record.get("status") not in ("research_processed", "heldout_processed")):
            raise ValueError("snapshot_result_identity_or_status_invalid")
        original = evidence.document(item.get("case_import"))
        if original != record.get("import_document"):
            raise ValueError("snapshot_case_import_does_not_match_result")
        accepted[episode_id] = {**row, "duration_seconds": record["coverage"]["duration_seconds"]}
        selected = subset(original, {episode_id})
        if not selected["cases"] or len(selected["cases"]) != len(original.get("cases", [])):
            raise ValueError("snapshot_complete_episode_cases_required")
        validate_document(selected, accepted, evidence, Path(item["case_import"]["path"]).parent, original_cases)
        cursor = 0
        for case in sorted(selected["cases"], key=lambda row: row["source_range"][0]):
            start, end = case["source_range"]
            if start > cursor + 0.001: raise ValueError("snapshot_case_coverage_gap")
            cursor = max(cursor, end)
        if cursor < accepted[episode_id]["duration_seconds"] - 0.001:
            raise ValueError("snapshot_case_coverage_gap")
        imports.append((split, selected))
    # Identity aliases and identical media cannot leak a heldout work into training recall.
    held_hashes = {row["source_video_sha256"] for row in accepted.values() if row["split"] == "heldout"}
    held_identities = {identity for split, doc in imports if split == "heldout" for work in doc["works"]
                       for identity in store.work_identities(work)}
    for split, doc in imports:
        if split == "research" and (any(ep["source_video"]["sha256"] in held_hashes for ep in doc["episodes"])
                or any(held_identities.intersection(store.work_identities(work)) for work in doc["works"])):
            raise ValueError("snapshot_heldout_identity_leak")
    merged = {split: {table: {} for table in TABLE_KEYS} for split in ("research", "heldout")}
    for split, document in imports: merge(merged[split], document)
    work_sources, rules, gaps = [], {}, []
    research_ids = {eid for eid, row in accepted.items() if row["split"] == "research"}
    for work_id, item in sorted(state.get("works", {}).items()):
        work_episode_ids = {eid for eid in research_ids if accepted[eid]["work_id"] == work_id}
        if not work_episode_ids: continue
        if item.get("status") not in ("research_aggregated", "aggregation_gap") or not item.get("result_binding"):
            gaps.append({"work_id": work_id, "state_status": item.get("status"), "gap": "work_result_not_yet_publishable"})
            continue
        result = evidence.document(item.get("result_binding"))
        if result != item.get("result") or not result.get("input_bindings"):
            raise ValueError("snapshot_work_result_binding_required")
        work_keys = {table: set() for table in TABLE_KEYS}
        for file in result["input_bindings"]:
            doc = subset(evidence.document(file), work_episode_ids)
            validate_document(doc, accepted, evidence, Path(file["path"]).parent, original_cases, False)
            merge(merged["research"], doc)
            for table, key in TABLE_KEYS.items(): work_keys[table].update(row[key] for row in doc[table])
        old_db = binding(result["cases_db"])
        # The old DB path alone is not proof. Its selected records are compared with the bound imports below.
        old_rules = evidence.check(result.get("rule_index"))
        with closing(store.readonly(old_rules["path"])) as db:
            for row in db.execute("SELECT record_json FROM rules ORDER BY rule_id"):
                rule = json.loads(row[0])
                case_ids = set(rule.get("case_ids", []))
                if not case_ids or not case_ids.issubset(merged["research"]["cases"]):
                    gaps.append({"work_id": work_id, "rule_id": rule.get("rule_id"), "gap": "rule_references_unpublished_cases"})
                    continue
                if rule.get("production_approval") is not False or rule.get("status") != "research":
                    raise ValueError("snapshot_research_rule_status_required")
                validate_rule_sources(rule, work_keys["cases"], merged["research"])
                evidence.tree(rule, Path(old_rules["path"]).parent)
                # Nuwa IDs are local to an independently synthesized work. Keep
                # the original bound record and namespace only its publication.
                rule = {**rule, "source_rule_id": rule["rule_id"], "source_rule_index": old_rules,
                        "rule_id": work_id + "/" + rule["rule_id"]}
                prior = rules.get(rule["rule_id"])
                if prior and prior != rule: raise ValueError("snapshot_rule_id_conflict")
                rules[rule["rule_id"]] = rule
        work_sources.append({"work_id": work_id, "cases_db": old_db, "rule_index": old_rules,
                             "result": item["result_binding"], "state_status": item["status"],
                             "nuwa_synthesis_completed": result.get("rule_synthesis", {}).get("nuwa_synthesis_completed") is True,
                             "record_ids": {table: sorted(ids) for table, ids in work_keys.items()}})
        gaps.extend({"work_id": work_id, "gap": gap} for gap in item.get("acceptance", {}).get("material_gaps", []))
        for stage in ("material_results", "material_candidate_results", "material_selection_results"):
            for selection in result.get(stage) or []:
                gaps.extend({"work_id": work_id, "stage": stage, "stage_status": selection.get("status"), "gap": gap}
                            for gap in selection.get("gaps", []))
    validate_isolation(merged["research"], merged["heldout"])
    databases, reports = {}, {}
    for split, tables in merged.items():
        document = {"schema_version": 2, **{table: list(values.values()) for table, values in tables.items()}}
        database = output / (split + "-cases.sqlite")
        store.import_store(database, document, output, evidence_checker=evidence.check)
        databases[split] = binding(database)
        reports[split] = store.report_store(database)
    with closing(store.readonly(databases["research"]["path"])) as current:
        for work in work_sources:
            with closing(store.readonly(work["cases_db"]["path"])) as old:
                for table, key in TABLE_KEYS.items():
                    for record_id in work["record_ids"][table]:
                        sql = "SELECT record_json FROM " + table + " WHERE " + key + "=?"
                        record = old.execute(sql, (record_id,)).fetchone()
                        found = current.execute(sql, (record_id,)).fetchone()
                        if not record or not found or not bound_record_equal(
                                table, json.loads(found[0]), json.loads(record[0]), evidence):
                            raise ValueError("snapshot_work_db_not_equal_bound_imports")
            if binding(work["cases_db"]["path"]) != work["cases_db"]:
                raise ValueError("snapshot_work_db_changed_during_read")
            evidence.check(work["rule_index"])
    indexed_case_ids = {case_id for rule in rules.values() for case_id in rule["case_ids"]}
    for case in merged["research"]["cases"].values():
        gaps.extend({"case_id": case["case_id"], "gap": gap} for gap in case.get("unresolved_gaps", []))
        if not case.get("music_pack_ids") and not case.get("theme_bundle_ids"):
            gaps.append({"case_id": case["case_id"], "gap": "case_has_no_music_pack"})
        if case["case_id"] not in indexed_case_ids:
            gaps.append({"case_id": case["case_id"], "gap": "work_rule_index_not_yet_available_for_case"})
    rule_file = output / "research-rules.sqlite"
    materials.write_rule_index(rule_file, {"rules": list(rules.values())})
    # Recheck every distinct input at publication, without repeating full reads for unchanged stat identities.
    for item in evidence.files.values():
        store.file_binding({**item, "path": str(native_path(item["path"]))}, Path("."), evidence.cache)
    evidence_file = write_new(output / "verified-inputs.json", {"files": list(evidence.files.values()), "work_sources": work_sources})
    result = {"schema_version": 1, "kind": "frozen_research_snapshot", "created_at": datetime.now(timezone.utc).isoformat(),
              "started_at": started_at, "elapsed_seconds": time.monotonic() - clock,
              "implementation": implementation,
              "status": "research_snapshot_available", "inputs": {"config": config_receipt, "state": state_receipt,
              "media_manifest": manifest_receipt, "source_identity_sidecar": dispute_receipt, "verified": evidence_file},
              "consumer": {"cases": {"db": databases["research"]["path"], "rules_db": str(rule_file),
                           **({"source_format_manifest": format_binding, "prefer_vertical": config.get("prefer_vertical") is True}
                              if format_binding else {})},
                           "usage_scope": "research_noncommercial"},
              "research": {"cases_db": databases["research"], "rules_db": binding(rule_file), "report": reports["research"]},
              "heldout": {"cases_db": databases["heldout"], "report": reports["heldout"], "training_recall_allowed": False},
              "included_episodes": [{"episode_id": eid, "work_id": row["work_id"], "source_video_sha256": row["source_video_sha256"],
                                     "split": row["split"]} for eid, row in accepted.items()], "excluded_episodes": excluded,
              "material_gaps": gaps, "rule_count": len(rules), "complete_corpus_claimed": False,
              "rule_source_works": [{key: work[key] for key in ("work_id", "state_status", "nuwa_synthesis_completed", "rule_index")}
                                    for work in work_sources],
              "production_usable": False, "formal_adoption_allowed": False, "qualification_granted": False,
              "artistic_approval": False, "model_calls": 0, "qualification_statuses_changed": False}
    write_new(output / "publication.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-config", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    published = publish_research_snapshot(args.batch_config, args.output_dir)
    print(json.dumps({"status": published["status"], "publication": str(args.output_dir.resolve() / "publication.json"),
                      "production_usable": False}, ensure_ascii=False))
