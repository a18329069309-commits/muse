"""Offline CPU CLAP recall for existing case tasks; similarity never approves a cue.

Register actual indexed windows in a new library snapshot, then apply the original
structured filters. The original text/query and real semantic run remain bound.
"""
import argparse
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import re
import shutil
import subprocess
import sys
import time

from clap_segment_features import ResidentRetriever, digest, json_digest
import clap_segment_features
import segment_library
import route_music_cues
import registered_library_connection
from route_music_cues import NEGATIVE_QUERY


def save(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return {'path': str(file.resolve()), 'sha256': digest(file)}


def binding(file):
    return {'path': str(Path(file).resolve()), 'sha256': digest(file)}


def execution_sources():
    return [Path(file).resolve() for file in (__file__, clap_segment_features.__file__,
            segment_library.__file__, route_music_cues.__file__, registered_library_connection.__file__)]


def archive_execution_code(config):
    sources = execution_sources()
    stamps = [(row.st_size, row.st_mtime_ns, row.st_ctime_ns) for row in [file.stat() for file in sources]]
    originals = [{'name': file.name, 'original_path': str(file), 'original_sha256': digest(file)} for file in sources]
    directory = local_database_path(config['database']).parent / 'execution-code' / json_digest(originals)
    directory.mkdir(parents=True, exist_ok=True)
    copies = []
    for file, original in zip(sources, originals):
        destination = directory / file.name
        try:
            with file.open('rb') as source, destination.open('xb') as target:
                shutil.copyfileobj(source, target)
        except FileExistsError:
            pass
        if digest(destination) != original['original_sha256'] or digest(file) != original['original_sha256']:
            raise ValueError('semantic_execution_code_changed_during_archive')
        copies.append(binding(destination))
    if stamps != [(row.st_size, row.st_mtime_ns, row.st_ctime_ns) for row in [file.stat() for file in sources]]:
        raise ValueError('semantic_execution_code_changed_during_archive')
    manifest = {'revision': 'semantic-execution-code-v2', 'execution_script': copies[0],
        'dependencies': copies[1:], 'original_sources': originals}
    file = directory / 'execution-code.json'
    if file.exists():
        if json.loads(file.read_text(encoding='utf-8')) != manifest:
            raise ValueError('semantic_execution_code_snapshot_changed')
        return binding(file)
    return save(file, manifest)


def verify_execution_snapshot(record):
    if not record or digest(record['path']) != record['sha256']:
        raise ValueError('semantic_execution_code_snapshot_changed')
    manifest = json.loads(Path(record['path']).read_text(encoding='utf-8'))
    rows = [manifest.get('execution_script'), *manifest.get('dependencies', [])]
    sources = execution_sources()
    if manifest.get('revision') != 'semantic-execution-code-v2' or len(rows) != len(sources) or any(
            not row or Path(row['path']).resolve() != source or digest(source) != row['sha256']
            for source, row in zip(sources, rows)):
        raise ValueError('semantic_execution_code_snapshot_changed')
    return manifest


def local_database_path(file):
    database = Path(file).resolve()
    if str(database).startswith(('\\\\', '//')):
        raise ValueError('semantic_local_database_storage_required')
    return database


def constrained_query(original, ids):
    """Only replace lexical matching; every explicit structural constraint survives."""
    if NEGATIVE_QUERY.search(original.get('text', '')):
        raise ValueError('negated_text_requires_explicit_structured_filters_before_semantic_recall')
    limit = original.get('limit', 20)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('research_recall_limit_must_be_1_to_20')
    query = deepcopy(original)
    query.update(text='', candidate_segment_ids=ids, preserve_source_windows=True,
                 usage_scope='research_noncommercial', limit=limit)
    return query


def library_view(database, base_reference=None):
    return database if base_reference is None else {'schema_version': 1,
        'kind': registered_library_connection.KIND, 'base_db': base_reference, 'delta_db': binding(database)}


def register_windows(database, records, directory, base_reference=None):
    """Use trusted asset identities, not guessed labels for a newly encoded window."""
    connection = registered_library_connection.readonly_registered_library(library_view(database, base_reference))
    assets, asset_rows, segments, gaps = {}, {}, [], []
    try:
        for record in records:
            asset = connection.execute('SELECT * FROM assets WHERE asset_id=?', (record['asset_id'],)).fetchone()
            if not asset or asset['source_sha256'] != record['source_sha256']:
                gaps.append({'segment_id': record['segment_id'], 'gap': 'indexed_asset_missing_or_identity_changed'})
                continue
            if asset['blocked']:
                gaps.append({'segment_id': record['segment_id'], 'gap': 'indexed_asset_blocked'})
                continue
            prior = connection.execute('SELECT * FROM segments WHERE segment_id=?', (record['segment_id'],)).fetchone()
            if prior:
                if (prior['source_sha256'] != record['source_sha256'] or prior['asset_id'] != record['asset_id']
                    or [prior['start_s'], prior['end_s']] != record['source_range']):
                    raise ValueError('indexed_segment_identity_changed')
                continue
            start, end = record['source_range']
            if not 0 <= start < end <= asset['duration']:
                gaps.append({'segment_id': record['segment_id'], 'gap': 'indexed_window_outside_asset'})
                continue
            asset_rows[record['asset_id']] = tuple(asset)
            assets[record['asset_id']] = {**json.loads(asset['record_json']),
                'asset_id': record['asset_id'], 'local_path': asset['path'], 'source_sha256': record['source_sha256']}
            parents = connection.execute('SELECT record_json FROM segments WHERE asset_id=? '
                'AND source_sha256=? AND start_s<=? AND end_s>=?',
                (record['asset_id'], record['source_sha256'], start, end)).fetchall()
            case_ids = {json.loads(parent['record_json']).get('case_id') for parent in parents}
            case_ids.discard(None)
            if len(case_ids) > 1:
                gaps.append({'segment_id': record['segment_id'], 'gap': 'indexed_window_case_provenance_ambiguous'})
                continue
            segments.append({'segment_id': record['segment_id'], 'asset_id': record['asset_id'],
                'source_sha256': record['source_sha256'], 'source_start_seconds': start,
                'source_end_seconds': end, 'phase': 'unknown', 'listening_status': 'pending',
                'vocal_presence': 'unknown', 'narrative_functions': [],
                **({'case_id': next(iter(case_ids))} if case_ids else {}),
                'tag_evidence': 'CLAP source window identity; no semantic labels or lyric verification'})
    finally:
        connection.close()
    report = {'imported_segments': 0}
    if segments:
        catalog = save(Path(directory) / 'assets.json', {'assets': list(assets.values())})
        windows = save(Path(directory) / 'windows.json', {'segments': segments})
        if base_reference is None:
            report = segment_library.import_library(database, catalog['path'], windows['path'])
        else:
            with closing(sqlite3.connect(database)) as target, target:
                target.execute('PRAGMA foreign_keys=ON')
                for row in asset_rows.values():
                    target.execute('INSERT OR IGNORE INTO assets VALUES(' + ','.join('?' * len(row)) + ')', row)
                for segment in segments:
                    target.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)',
                        (segment['segment_id'], segment['asset_id'], segment['source_sha256'],
                         segment['source_start_seconds'], segment['source_end_seconds'], 'unknown', 'pending',
                         json.dumps(segment, ensure_ascii=False)))
                    target.execute('INSERT INTO segment_text VALUES(?,?)', (segment['segment_id'],
                        segment_library.search_words(assets[segment['asset_id']], segment)))
            report = {'imported_segments': len(segments), 'reused_frozen_assets': len(asset_rows)}
        report.update(catalog=catalog, windows=windows)
    return {'registration': report, 'gaps': gaps}


