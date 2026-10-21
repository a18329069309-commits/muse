"""Freeze real acquired recordings and explicitly linked research case windows.

--config CONFIG.json. Config needs a NEW output_dir, bound base_library,
bound candidate_records ({candidates: [...]}) and bound case_inputs. Each row
needs recording {path,sha256}, recording_extent, extent_evidence and links.
Links require case_id/step_id/source_event_id, reference_occurrence_range in
the video's case clock and recording_window. reference_original additionally
requires an already verified recording_identity binding. Missing links are
gaps, never inferred from an episode's first case. No audio file is generated,
model invoked, listening certified or Ready qualification changed.
"""
import argparse
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

import corpus_materials
import segment_library
from registered_library_connection import readonly_registered_library


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def token(value):
    return hashlib.sha256(encode(value).encode('utf-8')).hexdigest()[:24]


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return binding(path)


def binding(path):
    path = physical_path(path).resolve()
    return {'path': str(path), 'sha256': segment_library.digest_file(path)}


def physical_path(value):
    """The same Windows file via its extended path, only when normal lookup fails."""
    path = Path(value)
    if os.name != 'nt' or path.is_file() or not path.is_absolute():
        return path
    resolved = str(path.resolve())
    extended = Path('\\\\?\\UNC\\' + resolved[2:] if resolved.startswith('\\\\') else '\\\\?\\' + resolved)
    return extended if extended.is_file() else path


def verify(reference):
    if not isinstance(reference, dict) or not reference.get('path') or not reference.get('sha256'):
        raise ValueError('bound_file_required')
    path = physical_path(reference['path'])
    if not path.is_absolute() or not path.is_file():
        raise ValueError('actual_absolute_file_required')
    before = path.stat()
    actual = binding(path)
    after = path.stat()
    if (actual['sha256'] != reference['sha256'] or
            (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)):
        raise ValueError('file_identity_changed')
    return actual


def compatible_bound_view(reference):
    """Preserve every evidence field and original path in a new snapshot only."""
    actual = verify(reference)
    result = deepcopy(reference)
    if physical_path(reference['path']) != Path(reference['path']):
        result.update(path=actual['path'], original_bound_path=reference['path'],
                      filesystem_path_protocol='windows_extended_same_file_sha_verified_v1')
    return result


def interval(value):
    if (not isinstance(value, list) or len(value) != 2 or any(isinstance(x, bool) or
            not isinstance(x, (int, float)) or not math.isfinite(x) for x in value) or
            not 0 <= value[0] < value[1]):
        raise ValueError('explicit_finite_range_required')
    return list(value)


def contained(inner, outer):
    return outer[0] <= inner[0] < inner[1] <= outer[1]


def decode_recording(reference):
    """Whole-file PCM forward, hashed/countable without persisting an audio preview."""
    source = verify(reference)
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-i', source['path'], '-map', '0:a:0',
            '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1']
    digest, byte_count, nonzero = hashlib.sha256(), 0, False
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
        try:
            for block in iter(lambda: process.stdout.read(1024 * 1024), b''):
                digest.update(block)
                byte_count += len(block)
                nonzero = nonzero or any(block)
            code = process.wait(timeout=120)
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait()
        errors.seek(0)
        diagnostic = errors.read(8192).decode('utf-8', errors='replace')
    if code or byte_count == 0 or byte_count % 8:
        raise ValueError('actual_audio_decode_failed')
    verify(source)
    return {'schema_version': 1, 'source': source, 'protocol': 'ffmpeg_full_decode_pcm_f32le_48k_stereo_v1',
            'argv': args, 'exit_code': code, 'diagnostic': diagnostic,
            'actual_audio_processed': True, 'actual_listening_performed': False,
            'pcm_sha256': digest.hexdigest(), 'pcm_bytes': byte_count,
            'decoded_samples_per_channel': byte_count // 8, 'sample_rate_hz': 48000, 'channels': 2,
            'decoded_duration_seconds': byte_count / 8 / 48000, 'nonzero_pcm_bytes': nonzero,
            'musical_or_plot_suitability_approved': False}


