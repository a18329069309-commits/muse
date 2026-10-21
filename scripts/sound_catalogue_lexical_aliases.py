"""Bounded bilingual publisher-metadata recall; never inspect or qualify audio."""
import argparse
import json
import re
from contextlib import closing
from registered_library_connection import readonly_registered_library
from segment_library import query_library


def recall(database, query, aliases):
    if query.get('asset_kind') not in ('sfx', 'ambience') or not aliases or len(aliases) > 100:
        raise ValueError('bounded_sound_metadata_query_required')
    original = query_library(database, **query)
    original_ids = [row['segment_id'] for row in original['candidates']]
    columns = ["json_extract(a.record_json,'$.title')", "json_extract(a.record_json,'$.source_tags')",
               "json_extract(a.record_json,'$.source_directory_hints')", "json_extract(a.record_json,'$.publisher_tags')"]
    where = ["a.blocked=0", "s.listening_status NOT IN ('rejected','failed')",
             "json_extract(a.record_json,'$.asset_kind')=?"]
    params = [query['asset_kind']]
    for field, operator in [('min_duration', '>='), ('max_duration', '<=')]:
        if query.get(field) is not None:
            where.append('s.end_s-s.start_s ' + operator + ' ?'); params.append(query[field])
    where.append('(' + ' OR '.join("lower(coalesce(" + field + ",'')) LIKE ?" for field in columns for alias in aliases) + ')')
    params.extend('%' + alias.lower() + '%' for field in columns for alias in aliases)
    allowed = set(query['candidate_segment_ids']) if query.get('candidate_segment_ids') else None
    matches = []
    with closing(readonly_registered_library(database)) as db:
        for row in db.execute('SELECT s.segment_id,a.record_json FROM segments s JOIN assets a USING(asset_id) WHERE '
                              + ' AND '.join(where) + ' ORDER BY s.segment_id LIMIT 200', params):
            segment_id, record = row[0], json.loads(row[1])
            if allowed is not None and segment_id not in allowed:
                continue
            fields = {key: record.get(key) for key in ('title', 'source_tags', 'source_directory_hints', 'publisher_tags')}
            encoded = json.dumps(fields, ensure_ascii=False)
            actual = [alias for alias in aliases if (re.search(r'(?<![a-z0-9])' + re.escape(alias) + r'(?![a-z0-9])', encoded, re.I)
                      if re.fullmatch('[a-zA-Z0-9 -]+', alias) else alias in encoded)]
            if actual:
                matches.append({'segment_id': segment_id, 'publisher_title': record.get('title', ''),
                                'matched_metadata_aliases': actual, 'metadata_status': 'unverified_publisher_labels'})
            if len(matches) >= 100:
                break
    # Exact function, exclusions, source scope, duration and eligibility remain
    # the existing consumer's responsibility. Apply them before returning IDs.
    union = list(dict.fromkeys(original_ids + [row['segment_id'] for row in matches]))[:100]
    aliases_result = query_library(database, **{**query, 'text': '', 'candidate_segment_ids': union, 'limit': 100}) if union else {'candidates': []}
    eligible = [row['segment_id'] for row in aliases_result['candidates']]
    final = list(dict.fromkeys([*original_ids, *eligible]))[:100]
    new = set(final) - set(original_ids)
    return {'kind': 'bounded_sound_catalogue_metadata_aliases', 'candidate_ids': final,
            'original_candidate_count': len(original_ids), 'alias_candidate_count': len(eligible),
            'additional_candidate_count': len(new), 'matches': [row for row in matches if row['segment_id'] in new],
            'actual_audio_read': False, 'qualification_granted': False}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--library', required=True)
    parser.add_argument('--query', required=True); parser.add_argument('--aliases', required=True)
    args = parser.parse_args()
    print(json.dumps(recall(args.library, json.loads(args.query), json.loads(args.aliases)), ensure_ascii=False))


if __name__ == '__main__':
    main()
