"""Prepare exact library candidates for a current task; never select or relabel.

Function observations are independently supplied, preparation-bound records.
Their audio/qualification bindings are checked, not independently heard.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import subprocess

import route_music_cues as router


def materialize_music_task(director, style_result, request, db_path, function_observations=None):
    if (not isinstance(director, dict) or director.get("schema_version") != 1
            or not isinstance(director.get("cues"), list)
            or not isinstance(style_result, dict) or style_result.get("schema_version") != 1
            or not isinstance(style_result.get("cues"), list)
            or not isinstance(request, dict) or request.get("schema_version") != 1
            or not isinstance(request.get("candidates"), list) or not request["candidates"]
            or any(not isinstance(c, dict) for c in request["candidates"])):
        raise ValueError("current_director_style_and_candidate_request_required")
    director_hash = router.json_hash(director)
    db_hash = router.library.digest_file(db_path)
    if style_result.get("director_sha256") != director_hash:
        raise ValueError("stale_style_director_binding")
    if style_result.get("database_sha256") != db_hash:
        raise ValueError("stale_style_database_binding")
    for key in ("source_video_sha256", "director_brief_sha256"):
        if not isinstance(director.get(key), str) or not re.fullmatch(r"[a-fA-F0-9]{64}", director[key]):
            raise ValueError(f"{key}_required_for_formal_task")
    cues = [c for c in router.expand_music_cues(director) if c.get("cue_id") == request.get("cue_id")]
    pools = [c for c in style_result["cues"] if c.get("cue_id") == request.get("cue_id")]
    if len(cues) != 1 or len(pools) != 1:
        raise ValueError("one_current_director_and_style_cue_required")
    cue, pool = cues[0], pools[0]
    function = cue.get("function")
    if (not isinstance(function, str) or not function.strip()
            or function.casefold() in router.library.AMBIGUOUS_FUNCTIONS
            or router.NEGATIVE_QUERY.search(function) or not router.valid_range(cue.get("target_range"))
            or cue.get("mode") not in ("fine", "fast")):
        raise ValueError("specific_current_story_task_required")
    if pool.get("target_range") != cue["target_range"] or pool.get("function") != function:
        raise ValueError("stale_style_cue_binding")
    candidates = list(pool.get("candidate_pool", []))
    if "words_target_range" not in cue:
        candidates += pool.get("words_candidate_retrieval", {}).get("candidate_pool", [])
    available = {c["segment_id"]: c for c in candidates}
    ids = [c.get("segment_id") for c in request["candidates"]]
    filters = cue.get("filters", {})
    if not isinstance(filters, dict) or set(filters) - (router.QUERY_FIELDS - {
            "function", "text", "limit", "asset_kind", "min_duration", "usage_scope",
            "discover_unknown_functions", "expand_functions", "phase", "candidate_segment_ids"}):
        raise ValueError("supported_director_filters_required")
    query = {**filters, "text": "", "function": function, "asset_kind": "music",
             "min_duration": cue["target_range"][1] - cue["target_range"][0],
             "usage_scope": director.get("usage_scope", "production_commercial"),
             "candidate_segment_ids": ids, "discover_unknown_functions": True, "limit": 100}
    if cue.get("music_role") == "words_candidate":
        query.update(vocals="sung", discover_unknown_functions=True,
                     discover_unknown_vocals=filters.get("discover_unknown_vocals", True))
    elif cue.get("words_candidate_request") == "require" and "words_target_range" not in cue:
        query["vocals"] = "sung"
    # Use the same eligibility filters to check real pointers, without assigning a function.
    eligible = router.library.query_library(db_path, **{**query, "function": None, "discover_unknown_functions": False})["candidates"]
    current = {c["segment_id"]: c for c in eligible}
    prepared, checks = [], []
    for wanted in request["candidates"]:
        segment_id = wanted["segment_id"]
        if segment_id not in available or segment_id not in current:
            raise ValueError("requested_candidate_not_in_current_eligible_style_pool")
        candidate, prior = current[segment_id], available[segment_id]
        if any(candidate[k] != prior.get(k) for k in ("asset_id", "source_sha256", "source_range", "local_path")):
            raise ValueError("stale_style_candidate_pointer")
        source_range = wanted.get("source_range")
        if (not router.valid_range(source_range) or source_range[0] < candidate["source_range"][0]
                or source_range[1] > candidate["source_range"][1]
                or source_range[1] - source_range[0] + .001 < query["min_duration"]):
            raise ValueError("requested_source_range_invalid_or_too_short")
        source = router.verified_file({"path": candidate["local_path"], "sha256": candidate["source_sha256"]})
        duration, _, _ = router.library.probe_file(source)
        router.verified_file({"path": str(source), "sha256": candidate["source_sha256"]})
        if source_range[1] > duration + .001:
            raise ValueError("requested_source_range_out_of_actual_audio")
        prepared.append({"segment_id": segment_id, "asset_id": candidate["asset_id"],
                         "source_sha256": candidate["source_sha256"], "local_path": str(source),
                         "candidate_source_range": candidate["source_range"], "source_range": source_range})
        checks.append({"segment_id": segment_id, "indexed_functions": candidate["record"].get("narrative_functions", []),
                       "actual_source_duration": duration, "actual_source_sha256_checked": True,
                       "function_observation_checked": False})
    frozen_cue = {k: copy.deepcopy(v) for k, v in cue.items() if k not in ("expert_ids", "filters")}
    frozen_cue.update(query=query, requested_candidates=prepared, director_cue_sha256=router.json_hash(cue))
    if cue["mode"] == "fast":
        frozen_cue["allow_generation"] = False
    bindings = {"director_sha256": director_hash, "style_result_sha256": router.json_hash(style_result),
                "database_sha256": db_hash, "candidate_request_sha256": router.json_hash(request)}
    task = {"schema_version": 1, "source_video_sha256": director["source_video_sha256"],
            "director_brief_sha256": director["director_brief_sha256"], "usage_scope": query["usage_scope"],
            "cues": [frozen_cue], "materialization_provenance": bindings}
    preparation_hash = router.json_hash({"prepared_task": task, "source_checks": checks})
    observations = {}
    if function_observations is not None:
        if (not isinstance(function_observations, dict) or function_observations.get("schema_version") != 1
                or function_observations.get("preparation_sha256") != preparation_hash
                or not isinstance(function_observations.get("observations"), list)):
            raise ValueError("current_preparation_bound_function_observations_required")
        for observation in function_observations["observations"]:
            if (not isinstance(observation, dict) or observation.get("segment_id") not in current
                    or observation["segment_id"] in observations):
                raise ValueError("unique_requested_function_observations_required")
            observations[observation["segment_id"]] = observation
    issues = []
    for check, pointer in zip(checks, prepared):
        segment_id = pointer["segment_id"]
        if check["indexed_functions"] and function not in check["indexed_functions"]:
            issues.append({"segment_id": segment_id, "reason": "explicit_indexed_function_conflicts_with_current_task"})
        observation = observations.get(segment_id)
        if observation is None:
            if function not in check["indexed_functions"]:
                issues.append({"segment_id": segment_id, "reason": "current_function_not_indexed_need_function_observation"})
            issues.append({"segment_id": segment_id, "reason": "current_function_observation_missing"})
            continue
        try:
            observed_range = observation.get("source_range")
            if (observation.get("function") != function or not router.valid_range(observed_range)
                    or observed_range[0] > pointer["source_range"][0] or observed_range[1] < pointer["source_range"][1]):
                raise ValueError("observed_function_or_window_does_not_cover_request")
            # Reuse provenance checks only; this adaptation is not a formal selection review.
            router.review_candidate({**observation, "verdict": "selected", "cue_sha256": preparation_hash,
                                     "query_sha256": preparation_hash,
                                     "candidate_source_range": pointer["candidate_source_range"]},
                                    current[segment_id], {k: v for k, v in frozen_cue.items() if k != "requested_candidates"},
                                    preparation_hash, preparation_hash)
            check["function_observation_checked"] = True
        except (ValueError, OSError, KeyError, IndexError, subprocess.SubprocessError) as error:
            issues.append({"segment_id": segment_id, "reason": str(error)})
    output = {"schema_version": 1, **bindings, "preparation_sha256": preparation_hash,
              "prepared_task": task, "source_checks": checks, "issues": issues,
              "frozen_task": None, "route": None, "selected": None, "production_approval": False,
              "artistic_acceptance": "not_assessed", "model_calls": 0, "generation_calls": 0, "cloud_uploads": 0,
              "limitations": ["Function observations and qualification records are supplied declarations, not independently heard.",
                              "Formal selection needs fresh task-bound reviews within the requested source windows."]}
    if issues:
        output["status"] = "need_function_observation" if any(function not in c["indexed_functions"] for c in checks) else "needs_audition"
    else:
        task = copy.deepcopy(task)
        task["materialization_provenance"].update(preparation_sha256=preparation_hash,
                                                  function_observations_sha256=router.json_hash(function_observations),
                                                  scoped_function_observations=[{key: observation[key] for key in (
                                                      "segment_id", "source_sha256", "source_range", "function")}
                                                      for observation in observations.values()])
        routed = router.route_music_cues(task, db_path)
        actual_ids = {c["segment_id"] for c in routed["cues"][0].get("retrieval", {}).get("candidates", [])}
        if actual_ids != set(ids):
            raise ValueError("formal_query_did_not_retrieve_exact_requested_candidates")
        output.update(frozen_task=task, route=routed, status="awaiting_audition")
    if router.library.digest_file(db_path) != db_hash:
        raise ValueError("database_changed_during_materialization")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("director", type=Path)
    parser.add_argument("--style-result", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--function-observations", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text(encoding="utf-8-sig"))
    result = materialize_music_task(read(args.director), read(args.style_result), read(args.request), args.db,
                                    read(args.function_observations) if args.function_observations else None)
    args.out.mkdir(parents=True, exist_ok=False)
    documents = {"preparation.json": result}
    if result["frozen_task"] is not None:
        documents.update({"music-tasks.json": result["frozen_task"], "retrieval-route.json": result["route"]})
    for name, document in documents.items():
        (args.out / name).write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"out": str(args.out.resolve()), "status": result["status"], "production_approval": False}))


if __name__ == "__main__":
    main()
