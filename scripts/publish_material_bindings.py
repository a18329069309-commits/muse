"""Freeze actually selected research material into a shared, derived case/library snapshot."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone

import case_preset_store as cases
import corpus_materials as materials
import segment_library as library
import registered_library_connection as registered
from publish_research_snapshot import Evidence, native_path


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def binding(path):
    return {'path': str(Path(path).resolve()), 'sha256': cases.digest_file(path)}


def verified(reference):
    if binding(reference['path'])['sha256'] != reference['sha256']:
        raise ValueError('material_publication_input_changed')
    return read(reference['path'])


def task_library_inputs(task, config, cache):
    declared = task.get('material_library')
    filename = declared['path'] if declared else config['source_library_db']
    key = str(Path(filename).resolve())
    reference = cache.get(key)
    if reference is None:
        reference = cache[key] = binding(filename)
    if declared and declared.get('sha256') and declared['sha256'] != reference['sha256']:
        raise ValueError('task_material_library_identity_changed')
    descriptor = Path(filename).suffix.lower() == '.json'
    if descriptor and not (declared and declared.get('sha256')):
        raise ValueError('task_material_library_descriptor_binding_required')
    source = reference if descriptor else reference['path']
    return {'source_library_db': source, 'source_library_binding': reference,
            'source_library_execution_proofs': declared.get('historical_execution_proofs', []) if declared else []}


def write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return binding(path)


def backup(source, target):
    with closing(cases.readonly(source)) as current, closing(sqlite3.connect(target)) as copied:
        current.backup(copied)


def current_reference(config, result):
    file = Path(config['output_root']) / 'current-publication.json'
    temp = file.with_suffix('.tmp')
    publication = Path(result['research']['cases_db']['path']).parent / 'publication.json'
    temp.write_text(json.dumps({'publication': binding(publication), 'consumer': result['consumer'],
                               'formal_adoption_allowed': False}, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(file)


def publish(config):
    evidence = Evidence(canonical_paths=True)
    inputs = list(config.get('material_inputs', []))
    if config.get('consumer_state'):
        state = read(config['consumer_state'])
        library_bindings = {}
        for item in state.get('tasks', {}).values():
            if item['status'] != 'research_bound':
                continue
            selection = verified(item['selection_record'])
            if not selection.get('bindings_file'):
                raise ValueError('research_bound_task_requires_selected_bindings')
            inputs.append({'case_input': selection['case_source'], 'selected_bindings': selection['bindings_file'],
                           'selection_record': item['selection_record'], 'bound_case_import': item['bound_case'],
                           **task_library_inputs(item, config, library_bindings)})
    inputs = list({row['selected_bindings']['sha256']: row for row in inputs}.values())
    if not inputs:
        return {'status': 'no_research_bindings_yet', 'formal_adoption_allowed': False}
    base_case, base_library = binding(config['base_cases_db']), binding(config['base_library_db'])
    implementation = {name: binding(Path(__file__).parent / name) for name in
                      ('publish_material_bindings.py', 'publish_research_snapshot.py', 'case_preset_store.py', 'corpus_materials.py', 'segment_library.py', 'registered_library_connection.py')}
    key = hashlib.sha256(json.dumps([base_case, base_library, inputs, implementation], sort_keys=True).encode()).hexdigest()
    out = Path(config['output_root']) / key
    if (out / 'publication.json').is_file():
        result = read(out / 'publication.json')
        for field in ('cases_db', 'library_db'):
            reference = result['research'][field]
            if binding(reference['path']) != reference:
                raise ValueError('frozen_material_publication_changed')
        current_reference(config, result)
        return result
    out.mkdir(parents=True, exist_ok=False)
    code_dir = out / 'implementation'
    code_dir.mkdir()
    for name, reference in list(implementation.items()):
        target = code_dir / name
        target.write_bytes(Path(reference['path']).read_bytes())
        copied = binding(target)
        if copied['sha256'] != reference['sha256']:
            raise ValueError('material_publisher_implementation_changed_during_freeze')
        implementation[name] = copied
    case_db, library_db = out / 'research-cases.sqlite', out / 'segments.sqlite'
    backup(base_case['path'], case_db)
    backup(base_library['path'], library_db)
    selected_records, source_inputs = [], []
    for index, item in enumerate(inputs):
        source_case = verified(item['case_input'])
        selected = verified(item['selected_bindings'])
        selection = verified(item['selection_record'])
        document = verified(item['bound_case_import'])
        if (selection.get('automatic_selection_performed') is not True or selection.get('selected_count', 0) < 1
                or selection.get('bindings_file') != item['selected_bindings']
                or selection.get('case_source') != item['case_input']
                or selection.get('artistic_approval') is not False or selection.get('production_approval') is not False):
            raise ValueError('actual_research_selection_record_required')
        raw = verified(selection['raw_response'])
        if raw.get('input_sha256') != selection['input']['sha256'] or not raw.get('model'):
            raise ValueError('actual_selection_response_input_binding_required')
        verified(selection['input'])
        source_library = item['source_library_db']
        library_reference = item.get('source_library_binding') or (source_library if isinstance(source_library, dict) else binding(source_library))
        evidence.check(library_reference)
        for reference in item.get('source_library_execution_proofs', []):
            evidence.check(reference)
        expected = materials.bind_materials(source_case, selected, source_library, Path(item['case_input']['path']).parent,
                                            evidence_checker=evidence.check)
        if document != expected:
            raise ValueError('bound_import_not_equal_verified_selected_materials')
        chosen = {row['case_id'] for row in selected['bindings']}
        update = {**document, 'cases': [row for row in document['cases'] if row['case_id'] in chosen]}
        with closing(cases.readonly(case_db)) as existing:
            for row in update['cases']:
                if row.get('status') != 'research':
                    raise ValueError('material_publication_cannot_change_qualification')
                prior = existing.execute('SELECT record_json FROM cases WHERE case_id=?', (row['case_id'],)).fetchone()
                if prior:
                    old = json.loads(prior[0])
                    for field in ('episode_id', 'source_range', 'conditions', 'story_sequence', 'description'):
                        if old.get(field) != row.get(field):
                            raise ValueError('material_publication_stale_case_definition')
        assets, segments = {}, {}
        with closing(registered.readonly_registered_library(source_library)) as source:
            for pack in document.get('packs', []):
                for window in pack.get('windows', []):
                    found = source.execute('SELECT * FROM segments WHERE segment_id=?', (window['segment_id'],)).fetchone()
                    if (not found or found['asset_id'] != pack['asset_id'] or found['source_sha256'] != pack['source_sha256']
                            or not found['start_s'] <= window['source_range'][0] < window['source_range'][1] <= found['end_s']):
                        raise ValueError('shared_material_segment_source_binding_required')
                    segments[found['segment_id']] = json.loads(found['record_json'])
                    asset = source.execute('SELECT record_json FROM assets WHERE asset_id=?', (found['asset_id'],)).fetchone()
                    assets[found['asset_id']] = json.loads(asset[0])
            for pack in document.get('sound_packs', []):
                for member in pack.get('members', []):
                    found = source.execute('SELECT * FROM segments WHERE segment_id=?', (member['segment_id'],)).fetchone()
                    if not found or found['source_sha256'] != member['source_sha256']:
                        raise ValueError('shared_sound_segment_source_binding_required')
                    segments[found['segment_id']] = json.loads(found['record_json'])
                    asset = source.execute('SELECT record_json FROM assets WHERE asset_id=?', (found['asset_id'],)).fetchone()
                    assets[found['asset_id']] = json.loads(asset[0])
        catalog = out / f'{index}-assets.json'
        ranges = out / f'{index}-segments.json'
        write_new(catalog, {'assets': list(assets.values())})
        write_new(ranges, {'segments': list(segments.values())})
        library.import_library(library_db, catalog, ranges, rehash=True)
        cases.import_store(case_db, update, Path(item['bound_case_import']['path']).parent, evidence_checker=evidence.check)
        selected_records.extend(chosen)
        source_inputs.append(item)
    for item in evidence.files.values():
        cases.file_binding({**item, 'path': str(native_path(item['path']))}, Path('.'), evidence.cache)
    if binding(base_case['path']) != base_case or binding(base_library['path']) != base_library:
        raise ValueError('base_snapshot_changed_during_material_publication')
    result = {'schema_version': 1, 'kind': 'frozen_research_material_snapshot', 'status': 'research_material_snapshot_available',
              'created_at': datetime.now(timezone.utc).isoformat(), 'inputs': source_inputs,
              'implementation': implementation,
              'bases': {'cases': base_case, 'library': base_library},
              'consumer': {'strategy': 'case_presets', 'cases': {'db': str(case_db)}, 'library': {'db': str(library_db)},
                           'usage_scope': 'research_noncommercial'},
              'research': {'cases_db': binding(case_db), 'library_db': binding(library_db), 'report': cases.report_store(case_db)},
              'bound_case_ids': sorted(set(selected_records)), 'complete_corpus_claimed': False, 'formal_adoption_allowed': False,
              'qualification_granted': False, 'artistic_approval': False, 'production_usable': False}
    write_new(out / 'publication.json', result)
    current_reference(config, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    result = publish(read(args.config))
    print(json.dumps({'status': result['status'], 'consumer': result.get('consumer'), 'formal_adoption_allowed': False}))
