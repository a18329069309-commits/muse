"""Freeze an independent CLAP index without changing the music publication.

Only <=10-second representative audio is encoded. Outer search windows remain
separate identities and gain no sound, lyric, phrase, or usage approval.
Existing vectors may be reused only for the exact SHA/range encoded previously.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import time

import numpy as np
from clap_segment_features import digest, json_digest, load_index, runtime
from gpu_single_slot import gpu_slot_guard, slot_binding_from_args, add_slot_arguments


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def checked_json(binding):
    if digest(binding['path']) != binding['sha256']:
        raise ValueError('Frozen input SHA mismatch: ' + binding['path'])
    return json.loads(Path(binding['path']).read_text(encoding='utf-8-sig'))


def plan_representatives(windows, old_index):
    by_sha, seen, result = {}, set(), []
    for row, record in enumerate(old_index['records']):
        by_sha.setdefault(record['source_sha256'], []).append((row, record))
    for window in windows:
        identifier = window['segment_id']
        if identifier in seen:
            raise ValueError('Duplicate frozen window ID')
        seen.add(identifier)
        start, end = window['source_range']
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
                   for x in (start, end)) or not 0 <= start < end:
            raise ValueError('Invalid target window range')
        center = (start + end) / 2
        # New PCM catalogues may supply their exact decoded sample clock.
        # Keep legacy planning unchanged when the explicit field is absent.
        preferred = window.get('clap_representative_range')
        if preferred is not None and (not isinstance(preferred, list) or len(preferred) != 2 or
                any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x)
                    for x in preferred) or not start <= preferred[0] < preferred[1] <= end or
                preferred[1] - preferred[0] > 10):
            raise ValueError('Invalid exact PCM representative range')
        contained = [(row, record) for row, record in by_sha.get(window['source_sha256'], [])
                     if start <= record['source_range'][0] < record['source_range'][1] <= end
                     and record['source_range'][1] - record['source_range'][0] <= 10 + 1e-9]
        if contained:
            row, record = min(contained, key=lambda pair: (
                abs(sum(pair[1]['source_range']) / 2 - center), pair[1]['source_range'][0], pair[0]))
            representative = list(record['source_range'])
        else:
            row = None
            length = min(10, end - start)
            representative = list(preferred) if preferred is not None else [
                round(center - length / 2, 9), round(center + length / 2, 9)]
        result.append({'segment_id': identifier, 'asset_id': window['asset_id'],
            'path': window.get('local_path') or window['path'], 'source_sha256': window['source_sha256'],
            'source_range': representative, 'target_window_range': list(window['source_range']),
            'family_id': window.get('recording_family_id') or window.get('family_id') or window['source_sha256'],
            'reused_row': row, 'whole_window_encoded': False,
            'representative_basis': 'exact_existing_encoded_range' if row is not None else (
                'exact_pcm_clock_representative' if preferred is not None else 'unverified_center_10_seconds')})
    return result


def decode(job):
    start, end = job['source_range']
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-threads', '1', '-i', job['path'],
        '-ss', str(start), '-t', str(end - start), '-map', '0:a:0', '-ac', '1', '-ar', '48000',
        '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], check=True, capture_output=True, timeout=60).stdout
    audio = np.frombuffer(raw, dtype='<f4').copy()
    if abs(len(audio) - round((end - start) * 48000)) > 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Decoded PCM does not cover representative range')
    return audio, hashlib.sha256(raw).hexdigest(), len(audio)


def source_state(job):
    stat = Path(job['path']).stat()
    return {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}


def validate_cached_vector(job, evidence, target, binding):
    identity = json_digest({key: job[key] for key in ('source_sha256', 'source_range')})
    if evidence.get('identity') != identity or evidence.get('source_sha256') != job['source_sha256'] or \
            evidence.get('source_range') != job['source_range'] or \
            evidence.get('model_binding_sha256') != json_digest(binding) or \
            digest(target) != evidence.get('vector_file_sha256'):
        raise ValueError('Cached representative vector binding changed')
    vector = np.load(target, allow_pickle=False)
    if vector.shape != (512,) or vector.dtype != np.dtype('float32') or not np.isfinite(vector).all() or \
            not np.isclose(np.linalg.norm(vector), 1, atol=1e-5) or \
            hashlib.sha256(vector.tobytes()).hexdigest() != evidence.get('vector_sha256'):
        raise ValueError('Cached representative vector content changed')
    return vector


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def build(args):
    started = time.perf_counter()
    publication_binding = {'path': str(Path(args.publication).resolve()), 'sha256': args.publication_sha256}
    publication = checked_json(publication_binding)
    windows = checked_json(publication['segments'])['segments']
    assets = {asset['asset_id']: asset for asset in checked_json(publication['assets'])['assets']}
    for window in windows:
        asset = assets[window['asset_id']]
        if window['source_sha256'] != asset['source_sha256']:
            raise ValueError('Frozen window/asset SHA mismatch')
        window['family_id'] = asset.get('recording_family_id') or asset.get('family_id')
    old_binding = {'index': {'path': str(Path(args.reuse_index) / 'index.json'), 'sha256': args.reuse_index_sha256},
                   'audio': {'path': str(Path(args.reuse_index) / 'audio.npy'), 'sha256': args.reuse_audio_sha256}}
    checked_json(old_binding['index'])
    if digest(old_binding['audio']['path']) != old_binding['audio']['sha256']:
        raise ValueError('Reuse vectors SHA mismatch')
    old_index, old_vectors = load_index(args.reuse_index)
    plan = plan_representatives(windows, old_index)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    work = out / 'work' / json_digest({'publication': publication_binding, 'reuse': old_binding})[:20]
    work.mkdir(parents=True, exist_ok=True)
    summary = {'schema_version': 1, 'publication': publication_binding, 'reused_index': old_binding,
               'target_windows': len(plan), 'reused_windows': sum(job['reused_row'] is not None for job in plan),
               'new_windows': sum(job['reused_row'] is None for job in plan),
               'representation_max_seconds': 10, 'artistic_approval': False, 'whole_window_encoded': False}
    write_json(work / 'plan.json', {'summary': summary, 'jobs': plan})
    print(json.dumps({'stage': 'plan', **summary}), flush=True)
    if args.plan_only:
        return summary
    torch, model, _, extractor, binding = runtime(args.weights, args.device)
    if binding != {key: value for key, value in old_index['binding'].items() if key != 'device'}:
        raise ValueError('Cannot mix vectors from different CLAP model/processor')
    unique = {job['source_sha256']: job for job in plan}
    verify_unique = unique if not args.probe_limit else {
        job['source_sha256']: job for job in [item for item in plan if item['reused_row'] is None][:args.probe_limit]}
    # Hash each actual recording once rather than once per overlapping window.
    states = {}
    def verify(job):
        before = source_state(job)
        if digest(job['path']) != job['source_sha256'] or source_state(job) != before:
            raise ValueError('Actual source identity changed: ' + job['path'])
        return job['source_sha256'], before
    with ThreadPoolExecutor(max_workers=getattr(args, 'decode_workers', 2)) as io:
        states.update(io.map(verify, verify_unique.values()))
    print(json.dumps({'stage': 'source_verified', 'actual_unique_recordings': len(states)}), flush=True)
    cache = Path(args.shared_encoded_cache) if getattr(args, 'shared_encoded_cache', None) else work / 'encoded'
    cache.mkdir(exist_ok=True)
    records, vectors, mapping, pending = [], [], [], []
    for job in plan:
        row = job['reused_row']
        identity = json_digest({key: job[key] for key in ('source_sha256', 'source_range')})
        cached = cache / (identity + '.json')
        if row is None and not cached.is_file():
            pending.append((job, identity))
    # A probe runs genuine CUDA forward without creating a complete publication.
    pending = pending[:args.probe_limit] if args.probe_limit else pending
    if getattr(args, 'cache_only', False) and pending:
        raise ValueError('Read-only subset cache is incomplete; no new model forward was attempted')
    with ThreadPoolExecutor(max_workers=getattr(args, 'decode_workers', 2)) as io:
        for offset in range(0, len(pending), args.batch_size):
            batch = pending[offset:offset + args.batch_size]
            decoded = list(io.map(decode, [job for job, _ in batch]))
            for job, _ in batch:
                if source_state(job) != states[job['source_sha256']]:
                    raise ValueError('Source changed while preparing representative PCM')
            features = extractor([audio for audio, _, _ in decoded], sampling_rate=48000,
                                 truncation='rand_trunc', padding='pad', return_tensors='pt')
            with torch.inference_mode():
                matrix = model.get_audio_features(**{key: value.to(args.device) for key, value in features.items()})
                matrix = matrix.cpu().numpy().astype('float32')
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            if matrix.shape != (len(batch), 512) or not np.isfinite(matrix).all() or np.any(norms == 0):
                raise ValueError('Invalid CLAP forward result')
            matrix /= norms
            for (job, identity), (_, pcm_sha, samples), vector in zip(batch, decoded, matrix):
                target = cache / (identity + '.npy')
                np.save(target, vector)
                write_json(cache / (identity + '.json'), {'identity': identity, 'source_sha256': job['source_sha256'],
                    'source_range': job['source_range'], 'model_binding_sha256': json_digest(binding),
                    'vector_file_sha256': digest(target), 'vector_sha256': hashlib.sha256(vector.tobytes()).hexdigest(),
                    'decoded_pcm_sha256': pcm_sha, 'samples': samples, 'actual_device': args.device,
                    'source_stat': states[job['source_sha256']]})
            print(json.dumps({'stage': 'encoding', 'new_this_run_completed': offset + len(batch),
                              'new_this_run_total': len(pending), 'elapsed_seconds': time.perf_counter() - started}), flush=True)
    if args.probe_limit:
        write_json(work / 'cuda-probe.json', {'actual_audio_forward': True, 'device': args.device,
            'new_vectors': len(pending), 'cuda_peak_allocated_bytes': torch.cuda.max_memory_allocated()
            if args.device == 'cuda' else 0, 'model_binding': binding, 'artistic_approval': False})
        return {'probe_completed': True, 'work': str(work), 'encoded_new': len(pending)}
    for job in plan:
        row = job['reused_row']
        if row is not None:
            vector, evidence = old_vectors[row].copy(), old_index['records'][row]
        else:
            identity = json_digest({key: job[key] for key in ('source_sha256', 'source_range')})
            target = cache / (identity + '.npy')
            evidence = json.loads((cache / (identity + '.json')).read_text(encoding='utf-8'))
            vector = validate_cached_vector(job, evidence, target, binding)
        record = {key: job[key] for key in ('segment_id', 'asset_id', 'path', 'source_sha256', 'source_range', 'family_id')}
        record.update(decoded_pcm_sha256=evidence['decoded_pcm_sha256'], samples=evidence['samples'],
                      target_window_range=job['target_window_range'],
                      vector_sha256=hashlib.sha256(vector.tobytes()).hexdigest(), listening_status='pending',
                      source_file_size=states[job['source_sha256']]['size'],
                      source_mtime_ns=states[job['source_sha256']]['mtime_ns'])
        if record['vector_sha256'] != evidence['vector_sha256']:
            raise ValueError('Representative vector content hash mismatch')
        records.append(record)
        vectors.append(vector)
        mapping.append({'segment_id': job['segment_id'], 'asset_id': job['asset_id'],
            'source_sha256': job['source_sha256'], 'source_range': job['target_window_range'],
            'representative_source_range': job['source_range'], 'vector_sha256': record['vector_sha256'],
            'reused_row': row, 'whole_window_encoded': False, 'artistic_approval': False})
    for job in unique.values():
        if source_state(job) != states[job['source_sha256']]:
            raise ValueError('Source changed before index freeze')
    index = {'schema': 'clap-window-features-v1', 'binding': binding, 'records': records,
             'records_sha256': json_digest(records), 'encoded_unique_sources': len(unique),
             'declared_pool_assets': len(assets), 'unencoded_declared_assets': 0,
             'artistic_approval': False, 'phase_classification': False,
             'runtime': {'device': args.device, 'batch_size': args.batch_size, 'torch_version': torch.__version__,
                         'cuda_peak_allocated_bytes': torch.cuda.max_memory_allocated() if args.device == 'cuda' else 0},
             'representation_max_seconds': 10, 'whole_window_encoded': False}
    stage = work / 'complete'
    stage.mkdir(exist_ok=True)
    np.save(stage / 'audio.npy', np.stack(vectors))
    index['audio_sha256'] = digest(stage / 'audio.npy')
    write_json(stage / 'index.json', index)
    write_json(stage / 'window-mapping.json', {'schema_version': 1, 'kind': 'independent_clap_window_mapping',
               'publication': publication_binding, 'records': mapping, 'whole_window_encoded': False})
    # Validate row identity, vector integrity, source ranges and normalization.
    load_index(stage)
    snapshot_id = json_digest({'publication': publication_binding, 'index_sha256': digest(stage / 'index.json'),
                               'audio_sha256': index['audio_sha256'], 'mapping_sha256': digest(stage / 'window-mapping.json')})
    snapshot = out / 'snapshots' / snapshot_id[:20]
    if snapshot.exists():
        raise ValueError('Refusing to overwrite existing vector snapshot')
    snapshot.mkdir(parents=True)
    for filename in ('index.json', 'audio.npy', 'window-mapping.json'):
        shutil.copyfile(stage / filename, snapshot / filename)
    freeze = {**summary, 'kind': 'independent_resident_clap_snapshot', 'snapshot_id': snapshot_id,
        'music_publication': publication_binding, 'model_binding': binding,
        'elapsed_seconds': time.perf_counter() - started,
        **{key: {'path': str(snapshot / filename), 'sha256': digest(snapshot / filename)}
           for key, filename in [('index', 'index.json'), ('audio', 'audio.npy'), ('mapping', 'window-mapping.json')]}}
    write_json(snapshot / 'snapshot.json', freeze)
    result = {'path': str(snapshot / 'snapshot.json'), 'sha256': digest(snapshot / 'snapshot.json'),
              'encoded_windows': len(records), 'new_encoded_windows': summary['new_windows'],
              'reused_encoded_windows': summary['reused_windows'], 'artistic_approval': False}
    write_json(out / 'current-snapshot.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('publication', 'publication-sha256', 'reuse-index', 'reuse-index-sha256',
                 'reuse-audio-sha256', 'weights', 'out'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cuda')
    add_slot_arguments(parser)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--decode-workers', type=int, choices=[1, 2], default=2)
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--probe-limit', type=int, default=0)
    parser.add_argument('--shared-encoded-cache', help='Reuse exact SHA/range/model-bound per-window vectors from a completed or ongoing build')
    parser.add_argument('--cache-only', action='store_true', help='Never encode a missing vector; useful for a separately bound subset release')
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 8 or args.probe_limit < 0:
        raise ValueError('Encoding batch must be 1..8 and probe limit nonnegative')
    print(json.dumps(build(args)), flush=True)


if __name__ == '__main__':
    main()
