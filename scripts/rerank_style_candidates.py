"""Rerank allowed style candidates with actual CLAP windows, without selecting.

Queries: {schema_version:1,cues:[{cue_id,audio_retrieval_query:positive_text}]}.
Encoding windows are recall clues, not full-length listening or phase evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy as np
import clap_segment_features as clap
import route_music_cues as router


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_args


@gpu_slot_guard(lambda style_route, queries, index_path, weights, limit=5, device='cpu', gpu_slot=None: device,
                lambda style_route, queries, index_path, weights, limit=5, device='cpu', gpu_slot=None: gpu_slot)
def rerank_style_candidates(style_route, queries, index_path, weights, limit=5, device="cpu", gpu_slot=None):
    if (style_route.get("schema_version") != 1 or not isinstance(style_route.get("branches"), list)
            or queries.get("schema_version") != 1 or not isinstance(queries.get("cues"), list)):
        raise ValueError("style_route_and_per_cue_queries_required")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError("limit_must_be_integer_from_1_to_20")
    query_map = {}
    for query in queries["cues"]:
        cue_id, text = query.get("cue_id"), query.get("audio_retrieval_query")
        if (not isinstance(cue_id, str) or not cue_id.strip() or cue_id in query_map
                or not isinstance(text, str) or not text.strip() or len(text) > 1000
                or re.search(r"不要|避免|不需要|不是|\b(without|not|no)\b", text, re.I)):
            raise ValueError("unique_cue_with_positive_audio_query_required")
        query_map[cue_id] = text
    branch_cues = {b["parent_cue_id"] for b in style_route["branches"]}
    for branch in style_route["branches"]:
        child = branch.get("frozen_task", {}).get("cues", [{}])[0]
        if child.get("music_role") == "words_candidate" and child["cue_id"] not in query_map:
            text = child.get("audio_retrieval_query", query_map.get(child.get("parent_cue_id")))
            if not isinstance(text, str) or not text.strip() or len(text) > 1000 or router.NEGATIVE_QUERY.search(text):
                raise ValueError("positive_words_audio_query_required")
            query_map[child["cue_id"]] = text
    if not query_map or set(query_map) != branch_cues:
        raise ValueError("queries_must_cover_exact_current_branch_cues")
    index, vectors = clap.load_index(index_path)
    index_rows = {}
    for i, record in enumerate(index["records"]):
        index_rows.setdefault((record["asset_id"], record["source_sha256"]), []).append((i, record["source_range"]))
    torch, model, tokenizer, _, binding = clap.runtime(weights, device)
    if ({k: v for k, v in binding.items() if k != "device"}
            != {k: v for k, v in index["binding"].items() if k != "device"}):
        raise ValueError("query_model_processor_does_not_match_index")
    output = {"schema_version": 1, "style_route_sha256": router.json_hash(style_route),
              "queries_sha256": router.json_hash(queries), "index_binding": index["binding"],
              "index_audio_sha256": index["audio_sha256"], "index_records_sha256": index["records_sha256"],
              "runtime_device": device, "cues": [], "production_approval": False,
              "score_type": "audio_text_cosine_not_artistic_quality_or_phase",
              "source_integrity": "encode_snapshot_reverify_selected_audio_before_use",
              "generation_calls": 0, "cloud_uploads": 0}
    for cue_id, text in query_map.items():
        with torch.inference_mode():
            query = model.get_text_features(**{k: v.to(device) for k, v in
                tokenizer([text], return_tensors="pt").items()})[0].cpu().numpy()
        hits, allowed, encoded = [], {}, set()
        for branch in (b for b in style_route["branches"] if b["parent_cue_id"] == cue_id):
            routed, task = branch["route"], branch["frozen_task"]
            if routed["task_sha256"] != router.json_hash(task) or len(routed["cues"]) != 1:
                raise ValueError("stale_or_non_single_cue_branch")
            item = routed["cues"][0]
            for candidate in item.get("retrieval", {}).get("candidates", []):
                identity = (candidate["asset_id"], candidate["source_sha256"])
                allowed[identity] = {"asset_id": identity[0], "source_sha256": identity[1]}
                parent = candidate["source_range"]
                positions = [i for i, window in index_rows.get(identity, [])
                             if parent[0] <= window[0] and window[1] <= parent[1]]
                if not positions:
                    continue
                encoded.add(identity)
                records = [index["records"][i] for i in positions]
                ranked = clap.rank_candidates(records, vectors[positions], query, len(positions))
                for window in ranked:
                    hits.append({**candidate, "branch_id": branch["branch_id"],
                                 "cue_sha256": item["cue_sha256"], "query_sha256": item["query_sha256"],
                                 "encoded_window": window, "similarity": window["similarity"],
                                 "selected": False, "decision": "unknown", "listening_status": "pending",
                                 "routing_status": "awaiting_audition", "full_range_listening_status": "not_assessed"})
        hits.sort(key=lambda x: -x["similarity"])
        pool, seen_hashes, seen_families = [], set(), set()
        for hit in hits:
            family = hit["family_id"] or hit["asset_id"]
            if hit["source_sha256"] in seen_hashes or family in seen_families:
                continue
            seen_hashes.add(hit["source_sha256"])
            seen_families.add(family)
            pool.append(hit)
            if len(pool) == limit:
                break
        unencoded = [allowed[key] for key in sorted(set(allowed) - encoded)]
        output["cues"].append({"cue_id": cue_id, "audio_retrieval_query": text,
                              "audio_query_sha256": router.json_hash({"cue_id": cue_id, "text": text}),
                              "candidate_pool": pool, "allowed_asset_count": len(allowed),
                              "encoded_allowed_asset_count": len(encoded),
                              "unencoded_allowed_asset_count": len(unencoded),
                              "unencoded_allowed_assets": unencoded,
                              "unencoded_reason": "no_current_identity_window_inside_allowed_candidate_range",
                              "status": "awaiting_audition" if pool else "no_encoded_allowed_candidates"})
        frozen = next(b["frozen_task"]["cues"][0] for b in style_route["branches"] if b["parent_cue_id"] == cue_id)
        if frozen.get("music_role") == "words_candidate":
            output["cues"][-1].update({key: frozen[key] for key in (
                "music_role", "parent_cue_id", "parent_target_range", "words_mode", "target_range")})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("style_route", type=Path)
    parser.add_argument("--queries", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    add_slot_arguments(parser)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    files = {"style_route": (args.style_route, args.style_route.read_bytes()),
             "queries": (args.queries, args.queries.read_bytes())}
    style_route, queries = [json.loads(files[k][1].decode("utf-8-sig")) for k in ("style_route", "queries")]
    result = rerank_style_candidates(style_route, queries, args.index, args.weights, args.limit, args.device,
                                     gpu_slot=slot_binding_from_args(args))
    result["input_files"] = {k: {"path": str(p.resolve()), "sha256": hashlib.sha256(raw).hexdigest()}
                             for k, (p, raw) in files.items()}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({"out": str(args.out.resolve()), "cues": len(result["cues"]), "production_approval": False}))


if __name__ == "__main__":
    main()