def extent_status(row, recording):
    claimed = row.get('recording_extent', 'unknown')
    if claimed not in ('full_recording', 'official_public_preview_only', 'unknown'):
        return 'unknown', None, 'unknown_recording_extent'
    proof = row.get('extent_evidence') or row.get('acquisition_result')
    if not proof:
        return 'unknown', None, 'recording_extent_evidence_missing'
    proof = verify(proof)
    document = read_json(proof['path'])
    entries = document.get('actual_recordings', [])
    matched = [entry for entry in entries if entry.get('source', {}).get('sha256') == recording['sha256']]
    preview = any(entry.get('scope') == 'official_public_preview_only' for entry in matched)
    if preview:
        return 'official_public_preview_only', proof, ('preview_cannot_close_full_recording' if claimed == 'full_recording' else None)
    material = document.get('material', document.get('source', {}))
    full = (material.get('sha256') == recording['sha256'] and document.get('full_decode_success') is True
            and 'complete_recording' in str(document.get('status', '')))
    full = full or any(entry.get('scope') == 'official_complete_recording' for entry in matched)
    # The full-acquisition consumer has a separate receipt contract from the
    # historical one-recording ledger. Accept its actual complete extent, never
    # a status string alone; recording identity and sound review remain pending.
    full = full or (document.get('full_recording_acquired') is True and any(
        entry.get('scope') == 'complete_official_public_recording'
        and entry.get('requested_extent') == 'full_recording'
        and entry.get('full_entry_extent_verified') is True
        and entry.get('full_file_decode_success') is True
        and float(entry.get('duration_seconds', 0)) > 0 for entry in matched))
    if claimed == 'full_recording' and full:
        return claimed, proof, None
    return 'unknown', proof, 'full_recording_extent_unverified' if claimed == 'full_recording' else 'unknown_recording_extent'


def snapshot_base(reference, output):
    """Materialize all logical rows, including descriptor views, into standalone SQLite."""
    source = verify(reference)
    library = source if Path(source['path']).suffix.lower() == '.json' else source['path']
    if Path(source['path']).suffix.lower() != '.json':
        for suffix in ('-wal', '-shm', '-journal'):
            sidecar = Path(source['path'] + suffix)
            if sidecar.exists() and sidecar.stat().st_size:
                raise ValueError('unbound_base_sqlite_sidecar')
    with closing(readonly_registered_library(library)) as original, closing(sqlite3.connect(output)) as target:
        with target:
            for statement in segment_library.SCHEMA:
                target.execute(statement)
            for table in ('assets', 'segments', 'functions', 'segment_text'):
                rows = original.execute('SELECT * FROM ' + table).fetchall()
                if rows:
                    target.executemany('INSERT INTO ' + table + ' VALUES(' + ','.join('?' * len(rows[0])) + ')', rows)
            target.execute('PRAGMA user_version=1')
    verify(source)
    return source


def load_cases(references):
    cases, sources = {}, []
    for reference in references:
        source = verify(reference)
        document = read_json(source['path'])
        works = {item['work_id']: item for item in document.get('works', [])}
        episodes = {item['episode_id']: item for item in document.get('episodes', [])}
        for case in document.get('cases', []):
            if case['case_id'] in cases:
                raise ValueError('ambiguous_duplicate_case_id')
            episode = episodes[case['episode_id']]
            work = works[episode['work_id']]
            if work.get('split') not in ('research', 'heldout'):
                raise ValueError('explicit_research_or_heldout_split_required')
            cases[case['case_id']] = (case, episode, work, source)
        sources.append(source)
    return cases, sources


