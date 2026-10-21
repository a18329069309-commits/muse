"""Bind explicit reference matches/substitutes to real library windows; compile case-grounded rule candidates."""
import argparse
import hashlib
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

from case_preset_store import file_binding, readonly, source_range, text, sha, bound_audio_evidence, work_identities
import segment_library
from registered_library_connection import readonly_registered_library
from route_music_cues import QUERY_FIELDS


def compact_candidate_evidence(document):
    """Intern repeated file evidence without dropping duplicates, order or extra fields."""
    table = {}
    def walk(value):
        if isinstance(value, list): return [walk(item) for item in value]
        if not isinstance(value, dict): return value
        if 'evidence_refs' in value: raise ValueError('candidate_evidence_already_encoded')
        output = {}
        for key, item in value.items():
            if key != 'evidence_files':
                output[key] = walk(item)
                continue
            refs = []
            for binding in item:
                encoded = json.dumps(binding, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
                identity = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
                table[identity] = deepcopy(binding)
                refs.append(identity)
            output['evidence_refs'] = refs
        return output
    result = walk(document)
    result['evidence_encoding'] = {'version': 1, 'original_schema_version': document['schema_version']}
    result['schema_version'] = 2
    result['evidence_table'] = table
    return result


def expand_candidate_evidence(document):
    if 'evidence_encoding' not in document: return deepcopy(document)
    encoding, table = document['evidence_encoding'], document.get('evidence_table', {})
    if document.get('schema_version') != 2 or encoding.get('version') != 1:
        raise ValueError('candidate_evidence_encoding_unsupported')
    for identity, binding in table.items():
        encoded = json.dumps(binding, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        if hashlib.sha256(encoded.encode('utf-8')).hexdigest() != identity:
            raise ValueError('candidate_evidence_identity_changed')
    def walk(value):
        if isinstance(value, list): return [walk(item) for item in value]
        if not isinstance(value, dict): return value
        if 'evidence_refs' in value and 'evidence_files' in value:
            raise ValueError('candidate_evidence_encoding_ambiguous')
        return {('evidence_files' if key == 'evidence_refs' else key):
                ([deepcopy(table[ref]) for ref in item] if key == 'evidence_refs' else walk(item))
                for key, item in value.items()}
    result = walk({key: item for key, item in document.items() if key not in ('evidence_encoding', 'evidence_table')})
    result['schema_version'] = encoding['original_schema_version']
    return result


def research_candidate_bindings(document, tasks, library_db, base_dir, evidence_files):
    """Retrieve bounded alternatives for explicit events; never choose a recording or claim hearing."""
    if tasks.get('schema_version') != 1 or not isinstance(tasks.get('tasks'), list):
        raise ValueError('explicit_material_candidate_tasks_required')
    base = Path(base_dir).resolve()
    hash_cache = {}
    evidence = [file_binding(row, base, hash_cache) for row in evidence_files]
    if not evidence: raise ValueError('material_binding_evidence_required')
    cases = {row['case_id']: row for row in document.get('cases', [])}
    episodes = {row['episode_id']: row for row in document.get('episodes', [])}
    results, covered, seen_tasks, source_files = [], set(), set(), []
    with closing(readonly_registered_library(library_db)) as library:
        for task in tasks['tasks']:
            case = cases.get(task.get('case_id'))
            step = next((row for row in (case or {}).get('development_preset', {}).get('steps', [])
                         if row['step_id'] == task.get('step_id')), None)
            event = next((row for row in (case or {}).get('source_events', [])
                          if row['event_id'] == task.get('source_event_id')), None)
            if not case or not step or not event or step.get('source_event_id') != event['event_id']:
                raise ValueError('material_candidate_task_requires_bound_case_step_event')
            key = (case['case_id'], step['step_id'])
            covered.add(key)
            parent = file_binding(episodes[case['episode_id']]['source_video'], base, hash_cache)
            if (case.get('evidence', {}).get('source_video_sha256') != parent['sha256']
                    or case['evidence'].get('source_range') != case['source_range']):
                raise ValueError('material_case_source_mismatch')
            interval, event_range = source_range(case['source_range']), source_range(event['source_range'])
            if (not interval[0] <= event_range[0] < event_range[1] <= interval[1]
                    or not event.get('observation_ids')
                    or not set(event['observation_ids']).issubset(case['evidence'].get('observation_ids', []))):
                raise ValueError('material_candidate_event_evidence_mismatch')
            source_files.append(parent)
            reason = text(task.get('reason'), 'material_candidate_task_reason')
            query = deepcopy(task.get('query'))
            if (not isinstance(query, dict) or set(query) - QUERY_FIELDS
                    or query.get('asset_kind') not in ('music', 'sfx', 'ambience')
                    or not isinstance(query.get('text', ''), str)
                    or not (query.get('text', '').strip() or query.get('candidate_segment_ids'))
                    or query.get('usage_scope', 'research_noncommercial') != 'research_noncommercial'):
                raise ValueError('explicit_research_sound_query_required')
            query.update(usage_scope='research_noncommercial', limit=query.get('limit', 20), preserve_source_windows=True)
            if isinstance(query['limit'], bool) or not isinstance(query['limit'], int) or not 1 <= query['limit'] <= 20:
                raise ValueError('research_recall_limit_must_be_1_to_20')
            role = task.get('sound_role')
            if query['asset_kind'] != 'music' and role not in ('physical', 'foley', 'dramatic', 'transition', 'ambience'):
                raise ValueError('explicit_sound_role_required')
            task_key = (*key, query['asset_kind'], role)
            if task_key in seen_tasks: raise ValueError('duplicate_material_candidate_task')
            seen_tasks.add(task_key)
            task_evidence = [*evidence, *[file_binding(item, base, hash_cache) for item in
                [*case['evidence'].get('files', []), *task.get('evidence_files', [])]]]
            row = {'case_id': case['case_id'], 'step_id': step['step_id'], 'source_event_id': event['event_id'],
                   'reference_event': event, 'reason': reason, 'attempts': [], 'candidates': [], 'gaps': [],
                   'evidence_files': task_evidence,
                   'candidate_limit_distinct_recordings': 5, 'selected': False, 'artistic_approval': False}
            # Explicit v2 passes the bound event function through retrieval; an
            # asset catalogue partition does not redefine the narrative role.
            if task.get('sound_function_intent') is not None:
                intent = task['sound_function_intent']
                if (not isinstance(intent, dict) or intent.get('revision') != 'sound-event-function-v2'
                        or intent.get('event_id') != event['event_id'] or intent.get('event_role') != role
                        or intent.get('target_range') != event_range):
                    raise ValueError('sound_event_function_bound_intent_required')
                row['sound_function_intent'] = deepcopy(intent)
                row['sound_query_projection'] = deepcopy(task.get('sound_query_projection'))
            seen_windows = set()
            for attempt in range(2):
                retrieval = segment_library.query_library(library_db, **query)
                row['attempts'].append({'query': deepcopy(query), 'retrieval': retrieval,
                                        'expansion': attempt == 1})
                for candidate in retrieval['candidates']:
                    source_hash = candidate['source_sha256']
                    window_key = (candidate['segment_id'], tuple(candidate['source_range']))
                    if window_key in seen_windows: continue
                    pointer = {name: candidate[name] for name in ('asset_id', 'segment_id', 'source_sha256', 'source_range')}
                    try: verify_pointer(library, pointer, base, source_files, hash_cache)
                    except (ValueError, OSError):
                        row['gaps'].append({'segment_id': candidate['segment_id'], 'gap': 'candidate_source_or_window_changed'})
                        continue
                    seen_windows.add(window_key)
                    token = hashlib.sha256(json.dumps([case['case_id'], source_hash, candidate['asset_id']], sort_keys=True).encode()).hexdigest()[:24]
                    item = {**pointer, 'step_id': step['step_id'], 'status': 'research',
                            'source_relation': 'candidate_substitute', 'reason': reason + '; retrieval candidate, not listening approval'}
                    mapping = {'case_id': case['case_id'], 'source_video_sha256': parent['sha256'],
                               'case_source_range': case['source_range'], 'evidence_files': task_evidence, 'music': [], 'sounds': []}
                    if query['asset_kind'] == 'music':
                        item.update(pack_id='research-candidate/' + token, window_id=candidate['segment_id'], phase=candidate['phase'])
                        mapping['music'].append(item)
                    else:
                        item.update(sound_pack_id='research-sound/' + token, member_id=candidate['segment_id'],
                                    sound_role=role, clean_content_status='unknown')
                        mapping['sounds'].append(item)
                    row['candidates'].append({'candidate': candidate, 'source_file': {'path': candidate['local_path'], 'sha256': source_hash},
                                              'binding': mapping, 'selected': False, 'listening_verified': False})
                if row['candidates']: break
                # One bounded label expansion; source type, vocal constraints and exclusions remain intact.
                query = {**query, 'expand_functions': True}
                if query.get('function'): query['discover_unknown_functions'] = True
            if not row['candidates']:
                row['gaps'].append({'gap': 'research_retrieval_empty_after_one_expansion_not_proven_library_absence'})
            row['gaps'].append({'gap': 'actual_candidate_comparison_and_listening_pending'})
            results.append(row)
    missing = [{'case_id': case['case_id'], 'step_id': step['step_id'], 'gap': 'explicit_sound_query_required'}
               for case in cases.values() for step in case.get('development_preset', {}).get('steps', [])
               if (case['case_id'], step['step_id']) not in covered]
    missing += [{'case_id': case['case_id'], 'gap': 'ordered_development_required'} for case in cases.values()
                if not case.get('development_preset', {}).get('steps')]
    return {'schema_version': 1, 'status': 'research_candidates_pending_comparison', 'tasks': results, 'gaps': missing,
            'evidence_files': evidence, 'source_files': list({(row['path'], row['sha256']): row for row in source_files}.values()),
            'automatic_selection_performed': False, 'original_recording_identified': False, 'artistic_approval': False,
            'binding_limits': {'music_recordings_per_case': 5, 'windows_per_music_pack': 12},
            'next_action': 'compare_candidates_then_freeze_research_bindings_for_existing_bind_materials'}


def verify_pointer(library, item, base, source_files=None, hash_cache=None):
    interval = source_range(item.get('source_range'))
    row = library.execute('SELECT s.asset_id,s.source_sha256,s.start_s,s.end_s,a.source_sha256 AS asset_hash,a.path,a.duration,a.blocked '
                          'FROM segments s JOIN assets a USING(asset_id) WHERE s.segment_id=?',
                          (text(item.get('segment_id'), 'segment_id'),)).fetchone()
    if not row:
        raise ValueError('material_library_pointer_mismatch')
    source_range([row['start_s'], row['end_s']])
    source_range([0, row['duration']])
    if (row['blocked'] or row['asset_id'] != item.get('asset_id')
            or row['source_sha256'] != sha(item.get('source_sha256'))
            or row['asset_hash'] != row['source_sha256']
            or not row['start_s'] <= interval[0] < interval[1] <= min(row['end_s'], row['duration'])):
        raise ValueError('material_library_pointer_mismatch')
    binding = file_binding({'path': row['path'], 'sha256': row['source_sha256']}, base, hash_cache)
    if source_files is not None: source_files.append(binding)
    return interval


def bind_materials(document, mappings, library_db, base_dir, evidence_checker=None):
    result = deepcopy(document)
    result['schema_version'] = 2
    result['artistic_approval'] = False
    base = Path(base_dir).resolve()
    check = evidence_checker or file_binding
    cases = {item['case_id']: item for item in result.get('cases', [])}
    episodes = {item['episode_id']: item for item in result.get('episodes', [])}
    packs = {item['pack_id']: item for item in result.get('packs', [])}
    sounds = {item['sound_pack_id']: item for item in result.get('sound_packs', [])}
    source_files = [check(item, base) for item in result.get('material_binding_evidence', {}).get('source_files', [])]
    bound_cases = set()
    with closing(readonly_registered_library(library_db)) as library:
        for mapping in mappings.get('bindings', []):
            case = cases.get(mapping.get('case_id'))
            if not case or case['case_id'] in bound_cases:
                raise ValueError('unknown_or_duplicate_material_case')
            bound_cases.add(case['case_id'])
            episode = episodes[case['episode_id']]
            parent = check(episode['source_video'], base)
            source_files.append(parent)
            if (mapping.get('source_video_sha256') != parent['sha256']
                    or mapping.get('case_source_range') != source_range(case['source_range'])):
                raise ValueError('material_case_source_mismatch')
            evidence = [check(item, base) for item in mapping.get('evidence_files', [])]
            if not evidence:
                raise ValueError('material_binding_evidence_required')
            steps = {step['step_id']: step for step in case.get('development_preset', {}).get('steps', [])}
            for item in mapping.get('music', []):
                step = steps.get(item.get('step_id'))
                if not step:
                    raise ValueError('material_development_step_missing')
                interval = verify_pointer(library, item, base, source_files)
                relation = item.get('source_relation')
                if relation not in ('fingerprint_candidate', 'candidate_substitute', 'reviewed_reference_match', 'reviewed_same_recording_window', 'reviewed_substitute'):
                    raise ValueError('explicit_material_source_relation_required')
                if not item.get('reason', '').strip():
                    raise ValueError('material_selection_reason_required')
                status = item.get('status', 'research')
                if status not in ('research', 'observed'):
                    raise ValueError('material_binding_cannot_sign_artistic_approval')
                listening = item.get('listening_evidence', {})
                if status == 'observed' or relation.startswith('reviewed_'):
                    listening = bound_audio_evidence(listening, item['source_sha256'], interval, base)
                pack_id, window_id = text(item.get('pack_id'), 'pack_id'), text(item.get('window_id'), 'window_id')
                pack = packs.setdefault(pack_id, {'pack_id': pack_id, 'asset_id': item['asset_id'],
                    'source_sha256': item['source_sha256'], 'status': status, 'windows': []})
                if pack['asset_id'] != item['asset_id'] or pack['source_sha256'] != item['source_sha256']:
                    raise ValueError('material_pack_source_changed')
                if pack.get('status', 'research') != status:
                    raise ValueError('material_pack_status_mismatch')
                window = {'window_id': window_id, 'segment_id': item['segment_id'], 'source_range': interval,
                    'phase': item.get('phase', 'unknown'), 'listening_evidence': listening,
                    'source_relation': relation, 'binding_evidence': evidence, 'selection_reason': item['reason']}
                if item.get('original_recording_evidence'):
                    window['original_recording_evidence'] = check(item['original_recording_evidence'], base)
                if relation == 'reviewed_same_recording_window':
                    window['reference_use_source_range'] = source_range(item['reference_use_source_range'])
                    window['ready_source_range'] = source_range(item['ready_source_range'])
                    window['recording_identity_source'] = check(item['recording_identity_source'], base)
                    if window['ready_source_range'] != interval or window['recording_identity_source']['sha256'] != item['source_sha256']:
                        raise ValueError('material_recording_window_range_roles_mismatch')
                if item.get('human_review_record'):
                    window['human_review_record'] = check(item['human_review_record'], base)
                if item.get('words_evidence'):
                    words = deepcopy(item['words_evidence'])
                    if words.get('source_sha256') != item['source_sha256'] or words.get('source_range') != interval:
                        raise ValueError('material_words_source_mismatch')
                    if words.get('content_status') == 'verified':
                        if (words.get('actual_audio_processed') is not True or words.get('vocal_presence') != 'sung'
                                or words.get('complete_phrase') is not True
                                or not isinstance(words.get('actual_words'), str) or not words['actual_words'].strip()
                                or not isinstance(words.get('vocal_language'), str) or not words['vocal_language'].strip()
                                or words['vocal_language'] == 'unknown'
                                or not isinstance(words.get('reviewer'), str) or not words['reviewer'].strip()
                                or not words.get('evidence_files')):
                            raise ValueError('material_complete_words_evidence_required')
                    if words.get('evidence_files'):
                        words['evidence_files'] = [check(row, base) for row in words['evidence_files']]
                    window['words_evidence'] = words
                old = next((row for row in pack['windows'] if row['window_id'] == window_id), None)
                if old and (old['segment_id'] != window['segment_id'] or old['source_range'] != interval):
                    raise ValueError('material_window_identity_changed')
                if not old:
                    pack['windows'].append(window)
                else:
                    old.update(window)
                for owner, field, value in [(case, 'music_pack_ids', pack_id), (step, 'music_pack_ids', pack_id)]:
                    owner.setdefault(field, [])
                    if value not in owner[field]: owner[field].append(value)
                pointer = {'pack_id': pack_id, 'window_id': window_id}
                step.setdefault('window_refs', [])
                if pointer not in step['window_refs']: step['window_refs'].append(pointer)
            for item in mapping.get('sounds', []):
                step = steps.get(item.get('step_id'))
                if not step: raise ValueError('material_development_step_missing')
                interval = verify_pointer(library, item, base, source_files)
                pack_id = text(item.get('sound_pack_id'), 'sound_pack_id')
                if item.get('sound_role') not in ('physical', 'foley', 'dramatic', 'transition', 'ambience'):
                    raise ValueError('invalid_sound_role')
                status = item.get('status', 'research')
                if status not in ('research', 'observed'):
                    raise ValueError('material_binding_cannot_sign_artistic_approval')
                member = {key: deepcopy(value) for key, value in item.items() if key not in ('step_id', 'sound_pack_id', 'status')}
                text(member.get('member_id'), 'sound_member_id')
                member['source_range'] = interval
                member['binding_evidence'] = evidence
                if status == 'observed':
                    member['listening_evidence'] = bound_audio_evidence(member.get('listening_evidence', {}), item['source_sha256'], interval, base)
                if member.get('clean_content_status', 'unknown') not in ('unknown', 'verified', 'contaminated'):
                    raise ValueError('invalid_sound_clean_content_status')
                if member.get('clean_content_status') == 'verified':
                    clean = bound_audio_evidence(member.get('cleanliness_evidence', {}), item['source_sha256'], interval, base)
                    if clean.get('unwanted_speech_absent') is not True or clean.get('unwanted_music_absent') is not True:
                        raise ValueError('clean_sound_requires_contamination_check')
                    member['cleanliness_evidence'] = clean
                pack = sounds.setdefault(pack_id, {'sound_pack_id': pack_id, 'status': status, 'members': []})
                if pack.get('status', 'research') != status:
                    raise ValueError('material_pack_status_mismatch')
                prior = next((row for row in pack['members'] if row['member_id'] == member.get('member_id')), None)
                if prior and prior != member: raise ValueError('material_sound_identity_changed')
                if not prior: pack['members'].append(member)
                for owner in (case, step):
                    owner.setdefault('sound_pack_ids', [])
                    if pack_id not in owner['sound_pack_ids']: owner['sound_pack_ids'].append(pack_id)
            case['material_binding'] = {'evidence_files': evidence, 'production_approval': False,
                'music_source_resolved': bool(mapping.get('music')), 'sound_source_resolved': bool(mapping.get('sounds'))}
    result['packs'] = list(packs.values())
    result['sound_packs'] = list(sounds.values())
    themes = deepcopy(mappings.get('theme_bundles', []))
    for theme in themes:
        for relation in theme.get('variant_relations', []):
            if relation.get('evidence', {}).get('files'):
                relation['evidence']['files'] = [check(item, base) for item in relation['evidence']['files']]
    result['theme_bundles'] = [*result.get('theme_bundles', []), *themes]
    result['material_binding_evidence'] = {'source_files': list({(row['path'], row['sha256']): row for row in source_files}.values())}
    return result


def case_rule(case, episode, work, base, hash_cache=None):
    evidence = case['evidence']
    files = [file_binding(row, base, hash_cache) for row in evidence['files']]
    parent = file_binding(episode['source_video'], base, hash_cache)
    interval = source_range(case['source_range'])
    if evidence.get('source_video_sha256') != parent['sha256'] or evidence.get('source_range') != interval:
        raise ValueError('rule_case_source_mismatch')
    status = case.get('status', 'research')
    if status not in ('research', 'observed', 'approved'):
        raise ValueError('invalid_case_status')
    if status in ('observed', 'approved') and (evidence.get('actual_audio_processed') is not True
            or evidence.get('actual_video_processed') is not True or not evidence.get('observations')
            or evidence.get('evidence_status') == 'unqualified_research_prediction'):
        raise ValueError('observed_case_requires_bound_audio_visual_evidence')
    if status == 'approved':
        review = evidence.get('review', {})
        if (review.get('status') != 'approved' or not review.get('reviewer') or not review.get('reason')
                or review.get('source_video_sha256') != parent['sha256'] or review.get('source_range') != interval):
            raise ValueError('approved_case_requires_window_bound_review')
    events = deepcopy(case.get('source_events', []))
    event_ids = set()
    for event in events:
        event_id = text(event.get('event_id'), 'source_event_id')
        span = source_range(event.get('source_range'))
        if (event_id in event_ids or not interval[0] <= span[0] < span[1] <= interval[1]
                or not event.get('observation_ids')
                or set(event['observation_ids']) - set(evidence.get('observation_ids', []))):
            raise ValueError('rule_source_event_not_bound_to_case')
        event_ids.add(event_id)
    story_ids = {step['step_id']: index for index, step in enumerate(case['story_sequence'])}
    previous = -1
    for step in case['development_preset']['steps']:
        position = story_ids.get(step.get('story_step_id'), -1)
        if (position < previous or position == -1
                or step.get('source_event_id') is not None and step['source_event_id'] not in event_ids):
            raise ValueError('rule_development_step_not_bound_to_case')
        previous = position
    return {'rule_id': 'case-rule/' + case['case_id'], 'case_ids': [case['case_id']],
        'work_ids': [work['work_id']], 'conditions': case.get('conditions', {}),
        'description': case.get('description', ''),
        'sound_observations': deepcopy(evidence.get('observations', {})),
        'uncertainties': deepcopy(case.get('uncertainties', [])),
        'unresolved_gaps': deepcopy(case.get('unresolved_gaps', [])),
        'story_sequence': case['story_sequence'], 'sound_development': case['development_preset'],
        'source_events': events, 'source_video': parent,
        'source_video_sha256': episode['source_video']['sha256'], 'source_range': case['source_range'],
        'evidence_files': files, 'source_observation_status': status,
        'counterexamples': [], 'applicability': 'current_case_only_pending_cross_work_validation',
        'status': 'research', 'nuwa_synthesis_completed': False, 'production_approval': False}


def rule_candidates(document, base_dir):
    """Compile traceable case-specific candidates, never claim that Nuwa or an auditor ran."""
    works = {row['work_id']: row for row in document.get('works', [])}
    episodes = {row['episode_id']: row for row in document.get('episodes', [])}
    heldout = [row for row in works.values() if row.get('split') == 'heldout']
    held_identities = {identity for row in heldout for identity in work_identities(row)}
    held_hashes = {row.get('source_video', {}).get('sha256') for row in episodes.values()
                   if works[row['work_id']].get('split') == 'heldout' and row.get('source_video', {}).get('sha256')}
    rules, gaps, hash_cache = [], [], {}
    for case in document.get('cases', []):
        episode = episodes[case['episode_id']]; work = works[episode['work_id']]
        if (work.get('split') == 'heldout' or held_identities.intersection(work_identities(work))
                or episode.get('source_video', {}).get('sha256') in held_hashes): continue
        if (not case.get('evidence', {}).get('files') or not case.get('story_sequence')
                or not case.get('development_preset', {}).get('steps')): continue
        try:
            rules.append(case_rule(case, episode, work, Path(base_dir), hash_cache))
        except (ValueError, OSError, KeyError) as error:
            reason = str(error)
            if not reason.isascii() or not reason.replace('_', '').isalnum(): reason = 'case_source_or_evidence_invalid'
            gaps.append({'case_id': case['case_id'], 'gap': reason})
    return {'schema_version': 1, 'rules': rules, 'rule_gaps': gaps, 'heldout_excluded': True,
            'synthesis_status': 'case_grounded_candidates_nuwa_synthesis_pending', 'artistic_approval': False}


def read_case_document(filename):
    with closing(readonly(filename)) as db:
        return {'schema_version': 2, **{table: [json.loads(row[0]) for row in db.execute('SELECT record_json FROM ' + table)]
                for table in ('works', 'episodes', 'cases')}}


def write_rule_index(filename, document):
    with closing(sqlite3.connect(filename)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS rules(rule_id TEXT PRIMARY KEY,record_json TEXT NOT NULL)')
        db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS rule_text USING fts5(rule_id UNINDEXED,words)')
        db.execute('CREATE TABLE IF NOT EXISTS rule_cases(case_id TEXT NOT NULL,rule_id TEXT NOT NULL,PRIMARY KEY(case_id,rule_id))')
        db.execute('DELETE FROM rules')
        db.execute('DELETE FROM rule_text')
        db.execute('DELETE FROM rule_cases')
        for rule in document['rules']:
            encoded = json.dumps(rule, ensure_ascii=False, allow_nan=False)
            db.execute('INSERT OR REPLACE INTO rules VALUES(?,?)', (rule['rule_id'], encoded))
            db.execute('DELETE FROM rule_text WHERE rule_id=?', (rule['rule_id'],))
            db.execute('INSERT INTO rule_text VALUES(?,?)', (rule['rule_id'], encoded))
            db.executemany('INSERT INTO rule_cases VALUES(?,?)',
                [(case_id, rule['rule_id']) for case_id in dict.fromkeys(rule.get('case_ids', []))])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--input', type=Path)
    source.add_argument('--case-db', type=Path)
    parser.add_argument('--bindings', type=Path)
    parser.add_argument('--candidate-tasks', type=Path)
    parser.add_argument('--candidate-report', type=Path)
    parser.add_argument('--library-db', type=Path)
    parser.add_argument('--library-sha256')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rules-db', type=Path)
    args = parser.parse_args()
    library = args.library_db
    library_evidence = []
    try:
        if library is not None and library.suffix.lower() == '.json':
            library = {'path': str(library.resolve()), 'sha256': args.library_sha256}
            with closing(readonly_registered_library(library)):
                descriptor = json.loads(args.library_db.read_text(encoding='utf-8-sig'))
            library_evidence = [descriptor['base_db'], descriptor['delta_db']]
        if args.output.exists() or args.candidate_report and args.candidate_report.exists(): raise ValueError('new_material_output_required')
        input_path = args.input or args.case_db
        if args.rules_db and args.rules_db.resolve() in {path.resolve() for path in
                (input_path, args.bindings, args.library_db, args.output) if path is not None}:
            raise ValueError('rule_index_must_not_replace_input_or_output')
        document = json.loads(args.input.read_text(encoding='utf-8-sig')) if args.input else read_case_document(args.case_db)
        if args.candidate_tasks:
            if not args.input or not args.library_db or not args.candidate_report or args.bindings or args.rules_db:
                raise ValueError('candidate_input_tasks_library_report_required')
            if args.candidate_report.resolve() in {file.resolve() for file in
                    (args.input, args.candidate_tasks, args.library_db, args.output)}:
                raise ValueError('candidate_report_must_not_replace_input_or_output')
            files = [{'path': str(file.resolve()), 'sha256': segment_library.digest_file(file)}
                     for file in (args.input, args.candidate_tasks, args.library_db)] + library_evidence
            output = research_candidate_bindings(document, json.loads(args.candidate_tasks.read_text(encoding='utf-8-sig')),
                                                 library, args.input.parent, files)
            args.candidate_report.parent.mkdir(parents=True, exist_ok=True)
            args.candidate_report.write_text(json.dumps(compact_candidate_evidence(output), ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
            report = {'path': str(args.candidate_report.resolve()), 'sha256': segment_library.digest_file(args.candidate_report)}
            output['retrieval_report'] = report
            for task in output['tasks']:
                for candidate in task['candidates']:
                    candidate['binding']['evidence_files'] = [*candidate['binding']['evidence_files'], report]
            output = compact_candidate_evidence(output)
        elif args.bindings:
            if not args.library_db or not args.input: raise ValueError('material_library_and_input_required')
            output = bind_materials(document, json.loads(args.bindings.read_text(encoding='utf-8-sig')), library, args.input.parent)
        else:
            output = rule_candidates(document, input_path.parent)
            if args.rules_db: write_rule_index(args.rules_db, output)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        print(json.dumps({'status': 'research_pending', 'rules': len(output.get('rules', [])),
                          'packs': len(output.get('packs', [])), 'candidate_tasks': len(output.get('tasks', [])),
                          'candidates': sum(len(task['candidates']) for task in output.get('tasks', [])),
                          'artistic_approval': False}))
    except (ValueError, OSError, KeyError, sqlite3.Error):
        parser.exit(1, 'corpus_materials: invalid source, binding, evidence or output\n')
