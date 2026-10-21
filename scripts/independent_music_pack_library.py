"""Frozen independent diagnostic recordings, actual windows and editorial recipes.

Uses the existing assets/segments schema; does not assign invented case IDs,
listen to music, identify a musical phrase or approve a song's dramatic use.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import threading
import urllib.request

from segment_library import SCHEMA, search_words, commercial_use
from independent_recording_checks import (bounded_source_identity, cached_recording_checks,
    probe_audio, technical_observation, technical_processor_sha256, write_json)


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def checked_binding(value):
    file = Path(value['path'] if isinstance(value, dict) else value)
    if not file.is_absolute() or not file.is_file():
        raise ValueError('music_packs_absolute_existing_file_required')
    digest = digest_file(file)
    if isinstance(value, dict) and value.get('sha256') != digest:
        raise ValueError('music_packs_source_catalogue_changed')
    return file, digest


def publisher_voice_candidate(row):
    return (row.get('publisher_variant_label') == 'Full Song'
        or row.get('publisher_vocal_hint') is True
        or 'instrument---voice' in row.get('source_tags', []))


def metadata_views(row, observation):
    """Keep publisher, measured and editorial evidence separate for retrieval."""
    return {
        'publisher': {'tags': row.get('publisher_tags', row.get('source_tags', [])),
            'genre': row.get('genre_preferences', []),
            'instruments': row.get('instrument_preferences', row.get('publisher_instruments', [])),
            'language_hint': row.get('vocal_language_hint', 'unknown'),
            'vocal_candidate': publisher_voice_candidate(row),
            'basis': 'publisher_annotation_not_actual_window_sound',
            'source_page': row.get('source_page')},
        'editorial': {'narrative_functions': row.get('narrative_functions', []),
            'substyles': row.get('substyles', []), 'conditions': row.get('conditions', []),
            'exclusions': row.get('exclusions', []),
            'basis': row.get('tag_status', row.get('preset_association_basis', 'unverified_metadata_hypothesis')),
            'usage_approved': False},
        'measured': {'kind': observation.get('kind'), 'input_sha256': observation.get('input_sha256'),
            'time_resolution_seconds': observation.get('time_resolution_seconds'),
            'sound_facts_qualified': False},
        'human_review': {'status': 'pending', 'window_approval_not_inferred': True}}


PRESET_DEFINITIONS = [
    ('sustained-danger', '持续危机', ['danger_introduced', 'threat_approaches', 'action_begins'],
     ['withhold_release', 'increase_pressure', 'drive_action'], ['danger_unresolved'], ['celebration', 'comic_relief']),
    ('humiliation-counteraction', '受辱反制', ['humiliation', 'decision_to_resist', 'counteraction'],
     ['hold_tension', 'gather_force', 'deliver_counteraction'], ['injury_or_insult_has_consequence'], ['joke_after_violence']),
    ('betrayal-refusal', '背弃决裂', ['abandoned', 'former_allies_plead', 'protagonist_refuses'],
     ['sustain_hurt', 'assert_agency', 'resolve_separation'], ['refusal_is_final'], ['romantic_reconciliation']),
    ('family-change', '亲情变化', ['regret', 'recognition', 'acceptance'],
     ['restrained_regret', 'recognition_turn', 'warmth_without_triumph'], ['family_relation'], ['romantic_desire']),
    ('era-transition', '年代转换', ['time_displacement', 'new_street_environment', 'new_relation'],
     ['bridge_transition', 'introduce_era_texture', 'stabilize_theme'], ['era_change'], ['anachronism_unexplained']),
    ('relationship-resolution', '关系兑现', ['guarded_closeness', 'mutual_choice', 'relationship_acceptance'],
     ['create_space', 'enter_lyric_if_semantic_fit', 'resolve_theme'], ['mutual_relationship_change'], ['danger_unresolved']),
    ('free-departure', '自由离场', ['constraint_released', 'self_directed_choice', 'departure'],
     ['release_pressure', 'expand_motion', 'full_phrase_departure'], ['freedom_gained'], ['escape_under_active_pursuit']),
    ('agency-light-irony', '人物自主与轻爽反讽', ['status_revealed', 'choice_asserted', 'ironic_payoff'],
     ['confident_motion', 'support_agency', 'controlled_light_payoff'], ['protagonist_controls_choice'], ['oppressive_wordless_chant', 'comic_after_harm']),
]


def editorial_presets():
    return [{'preset_id': 'editorial/' + key, 'title': title,
        'basis': 'editorial_recipe_not_distilled_success_case', 'case_ids': [],
        'conditions': conditions, 'exclusions': exclusions,
        'steps': [{'step_id': key + '/' + str(index + 1), 'event_anchor': event,
                   'sound_action': action, 'relative_timing': {'event': event, 'offset_seconds': 0},
                   'music_pack_ids': [], 'sound_pack_ids': []}
                  for index, (event, action) in enumerate(zip(events, actions))],
        'artistic_approval': False, 'production_approval': False}
        for key, title, events, actions, conditions, exclusions in PRESET_DEFINITIONS]


def acquire_inputs(inputs, root):
    """Explicit author URLs from config, bounded downloads; failures stay per item."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    results = []
    total_slots = threading.BoundedSemaphore(4)
    def acquire(item):
        record = dict(item)
        key = re.sub(r'[^a-zA-Z0-9._-]', '-', record.get('record_id', 'recording'))
        destination = root / (key + '.mp3')
        receipt = root / (key + '.receipt.json')
        try:
            url, page = record['download_url'], record['source_page']
            if not url.startswith('https://') or not page.startswith('https://'):
                raise ValueError('music_packs_https_author_source_required')
            if receipt.exists() and destination.exists():
                saved = read_json(receipt)
                if saved.get('sha256') == digest_file(destination) and saved.get('full_decode', {}).get('exit_code') == 0:
                    return {**saved, 'cache_reused': True}
                raise ValueError('music_packs_acquisition_cache_identity_changed')
            page_file = root / (key + '.page.html')
            if not page_file.exists():
                with total_slots, urllib.request.urlopen(urllib.request.Request(page, headers={'User-Agent': 'IndependentMusicPacks/1.0'}), timeout=30) as response:
                    body = response.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise ValueError('music_packs_source_page_too_large')
                page_file.write_bytes(body)
            page_text = page_file.read_text(encoding='utf-8').replace('\\/', '/')
            if record.get('require_url_in_page', True):
                relative = re.sub(r'^https://[^/]+', '', url)
                if url not in page_text and relative not in page_text:
                    raise ValueError('music_packs_download_not_in_author_page')
            if destination.exists():
                raise ValueError('music_packs_unfinished_file_preserved_requires_recovery_path')
            with total_slots, urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'IndependentMusicPacks/1.0'}), timeout=45) as response, destination.open('xb') as out:
                expected = response.headers.get('Content-Length')
                total = 0
                for block in iter(lambda: response.read(1024 * 1024), b''):
                    total += len(block)
                    if total > 40 * 1024 * 1024:
                        raise ValueError('music_packs_single_download_over_limit')
                    out.write(block)
                if expected and total != int(expected):
                    raise ValueError('music_packs_incomplete_download')
            record.update(probe_audio(destination))
            record.update({'path': str(destination.absolute()), 'source_page_evidence': {
                'path': str(page_file.absolute()), 'sha256': digest_file(page_file)},
                'status': 'acquired_and_full_decode_passed_not_sound_or_usage_approved'})
            write_json(receipt, record)
        except Exception as error:
            record.update({'status': 'acquisition_gap', 'error': type(error).__name__ + ': ' + str(error)})
            write_json(root / (key + '.failure.json'), record)
        return record
    # Total 4, each domain effectively <=2 by grouping caller inputs in pairs.
    domains = {}
    for item in inputs:
        domains.setdefault(item['source_page'].split('/')[2], []).append(item)
    with ThreadPoolExecutor(max_workers=4) as domain_pool:
        def group(items):
            with ThreadPoolExecutor(max_workers=2) as pool:
                return list(pool.map(acquire, items))
        for group_result in domain_pool.map(group, domains.values()):
            results.extend(group_result)
    return results


