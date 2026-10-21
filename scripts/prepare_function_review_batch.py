"""Prepare bounded, source-bound review media without granting listening approval.

--config CONFIG.json. All JSON/SQLite inputs are SHA-bound. The explicit arc_specs
must cover every existing beat exactly once; an arc is not an editing instruction.
At most eight music cards and eight SFX cards are decoded. Existing model results
are reused only for their exact source SHA/range. No models, HTTP or user-film
mix/render is called. Pending human forms deliberately fail the real publisher.
"""
import argparse
from contextlib import closing
from copy import deepcopy
import csv
import html
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import wave
from array import array

import bridge_original_candidates as bridge
import corpus_materials
import segment_library

FUNCTIONS = ('持续危机', '受辱反制', '背弃决裂', '亲情变化', '年代穿越', '爱情关系', '自由离场')
CLEAN_FIELDS = ('unwanted_speech_absent', 'unwanted_music_absent',
                'unwanted_scene_sounds_absent', 'audible_noise_absent')


def read_bound(reference):
    actual = bridge.verify(reference)
    return json.loads(Path(actual['path']).read_text(encoding='utf-8-sig'))


def group_arcs(matrix, specs):
    """Preserve actual event IDs and case routes, rejecting omission/duplication."""
    if set(specs) != {row['trial_id'] for row in matrix['films']}:
        raise ValueError('arc_specs_must_cover_exact_films')
    arcs, assigned = [], set()
    for film in matrix['films']:
        beats = sorted((row for row in matrix['tasks'] if row['trial_id'] == film['trial_id']),
                       key=lambda row: row['target_range'][0])
        previous_end = film['covered_range'][0]
        for number, spec in enumerate(specs[film['trial_id']], 1):
            interval = bridge.interval(spec['range'])
            if abs(interval[0] - previous_end) > 1e-6 or spec['function'] not in FUNCTIONS:
                raise ValueError('arc_gap_overlap_or_unknown_function')
            members = [beat for beat in beats if bridge.contained(beat['target_range'], interval)]
            if not members or abs(members[0]['target_range'][0] - interval[0]) > 1e-6 or abs(members[-1]['target_range'][1] - interval[1]) > 1e-6:
                raise ValueError('arc_boundary_must_follow_actual_beats')
            for member in members:
                key = (member['trial_id'], member['target_event_id'])
                if key in assigned:
                    raise ValueError('storybeat_assigned_twice')
                assigned.add(key)
            arcs.append({'arc_id': f"function-review/{film['trial_id']}/{number:02d}",
                         'trial_id': film['trial_id'], 'source_video_sha256': film['source_video_sha256'],
                         'target_range': interval, 'requested_function': spec['function'],
                         'proposed_development_not_heard': spec['intent'],
                         'counterexamples': spec['counterexamples'],
                         'target_event_ids': [row['target_event_id'] for row in members],
                         'target_case_bindings': list({json.dumps(row, sort_keys=True): row for beat in members for row in beat['target_case_bindings']}.values()),
                         'beat_evidence': [{key: row[key] for key in ('target_event_id', 'target_range', 'plot_evidence', 'event_evidence_frame_ids', 'event_fact_or_explicit_inference')} for row in members],
                         'candidate_card_ids': spec.get('candidate_card_ids', []),
                         'original_physical_audio_status': 'unknown',
                         'music_change_required': False, 'use_approved': False, 'Ready': False})
            previous_end = interval[1]
        if abs(previous_end - film['covered_range'][1]) > 1e-6:
            raise ValueError('film_axis_not_fully_covered')
    expected = {(row['trial_id'], row['target_event_id']) for row in matrix['tasks']}
    if assigned != expected:
        raise ValueError('all_storybeats_must_be_assigned_once')
    return {'schema_version': 1, 'status': 'proposed_function_arcs_not_adopted_music_plan',
            'functions': list(FUNCTIONS), 'films': deepcopy(matrix['films']), 'arcs': arcs,
            'storybeat_count': len(assigned), 'arc_count': len(arcs),
            'storybeat_does_not_mean_music_change': True, 'Ready': False}


