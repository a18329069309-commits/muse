"""Resume official MTG acquisition and <=500-source research-only indexing batches.

Reuses verified acquisition receipts, old asset identities and official checksums.
Audio stays on the configured media volume; fresh SQLite snapshots stay local.
Two same-host downloads at most; two CPU decoders; no models or paid APIs.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from queue import Queue
import re
import shutil
import threading
import time

import acquire_mtg_shards as acquire
import prepare_mtg_batch as prepare
from extend_mtg_music_batch import select_new_records


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def binding(path):
    return {'path': str(Path(path).resolve()), 'sha256': acquire.digest(path)}


def remaining_shards(metadata, checksums, assets):
    ids = {a['asset_id'] for a in assets}
    hashes = {a['source_sha256'] for a in assets}
    remaining = {}
    for identifier, row in metadata.items():
        member = row['source_archive_path'].replace('.mp3', '.low.mp3')
        sha = checksums.get(member)
        if sha is None:
            raise ValueError('official_metadata_track_has_no_checksum')
        if f'mtg-full-low-{identifier}' in ids or sha in hashes:
            continue
        remaining.setdefault(int(member.split('/')[0]), []).append(identifier)
    return remaining


def valid_receipt(path, revision):
    value = load(path)
    if value.get('complete') is not True or value.get('failures') or value.get('official_revision') != revision:
        raise ValueError('complete_pinned_acquisition_required')
    return value


def pending_batches(missing, media_root):
    batches = [missing[i:i + 2] for i in range(0, len(missing), 2)]
    def needs_download(shards):
        root = Path(media_root) / ('shards-' + '-'.join(f'{s:02}' for s in shards))
        return not all((root / 'archives' / f'raw_30s_audio-low-{s:02}.tar').is_file() for s in shards)
    # Existing archives still receive publisher SHA validation in acquire().
    return sorted(batches, key=needs_download)


def consume_receipt(file, metadata, state, config, emit):
    report = valid_receipt(file, config['official_revision'])
    licenses = prepare.read_licenses(Path(file).parent / 'provenance/audio_licenses.txt')
    rejected = set()
    while True:
        base = Path(state['latest_library'])
        assets = load(base / 'catalog-assets.json')['assets']
        records = [r for r in report['records'] if r['source_sha256'] not in rejected]
        chosen = select_new_records(records, assets, metadata, licenses, 500)
        if not chosen:
            return
        # Selection identity changes with the base; resumptions never overwrite old evidence.
        token = hashlib.sha256(json.dumps([binding(base / 'segments.sqlite'),
            [[r['source_track_id'], r['source_sha256']] for r in chosen]], sort_keys=True).encode()).hexdigest()[:20]
        selected_file = Path(file).parent / ('acquisition-queue-selected-' + token + '.json')
        selection = {**report, 'records': chosen, 'selection_scope': 'continuous_new_unique_source_files',
                     'full_acquisition_receipt': binding(file), 'selected_unique_sources': len(chosen)}
        if selected_file.exists():
            if load(selected_file) != selection:
                raise ValueError('selection_identity_changed')
        else:
            acquire.write_json(selected_file, selection)
        directory = Path(config['index_root']) / ('batch-' + token)
        if directory.exists():
            # An interrupted preparation is preserved, never promoted without its terminal report.
            directory = directory.with_name(directory.name + '-recovery-' + str(time.time_ns()))
        if shutil.disk_usage(Path(config['index_root'])).free < 2 * 1024 ** 3:
            raise ValueError('local_index_volume_below_2GiB_reserve')
        emit({'index_started': token, 'selected_sources': len(chosen), 'base': str(base)})
        try:
            result = prepare.prepare_batch(selected_file, Path(config['source_db']), base / 'segments.sqlite',
                base / 'catalog-assets.json', base / 'segments.json', directory, workers=2)
        except Exception as error:
            rejected.update(r['source_sha256'] for r in chosen)
            emit({'index_failed': token, 'error_type': type(error).__name__, 'error': str(error),
                  'source_ids_pending': [r['source_track_id'] for r in chosen]})
            continue
        failed_ids = {r['source_track_id'] for r in result['failed_media'] + result['quarantined_metadata']}
        rejected.update(r['source_sha256'] for r in chosen if r['source_track_id'] in failed_ids)
        freeze = {name: binding(directory / name) for name in
                  ('segments.sqlite', 'catalog-assets.json', 'segments.json', 'prepare-library-report.json')}
        evidence = {'schema_version': 1, 'batch': token, 'source_acquisition': binding(file),
                    'selected_acquisition': binding(selected_file), 'freeze': freeze,
                    'new_unique_file_hashes': result['new_file_hashes_not_in_base'],
                    'music_asset_ids': result['music_asset_ids'],
                    'music_unique_file_hashes': result['music_unique_file_hashes'],
                    'stock_unique_file_hashes': result['stock_unique_file_hashes'],
                    'source_duration_summary_seconds': {
                        'min': min(a['duration_seconds'] for a in load(directory / 'new-assets.json')['assets']),
                        'max': max(a['duration_seconds'] for a in load(directory / 'new-assets.json')['assets'])},
                    'old_audio_rehashed_or_decoded': result['old_audio_rehashed_or_decoded'],
                    'qualified': False, 'production_approval': False, 'new_clap_vectors': 0,
                    'distinct_compositions_verified': 'unknown', 'target_60000_achieved': False}
        acquire.write_json(Path(config['evidence_root']) / ('batch-' + token + '.json'), evidence)
        state.update(latest_library=str(directory), latest_freeze=freeze,
                     indexed_batches=state.get('indexed_batches', 0) + 1,
                     new_unique_files=state.get('new_unique_files', 0) + result['new_file_hashes_not_in_base'])
        emit({'index_completed': token, **{k: evidence[k] for k in
            ('new_unique_file_hashes', 'music_asset_ids', 'music_unique_file_hashes', 'old_audio_rehashed_or_decoded')}})


def run(config):
    if not re.fullmatch(r'[a-f0-9]{40}', config['official_revision']):
        raise ValueError('pinned_official_revision_required')
    for name in ('index_root', 'evidence_root', 'media_root', 'state_dir'):
        Path(config[name]).mkdir(parents=True, exist_ok=True)
    if Path(config['index_root']).drive.upper() != 'D:':
        raise ValueError('SQLite_index_requires_local_D_volume')
    state_file = Path(config['state_dir']) / 'state.json'
    identity = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    state = load(state_file) if state_file.exists() else {
        'config_sha256': identity, 'latest_library': config['base_library'], 'indexed_batches': 0, 'new_unique_files': 0}
    if state['config_sha256'] != identity:
        raise ValueError('queue_config_changed')
    for record in state.get('latest_freeze', {}).values():
        if acquire.digest(record['path']) != record['sha256']:
            raise ValueError('previous_index_snapshot_changed')
    state.update(status='running', pid=os.getpid(), downloads_max_same_host=2, decode_workers=2,
                 gpu_calls=0, model_calls=0, paid_calls=0, production_approval=False, http_backend='curl')
    lock = threading.Lock()
    def emit(value):
        row = {'utc': datetime.now(timezone.utc).isoformat(), **value}
        with lock:
            with (Path(config['evidence_root']) / 'events.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + '\n')
            state['last_event'] = row
            state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(row, ensure_ascii=False), flush=True)
    provenance = Path(config['metadata_receipt'])
    valid_receipt(provenance, config['official_revision'])
    metadata = prepare.source_records(Path(config['source_db']))
    checksums = acquire.checksum_map(provenance.parent / 'provenance/raw_30s_audio-low_sha256_tracks.txt')
    assets = load(Path(state['latest_library']) / 'catalog-assets.json')['assets']
    remaining = remaining_shards(metadata, checksums, assets)
    ready, covered = [], set()
    receipts = config['acquisition_receipts'] + [str(p) for p in Path(config['media_root']).glob('*/acquisition-report.json')]
    for file in dict.fromkeys(receipts):
        result = valid_receipt(file, config['official_revision'])
        shards = {int(re.search(r'-(\d{2})\.tar$', x)[1]) for x in result['requested_archives']}
        covered.update(shards)
        if shards.intersection(remaining):
            ready.append(file)
    missing = sorted(set(remaining) - covered)
    plan = {'metadata_track_records': len(metadata), 'remaining_track_ids': sum(map(len, remaining.values())),
            'remaining_by_shard': {str(k): len(v) for k, v in remaining.items()},
            'ready_receipts': [binding(f) for f in ready], 'missing_shards': missing,
            'single_source_below_60000': len(metadata) < 60000, 'generated_or_slice_counts_used': False}
    plan_file = Path(config['evidence_root']) / ('plan-' + str(time.time_ns()) + '.json')
    acquire.write_json(plan_file, plan)
    emit({'queue_started': os.getpid(), 'plan': binding(plan_file), 'ready_receipts': len(ready),
          'missing_shards': len(missing), 'remaining_track_ids': plan['remaining_track_ids']})
    incoming = Queue(maxsize=2)
    def producer():
        try:
            for shards in pending_batches(missing, config['media_root']):
                out = Path(config['media_root']) / ('shards-' + '-'.join(f'{s:02}' for s in shards))
                report_path = out / 'acquisition-report.json'
                try:
                    result = valid_receipt(report_path, config['official_revision']) if report_path.exists() else acquire.acquire(
                        shards, out, config['official_revision'], metadata_receipt=config['metadata_receipt'], http_backend='curl')
                    if result['complete']:
                        incoming.put(str(report_path))
                    else:
                        emit({'acquisition_incomplete': shards, 'failures': result['failures']})
                except Exception as error:
                    emit({'acquisition_failed': shards, 'error_type': type(error).__name__, 'error': str(error)})
        finally:
            incoming.put(None)
    def consume(file):
        try:
            consume_receipt(file, metadata, state, config, emit)
        except Exception as error:
            emit({'receipt_processing_failed': str(file), 'error_type': type(error).__name__,
                  'error': str(error), 'source_status': 'pending_not_complete'})
    if ready:
        before = state['indexed_batches']
        consume(ready.pop(0))
        if state['indexed_batches'] == before:
            state['status'] = 'pilot_index_failed_or_no_eligible_sources'
            emit({'pilot_failed': state['status'], 'continuous_downloads_started': False})
            return
        emit({'pilot_passed': True, 'continuous_downloads_started': False,
              'latest_freeze': state['latest_freeze']})
    thread = threading.Thread(target=producer, name='official-mtg-downloads')
    thread.start()
    for file in ready:
        consume(file)
    while True:
        file = incoming.get()
        if file is None:
            break
        consume(file)
    thread.join()
    latest = load(Path(state['latest_library']) / 'catalog-assets.json')['assets']
    gaps = remaining_shards(metadata, checksums, latest)
    state.update(status='source_queue_exhausted_with_gaps' if gaps else 'source_queue_exhausted',
                 source_track_ids_pending=sum(map(len, gaps.values())), target_60000_achieved=False,
                 target_music_recordings=60000, qualified_music_packs_added=0)
    emit({'queue_finished': state['status'], 'pending_official_tracks': state['source_track_ids_pending'],
          'target_60000_achieved': False, 'production_approval': False})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    run(load(parser.parse_args().config))
