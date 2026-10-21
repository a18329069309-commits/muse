"""Freeze explicitly supplied offline human window reviews without upgrading old research.

No model, network, listening, or automatic human-review generation occurs here.
"""
import argparse
from contextlib import closing
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import subprocess

import case_preset_store as store
import corpus_materials as materials
from registered_library_connection import readonly_registered_library


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': store.digest_file(path)}


def write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return binding(path)


def human_review(reference, base, source_hash, interval, case_id, kind):
    checked = store.file_binding(reference, base)
    review = read(checked['path'])
    if (review.get('schema_version') != 1 or review.get('type') != 'offline_human_window_review'
            or review.get('origin') != 'human' or review.get('status') != 'approved'
            or review.get('actual_audio_listened') is not True
            or not isinstance(review.get('reviewer'), str) or not review['reviewer'].strip()
            or not isinstance(review.get('reason'), str) or not review['reason'].strip()
            or not isinstance(review.get('reviewed_at'), str) or not review['reviewed_at'].strip()
            or not isinstance(review.get('case_ids'), list) or not review['case_ids']
            or any(not isinstance(identity, str) or not identity.strip() for identity in review['case_ids'])
            or review.get('asset_kind') != kind or case_id not in review['case_ids']
            or not isinstance(review.get('conditions'), dict) or not review['conditions']
            or not isinstance(review.get('observations'), dict) or not review['observations']
            or not isinstance(review.get('exclude_conditions'), list)
            or any(not isinstance(row, dict) or not row for row in review['exclude_conditions'])
            or any(review.get('cleanliness', {}).get(key) is not True for key in
                   ('unwanted_speech_absent', 'unwanted_music_absent', 'unwanted_scene_sounds_absent', 'audible_noise_absent'))):
        raise ValueError('offline_human_actual_window_review_required')
    datetime.fromisoformat(review['reviewed_at'].replace('Z', '+00:00'))
    source = store.file_binding(review.get('source_audio', {}), Path(checked['path']).parent)
    allowed = store.source_range(review.get('source_range'))
    if source['sha256'] != source_hash or not allowed[0] <= interval[0] < interval[1] <= allowed[1]:
        raise ValueError('offline_human_review_scope_mismatch')
    if kind == 'music':
        if review.get('music_form') not in ('instrumental', 'wordless_vocal', 'short_lyrics', 'spoken_adlib'):
            raise ValueError('offline_human_music_form_required')
        if review['music_form'] in ('short_lyrics', 'spoken_adlib'):
            words = review.get('words') or {}
            phrase = store.source_range(words.get('source_range'))
            if (not words.get('actual_words', '').strip() or not words.get('vocal_language', '').strip()
                    or words['vocal_language'] == 'unknown' or words.get('complete_phrase') is not True
                    or phrase != interval):
                raise ValueError('offline_human_complete_words_required')
    return checked, source, review


def music_source_identity(item, case, episode, source_hash, interval, base):
    """Reuse the production original-recording validator; this grants no listening review."""
    relation = item.get('source_relation', 'reviewed_substitute')
    if relation not in ('reviewed_substitute', 'reviewed_reference_match', 'reviewed_same_recording_window'):
        raise ValueError('reviewed_material_source_relation_invalid')
    if relation == 'reviewed_substitute':
        return {'source_relation': relation}
    if not item.get('original_recording_evidence'):
        raise ValueError('reviewed_material_original_identity_required')
    evidence = store.file_binding(item['original_recording_evidence'], base)
    candidate = {**item, 'source_sha256': source_hash, 'source_range': interval,
                 'source_relation': relation, 'original_recording_evidence': evidence}
    if relation == 'reviewed_same_recording_window':
        candidate.update(applicability={'source_integrity_verified': True, 'pack_status': 'approved',
            'pack_listening_record_checked': True, 'eligible_for_current_review': True})
    route = {'cue_id': 'reviewed-original', 'route_id': 'reviewed-original', 'case_ids': [case['case_id']],
             'reference_source': store.file_binding(episode['source_video'], base),
             'reference_case_range': case['source_range'], 'review_conditions': case.get('conditions', {}),
             'source_candidates': [candidate]}
    script = """import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {filterOriginalReferenceRoutes} = await import(pathToFileURL(process.argv[1]));
const route = JSON.parse(readFileSync(0, 'utf8'));
const result = await filterOriginalReferenceRoutes({routes:[route]}, {cues:[{cue_id:route.cue_id,case_conditions:route.review_conditions}]});
const accepted=result.caseRoutes.routes[0]?.source_candidates[0];
process.stdout.write(JSON.stringify({ready:result.ready,gaps:result.gaps,range_roles:accepted&&{
  reference_use_source_range:accepted.reference_use_source_range,ready_source_range:accepted.ready_source_range,
  recording_identity_source:accepted.recording_identity_source}}));"""
    result = subprocess.run(['node', '--input-type=module', '-e', script,
                             str(Path(__file__).with_name('music_profile.mjs'))],
                            input=json.dumps(route), capture_output=True, text=True,
                            encoding='utf-8', timeout=120, cwd=base)
    checked = json.loads(result.stdout) if not result.returncode else {}
    if not checked.get('ready'):
        raise ValueError('reviewed_material_original_identity_rejected')
    return {'source_relation': relation, 'original_recording_evidence': evidence,
            **(checked.get('range_roles') or {} if relation == 'reviewed_same_recording_window' else {})}


