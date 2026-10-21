"""Persistent, public first-ten recording discovery. Never renders episode music.

Consumes the existing public fingerprint component; successful candidates remain
unverified. State/evidence are separate from corpus research and production.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

GRAPH_VERIFIED_STAT_CACHE = set()


def digest(p):
    with Path(p).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def bind(p):
    actual=latest_state_file(Path(p))
    return {'path': str(actual.resolve()), 'sha256': digest(actual)}


def read(p):
    return json.loads(latest_state_file(Path(p)).read_text('utf-8-sig'))


def latest_state_file(p):
    if p.name=='run-status.json' and p.parent.is_dir():
        revisions=sorted(p.parent.glob(p.name+'.revision-*.json'))
        if revisions:
            newest=revisions[-1]
            if not p.exists() or newest.stat().st_mtime_ns>=p.stat().st_mtime_ns:return newest
    if str(p).upper().startswith('S:') and p.name in {'job-state.json','queue-scope.json','run-status.json','last-run-results.json','fresh-inspection-pointer.json','episode-discovery-summary.json','rate-limit-stop.json'}:
        revisions=sorted(p.parent.glob(p.name+'.revision-*.json')) if p.parent.is_dir() else []
        if revisions:return revisions[-1]
    return p


def checked(b):
    if digest(b['path']) != b['sha256']:
        raise ValueError('bound_discovery_input_changed')
    return read(b['path'])


def verify_graph(value, historical_code=None):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str) and isinstance(value.get('sha256'), str):
            p=Path(value['path']).resolve();s=p.stat();key=(str(p),s.st_size,s.st_mtime_ns,value['sha256'])
            archive=(historical_code or {}).get((str(p),value['sha256']))
            if archive:
                archive_stat=Path(archive).stat()
                key+=(str(Path(archive).resolve()),archive_stat.st_size,archive_stat.st_mtime_ns)
            if key not in GRAPH_VERIFIED_STAT_CACHE:
                if digest(p) != value['sha256']:
                    if not archive or digest(archive)!=value['sha256']:
                        raise ValueError('nested_discovery_evidence_changed')
                GRAPH_VERIFIED_STAT_CACHE.add(key)
        for child in value.values(): verify_graph(child,historical_code)
    elif isinstance(value, list):
        for child in value: verify_graph(child,historical_code)


def receipt_state_fields(receipt):
    verify_graph(receipt)
    input_record=checked(receipt['input']);verify_graph(input_record)
    archived=[]
    for key in ('runtime','submission','response','candidate_evidence'):
        if receipt.get(key):
            record=checked(receipt[key]);historical={}
            if key=='runtime':
                mutable=Path(__file__).parent/'reference_fingerprint/flick_public_adapter.py'
                for code in record.get('sdk_source_bindings',[]):
                    if Path(code['path']).resolve()==mutable.resolve():
                        copy=Path(receipt[key]['path']).parent/'flick_public_adapter.py'
                        if copy.is_file() and digest(copy)==code['sha256']:
                            historical[(str(mutable.resolve()),code['sha256'])]=copy
                            archived.append({'original_binding':code,'actual_contemporaneous_copy':bind(copy)})
            verify_graph(record,historical)
    return {'status':receipt['status'],'actual_input_binding':receipt['input'],'http_requests':receipt.get('http_requests',0),
        'http_status':receipt.get('http_status'),'submission':receipt.get('submission'),'response':receipt.get('response'),
        'candidate_evidence':receipt.get('candidate_evidence'),'actual_consumer_executed':True,
        'historical_adapter_code_evidence':archived}


def save(p, value):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    if str(p).upper().startswith('S:'):
        target=p if not p.exists() else p.with_name(p.name+'.revision-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-'+uuid.uuid4().hex+'.json')
        with target.open('x',encoding='utf-8') as stream:json.dump(value,stream,ensure_ascii=False,indent=2)
        return
    tmp = p.with_name(p.name + '.tmp-' + uuid.uuid4().hex)
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    try:
        os.replace(tmp, p)
    except PermissionError:
        # Progress JSON is telemetry; its Windows sharing lock must not abort a
        # successfully committed SQLite task. Authority/checkpoint writes still fail.
        if p.name!='run-status.json':raise
        revision=p.with_name(p.name+'.revision-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-'+uuid.uuid4().hex+'.json')
        with revision.open('x',encoding='utf-8') as stream:
            json.dump({**value,'telemetry_publication':{'mode':'immutable_revision_after_windows_sharing_error',
                'logical_status_path':str(p),'business_task_replay':False}},stream,ensure_ascii=False,indent=2)
        if tmp.is_file():tmp.unlink()


def alive(pid):
    if os.name != 'nt':
        try: os.kill(pid, 0); return True
        except ProcessLookupError: return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 5: raise RuntimeError('discovery_lock_owner_unqueryable')
        return False
    code = wintypes.DWORD()
    try:
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)): raise RuntimeError('discovery_lock_owner_unknown')
        return code.value == 259
    finally: kernel.CloseHandle(handle)


def windows(duration, length=10, step=8):
    if duration < 1: raise ValueError('source_extent_too_short')
    result = []
    start = 0.0
    while start < duration:
        end = min(duration, start + length)
        if end - start < 1:
            start = max(0, duration - length); end = duration
        bounds = [round(start, 9), round(end, 9)]
        if bounds not in result: result.append(bounds)
        if end >= duration: break
        start += step
    return result


def observation_windows(duration):
    return windows(duration, 25, 22)


def coverage_of(ranges, duration):
    cursor = 0.0
    for begin, end in sorted(ranges):
        if begin > cursor + 0.002: return False
        cursor = max(cursor, end)
    return cursor >= duration - 0.002


def covered_interval(ranges, requested):
    return coverage_of([[max(0,a-requested[0]),min(requested[1]-requested[0],b-requested[0])]
        for a,b in ranges if b>requested[0] and a<requested[1]],requested[1]-requested[0])


def summarize_episode(episode, episode_root):
    results = [read(p) for p in (episode_root / 'w').glob('*/job-state.json')]
    supported, candidates, failed = [], [], []
    for row in results:
        if row.get('actual_input_binding'):
            checked(row['actual_input_binding']); supported.append(row['source_window'])
        if row.get('status') not in ('no_candidate','candidate_unverified',
                                    'reused_bound_identity_or_actual_public_queries_unresolved_inventory'):
            failed.append({'source_window':row.get('source_window'),'status':row.get('status','unknown')})
        if row.get('candidate_evidence'):
            candidate = checked(row['candidate_evidence']).get('candidate')
            if candidate: candidates.append({'source_window': row['source_window'], 'candidate_metadata': candidate, 'status': 'unverified_lead', 'evidence': row['candidate_evidence']})
    candidates.sort(key=lambda row: row['source_window'])
    changes = []
    for before, after in zip(candidates, candidates[1:]):
        if before['candidate_metadata'].get('key') != after['candidate_metadata'].get('key'):
            changes.append({'between_source_windows': [before['source_window'],after['source_window']],
                'status': 'different_fingerprint_candidates_not_verified_music_change', 'actual_recording_change_verified': False})
    return {'target_id': episode['target_id'], 'source_episode_id': episode['episode_id'], 'source': episode['source'],
        'source_lane': episode['source_lane'], 'counts_toward_strict_screenshot_coverage': episode['counts_toward_strict_screenshot_coverage'],
        'source_duration_seconds': episode['duration_seconds'], 'full_observation_planning_windows': episode['full_observation_windows'],
        'observation_windows_actually_listened': False, 'planned_fingerprint_windows': episode['fingerprint_windows'],
        'actual_fingerprint_input_ranges': supported, 'fingerprint_input_timeline_coverage_complete': coverage_of(supported,episode['duration_seconds']),
        'all_fingerprint_outcomes_valid': not failed and coverage_of(supported,episode['duration_seconds']),
        'failed_fingerprint_window_count':len(failed),'failed_fingerprint_windows':failed,
        'candidate_leads': candidates, 'candidate_change_proposals': changes,
        'all_used_recording_inventory_complete': False, 'independent_clean_originals_complete': False, 'music_packages_ready': 0,
        'next_stage': 'locate_independent_recordings_then_actual_local_identity_and_cleanliness_review; never_use_mix_separation_as_master'}


def native_hongguo_jobs(queue, ledger, admitted, split='research', verifier=None):
    """Opt-in native queue; never reinterpret an old Hongguo receipt as ThePaper."""
    if queue.get('schema_version') != 1 or queue.get('kind') not in ('verified_hongguo_first10_queue',
                                                                  'historical_hongguo_first10_inspection_queue'):
        raise ValueError('native_hongguo_queue_contract_required')
    if split not in ('research','heldout'):
        raise ValueError('discovery_split_invalid')
    if verifier is None:
        spec = importlib.util.spec_from_file_location('native_public_adapter',
            Path(__file__).parent/'reference_fingerprint/flick_public_adapter.py')
        adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)
        verifier = (adapter._hongguo_native_source if queue['kind']=='historical_hongguo_first10_inspection_queue'
                    else adapter.verify_hongguo_public_acquisition)
    targets = {s['target_id']:(w,s) for w in ledger['works'] for s in w['slots']}
    registered = {r['episode_id']:r for r in admitted['entries']}
    jobs=[]; gaps=[]; seen=set()
    for row in queue.get('tasks',[]):
        tid=row.get('target_id')
        try:
            if tid not in targets or tid in seen:
                raise ValueError('native_hongguo_duplicate_or_unknown_target')
            seen.add(tid); work,slot=targets[tid]; media=slot.get('primary_canonical_media')
            if work['split_preserved'] != split:
                raise ValueError('native_hongguo_split_mismatch')
            if not media or media['source_platform']!='hongguo' or media['orientation']!='vertical' \
                    or media.get('confirmed_catalogue_episode') is not True:
                raise ValueError('native_hongguo_canonical_portrait_required')
            document=checked(row['specification']); verify_graph(document)
            ref=document.get('public_reference',{}); source=document.get('source',{})
            entry=registered.get(media['episode_id'])
            if not entry or entry.get('sha256')!=media['source_sha256'] \
                    or source.get('sha256')!=media['source_sha256'] \
                    or Path(source.get('path','')).resolve()!=Path(media['source_video']).resolve() \
                    or ref.get('episode_id')!=media['episode_id'] or ref.get('work_id')!=work['work_id'] \
                    or ref.get('episode_number')!=slot['episode_number']:
                raise ValueError('native_hongguo_queue_source_binding_mismatch')
            verifier(document)
            receipt=checked(document['public_source_provenance'])
            duration=float(receipt['jsonld_duration_seconds'])
            jobs.append({'target_id':tid,'work_id':work['work_id'],'title':work['title'],
                'episode_id':media['episode_id'],'episode_number':slot['episode_number'],'split':split,
                'source':source,'public_source_provenance':document['public_source_provenance'],
                'public_source_url':document['public_source_url'],'public_reference':ref,
                'full_decode_provenance':document['full_decode_provenance'],
                'public_source_inspection':document.get('public_source_inspection'),
                'native_anonymous_inspection_required':queue['kind']=='historical_hongguo_first10_inspection_queue',
                'native_specification_binding':row['specification'],
                'duration_seconds':duration,'full_observation_windows':observation_windows(duration),
                'fingerprint_windows':windows(duration),'source_lane':'canonical_public_hongguo_native',
                'counts_toward_strict_screenshot_coverage':True})
        except (ValueError, KeyError, OSError) as error:
            gaps.append({'target_id':tid,'reason':str(error),'stage':'native_public_source_admission'})
    return jobs,gaps


def load(config_file):
    cfg = read(config_file)
    if (cfg.get('schema_version') != 1 or cfg.get('kind') != 'public_first10_original_discovery'
        or cfg.get('public_fingerprint_submission_authorized') is not True):
        raise ValueError('explicit_public_discovery_authorization_required')
    if cfg.get('source_policy') != 'canonical_public_primary_and_verified_flick_alternates' or cfg.get('paid_calls_allowed') is not False:
        raise ValueError('discovery_scope_or_budget_invalid')
    queue = checked(cfg['first10_queue']); ledger = checked(cfg['coverage_ledger']); catalog = checked(cfg['catalogue'])
    admitted = checked(cfg['admitted_media_manifest'])
    if len(catalog['works']) != 115 or len(queue['targets']) != 1145 or len(ledger['works']) != 115:
        raise ValueError('complete_115_first10_scope_required')
    if sum(min(10, w['episode_count']) for w in catalog['works']) != 1145:
        raise ValueError('canonical_first10_count_changed')
    if digest(cfg['fingerprint_component']['path']) != cfg['fingerprint_component']['sha256']:
        raise ValueError('fingerprint_component_changed')
    admitted_by_id = {e['episode_id']: e for e in admitted['entries']}
    targets = {s['target_id']: (w, s) for w in ledger['works'] for s in w['slots']}
    jobs, gaps = [], []
    for task in queue['targets']:
        w, slot = targets[task['target_id']]; media = slot['primary_canonical_media']
        reason = None
        if not media or not slot['canonical_mapping_and_file_available']: reason = 'canonical_full_episode_missing'
        elif w['split_preserved'] == 'heldout': reason = 'heldout_preserved_separate_discovery_lane_pending'
        elif media['orientation'] != 'vertical': reason = 'horizontal_or_unknown_auxiliary_not_main_discovery'
        elif media['source_platform'] != 'thepaper': reason = 'native_public_provenance_adapter_not_validated_for_' + str(media['source_platform'])
        elif not media['confirmed_catalogue_episode']: reason = 'screenshot_cut_mapping_unverified'
        if reason:
            gaps.append({'target_id': task['target_id'], 'work_id': w['work_id'], 'title': w['title'], 'reason': reason}); continue
        entry = admitted_by_id.get(media['episode_id'])
        if not entry or entry.get('sha256') != media['source_sha256'] or entry.get('confirmed_catalogue_episode') is not True:
            raise ValueError('primary_media_not_bound_to_admitted_manifest')
        receipt_path = Path(media['source_video']).parent / 'acquisition-receipt.json'
        receipt = read(receipt_path); rmedia = receipt.get('media', {})
        url = urlsplit(receipt.get('source_page', ''))
        if (receipt.get('status') != 'acquired_verified' or rmedia.get('full_decode_success') is not True or rmedia.get('publication_verified_by_sha256') is not True
            or rmedia.get('sha256') != media['source_sha256'] or url.hostname != 'www.thepaper.cn'
            or receipt.get('work_id') != w['work_id'] or receipt.get('episode_number') != slot['episode_number']):
            raise ValueError('native_verified_public_primary_receipt_required')
        jobs.append({'target_id': task['target_id'], 'work_id': w['work_id'], 'title': w['title'], 'episode_id': media['episode_id'],
            'episode_number': slot['episode_number'], 'split': w['split_preserved'], 'source': {'path': media['source_video'], 'sha256': media['source_sha256']},
            'public_source_provenance': bind(receipt_path), 'public_source_url': receipt['source_page'],
            'public_reference': {key: receipt[key] for key in ('work_id', 'episode_number', 'official_series_id', 'official_episode_id')},
            'duration_seconds': float(rmedia['duration_seconds']), 'full_observation_windows': observation_windows(float(rmedia['duration_seconds'])),
            'fingerprint_windows': windows(float(rmedia['duration_seconds'])), 'source_lane': 'canonical_public_primary', 'counts_toward_strict_screenshot_coverage': True})
    if cfg.get('flick_alternate_queue'):
        alternate_queue = checked(cfg['flick_alternate_queue'])
        if cfg.get('flick_public_inspector') and digest(cfg['flick_public_inspector']['path']) != cfg['flick_public_inspector']['sha256']:
            raise ValueError('flick_public_inspector_changed')
        canonical = {w['work_id']: w for w in catalog['works']}
        for task in alternate_queue['tasks']:
            case = checked(task['source_case']); receipt = checked(task['acquisition_receipts'][0]); w = canonical.get(task['work_id'])
            if not w or w['split'] != 'research' or not 1 <= receipt['episode_number'] <= min(10, w['episode_count']) or case['work']['split'] != 'research':
                raise ValueError('alternate_first10_work_or_split_mismatch')
            if case['episode']['episode_id'] != task['episode_id'] or case['episode']['source_video']['sha256'] != task['reference_video']['sha256']:
                raise ValueError('alternate_real_case_source_binding_required')
            if receipt['media']['sha256'] != task['reference_video']['sha256'] or receipt.get('fresh_is_lock') != 0:
                raise ValueError('alternate_native_unlocked_receipt_required')
            entry = admitted_by_id.get(task['episode_id'])
            if not entry or entry['sha256'] != task['reference_video']['sha256']:
                raise ValueError('alternate_not_in_bound_admitted_manifest')
            series, episode = str(receipt['source_uid'].split(':')[1]), receipt['episode_number']
            jobs.append({'target_id': 'original-research/' + task['episode_id'], 'work_id': task['work_id'], 'title': task['title'],
                'episode_id': task['episode_id'], 'episode_number': episode, 'split': 'research', 'source': task['reference_video'],
                'public_source_provenance': task['acquisition_receipts'][0], 'public_source_url': receipt['source_page'],
                'public_reference': {'platform': 'flickreels', 'work_id': task['work_id'], 'episode_id': task['episode_id'], 'series_id': series,
                    'source_episode_id': str(receipt['source_episode_id']), 'episode_number': episode},
                'source_task_binding': cfg['flick_alternate_queue'], 'source_task_id': task['task_id'], 'source_case_binding': task['source_case'],
                'duration_seconds': float(receipt['media']['duration_seconds']),
                'full_observation_windows': observation_windows(float(receipt['media']['duration_seconds'])),
                'fingerprint_windows': windows(float(receipt['media']['duration_seconds'])), 'source_lane': 'verified_public_alternate_original_research_only',
                'counts_toward_strict_screenshot_coverage': False})
    if cfg.get('hongguo_primary_queue'):
        extra, rejected = native_hongguo_jobs(checked(cfg['hongguo_primary_queue']), ledger, admitted)
        admitted_targets={row['target_id'] for row in extra}
        gaps=[row for row in gaps if row['target_id'] not in admitted_targets]+rejected
        jobs.extend(extra)
    jobs.sort(key=lambda e: (e['episode_number'], e['work_id'], e['source_lane'], e['episode_id']))
    return cfg, jobs, gaps, len(admitted['entries'])


def lock(root):
    root.mkdir(parents=True, exist_ok=True); p = root / 'discovery.lock.json'; token = uuid.uuid4().hex
    owner = {'pid': os.getpid(), 'token': token, 'runner': str(Path(__file__).resolve()), 'created_at_utc': datetime.now(timezone.utc).isoformat()}
    claim=root/'discovery.lock.claim'
    try:
        with claim.open('x',encoding='utf-8') as stream:json.dump(owner,stream)
    except FileExistsError: raise RuntimeError('discovery_lock_claim_in_progress_or_unknown')
    try:
        try:
            with p.open('x', encoding='utf-8') as stream: json.dump(owner, stream)
        except FileExistsError:
            old_bytes=p.read_bytes();prior=json.loads(old_bytes.decode('utf-8-sig'))
            if not isinstance(prior.get('pid'), int) or prior.get('runner') != str(Path(__file__).resolve()): raise RuntimeError('discovery_lock_owner_unknown')
            if alive(prior['pid']): raise RuntimeError('original_discovery_already_running')
            if p.read_bytes()!=old_bytes:raise RuntimeError('discovery_lock_owner_changed')
            stale = root / ('stale-discovery-lock-' + uuid.uuid4().hex + '.json'); os.rename(p, stale)
            with p.open('x', encoding='utf-8') as stream: json.dump(owner, stream)
    finally:
        if claim.is_file() and read(claim).get('token')==token:claim.unlink()
    return p, token


def perform(cfg, episode, bounds, state_root, probe=False):
    if digest(episode['source']['path'])!=episode['source']['sha256']:raise ValueError('actual_public_source_changed_before_cache_or_submit')
    checked(episode['public_source_provenance'])
    support=[]
    for prior in cfg.get('prior_window_evidence', []):
        if prior['source_sha256'] == episode['source']['sha256']:
            checked(prior['evidence'])
            support.append({'range':prior['source_range'],'evidence':prior['evidence'],'kind':prior['kind']})
    previous_directory=state_root/'e'/episode['source']['sha256'][:16]/'w'
    for p in previous_directory.glob('*/job-state.json') if previous_directory.is_dir() else []:
        old=read(p)
        if old.get('source',{}).get('sha256')!=episode['source']['sha256'] or not old.get('recognition_receipt'):continue
        r=checked(old['recognition_receipt']);receipt_state_fields(r)
        if r.get('status') not in ('candidate_unverified','no_candidate'):continue
        support.append({'range':old['source_window'],'evidence':old['recognition_receipt'],'kind':'actual_public_fingerprint_query'})
    if covered_interval([s['range'] for s in support],bounds):
        return {'target_id':episode['target_id'],'source':episode['source'],'source_window':bounds,
            'status':'reused_bound_identity_or_actual_public_queries_unresolved_inventory', 'reused_without_http':True,'http_requests':0,
            'covered_by_bound_prior_windows':support,'actual_consumer_executed':False,'music_pack_ready':False,'all_used_tracks_complete':False}
    key = hashlib.sha256(json.dumps({'source': episode['source'], 'bounds': bounds,
        'component': cfg['fingerprint_component'], 'provenance': episode['public_source_provenance']}, sort_keys=True).encode()).hexdigest()
    episode_directory=state_root/'e'/episode['source']['sha256'][:16]
    root = episode_directory/'w'/key[:20]
    state_file = root / 'job-state.json'
    if state_file.exists():
        old = read(state_file)
        if old.get('recognition_receipt'):
            receipt = checked(old['recognition_receipt'])
            receipt_state_fields(receipt)
            if digest(episode['source']['path']) != episode['source']['sha256']:raise ValueError('cached_public_source_changed')
            checked(episode['public_source_provenance'])
            return {**old, 'reused_without_http': True}
        if old.get('status') in ('running', 'unknown_outcome'):
            output = root / 'recognition'
            if (output / 'receipt.json').exists():
                old['recognition_receipt'] = bind(output / 'receipt.json');old.update(receipt_state_fields(read(output/'receipt.json')));save(state_file,old)
                return perform(cfg, episode, bounds, state_root, probe)
            old['status'] = 'unknown_outcome'; old['automatic_resubmission_allowed'] = False; save(state_file, old)
            return {**old,'reused_without_http':True}
        return {**old, 'reused_without_http': True}
    # Full actual source hash and native provenance guard are also executed by
    # the mature child before and after its single fingerprint POST.
    if digest(episode['source']['path']) != episode['source']['sha256']:
        raise ValueError('actual_public_primary_source_sha_changed')
    checked(episode['public_source_provenance'])
    if digest(cfg['fingerprint_component']['path']) != cfg['fingerprint_component']['sha256']:
        raise ValueError('fingerprint_component_changed')
    root.mkdir(parents=True, exist_ok=False)
    save(state_file,{'source':episode['source'],'source_window':bounds,'status':'preflight_running','runner_pid':os.getpid(),
        'actual_consumer_executed':False,'automatic_resubmission_allowed':False,'all_used_tracks_complete':False,'music_pack_ready':False})
    spec_file = root / 'input-specification.json'
    spec = {'source_kind': 'public_research_video', 'public_source_url': episode['public_source_url'], 'source': episode['source'],
        'public_source_provenance': episode['public_source_provenance'], 'public_reference': episode['public_reference'],
        'window_seconds': bounds, 'source_clock': 'decoded_audio_zero_start_samples',
        'bound_first10_queue': cfg['first10_queue'], 'target_id': episode['target_id'], 'source_episode_id': episode['episode_id']}
    if episode['public_reference'].get('platform')=='hongguo':
        # Admission and the real child independently validate the native sidecars.
        # Expired/failed inspection is a specific source gap, never a platform relabel.
        spec.update(full_decode_provenance=episode['full_decode_provenance'],
                    public_source_inspection=episode['public_source_inspection'])
        if episode.get('native_anonymous_inspection_required'):
            pointer=episode_directory/'fresh-inspection-pointer.json'
            inspection=None
            if latest_state_file(pointer).is_file():
                candidate=read(pointer)['inspection'];report=checked(candidate)
                age=(datetime.now(timezone.utc)-datetime.fromisoformat(report['created_at'])).total_seconds()
                if 0<=age<3000:inspection=candidate
            if inspection is None:
                inspection_input=episode_directory/('native-inspection-input-'+uuid.uuid4().hex+'.json')
                save(inspection_input,{key:spec[key] for key in ('source_kind','source','public_reference',
                    'public_source_url','public_source_provenance','full_decode_provenance')})
                directory=episode_directory/('native-inspection-'+uuid.uuid4().hex)
                inspector=Path(__file__).parent/'reference_fingerprint/flick_public_adapter.py'
                check=subprocess.run([cfg['python'],str(inspector),'--hongguo-input',str(inspection_input),
                    '--out',str(directory)],capture_output=True,text=True,encoding='utf-8',timeout=100,
                    env={**os.environ,'PYTHONIOENCODING':'utf-8'})
                inspection_file=directory/'public-source-inspection.json'
                if check.returncode!=0 or not inspection_file.is_file():
                    raise ValueError('native_hongguo_anonymous_inspection_execution_gap')
                inspection=bind(inspection_file);save(pointer,{'inspection':inspection})
            report=checked(inspection)
            if report.get('status')!='fresh_anonymous_hongguo_detail_and_player_checked':
                raise ValueError(report.get('gap','native_hongguo_anonymous_inspection_gap'))
            spec.update(public_source_inspection=inspection,public_reference=report['native_reference'])
    if episode.get('source_task_binding'):
        episode_root = episode_directory
        inspection_pointer = episode_root / 'fresh-inspection-pointer.json'
        inspection = None
        if inspection_pointer.is_file():
            candidate_inspection = read(inspection_pointer)['inspection']
            candidate = checked(candidate_inspection)
            if 0 <= (datetime.now(timezone.utc) - datetime.fromisoformat(candidate['created_at'])).total_seconds() < 3000:
                inspection = candidate_inspection
        if inspection is None:
            inspection_output = episode_root / ('source-inspection-' + uuid.uuid4().hex)
            inspector_command = [cfg['python'], cfg['flick_public_inspector']['path'], '--queue', cfg['flick_alternate_queue']['path'],
                '--task-id', episode['source_task_id'], '--out', str(inspection_output)]
            inspection_run = subprocess.run(inspector_command, capture_output=True, text=True, encoding='utf-8', timeout=100,
                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            if inspection_run.returncode != 0:
                raise ValueError('fresh_alternate_public_inspection_failed')
            inspection = bind(inspection_output / 'public-source-inspection.json')
            save(inspection_pointer, {'inspection': inspection, 'argv': inspector_command})
        spec.update(source_task_binding=episode['source_task_binding'], source_task_id=episode['source_task_id'],
            source_case_binding=episode['source_case_binding'], public_source_inspection=inspection)
    save(spec_file, spec)
    state = {'schema_version': 1, 'job_key': key, 'target_id': episode['target_id'], 'source_episode_id': episode['episode_id'],
        'source': episode['source'], 'source_window': bounds, 'status': 'running', 'single_attempt': True,
        'probe': probe, 'started_at_utc': datetime.now(timezone.utc).isoformat(), 'runner_pid': os.getpid(),
        'independent_recording_acquired': False, 'recording_identity_verified': False, 'cleanliness_verified': False,
        'all_used_tracks_complete': False, 'music_pack_ready': False, 'private_media_uploaded': False, 'paid_calls': 0}
    save(state_file, state)
    command = [cfg['python'], cfg['fingerprint_component']['path'], '--input', str(spec_file), '--out', str(root / 'recognition'), '--consent-to-external-fingerprint-submission']
    started = time.monotonic()
    try:
        child = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=105, env={**os.environ, 'PYTHONIOENCODING':'utf-8'})
        (root / 'consumer.stdout.log').write_text(child.stdout, encoding='utf-8'); (root / 'consumer.stderr.log').write_text(child.stderr, encoding='utf-8')
        save(root / 'execution.json', {'argv': command, 'exit_code': child.returncode, 'wall_seconds': time.monotonic()-started,
            'actual_consumer_executed': True, 'stdout': bind(root / 'consumer.stdout.log'), 'stderr': bind(root / 'consumer.stderr.log')})
        receipt_file = root / 'recognition/receipt.json'
        if receipt_file.exists():
            receipt = read(receipt_file);state.update(receipt_state_fields(receipt));state['recognition_receipt']=bind(receipt_file)
        else:
            state.update(status='unknown_outcome' if (root / 'recognition/submission.json').exists() else 'consumer_preflight_failed', automatic_resubmission_allowed=False)
    except subprocess.TimeoutExpired:
        state.update(status='unknown_outcome', error='child_timeout_no_automatic_replay', automatic_resubmission_allowed=False,actual_consumer_executed=True)
    state['finished_at_utc'] = datetime.now(timezone.utc).isoformat(); save(state_file, state)
    return state


def run(args):
    cfg, episodes, gaps, admitted_count = load(args.config)
    root = Path(cfg['state_root']); cache = Path(cfg['cache_root']); cache.mkdir(parents=True, exist_ok=True)
    if (root/'rate-limit-stop.json').exists():raise RuntimeError('persistent_rate_limit_requires_explicit_resume_evidence')
    p, token = lock(cache)
    try:
        save(root / 'queue-scope.json', {'config': bind(args.config), 'episodes': episodes, 'gaps': gaps,
            'admitted_fullrange_rows_preserved': admitted_count, 'first10_targets': 1145,
            'all_used_tracks_complete': False, 'original_music_package_ready_count': 0})
        selected = episodes
        if args.probe_target:
            selected = [e for e in episodes if e['target_id'] == args.probe_target]
            if len(selected) != 1: raise ValueError('probe_requires_one_eligible_public_primary_target')
        summary = {'schema_version': 1, 'runner_pid': os.getpid(), 'started_at_utc': datetime.now(timezone.utc).isoformat(),
            'scope': 'preproduction_recording_discovery_only_no_scoring_or_trials', 'eligible_discovery_source_versions': len(episodes),
            'canonical_public_primary_episodes':sum(e['counts_toward_strict_screenshot_coverage'] is True for e in episodes),
            'native_hongguo_primary_episodes':sum(e['source_lane']=='canonical_public_hongguo_native' for e in episodes),
            'verified_public_alternate_source_versions':sum(e['source_lane']=='verified_public_alternate_original_research_only' for e in episodes),
            'gated_first10_targets': len(gaps), 'admitted_fullrange_rows_preserved': admitted_count, 'windows_executed_this_run': 0,
            'windows_reused_without_http': 0, 'http_requests_this_run': 0, 'candidate_windows_this_run': 0, 'status': 'running',
            'all_used_tracks_complete': False, 'original_music_packages_ready': 0, 'paid_calls': 0, 'private_media_uploads': 0,
            'new_models': 0, 'source_files_downloaded': 0, 'old_media_research_workers_stopped': 0}
        results = []
        for episode in selected:
            bounds_list = [args.probe_window] if args.probe_target else episode['fingerprint_windows']
            episode_results = []
            for bounds in bounds_list:
                if (root/'rate-limit-stop.json').exists():summary['status']='respecting_persistent_global_rate_limit_stop';break
                if (root / 'stop-request.json').exists(): summary['status']='explicit_discovery_stop_preserved'; break
                if not 1-1e-9 <= bounds[1]-bounds[0] <= 10+1e-9 or not 0 <= bounds[0] < bounds[1] <= episode['duration_seconds']:
                    raise ValueError('bound1to10second_discovery_window_required')
                try: result = perform(cfg, episode, bounds, root, bool(args.probe_target))
                except Exception as error:
                    result={'target_id':episode['target_id'],'source_window':bounds,'status':'window_preflight_gap','error_type':type(error).__name__,'error':str(error),'http_requests':0}
                episode_results.append(result); results.append(result)
                reused = result.get('reused_without_http') is True
                summary['windows_reused_without_http'] += int(reused)
                summary['windows_executed_this_run'] += int(not reused and result.get('actual_consumer_executed') is True)
                summary['http_requests_this_run'] += 0 if reused else result.get('http_requests',0)
                summary['candidate_windows_this_run'] += int(not reused and result.get('status')=='candidate_unverified')
                summary['last_result'] = result
                save(root / 'run-status.json', summary); save(cache / 'run-status.json', summary)
                if result.get('status') == 'rate_limited_stop_all':
                    save(root/'rate-limit-stop.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),'result':result,'explicit_resume_required':True})
                    summary['status']='rate_limited_requires_explicit_resume';break
                if args.max_windows and summary['windows_executed_this_run'] >= args.max_windows: summary['status']='bounded_run_finished'; break
                if not reused: time.sleep(cfg.get('minimum_request_interval_seconds',3))
            episode_root = root/'e'/episode['source']['sha256'][:16]
            save(episode_root / 'episode-discovery-summary.json', summarize_episode(episode, episode_root))
            if summary['status'] != 'running': break
        if summary['status']=='running': summary['status']='available_queue_finished_with_gaps'
        summary['finished_at_utc']=datetime.now(timezone.utc).isoformat(); save(root/'run-status.json',summary); save(cache/'run-status.json',summary)
        save(root/'last-run-results.json',{'config':bind(args.config),'results':results,'summary':summary})
        print(json.dumps(summary,ensure_ascii=False))
    finally:
        if p.is_file() and read(p).get('token')==token: p.unlink()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True); parser.add_argument('--max-windows',type=int,default=0)
    parser.add_argument('--probe-target'); parser.add_argument('--probe-window',type=float,nargs=2)
    arguments=parser.parse_args()
    if bool(arguments.probe_target) != bool(arguments.probe_window): parser.error('probe target and bounds must be supplied together')
    run(arguments)
