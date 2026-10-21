"""Resident CPU CLAP text retrieval scoped to exact frozen independent windows."""
import argparse
import json
import os
from pathlib import Path
import sys

from build_independent_clap_index import checked_json
from clap_segment_features import ResidentRetriever, digest
from independent_pack_mmr import validate_policy, validate_scope, scope_digest, rerank


class IndependentPackRetriever:
    def __init__(self, snapshot, snapshot_sha256, weights):
        self.snapshot = checked_json({'path': snapshot, 'sha256': snapshot_sha256})
        self.snapshot_sha256 = snapshot_sha256
        if self.snapshot['kind'] != 'independent_resident_clap_snapshot':
            raise ValueError('Invalid independent vector snapshot kind')
        checked_json(self.snapshot['index'])
        mapping = checked_json(self.snapshot['mapping'])
        self.publication = checked_json(self.snapshot['music_publication'])
        if digest(self.snapshot['audio']['path']) != self.snapshot['audio']['sha256']:
            raise ValueError('Frozen audio vectors mismatch')
        if mapping['publication'] != self.snapshot['music_publication']:
            raise ValueError('Mapping publication differs from vector snapshot')
        self.resident = ResidentRetriever(Path(self.snapshot['index']['path']).parent, weights, 'cpu')
        self.windows = {window['segment_id']: window for window in mapping['records']}
        self.verified_families = None
        if len(self.windows) != len(mapping['records']) or set(self.windows) != {row['segment_id'] for row in self.resident.records}:
            raise ValueError('Independent window map is incomplete')
        for row in self.resident.records:
            window = self.windows[row['segment_id']]
            if row['asset_id'] != window['asset_id'] or row['source_sha256'] != window['source_sha256'] or \
                    row['source_range'] != window['representative_source_range'] or row['vector_sha256'] != window['vector_sha256']:
                raise ValueError('Independent vector/window binding mismatch')

    def verified_family_scope(self):
        if self.verified_families is not None:
            return self.verified_families
        published = self.publication.get('windows')
        if published is None:
            published = [window for pack in self.publication.get('packs', []) for window in pack.get('windows', [])]
        recordings = {row['asset_id']: row for pack in self.publication.get('packs', []) for row in pack.get('recordings', [])}
        families = {}
        for window in published:
            window = {**recordings.get(window['asset_id'], {}), **window}
            identity = window.get('family_identity') or {}
            family = None
            if identity.get('status') == 'verified':
                if not isinstance(identity.get('family_id'), str) or not identity['family_id'].strip() \
                        or not isinstance(identity.get('evidence'), list) or not identity['evidence']:
                    raise ValueError('Independent verified family membership required')
                for binding in identity['evidence']:
                    proof = checked_json(binding)
                    if proof.get('kind') != 'verified_recording_family_membership' or proof.get('status') != 'verified' \
                            or proof.get('family_id') != identity['family_id'] \
                            or proof.get('recording_sha256') != window['source_sha256'] \
                            or not isinstance(proof.get('basis'), str) or not proof['basis'].strip():
                        raise ValueError('Independent verified family identity changed')
                family = identity['family_id']
            families[window['segment_id']] = family
        self.verified_families = families
        return families

    def search(self, request):
        allowed = request.get('allowed_segment_ids')
        if not isinstance(allowed, list) or any(not isinstance(value, str) or value not in self.windows for value in allowed):
            raise ValueError('Explicit exact eligible window IDs are required')
        if request.get('preserve_source_windows') is not True:
            raise ValueError('Independent recall must preserve source windows')
        policy = None
        if 'ranking_policy' in request:
            policy = validate_policy(request['ranking_policy'])
            scope = validate_scope(request.get('candidate_scope'), self.windows, self.verified_family_scope())
            if set(scope) != set(allowed) or request.get('candidate_scope_sha256') != scope_digest(request['candidate_scope']):
                raise ValueError('Independent ranking scope binding changed')
        result = self.resident.search(request['text'], request.get('limit', 20), None, True, allowed)
        for hit in result['candidates']:
            window = self.windows[hit['segment_id']]
            if hit['source_range'] != window['representative_source_range']:
                raise ValueError('Returned representative range changed')
            hit.update(semantic_evidence_range=hit['source_range'], source_range=window['source_range'],
                       semantic_vector_sha256=window['vector_sha256'], whole_window_encoded=False)
        if policy:
            vectors = {row['segment_id']: vector for row, vector in zip(self.resident.records, self.resident.vectors)}
            result['candidates'], result['ranking'] = rerank(result['candidates'], vectors, scope, policy, request.get('limit', 20))
            result['candidate_scope_sha256'] = request['candidate_scope_sha256']
        result.update(scope_filtered_before_limit=True, eligible_windows=len(set(allowed)),
                      encoded_representative_max_seconds=10, text_device='cpu', artistic_approval=False)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--snapshot-sha256', required=True)
    parser.add_argument('--weights', required=True)
    args = parser.parse_args()
    retriever = IndependentPackRetriever(args.snapshot, args.snapshot_sha256, args.weights)
    print(json.dumps({'status': 'ready', 'snapshot_sha256': args.snapshot_sha256, 'text_device': 'cpu',
        'process_id': os.getpid(),
        'encoded_windows': len(retriever.windows), 'encoded_unique_sources': retriever.resident.encoded_unique_sources,
        'artistic_approval': False}), flush=True)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('JSON object request required')
            result = retriever.search(request)
            result['request_id'] = request.get('request_id')
        except (ValueError, KeyError, OSError) as error:
            result = {'status': 'query_failed', 'error': str(error), 'artistic_approval': False,
                      'request_id': request.get('request_id') if isinstance(request, dict) else None}
        print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
