"""Consume real discovery hits into independent public recording candidates.

One acquisition per exact recording metadata tuple. No score/trial rendering and
no Ready, source-match, lyric, cleanliness or reference-budget promotion.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

_spec=importlib.util.spec_from_file_location('discovery',Path(__file__).with_name('run_original_discovery.py'))
discovery=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(discovery)


def track_key(candidate):
    values=[candidate.get(k) for k in ('title','subtitle','isrc')]
    if any(not isinstance(value,str) or not value.strip() for value in values):return None
    return hashlib.sha256(json.dumps([value.strip().casefold() for value in values],ensure_ascii=False).encode()).hexdigest()


def register_candidate(index, source_input, candidate, acquisition, result_binding, source_case=None):
    recordings=acquisition.get('actual_recordings',[])
    rows=[]
    for recording in recordings:
        source=recording['source'];sha=source['sha256']
        if discovery.digest(source['path'])!=sha:raise ValueError('independent_acquired_recording_changed')
        ep_id=source_input.get('source_episode_id') or source_input.get('public_reference',{}).get('episode_id')
        if not ep_id:raise ValueError('actual_source_episode_identity_missing')
        wid=ep_id.split('/')[0]
        case_ids=[]
        if source_case:
            case=discovery.checked(source_case)
            case_ids=[row['case_id'] for row in case.get('cases',[]) if row.get('case_id')]
            if case.get('case',{}).get('case_id'):case_ids.append(case['case']['case_id'])
            if case.get('case_id'):case_ids.append(case['case_id'])
        identifier='original-discovery/'+hashlib.sha256(json.dumps([ep_id,source_input['window_seconds'],candidate.get('isrc'),sha],sort_keys=True).encode()).hexdigest()[:28]
        pack='research-original-candidate/'+hashlib.sha256(json.dumps([ep_id,candidate.get('isrc'),sha],sort_keys=True).encode()).hexdigest()[:24]
        payload={'schema_version':1,'candidate_id':identifier,'work_id':wid,'episode_id':ep_id,
            'real_episode_case_ids':case_ids,'source_case_binding':source_case,'case_linkage_pending':True,
            'case_context_only':True,'case_occurrence_link_verified':False,
            'case_vs_fingerprint_clock_alignment':'pending; case IDs are episode context, not exact music occurrence approval',
            'reference_video':source_input['source'],'reference_fingerprint_range':source_input['window_seconds'],
            'recording':source,'recording_origin':'independent_official_public_preview_or_recording; not drama mix separation',
            'provider_metadata_candidate':candidate,'acquisition_result':result_binding,
            'available_source_range':recording.get('available_source_range_seconds'),
            'recording_extent':recording.get('scope','unknown'),
            'full_song_acquired':False,'cleanliness_verified':False,'lyrics_verified':False,'strict_source_recording_identity_verified':False,
            'artist_credit_scope':'official catalogue metadata only; actual artist/recording identity not independently concluded',
            'research_package_id':pack,'status':'research_candidate_not_ready','reference_music_budget_credit':False,
            'source_cut_equivalence':'unknown_for_alternate_versions','strict_screenshot_coverage_granted':False,
            'all_used_tracks_episode_complete':False,'Ready':False,'new_trial_rendered':False}
        index.execute('INSERT OR IGNORE INTO research_candidates(candidate_id,work_id,episode_id,case_id,recording_sha,pack_id,status,plot_function,payload) VALUES(?,?,?,?,?,?,?,?,?)',
            (identifier,wid,ep_id,None,sha,pack,'research_candidate_not_ready','actual music candidate; narrative suitability pending',json.dumps(payload,ensure_ascii=False)))
        rows.append(payload)
    index.commit();return rows


def consume(cfg, cache, index, states, receipt_path, helper, existing=None):
    receipt=discovery.read(receipt_path)
    if receipt.get('status')!='candidate_unverified' or not receipt.get('candidate_evidence'):return None
    discovery.receipt_state_fields(receipt)
    metadata=discovery.checked(receipt['candidate_evidence']);candidate=metadata.get('candidate') or {};key=track_key(candidate)
    if not key:return {'status':'stable_title_artist_isrc_missing','Ready':False}
    source_input=discovery.checked(receipt['input']);specification=discovery.checked(source_input['specification'])
    case=specification.get('source_case_binding')
    row=states.execute('SELECT status,payload FROM acquisitions WHERE track_key=?',(key,)).fetchone()
    if row:
        prior=json.loads(row[1])
        if prior.get('acquisition_result'):
            result=discovery.checked(prior['acquisition_result'])
            registered=register_candidate(index,specification,candidate,result,prior['acquisition_result'],case)
            return {'status':'existing_independent_recording_reused','recordings':len(registered),'http_requests':0,'Ready':False}
        completed=Path(cfg['state_root'])/'a'/key[:20]/'acquired/official-acquisition-result.json'
        if completed.is_file():
            result=discovery.read(completed);result_binding=discovery.bind(completed)
            registered=register_candidate(index,specification,candidate,result,result_binding,case)
            prior.update(status=result['status'],acquisition_result=result_binding,recordings=len(registered),Ready=False)
            states.execute('UPDATE acquisitions SET status=?,payload=? WHERE track_key=?',(prior['status'],json.dumps(prior,ensure_ascii=False),key));states.commit()
            return {'status':'completed_acquisition_recovered_without_http','recordings':len(registered),'http_requests':0,'Ready':False}
        return {'status':row[0],'http_requests':0,'automatic_replay':False,'Ready':False}
    root=Path(cfg['state_root'])/'a'/key[:20];root.mkdir(parents=True,exist_ok=True)
    inp={'schema_version':1,'candidate_metadata':receipt['candidate_evidence'],'recognition_receipt':discovery.bind(receipt_path)}
    if case:inp['source_case']=case
    if existing and track_key(existing['candidate'])==key:
        inp['reuse_existing_acquisition']=existing['reuse_existing_acquisition']
    input_path=root/'acquisition-input.json';discovery.save(input_path,inp)
    payload={'candidate':candidate,'input':discovery.bind(input_path),'status':'running','started_at_utc':datetime.now(timezone.utc).isoformat()}
    states.execute('INSERT INTO acquisitions VALUES(?,?,?)',(key,'running',json.dumps(payload,ensure_ascii=False)));states.commit()
    command=[cfg['python'],str(helper),'--input',str(input_path),'--out',str(root/'acquired')]
    try:
        p=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',timeout=150,
            env={**__import__('os').environ,'PYTHONIOENCODING':'utf-8'})
        (cache/(key[:20]+'.stdout.log')).write_text(p.stdout,encoding='utf-8');(cache/(key[:20]+'.stderr.log')).write_text(p.stderr,encoding='utf-8')
        result_path=root/'acquired/official-acquisition-result.json'
        if result_path.is_file():
            result=discovery.read(result_path);result_binding=discovery.bind(result_path)
            registered=register_candidate(index,specification,candidate,result,result_binding,case)
            if result.get('http_status')==429:
                discovery.save(Path(cfg['state_root'])/'rate-limit-stop.json',{'created_at_utc':datetime.now(timezone.utc).isoformat(),
                    'provider':'official_recording_acquisition','acquisition_result':result_binding,'explicit_resume_required':True})
                discovery.save(Path(cfg['state_root'])/'stop-request.json',{'kind':'discovery_provider_rate_limit',
                    'provider':'official_recording_acquisition','acquisition_result':result_binding,'explicit_resume_required':True})
            payload.update(status=result['status'],acquisition_result=result_binding,recordings=len(registered),
                actual_acquisition_consumer_executed=True,http_requests=len(result.get('requests',[])),Ready=False)
        else:payload.update(status='acquisition_consumer_gap',exit_code=p.returncode,automatic_replay=False,Ready=False)
    except subprocess.TimeoutExpired:payload.update(status='unknown_acquisition_outcome',automatic_replay=False,Ready=False)
    states.execute('UPDATE acquisitions SET status=?,payload=? WHERE track_key=?',(payload['status'],json.dumps(payload,ensure_ascii=False),key));states.commit()
    return payload


def run(args):
    cfg=discovery.read(args.config);cache=Path(cfg['cache_root']).parent/'acquisition-cache';cache.mkdir(parents=True,exist_ok=True)
    helper=Path(__file__).with_name('acquire_public_original_candidate.py')
    lock_path,token=discovery.lock(cache)
    states=sqlite3.connect(cache/'acquisition-state.sqlite')
    states.execute('CREATE TABLE IF NOT EXISTS acquisitions(track_key TEXT PRIMARY KEY,status TEXT,payload TEXT)');states.commit()
    index=sqlite3.connect(args.index)
    index.execute('CREATE TABLE IF NOT EXISTS research_candidates(candidate_id TEXT PRIMARY KEY,work_id TEXT,episode_id TEXT,case_id TEXT,recording_sha TEXT,pack_id TEXT,status TEXT,plot_function TEXT,payload TEXT)');index.commit()
    existing=discovery.read(args.reuse_seed) if args.reuse_seed else None
    summary={'schema_version':1,'runner_pid':__import__('os').getpid(),'status':'running','checked_named_hit_events':0,'candidate_recording_link_events':0,
        'new_official_acquisition_consumers':0,'Ready_packages':0,'new_trials':0,'paid_calls':0,'private_uploads':0}
    try:
        while True:
            if (Path(cfg['state_root'])/'rate-limit-stop.json').exists():
                summary['status']='respecting_global_fingerprint_rate_limit_stop';break
            receipts=list((Path(cfg['state_root'])/'e').glob('*/w/*/recognition/receipt.json'))
            if args.seed_receipt:receipts=[Path(args.seed_receipt)] if args.seed_only else [Path(args.seed_receipt)]+receipts
            for receipt in receipts:
                try:result=consume(cfg,cache,index,states,receipt,helper,existing)
                except Exception as error:result={'status':'candidate_acquisition_preflight_gap','error_type':type(error).__name__,'Ready':False}
                if result:
                    summary['checked_named_hit_events']+=1
                    summary['new_official_acquisition_consumers']+=int(result.get('actual_acquisition_consumer_executed') is True)
                    summary['candidate_recording_link_events']+=int(result.get('recordings',0)>0)
                    summary['last_result']=result
                    discovery.save(cache/'run-status.json',summary)
            if args.once:summary['status']='bounded_acquisition_pass_finished';break
            summary['tracked_exact_recording_tuples']=states.execute('SELECT count(*) FROM acquisitions').fetchone()[0]
            values=[json.loads(row[0]) for row in states.execute('SELECT payload FROM acquisitions')]
            summary['exact_recording_tuples_with_independent_files']=sum(v.get('recordings',0)>0 for v in values)
            discovery.save(cache/'run-status.json',summary)
            time.sleep(15)
        discovery.save(cache/'run-status.json',summary);print(json.dumps(summary,ensure_ascii=False))
    finally:
        states.close();index.close()
        if lock_path.is_file() and discovery.read(lock_path).get('token')==token:lock_path.unlink()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=Path,required=True)
    p.add_argument('--index',type=Path,required=True);p.add_argument('--reuse-seed',type=Path);p.add_argument('--seed-receipt',type=Path);p.add_argument('--seed-only',action='store_true');p.add_argument('--once',action='store_true')
    run(p.parse_args())
