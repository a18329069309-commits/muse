"""Bind actual music observations to current story tasks; never select or submit.

The input observations are model predictions, not music-candidate qualifications.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re

import numpy as np
import soundfile as sf

import route_music_cues as router


def read_file(path, require_schema=True):
    path = Path(path).resolve(strict=True)
    raw = path.read_bytes()
    document = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(document, dict) or require_schema and document.get("schema_version") != 1:
        raise ValueError("schema_version_1_document_required")
    return document, {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest()}


def check_binding(binding, actual, reason):
    if (not isinstance(binding, dict) or binding.get("sha256") != actual["sha256"]
            or Path(binding.get("path", "")).resolve() != Path(actual["path"])):
        raise ValueError(reason)


def unique_rows(rows, key, reason):
    if not isinstance(rows, list) or any(not isinstance(row, dict)
            or not isinstance(row.get(key), str) or not row[key].strip() for row in rows):
        raise ValueError(reason)
    result = {row[key]: row for row in rows}
    if len(result) != len(rows):
        raise ValueError(reason)
    return result


def uncovered(parent, windows):
    """Return the exact source intervals that were not observed."""
    cursor, gaps = parent[0], []
    for start, end in sorted(windows):
        if start > cursor:
            gaps.append([cursor, start])
        cursor = max(cursor, end)
    if cursor < parent[1]:
        gaps.append([cursor, parent[1]])
    return gaps


def prepare_music_audition(director_path, brief_path, candidates_path, jobs_path,
                           observations_path, output_path=None):
    files = {name: read_file(path, require_schema=name != "brief") for name, path in (
        ("director", director_path), ("brief", brief_path), ("candidates", candidates_path),
        ("jobs", jobs_path), ("observations", observations_path))}
    director, brief, ranked, jobs, observed = [files[name][0] for name in files]
    bindings = {name: value[1] for name, value in files.items()}
    if (not re.fullmatch(r"[0-9a-f]{64}", str(director.get("source_video_sha256")))
            or brief.get("source_video_sha256") != director["source_video_sha256"]
            or director.get("director_brief_sha256") != bindings["brief"]["sha256"]
            or not isinstance(brief.get("story_beats"), list) or not brief["story_beats"]):
        raise ValueError("current_video_and_director_brief_binding_required")
    route_binding = ranked.get("input_files", {}).get("style_route")
    route_path = router.verified_file(route_binding)
    route, _ = read_file(route_path)
    if (route.get("director_sha256") != router.json_hash(director)
            or ranked.get("style_route_sha256") != router.json_hash(route)):
        raise ValueError("current_style_director_and_route_required")
    branches = unique_rows(route.get("branches"), "branch_id", "unique_current_style_branches_required")
    check_binding(jobs.get("input_file"), bindings["candidates"], "jobs_candidate_file_binding_mismatch")
    check_binding(observed.get("jobs_file"), bindings["jobs"], "observation_jobs_file_binding_mismatch")
    if (not isinstance(observed.get("binding"), dict) or not observed["binding"]
            or not re.fullmatch(r"[0-9a-f]{64}", str(observed.get("prompt_sha256")))):
        raise ValueError("actual_observer_binding_and_prompt_required")
    cue_map = unique_rows(router.expand_music_cues(director), "cue_id", "unique_director_cues_required")
    pools = unique_rows(ranked.get("cues"), "cue_id", "unique_candidate_cues_required")
    mappings = unique_rows(jobs.get("cues"), "cue_id", "unique_window_cues_required")
    if not cue_map or set(cue_map) != set(pools) or set(cue_map) != set(mappings):
        raise ValueError("exact_current_cues_required")
    actual_jobs = unique_rows(jobs.get("jobs"), "segment_id", "unique_actual_jobs_required")
    records = unique_rows(observed.get("records"), "segment_id", "unique_observation_records_required")
    if not set(records).issubset(actual_jobs):
        raise ValueError("observation_not_in_current_jobs")
    sources = {}
    for job in actual_jobs.values():
        window = job.get("source_range")
        if not router.valid_range(window) or window[1] - window[0] > 30:
            raise ValueError("bounded_actual_observation_window_required")
        identity = (job.get("path"), job.get("source_sha256"))
        if identity not in sources:
            source = router.verified_file({"path": identity[0], "sha256": identity[1]})
            duration, _, _ = router.library.probe_file(source)
            router.verified_file({"path": str(source), "sha256": identity[1]})
            sources[identity] = (str(source), duration)
        if window[1] > sources[identity][1] + 1 / 16000:
            raise ValueError("observation_window_out_of_actual_source")
        if job["segment_id"] not in records:
            continue
        record = records[job["segment_id"]]
        if (record.get("asset_id") != job.get("asset_id")
                or record.get("source_sha256") != job.get("source_sha256")
                or record.get("source_range") != window
                or Path(record.get("source_path", "")).resolve() != Path(sources[identity][0])):
            raise ValueError("observation_source_identity_or_window_mismatch")
        execution, signal = record.get("execution", {}), record.get("signal", {})
        backend_kind = execution.get("backend_kind", "local")
        if (backend_kind not in ("local", "api") or execution.get("actual_audio_processed") is not True
                or record.get("qualified") is not False or record.get("scopes") != []
                or record.get("selected") is not False or record.get("artistic_approval") is not False):
            raise ValueError("actual_unqualified_observation_required")
        if record.get("completion_status") not in ("complete", "incomplete"):
            raise ValueError("observation_completion_status_required")
        stop = record.get("generation_termination", {})
        if backend_kind == "local" and any(isinstance(execution.get(key), bool)
                or not isinstance(execution.get(key), int) or execution[key] < 1
                for key in ("encoder_forward_count", "head_forward_count")):
            raise ValueError("actual_unqualified_observation_required")
        if backend_kind == "local" and (any(type(stop.get(key)) is not bool for key in (
                "last_token_is_configured_eos", "max_tokens_reached", "max_time_threshold_reached"))
                or record["completion_status"] != ("complete" if stop["last_token_is_configured_eos"]
                   and not stop["max_tokens_reached"] and not stop["max_time_threshold_reached"] else "incomplete")
                or execution.get("processor_pcm_sha256") != record.get("pcm_sha256")):
            raise ValueError("observation_completion_or_processor_pcm_mismatch")
        if backend_kind == "api":
            audit_path = router.verified_file(record.get("api_evidence"))
            audit, _ = read_file(audit_path)
            finish = audit.get("finish_reason")
            if (any(key in execution for key in ("encoder_forward_count", "head_forward_count", "processor_pcm_sha256"))
                    or observed["binding"].get("backend_kind") != "api"
                    or not isinstance(execution.get("model"), str) or not execution["model"].strip()
                    or execution["model"] != observed["binding"].get("model")
                    or not isinstance(execution.get("request_id"), str) or not execution["request_id"].strip()
                    or any(audit.get(key) != execution.get(key) for key in ("model", "request_id", "audio_sha256"))
                    or audit.get("source_sha256") != job["source_sha256"]
                    or audit.get("source_window") != window or execution.get("source_window") != window
                    or execution.get("audio_sha256") != record.get("input_audio", {}).get("sha256")
                    or execution.get("submitted_pcm_sha256") != record.get("pcm_sha256")
                    or finish not in ("stop", "complete", "length", "timeout", "failed")
                    or record["completion_status"] != ("complete" if finish in ("stop", "complete") else "incomplete")
                    or not re.fullmatch(r"[0-9a-f]{64}", str(audit.get("raw_response_sha256")))):
                raise ValueError("actual_api_audio_request_and_completion_binding_required")
            if "raw_response" in audit:
                router.verified_file(audit["raw_response"])
                if audit["raw_response"].get("sha256") != audit["raw_response_sha256"]:
                    raise ValueError("api_raw_response_hash_mismatch")
        if (not isinstance(record.get("raw_observation"), str) or not record["raw_observation"].strip()
                or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("pcm_sha256")))
                or record.get("sample_rate_hz") != 16000 or isinstance(record.get("samples"), bool)
                or not isinstance(record.get("samples"), int) or record["samples"] < 1
                or abs(record["samples"] - round((window[1] - window[0]) * 16000)) > 1
                or not isinstance(record.get("cache_hit"), bool)
                or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("cache_key")))
                or not isinstance(signal.get("exact_zero"), bool)
                or any(isinstance(signal.get(key), bool) or not isinstance(signal.get(key), (int, float))
                       or not math.isfinite(signal[key]) or signal[key] < 0 for key in ("peak", "rms"))
                or signal["exact_zero"] != (signal["peak"] == 0 and signal["rms"] == 0)
                or not isinstance(record.get("warnings"), list)):
            raise ValueError("actual_pcm_and_raw_observation_required")
        audio_binding = record.get("input_audio")
        actual_audio = router.verified_file(audio_binding)
        info = sf.info(actual_audio)
        pcm, rate = sf.read(actual_audio, dtype="float32")
        if (info.format != "WAV" or info.subtype != "FLOAT" or pcm.ndim != 1 or rate != 16000
                or not np.isfinite(pcm).all() or len(pcm) != record["samples"]
                or audio_binding.get("samples") != len(pcm) or audio_binding.get("sample_rate_hz") != rate
                or audio_binding.get("pcm_sha256") != record["pcm_sha256"]
                or hashlib.sha256(pcm.astype("<f4", copy=False).tobytes()).hexdigest() != record["pcm_sha256"]):
            raise ValueError("actual_input_audio_format_samples_or_pcm_mismatch")
        router.verified_file(audio_binding)
    result = {"schema_version": 1, "scope": "story_and_actual_music_observations_not_selection",
              "input_files": bindings, "source_video_sha256": director["source_video_sha256"],
              "director_brief": brief, "observer_binding": observed["binding"],
              "observation_prompt_sha256": observed["prompt_sha256"], "cues": [],
              "selected": False, "artistic_approval": False, "production_approval": False,
              "model_calls": 0, "generation_calls": 0, "cloud_uploads": 0,
              "limitations": ["Raw observations are unqualified model predictions, not selected/rejected reviews.",
                              "Identity and forward records are checked, not independently heard.",
                              "Standalone windows do not establish picture/dialogue fit or full-song knowledge."]}
    referenced = set()
    for cue_id, cue in cue_map.items():
        if not router.valid_range(cue.get("target_range")):
            raise ValueError("current_cue_target_range_required")
        pool = pools[cue_id].get("candidate_pool")
        windows = mappings[cue_id].get("candidate_windows")
        if not isinstance(pool, list) or not isinstance(windows, list):
            raise ValueError("current_candidates_and_window_mapping_required")
        for candidate in pool:
            branch = branches.get(candidate.get("branch_id"), {})
            routed = branch.get("route", {})
            route_cues = routed.get("cues", [])
            origin = route_cues[0] if len(route_cues) == 1 else {}
            originals = [row for row in origin.get("retrieval", {}).get("candidates", [])
                         if row.get("segment_id") == candidate.get("segment_id")]
            if (branch.get("parent_cue_id") != cue_id
                    or routed.get("task_sha256") != router.json_hash(branch.get("frozen_task"))
                    or len(originals) != 1
                    or any(originals[0].get(key) != candidate.get(key) for key in (
                        "asset_id", "source_sha256", "source_range", "local_path", "family_id"))
                    or candidate.get("cue_sha256") != origin.get("cue_sha256")
                    or candidate.get("query_sha256") != origin.get("query_sha256")):
                raise ValueError("candidate_not_bound_to_current_style_branch")
        packaged, seen_candidates = [], set()
        for mapping in windows:
            matches = [candidate for candidate in pool if candidate.get("asset_id") == mapping.get("asset_id")
                       and candidate.get("source_sha256") == mapping.get("source_sha256")
                       and candidate.get("source_range") == mapping.get("allowed_source_range")]
            if (len(matches) != 1 or not isinstance(matches[0].get("segment_id"), str)
                    or matches[0].get("family_id") != mapping.get("family_id")):
                raise ValueError("window_mapping_not_unique_current_candidate")
            candidate = matches[0]
            if candidate["segment_id"] in seen_candidates:
                raise ValueError("duplicate_candidate_window_mapping")
            seen_candidates.add(candidate["segment_id"])
            parent, ids = candidate["source_range"], mapping.get("job_segment_ids")
            if (not router.valid_range(parent) or not isinstance(ids, list) or not ids
                    or len(set(ids)) != len(ids) or not set(ids).issubset(actual_jobs)):
                raise ValueError("actual_candidate_job_ranges_required")
            observed_windows, observations = [], []
            for job_id in ids:
                job = actual_jobs[job_id]
                if (job.get("asset_id") != candidate["asset_id"]
                        or job.get("source_sha256") != candidate["source_sha256"]
                        or Path(job["path"]).resolve() != Path(candidate.get("local_path", "")).resolve()
                        or job["source_range"][0] < parent[0] or job["source_range"][1] > parent[1]):
                    raise ValueError("observed_job_outside_current_candidate")
                referenced.add(job_id)
                if job_id in records:
                    if records[job_id]["completion_status"] == "complete":
                        observed_windows.append(job["source_range"])
                    observations.append({"observed_job_segment_id": job_id, **records[job_id]})
            packaged.append({"candidate_segment_id": candidate["segment_id"], "asset_id": candidate["asset_id"],
                             "source_sha256": candidate["source_sha256"], "local_path": candidate["local_path"],
                             "allowed_source_range": parent, "observations": observations,
                             "unobserved_source_ranges": uncovered(parent, observed_windows), "selected": False})
        result["cues"].append({"cue_id": cue_id, "story_requirement": cue, "candidates": packaged,
                               "unexpanded_candidate_count": max(0, len(pool) - len(packaged))})
    if referenced != set(actual_jobs):
        raise ValueError("unmapped_observation_job")
    for binding in (*bindings.values(), route_binding):
        router.verified_file(binding)
    result["incomplete_observation_count"] = sum(row["completion_status"] == "incomplete" for row in records.values())
    result["missing_observation_count"] = len(actual_jobs) - len(records)
    result["status"] = ("needs_observation_repair" if result["incomplete_observation_count"] else
                        "needs_actual_music_observation" if result["missing_observation_count"] or not records else
                        "ready_for_director_comparison")
    if output_path is not None:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("director", "brief", "candidates", "jobs", "observations", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    result = prepare_music_audition(args.director, args.brief, args.candidates, args.jobs, args.observations, args.out)
    print(json.dumps({"out": str(args.out.resolve()), "status": result["status"],
                      "cues": len(result["cues"]), "selected": False}))


if __name__ == "__main__":
    main()