def make_windows(asset, observation, supplied=None):
    duration = asset['duration_seconds']
    ranges = supplied
    if ranges is None:
        # Search windows are not musical phrases. Continuous windows preserve
        # the beginning/end and can be observed or subdivided later.
        length, step = min(80.0, duration), 60.0
        starts = list(range(0, max(1, int(duration - length) + 1), int(step)))
        if not starts or starts[-1] + length < duration:
            starts.append(max(0.0, duration - length))
        ranges = [[float(start), min(float(start) + length, duration)] for start in sorted(set(starts))]
    windows = []
    for index, pair in enumerate(ranges):
        if not isinstance(pair, list) or len(pair) != 2 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in pair) or not 0 <= pair[0] < pair[1] <= duration:
            raise ValueError('music_packs_window_out_of_source')
        start, end = pair
        token = hashlib.sha256(json.dumps([asset['source_sha256'], pair]).encode()).hexdigest()[:20]
        points = observation.get('rms_dbfs', [])[int(start):max(int(start) + 1, int(end))]
        energy = sum(points) / len(points) if points else None
        third = max(1, len(points) // 3)
        energy_change = (sum(points[-third:]) - sum(points[:third])) / third if points else None
        windows.append({'window_id': 'window/' + token, 'segment_id': 'window/' + token,
            'pack_id': asset['pack_id'], 'asset_id': asset['asset_id'], 'source_sha256': asset['source_sha256'],
            'source_range': pair, 'source_start_seconds': start, 'source_end_seconds': end,
            'phase': 'unknown', 'listening_status': 'pending', 'vocal_presence': 'unknown',
            'lyrics_state': 'pending', 'lyrics': [], 'phrase_boundaries_verified': False,
            'development_roles': ['unverified_development_candidate'], 'preset_ids': asset.get('preset_ids', []),
            'conditions': asset.get('conditions', []), 'exclusions': asset.get('exclusions', []),
            'entry_candidates': [{'source_seconds': start, 'basis': 'window_boundary_not_phrase'}],
            'exit_candidates': [{'source_seconds': end, 'basis': 'window_boundary_not_phrase'}],
            'connection_margin_seconds': {'before': min(5.0, start), 'after': min(5.0, duration - end)},
            'connection_margin_approved': False, 'status': 'diagnostic_candidate',
            'contamination': 'unknown', 'source': {'path': asset['local_path'], 'sha256': asset['source_sha256']},
            'path': asset['local_path'], 'local_path': asset['local_path'],
            'recording_duration_seconds': duration, 'duration_seconds': duration,
            'narrative_functions': [], 'description': asset.get('description', '') + ' ' + asset.get('publisher_description', '')
                + ' Publisher labels: ' + ' '.join(asset.get('publisher_tags', asset.get('source_tags', []))),
            'technical_rms_dbfs': energy, 'source_relation': asset['source_relation'],
            'technical_energy_change_db': energy_change,
            'technical_energy_direction': 'unknown' if energy_change is None else
                'rising' if energy_change > 3 else 'falling' if energy_change < -3 else 'approximately_steady',
            'adaptation': {'source_clock': 'independent_recording_seconds',
                'window_kind': 'search_interval_not_verified_phrase',
                'available_margin_seconds': {'before': start, 'after': duration - end},
                'connection_margin_approved': False,
                'unknowns': ['actual_sound_content', 'cleanliness', 'musical_phrase_boundaries',
                    'dramatic_use', 'lyric_words_and_complete_sentence' if asset.get('publisher_vocal_hint') else 'actual_vocal_presence'],
                'classification': asset.get('metadata_views', {})},
            'sound_review': 'pending', 'usage_review': 'pending', 'lyrics_review': 'pending',
            'artistic_approval': False, 'production_approval': False})
    return windows


def build(config):
    if config.get('mode') != 'research' or config.get('trial_review_policy') != 'diagnostic_candidates':
        raise ValueError('music_packs_explicit_diagnostic_research_required')
    output = Path(config['output_dir']).absolute()
    output.mkdir(parents=True, exist_ok=True)
    records, source_bindings, gaps = [], [], []
    for binding in config.get('source_catalogues', []):
        file, sha = checked_binding(binding)
        document = read_json(file)
        rows = document if isinstance(document, list) else document.get('records', document.get('assets'))
        if not isinstance(rows, list):
            raise ValueError('music_packs_source_records_required')
        records.extend(rows)
        source_bindings.append({'path': str(file), 'sha256': sha})
    for folder in config.get('local_folders', []):
        directory = Path(folder)
        if not directory.is_absolute() or not directory.is_dir():
            raise ValueError('music_packs_absolute_local_folder_required')
        for file in sorted(directory.rglob('*')):
            if file.suffix.lower() in ('.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus') and file.is_file():
                records.append({'record_id': 'user-file/' + hashlib.sha256(str(file).encode()).hexdigest()[:16],
                    'title': file.stem, 'path': str(file.absolute()), 'origin': 'user_provided',
                    'requested_extent': 'user_provided_recording_unknown_original_extent'})
    if config.get('acquisition_inputs'):
        acquired = acquire_inputs(config['acquisition_inputs'], config['acquisition_dir'])
        for row in acquired: row.pop('cache_reused', None)
        source_bindings.append(write_json(output / 'acquisition-records.json', {'records': acquired}))
        records.extend(acquired)
    workers = config.get('decode_workers', 1)
    if isinstance(workers, bool) or not isinstance(workers, int) or not 1 <= workers <= 2:
        raise ValueError('music_packs_decode_workers_must_be_one_or_two')
    timeout_names = {'source_hash_timeout_seconds': 60, 'probe_timeout_seconds': 30,
        'decode_timeout_seconds': 180, 'technical_cache_lock_timeout_seconds': 240}
    timeouts = {}
    for name, default in timeout_names.items():
        value = config.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 3600:
            raise ValueError('music_packs_invalid_timeout: ' + name)
        timeouts[name] = value
    compatible_revisions = config.get('technical_cache_compatible_processor_sha256s', [])
    if (not isinstance(compatible_revisions, list) or len(compatible_revisions) > 20
            or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value) for value in compatible_revisions)):
        raise ValueError('music_packs_invalid_compatible_processor_revisions')
    checked, candidates, observation_by_sha = [], {}, {}
    cache_reuses = 0
    for record in records:
        if not isinstance(record, dict):
            gaps.append({'record_id': None, 'gap': 'invalid_source_record', 'recording_published': False})
            continue
        if record.get('status') in ('acquisition_gap', 'source_probe_failed'):
            gaps.append({'record_id': record.get('record_id'), 'gap': record.get('error')}); continue
        if (record.get('content_rejected') is True or record.get('contamination') in
                ('dialogue', 'dialogue_residual', 'scene_effects', 'polluted', 'rejected')):
            gaps.append({'record_id': record.get('record_id'), 'gap': 'explicitly_rejected_or_contaminated_recording'})
            continue
        try:
            file = Path(record.get('path', record.get('local_path', '')))
        except (TypeError, ValueError):
            gaps.append({'record_id': record.get('record_id'), 'gap': 'recording_not_available',
                'detail': 'invalid source path', 'recording_published': False})
            continue
        if not file.is_absolute():
            gaps.append({'record_id': record.get('record_id'), 'gap': 'recording_not_available'}); continue
        for name in ('publisher_metadata', 'publisher_catalogue', 'source_page_evidence'):
            if isinstance(record.get(name), dict) and record[name].get('path') and record[name].get('sha256'):
                evidence_file, evidence_digest = checked_binding(record[name])
                source_bindings.append({'path': str(evidence_file), 'sha256': evidence_digest})
        candidates.setdefault(str(file), {'file': file, 'records': []})['records'].append(record)

    def source_gap(record, file, error, stage):
        detail = str(getattr(error, 'stderr', None) or error)[-1000:]
        if isinstance(error, (subprocess.TimeoutExpired, TimeoutError)):
            reason = 'recording_check_timeout'
        elif isinstance(error, FileNotFoundError):
            reason = 'recording_not_available'
        elif 'recording_sha_changed' in detail or 'recording_changed_during_check' in detail:
            reason = 'recording_identity_changed'
        elif 'technical_cache_changed' in detail:
            reason = 'recording_cache_integrity_failed'
        elif isinstance(error, OSError):
            reason = 'recording_source_unavailable'
        else:
            reason = 'recording_decode_failed'
        return {'record_id': record.get('record_id'), 'gap': reason, 'stage': stage,
            'source_path': str(file), 'detail': detail, 'recording_published': False}

    def hash_one(candidate):
        file, rows = candidate['file'], candidate['records']
        try:
            identity = bounded_source_identity(file, timeouts['source_hash_timeout_seconds'])
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            return [], [source_gap(record, file, error, 'source_identity') for record in rows]
        valid, errors = [], []
        for record in rows:
            claimed = record.get('sha256', record.get('source_sha256'))
            if claimed and claimed != identity['sha256']:
                errors.append(source_gap(record, file, ValueError('music_packs_recording_sha_changed'), 'source_identity'))
            else:
                valid.append((record, file, identity))
        return valid, errors

    # Establish real content identity before any full decoding. Aliases do not
    # consume another decoder slot or increase independent recording counts.
    groups = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for valid, errors in pool.map(hash_one, candidates.values()):
            gaps.extend(errors)
            for candidate in valid:
                groups.setdefault(candidate[2]['sha256'], []).append(candidate)

    def check_group(group):
        record, file, before = group[0]
        try:
            identity, observation, hit = cached_recording_checks(file, before['sha256'],
                config.get('technical_cache_dir'), source_identity=before,
                hash_timeout=timeouts['source_hash_timeout_seconds'],
                probe_timeout=timeouts['probe_timeout_seconds'],
                decode_timeout=timeouts['decode_timeout_seconds'],
                cache_lock_timeout=timeouts['technical_cache_lock_timeout_seconds'],
                compatible_processor_sha256s=compatible_revisions)
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            return None, [source_gap(alias, path, error, 'local_source_probe') for alias, path, _ in group]
        valid = [(record, file, before)]
        errors, verified_paths = [], {str(file)}
        for alias, path, original in group[1:]:
            if str(path) not in verified_paths:
                try:
                    current = bounded_source_identity(path, timeouts['source_hash_timeout_seconds'])
                    if any(current[key] != original[key] for key in ('sha256', 'bytes', 'mtime_ns')):
                        raise ValueError('music_packs_recording_changed_during_check')
                    verified_paths.add(str(path))
                except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
                    errors.append(source_gap(alias, path, error, 'alias_identity'))
                    continue
            valid.append((alias, path, original))
        row = {**record, **identity, 'path': str(file.absolute()),
            'aliases': [alias.get('record_id') for alias, _, _ in valid[1:]],
            'source_aliases': [{'record_id': alias.get('record_id'), 'path': str(path.absolute()),
                **original} for alias, path, original in valid],
            'source_record_count': len(valid), 'file_identity_verified': True,
            'full_decode_verified': True, 'timeline_clock_verified': True, 'rms_ready': True,
            'verified_extent': 'entire_provided_file_decoded_not_release_completeness'}
        return (row, observation, hit), errors

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result, errors in pool.map(check_group, groups.values()):
            gaps.extend(errors)
            if result:
                row, observation, hit = result
                checked.append(row)
                observation_by_sha[row['sha256']] = observation
                cache_reuses += int(hit)
    if not checked:
        write_json(output / 'recording-check-failures.json', {'gaps': gaps,
            'recording_files': 0, 'model_calls': 0, 'paid_calls': 0})
        raise ValueError('music_packs_no_decoded_recordings: ' + '; '.join(gap.get('detail', gap['gap']) for gap in gaps[:3]))
    source_bindings = list({(ref['path'], ref['sha256']): ref for ref in source_bindings}.values())
    version_input = {'sources': source_bindings,
        'recordings': [{key: row.get(key) for key in ('record_id', 'sha256', 'recording_family_id', 'preset_ids', 'source_windows',
            'source_aliases', 'duration_samples', 'timeline_sample_rate_hz', 'full_decode', 'technical_cache_provenance')} for row in checked],
        'builder_sha256': digest_file(__file__), 'technical_processor_sha256': technical_processor_sha256(),
        'preset_definitions': PRESET_DEFINITIONS}
    version = hashlib.sha256(json.dumps(version_input, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    snapshot = output / 'snapshots' / version[:20]
    existing = snapshot / 'publication.json'
    if existing.exists():
        document = read_json(existing)
        checked_binding(document['library'])
        return {'status': 'frozen_diagnostic_library_reused', 'publication': {'path': str(existing.absolute()), 'sha256': digest_file(existing)},
                'library': document['library'], 'counts': document['counts'], 'gaps': gaps,
                'technical_cache_reuses': cache_reuses, 'model_calls': 0, 'paid_calls': 0}
    snapshot.mkdir(parents=True, exist_ok=True)
    assets, segments, packs = [], [], {}
    observations = snapshot / 'observations'; observations.mkdir(exist_ok=True)
    # Each recording is decoded once for low-resolution RMS, never by candidate.
    for row in checked:
        digest = row['sha256']
        family = row.get('recording_family_id', row.get('family_id', row.get('record_id', 'recording/' + digest)))
        pack_id = 'independent-pack/' + hashlib.sha256(family.encode()).hexdigest()[:20]
        asset = {**row, 'asset_id': 'independent-recording/' + digest[:24], 'family_id': family,
            'pack_id': pack_id, 'source_sha256': digest, 'local_path': row['path'], 'asset_kind': 'music',
            'source_relation': 'user_provided' if row.get('origin') in
                ('user_provided', 'user_supplied_local_library') else 'independent_library',
            'listening_status': 'pending', 'fulltrack_voice_hint': publisher_voice_candidate(row),
            'publisher_vocal_hint': publisher_voice_candidate(row),
            'actual_window_vocals_verified': False, 'sound_review': 'pending', 'usage_review': 'pending',
            'production_approval': False, 'artistic_approval': False}
        if not asset.get('preset_ids'):
            scott_proposals = {'sanctuary': ['sustained-danger'], 'undertow': ['betrayal-refusal'],
                'ascension': ['humiliation-counteraction', 'free-departure'], 'inflection': ['relationship-resolution'],
                'home-was-you': ['family-change'], 'effervescence': ['free-departure', 'agency-light-irony'],
                'childhood': ['family-change', 'era-transition'], 'awakening': ['relationship-resolution', 'free-departure']}
            key = str(row.get('record_id', '')).split(':')[-1]
            asset['preset_ids'] = ['editorial/' + value for value in scott_proposals.get(key, [])]
            if not asset['preset_ids'] and row.get('publisher_variant_label') in ('Full Song', 'Instrumental Mix'):
                asset['preset_ids'] = ['editorial/relationship-resolution', 'editorial/free-departure']
            asset['preset_association_basis'] = 'editorial_candidate_proposal_not_usage_approval'
        if asset['publisher_vocal_hint']:
            asset['fulltrack_voice_annotation'] = {'label': 'voice', 'basis': 'publisher_variant_hint_not_window_observation',
                'source_page': row.get('source_page'), 'window_qualified': False}
        observation = observation_by_sha[digest]
        asset['metadata_views'] = metadata_views(row, observation)
        asset['technical_observation'] = write_json(observations / (digest[:24] + '.json'), observation)
        windows = make_windows(asset, observation, row.get('source_windows'))
        assets.append(asset); segments.extend(windows)
        pack = packs.setdefault(pack_id, {'pack_id': pack_id, 'family_id': family, 'title': row.get('title', row.get('record_id')),
            'source_relation': asset['source_relation'], 'recordings': [], 'windows': [],
            'reference_drama_ids': [], 'case_ids': [], 'basis': 'independent_author_recording_not_reference_drama',
            'status': 'diagnostic_candidate', 'artistic_approval': False, 'production_approval': False})
        pack['recordings'].append(asset); pack['windows'].extend(windows)
    database = snapshot / 'segments.sqlite'
    db = sqlite3.connect(database)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        for statement in SCHEMA: db.execute(statement)
        db.execute('PRAGMA user_version=1')
        for asset in assets:
            db.execute('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (asset['asset_id'], asset['source_sha256'], asset['family_id'], asset['local_path'], asset['bytes'], asset['mtime_ns'],
                 asset['duration_seconds'], asset['sample_rate_hz'], asset['channels'], int(commercial_use(asset)), 0, 0,
                 json.dumps(asset, ensure_ascii=False)))
        by_asset = {row['asset_id']: row for row in assets}
        for segment in segments:
            db.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)',
                (segment['segment_id'], segment['asset_id'], segment['source_sha256'], *segment['source_range'],
                 'unknown', 'pending', json.dumps(segment, ensure_ascii=False)))
            db.execute('INSERT INTO segment_text VALUES(?,?)',
                (segment['segment_id'], search_words(by_asset[segment['asset_id']], segment)))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('music_packs_sqlite_integrity_failed')
    finally:
        db.close()
    asset_ref = write_json(snapshot / 'assets.json', {'assets': assets})
    segments_ref = write_json(snapshot / 'segments.json', {'segments': segments})
    presets = editorial_presets()
    for preset in presets:
        linked = [row for row in segments if preset['preset_id'] in row['preset_ids']]
        preset['candidate_music_pack_ids'] = list(dict.fromkeys(row['pack_id'] for row in linked))
        preset['candidate_window_refs'] = [{key: row[key] for key in
            ('pack_id', 'window_id', 'asset_id', 'source_sha256', 'source_range')} for row in linked]
        preset['material_link_basis'] = 'editorial_candidate_group_not_sound_or_usage_approval'
        for step in preset['steps']:
            step['candidate_music_pack_ids'] = preset['candidate_music_pack_ids']
            step['candidate_window_refs'] = preset['candidate_window_refs']
            step['selection_status'] = 'compare_actual_window_before_applying'
    presets_ref = write_json(snapshot / 'presets.json', {'presets': presets})
    library = {'path': str(database.absolute()), 'sha256': digest_file(database)}
    counts = {'recording_files': len(assets), 'recording_families': len(packs), 'unique_recording_hashes': len(assets),
              'source_record_count': sum(row['source_record_count'] for row in assets),
              'duplicate_source_records': sum(row['source_record_count'] - 1 for row in assets),
              'source_windows': len(segments), 'editorial_presets': len(PRESET_DEFINITIONS),
              'publisher_vocal_candidates': sum(bool(row.get('publisher_vocal_hint')) for row in assets),
              'sound_approved_windows': 0, 'usage_approved_windows': 0, 'qualified_lyrics_windows': 0,
              'production_approved_packs': 0, 'decoded_recording_seconds': sum(row['duration_seconds'] for row in assets),
              'publisher_lyrics_candidates': sum(row.get('publisher_variant_label') == 'Full Song' for row in assets),
              'metadata_adapted_windows': len(segments)}
    publication = {'schema_version': 1, 'kind': 'independent_music_pack_publication', 'publication_id': 'independent/' + version,
        'material_strategy': 'independent_music_packs', 'mode': 'research', 'trial_review_policy': 'diagnostic_candidates',
        'library': library, 'assets': asset_ref, 'segments': segments_ref, 'preset_index': presets_ref,
        'packs': list(packs.values()), 'windows': segments, 'presets': presets, 'source_catalogues': source_bindings,
        'counts': counts, 'gaps': gaps, 'artistic_approval': False, 'production_approval': False,
        'source_policy_scope': 'independent_diagnostic_research_only', 'original_route_coexists': True,
        'original_reference_ratio_policy_unchanged': True, 'human_audition_performed': False,
        'professional_audio_review_qualified': False, 'reference_drama_identity_claimed': False,
        'meaning': 'Actual decoded recordings and search windows; audition, full lyrics, phrase and usage remain pending.'}
    publication_ref = write_json(existing, publication)
    return {'status': 'frozen_diagnostic_library_built', 'publication': publication_ref,
            'library': library, 'counts': counts, 'gaps': gaps,
            'technical_cache_reuses': cache_reuses, 'model_calls': 0, 'paid_calls': 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['build'])
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = build(read_json(args.input))
    write_json(args.output, result)
    print(json.dumps({'status': result['status'], 'counts': result['counts'], 'gaps': len(result['gaps'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