def expand_tasks(document, descriptions, resident, database, output, run_identity, forward_calls, expansion_limit=100,
                 invalid_query_handling='reject', base_reference=None):
    if type(expansion_limit) is not int or expansion_limit not in (50, 100):
        raise ValueError('semantic_expansion_limit_must_be_50_or_100')
    if invalid_query_handling not in ('reject', 'task_gap'):
        raise ValueError('semantic_invalid_query_handling_must_be_reject_or_task_gap')
    result = deepcopy(document)
    seen, reports = set(), []
    for item in descriptions:
        index = item['task_index']
        if type(index) is not int or not 0 <= index < len(result['tasks']) or index in seen:
            raise ValueError('unique_existing_task_indices_required')
        seen.add(index)
        task, original = result['tasks'][index], deepcopy(result['tasks'][index]['query'])
        if original.get('usage_scope', 'research_noncommercial') != 'research_noncommercial':
            raise ValueError('research_scope_required')
        gap = None
        if original.get('asset_kind') == 'music' and invalid_query_handling == 'task_gap':
            if not original.get('text', '').strip() or not isinstance(item.get('text'), str) or not item['text'].strip():
                gap = 'empty_music_text_requires_explicit_positive_description'
            elif NEGATIVE_QUERY.search(original['text']) or NEGATIVE_QUERY.search(item['text']):
                gap = 'negated_music_text_requires_explicit_structured_filters'
        if gap:
            evidence = save(output / f'task-{index}-semantic-recall.json', {'schema_version': 1, **run_identity,
                'case_id': task['case_id'], 'step_id': task['step_id'], 'source_event_id': task['source_event_id'],
                'original_query': original, 'semantic_gap': gap, 'attempts': [], 'candidate_segment_ids': [],
                'actual_text_embedding_processed': False, 'text_embedding_forward_calls': 0,
                'artistic_approval': False, 'lyrics_verified': False, 'production_approval': False})
            task['evidence_files'] = [*task.get('evidence_files', []), evidence]
            task['semantic_recall'], task['semantic_gap'] = evidence, gap
            reports.append(evidence)
            continue
        if original.get('asset_kind') != 'music' or not isinstance(item.get('text'), str) or not item['text'].strip():
            raise ValueError('explicit_music_sound_description_required')
        if NEGATIVE_QUERY.search(original.get('text', '')) or NEGATIVE_QUERY.search(item['text']):
            raise ValueError('negated_text_requires_explicit_structured_filters_before_semantic_recall')
        attempts, selected = [], []
        allowed_ids = set(original['candidate_segment_ids']) if original.get('candidate_segment_ids') else None
        for attempt, limit in enumerate((20, expansion_limit)):
            begun, before = time.perf_counter(), forward_calls[0]
            recall = resident.search(item['text'], limit=limit, preserve_source_windows=True)
            candidates = recall['candidates']
            if allowed_ids is not None:
                candidates = [row for row in candidates if row['segment_id'] in allowed_ids]
            registered = register_windows(database, candidates, output / f'task-{index}-attempt-{attempt}', base_reference)
            ids = [row['segment_id'] for row in candidates]
            filtered = segment_library.query_library(library_view(database, base_reference), **constrained_query(original, ids)) if ids else {'candidates': []}
            selected = filtered['candidates']
            attempts.append({'attempt': attempt, 'expansion': bool(attempt), 'actual_sound_description': item['text'],
                'original_query': original, 'semantic': recall, 'registration': registered, 'filtered': filtered,
                'text_embedding_forward_calls': forward_calls[0] - before,
                'elapsed_seconds': time.perf_counter() - begun})
            if len(selected) >= min(original.get('limit', 20), 20):
                break
        record = {'schema_version': 1, **run_identity, 'case_id': task['case_id'], 'step_id': task['step_id'],
            'source_event_id': task['source_event_id'], 'original_query': original, 'attempts': attempts,
            'candidate_segment_ids': [row['segment_id'] for row in selected],
            'actual_text_embedding_processed': all(row['text_embedding_forward_calls'] > 0 for row in attempts),
            'source_integrity': 'index_snapshot_and_registered_assets_reverify_before_observation',
            'artistic_approval': False, 'lyrics_verified': False, 'production_approval': False}
        evidence = save(output / f'task-{index}-semantic-recall.json', record)
        task['evidence_files'] = [*task.get('evidence_files', []), evidence]
        if selected:
            query = constrained_query(original, record['candidate_segment_ids'])
            query.pop('preserve_source_windows')  # corpus_materials applies this itself.
            task['query'] = query
            task['semantic_recall'] = evidence
        else:
            task['semantic_recall'] = evidence
            task['semantic_gap'] = 'no_eligible_semantic_candidate_after_one_expansion'
        reports.append(evidence)
    return result, reports


