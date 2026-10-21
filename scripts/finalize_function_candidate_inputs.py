"""Preserve an existing exact original identity anchor in new review discovery.

This reuses an actually consumed reference candidate and its bound human context.
It clones the just-prepared library; no media/model/HTTP is called. Other sources
remain research auxiliary. Original identity and source listening are separate.
"""
import argparse
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import bridge_original_candidates as bridge
import corpus_materials
import segment_library


def finalize(root, previous_original, output_name='standard-origin'):
    root = Path(root)
    pack = json.loads((root / 'review-package.json').read_text(encoding='utf-8'))
    std = json.loads((root / 'material-candidate-inputs.json').read_text(encoding='utf-8'))
    document = corpus_materials.expand_candidate_evidence(json.loads(Path(bridge.verify(pack['standard_candidate_bindings'])['path']).read_text(encoding='utf-8')))
    prior = corpus_materials.expand_candidate_evidence(json.loads(Path(bridge.verify(previous_original)['path']).read_text(encoding='utf-8')))
    exact = deepcopy(prior['tasks'][0]['candidates'][0])
    role = exact['bridge_recording_role']
    music_task = next(row for row in document['tasks'] if row['candidates'] and row['candidates'][0]['binding']['music'])
    if role['recording_origin_role'] != 'reference_original' or role['case_id'] != music_task['case_id'] or role['source_event_id'] != music_task['source_event_id']:
        raise ValueError('exact_reference_case_original_anchor_required')
    identity = json.loads(Path(bridge.verify(role['recording_identity_evidence'])['path']).read_text(encoding='utf-8'))
    if identity['source_audio']['sha256'] != exact['candidate']['source_sha256'] or music_task['case_id'] not in identity['case_ids']:
        raise ValueError('source_identity_scope_mismatch')
    target = root / output_name
    if target.resolve().parent != root.resolve():
        raise ValueError('new_consumer_output_must_stay_within_review_root')
    target.mkdir(exist_ok=False)
    library_path = target / 'segments.sqlite'
    with closing(sqlite3.connect(bridge.verify(pack['frozen_library'])['path'])) as source, closing(sqlite3.connect(library_path)) as destination:
        source.backup(destination)
    current = next(row for row in music_task['candidates'] if row['candidate']['source_sha256'] == role['source_sha256'])
    asset_id = current['candidate']['asset_id']
    segment_id = 'p3-original-anchor/' + role['source_sha256'][:12]
    new_role = deepcopy(role); new_role.update(asset_id=asset_id, segment_id=segment_id)
    segment = {key: new_role[key] for key in ('segment_id', 'asset_id', 'source_sha256', 'source_start_seconds', 'source_end_seconds', 'phase', 'listening_status')}
    segments = bridge.save(target / 'anchor-segment.json', {'segments': [segment]})
    assets = bridge.save(target / 'no-new-assets.json', {'assets': []})
    report = segment_library.import_library(library_path, assets['path'], segments['path'])
    library = bridge.binding(library_path)
    exact['candidate'].update(asset_id=asset_id, segment_id=segment_id, local_path=current['source_file']['path'])
    exact['source_file'] = deepcopy(current['source_file'])
    exact['bridge_recording_role'] = new_role
    for item in exact['binding']['music']:
        item.update(asset_id=asset_id, segment_id=segment_id, window_id=segment_id)
    exact['identity_anchor_reuse'] = {'upstream': previous_original, 'recording_window': exact['candidate']['source_range'],
                                    'reference_occurrence_range': role['reference_occurrence_range'],
                                    'same_case_step_event': True, 'Ready': False}
    music_task['candidates'] = [exact if row['candidate']['source_sha256'] == role['source_sha256'] else row for row in music_task['candidates']]
    music_task['identity_anchor_note'] = 'Original source4s and reference132–136 kept; context53–78 and human50–80 are source-fact context only'
    manifest = {segment_id: new_role}
    with closing(sqlite3.connect(library_path)) as db:
        for row in music_task['candidates']:
            if row is exact:
                continue
            pointer = row['candidate']; sid = pointer['segment_id']
            asset = json.loads(db.execute('SELECT record_json FROM assets WHERE asset_id=?', (pointer['asset_id'],)).fetchone()[0])
            aux_role = {'segment_id': sid, 'asset_id': pointer['asset_id'], 'source_sha256': pointer['source_sha256'],
                        'source_start_seconds': pointer['source_range'][0], 'source_end_seconds': pointer['source_range'][1],
                        'case_id': music_task['case_id'], 'source_event_id': music_task['source_event_id'],
                        'recording_origin_role': 'research_auxiliary', 'recording_extent': 'full_recording',
                        'full_song_acquired': True, 'reference_occurrence_range': None,
                        'recording_identity_evidence': None, 'decode_receipt': asset.get('decode_receipt'),
                        'extent_evidence': asset.get('acquisition_result'), 'Ready': False, 'listening_verified': False}
            manifest[sid] = aux_role; row['bridge_recording_role'] = deepcopy(aux_role)
            row['binding']['music'][0].update(recording_origin_role='research_auxiliary',
                                             source_relation='candidate_substitute', original_recording_evidence=None)
    roles = bridge.save(target / 'recording-role-manifest.json', {'schema_version': 1, 'status': 'research_pending',
                         'segment_roles': manifest, 'qualification_granted': False})
    case_binding = document['case_input']
    case_doc = json.loads(Path(bridge.verify(case_binding)['path']).read_text(encoding='utf-8'))
    new_case = bridge.save(target / 'research' / 'w_reference' / 'e_reference' / 'distillation' / 'case-import.json', case_doc)
    files, task_files = [], []
    for number, task in enumerate(document['tasks']):
        task_input = {key: task[key] for key in ('case_id', 'step_id', 'source_event_id', 'reason')}
        item = task['candidates'][0]['binding']
        kind = 'music' if item['music'] else ('ambience' if item['sounds'][0]['sound_role'] == 'ambience' else 'sfx')
        task_input['query'] = {'asset_kind': kind, 'text': '',
                 'candidate_segment_ids': [row['candidate']['segment_id'] for row in task['candidates']],
                 'usage_scope': 'research_noncommercial', 'limit': 8}
        if kind != 'music':
            task_input['sound_role'] = item['sounds'][0]['sound_role']
        task_file = bridge.save(target / 'inputs' / str(number) / 'candidate-tasks.json', {'schema_version': 1, 'tasks': [task_input]})
        task_files.append(task_file)
        copied = deepcopy(document); copied['tasks'] = [task]
        copied.update(case_input=new_case, Ready=False, production_approval=False)
        copied['evidence_files'] += [library, previous_original, task_file]
        if task is music_task:
            copied.update(frozen_library_binding=library, recording_role_manifest=roles)
        else:
            copied.pop('frozen_library_binding', None); copied.pop('recording_role_manifest', None)
        for evidence in copied['evidence_files']:
            if evidence['path'] == pack['frozen_library']['path']:
                evidence.update(library)
        destination = target / 'work-results' / 'w_reference' / 'v_prepared' / 'corpus' / 'material-candidates' / str(number) / 'candidate-bindings.json'
        files.append(bridge.save(destination, corpus_materials.compact_candidate_evidence(copied)))
    result = {'schema_version': 1, 'status': 'research_preparation_standard_inputs_pending',
              'upstream_review_pack': bridge.binding(root / 'review-package.json'), 'existing_original_anchor': previous_original,
              'frozen_library': library, 'recording_role_manifest': roles, 'candidate_bindings': files,
              'consumer_config_fragment': {'discovery_root': str(target), 'library_db': str(library_path)},
              'material_candidate_inputs': [{**std['material_candidate_inputs'][0], 'input': new_case['path'],
                    'input_binding': new_case, 'candidate_bindings': row, 'recording_role_manifest': roles if index == 0 else None,
                    'tasks': task_files[index]['path'], 'tasks_binding': task_files[index],
                    'production_publish_allowed': False} for index, row in enumerate(files)],
              'import_report': report, 'original_recording_anchor': {'source': role['source_sha256'],
                    'reference_range': role['reference_occurrence_range'], 'source_range': exact['candidate']['source_range'],
                    'observation_contexts': exact['observation_contexts'], 'human_context_review': exact['human_context_review']},
              'other_recordings_approved_auxiliary': False, 'production_publish_allowed': False,
              'Ready': False, 'new_audio_files': 0, 'new_models': 0, 'new_http_calls': 0}
    return bridge.save(target / 'standard-inputs.json', result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True); parser.add_argument('--original-candidate', required=True)
    parser.add_argument('--output-name', default='standard-origin')
    args = parser.parse_args()
    print(json.dumps(finalize(args.root, bridge.binding(args.original_candidate), args.output_name), ensure_ascii=False))
