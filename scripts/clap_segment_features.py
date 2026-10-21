"""Local CLAP window features and text recall; similarity is not artistic approval.

encode --weights LOCAL_DIR --jobs jobs.json --out NEW_DIR
search --weights LOCAL_DIR --index INDEX_DIR --text DESCRIPTION [--limit 3]
Jobs need segment_id, asset_id, path, source_sha256, source_range=[start,end].
Optional candidate_pool_asset_ids counts declared unencoded sources, not audio files.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
os.environ.update(OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
import numpy as np


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            result.update(chunk)
    return result.hexdigest()


def json_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def validate_jobs(document, verify_audio=True):
    jobs, seen, sources, verified = document.get('jobs'), set(), {}, set()
    if not isinstance(jobs, list) or not jobs:
        raise ValueError('jobs must be a nonempty array')
    for job in jobs:
        for key in ['segment_id', 'asset_id', 'path']:
            if not isinstance(job.get(key), str) or not job[key].strip():
                raise ValueError(f'{key} must be nonempty')
        if job['segment_id'] in seen:
            raise ValueError('Duplicate segment_id')
        seen.add(job['segment_id'])
        if not re.fullmatch('[0-9a-f]{64}', str(job.get('source_sha256', ''))):
            raise ValueError('Invalid source_sha256')
        window = job.get('source_range')
        if not isinstance(window, list) or len(window) != 2 or any(
                isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in window):
            raise ValueError('Invalid source_range')
        if not 0 <= window[0] < window[1] or window[1] - window[0] > 10 + 1e-9:
            raise ValueError('Window must be positive and at most 10 seconds')
        # Stored vectors already bind the exact source path in signed records.
        # Reading an index must not resolve every offline/network audio file.
        binding = (str(Path(job['path']).resolve()) if verify_audio else job['path'], job['source_sha256'])
        if verify_audio:
            job['path'] = binding[0]
        if job['asset_id'] in sources and sources[job['asset_id']] != binding:
            raise ValueError('Conflicting asset identity')
        if verify_audio and binding not in verified:
            if digest(binding[0]) != binding[1]:
                raise ValueError('Source SHA does not match actual file')
            verified.add(binding)
        sources[job['asset_id']] = binding
    pool = document.get('candidate_pool_asset_ids')
    if pool is not None and (not isinstance(pool, list) or any(
            not isinstance(x, str) or not x.strip() for x in pool) or len(set(pool)) != len(pool)
            or not set(sources).issubset(pool)):
        raise ValueError('Invalid declared candidate pool')
    return jobs, len(pool) if pool is not None else None


from gpu_single_slot import (gpu_slot_guard, require_gpu_slot, add_slot_arguments,
                             slot_binding_from_args, gpu_slot_scope)


def runtime(weights, device='cpu'):
    require_gpu_slot(device)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_IMPLICIT_TOKEN='1', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2')
    import torch
    from transformers import AutoTokenizer, ClapFeatureExtractor, ClapModel
    if device not in ['cpu', 'cuda'] or device == 'cuda' and not torch.cuda.is_available():
        raise ValueError('Requested device is unavailable; no CPU fallback')
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    weights = Path(weights).resolve(strict=True)
    safetensors = (weights / 'model.safetensors').is_file()
    filename = 'model.safetensors' if safetensors else 'pytorch_model.bin'
    files = [filename, 'config.json', 'tokenizer.json', 'tokenizer_config.json',
             'special_tokens_map.json', 'vocab.json', 'merges.txt']
    binding = {name: digest(weights / name) for name in files if (weights / name).is_file()}
    if filename not in binding or 'config.json' not in binding:
        raise ValueError('Local single-file CLAP weights and config are required')
    torch.set_num_threads(2)
    model = ClapModel.from_pretrained(weights, local_files_only=True, token=False,
                                     use_safetensors=safetensors).to(device).eval()
    if {p.device.type for p in model.parameters()} != {device} or model.config.projection_dim != 512 or model.config.audio_config.enable_fusion:
        raise ValueError('Expected requested-device CLAP with 512-dimensional projection')
    tokenizer = AutoTokenizer.from_pretrained(weights, local_files_only=True, token=False)
    extractor = ClapFeatureExtractor(sampling_rate=48000, max_length_s=10)
    processor = {**extractor.to_dict(), 'actual_truncation': 'rand_trunc', 'actual_padding': 'pad'}
    return torch, model, tokenizer, extractor, {'model_files': binding,
            'processor': processor, 'processor_sha256': json_digest(processor)}


@gpu_slot_guard(lambda args: getattr(args, 'device', 'cpu'), slot_binding_from_args)
def encode(args):
    started = time.perf_counter()
    device, batch_size = getattr(args, 'device', 'cpu'), getattr(args, 'batch_size', 1)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError('batch_size must be a positive integer')
    jobs, pool = validate_jobs(json.loads(Path(args.jobs).read_text(encoding='utf-8-sig')))
    out = Path(args.out)
    if out.exists():
        raise ValueError('Refusing to overwrite output directory')
    torch, model, _, extractor, binding = runtime(args.weights, device)
    records, vectors, batch_audio = [], [], []
    for job in jobs:
        start, end = job['source_range']
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '2', '-i', job['path'],
            '-ss', str(start), '-t', str(end-start), '-map', '0:a:0', '-ac', '1', '-ar', '48000',
            '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], check=True, capture_output=True, timeout=30).stdout
        audio = np.frombuffer(raw, dtype='<f4').copy()
        if digest(job['path']) != job['source_sha256']:
            raise ValueError('Source changed during encoding')
        expected = round((end-start) * 48000)
        if abs(len(audio)-expected) > 1 or not len(audio) or not np.isfinite(audio).all():
            raise ValueError('Decoded audio does not match requested window')
        records.append({key: job[key] for key in ['segment_id', 'asset_id', 'path', 'source_sha256', 'source_range']})
        if job.get('family_id'):
            records[-1]['family_id'] = job['family_id']
        records[-1].update(decoded_pcm_sha256=hashlib.sha256(raw).hexdigest(), samples=len(audio),
                           listening_status='pending')
        batch_audio.append(audio)
        if len(batch_audio) == batch_size or len(records) == len(jobs):
            features = extractor(batch_audio, sampling_rate=48000, truncation='rand_trunc', padding='pad', return_tensors='pt')
            with torch.inference_mode():
                matrix = model.get_audio_features(**{k: v.to(device) for k, v in features.items()}).cpu().numpy().astype('float32')
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            if matrix.shape != (len(batch_audio), 512) or not np.isfinite(matrix).all() or np.any(norms == 0):
                raise ValueError('Invalid audio embedding')
            matrix /= norms
            for vector in matrix:
                records[len(vectors)]['vector_sha256'] = hashlib.sha256(vector.tobytes()).hexdigest()
                vectors.append(vector)
            batch_audio.clear()
    out.mkdir(parents=True)
    np.save(out / 'audio.npy', np.stack(vectors))
    index = {'schema': 'clap-window-features-v1', 'binding': binding, 'records': records,
             'runtime': {'device': device, 'batch_size': batch_size, 'torch_version': torch.__version__,
                         'cuda_peak_allocated_bytes': torch.cuda.max_memory_allocated() if device == 'cuda' else 0},
             'records_sha256': json_digest(records), 'audio_sha256': digest(out / 'audio.npy'),
             'encoded_unique_sources': len({x['source_sha256'] for x in records}),
             'declared_pool_assets': pool, 'unencoded_declared_assets': None if pool is None else pool-len({x['asset_id'] for x in records}),
             'artistic_approval': False, 'phase_classification': False, 'elapsed_seconds': time.perf_counter()-started}
    (out / 'index.json').write_text(json.dumps(index, indent=2), encoding='utf-8')
    return index


def load_index(directory):
    root = Path(directory)
    index = json.loads((root / 'index.json').read_text(encoding='utf-8'))
    records = index['records']
    validate_jobs({'jobs': records}, verify_audio=False)
    if index['schema'] != 'clap-window-features-v1' or json_digest(records) != index['records_sha256']:
        raise ValueError('Index mapping integrity mismatch')
    if digest(root / 'audio.npy') != index['audio_sha256']:
        raise ValueError('Embedding file integrity mismatch')
    vectors = np.load(root / 'audio.npy', allow_pickle=False)
    if vectors.shape != (len(records), 512) or vectors.dtype != np.dtype('float32') or not len(records):
        raise ValueError('Embedding/mapping shape mismatch')
    if len({x['segment_id'] for x in records}) != len(records) or not np.isfinite(vectors).all():
        raise ValueError('Duplicate mapping or nonfinite embedding')
    if not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5):
        raise ValueError('Expected normalized embeddings')
    for record, vector in zip(records, vectors):
        if hashlib.sha256(vector.tobytes()).hexdigest() != record['vector_sha256']:
            raise ValueError('Vector row mapping mismatch')
    return index, vectors


def rank_candidates(records, vectors, query, limit):
    query = np.asarray(query, dtype='float32')
    if query.shape != (512,) or not np.isfinite(query).all() or np.linalg.norm(query) == 0:
        raise ValueError('Invalid query embedding')
    scores = vectors @ (query / np.linalg.norm(query))
    return [{**{key: records[i][key] for key in ['segment_id', 'asset_id', 'source_sha256', 'source_range']},
             'similarity': float(scores[i]), 'decision': 'unknown', 'listening_status': 'pending'}
            for i in np.argsort(-scores, kind='stable')[:limit]]


def tokenize_query(tokenizer, model, text):
    # RoBERTa-based CLAP reserves two position IDs. A long user description
    # must not overflow its text model; audio vectors/model binding are intact.
    config = getattr(getattr(model, 'config', None), 'text_config', None)
    positions = getattr(config, 'max_position_embeddings', 514)
    maximum = min(512, max(2, positions - 2))
    return tokenizer([text], padding=True, truncation=True, max_length=maximum, return_tensors='pt')


class ResidentRetriever:
    """Validate one immutable snapshot once; keep text model and matrix resident."""

    def __init__(self, index, weights=None, device='cpu'):
        self.index, self.vectors = load_index(index)
        self.records = self.index['records']
        self.encoded_unique_sources = len({r['source_sha256'] for r in self.records})
        self.assets = np.asarray([r['asset_id'] for r in self.records])
        self.segments = np.asarray([r['segment_id'] for r in self.records])
        keys = [r.get('family_id') or r['source_sha256'] for r in self.records]
        self.families, self.groups = np.unique(keys, return_inverse=True)
        self.group_rows = np.argsort(self.groups, kind='stable')
        self.group_offsets = np.r_[0, np.cumsum(np.bincount(self.groups))]
        self.loaded_runtime = runtime(weights, device) if weights is not None else None
        if self.loaded_runtime is not None:
            binding = self.loaded_runtime[-1]
            if {k: v for k, v in binding.items() if k != 'device'} != {
                    k: v for k, v in self.index['binding'].items() if k != 'device'}:
                raise ValueError('Query model/processor does not match encoded index')

    def search_vector(self, query, limit=20, allowed_asset_ids=None, preserve_source_windows=False,
                      allowed_segment_ids=None):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError('limit must be an integer from 1 to 200')
        if type(preserve_source_windows) is not bool:
            raise ValueError('preserve_source_windows must be boolean')
        query = np.asarray(query, dtype='float32')
        norm = np.linalg.norm(query)
        if query.shape != (512,) or not np.isfinite(query).all() or not norm:
            raise ValueError('Invalid query embedding')
        scores = self.vectors @ (query / norm)
        if allowed_asset_ids is not None:
            if isinstance(allowed_asset_ids, str):
                raise ValueError('allowed_asset_ids must be a collection of IDs')
            scores[~np.isin(self.assets, list(allowed_asset_ids))] = -np.inf
        if allowed_segment_ids is not None:
            if isinstance(allowed_segment_ids, str) or not isinstance(allowed_segment_ids, (list, tuple, set)) or any(
                    not isinstance(item, str) or not item.strip() for item in allowed_segment_ids):
                raise ValueError('allowed_segment_ids must be a collection of nonempty IDs')
            # An asset-level allowlist cannot express different conflicts for its
            # windows. Mask exact windows before ranking, never after top-k.
            scores[~np.isin(self.segments, list(allowed_segment_ids))] = -np.inf
        if preserve_source_windows:
            hits, seen = [], set()
            for position in np.argsort(-scores, kind='stable'):
                if not np.isfinite(scores[position]):
                    break
                record = self.records[int(position)]
                # Independent library windows can share one encoded short
                # representative while having distinct editable outer ranges.
                identity = (record['source_sha256'], tuple(record.get('target_window_range', record['source_range'])))
                if identity in seen:
                    continue
                seen.add(identity)
                hits.append({**{key: record[key] for key in
                    ['segment_id', 'asset_id', 'source_sha256', 'source_range']},
                    'family_id': record.get('family_id'), 'similarity': float(scores[position]),
                    'decision': 'unknown', 'listening_status': 'pending'})
                if len(hits) == limit:
                    break
            return hits
        grouped = np.full(len(self.families), -np.inf, dtype='float32')
        np.maximum.at(grouped, self.groups, scores)
        count = min(limit, int(np.isfinite(grouped).sum()))
        if not count:
            return []
        threshold = np.partition(grouped, len(grouped) - count)[-count]
        choices = np.flatnonzero(grouped >= threshold)
        choices = choices[np.lexsort((choices, -grouped[choices]))][:count]
        hits = []
        for group in choices:
            positions = self.group_rows[self.group_offsets[group]:self.group_offsets[group+1]]
            row = int(positions[np.argmax(scores[positions])])
            record = self.records[row]
            hits.append({**{key: record[key] for key in
                         ['segment_id', 'asset_id', 'source_sha256', 'source_range']},
                         'family_id': record.get('family_id'),
                         'similarity': float(scores[row]), 'decision': 'unknown',
                         'listening_status': 'pending'})
        return hits

    def search(self, text, limit=20, allowed_asset_ids=None, preserve_source_windows=False,
               allowed_segment_ids=None):
        if not isinstance(text, str) or not text.strip() or self.loaded_runtime is None:
            raise ValueError('Nonempty text and resident text model are required')
        torch, model, tokenizer, _, _ = self.loaded_runtime
        with torch.inference_mode():
            query = model.get_text_features(**{k: v.to(next(model.parameters()).device)
                for k, v in tokenize_query(tokenizer, model, text).items()})[0].cpu().numpy()
        return {'score_type': 'audio_text_cosine_not_artistic_quality_or_phase',
                'artistic_approval': False, 'source_integrity': 'encode_snapshot_only_reverify_selected_audio_before_use',
                'encoded_unique_sources': self.encoded_unique_sources,
                'encoded_windows': len(self.records),
                'unencoded_declared_assets': self.index.get('unencoded_declared_assets'),
                'preserve_source_windows': preserve_source_windows,
                'scope_filtered_before_limit': allowed_segment_ids is not None or allowed_asset_ids is not None,
                'candidates': self.search_vector(query, limit, allowed_asset_ids, preserve_source_windows,
                                                 allowed_segment_ids)}

    def verify_candidates(self, candidates):
        """Hash only explicitly selected source files immediately before audition/use."""
        by_identity = {(r['asset_id'], r['source_sha256']): r for r in self.records}
        verified = {}
        for candidate in candidates:
            identity = (candidate['asset_id'], candidate['source_sha256'])
            record = by_identity[identity]
            path = record['path']
            if path not in verified:
                verified[path] = digest(path) == record['source_sha256']
            if not verified[path]:
                raise ValueError('Selected source SHA does not match indexed audio')
        return {'verified_selected_sources': len(verified), 'all_library_audio_rehashed': False}


@gpu_slot_guard(lambda args: getattr(args, 'device', 'cpu'), slot_binding_from_args)
def search(args):
    index, vectors = load_index(args.index)
    device = getattr(args, 'device', 'cpu')
    torch, model, tokenizer, _, binding = runtime(args.weights, device)
    if {k: v for k, v in binding.items() if k != 'device'} != {k: v for k, v in index['binding'].items() if k != 'device'}:
        raise ValueError('Query model/processor does not match encoded index')
    with torch.inference_mode():
        query = model.get_text_features(**{k: v.to(device) for k, v in tokenize_query(tokenizer, model, args.text).items()})[0].cpu().numpy()
    return {'score_type': 'audio_text_cosine_not_artistic_quality_or_phase', 'artistic_approval': False,
            'source_integrity': 'encode_snapshot_only_reverify_selected_audio_before_use',
            'encoded_unique_sources': len({x['source_sha256'] for x in index['records']}), 'unencoded_declared_assets': index['unencoded_declared_assets'],
            'candidates': rank_candidates(index['records'], vectors, query, args.limit)}


def serve_requests(resident, stream):
    """One resident model/index for the complete JSONL input stream."""
    print(json.dumps({'status': 'ready', 'encoded_windows': len(resident.records),
                      'encoded_unique_sources': resident.encoded_unique_sources,
                      'artistic_approval': False}), flush=True)
    for line in stream:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('request must be a JSON object')
            parameters = [request['text'], request.get('limit', 20),
                          request.get('allowed_asset_ids'), request.get('preserve_source_windows', False)]
            # Preserve the legacy four-argument consumer when no new scope is
            # supplied; new independent workers require exact scope explicitly.
            if 'allowed_segment_ids' in request:
                parameters.append(request['allowed_segment_ids'])
            result = resident.search(*parameters)
            if request.get('verify_selected'):
                result['selected_source_verification'] = resident.verify_candidates(result['candidates'])
            result['request_id'] = request.get('request_id')
        except (ValueError, KeyError, OSError) as error:
            result = {'status': 'query_failed', 'error_type': type(error).__name__, 'error': str(error),
                      'request_id': request.get('request_id') if isinstance(request, dict) else None,
                      'artistic_approval': False}
        print(json.dumps(result, ensure_ascii=True), flush=True)


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def serve(args):
    resident = ResidentRetriever(args.index, args.weights, args.device)
    serve_requests(resident, sys.stdin)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    encode_parser = commands.add_parser('encode')
    encode_parser.add_argument('--jobs', required=True)
    encode_parser.add_argument('--out', required=True)
    encode_parser.add_argument('--batch-size', type=int, default=1)
    search_parser = commands.add_parser('search')
    search_parser.add_argument('--index', required=True)
    search_parser.add_argument('--text', required=True)
    search_parser.add_argument('--limit', type=int, default=3, choices=range(1, 21))
    serve_parser = commands.add_parser('serve', help='Resident JSONL queries on stdin; JSONL results on stdout')
    serve_parser.add_argument('--index', required=True)
    for command in [encode_parser, search_parser, serve_parser]:
        command.add_argument('--weights', required=True)
        command.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
        add_slot_arguments(command)
    args = parser.parse_args()
    if args.command == 'serve':
        serve(args)
        return
    if args.command == 'search' and not args.text.strip():
        raise ValueError('Text must be nonempty')
    result = encode(args) if args.command == 'encode' else search(args)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