def link_window(row, link, cases, recording, duration):
    if not all(link.get(key) for key in ('case_id', 'step_id', 'source_event_id')):
        raise ValueError('explicit_case_step_event_required')
    if link['case_id'] not in cases:
        raise ValueError('actual_case_missing')
    case, episode, work, case_input = cases[link['case_id']]
    step = next((step for step in case.get('development_preset', {}).get('steps', []) if step['step_id'] == link['step_id']), None)
    event = next((event for event in case.get('source_events', []) if event['event_id'] == link['source_event_id']), None)
    if not step or not event or step.get('source_event_id') != event['event_id']:
        raise ValueError('actual_case_step_event_mismatch')
    if (not contained(interval(event.get('source_range')), interval(case.get('source_range'))) or
            not event.get('observation_ids') or not set(event['observation_ids']).issubset(
                case.get('evidence', {}).get('observation_ids', []))):
        raise ValueError('actual_case_event_observation_mismatch')
    occurrence = interval(link.get('reference_occurrence_range'))
    window = interval(link.get('recording_window'))
    if not contained(occurrence, interval(event['source_range'])) or not contained(occurrence, interval(case['source_range'])):
        raise ValueError('occurrence_outside_actual_case_event')
    if not contained(window, [0, duration]):
        raise ValueError('recording_window_outside_actual_decoded_audio')
    video = verify(episode['source_video'])
    if (case.get('evidence', {}).get('source_video_sha256') != video['sha256'] or
            case.get('evidence', {}).get('source_range') != case['source_range']):
        raise ValueError('case_original_video_evidence_mismatch')
    if not case.get('evidence', {}).get('files'):
        raise ValueError('actual_case_observation_file_evidence_missing')
    for evidence_file in case['evidence']['files']:
        verify(evidence_file)
    role = row.get('recording_origin_role', 'unresolved_original_candidate')
    identity = None
    if role == 'reference_original':
        identity = verify(link.get('recording_identity') or row.get('recording_identity'))
        document = read_json(identity['path'])
        if (document.get('status') != 'verified_same_recording' or
                document.get('source_audio', {}).get('sha256') != recording['sha256'] or
                document.get('reference_video', {}).get('sha256') != video['sha256'] or
                case['case_id'] not in document.get('case_ids', [])):
            raise ValueError('existing_original_identity_case_source_mismatch')
        reference_range = interval(document.get('reference_case_use_range'))
        source_range = interval(document.get('source_range'))
        if (not contained(occurrence, reference_range) or
                abs((reference_range[1] - reference_range[0]) - (source_range[1] - source_range[0])) > 0.002):
            raise ValueError('identity_observed_case_clock_alignment_missing')
        expected = [source_range[0] + occurrence[x] - reference_range[0] for x in (0, 1)]
        if max(abs(expected[x] - window[x]) for x in (0, 1)) > 0.002:
            raise ValueError('identity_recording_window_alignment_mismatch')
        verify(document['source_audio'])
        verify(document['reference_video'])
    elif role == 'reviewed_auxiliary':
        identity = verify(row.get('auxiliary_approval'))
        document = read_json(identity['path'])
        if (document.get('source_sha256') != recording['sha256'] or document.get('status') != 'approved' or
                document.get('actual_listening_performed') is not True or
                not contained(window, interval(document.get('source_range')))):
            raise ValueError('existing_auxiliary_approval_scope_mismatch')
    elif role not in ('unresolved_original_candidate', 'research_auxiliary'):
        raise ValueError('explicit_recording_origin_role_required')
    if role == 'unresolved_original_candidate':
        raise ValueError('original_occurrence_recording_identity_unresolved')
    return {'case': case, 'episode': episode, 'work': work, 'case_input': case_input,
            'step_id': step['step_id'], 'source_event_id': event['event_id'], 'reference_occurrence_range': occurrence,
            'recording_window': window, 'recording_origin_role': role, 'identity_evidence': identity,
            'source_video': video, 'lane': work['split']}


