"""Register a bounded, stratified selection from a pinned local path inventory.

Original directories stay read-only. A catalogue proves file SHA and probed audio
metadata; folder/title annotations never grant voice, lyric or use qualification.
"""
import argparse
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

from independent_music_pack_library import checked_binding, digest_file, read_json, write_json

AUDIO_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.aiff', '.aif', '.wma', '.opus'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.mkv', '.webm', '.avi'}


def path_hints(item):
    return list(item.get('directory_hints') or Path(item['relative_path']).parts[:-1])


def catalogue_role(item):
    """Directory role is an unverified routing hint, not actual sound content."""
    hints = path_hints(item)
    if not hints:
        return None
    top = hints[0]
    if top == 'c c音效' or top == '音乐音效' or top == '音效' and (len(hints) < 2 or hints[1].upper() != 'BGM'):
        return 'sound'
    if top == '短剧' and len(hints) > 1:
        return 'music' if hints[1].casefold() == 'bgm' else 'sound' if hints[1] == '音效' else None
    if top in {'短剧音乐', '个人音乐包', '红果短剧BGM'} or top == '音效' and len(hints) > 1 and hints[1].upper() == 'BGM':
        return 'music'
    return None


def stratum(item):
    hints = path_hints(item)
    depth = 3 if len(hints) > 2 and hints[1] in {'女频音乐', '短剧配乐+++'} else 2
    return '/'.join(hints[:depth])


def stratified_order(items, role, max_bytes):
    groups = defaultdict(list)
    for item in items:
        extension = str(item.get('extension', Path(item['path']).suffix)).lower()
        if (extension not in AUDIO_EXTENSIONS | VIDEO_EXTENSIONS or item.get('metadata_unknown')
                or not 0 < item.get('bytes', 0) <= max_bytes or catalogue_role(item) != role):
            continue
        groups[stratum(item)].append(item)
    queues = {}
    for key, rows in groups.items():
        rows.sort(key=lambda row: hashlib.sha256(row['path'].encode('utf-8')).hexdigest())
        queues[key] = deque(rows)
    result = []
    while queues:
        for key in sorted(queues):
            result.append(queues[key].popleft())
            if not queues[key]:
                del queues[key]
    return result


def filename_hints(item):
    text = Path(item['path']).stem
    voice = bool(re.search(r'\binst\.?\b|instrumental|karaoke|伴奏|纯音乐', text, re.I))
    language = 'Korean_filename' if re.search(r'[\uac00-\ud7af]', text) else 'Japanese_filename' if re.search(r'[\u3040-\u30ff]', text) else 'Chinese_filename' if re.search(r'[\u3400-\u9fff]', text) else 'Latin_filename' if re.search(r'[A-Za-z]', text) else 'unknown'
    return {'title': text, 'language_hint': language, 'instrumental_filename_hint': voice,
        'basis': 'filename_only_not_actual_voice_words_or_language'}


def inspect_candidate(item, role, inventory_binding, allowed_roots):
    file = Path(item['path']).absolute()
    if not any(file.is_relative_to(Path(root).absolute()) for root in allowed_roots):
        raise ValueError('local_catalogue_source_outside_allowed_roots')
    before = file.stat()
    if (before.st_size, before.st_mtime_ns) != (item.get('bytes'), item.get('mtime_ns')):
        return None, {'path': str(file), 'gap': 'source_metadata_changed_since_inventory'}
    sha = digest_file(file)
    p = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
        'format=duration:stream=codec_name,sample_rate,channels,duration', '-of', 'json', str(file)],
        capture_output=True, text=True, encoding='utf-8', timeout=30)
    if p.returncode:
        return None, {'path': str(file), 'gap': 'local_audio_probe_failed', 'exit_code': p.returncode,
            'detail': p.stderr[-1200:]}
    info = json.loads(p.stdout)
    audio = (info.get('streams') or [None])[0]
    if not audio:
        return None, {'path': str(file), 'gap': 'local_audio_stream_missing'}
    duration = float(audio.get('duration') or info.get('format', {}).get('duration') or 0)
    if duration <= 0 or duration > 1800 or role == 'sound' and duration > 300:
        return None, {'path': str(file), 'gap': 'candidate_duration_outside_bounded_catalogue', 'duration_seconds': duration}
    after = file.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        return None, {'path': str(file), 'gap': 'source_changed_during_catalogue_probe'}
    hints = path_hints(item); named = filename_hints(item)
    ambient = any('环境' in part for part in hints)
    return {'record_id': 'user-local/' + sha, 'asset_id': 'user-local/' + sha,
        'recording_family_id': 'recording/' + sha, 'source_family': 'recording/' + sha,
        'path': str(file), 'local_path': str(file), 'sha256': sha, 'source_sha256': sha,
        'bytes': before.st_size, 'mtime_ns': before.st_mtime_ns,
        'asset_kind': 'music' if role == 'music' else 'ambient' if ambient else 'sfx',
        'title': named['title'], 'source_directory_hints': hints, 'source_tags': hints,
        'directory_stratum': stratum(item), 'filename_hints': named,
        'publisher_tags': [], 'publisher_vocal_hint': False,
        'vocal_language_hint': 'unknown', 'origin': 'user_supplied_local_library',
        'requested_extent': 'existing_local_recording_metadata_probed_not_full_decode',
        'source_catalogue_evidence': inventory_binding,
        'description': named['title'] + '; user folder hints: ' + '/'.join(hints),
        'narrative_functions': [], 'preset_ids': [],
        'tag_status': 'local_directory_filename_unverified_hypothesis',
        'listening_status': 'pending', 'sound_review': 'pending', 'usage_review': 'pending',
        'production_approval': False, 'usage_scope': 'diagnostic_research',
        'license_status': 'user_local_not_a_redistribution_or_commercial_approval',
        'duration_seconds': duration, 'sample_rate_hz': int(audio['sample_rate']),
        'channels': int(audio['channels']), 'container_extension': file.suffix.lower(),
        'actual_audio_codec': audio.get('codec_name'),
        'file_identity_verified': True, 'full_decode_verified': False,
        'probe': {'exit_code': p.returncode, 'decoder': 'ffprobe', 'audio_stream': 'a:0'}}, None


