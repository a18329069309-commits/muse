"""Offline constant-gain PCM proxies, compatible with source_catalogues.

No dynamic normalization, limiter, online gain waiver or sound/use approval.
Original recording families and absolute 48k clocks survive window extraction.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import time

from independent_recording_checks import (bounded_source_identity, digest_file,
    read_json, write_json, _identity_lock)

RATE = 48000
CHANNELS = 2
REVISION = 'offline-static-loudness-pcm24-v1'
PROCESSOR_SHA = digest_file(__file__)
FALSE_QUALIFICATIONS = {'sound_facts_qualified': False, 'use_qualified': False,
    'words_qualified': False, 'artistic_approval': False, 'production_approval': False,
    'professional_audio_review_qualified': False, 'human_audition_performed': False}


def binding(file):
    return {'path': str(Path(file).absolute()), 'sha256': digest_file(file)}


def checked(value):
    if not isinstance(value, dict) or not Path(value.get('path', '')).is_absolute():
        raise ValueError('static_loudness_absolute_bound_input_required')
    file = Path(value['path'])
    if digest_file(file) != value.get('sha256'):
        raise ValueError('static_loudness_bound_input_changed')
    return file


def ffmpeg_identity():
    file = shutil.which('ffmpeg')
    if not file:
        raise ValueError('static_loudness_ffmpeg_required')
    result = subprocess.run([file, '-version'], capture_output=True, timeout=10)
    if result.returncode:
        raise ValueError('static_loudness_ffmpeg_identity_failed')
    return {**binding(file), 'version': result.stdout.decode('utf8', 'replace').splitlines()[0]}


def parse_ebur128(text):
    summary = text.rsplit('Summary:', 1)[-1]
    def number(pattern):
        found = re.search(pattern, summary)
        if not found:
            raise ValueError('static_loudness_measurement_summary_missing')
        return float(found.group(1))
    values = {'integrated_lufs': number(r'I:\s*([-+\d.]+|[-+]?inf)\s*LUFS'),
        'loudness_range_lu': number(r'LRA:\s*([-+\d.]+)\s*LU'),
        'true_peak_dbtp': number(r'True peak:\s*Peak:\s*([-+\d.]+|[-+]?inf)\s*dBFS')}
    if any(not math.isfinite(v) for v in values.values()) or values['integrated_lufs'] <= -69.9:
        raise ValueError('static_loudness_silence_or_ungated_audio')
    return values


def gain_plan(measured, target=-24.0, ceiling=-3.0, margin=.1):
    if (any(not math.isfinite(v) for v in (target, ceiling, margin))
            or not -40 <= target <= -16 or not -12 <= ceiling <= -1 or not 0 <= margin <= 1):
        raise ValueError('static_loudness_target_or_headroom_invalid')
    desired = target - measured['integrated_lufs']
    headroom = ceiling - measured['true_peak_dbtp'] - margin
    return {'target_lufs': target, 'true_peak_ceiling_dbtp': ceiling, 'peak_safety_margin_db': margin,
        'desired_static_gain_db': desired, 'available_static_gain_db': headroom,
        'headroom_sufficient': desired <= headroom + 1e-8,
        'compression': False, 'limiter': False, 'dynamic_normalization': False}


def run_ffmpeg(tool, args, log, timeout):
    started = time.monotonic()
    result = subprocess.run([tool['path'], *args], capture_output=True, timeout=timeout)
    log = Path(log); log.write_bytes(result.stderr)
    receipt = {'arguments': args, 'exit_code': result.returncode,
        'elapsed_seconds': time.monotonic() - started, 'stderr': binding(log), 'ffmpeg': tool}
    if result.returncode:
        raise ValueError('static_loudness_ffmpeg_failed: ' + result.stderr.decode('utf8', 'replace')[-800:])
    return receipt, result.stderr.decode('utf8', 'replace')


def measure(file, tool, log, timeout, raw=False):
    args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-xerror']
    if raw:
        args += ['-f', 'f32le', '-ar', str(RATE), '-ac', str(CHANNELS)]
    args += ['-i', str(file), '-map', '0:a:0', '-af',
        'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']
    receipt, text = run_ffmpeg(tool, args, log, timeout)
    return {**parse_ebur128(text), 'receipt': receipt}


def frame_range(row):
    seconds = row.get('source_range')
    if seconds is None:
        return None
    if (not isinstance(seconds, list) or len(seconds) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in seconds)
            or not 0 <= seconds[0] < seconds[1]):
        raise ValueError('static_loudness_source_range_invalid')
    frames = [round(v * RATE) for v in seconds]
    if frames[0] >= frames[1] or any(abs(v * RATE - f) > 1e-5 for v, f in zip(seconds, frames)):
        raise ValueError('static_loudness_source_range_not_exact_48k_clock')
    return frames


def pcm24_clock(file):
    """Read RIFF PCM24 and extensible-PCM headers, including on Python 3.11."""
    with Path(file).open('rb') as stream:
        if stream.read(4) != b'RIFF':
            raise ValueError('static_loudness_pcm_riff_required')
        size = struct.unpack('<I', stream.read(4))[0]
        if stream.read(4) != b'WAVE' or size + 8 != Path(file).stat().st_size:
            raise ValueError('static_loudness_pcm_riff_size_invalid')
        fmt = None; data_bytes = None
        while True:
            tag = stream.read(4)
            if not tag:
                break
            length = struct.unpack('<I', stream.read(4))[0]
            if tag == b'fmt ':
                body = stream.read(length); kind, channels, rate, byte_rate, alignment, bits = struct.unpack('<HHIIHH', body[:16])
                if kind == 0xfffe:
                    if len(body) < 40 or body[24:40] != bytes.fromhex('0100000000001000800000aa00389b71'):
                        raise ValueError('static_loudness_extensible_pcm_required')
                    kind = 1
                fmt = (kind, channels, rate, alignment, bits, byte_rate)
            elif tag == b'data':
                data_bytes = length; stream.seek(length, 1)
            else:
                stream.seek(length, 1)
            if length % 2:
                stream.seek(1, 1)
            if stream.tell() > size + 8:
                raise ValueError('static_loudness_pcm_data_truncated')
    if fmt != (1, CHANNELS, RATE, CHANNELS * 3, 24, RATE * CHANNELS * 3) or not data_bytes or data_bytes % (CHANNELS * 3):
        raise ValueError('static_loudness_pcm24_clock_invalid')
    return data_bytes // (CHANNELS * 3)


def reused_pcm(row, source_sha, frames, tool):
    if not row.get('reuse_probe'):
        return None
    file = checked(row['reuse_probe']); proof = read_json(file)
    if (proof.get('source', {}).get('sha256') != source_sha
            or proof.get('source', {}).get('after_sha256') != source_sha
            or proof.get('ffmpeg', {}).get('sha256') != tool['sha256']
            or frame_range(proof['source']) != frames):
        raise ValueError('static_loudness_reuse_probe_identity_or_clock_changed')
    raw = checked(proof['decoded_pcm']); stats = proof['decoded_pcm']['stats']
    count = raw.stat().st_size // (CHANNELS * 4)
    if (raw.stat().st_size % (CHANNELS * 4) or stats.get('sample_frames') != count
            or stats.get('channels') != CHANNELS or stats.get('sample_rate') != RATE
            or frames is None or count != frames[1] - frames[0]
            or proof.get('decode', {}).get('exit_code') != 0):
        raise ValueError('static_loudness_reused_pcm_decode_clock_invalid')
    checked(proof['decode']['stderr'])
    measured = proof['source_ebur128']; receipt = measured['receipt']
    text = checked(receipt['stderr']).read_text(encoding='utf8', errors='replace')
    actual = parse_ebur128(text)
    if receipt.get('exit_code') != 0 or any(actual[k] != measured[k] for k in actual):
        raise ValueError('static_loudness_reuse_measurement_changed')
    args = receipt.get('arguments', [])
    if ('ebur128=peak=true:framelog=verbose' not in args or str(raw) not in args
            or any('volume=' in value for value in args)):
        raise ValueError('static_loudness_reuse_unscaled_pcm_measurement_required')
    return raw, measured, {'kind': 'source_bound_existing_decode_probe', 'probe': binding(file),
        'source_decode_receipt': proof['decode'], 'pcm': binding(raw),
        'clock_basis': 'existing_bound_probe_range_and_actual_pcm_sample_count'}


def commit_create_only(temporary, destination):
    expected = digest_file(temporary)
    if destination.exists():
        if digest_file(destination) != expected:
            raise ValueError('static_loudness_existing_proxy_conflict')
        return
    try:
        # link is an exclusive commit on local filesystems; SMB may deny it.
        os.link(temporary, destination)
    except (OSError, NotImplementedError):
        with temporary.open('rb') as source, destination.open('xb') as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
            output.flush(); os.fsync(output.fileno())
    if digest_file(destination) != expected:
        raise ValueError('static_loudness_proxy_commit_hash_mismatch')


def verify_sources_unchanged(group, config):
    for alias, old, _ in group:
        current = bounded_source_identity(alias.get('path', alias.get('local_path')), config.get('hash_timeout_seconds', 60))
        if current != old:
            raise ValueError('static_loudness_source_changed_during_adaptation')


def adapt_group(group, config, tool):
    row, before, frames = group[0]
    source = Path(row.get('path', row.get('local_path')))
    identity = {'revision': REVISION, 'processor_sha256': PROCESSOR_SHA,
        'original_sha256': before['sha256'], 'source_sample_range': frames,
        'target_lufs': config.get('target_lufs', -24.0),
        'true_peak_ceiling_dbtp': config.get('true_peak_ceiling_dbtp', -3.0),
        'peak_safety_margin_db': config.get('peak_safety_margin_db', .1),
        'ffmpeg_sha256': tool['sha256'], 'sample_rate': RATE, 'channels': CHANNELS, 'codec': 'pcm_s24le'}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    media = Path(config['media_root']); cache = Path(config['output_dir']) / 'receipts'
    cache.mkdir(parents=True, exist_ok=True); media.mkdir(parents=True, exist_ok=True)
    receipt_file = cache / (key + '.json'); proxy = media / (key + '.wav')
    timeout = config.get('decode_timeout_seconds', 180)
    with _identity_lock(receipt_file, config.get('lock_timeout_seconds', 15)):
        if receipt_file.exists():
            proof = read_json(receipt_file)
            if proof.get('identity') != identity:
                raise ValueError('static_loudness_receipt_identity_changed')
            checked(proof['derived']); checked(proof['record']['loudness_adaptation'])
            family = row.get('recording_family_id', row.get('family_id', 'recording/' + before['sha256']))
            if proof['record']['recording_family_id'] != family:
                raise ValueError('static_loudness_cached_family_identity_changed')
            verify_sources_unchanged(group, config)
            return {**proof['record'], 'aliases': [x[0].get('record_id') for x in group[1:]],
                'source_aliases': [{'record_id': a.get('record_id'), 'source': {'path': a.get('path', a.get('local_path')), 'sha256': old['sha256']}}
                    for a, old, _ in group]}, True
        logs = Path(config['output_dir']) / 'logs' / key; logs.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=Path(config['output_dir']), prefix='pcm-') as stage:
            stage = Path(stage); reuse = reused_pcm(row, before['sha256'], frames, tool)
            if reuse:
                raw, source_measure, decode = reuse
            else:
                raw = stage / 'source.f32le'
                args = ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', str(source),
                    '-map', '0:a:0', '-ac', str(CHANNELS), '-ar', str(RATE)]
                if frames is not None:
                    args += ['-af', f'aresample={RATE},atrim=start_sample={frames[0]}:end_sample={frames[1]},asetpts=N/SR/TB']
                args += ['-f', 'f32le', str(raw)]
                decode, _ = run_ffmpeg(tool, args, logs / 'source-decode.log', timeout)
                source_measure = measure(raw, tool, logs / 'source-ebur128.log', timeout, raw=True)
            count = raw.stat().st_size // (CHANNELS * 4)
            if not count or raw.stat().st_size % (CHANNELS * 4) or frames and count != frames[1] - frames[0]:
                raise ValueError('static_loudness_full_source_interval_decode_incomplete')
            absolute = frames or [0, count]
            plan = gain_plan(source_measure, identity['target_lufs'], identity['true_peak_ceiling_dbtp'], identity['peak_safety_margin_db'])
            if not plan['headroom_sufficient']:
                raise ValueError('static_loudness_target_exceeds_headroom: ' + json.dumps(plan, sort_keys=True))
            temporary = stage / 'derived.wav'
            args = ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-f', 'f32le',
                '-ar', str(RATE), '-ac', str(CHANNELS), '-i', str(raw), '-map', '0:a:0',
                '-af', f"volume={plan['desired_static_gain_db']:.12f}dB:precision=double",
                '-c:a', 'pcm_s24le', str(temporary)]
            creation, _ = run_ffmpeg(tool, args, logs / 'proxy-decode.log', timeout)
            if pcm24_clock(temporary) != count:
                raise ValueError('static_loudness_derived_exact_clock_changed')
            derived_measure = measure(temporary, tool, logs / 'derived-ebur128.log', timeout)
            if (derived_measure['true_peak_dbtp'] > identity['true_peak_ceiling_dbtp'] + .05
                    or abs(derived_measure['integrated_lufs'] - identity['target_lufs']) > .2
                    or abs(derived_measure['loudness_range_lu'] - source_measure['loudness_range_lu']) > .2):
                raise ValueError('static_loudness_actual_target_peak_or_dynamics_failed')
            # All aliases are source-bound and rechecked before any publishing.
            verify_sources_unchanged(group, config)
            commit_create_only(temporary, proxy)
            family = row.get('recording_family_id', row.get('family_id', 'recording/' + before['sha256']))
            alias_refs = [{'record_id': a.get('record_id'), 'source': {'path': a.get('path', a.get('local_path')), 'sha256': old['sha256']}}
                for a, old, _ in group]
            evidence = {'schema_version': 1, 'kind': REVISION, 'identity': identity,
                'original': {'path': str(source), 'sha256': before['sha256']}, 'derived': binding(proxy),
                'original_source_sample_range': absolute, 'timeline_sample_rate_hz': RATE,
                'derived_source_sample_range': [0, count], 'duration_samples': count,
                'recording_family_id': family, 'source_aliases': alias_refs, 'source_decode': decode,
                'source_measurement': source_measure, 'static_gain': plan, 'proxy_creation': creation,
                'derived_full_decode_and_measurement': derived_measure,
                'full_decode_verified': True, 'timeline_clock_verified': True,
                'operation': 'constant_amplitude_multiplier_then_PCM24_quantization',
                'source_originals_modified': False, 'original_family_not_new_song': True,
                'source_clock_mapping': {'original_start_sample': absolute[0], 'derived_start_sample': 0, 'sample_rate_hz': RATE},
                **FALSE_QUALIFICATIONS}
            evidence_ref = write_json(cache / (key + '.adaptation.json'), evidence)
            record = {**row, 'record_id': 'static-proxy/' + key, 'path': str(proxy.absolute()),
                'local_path': str(proxy.absolute()), 'sha256': evidence['derived']['sha256'],
                'source_sha256': evidence['derived']['sha256'], 'recording_family_id': family, 'source_family': family,
                'source_windows': [[0, count / RATE]], 'original_recording': evidence['original'],
                'original_source_sample_range': absolute, 'timeline_sample_rate_hz': RATE, 'duration_samples': count,
                'requested_extent': 'derived_provided_source_interval_not_full_release',
                'source_range': [0, count / RATE], 'loudness_adaptation': evidence_ref,
                'aliases': [a.get('record_id') for a, _, _ in group[1:]], 'source_aliases': alias_refs,
                'status': 'static_loudness_diagnostic_candidate', 'sound_review': 'pending', 'usage_review': 'pending',
                'lyrics_review': 'pending', 'phrase_boundaries_verified': False, **FALSE_QUALIFICATIONS}
            for stale in ('reuse_probe', 'file_identity_verified', 'full_recording_acquired', 'reference_original_verified'):
                record.pop(stale, None)
            write_json(receipt_file, {'identity': identity, 'derived': evidence['derived'], 'record': record})
            return record, False


def adapt(config):
    if config.get('mode') != 'research' or config.get('trial_review_policy') != 'diagnostic_candidates':
        raise ValueError('static_loudness_explicit_diagnostic_research_required')
    for field in ('output_dir', 'media_root'):
        if not Path(config.get(field, '')).is_absolute():
            raise ValueError('static_loudness_absolute_output_required')
    Path(config['output_dir']).mkdir(parents=True, exist_ok=True)
    records = config.get('records', []); sources = []
    for item in config.get('source_catalogues', []):
        file = checked(item); rows = read_json(file)
        rows = rows.get('records', rows.get('assets')) if isinstance(rows, dict) else rows
        if not isinstance(rows, list):
            raise ValueError('static_loudness_bounded_records_required')
        records = [*records, *rows]; sources.append(binding(file))
    if not isinstance(records, list) or not 1 <= len(records) <= config.get('max_records', 500) <= 500:
        raise ValueError('static_loudness_bounded_records_required')
    tool = ffmpeg_identity(); groups = {}; gaps = []; output = []; reused = 0
    for row in records:
        try:
            if not isinstance(row, dict) or row.get('asset_kind', 'music') != 'music':
                raise ValueError('static_loudness_music_record_required')
            source = Path(row.get('path', row.get('local_path', '')))
            if not source.is_absolute():
                raise ValueError('static_loudness_absolute_original_required')
            before = bounded_source_identity(source, config.get('hash_timeout_seconds', 60))
            claimed = row.get('sha256', row.get('source_sha256'))
            if claimed and claimed != before['sha256']:
                raise ValueError('static_loudness_original_identity_changed')
            frames = frame_range(row); key = (before['sha256'], tuple(frames) if frames is not None else None)
            groups.setdefault(key, []).append((row, before, frames))
        except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
            gaps.append({'record_id': row.get('record_id') if isinstance(row, dict) else None,
                'gap': str(error), 'proxy_published': False})
    for group in groups.values():
        try:
            row, hit = adapt_group(group, config, tool); output.append(row); reused += int(hit)
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
            gaps.append({'record_ids': [r.get('record_id') for r, _, _ in group], 'gap': str(error), 'proxy_published': False})
    catalogue = {'schema_version': 1, 'kind': REVISION + '-source-catalogue', 'records': output,
        'source_catalogues': sources, 'gaps': gaps, 'recording_families': len({r['recording_family_id'] for r in output}),
        'proxy_files': len(output), 'duplicate_aliases': sum(len(r['aliases']) for r in output),
        'cache_reused': reused, 'new_proxy_files': len(output) - reused,
        'source_originals_modified': False, 'original_family_not_new_song': True,
        'model_calls': 0, 'paid_calls': 0, **FALSE_QUALIFICATIONS}
    key = hashlib.sha256(json.dumps(catalogue, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    ref = write_json(Path(config['output_dir']) / ('source-catalogue-' + key[:20] + '.json'), catalogue)
    return {'status': 'static_loudness_candidates_with_gaps' if gaps else 'static_loudness_candidates_ready',
        'source_catalogue': ref, 'counts': {k: catalogue[k] for k in ('recording_families', 'proxy_files', 'duplicate_aliases', 'cache_reused', 'new_proxy_files')},
        'gaps': gaps, 'model_calls': 0, 'paid_calls': 0, **FALSE_QUALIFICATIONS}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('config'); args = parser.parse_args()
    print(json.dumps(adapt(read_json(args.config)), ensure_ascii=False))
