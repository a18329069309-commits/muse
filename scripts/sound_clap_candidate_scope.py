"""Apply existing exact sound-library filters before semantic top-k ranking."""
import argparse
import json
from segment_library import query_library


def eligible_scope(database, query, indexed_ids):
    if query.get('asset_kind') not in ('sfx', 'ambience') or not isinstance(indexed_ids, list) or \
            not 1 <= len(indexed_ids) <= 100 or len(set(indexed_ids)) != len(indexed_ids) or \
            any(not isinstance(i, str) or not i for i in indexed_ids):
        raise ValueError('Bounded exact sound semantic scope required')
    requested = query.get('candidate_segment_ids')
    if requested is not None:
        if not isinstance(requested, list) or len(set(requested)) != len(requested):
            raise ValueError('Exact caller candidate IDs required')
        indexed_ids = [i for i in indexed_ids if i in requested]
    if not indexed_ids:
        return {'kind': 'exact_sound_semantic_scope', 'candidates': [], 'audio_files_read': 0,
                'scope_filtered_before_limit': True, 'qualification_granted': False}
    result = query_library(database, **{**query, 'text': '', 'limit': 100,
        'candidate_segment_ids': indexed_ids, 'preserve_source_windows': True})
    return {'kind': 'exact_sound_semantic_scope', 'candidates': result['candidates'],
            'audio_files_read': result['audio_files_read'], 'scope_filtered_before_limit': True,
            'qualification_granted': False, 'query_filters': {k:v for k,v in query.items() if k != 'text'}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', required=True)
    parser.add_argument('--query', required=True)
    parser.add_argument('--indexed-ids', required=True)
    args = parser.parse_args()
    print(json.dumps(eligible_scope(args.library, json.loads(args.query), json.loads(args.indexed_ids)), ensure_ascii=False))