def prepare(config):
    inventory_file, inventory_sha = checked_binding(config['inventory'])
    inventory_binding = {'path': str(inventory_file.absolute()), 'sha256': inventory_sha}
    inventory = read_json(inventory_file)
    roots = config.get('allowed_source_roots') or list(inventory['summary']['roots'])
    output = Path(config['output_dir']).absolute(); output.mkdir(parents=True, exist_ok=True)
    batch_size = int(config.get('batch_size', 20))
    if not 1 <= batch_size <= 20:
        raise ValueError('local_catalogue_batch_size_must_be_1_to_20')
    targets = {'music': int(config.get('music_target', 100)), 'sound': int(config.get('sound_target', 100))}
    if any(not 1 <= value <= 500 for value in targets.values()):
        raise ValueError('local_catalogue_target_outside_1_to_500')
    identity = {'inventory': inventory_binding, 'roots': roots, 'targets': targets,
        'processor_sha256': digest_file(__file__), 'max_source_bytes': int(config.get('max_source_bytes', 100 * 1024 * 1024))}
    state_path = output / 'prepare-state.json'
    if state_path.is_file():
        state = read_json(state_path)
        if state.get('identity') != identity:
            raise ValueError('local_catalogue_resume_identity_changed')
        for rows in state.get('selected', {}).values():
            for row in rows:
                if digest_file(row['path']) != row['source_sha256']:
                    raise ValueError('local_catalogue_previously_selected_source_changed')
    else:
        state = {'identity': identity, 'selected': {'music': [], 'sound': []}, 'attempted': {},
            'duplicates': [], 'gaps': [], 'batch_receipts': [], 'model_calls': 0, 'paid_calls': 0}
    seen = {row['source_sha256'] for rows in state['selected'].values() for row in rows}
    for role, target in targets.items():
        candidates = stratified_order(inventory['items'], role, identity['max_source_bytes'])
        recent = []; begun = time.monotonic(); new_attempts = 0
        for item in candidates:
            if len(state['selected'][role]) >= target:
                break
            if item['path'] in state['attempted']:
                continue
            if new_attempts >= int(config.get('max_new_attempts_per_role', target * 5)):
                state['gaps'].append({'role': role, 'gap': 'bounded_candidate_attempt_limit', 'attempts': new_attempts})
                break
            new_attempts += 1
            try:
                row, gap = inspect_candidate(item, role, inventory_binding, roots)
            except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
                row, gap = None, {'path': item['path'], 'gap': 'local_candidate_inspection_failed', 'detail': str(error)}
            if gap:
                state['gaps'].append(gap); state['attempted'][item['path']] = {'status': 'gap', **gap}
            elif row['source_sha256'] in seen:
                duplicate = {'path': row['path'], 'source_sha256': row['source_sha256'], 'role': role}
                state['duplicates'].append(duplicate); state['attempted'][item['path']] = {'status': 'sha_duplicate', **duplicate}
            else:
                seen.add(row['source_sha256']); state['selected'][role].append(row); recent.append(row['record_id'])
                state['attempted'][item['path']] = {'status': 'registered_unapproved', 'source_sha256': row['source_sha256']}
            if len(recent) >= batch_size:
                receipt = {'role': role, 'new_registered_ids': recent, 'registered_total': len(state['selected'][role]),
                    'elapsed_seconds': round(time.monotonic() - begun, 3), 'recorded_at': datetime.now(timezone.utc).isoformat()}
                state['batch_receipts'].append(receipt); write_json(state_path, state)
                print(json.dumps(receipt, ensure_ascii=False), flush=True)
                recent = []; begun = time.monotonic()
        if recent:
            state['batch_receipts'].append({'role': role, 'new_registered_ids': recent,
                'registered_total': len(state['selected'][role]), 'elapsed_seconds': round(time.monotonic() - begun, 3)})
        write_json(state_path, state)
    bindings = {}
    for role, rows in state['selected'].items():
        key = 'records' if role == 'music' else 'assets'
        bindings[role] = write_json(output / (role + '-source-catalogue.json'), {
            'kind': 'user_local_sha_verified_unapproved_candidate_catalogue', key: rows,
            'inventory': inventory_binding, 'basis': 'directory_title_metadata_not_auditory_or_use_approval',
            'original_sources_modified': False, 'recording_family_dedupe': 'exact_file_sha_only',
            'model_calls': 0, 'paid_calls': 0})
    result = {'kind': 'local_music_sound_catalogue_preparation', 'catalogues': bindings,
        'registered_counts': {role: len(rows) for role, rows in state['selected'].items()},
        'targets': targets, 'target_met': all(len(state['selected'][role]) >= targets[role] for role in targets),
        'inventory': inventory_binding, 'state': {'path': str(state_path), 'sha256': digest_file(state_path)},
        'duplicates': state['duplicates'], 'gaps': state['gaps'], 'model_calls': 0, 'paid_calls': 0,
        'full_decode_completed': False, 'sound_approved': False, 'usage_approved': False}
    write_json(output / 'prepare-receipt.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True)
    args = parser.parse_args(); print(json.dumps(prepare(read_json(args.config)), ensure_ascii=False))


if __name__ == '__main__':
    main()
