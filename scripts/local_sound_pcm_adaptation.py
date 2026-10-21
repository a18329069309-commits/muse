"""Decode local sound candidates to exact PCM clocks and measured transients.

Measurements are not listening/use approval. Only selected candidate originals
are read, never rewritten. Compressed/nonstandard inputs use content-bound PCM
proxies so later edits use the clock actually measured.
"""
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import threading
import wave

import numpy as np

from independent_music_pack_library import digest_file, read_json, write_json

_ADAPT_LOCKS = {}


def commit_pcm(temporary, destination):
    """Prefer rename; publish verified bytes on create-only archival shares."""
    try:
        temporary.replace(destination)
        return 'atomic_replace'
    except PermissionError:
        expected = digest_file(temporary)
        if destination.exists():
            if digest_file(destination) != expected:
                raise ValueError('local_sound_existing_pcm_commit_changed')
            return 'existing_matching_pcm_after_rename_denied'
        with temporary.open('rb') as source, destination.open('xb') as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        if digest_file(destination) != expected:
            raise ValueError('local_sound_pcm_copy_commit_failed')
        # Cache readers require the separate checked receipt published later.
        return 'exclusive_create_copy_hash_verified_after_rename_denied'


def measured_profile(pcm, sample_rate):
    audio = np.asarray(pcm, dtype=np.float64)
    if audio.ndim == 2:
        magnitude = np.max(np.abs(audio), axis=1)
        power = np.mean(audio ** 2, axis=1)
    else:
        magnitude = np.abs(audio); power = audio ** 2
    if not len(magnitude):
        raise ValueError('local_sound_empty_decoded_pcm')
    peak = float(np.max(magnitude)); frame = max(1, int(sample_rate * .01))
    rms = [float(np.sqrt(np.mean(power[start:start + frame]))) for start in range(0, len(power), frame)]
    envelope = np.asarray(rms)
    peak_frame = int(np.argmax(magnitude))
    candidates = []
    if peak > 1e-8:
        # Greedy measured local maxima, at least 0.4s apart. No event semantics.
        order = np.argsort(-envelope, kind='stable')
        for position in order:
            if envelope[position] < max(float(np.max(envelope)) * .5, 1e-7):
                break
            seconds = float(position * frame / sample_rate)
            if all(abs(seconds - value['seconds']) >= .4 for value in candidates):
                start = position * frame; end = min(len(magnitude), start + frame)
                exact = int(start + np.argmax(magnitude[start:end]))
                candidates.append({'sample_index': exact, 'seconds': exact / sample_rate,
                    'peak_amplitude': float(magnitude[exact]), 'status': 'measured_unverified_transient_candidate'})
            if len(candidates) >= 8:
                break
    candidates.sort(key=lambda value: value['seconds'])
    return {'decoded_samples': len(magnitude), 'decoded_sample_rate': sample_rate,
        'duration_seconds': len(magnitude) / sample_rate,
        'global_peak_sample': peak_frame, 'global_peak_seconds': peak_frame / sample_rate,
        'peak_dbfs': 20 * math.log10(max(peak, 1e-9)),
        'rms_dbfs': 20 * math.log10(max(float(np.sqrt(np.mean(power))), 1e-9)),
        'transient_candidates': candidates, 'envelope_resolution_seconds': frame / sample_rate,
        'sound_facts_qualified': False, 'auditory_anchor_verified': False}


def classify_candidate(row, profile):
    hints = '/'.join(row.get('source_directory_hints', [])) + '/' + row.get('title', '')
    if row.get('asset_kind') == 'ambient' or '环境' in hints:
        return 'ambient'
    if any(word in hints for word in ('氛围', '铺底', '持续', '紧张感', '背景')):
        return 'bed'
    return 'point' if profile['duration_seconds'] <= 8 or any(word in hints for word in ('打击', '惊爆', '爆炸', '转场', '巴掌', '撞击')) else 'bed'