def run(config, execution_snapshot=None):
    if execution_snapshot is None:
        raise ValueError('semantic_immutable_execution_snapshot_required')
    code = verify_execution_snapshot(execution_snapshot)
    if config.get('device', 'cpu') != 'cpu':
        raise ValueError('semantic_material_worker_must_use_cpu')
    expansion_limit = config.get('expansion_limit', 100)
    if type(expansion_limit) is not int or expansion_limit not in (50, 100):
        raise ValueError('semantic_expansion_limit_must_be_50_or_100')
    invalid_query_handling = config.get('invalid_query_handling', 'reject')
    if invalid_query_handling not in ('reject', 'task_gap'):
        raise ValueError('semantic_invalid_query_handling_must_be_reject_or_task_gap')
    database = local_database_path(config['database'])
    storage_kind = config.get('storage_kind', 'single_database')
    if storage_kind not in ('single_database', registered_library_connection.KIND):
        raise ValueError('semantic_explicit_storage_kind_required')
    descriptor_file = local_database_path(config['library_descriptor']) if storage_kind == registered_library_connection.KIND else None
    if descriptor_file is not None and (descriptor_file.suffix.lower() != '.json' or descriptor_file == database or descriptor_file.exists()):
        raise ValueError('new_hash_bound_library_descriptor_required')
    output = Path(config['output_dir']).resolve()
    output.mkdir(parents=True, exist_ok=False)
    inputs = {name: binding(config[name]) for name in ('task_file', 'case_input', 'library_db')}
    inputs['execution_script'] = code['execution_script']
    inputs['execution_dependencies'] = code['dependencies']
    index, weights = Path(config['index']).resolve(), Path(config['weights']).resolve()
    if database.exists():
        raise ValueError('new_local_database_snapshot_required')
    database.parent.mkdir(parents=True, exist_ok=True)
    source_bytes = Path(inputs['library_db']['path']).stat().st_size
    free_bytes = shutil.disk_usage(database.parent).free
    if free_bytes < source_bytes + 2 * 1024 ** 3:
        error = ValueError('semantic_local_database_space_reserve_required')
        error.text_embedding_forward_calls = 0
        error.storage = {'source_bytes': source_bytes, 'free_bytes': free_bytes, 'reserve_bytes': 2 * 1024 ** 3}
        raise error
    base_reference = inputs['library_db'] if storage_kind == registered_library_connection.KIND else None
    if base_reference is not None:
        registered_library_connection._reference(base_reference)
        with closing(sqlite3.connect(database)) as target, target:
            for statement in segment_library.SCHEMA:
                target.execute(statement)
    else:
        with closing(sqlite3.connect(Path(inputs['library_db']['path']).as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(database)) as target:
                source.backup(target)
    document = json.loads(Path(config['task_file']).read_text(encoding='utf-8-sig'))
    needs_model = invalid_query_handling == 'reject' or any(
        isinstance(item.get('text'), str) and item['text'].strip()
        and document['tasks'][item['task_index']]['query'].get('text', '').strip()
        and not NEGATIVE_QUERY.search(item['text'])
        and not NEGATIVE_QUERY.search(document['tasks'][item['task_index']]['query']['text'])
        for item in config['semantic_queries'])
    started = time.perf_counter()
    resident = ResidentRetriever(index, weights if needs_model else None, 'cpu')
    load_seconds, calls = time.perf_counter() - started, [0]
    def counted(module, arguments):
        calls[0] += 1
    if resident.loaded_runtime is not None:
        resident.loaded_runtime[1].text_model.register_forward_pre_hook(counted)
    identity = {'backend': 'local_clap_text_audio_retrieval', 'device': 'cpu', 'source_inputs': inputs,
        'execution_code_snapshot': execution_snapshot,
        'index_manifest': binding(index / 'index.json'), 'index_vectors': binding(index / 'audio.npy'),
        'model_binding': resident.index['binding'], 'encoded_windows': len(resident.records),
        'encoded_sources': resident.encoded_unique_sources, 'startup_seconds': load_seconds, 'expansion_limit': expansion_limit,
        'invalid_query_handling': invalid_query_handling,
        **({'storage_identity': config['storage_identity']} if config.get('storage_identity') else {})}
    expanded, reports = expand_tasks(document, config['semantic_queries'], resident, database, output, identity, calls,
                                    expansion_limit, invalid_query_handling, base_reference)
    verify_execution_snapshot(execution_snapshot)
    for row in [inputs[name] for name in ('task_file', 'case_input', 'library_db')]:
        if digest(row['path']) != row['sha256']:
            raise ValueError('semantic_source_changed_during_run')
    library, library_storage = binding(database), None
    if base_reference is not None:
        descriptor = library_view(database, base_reference)
        library = save(descriptor_file, descriptor)
        with closing(registered_library_connection.readonly_registered_library(library)):
            pass
        library_storage = {'schema_version': 1, 'kind': storage_kind, 'descriptor': library,
            'base_db': base_reference, 'delta_db': descriptor['delta_db']}
    expanded_tasks = save(output / 'material-tasks-semantic.json', expanded)
    return save(output / 'semantic-run-receipt.json', {**identity, 'expanded_tasks': expanded_tasks,
        'library': library, **({'library_storage': library_storage} if library_storage is not None else {}), 'query_evidence': reports, 'text_embedding_forward_calls': calls[0],
        'status': 'semantic_recall_complete_not_listened', 'paid_calls': 0, 'uploads': 0,
        'new_models': 0, 'artistic_approval': False, 'production_approval': False})


def run_cli(config_file, execution_snapshot=None):
    config = json.loads(Path(config_file).read_text(encoding='utf-8-sig'))
    try:
        if execution_snapshot is None:
            archived = archive_execution_code(config)
            code = json.loads(Path(archived['path']).read_text(encoding='utf-8'))
            return subprocess.run([sys.executable, '-B', code['execution_script']['path'], '--config', str(config_file),
                '--execution-snapshot', archived['path'], '--execution-snapshot-sha256', archived['sha256']],
                check=False, stdout=sys.stdout, stderr=sys.stderr,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0).returncode
        print(json.dumps(run(config, execution_snapshot)))
        return 0
    except Exception as error:
        message = str(error)
        safe_message = message if isinstance(error, sqlite3.Error) or (
            isinstance(error, ValueError) and re.fullmatch(r'[a-z][a-z0-9_]{1,160}', message)) else 'exception_message_not_exposed'
        failure = save(Path(config['output_dir']) / 'semantic-run-failure.json', {
            'status': 'semantic_recall_failed', 'config': binding(config_file), 'execution_script': binding(__file__),
            **({'execution_code_snapshot': execution_snapshot} if execution_snapshot is not None else {}),
            'error_type': type(error).__name__, 'error': safe_message,
            'sqlite_errorcode': getattr(error, 'sqlite_errorcode', None),
            'sqlite_errorname': getattr(error, 'sqlite_errorname', None),
            'text_embedding_forward_calls': getattr(error, 'text_embedding_forward_calls', None),
            **({'storage': error.storage} if hasattr(error, 'storage') else {}),
            'artistic_approval': False, 'production_approval': False})
        print(json.dumps({'failure': failure}))
        return 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--execution-snapshot', type=Path)
    parser.add_argument('--execution-snapshot-sha256')
    args = parser.parse_args()
    raise SystemExit(run_cli(args.config, {'path': str(args.execution_snapshot), 'sha256': args.execution_snapshot_sha256}
                            if args.execution_snapshot else None))