def candidate_rows(config, root):
    if config.get('candidate_records'):
        source = verify(config['candidate_records'])
        value = read_json(source['path'])
        rows = value.get('candidates') if isinstance(value, dict) else value
        if not isinstance(rows, list):
            raise ValueError('candidate_records_array_required')
        return rows, source
    # The live inventory's first-case column is deliberately ignored. Freeze payload rows
    # inside one read transaction; exact links must be supplied in payload or link_overrides.
    index = Path(config['candidate_index']).resolve()
    with closing(sqlite3.connect(index.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        rows = [json.loads(row[0]) for row in db.execute('SELECT payload FROM research_candidates ORDER BY candidate_id')]
    for row in rows:
        if row['candidate_id'] in config.get('link_overrides', {}):
            row['links'] = deepcopy(config['link_overrides'][row['candidate_id']])
    source = save(root / 'candidate-index-transaction-export.json', {'schema_version': 1, 'source_index_path': str(index),
        'snapshot_protocol': 'sqlite_read_transaction_logical_payload_export_v1', 'candidates': rows})
    return rows, source


def bridge(config):
    root = Path(config['output_dir']).resolve()
    if root.exists():
        raise ValueError('new_output_snapshot_required')
    root.mkdir(parents=True)
    cases, case_sources = load_cases(config.get('case_inputs', []))
    heldout_work_ids = {item[2]['work_id'] for item in cases.values() if item[2]['split'] == 'heldout'}
    heldout_aliases = {identity for item in cases.values() if item[2]['split'] == 'heldout'
                       for identity in corpus_materials.work_identities(item[2])}
    heldout_video_hashes = {item[1]['source_video']['sha256'] for item in cases.values() if item[2]['split'] == 'heldout'}
    excluded_research_cases = {case_id for case_id, item in cases.items() if item[2]['split'] == 'research' and
        (item[2]['work_id'] in heldout_work_ids or
         heldout_aliases.intersection(corpus_materials.work_identities(item[2])) or
         item[1]['source_video']['sha256'] in heldout_video_hashes)}
    rows, row_source = candidate_rows(config, root)
    gaps, inventories, linked = [], [], []
    decode_cache = {}
    for number, row in enumerate(rows):
        candidate_id = row.get('candidate_id', 'candidate/' + str(number))
        try:
            recording = verify(row.get('recording'))
            if recording['sha256'] not in decode_cache:
                receipt = decode_recording(recording)
                receipt_binding = save(root / 'decode-receipts' / (recording['sha256'] + '.json'), receipt)
                decode_cache[recording['sha256']] = (receipt, receipt_binding)
            receipt, receipt_binding = decode_cache[recording['sha256']]
            extent, extent_evidence, extent_gap = extent_status(row, recording)
            inventory = {'candidate_id': candidate_id, 'recording': recording, 'decode_receipt': receipt_binding,
                'actual_decoded_range': [0, receipt['decoded_duration_seconds']], 'recording_extent': extent,
                'extent_evidence': extent_evidence, 'full_song_acquired': extent == 'full_recording',
                'recording_origin_role': row.get('recording_origin_role', 'unresolved_original_candidate'),
                'status': 'research_pending', 'Ready': False, 'listening_verified': False,
                'all_used_tracks_episode_complete': False}
            inventories.append(inventory)
            if extent_gap:
                gaps.append({'candidate_id': candidate_id, 'gap': extent_gap})
            links = row.get('links')
            if not isinstance(links, list) or not links:
                gaps.append({'candidate_id': candidate_id, 'gap': 'explicit_case_step_event_occurrence_link_pending'})
                continue
            for link_number, link in enumerate(links):
                try:
                    if link.get('case_id') in excluded_research_cases:
                        raise ValueError('heldout_source_or_work_alias_excluded_from_research')
                    result = link_window(row, link, cases, recording, receipt['decoded_duration_seconds'])
                    result.update(inventory=inventory, candidate_id=candidate_id)
                    linked.append(result)
                except (ValueError, KeyError, OSError) as error:
                    gaps.append({'candidate_id': candidate_id, 'link_index': link_number, 'gap': str(error)})
        except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
            gaps.append({'candidate_id': candidate_id, 'gap': str(error)})
    # Honor the existing five-recording comparison budget per case without discarding
    # inventory or conflating several occurrences of one recording with extra sources.
    seen_recordings, bounded_links = {}, []
    for item in linked:
        case_id = item['case']['case_id']; digest = item['inventory']['recording']['sha256']
        seen = seen_recordings.setdefault(case_id, set())
        if digest not in seen and len(seen) >= 5:
            gaps.append({'candidate_id': item['candidate_id'], 'case_id': case_id,
                         'gap': 'five_distinct_recording_case_comparison_budget_exceeded'})
            continue
        seen.add(digest)
        bounded_links.append(item)
    linked = bounded_links
    base = verify(config['base_library'])
    outputs, inputs, sealed_inputs = [], [], []
    for lane in ('research', 'heldout'):
        lane_links = [item for item in linked if item['lane'] == lane]
        if not lane_links and lane == 'heldout':
            continue
        lane_root = root / ('production-research' if lane == 'research' else 'sealed-heldout-validation')
        lane_root.mkdir(parents=True)
        db_path = lane_root / 'segments.sqlite'
        snapshot_base(base, db_path)
        assets, segments, manifests = {}, {}, {}
        # Unlinked recordings are inventory only: importing them here would make them
        # accidentally discoverable without case provenance, or leak heldout inputs.
        for item in lane_links:
            inv = item['inventory']; source = inv['recording']
            asset_id = 'bridge-recording/' + source['sha256']
            segment_id = 'bridge-window/' + token([source['sha256'], item['recording_window'], item['case']['case_id'], item['step_id']])
            assets[asset_id] = {'asset_id': asset_id, 'asset_kind': 'music', 'family_id': 'recording/' + source['sha256'],
                'title': item['candidate_id'], 'local_path': source['path'], 'source_sha256': source['sha256'],
                'commercial_use_allowed': False, 'listening_status': 'pending', 'tag_status': 'research_pending',
                'recording_extent': inv['recording_extent'], 'full_song_acquired': inv['full_song_acquired'],
                'decode_receipt': inv['decode_receipt']}
            window = item['recording_window']
            segments[segment_id] = {'segment_id': segment_id, 'asset_id': asset_id, 'source_sha256': source['sha256'],
                'source_start_seconds': window[0], 'source_end_seconds': window[1], 'phase': 'unknown',
                'listening_status': 'pending', 'vocal_presence': 'unknown', 'narrative_functions': [],
                'case_id': item['case']['case_id'], 'source_event_id': item['source_event_id'],
                'recording_origin_role': item['recording_origin_role'],
                'reference_occurrence_range': item['reference_occurrence_range'],
                'recording_identity_evidence': item['identity_evidence'], 'Ready': False}
            manifests[segment_id] = {**segments[segment_id], 'recording_extent': inv['recording_extent'],
                'full_song_acquired': inv['full_song_acquired'], 'decode_receipt': inv['decode_receipt'],
                'extent_evidence': inv['extent_evidence'], 'listening_verified': False}
            item.update(asset_id=asset_id, segment_id=segment_id)
        asset_file = save(lane_root / 'assets.json', {'assets': list(assets.values())})
        segment_file = save(lane_root / 'segments.json', {'segments': list(segments.values())})
        imported = segment_library.import_library(db_path, asset_file['path'], segment_file['path'], rehash=True)
        library = binding(db_path)
        role_manifest = save(lane_root / 'recording-role-manifest.json', {'schema_version': 1, 'status': 'research_pending',
            'segment_roles': manifests, 'qualification_granted': False})
        groups = {}
        for item in lane_links:
            groups.setdefault((item['work']['work_id'], item['episode']['episode_id']), []).append(item)
        for (work_id, episode_id), group in groups.items():
            group_key = token([work_id, episode_id])
            work_dir = 'w_' + token(work_id); episode_dir = 'e_' + token(episode_id)
            case_doc = {'schema_version': 1, 'works': [deepcopy(group[0]['work'])],
                'episodes': [deepcopy(group[0]['episode'])], 'cases': list({item['case']['case_id']: deepcopy(item['case']) for item in group}.values())}
            for episode in case_doc['episodes']:
                episode['source_video'] = compatible_bound_view(episode['source_video'])
            for case in case_doc['cases']:
                case['evidence']['files'] = [compatible_bound_view(reference) for reference in case['evidence']['files']]
            case_input = save(lane_root / 'research' / work_dir / episode_dir / 'distillation' / 'case-import.json', case_doc)
            tasks = {}
            for item in group:
                key = (item['case']['case_id'], item['step_id'], item['source_event_id'])
                task = tasks.setdefault(key, {'case_id': key[0], 'step_id': key[1], 'source_event_id': key[2],
                    'reason': 'Explicit acquired recording occurrence bridge; technical identity does not certify suitability or listening',
                    'query': {'asset_kind': 'music', 'text': '', 'candidate_segment_ids': [], 'usage_scope': 'research_noncommercial', 'limit': 20}})
                task['query']['candidate_segment_ids'].append(item['segment_id'])
            task_doc = {'schema_version': 1, 'tasks': list(tasks.values())}
            task_file = save(lane_root / 'inputs' / group_key / 'candidate-tasks.json', task_doc)
            evidence = [case_input, task_file, library, row_source, role_manifest, *[item['case_input'] for item in group]]
            candidate_doc = corpus_materials.research_candidate_bindings(case_doc, task_doc, str(db_path), Path(case_input['path']).parent, evidence)
            for task in candidate_doc['tasks']:
                for candidate in task['candidates']:
                    sid = candidate['candidate']['segment_id']; manifest = manifests[sid]
                    candidate['bridge_recording_role'] = deepcopy(manifest)
                    music = candidate['binding']['music'][0]
                    music['recording_origin_role'] = manifest['recording_origin_role']
                    music['source_relation'] = ('fingerprint_candidate' if manifest['recording_origin_role'] == 'reference_original' else 'candidate_substitute')
                    music['original_recording_evidence'] = manifest['recording_identity_evidence'] if manifest['recording_origin_role'] == 'reference_original' else None
                    music['reference_occurrence_range'] = manifest['reference_occurrence_range']
                    music['full_song_acquired'] = manifest['full_song_acquired']
                    music['recording_extent'] = manifest['recording_extent']
                    music['listening_verified'] = False
            candidate_doc.update(case_input=case_input, frozen_library_binding=library, recording_role_manifest=role_manifest,
                status='research_pending', production_approval=False, Ready=False,
                heldout_sealed=lane == 'heldout', original_recording_identity_is_not_listening_approval=True)
            destination = lane_root / 'work-results' / work_dir / ('v_' + group_key) / 'corpus' / 'material-candidates' / 'bridge' / 'candidate-bindings.json'
            result = save(destination, corpus_materials.compact_candidate_evidence(candidate_doc))
            fragment = {'input': case_input['path'], 'tasks': task_file['path'], 'input_binding': case_input,
                'tasks_binding': task_file, 'bridge_candidate_bindings': result, 'recording_role_manifest': role_manifest,
                'split': lane, 'research_discovery_allowed': lane == 'research', 'production_publish_allowed': False}
            (inputs if lane == 'research' else sealed_inputs).append(fragment)
        outputs.append({'lane': lane, 'frozen_library': library, 'base_library': base, 'asset_catalog': asset_file,
            'segment_catalog': segment_file, 'recording_role_manifest': role_manifest, 'import_report': imported,
            'discovery_root': str(lane_root), 'heldout_isolated': lane == 'heldout'})
    verify(base)
    report = {'schema_version': 1, 'status': 'research_pending', 'producer': binding(__file__), 'candidate_records': row_source,
        'case_inputs': case_sources, 'inventory': inventories, 'gaps': gaps, 'frozen_libraries': outputs,
        'material_candidate_inputs': inputs, 'sealed_validation_inputs': sealed_inputs,
        'consumer_config_fragment': {'discovery_root': str(root / 'production-research'),
            'library_db': str(root / 'production-research' / 'segments.sqlite')},
        'standard_retrieval_role_policy': 'Ordinary retrieval is unqualified candidate_substitute; preserve original/auxiliary origin through bound recording_role_manifest and bridge candidate-bindings, never infer hearing',
        'Ready': False, 'qualification_granted': False, 'new_trial_rendered': False,
        'all_used_tracks_episode_complete': False, 'base_library_unchanged': True,
        'counts': {'candidate_records': len(rows), 'decoded_unique_recordings': len(decode_cache),
            'linked_occurrences': len(linked), 'research_input_groups': len(inputs), 'sealed_input_groups': len(sealed_inputs)}}
    save(root / 'bridge-receipt.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = bridge(read_json(args.config))
        print(encode({'status': result['status'], 'counts': result['counts'], 'gaps': len(result['gaps']), 'Ready': False}))
    except (ValueError, KeyError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        parser.exit(1, 'bridge_original_candidates: ' + str(error) + '\n')
