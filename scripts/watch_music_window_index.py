"""CPU-only incremental window indexing of verified, growing music snapshots.

Uses the existing builder and immutable indexes. Failed old windows are not
decoded again; new sources receive one three-window pass and retain their gaps.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

import numpy as np
import build_music_window_index as builder
import clap_segment_features as clap


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def ref(path):
    return {'path': str(Path(path).resolve()), 'sha256': clap.digest(path)}


def fresh_sources(assets, attempted):
    seen, result = set(attempted), []
    for asset in assets:
        if asset.get('asset_kind') == 'music' and asset['source_sha256'] not in seen:
            seen.add(asset['source_sha256'])
            result.append(asset)
    return result


def merge_indexes(directories):
    records, matrices, binding, ids = [], [], None, set()
    for directory in directories:
        document, matrix = clap.load_index(directory)
        if binding is not None and binding != document['binding']:
            raise ValueError('incremental_model_processor_binding_changed')
        binding = document['binding']
        for record in document['records']:
            if record['segment_id'] in ids:
                raise ValueError('incremental_segment_identity_overlap')
            ids.add(record['segment_id'])
            records.append(record)
        matrices.append(matrix)
    return records, np.concatenate(matrices), binding


def publish(root, state, freeze, assets):
    inputs = [ref(Path(p) / 'index.json') for p in state['indexes']]
    identity = clap.json_digest({'inputs': inputs, 'freeze': freeze})
    output = root / 'snapshots' / identity
    if not (output / 'index.json').exists():
        records, matrix, binding = merge_indexes(state['indexes'])
        pool = [a['asset_id'] for a in assets if a.get('asset_kind') == 'music']
        builder.save_index(output, records, matrix, binding,
            {'device': 'cpu', 'operation': 'prior_vectors_plus_actual_cpu_increments', 'gpu_calls': 0},
            pool, {'upstream_freeze': freeze, 'source_indexes': inputs,
                   'window_sampling': 'three_temporal_representatives_not_phrase_boundaries'})
    index, _ = clap.load_index(output)
    publication = {'schema': 'continuous-music-window-publication-v1', 'utc': datetime.now(timezone.utc).isoformat(),
        'index': str(output), 'index_json': ref(output / 'index.json'), 'audio_matrix': ref(output / 'audio.npy'),
        'upstream_freeze': freeze, 'encoded_windows': len(index['records']),
        'encoded_unique_sources': index['encoded_unique_sources'],
        'music_unique_sources': len({a['source_sha256'] for a in assets if a.get('asset_kind') == 'music'}),
        'pending_new_sources': len(fresh_sources(assets, state['attempted_sources'])),
        'build_reports': state['build_reports'], 'prior_gaps': state['prior_gaps'],
        'qualified': False, 'artistic_approval': False, 'production_approval': False,
        'consumer': {'clap_index': str(output), 'clap_weights': state['weights'],
                     'library': {'db': freeze['segments.sqlite']['path']},
                     'indexed_window_registration': 'existing_semantic_material_recall_register_windows'}}
    builder.write_json(root / 'current-publication.json', publication)
    state['latest_publication'] = ref(root / 'current-publication.json')
    return publication


def run(config):
    root = Path(config['out']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # An OS-held lock releases when the process closes, including a crash.
    lock = (root / 'writer.lock').open('a+b')
    if os.name == 'nt':
        import msvcrt
        if not lock.tell():
            lock.write(b'0'); lock.flush()
        lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    state_path = root / 'state.json'
    config_hash = clap.json_digest(config)
    if state_path.exists():
        state = read(state_path)
        if state['config_sha256'] != config_hash:
            raise ValueError('continuous_index_config_changed')
    else:
        base, _ = clap.load_index(config['prior_index'])
        pilot_report = read(Path(config['pilot_index']).parent / 'build-report.json')
        if pilot_report['status'] not in ['complete', 'complete_with_gaps']:
            raise ValueError('actual_pilot_build_required')
        clap.load_index(config['pilot_index'])
        pilot_job = read(Path(config['pilot_index']).parent / 'job.json')
        if clap.digest(pilot_job['catalog']) != pilot_job['catalog_sha256']:
            raise ValueError('pilot_catalog_changed')
        pilot_assets = read(pilot_job['catalog'])['assets']
        state = {'config_sha256': config_hash,
                 'indexes': [config['prior_index'], config['pilot_index']],
                 'attempted_sources': sorted({r['source_sha256'] for r in base['records']} |
                                           {a['source_sha256'] for a in pilot_assets}),
                 'build_reports': [ref(Path(config['pilot_index']).parent / 'build-report.json')],
                 'prior_gaps': ref(config['prior_report']), 'active': None}
    state.update(pid=os.getpid(), status='running', cpu_threads=2, gpu_calls=0, paid_calls=0,
                 weights=config['weights'])
    builder.write_json(state_path, state)
    cached_sha, assets, freeze = None, None, None
    while True:
        upstream = read(config['upstream_state'])
        current_freeze = upstream['latest_freeze']
        catalog_ref = current_freeze['catalog-assets.json']
        if shutil.disk_usage(root).free < 2 * 1024 ** 3:
            state['status'] = 'storage_wait'
            builder.write_json(state_path, state)
            time.sleep(config.get('poll_seconds', 30)); continue
        if cached_sha != catalog_ref['sha256']:
            for item in current_freeze.values():
                if clap.digest(item['path']) != item['sha256']:
                    raise ValueError('upstream_snapshot_identity_changed')
            assets = read(catalog_ref['path'])['assets']
            freeze, cached_sha = current_freeze, catalog_ref['sha256']
            publish(root, state, freeze, assets)
        if not state.get('active'):
            chosen = fresh_sources(assets, state['attempted_sources'])[:500]
            if not chosen:
                state.update(status='waiting_for_new_verified_sources', pending_new_sources=0)
                builder.write_json(state_path, state)
                time.sleep(config.get('poll_seconds', 30)); continue
            token = clap.json_digest({'freeze': freeze, 'sources': [a['source_sha256'] for a in chosen]})[:24]
            directory = root / 'batches' / token
            directory.mkdir(parents=True, exist_ok=True)
            catalog = directory / 'catalog.json'
            if not catalog.exists():
                builder.write_json(catalog, {'assets': chosen, 'source_catalog': catalog_ref})
            state['active'] = {'token': token, 'catalog': str(catalog), 'out': str(directory / 'build'),
                               'source_hashes': [a['source_sha256'] for a in chosen]}
            state['status'] = 'encoding_new_sources'
            builder.write_json(state_path, state)
        active = state['active']
        directory = Path(active['catalog']).parent
        command = [config['python'], str(Path(builder.__file__).resolve()), '--catalog', active['catalog'],
                   '--weights', config['weights'], '--out', active['out'], '--device', 'cpu', '--batch-size', '4']
        env = {**os.environ, 'CUDA_VISIBLE_DEVICES': '', 'OMP_NUM_THREADS': '2',
               'MKL_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2'}
        with (directory / 'stdout.log').open('a', encoding='utf-8') as stdout, (directory / 'stderr.log').open('a', encoding='utf-8') as stderr:
            result = subprocess.run(command, stdout=stdout, stderr=stderr, env=env)
        if result.returncode:
            state.update(status='build_failed_requires_targeted_repair', exit_code=result.returncode)
            builder.write_json(state_path, state)
            return state
        report = Path(active['out']) / 'build-report.json'
        clap.load_index(Path(active['out']) / 'merged')
        state['indexes'].append(str(Path(active['out']) / 'merged'))
        state['build_reports'].append(ref(report))
        state['attempted_sources'] = sorted(set(state['attempted_sources']) | set(active['source_hashes']))
        state.update(active=None, status='running')
        publication = publish(root, state, freeze, assets)
        builder.write_json(state_path, state)
        print(json.dumps({'utc': publication['utc'], 'batch': active['token'],
            'encoded_windows': publication['encoded_windows'], 'encoded_unique_sources': publication['encoded_unique_sources'],
            'pending_new_sources': publication['pending_new_sources'], 'production_approval': False}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    run(read(parser.parse_args().config))
