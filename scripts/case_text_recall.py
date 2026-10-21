"""Bounded lexical case recall from a frozen readonly store, not a semantic verdict.

SQLite FTS5 indexes Chinese character pairs and ordinary words once per store hash.
The host comparator must still judge ordered story compatibility and hard conflicts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from contextlib import closing

from case_preset_store import heldout_clause, file_binding
from segment_library import digest_file


def words(value):
    def values(item):
        if isinstance(item, str): return [item]
        if isinstance(item, dict): return [text for child in item.values() for text in values(child)]
        if isinstance(item, list): return [text for child in item for text in values(child)]
        return []
    text = ' '.join(values(value))
    tokens = re.findall(r'[a-zA-Z0-9]{3,}', text.lower())
    for phrase in re.findall(r'[\u3400-\u9fff]{2,}', text):
        tokens.extend(phrase[index:index + 2] for index in range(len(phrase) - 1))
    return tokens


def recall(db_file, request, cache_file, pool_binding=None):
    if request.get('schema_version') != 2 or request.get('usage_scope') != 'research_noncommercial':
        raise ValueError('research_case_query_v2_required')
    file_binding({'path': str(Path(db_file).resolve()), 'sha256': request['store_sha256']}, Path('.'))
    source_hash = request.get('source_video_sha256', '')
    if not re.fullmatch('[a-f0-9]{64}', source_hash):
        raise ValueError('current_source_sha256_required')
    limit = request.get('limit', 20)
    if isinstance(limit, bool) or limit not in (20, 50):
        raise ValueError('bounded_case_recall_twenty_or_fifty_required')
    pool = None
    if pool_binding:
        checked = file_binding(pool_binding, Path('.'))
        pool = json.loads(Path(checked['path']).read_text(encoding='utf-8-sig'))
        if (pool.get('schema_version') != 1 or pool.get('source_video_sha256') != source_hash
                or pool.get('case_db', {}).get('sha256') != request['store_sha256']
                or Path(pool['case_db']['path']).resolve() != Path(db_file).resolve()
                or pool.get('production_approval') is not False
                or len({row['cue_id'] for row in pool.get('cues', [])}) != len(pool.get('cues', []))):
            raise ValueError('bound_reference_pool_identity_required')
    Path(cache_file).parent.mkdir(parents=True, exist_ok=True)
    formats = {}
    if request.get('source_format_manifest'):
        bound = file_binding(request['source_format_manifest'], Path('.'))
        document = json.loads(Path(bound['path']).read_text(encoding='utf-8-sig'))
        formats = {row['episode_id']: row for row in document['entries']}
    with closing(sqlite3.connect(cache_file)) as cache:
        cache.execute('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT)')
        cached = cache.execute("SELECT value FROM metadata WHERE key='store_sha256'").fetchone()
        schema = cache.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
        built = False
        if not cached or cached[0] != request['store_sha256'] or not schema or schema[0] != '3':
            with closing(sqlite3.connect(Path(db_file).resolve().as_uri() + '?mode=ro', uri=True)) as source:
                rows = source.execute('SELECT c.record_json,e.record_json,w.record_json FROM cases c '
                                      'JOIN episodes e USING(episode_id) JOIN works w USING(work_id) WHERE '
                                      + heldout_clause(True) + ' ORDER BY c.case_id').fetchall()
            cache.execute('DROP TABLE IF EXISTS case_terms')
            cache.execute('DROP TABLE IF EXISTS case_records')
            cache.execute('CREATE VIRTUAL TABLE case_terms USING fts5(case_id UNINDEXED,terms)')
            cache.execute('CREATE TABLE case_records(case_id TEXT PRIMARY KEY,episode_id TEXT,'
                          'case_json TEXT,episode_json TEXT,work_json TEXT)')
            for raw, episode_raw, work_raw in rows:
                case = json.loads(raw)
                content = {key: case.get(key) for key in ('description', 'conditions', 'story_sequence')}
                cache.execute('INSERT INTO case_terms VALUES(?,?)', (case['case_id'], ' '.join(words(content))))
                cache.execute('INSERT INTO case_records VALUES(?,?,?,?,?)',
                              (case['case_id'], case['episode_id'], raw, episode_raw, work_raw))
            cache.execute("INSERT OR REPLACE INTO metadata VALUES('store_sha256',?)", (request['store_sha256'],))
            cache.execute("INSERT OR REPLACE INTO metadata VALUES('schema_version','3')")
            cache.commit()
            built = True
        size = cache.execute('SELECT COUNT(*) FROM case_records').fetchone()[0]
        decoded = set()

        def record(case_id):
            raw, episode_raw, work_raw = cache.execute(
                'SELECT case_json,episode_json,work_json FROM case_records WHERE case_id=?', (case_id,)).fetchone()
            case, episode, work = json.loads(raw), json.loads(episode_raw), json.loads(work_raw)
            decoded.add(case_id)
            return {'case_id': case['case_id'], 'episode_id': case['episode_id'],
                'reference_case_binding': {'database': {'path': str(Path(db_file).resolve()), 'sha256': request['store_sha256']},
                    'case_id': case['case_id'], 'record_sha256': hashlib.sha256(raw.encode()).hexdigest()},
                'source_video': episode['source_video'], 'work': work, 'case_status': case['status'],
                'source_range': case['source_range'], 'description': case.get('description', ''),
                **{key: case.get(key, [] if key.endswith('_ids') else {}) for key in (
                    'conditions', 'story_sequence', 'development_preset', 'sound_actions', 'source_events',
                    'music_pack_ids', 'sound_pack_ids', 'theme_bundle_ids')},
                'evidence_summary': {key: case.get('evidence', {}).get(key) for key in (
                    'evidence_status', 'actual_audio_processed', 'actual_video_processed', 'artistic_approval')},
                'evidence_file_count': len(case.get('evidence', {}).get('files', [])),
                'source_format': {'orientation': formats.get(case['episode_id'], {}).get('orientation', 'unknown'),
                    'source_hash_verified_for_current_query': False,
                    'metadata_binding': request.get('source_format_manifest'), 'formal_adoption_allowed': False},
                'unresolved_gaps': case.get('unresolved_gaps', [])}

        cues = []
        for cue in request['cues']:
            condition = {key: cue.get(key) for key in ('function', 'case_conditions', 'story_sequence')}
            tokens = list(dict.fromkeys(words(condition)))[:120]
            if pool:
                group = next((row for row in pool['cues'] if row['cue_id'] == cue['cue_id']
                              or row['cue_id'] + '/words' == cue['cue_id']), None)
                bindings = group.get('candidate_cases', []) if group else []
                if len(bindings) > limit or len({row['case_id'] for row in bindings}) != len(bindings):
                    raise ValueError('reference_pool_limit_or_duplicate_identity')
                matches = []
                for binding in bindings:
                    row = cache.execute('SELECT case_json FROM case_records WHERE case_id=?', (binding['case_id'],)).fetchone()
                    if not row or hashlib.sha256(row[0].encode()).hexdigest() != binding.get('record_sha256'):
                        raise ValueError('reference_pool_case_changed_or_unavailable')
                    matches.append((binding['case_id'], None))
            elif not tokens:
                matches = []
            else:
                expression = ' OR '.join('"' + token.replace('"', '""') + '"' for token in tokens)
                matches = cache.execute('SELECT case_id,bm25(case_terms) FROM case_terms WHERE case_terms MATCH ? '
                                        'ORDER BY bm25(case_terms),case_id LIMIT 100', (expression,)).fetchall()
                if request.get('prefer_vertical'):
                    ids = [row[0] for row in matches]
                    episode_ids = dict(cache.execute('SELECT case_id,episode_id FROM case_records WHERE case_id IN ('
                                                     + ','.join('?' for _ in ids) + ')', ids)) if ids else {}
                    matches.sort(key=lambda row: {'vertical': 0, 'horizontal': 1}.get(
                        formats.get(episode_ids.get(row[0]), {}).get('orientation', 'unknown'), 2))
                matches = matches[:limit]
            cues.append({'cue_id': cue['cue_id'], 'recall_kind': ('bound_reference_pool_pending_host_comparison' if pool
                         else 'cached_fts5_lexical_not_semantic'),
                         'query_terms': tokens, 'candidates': [{**record(case_id), 'lexical_rank': rank + 1,
                                                               'lexical_score': score} for rank, (case_id, score) in enumerate(matches)]})
    if digest_file(db_file) != request['store_sha256']:
        raise ValueError('case_store_changed_during_recall')
    if pool_binding:
        file_binding(pool_binding, Path('.'))
    return {'schema_version': 1, 'source_video_sha256': source_hash, 'store_sha256': request['store_sha256'],
            'reference_store_size': size, 'cues': cues, 'semantics_validated': False, 'reference_pool': pool_binding,
            'recall_execution': {'index_built': built, 'full_records_decoded': len(decoded),
                                 'all_source_records_read_for_build': size if built else 0},
            'qualification_scope': 'readonly_source_identity_and_lexical_recall_only',
            'source_format_policy': {'prefer_vertical': request.get('prefer_vertical', False),
                'source_format_manifest': request.get('source_format_manifest'),
                'metadata_only_not_current_media_hash_verification': True},
            'formal_adoption_allowed': False, 'production_approval': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('db', 'request', 'cache', 'out'):
        parser.add_argument('--' + flag, type=Path, required=True)
    parser.add_argument('--pool', type=Path)
    parser.add_argument('--pool-sha256')
    args = parser.parse_args()
    result = recall(args.db, json.loads(args.request.read_text(encoding='utf-8-sig')), args.cache,
                    {'path': str(args.pool.resolve()), 'sha256': args.pool_sha256} if args.pool else None)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'lexical_candidates_pending_host_comparison', 'counts': [len(c['candidates']) for c in result['cues']]}, ensure_ascii=False))