def publish(config, base_dir=Path('.')):
    if config.get('schema_version') != 1 or not isinstance(config.get('reviews'), list):
        raise ValueError('reviewed_material_publication_config_invalid')
    if not config['reviews']:
        return {'status': 'no_actual_human_reviews', 'qualification_granted': False, 'production_approval': False}
    base = Path(base_dir).resolve()
    base_db = binding(base / config['base_cases_db'])
    library_db = binding(base / config['library_db'])
    library_input = library_db if Path(library_db['path']).suffix.lower() == '.json' else library_db['path']
    work_rows, episode_rows, case_rows, mappings, receipts, new_ids = {}, {}, {}, {}, [], set()
    with closing(store.readonly(base_db['path'])) as db, closing(readonly_registered_library(library_input)) as library:
        for item in config['reviews']:
            case_id, kind = item.get('case_id'), item.get('kind', 'music')
            if kind not in ('music', 'sfx', 'ambience'):
                raise ValueError('reviewed_material_kind_invalid')
            row = db.execute('SELECT record_json FROM cases WHERE case_id=?', (case_id,)).fetchone()
            if not row:
                raise ValueError('reviewed_material_actual_case_required')
            case = json.loads(row[0])
            episode = json.loads(db.execute('SELECT record_json FROM episodes WHERE episode_id=?', (case['episode_id'],)).fetchone()[0])
            work = json.loads(db.execute('SELECT record_json FROM works WHERE work_id=?', (episode['work_id'],)).fetchone()[0])
            if work['split'] == 'heldout' or 'current_unscored_target_not_reference_success_case' in json.dumps(case):
                raise ValueError('reviewed_material_reference_case_required')
            pack_id = store.text(item.get('pack_id'), 'pack_id')
            table = 'packs' if kind == 'music' else 'sound_packs'
            key = 'pack_id' if kind == 'music' else 'sound_pack_id'
            if db.execute(f'SELECT 1 FROM {table} WHERE {key}=?', (pack_id,)).fetchone():
                raise ValueError('reviewed_publication_requires_new_pack_identity')
            interval = store.source_range(item.get('source_range'))
            found = library.execute('SELECT s.*,a.path,a.duration,a.blocked,a.source_sha256 AS asset_hash '
                                    'FROM segments s JOIN assets a USING(asset_id) WHERE segment_id=?', (item.get('segment_id'),)).fetchone()
            if not found or found['asset_id'] != item.get('asset_id') or found['source_sha256'] != found['asset_hash']:
                raise ValueError('reviewed_material_registered_source_required')
            source_hash = found['source_sha256']
            materials.verify_pointer(library, {**item, 'source_sha256': source_hash}, base)
            review_file, source, review = human_review(item.get('review_record', {}), base, source_hash, interval, case_id, kind)
            step = next((step for step in case.get('development_preset', {}).get('steps', []) if step['step_id'] == item.get('step_id')), None)
            if not step:
                raise ValueError('reviewed_material_development_step_required')
            # A review is scoped to a real reference case, not allowed to rewrite its plot or observations.
            context = case.get('conditions', {})
            relationship_classes = {'family': 'family', 'mother_daughter': 'family', 'romantic': 'romance', 'romance': 'romance'}
            if any(key not in store.CONDITION_KEYS or key not in context or value is None
                   or (relationship_classes.get(context[key]) != relationship_classes[value]
                       if key == 'relationship' and value in relationship_classes else context[key] != value)
                   for key, value in review['conditions'].items()):
                raise ValueError('offline_human_review_reference_conditions_mismatch')
            listening = {'source_sha256': source_hash, 'source_range': interval, 'actual_audio_processed': True,
                         'observations': review['observations'], 'files': [review_file, source],
                         'origin': 'offline_human_review', 'review': {'status': 'approved', 'reviewer': review['reviewer'],
                         'reason': review['reason'], 'source_sha256': source_hash, 'source_range': interval}}
            chosen = {**item, 'source_sha256': source_hash, 'status': 'observed', 'reason': review['reason'],
                      'listening_evidence': listening, 'human_review_record': review_file}
            chosen.pop('review_record', None)
            identity = (pack_id, item.get('window_id'))
            if identity in new_ids:
                raise ValueError('duplicate_reviewed_material_window')
            new_ids.add(identity)
            if kind == 'music':
                if item.get('source_relation') == 'reviewed_same_recording_window':
                    chosen['library_allowed_source_range'] = [found['start_s'], found['end_s']]
                chosen.update(music_source_identity(chosen, case, episode, source_hash, interval, base),
                              phase=item.get('phase', 'unknown'))
                if review.get('words'):
                    chosen['words_evidence'] = {'content_status': 'verified', 'source_sha256': source_hash,
                        'source_range': interval, 'vocal_presence': 'sung' if review['music_form'] == 'short_lyrics' else 'speech',
                        **review['words'], 'actual_audio_processed': True, 'reviewer': review['reviewer'], 'evidence_files': [review_file]}
                    # The word evidence applies to its exact phrase, not all surrounding audio.
                    chosen['words_evidence']['source_range'] = interval
            else:
                role = item.get('sound_role')
                if role not in ('physical', 'foley', 'dramatic', 'transition', 'ambience') or (kind == 'ambience') != (role == 'ambience'):
                    raise ValueError('reviewed_sound_role_required')
                chosen.update(sound_pack_id=pack_id, member_id=item['window_id'], clean_content_status='verified',
                              cleanliness_evidence={**listening, **review['cleanliness']})
                chosen.pop('pack_id', None)
                if kind == 'sfx':
                    anchor = review.get('source_anchor_seconds')
                    if isinstance(anchor, bool) or not isinstance(anchor, (int, float)) or not interval[0] <= anchor < interval[1]:
                        raise ValueError('reviewed_sound_actual_anchor_required')
                    chosen['source_anchor_seconds'] = anchor
            case_rows[case_id] = deepcopy(case)
            episode_rows[episode['episode_id']] = episode
            work_rows[work['work_id']] = work
            mapping = mappings.setdefault(case_id, {'case_id': case_id, 'source_video_sha256': episode['source_video']['sha256'],
                'case_source_range': case['source_range'], 'evidence_files': [], 'music': [], 'sounds': []})
            mapping['evidence_files'].extend([review_file, source])
            mapping['music' if kind == 'music' else 'sounds'].append(chosen)
            receipts.append({'case_id': case_id, 'pack_id': pack_id, 'window_id': item['window_id'], 'kind': kind,
                             'review_record': review_file, 'source_audio': source, 'source_range': interval})
    document = {'schema_version': 2, 'works': list(work_rows.values()), 'episodes': list(episode_rows.values()),
                'cases': list(case_rows.values()), 'packs': [], 'sound_packs': []}
    bound = materials.bind_materials(document, {'bindings': list(mappings.values())}, library_input, base)
    for pack in [*bound.get('packs', []), *bound.get('sound_packs', [])]:
        pack['status'] = 'approved'
    out = (base / config['output_dir']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    write_new(out / 'reviewed-case-import.json', bound)
    target = out / 'reviewed-cases.sqlite'
    with closing(store.readonly(base_db['path'])) as old, closing(sqlite3.connect(target)) as new:
        old.backup(new)
    store.import_store(target, bound, base)
    if binding(base_db['path']) != base_db or binding(library_db['path']) != library_db:
        raise ValueError('reviewed_publication_base_changed')
    # A registered-window descriptor binds its frozen base and delta independently.
    with closing(readonly_registered_library(library_input)):
        pass
    for record in receipts:
        store.file_binding(record['review_record'], base)
        store.file_binding(record['source_audio'], base)
    manifest = {'schema_version': 1, 'kind': 'frozen_offline_human_reviewed_materials',
                'status': 'reviewed_packages_available_for_assisted_trial', 'bases': {'cases_db': base_db, 'library_db': library_db},
                'cases_db': binding(target), 'library_db': library_db, 'reviews': receipts,
                'published_counts': {'music_packs': len(bound.get('packs', [])),
                    'music_windows': sum(len(pack['windows']) for pack in bound.get('packs', [])),
                    'sound_packs': len(bound.get('sound_packs', [])),
                    'sound_members': sum(len(pack['members']) for pack in bound.get('sound_packs', []))},
                'consumer': {'strategy': 'case_presets', 'cases': {'db': str(target),
                    'material_policy': 'reference_or_reviewed_equivalent'}, 'library': {'db': library_db['path'],
                    'sha256': library_db['sha256']}},
                'old_research_qualification_changed': False, 'qualified_model_declared': False,
                'qualification_granted': False, 'production_approval': False, 'full_corpus_completed': False}
    manifest['publication'] = write_new(out / 'publication.json', manifest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    result = publish(read(args.config), args.config.resolve().parent)
    print(json.dumps({'status': result['status'], 'publication': result.get('publication'),
                      'qualification_granted': False, 'production_approval': False}))
