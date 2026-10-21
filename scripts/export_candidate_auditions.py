"""Export pending music-only research auditions; no selection or picture sync."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

import numpy as np
import soundfile as sf
RATE = 48000

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def json_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def task_binding(ranked, tasks, targets):
    try:
        reference = ranked['input_files']['style_route']
        route_path = Path(reference['path'])
        raw = route_path.read_bytes()
        route_digest = hashlib.sha256(raw).hexdigest()
        if route_digest != reference['sha256']:
            raise ValueError('style_route_identity_mismatch')
        route = json.loads(raw.decode('utf-8-sig'))
        if json_hash(route) != ranked['style_route_sha256']:
            raise ValueError('style_route_identity_mismatch')
        director_digest = json_hash(tasks)
        if route.get('director_sha256') != director_digest:
            raise ValueError('task_identity_mismatch')
        branches = route['branches']
        if not branches or {b['parent_cue_id'] for b in branches} != set(targets):
            raise ValueError('task_identity_mismatch')
        for branch in branches:
            frozen = branch['frozen_task']
            frozen_cues = frozen['cues']
            parent = branch['parent_cue_id']
            if (frozen.get('source_video_sha256') != tasks['source_video_sha256']
                or frozen.get('usage_scope') != tasks['usage_scope'] or len(frozen_cues) != 1
                or frozen_cues[0]['cue_id'] != parent or frozen_cues[0]['target_range'] != targets[parent]
                or branch['route']['task_sha256'] != json_hash(frozen)):
                raise ValueError('task_identity_mismatch')
        return {'style_route_path': str(route_path.resolve()), 'style_route_file_sha256': route_digest,
            'style_route_sha256': ranked['style_route_sha256'], 'director_sha256': director_digest}
    except (KeyError, TypeError, OSError) as error:
        raise ValueError('task_provenance_required') from error


def license_codes(text):
    codes = set(re.findall(r'https?://(?:www\.)?creativecommons\.org/licenses/(by(?:-(?:nc|sa|nd)){0,2})/', text, re.I))
    if re.search(r'https?://(?:www\.)?creativecommons\.org/publicdomain/zero/|\bCC\s*0\b|creative[ -]+commons[ -]+zero', text, re.I):
        codes.add('cc0')
    for short in re.findall(r'\bCC[ -]+(BY(?:[ -]+(?:NC|SA|ND)){0,2})\b', text, re.I):
        codes.add(re.sub(r'[ -]+', '-', short).lower())
    for full in re.findall(r'creative[ -]+commons[ -]+attribution(?:[ -]+(?:non[ -]?commercial|share[ -]?alike|no[ -]?derivatives))*', text, re.I):
        code = 'by'
        if re.search('non[ -]?commercial', full, re.I):
            code += '-nc'
        if re.search('no[ -]?derivatives', full, re.I):
            code += '-nd'
        elif re.search('share[ -]?alike', full, re.I):
            code += '-sa'
        codes.add(code)
    return {c.lower() for c in codes}


def check_license(candidate):
    name, evidence = candidate.get('license'), candidate.get('license_evidence')
    if not isinstance(name, str) or not isinstance(evidence, str) or not name or not evidence:
        raise ValueError('license_and_evidence_required')
    declared = license_codes(name)
    if any(c.endswith('-nd') for c in declared) or re.search(r'no[ -]?derivatives|\bND\b', name, re.I):
        raise ValueError('no_derivatives_local_derivative_audition_not_cleared')
    if len(declared) != 1 or evidence.strip().lower() in ('unknown', 'unverified', 'pending'):
        raise ValueError('known_license_and_verified_evidence_required')
    if re.match(r'https?://', evidence, re.I):
        text = evidence
    elif license_codes(evidence):
        text = evidence
    else:
        text = Path(evidence).read_text(encoding='utf-8-sig')
        headers = list(re.finditer(r'(?m)^\d+/(\d+)\.mp3\s*$', text))
        if headers:
            track_ids = set()
            if candidate.get('track_id') is not None:
                track_ids.add(str(candidate['track_id']))
            for field, pattern in [('family_id', r'mtg-track-(\d+)'), ('asset_id', r'mtg-full-low-(\d+)')]:
                match = re.fullmatch(pattern, str(candidate.get(field, '')))
                if match:
                    track_ids.add(match[1])
            matches = [i for i, header in enumerate(headers) if header[1] in track_ids]
            if len(track_ids) != 1 or len(matches) != 1:
                raise ValueError('license_evidence_track_identity_required')
            index = matches[0]
            text = text[headers[index].start():headers[index + 1].start() if index + 1 < len(headers) else len(text)]
    observed = license_codes(text)
    if any(c.endswith('-nd') for c in observed):
        raise ValueError('no_derivatives_license_evidence_conflict')
    if observed != declared:
        raise ValueError('license_evidence_missing_or_conflicting')


def span(value):
    if (not isinstance(value, list) or len(value) != 2 or any(isinstance(x, bool) or
        not isinstance(x, (int, float)) or not math.isfinite(x) for x in value)
        or not 0 <= value[0] < value[1]):
        raise ValueError('invalid_range')
    return value


def source_window(parent, encoded, duration, samples):
    low, high = span(parent)
    first, last = span(encoded)
    if not math.isfinite(duration) or high > duration:
        raise ValueError('source_range_exceeds_actual_duration')
    # Decimal seconds can land just beside an integer sample (for example 160.8 * 48000).
    lo, hi = math.ceil(low * RATE - 1e-7), math.floor(high * RATE + 1e-7)
    start = max(lo, min(round((first + last) * RATE / 2 - samples / 2), hi - samples))
    full = start <= math.floor(first * RATE + 1e-7) and start + samples >= math.ceil(last * RATE - 1e-7)
    partial = samples < 10 * RATE and start >= math.ceil(first * RATE - 1e-7) and start + samples <= math.floor(last * RATE + 1e-7)
    if (samples < 1 or hi - lo < samples or not (full or partial) or first < low or last > high):
        raise ValueError('full_target_window_cannot_contain_encoded_window')
    return start / RATE, (start + samples) / RATE, 'full' if full else 'partial'


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=60).stdout


def export(reranked_path, tasks_path, out, limit=2):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError('limit_must_be_integer_1_to_20')
    reranked_path, tasks_path, out = Path(reranked_path), Path(tasks_path), Path(out)
    if out.exists():
        raise ValueError('refusing_to_overwrite_output')
    ranked, tasks = [json.loads(p.read_text(encoding='utf-8-sig')) for p in (reranked_path, tasks_path)]
    if (ranked.get('schema_version') != 1 or tasks.get('schema_version') != 1
        or tasks.get('usage_scope') != 'research_noncommercial'
        or not re.fullmatch('[0-9a-f]{64}', str(tasks.get('source_video_sha256', '')))):
        raise ValueError('research_tasks_and_source_video_identity_required')
    cues, task_cues = ranked.get('cues'), tasks.get('cues')
    if not isinstance(cues, list) or not cues or not isinstance(task_cues, list) or not task_cues:
        raise ValueError('nonempty_cues_required')
    targets = {c['cue_id']: span(c['target_range']) for c in task_cues}
    if (len(targets) != len(task_cues) or len({c['cue_id'] for c in cues}) != len(cues)
        or set(targets) != {c['cue_id'] for c in cues}
        or any(not isinstance(c.get('candidate_pool'), list) or not c['candidate_pool'] for c in cues)):
        raise ValueError('unique_matching_cues_and_candidate_pools_required')
    binding = task_binding(ranked, tasks, targets)
    manifest = {'schema_version': 1, 'input_sha256': digest(reranked_path), 'tasks_sha256': digest(tasks_path),
        'task_binding': binding,
        'source_video_sha256': tasks['source_video_sha256'], 'usage_scope': 'research_noncommercial',
        'scope': 'standalone_music_only_not_picture_dialogue_or_final_sync', 'auditions': [], 'rejected': [],
        'selected': False, 'artistic_approval': False, 'generation_calls': 0, 'cloud_uploads': 0,
        'level_matching': 'RMS_minus20dBFS_sample_peak_max_minus2dBFS_not_perceptual_loudness'}
    out.mkdir(parents=True)
    for cue_number, cue in enumerate(cues, 1):
        target = targets[cue['cue_id']]
        count, samples, seen = 0, round((target[1] - target[0]) * RATE), set()
        for candidate in cue['candidate_pool']:
            if count == limit:
                break
            try:
                check_license(candidate)
                license_name = candidate.get('license', '')
                if candidate.get('usage_scope') != 'research_noncommercial':
                    raise ValueError('candidate_research_scope_required')
                path = Path(candidate.get('local_path') or candidate.get('path') or '')
                expected = candidate.get('source_sha256')
                if not re.fullmatch('[0-9a-f]{64}', str(expected)) or digest(path) != expected:
                    raise ValueError('source_sha256_mismatch')
                encoded = candidate['encoded_window']
                if encoded.get('asset_id') != candidate['asset_id'] or encoded.get('source_sha256') != expected:
                    raise ValueError('encoded_window_identity_mismatch')
                if expected in seen:
                    raise ValueError('duplicate_recording')
                probe = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                    '-show_entries', 'stream=duration,sample_rate,channels,codec_name:format=duration', '-of', 'json', str(path)]))
                duration = float(probe['streams'][0].get('duration', probe['format']['duration']))
                start, end, coverage = source_window(candidate['source_range'], candidate['encoded_window']['source_range'], duration, samples)
                raw = run(['ffmpeg', '-v', 'error', '-threads', '2', '-i', str(path), '-ss', str(start),
                    '-t', str(samples / RATE), '-map', '0:a:0', '-ar', str(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1'])
                audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
                if len(audio) != samples or not np.isfinite(audio).all() or digest(path) != expected:
                    raise ValueError('decoded_length_finiteness_or_source_identity_mismatch')
                rms, peak = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))), float(np.max(np.abs(audio)))
                if not peak:
                    raise ValueError('silent_candidate')
                gain = min(10 ** (-20 / 20) / rms, 10 ** (-2 / 20) / peak)
                count += 1
                output = out / f'cue-{cue_number:02d}-option-{count:02d}.wav'
                sf.write(output, audio * gain, RATE, subtype='PCM_24')
                info = sf.info(output)
                matched, _ = sf.read(output, dtype='float64', always_2d=True)
                if (info.frames, info.samplerate, info.channels, info.subtype) != (samples, RATE, 2, 'PCM_24'):
                    raise ValueError('output_format_or_sample_count_mismatch')
                matched_rms = 10 * math.log10(float(np.mean(matched ** 2)))
                target_reached = abs(matched_rms - -20) <= .01
                credits = {key: candidate[key] for key in ('creator', 'title', 'attribution', 'source_page', 'family_id') if key in candidate}
                manifest['auditions'].append({'cue_id': cue['cue_id'], 'asset_id': candidate['asset_id'],
                    'target_range': target, 'source_clip_range': [start, end], 'encoded_window': candidate['encoded_window']['source_range'],
                    'encoded_window_coverage': coverage,
                    'source_path': str(path.resolve()), 'source_sha256': expected, 'source_probe': probe,
                    'audio_path': str(output.resolve()), 'audio_sha256': digest(output), 'duration_samples': samples,
                    'sample_rate': RATE, 'channels': 2, 'bit_depth': 24, 'gain_db': 20 * math.log10(gain),
                    'matched_rms_dbfs': matched_rms, 'matched_sample_peak_dbfs': 20 * math.log10(float(np.max(np.abs(matched)))),
                    'level_target_reached': target_reached, 'level_status': 'target_met' if target_reached else 'peak_limited_target_not_reached',
                    'license': license_name, 'license_evidence': candidate['license_evidence'],
                    **credits, 'credit_status': 'provided_not_reviewed' if all(candidate.get(k) for k in ('creator', 'title', 'attribution', 'source_page')) else 'pending_asset_catalog_lookup',
                    'vocal_presence': 'unknown', 'phase': 'unknown', 'listening_status': 'pending',
                    'selected': False, 'artistic_approval': False})
                seen.add(expected)
            except (ValueError, OSError, KeyError, IndexError, subprocess.SubprocessError) as error:
                manifest['rejected'].append({'cue_id': cue['cue_id'], 'asset_id': candidate.get('asset_id'), 'reason': str(error)})
    with (out / 'manifest.json').open('x', encoding='utf-8') as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reranked'); parser.add_argument('--tasks', required=True)
    parser.add_argument('--out', required=True); parser.add_argument('--limit', type=int, default=2)
    args = parser.parse_args()
    result = export(args.reranked, args.tasks, args.out, args.limit)
    print(json.dumps({'manifest': str(Path(args.out).resolve() / 'manifest.json'), 'auditions': len(result['auditions']),
                      'rejected': len(result['rejected']), 'artistic_approval': False}))