def _adapt(row, config):
    original = Path(row.get('path', row.get('local_path', ''))).absolute()
    before = original.stat(); expected = row.get('source_sha256', row.get('sha256'))
    original_sha = digest_file(original)
    if expected and original_sha != expected:
        raise ValueError('local_sound_original_source_sha_changed')
    mode = config.get('source_mode', 'archival_copy')
    if mode not in ('readonly_original', 'archival_copy'):
        raise ValueError('local_sound_source_mode_unknown')
    rate = 48000
    output_root = Path(config['media_root']).absolute()
    revision = digest_file(__file__)
    pcm_identity = hashlib.sha256(json.dumps({'original_sha256': original_sha, 'processor_sha256': revision,
        'sample_rate_hz': rate, 'channels': 2, 'codec': 'pcm_s16le'}, sort_keys=True).encode()).hexdigest()
    receipt = output_root / 'pcm-receipts' / (pcm_identity + '.json')
    proxy = output_root / 'pcm-proxies' / original_sha[:2] / (pcm_identity + '.wav')
    cached = False; reused_original_pcm = False; commit_method = 'existing_checked_receipt'
    if receipt.is_file():
        proof = read_json(receipt)
        if (proof.get('original_sha256') != original_sha or proof.get('processor_sha256') != revision
                or digest_file(proof['pcm_path']) != proof.get('pcm_sha256')):
            raise ValueError('local_sound_pcm_cache_changed')
        proxy = Path(proof['pcm_path']); cached = True
    else:
        try:
            with wave.open(str(original), 'rb') as source_pcm:
                reused_original_pcm = (source_pcm.getframerate() == rate and source_pcm.getnchannels() == 2
                    and source_pcm.getsampwidth() == 2 and source_pcm.getcomptype() == 'NONE')
        except (wave.Error, EOFError):
            pass
        if reused_original_pcm:
            proxy = original; commit_method = 'readonly_existing_pcm'
        else:
            proxy.parent.mkdir(parents=True, exist_ok=True)
            temporary = proxy.with_suffix('.partial.wav')
            decode = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-y', '-i', str(original),
                '-map', '0:a:0', '-ac', '2', '-ar', str(rate), '-c:a', 'pcm_s16le', str(temporary)],
                capture_output=True, text=True, encoding='utf-8', timeout=int(config.get('decode_timeout_seconds', 180)))
            if decode.returncode:
                raise ValueError('local_sound_full_decode_failed: ' + decode.stderr[-1000:])
            commit_method = commit_pcm(temporary, proxy)
    with wave.open(str(proxy), 'rb') as stream:
        if stream.getframerate() != rate or stream.getnchannels() != 2 or stream.getsampwidth() != 2:
            raise ValueError('local_sound_pcm_clock_contract_invalid')
        frames = stream.getnframes()
        pcm = np.frombuffer(stream.readframes(frames), dtype='<i2').reshape((-1, 2)).astype(np.float64) / 32768
    if frames != len(pcm):
        raise ValueError('local_sound_pcm_frame_count_invalid')
    profile = measured_profile(pcm, rate)
    after = original.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or digest_file(original) != original_sha:
        raise ValueError('local_sound_original_changed_during_decode')
    proxy_sha = digest_file(proxy)
    if not cached:
        write_json(receipt, {'kind': 'local_sound_actual_pcm_decode', 'original_path': str(original),
            'original_sha256': original_sha, 'processor_sha256': revision, 'pcm_path': str(proxy),
            'pcm_sha256': proxy_sha, 'decoded_samples': frames, 'sample_rate_hz': rate, 'channels': 2,
            'commit_method': commit_method,
            'full_decode': {'exit_code': 0, 'strict_errors': True, 'decoder': 'ffmpeg'},
            'profile': profile, 'sound_facts_qualified': False})
    classification = classify_candidate(row, profile)
    stat = proxy.stat()
    return {**row, 'path': str(proxy), 'local_path': str(proxy), 'source_sha256': proxy_sha, 'sha256': proxy_sha,
        'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'duration_seconds': profile['duration_seconds'],
        'sample_rate_hz': rate, 'channels': 2, 'actual_clock': {'kind': 'decoded_pcm_sample_clock',
            'samples': frames, 'sample_rate_hz': rate, 'source_duration_seconds': profile['duration_seconds']},
        'original_source': {'path': str(original), 'sha256': original_sha, 'bytes': before.st_size,
            'mtime_ns': before.st_mtime_ns, 'read_only': True},
        'pcm_proxy': {'path': str(proxy), 'sha256': proxy_sha, 'cache_reused': cached,
            'commit_method': commit_method,
            'receipt': {'path': str(receipt), 'sha256': digest_file(receipt)},
            'reason': 'existing_exact_pcm_original' if proxy == original else 'exact_decoded_clock_and_portable_stereo_edit_source'},
        'source_family': row.get('source_family', 'recording/' + original_sha),
        'measured_profile': profile, 'sound_class_candidate': classification,
        'sound_class_basis': 'directory_and_pcm_measurement_unverified',
        'full_decode': {'exit_code': 0, 'strict_errors': True, 'decoder': 'ffmpeg'},
        'full_decode_verified': True,
        'source_mode': mode, 'sound_review': 'pending', 'usage_review': 'pending', 'production_approval': False}


def adapt(row, config):
    key = str(Path(config['media_root']).absolute()) + '/' + str(row.get('source_sha256', row.get('sha256', row.get('path', row.get('local_path')))))
    with _ADAPT_LOCKS.setdefault(key, threading.Lock()):
        return _adapt(row, config)
