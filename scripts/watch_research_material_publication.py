"""Publish newly completed research and compatible actual bindings without model calls."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
import traceback

import case_preset_store as cases
import publish_material_bindings as material
import publish_research_snapshot as research


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def digest_json(value):
    import hashlib
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def case_definition(value):
    # Binding adds these references recursively, never changes director facts.
    if isinstance(value, dict):
        return {key: case_definition(item) for key, item in value.items()
                if key not in ('music_pack_ids', 'theme_bundle_ids', 'sound_pack_ids')}
    if isinstance(value, list):
        return [case_definition(item) for item in value]
    return value


def compatible_inputs(config, database):
    inputs = list(config.get('material_inputs', []))
    state = read(config['consumer_state']) if config.get('consumer_state') else {}
    library_bindings = {}
    for item in state.get('tasks', {}).values():
        if item.get('status') == 'research_bound':
            selection = material.verified(item['selection_record'])
            inputs.append({'case_input': selection['case_source'], 'selected_bindings': selection['bindings_file'],
                'selection_record': item['selection_record'], 'bound_case_import': item['bound_case'],
                **material.task_library_inputs(item, config, library_bindings)})
    inputs = list({row['selected_bindings']['sha256']: row for row in inputs}.values())
    accepted, gaps = [], []
    with closing(cases.readonly(database)) as source:
        for item in inputs:
            original = material.verified(item['case_input'])
            selected = material.verified(item['selected_bindings'])
            ids = {row['case_id'] for row in selected['bindings']}
            originals = {row['case_id']: row for row in original['cases']}
            conflicts = []
            for identifier in ids:
                stored = source.execute('SELECT record_json FROM cases WHERE case_id=?', (identifier,)).fetchone()
                if not stored:
                    conflicts.append({'case_id': identifier, 'reason': 'not_in_current_published_research'})
                elif case_definition(json.loads(stored[0])) != case_definition(originals[identifier]):
                    conflicts.append({'case_id': identifier, 'reason': 'source_case_definition_changed'})
            if conflicts:
                gaps.append({'selected_bindings': item['selected_bindings'], 'status': 'needs_revalidate',
                             'conflicts': conflicts})
            else:
                accepted.append(item)
    return accepted, gaps


def admitted_run(supervisor):
    """A failed extension may be last while the checkpoint still has an older manifest."""
    for run in reversed(supervisor['runs']):
        worker = run.get('execution_config', run['config'])
        if material.binding(worker['path']) != worker:
            raise ValueError('active_worker_config_identity_changed')
        batch_config = read(worker['path'])
        batch = read(Path(batch_config['checkpoint_root']) / 'batch-state.json')
        if material.binding(batch_config['manifest_file'])['sha256'] == batch['identity']['manifest_sha256']:
            return worker, batch_config, batch
    raise ValueError('no_worker_config_matches_checkpoint_manifest')


def validate_output_root(root):
    # Default Windows SQLite creates a rollback journal before its first write.
    journal = root / 'snapshots' / ('f' * 64 + '-' + '9' * 19) / 'research-rules-with-history.sqlite-journal'
    if os.name == 'nt' and len(str(journal)) >= 260:
        raise ValueError('research_publication_short_output_root_required')


def run(config):
    root = Path(config['out']).resolve()
    validate_output_root(root)
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / 'writer.lock').open('a+b')
    if os.name == 'nt':
        import msvcrt
        if not lock.tell(): lock.write(b'0'); lock.flush()
        lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    state_file = root / 'state.json'
    identity = digest_json(config)
    state = read(state_file) if state_file.exists() else {'config_sha256': identity, 'failed_signatures': []}
    if state['config_sha256'] != identity: raise ValueError('research_publication_watch_config_changed')
    state.update(pid=os.getpid(), status='running', model_calls=0, paid_calls=0)
    save(state_file, state)
    implementation = {module.__file__: material.binding(module.__file__) for module in
                      (cases, material, research, material.materials, material.library, material.registered)}
    while True:
        candidates = config.get('supervisor_state_candidates', [config['supervisor_state']])
        supervisor = next((value for filename in candidates if Path(filename).is_file()
                           and (value := read(filename)).get('runs')), None)
        if supervisor is None:
            time.sleep(config.get('poll_seconds', 60)); continue
        worker, batch_config, batch = admitted_run(supervisor)
        material_config = read(config['material_config'])
        consumer = read(material_config['consumer_state'])
        signature = digest_json({'manifest': batch['identity']['manifest_sha256'],
            'completed': {key: row.get('case_import') for key, row in batch.get('episodes', {}).items()
                          if row.get('status') in ('research_processed', 'heldout_processed')},
            'work_results': {key: row.get('result_binding') for key, row in batch.get('works', {}).items()},
            'bindings': {key: row.get('bound_case') for key, row in consumer.get('tasks', {}).items()
                         if row.get('status') == 'research_bound'}})
        bootstrap = config.get('initial_research_publication') if not state.get('bootstrap_completed') else None
        if bootstrap:
            signature = digest_json({'bootstrap': bootstrap, 'bindings': consumer.get('tasks', {})})
        if signature == state.get('published_signature') or signature in state['failed_signatures']:
            time.sleep(config.get('poll_seconds', 60)); continue
        attempt = root / 'snapshots' / (signature + '-' + str(time.time_ns()))
        state.update(status='publishing', active_signature=signature)
        save(state_file, state)
        try:
            for reference in implementation.values():
                if material.binding(reference['path']) != reference:
                    raise ValueError('loaded_publication_implementation_changed')
            if bootstrap:
                attempt.mkdir(parents=True, exist_ok=False)
                published = material.verified(bootstrap)
                if published.get('kind') != 'frozen_research_snapshot' or published.get('formal_adoption_allowed') is not False:
                    raise ValueError('verified_research_bootstrap_required')
                for key in ('cases_db', 'rules_db'):
                    reference = published['research'][key]
                    if material.binding(reference['path']) != reference:
                        raise ValueError('bootstrap_research_database_changed')
                save(attempt / 'bootstrap-publication-reference.json', bootstrap)
            else:
                published = research.publish_research_snapshot(worker['path'], attempt)
            published = research.inherit_historical_rules(published, config.get('prior_research_publications', []), attempt)
            accepted, gaps = compatible_inputs(material_config, published['research']['cases_db']['path'])
            derived = {**material_config, 'base_cases_db': published['research']['cases_db']['path'],
                       'material_inputs': accepted, 'consumer_state': None,
                       'output_root': str(root / 'material-snapshots')}
            save(attempt / 'material-config.json', derived)
            bound = material.publish(derived)
            consumer_config = bound.get('consumer', published['consumer'])
            consumer_config['cases'].update({key: value for key, value in published['consumer']['cases'].items()
                                             if key != 'db'})
            pointer = {'schema': 'continuous-research-material-publication-v1',
                       'created_at': datetime.now(timezone.utc).isoformat(),
                       'research_publication': bootstrap or material.binding(attempt / 'publication.json'),
                       'loaded_implementation': implementation,
                       'historical_rule_inheritance': published.get('historical_rule_inheritance'),
                       'consumer': consumer_config, 'research_counts': published['research']['report'],
                       'rule_count': published['rule_count'],
                       'material_counts': bound.get('research', {}).get('report'),
                       'compatible_binding_inputs': len(accepted), 'needs_revalidate': gaps,
                       'formal_adoption_allowed': False, 'complete_corpus_claimed': False}
            for reference in implementation.values():
                if material.binding(reference['path']) != reference:
                    raise ValueError('loaded_publication_implementation_changed')
            save(attempt / 'consumer-publication.json', pointer)
            save(root / 'current-publication.json', pointer)
            state.update(status='waiting_for_new_research_or_bindings', published_signature=signature,
                         bootstrap_completed=state.get('bootstrap_completed') or bool(bootstrap),
                         current_publication=material.binding(root / 'current-publication.json'))
            print(json.dumps({'status': state['status'], 'signature': signature,
                              'compatible_binding_inputs': len(accepted), 'needs_revalidate': len(gaps),
                              'rule_count': published['rule_count'], 'production_approval': False}), flush=True)
        except Exception as error:
            attempt.mkdir(parents=True, exist_ok=True)
            save(attempt / 'failure.json', {'signature': signature, 'error_type': type(error).__name__,
                                          'error': str(error), 'stack': traceback.format_exc()})
            state['failed_signatures'].append(signature)
            state.update(status='publication_gap_preserved', latest_failure=material.binding(attempt / 'failure.json'))
        state.pop('active_signature', None)
        save(state_file, state)
        time.sleep(config.get('poll_seconds', 60))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    run(read(parser.parse_args().config))
