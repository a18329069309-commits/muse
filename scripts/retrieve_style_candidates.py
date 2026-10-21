"""Retrieve pending style branches from one library; never select or generate audio.

Director cues require function, target_range, mode, and expert_ids. Optional
per-cue source_tag_queries override generic expert tags; neither is listening.
phase_goal is a desired development state, not a verified database filter.
Each branch returns frozen task and route hashes for route_music_cues.py.
"""
import argparse
import json
from pathlib import Path

import route_music_cues as router


def retrieve_style_candidates(director, registry, db_path, limit=5):
    if (not isinstance(director, dict) or director.get("schema_version") != 1
            or not isinstance(director.get("cues"), list) or not director["cues"]):
        raise ValueError("director_document_with_cues_required")
    if (not isinstance(registry, dict) or registry.get("schema_version") != 1
            or not isinstance(registry.get("experts"), list)):
        raise ValueError("style_expert_registry_required")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit_must_be_integer_from_1_to_100")
    experts = {}
    for expert in registry["experts"]:
        if (not isinstance(expert, dict) or not isinstance(expert.get("id"), str)
                or not expert["id"].strip() or expert["id"] in experts
                or not isinstance(expert.get("source_tag_queries"), list)
                or not expert["source_tag_queries"]
                or any(not isinstance(q, str) or not q.strip() for q in expert["source_tag_queries"])):
            raise ValueError("unique_expert_and_positive_source_tag_queries_required")
        experts[expert["id"]] = expert
    result = {"schema_version": 1, "director_sha256": router.json_hash(director),
              "registry_sha256": router.json_hash(registry), "branches": [], "cues": [],
              "production_approval": False, "artistic_acceptance": "not_assessed",
              "model_calls": 0, "generation_calls": 0, "cloud_uploads": 0,
              "pool_scope": "diverse_pending_shortlist_not_automatic_music_selection"}
    ids = set()
    database_sha256 = router.library.digest_file(db_path)
    for cue in router.expand_music_cues(director):
        if (not isinstance(cue, dict) or not isinstance(cue.get("cue_id"), str)
                or not cue["cue_id"].strip() or cue["cue_id"] in ids
                or not router.valid_range(cue.get("target_range"))
                or cue.get("mode") not in ("fine", "fast")
                or not isinstance(cue.get("function"), str) or not cue["function"].strip()
                or not isinstance(cue.get("expert_ids"), list) or not cue["expert_ids"]
                or any(not isinstance(e, str) or e not in experts for e in cue["expert_ids"])
                or len(set(cue["expert_ids"])) != len(cue["expert_ids"])):
            raise ValueError("unique_director_cue_with_known_experts_required")
        ids.add(cue["cue_id"])
        filters = cue.get("filters", {})
        fixed = {"function", "text", "limit", "asset_kind", "min_duration", "usage_scope",
                 "discover_unknown_functions", "expand_functions", "phase"}
        if not isinstance(filters, dict) or set(filters) - (router.QUERY_FIELDS - fixed):
            raise ValueError("supported_explicit_filters_required_phase_is_goal_not_filter")
        if "words_candidate_request" in cue and cue["words_candidate_request"] not in ("explore", "require"):
            raise ValueError("words_candidate_request_must_be_explore_or_require")
        words_target = cue.get("words_target_range", cue["target_range"])
        if (not router.valid_range(words_target)
                or words_target[0] < cue["target_range"][0]
                or words_target[1] > cue["target_range"][1]):
            raise ValueError("words_target_range_must_be_valid_subrange_of_cue")
        cue_queries = cue.get("source_tag_queries")
        if "source_tag_queries" in cue:
            if (not isinstance(cue_queries, list) or not 1 <= len(cue_queries) <= 3
                    or any(not isinstance(q, str) or not q.strip() or len(q) > 160
                           or router.NEGATIVE_QUERY.search(q) or not router.library.terms(q)
                           for q in cue_queries)):
                raise ValueError("cue_source_tag_queries_require_one_to_three_short_positive_queries")
            cue_queries = [q.strip() for q in cue_queries]
        query_origin = "cue_specific_source_tags" if cue_queries is not None else "generic_expert_query_only"
        group = []
        for expert_id in cue["expert_ids"]:
            expert = experts[expert_id]
            for index, text in enumerate(cue_queries if cue_queries is not None else expert["source_tag_queries"]):
                branch_id = f"{cue['cue_id']}/{expert_id}/{index + 1}"
                query = {**filters, "function": cue["function"], "text": text, "limit": limit,
                         "asset_kind": "music", "discover_unknown_functions": True,
                         "min_duration": cue["target_range"][1] - cue["target_range"][0]}
                frozen_cue = {k: v for k, v in cue.items() if k not in ("function", "expert_ids", "filters")}
                frozen_cue.update(query=query, style_expert_id=expert_id,
                                  style_expert_sha256=router.json_hash(expert),
                                  source_tag_query_origin=query_origin)
                if cue["mode"] == "fast":
                    frozen_cue["allow_generation"] = False
                task = {"schema_version": 1, "source_video_sha256": director.get("source_video_sha256"),
                        "usage_scope": director.get("usage_scope", "production_commercial"),
                        "cues": [frozen_cue]}
                if "director_brief_sha256" in director:
                    task["director_brief_sha256"] = director["director_brief_sha256"]
                routed = router.route_music_cues(task, db_path)
                if routed["database_sha256"] != database_sha256:
                    raise ValueError("database_changed_during_style_retrieval")
                branch = {"branch_id": branch_id, "parent_cue_id": cue["cue_id"],
                          "expert_id": expert_id, "source_tag_query": text,
                          "query_origin": query_origin,
                          "clap_descriptors": expert.get("retrieval_descriptors", []),
                          "frozen_task": task, "route": routed}
                result["branches"].append(branch)
                group.append(branch)
        pool, suppressed, seen_hashes, seen_families = [], [], {}, {}
        lists = [(b, b["route"]["cues"][0].get("retrieval", {}).get("candidates", [])) for b in group]
        for rank in range(max((len(c) for _, c in lists), default=0)):
            for branch, candidates in lists:
                if rank >= len(candidates):
                    continue
                candidate = candidates[rank]
                family = candidate["family_id"] or candidate["asset_id"]
                duplicate = seen_hashes.get(candidate["source_sha256"]) or seen_families.get(family)
                if duplicate is not None:
                    suppressed.append({"branch_id": branch["branch_id"], "segment_id": candidate["segment_id"],
                                       "representative_segment_id": duplicate,
                                       "reason": "same_recording_or_work_family_in_display_pool"})
                    continue
                seen_hashes[candidate["source_sha256"]] = candidate["segment_id"]
                seen_families[family] = candidate["segment_id"]
                pool.append({**candidate, "branch_id": branch["branch_id"],
                             "routing_status": "awaiting_audition", "selected": False})
        cue_result = {"cue_id": cue["cue_id"], "target_range": cue["target_range"],
                      "function": cue["function"], "phase_goal": cue.get("phase_goal"),
                      "query_origin": query_origin,
                      "candidate_pool": pool[:limit], "distinct_family_candidates": len(pool),
                      "display_deduplication": suppressed,
                      "branch_statuses": [b["route"]["cues"][0]["status"] for b in group],
                      "status": "awaiting_audition" if pool else "no_candidate_see_branch_gaps"}
        if "words_candidate_request" in cue and cue.get("music_role") != "words_candidate":
            # Separate discovery cannot satisfy the router's story-function/listening contract.
            query = {**filters, "function": None,
                     "text": " ".join(dict.fromkeys(b["source_tag_query"] for b in group)),
                     "limit": min(limit, 5), "asset_kind": "music", "vocals": "sung",
                     "min_duration": words_target[1] - words_target[0],
                     "usage_scope": director.get("usage_scope", "production_commercial")}
            blocked = "need_director_revision" in cue_result["branch_statuses"]
            retrieval = ({"candidates": [], "gaps": ["story_task_requires_revision"]} if blocked
                         else router.library.query_library(db_path, **query))
            songs = [{**c, "listening_status": "pending", "routing_status": "awaiting_audition",
                      "words_content_status": "not_verified", "selected": False}
                     for c in retrieval["candidates"]]
            gaps = list(retrieval["gaps"])
            if not blocked and not songs and cue["words_candidate_request"] == "require":
                gaps.append("required_sung_candidate_missing")
            bindings = [{key: c[key] for key in ("segment_id", "source_sha256", "source_range")}
                        for c in songs]
            cue_result["words_candidate_retrieval"] = {
                "request": cue["words_candidate_request"], "cue_id": cue["cue_id"],
                "target_range": words_target, "parent_target_range": cue["target_range"],
                "original_function": cue["function"],
                "source_video_sha256": director.get("source_video_sha256"),
                "director_sha256": result["director_sha256"], "database_sha256": database_sha256,
                "fallback_reason": "explicit_words_request_song_function_labels_may_not_cover_story_task",
                "query": query, "query_sha256": router.json_hash({
                    "director_sha256": result["director_sha256"], "cue_id": cue["cue_id"],
                    "database_sha256": database_sha256, "target_range": words_target,
                    "parent_target_range": cue["target_range"], "query": query, "candidates": bindings}),
                "candidate_pool": songs, "gaps": gaps, "generation_request": None,
                "status": "need_director_revision" if blocked else
                    "awaiting_words_audition" if songs else "words_candidate_gap",
                "pool_scope": "pending_song_discovery_not_route_or_selected"}
        result["cues"].append(cue_result)
        if cue.get("music_role") == "words_candidate":
            cue_result.update(music_role="words_candidate", parent_cue_id=cue["parent_cue_id"],
                              parent_target_range=cue["parent_target_range"], words_mode=cue["words_mode"])
    if router.library.digest_file(db_path) != database_sha256:
        raise ValueError("database_changed_during_style_retrieval")
    result["database_sha256"] = database_sha256
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("director", type=Path)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    director = json.loads(args.director.read_text(encoding="utf-8-sig"))
    registry = json.loads(args.registry.read_text(encoding="utf-8-sig"))
    result = retrieve_style_candidates(director, registry, args.db, args.limit)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({"out": str(args.out.resolve()), "branches": len(result["branches"]),
                      "cue_statuses": [c["status"] for c in result["cues"]], "production_approval": False}))


if __name__ == "__main__":
    main()
