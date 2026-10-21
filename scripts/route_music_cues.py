"""Route frozen music tasks to audition, editing, or stock-gap diagnosis.

Retrieves real indexed pointers. Never calls models or chooses the first hit.
Listening and qualification records are checked, not independently heard.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

import segment_library as library


QUERY_FIELDS = {"text", "function", "phase", "limit", "avoid_families", "expand_functions",
                "asset_kind", "substyle", "timbre", "min_duration", "max_duration",
                "min_energy", "min_dialogue_space", "vocals", "exclude_cases", "usage_scope",
                "discover_unknown_functions", "candidate_segment_ids", "discover_unknown_vocals", "excluded_tags"}
DIRECTOR_GAPS = {"ambiguous_function_query_needs_specific_story_task",
                 "negated_text_query_needs_positive_structured_filters",
                 "conflicting_explicit_function_requests"}
NEGATIVE_QUERY = re.compile(r"不要|避免|不需要|不是|\b(without|not|no)\b", re.I)
WORDS_MODES = {"same_source_development", "song_replace", "vocal_overlay"}


def json_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def valid_range(value):
    return (isinstance(value, list) and len(value) == 2
            and all(not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) for x in value)
            and 0 <= value[0] < value[1])


def expand_music_cues(director):
    """Compile explicit local words requests without replacing parent music tasks."""
    rows = director.get("cues", [])
    expanded = []
    for cue in rows:
        if not isinstance(cue, dict) or not isinstance(cue.get("cue_id"), str) or not cue["cue_id"].strip():
            raise ValueError("unique_director_cues_required")
        expanded.append(cue)
        if "words_target_range" not in cue or "words_candidate_request" not in cue:
            continue
        parent, target = cue.get("target_range"), cue["words_target_range"]
        mode = cue.get("words_mode", "song_replace")
        if (not valid_range(parent) or not valid_range(target) or target[0] < parent[0]
                or target[1] > parent[1] or mode not in WORDS_MODES
                or cue["words_candidate_request"] not in ("explore", "require")):
            raise ValueError("valid_words_subtask_range_mode_and_policy_required")
        child = {k: v for k, v in cue.items() if k not in (
            "words_target_range", "words_function", "words_audio_retrieval_query")}
        child.update(cue_id=cue["cue_id"] + "/words", music_role="words_candidate",
                     parent_cue_id=cue["cue_id"], parent_target_range=parent,
                     target_range=target, words_mode=mode, parent_cue_sha256=json_hash(cue),
                     function=cue.get("words_function", cue.get("function")),
                     vocal_language=cue.get("vocal_language", "unknown"),
                     filters={**cue.get("filters", {}), "vocals": "sung",
                              "discover_unknown_vocals": cue.get("filters", {}).get("discover_unknown_vocals", True)})
        if cue.get("arc_parent_cue_id"):
            child["arc_parent_cue_id"] = cue["arc_parent_cue_id"] + "/words"
            child.pop("requested_candidates", None)
        if cue.get("words_audio_retrieval_query") or cue.get("audio_retrieval_query"):
            child["audio_retrieval_query"] = cue.get("words_audio_retrieval_query", cue.get("audio_retrieval_query"))
        expanded.append(child)
    if len({cue.get("cue_id") for cue in expanded}) != len(expanded):
        raise ValueError("words_subtask_id_conflicts_with_existing_cue")
    return expanded


def verified_file(binding):
    if not isinstance(binding, dict) or not isinstance(binding.get("path"), str):
        raise ValueError("file_binding_required")
    file = Path(binding["path"])
    if not file.is_absolute() or not file.is_file():
        raise ValueError("absolute_existing_file_required")
    before = file.stat()
    digest = library.digest_file(file)
    if digest != binding.get("sha256"):
        raise ValueError("file_hash_mismatch")
    if (before.st_size, before.st_mtime_ns) != (file.stat().st_size, file.stat().st_mtime_ns):
        raise ValueError("file_changed_during_check")
    return file


def same_audio_backend(record, expected):
    def identity(value):
        if (value.get("backend_id") == "gemini-3.8-flash"
                and not value.get("model_revision") and not value.get("protocol")):
            return ("gemini_interactions", "gemini-3.8-flash", "gemini-3.8-flash")
        revision = value.get("model_revision")
        if (value.get("protocol") == "gemini_interactions" and value.get("backend_id")
                and isinstance(revision, str) and revision.startswith("gemini-")):
            return (value["protocol"], value["backend_id"], revision)
        return None
    actual, wanted = identity(record), identity(expected)
    return actual is not None and actual == wanted


def review_candidate(review, candidate, cue, cue_hash, query_hash):
    """Check declared review provenance and real source stability, not aesthetics."""
    if (review.get("cue_sha256") != cue_hash or review.get("query_sha256") != query_hash
            or review.get("source_sha256") != candidate["source_sha256"]
            or review.get("candidate_source_range") != candidate["source_range"]):
        raise ValueError("stale_or_unbound_review")
    verdict = review.get("verdict")
    if verdict not in ("selected", "rejected", "unknown"):
        raise ValueError("invalid_review_verdict")
    if verdict == "unknown":
        return "unknown", None
    if not isinstance(review.get("reason"), str) or not review["reason"].strip():
        raise ValueError("actual_sound_reason_required")
    evidence = review.get("listening_evidence", {})
    if (not isinstance(evidence, dict) or evidence.get("actual_audio_processed") is not True
            or not evidence.get("backend_id")):
        raise ValueError("actual_audio_processing_evidence_required")
    if not isinstance(evidence.get("observations"), str) or not evidence["observations"].strip():
        raise ValueError("actual_sound_observations_required")
    qualification_file = verified_file(evidence.get("qualification_record"))
    qualification = json.loads(qualification_file.read_text(encoding="utf-8-sig"))
    if (not isinstance(qualification, dict) or qualification.get("status") != "qualified"
            or not same_audio_backend(evidence, qualification)
            or not isinstance(qualification.get("scopes"), list)
            or not all(scope in qualification["scopes"] for scope in ("audio_observation", "music_candidate_judgment"))):
        raise ValueError("qualified_listener_record_required")
    source_range = review.get("source_range")
    if (not valid_range(source_range) or source_range[0] < candidate["source_range"][0]
            or source_range[1] > candidate["source_range"][1]
            or (verdict == "selected" and source_range[1] - source_range[0] + .001
                < cue["target_range"][1] - cue["target_range"][0])):
        raise ValueError("review_source_range_invalid_or_too_short")
    words = None
    if cue.get("music_role") == "words_candidate" and verdict == "selected":
        words = review.get("words_evidence", {})
        language = words.get("vocal_language")
        if (words.get("content_status") != "verified" or words.get("source_sha256") != candidate["source_sha256"]
                or words.get("source_range") != source_range or words.get("vocal_presence") != "sung"
                or not isinstance(words.get("actual_words"), str) or not words["actual_words"].strip()
                or not isinstance(language, str) or not language.strip() or language.casefold() in ("unknown", "uncertain")
                or cue.get("vocal_language", "unknown") not in ("unknown", language)):
            raise ValueError("verified_current_words_window_and_language_required")
        if cue.get("words_mode") == "vocal_overlay" and words.get("mix_compatibility") not in (
                "isolated_vocal", "verified_compatible_mix"):
            raise ValueError("words_overlay_requires_verified_clean_or_compatible_audio")
        if cue.get("words_complete_phrase_required") and words.get("complete_phrase") is not True:
            raise ValueError("actual_complete_sung_phrase_required")
    if verdict == "selected" and "requested_candidates" in cue:
        intentions = cue["requested_candidates"]
        matches = [p for p in intentions if isinstance(p, dict) and p.get("segment_id") == candidate["segment_id"]] if isinstance(intentions, list) else []
        if (len(matches) != 1 or not valid_range(matches[0].get("source_range"))
                or source_range[0] < matches[0]["source_range"][0] or source_range[1] > matches[0]["source_range"][1]):
            raise ValueError("selected_source_outside_requested_candidate_window")
    audio = verified_file(evidence.get("input_audio"))
    input_duration, _, _ = library.probe_file(audio)
    source_file = verified_file({"path": candidate["local_path"], "sha256": candidate["source_sha256"]})
    source_duration, _, _ = library.probe_file(source_file)
    verified_file({"path": str(source_file), "sha256": candidate["source_sha256"]})
    if source_range[1] > source_duration + .001:
        raise ValueError("review_source_range_out_of_actual_audio")
    if evidence["input_audio"]["sha256"] != candidate["source_sha256"]:
        if (evidence["input_audio"].get("source_sha256") != candidate["source_sha256"]
                or evidence["input_audio"].get("source_range") != source_range
                or abs(input_duration - (source_range[1] - source_range[0])) > .05):
            raise ValueError("listening_excerpt_not_bound_to_source_window")
    return verdict, {"segment_id": candidate["segment_id"], "asset_id": candidate["asset_id"],
                     "source_sha256": candidate["source_sha256"], "local_path": str(source_file),
                     "source_range": source_range, "reason": review["reason"],
                     "listening_record_checked": True,
                     "listening_input_binding": {**evidence["input_audio"], "derivation_status":
                         "same_original_recording" if evidence["input_audio"]["sha256"] == candidate["source_sha256"]
                         else "declared_excerpt_not_independently_proven"},
                     "qualification_record": evidence["qualification_record"],
                     **({"words_evidence": words, "words_mode": cue["words_mode"],
                         "parent_cue_id": cue["parent_cue_id"]} if words is not None else {})}


def gap_route(cue, missing_sound_type):
    if cue["mode"] == "fine" and cue.get("allow_generation") is True:
        if (not isinstance(missing_sound_type, str) or not missing_sound_type.strip()
                or missing_sound_type.strip().casefold() in library.AMBIGUOUS_FUNCTIONS
                or missing_sound_type == cue["query"]["function"] or NEGATIVE_QUERY.search(missing_sound_type)):
            return {"status": "need_director_revision", "reason": "specific_positive_required_sound_for_generation_gap",
                    "generation_request": None}
        return {"status": "need_gap_diagnosis", "requested_sound_type": missing_sound_type,
                "generation_request": None, "generation_eligibility": "not_established",
                "required_checks": ["unknown_audio_tags", "overly_strict_filters",
                                    "source_catalog_availability", "undownloaded_candidates"]}
    return {"status": "stock_gap", "requested_sound_type": missing_sound_type,
            "gap_scope": "no_match_in_local_index_not_proven_absent_from_sources",
            "generation_request": None}


def route_music_cues(task, db_path, reviews=None):
    """Return decisions for an API executor; no media generation or database writes."""
    if (not isinstance(task, dict) or task.get("schema_version") != 1
            or not isinstance(task.get("cues"), list) or not task["cues"]):
        raise ValueError("frozen_music_task_with_cues_required")
    if not isinstance(task.get("source_video_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", task["source_video_sha256"], re.I):
        raise ValueError("source_video_sha256_required")
    task_scope = task.get("usage_scope", "production_commercial")
    if task_scope not in ("production_commercial", "research_noncommercial"):
        raise ValueError("invalid_task_usage_scope")
    reviews = {"schema_version": 1, "reviews": []} if reviews is None else reviews
    if (not isinstance(reviews, dict) or reviews.get("schema_version") != 1
            or not isinstance(reviews.get("reviews"), list)
            or any(not isinstance(r, dict) for r in reviews["reviews"])):
        raise ValueError("invalid_reviews_document")
    db_path = Path(db_path).resolve()
    db_hash = library.digest_file(db_path)
    output = {"schema_version": 1, "task_sha256": json_hash(task), "database_sha256": db_hash,
              "cues": [], "usage_scope": task_scope, "model_calls": 0, "cloud_uploads": 0, "generation_calls": 0,
              "production_approval": False, "artistic_acceptance": "not_independently_assessed",
              "review_scope": "records_and_real_sources_checked_not_independently_listened",
              "limitations": ["Qualification and observations are supplied records; the router does not hear or prove their truth.",
                  "Excerpt-parent relationships are declarations; no waveform derivation is independently verified.",
                  "Source-video hash syntax is checked; its actual file identity is the upstream preparer's responsibility.",
                  "A rejection concerns this cue and reviewed window, not the whole recording or every future use."]}
    ids = set()
    for cue in task["cues"]:
        if (not isinstance(cue, dict) or not isinstance(cue.get("cue_id"), str)
                or not cue["cue_id"].strip() or cue["cue_id"] in ids
                or not valid_range(cue.get("target_range")) or cue.get("mode") not in ("fine", "fast")
                or not isinstance(cue.get("allow_generation", False), bool)):
            raise ValueError("invalid_or_duplicate_frozen_cue")
        ids.add(cue["cue_id"])
        cue_hash = json_hash({"source_video_sha256": task.get("source_video_sha256"),
                              "task_usage_scope": task_scope, "cue": cue})
        item = {"cue_id": cue["cue_id"], "cue_sha256": cue_hash, "selected": None,
                "generation_request": None, "review_issues": []}
        output["cues"].append(item)
        query = cue.get("query")
        if (not isinstance(query, dict) or set(query) - QUERY_FIELDS
                or not isinstance(query.get("function"), str) or not query["function"].strip()
                or query["function"].casefold() in library.AMBIGUOUS_FUNCTIONS
                or NEGATIVE_QUERY.search(query["function"])):
            item.update(status="need_director_revision", reason="specific_positive_function_and_supported_filters_required")
            continue
        query = {**query, "usage_scope": query.get("usage_scope", task_scope)}
        try:
            retrieval = library.query_library(db_path, **query)
        except (ValueError, TypeError) as error:
            item.update(status="need_director_revision", reason=str(error))
            continue
        item["retrieval"] = retrieval
        bindings = [{key: c[key] for key in ("segment_id", "source_sha256", "source_range")}
                    for c in retrieval["candidates"]]
        query_hash = json_hash({"cue_sha256": cue_hash, "database_sha256": db_hash,
                                "query": query, "candidates": bindings})
        item["query_sha256"] = query_hash
        if any(gap in DIRECTOR_GAPS for gap in retrieval.get("gaps", [])):
            item.update(status="need_director_revision", reason=retrieval["gaps"][0])
            continue
        if not retrieval["candidates"]:
            item.update(gap_route(cue, cue.get("required_sound") if cue["mode"] == "fine" and cue.get("allow_generation") is True
                                  else query["function"]))
            continue
        current_reviews = [r for r in reviews["reviews"] if r.get("cue_id") == cue["cue_id"]]
        known = {c["segment_id"] for c in retrieval["candidates"]}
        for review in current_reviews:
            if review.get("segment_id") not in known:
                item["review_issues"].append({"segment_id": review.get("segment_id"), "reason": "candidate_not_in_current_retrieval"})
        checked, selected, missing = [], [], []
        for candidate in retrieval["candidates"]:
            matched = [r for r in current_reviews if r.get("segment_id") == candidate["segment_id"]]
            candidate["routing_status"] = "awaiting_audition"
            if not matched:
                checked.append("pending")
                continue
            try:
                if len(matched) != 1:
                    raise ValueError("conflicting_or_duplicate_candidate_reviews")
                verdict, selection = review_candidate(matched[0], candidate, cue, cue_hash, query_hash)
                candidate["routing_status"] = verdict
                checked.append(verdict)
                if verdict == "selected":
                    selected.append(selection)
                if verdict == "rejected" and isinstance(matched[0].get("missing_sound_type"), str) and matched[0]["missing_sound_type"].strip():
                    missing.append(matched[0]["missing_sound_type"])
            except (ValueError, OSError, KeyError, IndexError, subprocess.SubprocessError) as error:
                checked.append("pending")
                item["review_issues"].append({"segment_id": candidate["segment_id"], "reason": str(error)})
        if len(selected) == 1 and not item["review_issues"]:
            item.update(status="ready_for_edit", selected=selected[0])
        elif len(selected) > 1:
            item.update(status="need_director_revision", reason="multiple_selected_candidates")
        elif checked and all(state == "rejected" for state in checked) and not item["review_issues"]:
            item.update(status="need_retrieval_expansion",
                        missing_sound_type="; ".join(dict.fromkeys(missing)) if missing else None,
                        reason="rejected_shortlist_is_not_library_exhaustion",
                        next_action="expand_or_change_positive_query_and_retrieve_again")
        else:
            item["status"] = "awaiting_audition"
    if library.digest_file(db_path) != db_hash:
        raise ValueError("database_changed_during_routing_retry_current_snapshot")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", type=Path)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--reviews", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    task = json.loads(args.task.read_text(encoding="utf-8-sig"))
    reviews = json.loads(args.reviews.read_text(encoding="utf-8-sig")) if args.reviews else None
    result = route_music_cues(task, args.db, reviews)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({"report": str(args.out.resolve()), "statuses": [c["status"] for c in result["cues"]]}))


if __name__ == "__main__":
    main()
