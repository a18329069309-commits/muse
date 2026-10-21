"""Bounded MMR ordering of frozen, already-eligible CLAP windows; no inference.

Algorithm: query relevance minus maximum similarity to selected vectors, as in
https://qdrant.tech/documentation/search/search-relevance/ and LangChain's
maximal_marginal_relevance. This implementation adds bounded history hints and
an initial verified-family comparison prefix; neither grants material approval.
"""
import hashlib
import json
import math
import re
import numpy as np

REVISION = 'positive-relevance-family-mmr-v1'
POLICY_FIELDS = {'revision', 'relevance_weight', 'minimum_similarity', 'history_penalty_weight',
                 'history_penalty_cap', 'preference_penalty_weight', 'distinct_family_prefix'}


def validate_policy(value):
    if not isinstance(value, dict) or set(value) - POLICY_FIELDS or value.get('revision') != REVISION:
        raise ValueError('Independent MMR explicit policy required')
    policy = dict(relevance_weight=0.85, minimum_similarity=0, history_penalty_weight=0.02,
                  history_penalty_cap=0.06, preference_penalty_weight=0.005, distinct_family_prefix=2)
    policy.update(value)
    for key in POLICY_FIELDS - {'revision', 'distinct_family_prefix'}:
        if type(policy[key]) not in (int, float) or not math.isfinite(policy[key]):
            raise ValueError('Independent MMR finite policy values required')
    if not 0.5 <= policy['relevance_weight'] <= 1 or not 0 <= policy['minimum_similarity'] < 1 \
            or not 0 <= policy['history_penalty_weight'] <= 0.1 or not 0 <= policy['history_penalty_cap'] <= 0.1 \
            or not 0 <= policy['preference_penalty_weight'] <= 0.02 \
            or type(policy['distinct_family_prefix']) is not int or not 1 <= policy['distinct_family_prefix'] <= 5:
        raise ValueError('Independent MMR policy bounds invalid')
    return policy


def scope_digest(scope):
    return hashlib.sha256(json.dumps(scope, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def validate_scope(scope, windows, verified_families):
    if not isinstance(scope, list):
        raise ValueError('Independent MMR exact bound scope required')
    result = {}
    for item in scope:
        if not isinstance(item, dict) or item.get('segment_id') in result:
            raise ValueError('Independent MMR duplicate or invalid scope row')
        window = windows.get(item.get('segment_id'))
        if not window or any(item.get(key) != window.get(key) for key in
                             ('asset_id', 'source_sha256', 'source_range', 'vector_sha256')):
            raise ValueError('Independent MMR scope window identity changed')
        family = verified_families.get(item['segment_id'])
        key = 'family:' + family if family else 'recording:' + window['source_sha256']
        if item.get('family_id') != family or item.get('diversity_key') != key \
                or type(item.get('usage_count')) is not int or item['usage_count'] < 0 \
                or item['usage_count'] > 1_000_000 or type(item.get('preference')) is not int \
                or item['preference'] not in (0, 1):
            raise ValueError('Independent MMR scope family/history changed or invalid')
        if not re.fullmatch('[a-f0-9]{64}', item['source_sha256']) \
                or not re.fullmatch('[a-f0-9]{64}', item['vector_sha256']):
            raise ValueError('Independent MMR hash invalid')
        result[item['segment_id']] = item
    return result


def rerank(candidates, vectors_by_segment, scope, policy, limit):
    policy = validate_policy(policy)
    if type(limit) is not int or not 1 <= limit <= 50 or len(candidates) > limit:
        raise ValueError('Independent MMR preserves bounded 20/50 recall')
    admitted, seen, rejected = [], set(), []
    for rank, candidate in enumerate(candidates):
        sid = candidate.get('segment_id')
        row = scope.get(sid)
        if not row or sid in seen or any(candidate.get(key) != row[key] for key in
                                        ('asset_id', 'source_sha256', 'source_range')):
            raise ValueError('Independent MMR candidate outside bound eligible scope')
        seen.add(sid)
        score = candidate.get('similarity')
        if type(score) not in (int, float) or not math.isfinite(score) or not -1.00001 <= score <= 1.00001:
            raise ValueError('Independent MMR finite cosine required')
        vector = np.asarray(vectors_by_segment.get(sid), dtype=np.float32)
        if vector.shape != (512,) or not np.isfinite(vector).all() \
                or not np.isclose(np.linalg.norm(vector), 1, atol=1e-5) \
                or hashlib.sha256(vector.tobytes()).hexdigest() != row['vector_sha256']:
            raise ValueError('Independent MMR frozen vector identity invalid')
        if score <= policy['minimum_similarity']:
            rejected.append(dict(segment_id=sid, reason='nonpositive_or_below_configured_relevance', similarity=score))
            continue
        history = min(policy['history_penalty_cap'], policy['history_penalty_weight'] * math.log1p(row['usage_count']))
        preference = policy['preference_penalty_weight'] * row['preference']
        admitted.append(dict(candidate=candidate, scope=row, vector=vector, original_rank=rank + 1,
                             history_penalty=history, preference_penalty=preference))
    selected, keys = [], set()
    while admitted:
        fresh = [row for row in admitted if row['scope']['diversity_key'] not in keys]
        pool = fresh if len(keys) < policy['distinct_family_prefix'] and fresh else admitted
        scored = []
        for row in pool:
            redundancy = max((float(np.dot(row['vector'], old['vector'])) for old in selected), default=0)
            value = policy['relevance_weight'] * row['candidate']['similarity'] \
                - (1 - policy['relevance_weight']) * max(0, redundancy) \
                - row['history_penalty'] - row['preference_penalty']
            scored.append((value, -row['original_rank'], row, redundancy))
        value, _, chosen, redundancy = max(scored, key=lambda row: row[:2])
        chosen['mmr_score'], chosen['redundancy'] = value, redundancy
        selected.append(chosen); keys.add(chosen['scope']['diversity_key'])
        admitted = [row for row in admitted if row is not chosen]
    hits = []
    for row in selected:
        hits.append({**row['candidate'], 'family_id': row['scope']['family_id'], 'ranking_evidence': dict(revision=REVISION,
            original_relevance_rank=row['original_rank'], mmr_score=row['mmr_score'],
            maximum_selected_vector_similarity=row['redundancy'], history_penalty=row['history_penalty'],
            preference_penalty=row['preference_penalty'], usage_count=row['scope']['usage_count'],
            diversity_key=row['scope']['diversity_key'], ranking_only=True, qualification_granted=False)})
    return hits, dict(revision=REVISION, policy=policy, input_candidates=len(candidates),
                     ranked_candidates=len(hits), rejected_relevance=rejected,
                     comparison_prefix_distinct_families=len({r['scope']['diversity_key'] for r in selected[:policy['distinct_family_prefix']]}),
                     preserved_same_recording_windows=True, history_is_bounded_soft_hint=True,
                     no_audio_forward=True, qualification_granted=False)
