"""Incremental three-window CLAP index; immutable batches and resume receipts.

Cache identity is source SHA + exact source range + model/processor binding.
The old index and library records are never edited. CPU retrieval remains exact.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time

import numpy as np
import clap_segment_features as clap


def write_json(path, value):
    temporary = Path(path).with_suffix(Path(path).suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def window_ranges(duration):
    if not isinstance(duration, (int, float)) or not np.isfinite(duration) or duration <= 0:
        raise ValueError('finite_positive_duration_required')
    length = min(10.0, duration)
    latest_start = math.floor(max(0.0, duration - length) * 1000) / 1000
    starts = [min(latest_start, round(max(0.0, min(duration - length, duration * fraction - length / 2)), 3))
              for fraction in (0.15, 0.5, 0.85)]
    return [[start, min(duration, round(start + length, 3))] for start in dict.fromkeys(starts)]


def cache_key(record):
    return (record['source_sha256'], tuple(record['source_range']))


def asset_duration(asset, path):
    duration = asset.get('duration_seconds')
    if isinstance(duration, (int, float)) and np.isfinite(duration) and duration > 0:
        return duration
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                             '-of', 'json', str(path)], check=True, capture_output=True, timeout=30)
    duration = float(json.loads(result.stdout)['format']['duration'])
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError('ffprobe_duration_invalid')
    return duration


def save_index(root, records, matrix, binding, runtime_info, pool, extra=None):
    root.mkdir(parents=True, exist_ok=False)
    np.save(root / 'audio.npy', np.asarray(matrix, dtype='float32'))
    document = {'schema': 'clap-window-features-v1', 'binding': binding, 'records': records,
                'records_sha256': clap.json_digest(records), 'audio_sha256': clap.digest(root / 'audio.npy'),
                'runtime': runtime_info, 'encoded_unique_sources': len({r['source_sha256'] for r in records}),
                'declared_pool_assets': len(pool),
                'unencoded_declared_assets': len(set(pool) - {r['asset_id'] for r in records}),
                'artistic_approval': False, 'phase_classification': False, **(extra or {})}
    write_json(root / 'index.json', document)
    return document


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_args


@gpu_slot_guard(lambda catalog, weights, out, prior=(), device='cuda', batch_size=16, shard_windows=500, gpu_slot=None: device,
                lambda catalog, weights, out, prior=(), device='cuda', batch_size=16, shard_windows=500, gpu_slot=None: gpu_slot)
def build(catalog, weights, out, prior=(), device='cuda', batch_size=16, shard_windows=500, gpu_slot=None):
    if type(batch_size) is not int or not 1 <= batch_size <= 64:
        raise ValueError('batch_size_from_1_to_64_required')
    started = time.perf_counter()
    catalog, out = Path(catalog).resolve(), Path(out).resolve()
    catalog_sha = clap.digest(catalog)
    assets = json.loads(catalog.read_text(encoding='utf-8-sig'))['assets']
    music = [a for a in assets if a.get('asset_kind') == 'music']
    if not music:
        raise ValueError('real_music_assets_required')
    pool = [a['asset_id'] for a in music]
    job = {'schema': 'incremental-three-window-job-v1', 'catalog': str(catalog),
           'catalog_sha256': catalog_sha, 'weights': str(Path(weights).resolve()),
           'prior': [str(Path(p).resolve()) for p in prior], 'fractions': [0.15, 0.5, 0.85]}
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'job.json').exists():
        if json.loads((out / 'job.json').read_text(encoding='utf-8')) != job:
            raise ValueError('resume_job_identity_mismatch')
    else:
        if any(out.iterdir()):
            raise ValueError('nonempty_unidentified_output_refused')
        write_json(out / 'job.json', job)
    if (out / 'merged/index.json').exists():
        index, _ = clap.load_index(out / 'merged')
        return {'status': 'complete_snapshot_reused', 'encoded_windows': len(index['records']),
                'encoded_unique_sources': index['encoded_unique_sources'], 'out': str(out)}
    loaded = clap.runtime(weights, device)
    torch, model, _, extractor, binding = loaded
    cache, cache_records, provenance = {}, {}, []
    existing_dirs = [Path(p) for p in prior] + sorted(out.glob('shard-*/'))
    for directory in existing_dirs:
        index, matrix = clap.load_index(directory)
        if index['binding'] != binding:
            raise ValueError('cached_model_processor_binding_mismatch')
        provenance.append({'path': str(directory.resolve()), 'index_sha256': clap.digest(directory / 'index.json')})
        for record, vector in zip(index['records'], matrix):
            key = cache_key(record)
            cache[key], cache_records[key] = vector.copy(), record
    prior_by_sha, prior_record_by_sha = {}, {}
    for cached_record in cache_records.values():
        prior_by_sha.setdefault(cached_record['source_sha256'], []).append(cached_record['source_range'])
        prior_record_by_sha.setdefault(cached_record['source_sha256'], cached_record)
    initial_cache_keys = set(cache)
    jobs, failures, source_stats = [], [], {}
    fresh_hashes, reused_source_stats = 0, 0
    for asset in music:
        try:
            path = Path(asset['local_path'])
            if not path.is_absolute():
                path = catalog.parent / path
            path = path.resolve(strict=True)
            sha = asset['source_sha256']
            if sha not in source_stats:
                before = path.stat()
                previous = prior_record_by_sha.get(sha)
                if previous and (previous.get('source_file_size'),previous.get('source_mtime_ns')) == (before.st_size,before.st_mtime_ns):
                    reused_source_stats += 1
                else:
                    if clap.digest(path) != sha:
                        raise ValueError('source_sha_mismatch')
                    fresh_hashes += 1
                after = path.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ValueError('source_changed_during_hash')
                source_stats[sha] = (after.st_size, after.st_mtime_ns)
            duration = asset_duration(asset, path)
            ranges = window_ranges(duration)
            old_ranges = prior_by_sha.get(sha, [])
            if len(ranges) == 3 and old_ranges:
                middle = min(old_ranges, key=lambda r: abs(sum(r)/2-duration/2))
                if (0 <= middle[0] < middle[1] <= duration and middle[1]-middle[0] <= 10 + 1e-9
                        and abs(sum(middle)/2-duration/2) <= 1):
                    ranges[1] = middle
            ranges = [list(window) for window in dict.fromkeys(tuple(window) for window in ranges)]
            for window in ranges:
                jobs.append({'segment_id': f"{asset['asset_id']}-clap-{window[0]:.3f}-{window[1]:.3f}",
                             'asset_id': asset['asset_id'], 'path': str(path), 'source_sha256': sha,
                             'source_range': window,
                             'source_file_size': source_stats[sha][0], 'source_mtime_ns': source_stats[sha][1],
                             'family_id': asset.get('family_id') or asset.get('source_family') or sha})
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failures.append({'asset_id': asset['asset_id'], 'stage': 'source_preflight', 'error': str(error)})
    print(json.dumps({'phase': 'sources_verified', 'music_assets': len(music), 'jobs': len(jobs),
                      'unique_verified_sources': len(source_stats), 'prior_cached_windows': len(cache),
                      'failures': len(failures)}), flush=True)
    pending = []
    seen = set(cache)
    for record in jobs:
        key = cache_key(record)
        if key not in seen:
            seen.add(key)
            pending.append(record)
    buffer_records, buffer_vectors = [], []
    batch_audio, batch_records = [], []
    shard_number = len(list(out.glob('shard-*'))) + 1
    def save_buffer():
        nonlocal shard_number, buffer_records, buffer_vectors
        if not buffer_records:
            return
        directory = out / f'shard-{shard_number:04d}'
        save_index(directory, buffer_records, buffer_vectors, binding,
                   {'device': device, 'batch_size': batch_size, 'torch_version': torch.__version__}, pool)
        print(json.dumps({'phase': 'shard_saved', 'shard': str(directory), 'cached_windows': len(cache),
                          'new_windows': len(buffer_records), 'failures': len(failures),
                          'elapsed_seconds': time.perf_counter()-started}), flush=True)
        shard_number += 1
        buffer_records, buffer_vectors = [], []
    def flush_batch():
        if not batch_audio:
            return
        features = extractor(batch_audio, sampling_rate=48000, truncation='rand_trunc', padding='pad', return_tensors='pt')
        with torch.inference_mode():
            matrix = model.get_audio_features(**{k: v.to(device) for k, v in features.items()}).cpu().numpy().astype('float32')
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        if matrix.shape != (len(batch_audio), 512) or not np.isfinite(matrix).all() or np.any(norms == 0):
            raise ValueError('invalid_audio_embedding_batch')
        matrix /= norms
        for record, vector in zip(batch_records, matrix):
            record['vector_sha256'] = hashlib.sha256(vector.tobytes()).hexdigest()
            cache[cache_key(record)], cache_records[cache_key(record)] = vector, record
            buffer_records.append(record); buffer_vectors.append(vector)
        batch_audio.clear(); batch_records.clear()
        if len(buffer_records) >= shard_windows:
            save_buffer()
    for record in pending:
        try:
            path = Path(record['path']); current = path.stat()
            if (current.st_size, current.st_mtime_ns) != source_stats[record['source_sha256']]:
                raise ValueError('source_changed_since_preflight')
            start, end = record['source_range']
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '2', '-ss', str(start),
                '-i', str(path), '-t', str(end-start), '-map', '0:a:0', '-ac', '1', '-ar', '48000',
                '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], check=True, capture_output=True, timeout=30).stdout
            audio = np.frombuffer(raw, dtype='<f4').copy()
            after = path.stat()
            if (after.st_size, after.st_mtime_ns) != source_stats[record['source_sha256']]:
                raise ValueError('source_changed_during_decode')
            if abs(len(audio) - round((end-start)*48000)) > 1 or not len(audio) or not np.isfinite(audio).all():
                raise ValueError('decoded_window_shape_or_values_invalid')
            if not np.any(audio):
                raise ValueError('actual_all_zero_window')
            batch_records.append({**record, 'decoded_pcm_sha256': hashlib.sha256(raw).hexdigest(),
                                  'samples': len(audio), 'listening_status': 'pending'})
            batch_audio.append(audio)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            failures.append({'asset_id': record['asset_id'], 'source_range': record['source_range'],
                             'stage': 'window_decode', 'error': str(error)})
        if len(batch_audio) >= batch_size:
            flush_batch()
    flush_batch(); save_buffer()
    records, vectors = [], []
    pending_keys = {cache_key(r) for r in pending}
    reused = 0
    for job_record in jobs:
        key = cache_key(job_record)
        if key not in cache:
            continue
        prior_record = cache_records[key]
        records.append({**prior_record, **job_record})
        vectors.append(cache[key]); reused += key not in pending_keys
    if not records:
        raise ValueError('no_actual_encoded_windows')
    if clap.digest(catalog) != catalog_sha:
        raise ValueError('catalog_changed_during_encoding')
    index = save_index(out / 'merged', records, vectors, binding,
        {'device': device, 'batch_size': batch_size, 'torch_version': torch.__version__,
         'cuda_peak_allocated_bytes': torch.cuda.max_memory_allocated() if device == 'cuda' else 0},
        pool, {'source_shards': provenance, 'catalog_sha256': catalog_sha,
               'phase_classification': False, 'window_sampling': 'three_temporal_representatives_not_phrase_boundaries'})
    clap.load_index(out / 'merged')
    report = {'schema': 'actual-music-three-window-build-v1', 'status': 'complete_with_gaps' if failures else 'complete',
              'music_asset_ids': len(music), 'music_unique_source_hashes': len({a['source_sha256'] for a in music}),
              'verified_distinct_compositions': 'unknown', 'requested_windows': len(jobs),
              'encoded_windows': len(records), 'encoded_unique_sources': index['encoded_unique_sources'],
              'cached_window_rows_reused': int(reused), 'new_unique_windows_encoded': len(set(cache)-initial_cache_keys),
              'missing_asset_ids': sorted(set(pool)-{r['asset_id'] for r in records}), 'failures': failures,
              'out': str(out / 'merged'), 'elapsed_seconds': time.perf_counter()-started,
              'source_verification': 'hash_new_or_changed_sources; reuse_validated_snapshot_stats; stat_check_each_window',
              'fresh_source_hashes_verified': fresh_hashes, 'validated_prior_source_stats_reused': reused_source_stats,
              'query_audio_rehash_policy': 'explicit_selected_sources_only',
              'artistic_approval': False, 'phase_classification': False, 'target_60000_works_achieved': False}
    write_json(out / 'build-report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('catalog', 'weights', 'out'):
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--prior', nargs='*', default=[], type=Path)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cuda')
    add_slot_arguments(parser)
    parser.add_argument('--batch-size', type=int, default=16)
    args = parser.parse_args()
    print(json.dumps(build(args.catalog, args.weights, args.out, args.prior, args.device, args.batch_size,
                           gpu_slot=slot_binding_from_args(args))), flush=True)


if __name__ == '__main__':
    main()