def decode_window(source, interval, destination):
    """Trim after complete decoding against the actual sample clock, never pad."""
    actual = bridge.verify(source)
    interval = bridge.interval(interval)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    start, end = (round(value * 48000) for value in interval)
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', actual['path'], '-map', '0:a:0', '-vn',
            '-af', f'aresample=48000,asetpts=PTS-STARTPTS,atrim=start_sample={start}:end_sample={end},asetpts=PTS-STARTPTS',
            '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', str(destination)]
    result = subprocess.run(args, capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError('bounded_actual_decode_failed: ' + result.stderr.decode('utf-8', errors='replace')[-1000:])
    with wave.open(str(destination), 'rb') as stream:
        count, rate, channels = stream.getnframes(), stream.getframerate(), stream.getnchannels()
        values = array('h', stream.readframes(count))
    if count != end - start or rate != 48000 or channels != 2:
        raise ValueError(f'actual_source_sample_shortfall:{count}:{end-start}')
    peak = max(abs(value) for value in values) if values else 0
    if not peak:
        raise ValueError('silent_audio_is_not_review_supply')
    bridge.verify(source)
    receipt = {'schema_version': 1, 'protocol': 'ffmpeg_decoded_zero_sample_trim_no_padding_v1',
               'source': source, 'source_range': interval, 'source_clock': 'decoded_audio_zero_start_samples',
               'argv': args, 'exit_code': result.returncode, 'media': bridge.binding(destination),
               'sample_rate': rate, 'channels': channels, 'sample_count': count,
               'duration_seconds': count / rate, 'peak_linear': peak / 32768,
               'actual_audio_processed': True, 'actual_audio_listened': False, 'cleanliness_verified': False,
               'silence_padding_added': False}
    receipt_binding = bridge.save(destination.with_suffix('.receipt.json'), receipt)
    preview = destination.with_suffix('.mp3')
    compression = ['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', str(destination), '-codec:a', 'libmp3lame', '-b:a', '192k', str(preview)]
    process = subprocess.run(compression, capture_output=True, timeout=30)
    if process.returncode:
        raise ValueError('review_compression_failed')
    return {'wav': receipt['media'], 'mp3': bridge.binding(preview), 'decode_receipt': receipt_binding,
            'source_range': interval, 'actual_audio_processed': True, 'actual_audio_listened': False}


def exact_observation(observations, source_sha, interval):
    return next((deepcopy(row) for row in observations if row['source_sha256'] == source_sha
                 and all(abs(a-b) < 1e-6 for a, b in zip(row['source_range'], interval))), None)


def compatible_evidence_views(references):
    """Do not hash the same repeated historical evidence binding again."""
    cache = {}
    result = []
    for reference in references:
        key = json.dumps(reference, ensure_ascii=False, sort_keys=True)
        if key not in cache:
            cache[key] = bridge.compatible_bound_view(reference)
        result.append(deepcopy(cache[key]))
    return result


def full_machine_words(observation, source_sha, interval):
    """Prefill the actual ASR prediction; never complete/correct it from a title."""
    reference = (observation or {}).get('raw_result_bindings', {}).get('qwen3_asr')
    if not reference:
        return ''
    raw = read_bound(reference)
    scope = raw.get('source_window_seconds')
    if (raw.get('source_sha256') != source_sha or not isinstance(scope, list) or len(scope) != 2
            or any(abs(a-b) > 1e-6 for a,b in zip(scope, interval)) or raw.get('status') != 'predicted'):
        raise ValueError('actual_model_raw_scope_mismatch')
    return raw.get('parsed', {}).get('transcription', '')


def pending_review(card, case_ids, conditions=None):
    result = {'schema_version': 1, 'type': 'offline_human_window_review', 'origin': 'pending_human',
              'status': 'pending', 'reviewer': '', 'reviewed_at': None, 'actual_audio_listened': None,
              'source_audio': deepcopy(card['source']), 'source_range': deepcopy(card['source_range']),
              'audition_media': card['media']['mp3'], 'case_ids': case_ids, 'asset_kind': card['asset_kind'],
              'conditions': conditions or {'review_scope_pending': True}, 'exclude_conditions': [],
              'cleanliness': {key: None for key in CLEAN_FIELDS}, 'observations': {}, 'reason': '',
              'same_recording_version': None, 'recording_identity_approved_by_human': None,
              'current_target_use_reviews': [], 'production_model_qualified': False,
              'machine_draft_is_not_human_evidence': True}
    if card['asset_kind'] == 'music':
        result.update(music_form='unknown', words={'actual_words': '', 'vocal_language': 'unknown',
                      'complete_phrase': None, 'source_range': deepcopy(card['source_range'])},
                      machine_words_candidate=card.get('machine_words_candidate', ''),
                      complete_lyric_phrase_approved=None, proposed_phrase_boundaries_unverified=True)
    else:
        result.update(sound_role=card['proposed_sound_role'], source_anchor_seconds=None,
                      machine_anchor_candidate_seconds=card.get('waveform_peak_anchor_seconds'))
    return result


def read_new_observations(completion):
    results = []
    for recording in completion['recordings']:
        source = recording['source']
        for pann in recording['PANN_windows']:
            interval = pann['source_window_seconds']
            asr = next((row for row in recording['ASR_windows'] if row['source_window_seconds'] == interval), None)
            text = ''
            if asr:
                raw = read_bound(asr['actual_raw_prediction'])
                parsed = raw.get('parsed', {})
                text = parsed.get('text', parsed.get('transcription', ''))
                if not text:
                    text = raw.get('transcription', raw.get('text', ''))
            results.append({'source_sha256': source['sha256'], 'source_range': interval,
                            'input_audio': pann['input'], 'pann_top_labels': pann['top_labels'],
                            'pann_activity_scores': pann['clipwise_voice_predictions'],
                            'language_candidate_asr_only': asr.get('predicted_language') if asr else 'unknown',
                            'lyric_candidate_excerpt_unverified': text,
                            'raw_result_bindings': {'panns_sed': pann['actual_raw_prediction'],
                              **({'qwen3_asr': asr['actual_raw_prediction']} if asr else {})},
                            'receipt_bindings': {key: model['actual_receipt'] for key, model in completion['models'].items() if key == 'panns_sed' or asr},
                            'actual_audio_processed': True, 'Ready': False})
    return results


def prepare(config):
    root = Path(config['output_dir']).resolve()
    if root.exists():
        raise ValueError('new_review_output_dir_required')
    matrix = read_bound(config['demand_matrix'])
    inventory = read_bound(config['full_library_assets'])
    old = read_bound(config['old_observations'])
    new = read_bound(config['new_observations'])
    if len(config['music_cards']) > 8 or len(config['sfx_cards']) > 8:
        raise ValueError('bounded_review_card_limit_exceeded')
    arcs = group_arcs(matrix, config['arc_specs'])
    root.mkdir(parents=True)
    arc_binding = bridge.save(root / 'function-arcs.json', arcs)
    observations = old['observations'] + read_new_observations(new)
    assets = {row['source_sha256']: row for row in inventory['assets']}
    recordings = {row['source_sha256']: row for row in old['full10_recordings']}
    cards, gaps, verified_sources = [], [], set()
    base = bridge.verify(config['full_library_db'])
    library_path = root / 'review-library.sqlite'
    with closing(sqlite3.connect(base['path'])) as original, closing(sqlite3.connect(library_path)) as target:
        original.backup(target)
    added_assets, segments = {}, []
    sfx_source = bridge.verify(config['sfx_library_db'])
    with closing(sqlite3.connect(sfx_source['path'])) as sfx:
        sfx.row_factory = sqlite3.Row
        for spec in [*config['music_cards'], *config['sfx_cards']]:
            try:
                if spec['asset_kind'] == 'music':
                    asset = deepcopy(assets[spec['source_sha256']])
                    source = {'path': asset['local_path'], 'sha256': asset['source_sha256']}
                    asset_id = asset['asset_id']
                    interval = bridge.interval(spec['source_range'])
                    observation = exact_observation(observations, source['sha256'], interval)
                    metadata = recordings.get(source['sha256'], {})
                    card = {'card_id': spec['card_id'], 'asset_kind': 'music', 'title_metadata_only': spec['title'],
                            'source': source, 'source_range': interval,
                            'existing_exact_window_observation': observation,
                            'machine_words_candidate': full_machine_words(observation, source['sha256'], interval),
                            'machine_language_candidate': (observation or {}).get('language_candidate_asr_only', 'unknown'),
                            'reference_position_candidates': metadata.get('reference_case_position_candidates', []),
                            'recording_identity_evidence': metadata.get('strict_existing_identity'),
                            'human_baseline_evidence': old['old_reviewed_baseline'] if spec.get('reuse_baseline') else None,
                            'complete_phrase_verified': False, 'human_music_form': 'unknown', 'genre_verified': False}
                else:
                    row = sfx.execute('SELECT s.*,a.record_json AS asset_record,a.path FROM segments s JOIN assets a USING(asset_id) WHERE s.segment_id=?', (spec['segment_id'],)).fetchone()
                    if not row:
                        raise ValueError('indexed_sfx_segment_missing')
                    asset = json.loads(row['asset_record']); asset_id = row['asset_id']
                    source = {'path': row['path'], 'sha256': row['source_sha256']}
                    indexed_interval = [row['start_s'], row['end_s']]
                    interval = bridge.interval(spec.get('source_range', indexed_interval))
                    if not bridge.contained(interval, indexed_interval):
                        raise ValueError('sfx_review_window_outside_indexed_source')
                    added_assets[asset_id] = asset
                    card = {'card_id': spec['card_id'], 'asset_kind': asset.get('asset_kind', 'sfx'),
                            'title_metadata_only': asset.get('title', asset_id), 'source': source, 'source_range': interval,
                            'original_index_segment_id': spec['segment_id'],
                            'indexed_source_range': indexed_interval,
                            'proposed_sound_role': spec['sound_role'], 'original_physical_audio_status': 'unknown',
                            'original_physical_addition_action': 'omit_until_actual_event_and_original_audio_review',
                            'license_metadata_evidence': asset.get('license_evidence'),
                            'indexed_listening_status': row['listening_status'],
                            'cleanliness_verified': False}
                verified_sources.add(source['sha256'])
                card['media'] = decode_window(source, interval, root / 'audio' / (spec['card_id'] + '.wav'))
                if spec.get('observation_context'):
                    context_range = bridge.interval(spec['observation_context'])
                    if not bridge.contained(interval, context_range):
                        raise ValueError('observation_context_must_contain_review_window')
                    context_media = decode_window(source, context_range, root / 'audio' / (spec['card_id'] + '-context.wav'))
                    card['observation_context'] = {'source_range': context_range, 'media': context_media,
                           'purpose': 'Look at development and adjust phrase boundary; this is not an adoption or reviewed extent',
                           'context_only': True, 'machine_words_scope': interval,
                           'fact_qualification': 'actual_decode_only_not_listened', 'Ready': False}
                card.update(proposed_functions=spec['functions'], proposed_use=spec['proposed_use'],
                            counterexamples=spec['counterexamples'], use_approved=False, Ready=False,
                            source_clock='decoded_audio_zero_start_samples', actual_audio_listened=False,
                            current_target_arc_ids=[arc['arc_id'] for arc in arcs['arcs'] if spec['card_id'] in arc['candidate_card_ids']])
                segment_id = 'p3-review/' + spec['card_id'] + '/' + source['sha256'][:12]
                card.update(asset_id=asset_id, segment_id=segment_id)
                segment = {'segment_id': segment_id, 'asset_id': asset_id, 'source_sha256': source['sha256'],
                           'source_start_seconds': interval[0], 'source_end_seconds': interval[1],
                           'phase': 'unknown', 'listening_status': 'pending', 'tag_status': 'research_pending',
                           'description': 'Bounded review candidate; requested functions are proposals, not source tags',
                           'Ready': False}
                segments.append(segment)
                cards.append(card)
            except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
                gaps.append({'card_id': spec['card_id'], 'gap': str(error), 'Ready': False})
    asset_file = bridge.save(root / 'added-assets.json', {'assets': list(added_assets.values())})
    segment_file = bridge.save(root / 'review-segments.json', {'segments': segments})
    imported = segment_library.import_library(library_path, asset_file['path'], segment_file['path'], rehash=True)
    library = bridge.binding(library_path)
    # Consume only explicit real reference events. Target-route IDs are not invented as reference cases.
    source_case_binding = bridge.verify(config['reference_case_input'])
    case_doc = read_bound(source_case_binding)
    for episode in case_doc['episodes']:
        episode['source_video'] = bridge.compatible_bound_view(episode['source_video'])
    for case in case_doc['cases']:
        case['evidence']['files'] = compatible_evidence_views(case['evidence']['files'])
    selected = config['reference_task']
    real_case = next(row for row in case_doc['cases'] if row['case_id'] == selected['case_id'])
    if any(work['split'] != 'research' for work in case_doc['works']):
        raise ValueError('heldout_must_remain_sealed')
    case_input = bridge.save(root / 'consumer' / 'research' / 'w_reference' / 'e_reference' / 'distillation' / 'case-import.json', case_doc)
    lookup = {card['card_id']: card for card in cards}
    tasks = []
    for task_spec in config['standard_queries']:
        chosen = [lookup[key] for key in task_spec['card_ids'] if key in lookup]
        if not chosen:
            gaps.append({'gap': 'standard_query_has_no_actual_prepared_candidates', 'role': task_spec.get('sound_role')})
            continue
        if len({row['source']['sha256'] for row in chosen}) > 5:
            raise ValueError('reference_case_distinct_recording_limit_exceeded')
        task = {**selected, 'reason': task_spec['reason'], 'query': {'asset_kind': task_spec['asset_kind'],
                'text': '', 'candidate_segment_ids': [row['segment_id'] for row in chosen],
                'usage_scope': 'research_noncommercial', 'limit': 8}}
        if task_spec.get('sound_role'):
            task['sound_role'] = task_spec['sound_role']
        tasks.append(task)
    task_doc = {'schema_version': 1, 'tasks': tasks}
    task_binding = bridge.save(root / 'consumer' / 'candidate-tasks.json', task_doc)
    candidate_doc = corpus_materials.research_candidate_bindings(case_doc, task_doc, str(library_path),
                         Path(case_input['path']).parent, [case_input, task_binding, library, arc_binding])
    candidate_doc.update(case_input=case_input, status='research_pending', Ready=False,
                         review_only_not_current_target_plan=True)
    candidate_binding = bridge.save(root / 'consumer' / 'work-results' / 'w_reference' / 'v_review' / 'corpus' / 'material-candidates' / 'p3' / 'candidate-bindings.json',
                                    corpus_materials.compact_candidate_evidence(candidate_doc))
    consumer_input = bridge.save(root / 'material-candidate-inputs.json', {'schema_version': 1,
       'material_candidate_inputs': [{'input': case_input['path'], 'tasks': task_binding['path'],
                                    'input_binding': case_input, 'tasks_binding': task_binding,
                                    'candidate_bindings': candidate_binding, 'split': 'research',
                                    'research_discovery_allowed': True, 'production_publish_allowed': False}],
       'consumer_config_fragment': {'discovery_root': str(root / 'consumer'), 'library_db': str(library_path)},
       'target_case_input_gap': 'Nine current-target route IDs remain target demand evidence; require actual legal target case documents before target-specific standard selection',
       'Ready': False})
    reviews, publisher_rows = [], []
    for card in cards:
        review = pending_review(card, [real_case['case_id']], deepcopy(real_case.get('conditions') or {'review_scope_pending': True}))
        review_binding = bridge.save(root / 'pending-human' / (card['card_id'] + '.json'), review)
        card['pending_review_record'] = review_binding
        row = {**selected, 'kind': card['asset_kind'], 'pack_id': 'p3-pending/' + card['card_id'],
               'asset_id': card['asset_id'], 'segment_id': card['segment_id'], 'source_range': card['source_range'],
               'review_record': review_binding, 'source_relation': 'reviewed_substitute',
               'window_id': card['segment_id'], 'phase': 'unknown'}
        if card['asset_kind'] != 'music':
            row.update(sound_role=card['proposed_sound_role'], source_anchor_seconds=None)
        publisher_rows.append(row)
        reviews.append({'card_id': card['card_id'], 'record': review_binding,
                        'source_review_pending': True, 'current_target_use_pending': True})
    publisher = bridge.save(root / 'pending-publisher-input.json', {'schema_version': 1,
                  'base_cases_db': config['base_cases_db'], 'library_db': str(library_path),
                  'output_dir': str(root / 'NOT_CREATED-published-after-human-review'), 'reviews': publisher_rows})
    pack = {'schema_version': 1, 'status': 'actual_media_prepared_human_review_pending',
            'inputs': {key: config[key] for key in ('demand_matrix', 'full_library_assets', 'full_library_db', 'old_observations', 'new_observations', 'sfx_library_db')},
            'cards': cards, 'gaps': gaps, 'function_arcs': arc_binding, 'frozen_library': library,
            'library_import': imported, 'standard_consumer_input': consumer_input,
            'standard_candidate_bindings': candidate_binding, 'pending_publisher_input': publisher,
            'counts': {'music_cards': sum(row['asset_kind'] == 'music' for row in cards),
                       'sound_cards': sum(row['asset_kind'] != 'music' for row in cards),
                       'unique_sources_prepared': len(verified_sources), 'storybeats': arcs['storybeat_count'],
                       'sound_arcs': arcs['arc_count'], 'new_model_calls': 0, 'new_http_calls': 0,
                       'new_ready_packages': 0, 'new_user_films': 0},
            'release_gaps': ['新源窗同版本/原剧时钟未核不计原曲', '干净度、声型、词句完整性分别待真实人审',
                             '提议功能尚未获得当前具体事件用途批准', '原物理声未知，拟音/物理声仅供核听，不加进成片',
                             'pending_human 表故意不能通过既有发布门', '项目试配 hold 保留，未创建任何新用户片'],
            'Ready': False, 'actual_audio_listened': False}
    output = bridge.save(root / 'review-package.json', pack)
    write_review_ui(root, pack, arcs)
    bridge.verify(config['full_library_db']); bridge.verify(config['sfx_library_db'])
    return {'output': output, 'counts': pack['counts'], 'gaps': gaps, 'Ready': False}


def write_review_ui(root, pack, arcs):
    with (root / 'batch-review.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        fields = ['card_id', 'title_metadata_only', 'source_sha256', 'source_start', 'source_end', 'machine_words_candidate',
                  'listened', 'human_music_form', 'same_recording_version', 'clean', 'complete_phrase', 'approved_function',
                  'approved_target_arc_ids', 'exclude_conditions', 'reviewer', 'reviewed_at', 'reason']
        writer = csv.DictWriter(stream, fieldnames=fields); writer.writeheader()
        for card in pack['cards']:
            writer.writerow({'card_id': card['card_id'], 'title_metadata_only': card['title_metadata_only'],
                             'source_sha256': card['source']['sha256'], 'source_start': card['source_range'][0],
                             'source_end': card['source_range'][1], 'machine_words_candidate': card.get('machine_words_candidate', '')})
    embedded = json.dumps({'cards': pack['cards'], 'arcs': arcs['arcs']}, ensure_ascii=False).replace('</', '<\\/')
    markup = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>集中声音审核</title>
<style>body{max-width:1100px;margin:24px auto;padding:0 18px;background:#111922;color:#e8edf2;font:16px/1.55 sans-serif}h1{font-size:26px}article{border:1px solid #445464;padding:18px;margin:18px 0;border-radius:8px}small{color:#b9c5d1}audio{width:100%;margin:6px 0}textarea{width:98%;min-height:70px}input,select,textarea,button{font:inherit;margin:5px;background:#eff3f7;color:#14202d}label{display:inline-block;margin-right:12px}details{margin-top:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.pending{color:#f2cc82}</style>
<h1>音乐与音效集中审核</h1><p>本页是独立原录音/既有音效的源窗核听，尚无新片试配。先核真实声音，再分别核用途与词句边界。字段默认空白；机器草稿不代表歌词正确，也不代表完整乐句。保存草稿不会发布或写成已批准的人审证据。</p>
<p class="pending">基线吟唱仅复用源 50–80 秒、受压/蓄势批准。英文爱情措辞与母女/危机场景可能冲突，须听后决定。</p><button id="save">下载批审核草稿 JSON</button><div id="cards"></div>
<script>const data=__DATA__;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const player=p=>`<audio controls preload="none" src="${esc(p)}"></audio>`;
document.querySelector('#cards').innerHTML=data.cards.map(c=>`<article data-id="${esc(c.card_id)}"><h2>${esc(c.card_id)} · ${esc(c.title_metadata_only)}</h2><small>源 ${c.source_range.map(n=>n.toFixed(6)).join('–')} 秒 / ${esc(c.source.sha256)}</small>${player('audio/'+c.card_id+'.mp3')}<p>提议用途：${esc(c.proposed_use)}<br>反例：${esc(c.counterexamples.join('；'))}</p><p>关联目标弧线：${esc(c.current_target_arc_ids.join('、')||'仅源素材核听')}</p>${c.human_baseline_evidence?'<p>已有 50–80 秒限定受压/蓄势人审；仍没有本批新用境批准。</p>':''}<details><summary>实际机器观察与原剧候选关联（不授予同版本）</summary><pre>${esc(JSON.stringify({predictions:c.existing_exact_window_observation?.pann_top_labels,language:c.machine_language_candidate,refs:c.reference_position_candidates,identity:c.recording_identity_evidence},null,2))}</pre></details><label>实际听过 <select name="listened"><option value="">待核</option><option value="true">是</option><option value="false">否</option></select></label><label>声型 <select name="form"><option value="">待核</option><option>instrumental</option><option>wordless_vocal</option><option>short_lyrics</option><option>spoken_adlib</option><option>dialogue_or_environment</option></select></label><label>同录音同版本 <select name="same_recording_version"><option value="">待核</option><option value="true">是（需要原剧对照）</option><option value="false">否</option></select></label><label>干净度 <select name="clean"><option value="">待核</option><option value="true">四项均无污染</option><option value="false">有污染</option></select></label><p>机器词句草稿；确认或改错即可（空转写不能证明器乐）：</p><textarea name="words">${esc(c.machine_words_candidate||'')}</textarea><label>完整乐句/歌句 <select name="complete_phrase"><option value="">待核</option><option value="true">是</option><option value="false">边界不完整</option></select></label><label>确认边界 <input name="source_start" type="number" step="0.001" value="${c.source_range[0]}">–<input name="source_end" type="number" step="0.001" value="${c.source_range[1]}"></label><p>具体通过/排除用途、目标弧线、词句指向、对白碰撞或需要扩看前后：</p><textarea name="reason"></textarea><label>审核者 <input name="reviewer"></label><label>审核时间 <input name="reviewed_at" type="datetime-local"></label><p class="pending">当前待审；本页不会生成 approved / Ready。</p></article>`).join('');
document.querySelector('#save').onclick=()=>{const rows=[...document.querySelectorAll('article')].map(a=>({card_id:a.dataset.id,fields:Object.fromEntries([...a.querySelectorAll('input,textarea,select')].map(x=>[x.name,x.value]))}));const b=new Blob([JSON.stringify({schema_version:1,type:'offline_batch_review_draft',origin:'pending_human',status:'draft',rows},null,2)],{type:'application/json'});const x=document.createElement('a');x.href=URL.createObjectURL(b);x.download='batch-review-draft.json';x.click();URL.revokeObjectURL(x.href)};</script></html>'''.replace('__DATA__', embedded)
    markup = markup.replace("document.querySelector('#save').onclick", """data.cards.forEach(c=>{if(c.observation_context){const a=document.querySelector('[data-id="'+c.card_id+'"]');const d=document.createElement('details');d.innerHTML='<summary>前后声音发展上下文（不扩大已核范围）</summary>'+player('audio/'+c.card_id+'-context.mp3')+'<p>上下文源 '+c.observation_context.source_range.join('–')+' 秒；机器词句只来自卡上原观察窗，外侧尚未观察/听核。</p>';a.append(d)}});document.querySelector('#save').onclick""")
    if (root / 'original-drama-comparisons.json').exists():
        markup = markup.replace('<div id="cards"></div>', '<p><a href="identity.html">打开雨蝶 / Hero / Savadika 的实际原剧与独立录音同步对照</a>（仅身份待审，不批准本批用途）</p><div id="cards"></div>')
    (root / 'index.html').write_text(markup, encoding='utf-8')
    lines = ['# 集中声音审核', '', '实际源窗媒体；没有新用户片。源事实、同版本、完整词句与具体用途分开审核；当前全部待审。', '']
    for card in pack['cards']:
        lines += [f"{card['card_id']} — {card['title_metadata_only']}；源 {card['source_range']}；提议 {card['proposed_use']}",
                  f"![{card['card_id']}]({card['media']['mp3']['path'].replace(chr(92), '/')})", '']
    (root / 'audition-list.md').write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
    print(json.dumps(prepare(config), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
