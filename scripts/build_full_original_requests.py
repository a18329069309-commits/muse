"""Build executable full-recording inputs; never search/download or start a worker.

Routes are genuine bound official source evidence, not bare URLs. Missing routes
remain full-source discovery gaps. Existing preview consumers/configs are untouched.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

_spec = importlib.util.spec_from_file_location('full_recording',Path(__file__).with_name('acquire_full_original_recording.py'))
full = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(full)


def candidate_key(candidate):
    return hashlib.sha256(json.dumps([str(candidate.get(key,'')).strip().casefold() for key in ('title','subtitle','isrc')],
                                     ensure_ascii=False).encode()).hexdigest()


def build(args):
    out = Path(args.out)
    out.mkdir(parents=True,exist_ok=False)
    queue_binding = full.bind(args.first10_queue)
    queue = full.checked(queue_binding)
    catalog = {target['work_id'] for target in queue['targets']}
    policy_origin = full.bind(args.project_policy)
    # Acquisition provenance is immutable even when the host later updates trial scheduling.
    policy_snapshot = out/'project-policy.snapshot.json'
    full.write_new(policy_snapshot, full.checked(policy_origin))
    policy = full.bind(policy_snapshot)
    tool = full.bind(args.yt_dlp)
    route_binding = full.bind(args.routes)
    routes = full.checked(route_binding)
    if routes.get('schema_version') != 1 or not isinstance(routes.get('routes'),list):
        raise ValueError('bound_full_original_routes_list_required')
    connection = sqlite3.connect(Path(args.candidate_index).as_uri()+'?mode=ro',uri=True)
    connection.execute('BEGIN')
    rows = connection.execute('SELECT candidate_id,work_id,episode_id,case_id,payload FROM research_candidates ORDER BY candidate_id').fetchall()
    connection.rollback()
    connection.close()
    groups = {}
    for identifier,wid,eid,case_id,payload in rows:
        item = json.loads(payload)
        if wid not in catalog:
            continue
        candidate = item.get('provider_metadata_candidate')
        if not candidate:
            continue
        key = candidate_key(candidate)
        group = groups.setdefault(key,{'candidate':candidate,'links':[]})
        # Legacy rows stored the episode's first case despite pending occurrence clocks.
        # Preserve that as historical context, never as the music's approved plot location.
        approved_case = case_id if item.get('case_occurrence_link_verified') is True else None
        group['links'].append({'candidate_id':identifier,'work_id':wid,'episode_id':eid,'case_id':approved_case,
                               'legacy_case_context':case_id,'episode_context_case_ids':item.get('real_episode_case_ids',[]),
                               'case_occurrence_link_verified':item.get('case_occurrence_link_verified') is True,
                               'reference_video':item.get('reference_video'),'reference_fingerprint_range':item.get('reference_fingerprint_range'),
                               'existing_independent_preview':item.get('recording'), 'case_clock_alignment':'pending'})
    if getattr(args,'acquisition_state',None):
        connection=sqlite3.connect(Path(args.acquisition_state).as_uri()+'?mode=ro',uri=True)
        connection.execute('BEGIN')
        leads=connection.execute('SELECT track_key,status,payload FROM acquisitions ORDER BY track_key').fetchall()
        connection.rollback();connection.close()
        for original_key,status,payload in leads:
            candidate=json.loads(payload).get('candidate')
            if candidate:
                group=groups.setdefault(candidate_key(candidate),{'candidate':candidate,'links':[]})
                group['acquisition_lead']={'track_key':original_key,'status':status,'recording_match':'pending'}
    route_keys = set()
    previous = full.read(args.previous_queue) if getattr(args,'previous_queue',None) else None
    tasks = list(previous['tasks']) if previous else []
    gaps = []
    inherited_keys = {task['task_key'] for task in tasks}
    current_keys = set(inherited_keys)
    inherited_catalogue_routes = {task['candidate_key'] for task in tasks if task.get('candidate_key')
                                 and task.get('candidate_version_relation')!='different_or_unverified_catalogue_variant'}
    for task in tasks:
        if task.get('candidate_version_relation')=='different_or_unverified_catalogue_variant':
            group=groups.get(task.get('candidate_key'))
            gaps.append({'candidate_key':task.get('candidate_key'),'candidate':(group or {}).get('candidate'),
                         'requested_extent':'full_recording','status':'exact_catalogue_version_still_unresolved',
                         'alternate_full_task_key':task['task_key'],
                         'gap':'Inherited official alternate/MV remains a distinct version; exact catalogue recording/ISRC gap retained.'})
    for route in routes['routes']:
        # Explicit prior verified original identities may provide a route absent
        # from the newer preview-only candidate table. They remain separate context.
        if route.get('reference_original_identity'):
            full.checked(route['reference_original_identity'])
        candidate = route.get('candidate') or {}
        key = candidate_key(candidate) if candidate else None
        if key:
            if key in route_keys:
                raise ValueError('duplicate_official_route_for_same_recording_request')
            route_keys.add(key)
        source = route.get('official_source')
        if not source:
            gaps.append({'candidate_key':key,'candidate':candidate,'requested_extent':'full_recording',
                         'status':'needs_verified_normal_official_full_entry','gap':'No bound normal official full-source evidence supplied; Apple preview does not establish global unavailability.'})
            continue
        metadata = full.checked(source['metadata'])
        expected = route.get('expected') or {'title':metadata['title'],'channel_id':metadata['channel_id'],
            'release_date':metadata.get('release_date'),'metadata_artist_credit':metadata.get('artist'),
            'recording_version':route.get('recording_version'),'isrc':candidate.get('isrc') or None}
        links = (groups.get(key) or {}).get('links',[])
        context = {'candidate_key':key,'provider_metadata_candidate':candidate or None,'research_links':links,
                   'reference_original_identity':route.get('reference_original_identity'),'route_binding':route_binding}
        specification = {'schema_version':1,'requested_extent':'full_recording','expected':expected,
                         'official_source':source,'yt_dlp':tool,'first10_queue':queue_binding,'project_policy':policy,
                         'recording_output_root':str(Path(args.recording_root)), 'research_context':context,
                         'artist_recording_match':'pending; this task acquires the supplied official entry only',
                         'Ready':False,'strict_screenshot_coverage_granted':False}
        if route.get('reuse_existing'):
            specification['reuse_existing'] = route['reuse_existing']
        if route.get('network_route'):
            specification['network_route'] = route['network_route']
        if route.get('targeted_repair'):
            specification['targeted_repair']=route['targeted_repair']
        relation = route.get('candidate_version_relation','same_named_catalogue_version_candidate_identity_pending')
        specification['research_context']['candidate_version_relation'] = relation
        ordinal = len(tasks)
        temporary = out/('input-'+str(ordinal)+'.json')
        full.write_new(temporary,specification)
        prepared = full.prepare(temporary)
        task_key = prepared['task_key']
        if task_key in current_keys:
            # Old inputs/commands/results stay byte-identical. Do not schedule a
            # second task just because a new catalogue tuple describes an old file.
            continue
        current_keys.add(task_key)
        specification['task_key'] = task_key
        # The final immutable input is the consumer's exact causal binding.
        input_file = out/(task_key[:24]+'-full-input.json')
        full.write_new(input_file,specification)
        output = Path(args.state_root)/task_key
        tasks.append({'task_key':task_key,'requested_extent':'full_recording','candidate_key':key,
                      'status':'ready_for_actual_full_recording_consumer','input':full.bind(input_file),'output_dir':str(output),
                      'command':[str(args.python),'-B',str(Path(full.__file__).resolve()),'--input',str(input_file),'--out',str(output)],
                      'research_links':links,'reuse_known_independent_full_recording':bool(route.get('reuse_existing')),
                      'candidate_version_relation':relation,
                      'new_user_film_trial':False,'Ready':False})
        if relation=='different_or_unverified_catalogue_variant':
            gaps.append({'candidate_key':key,'candidate':candidate,'requested_extent':'full_recording',
                         'status':'exact_catalogue_version_still_unresolved','alternate_full_task_key':task_key,
                         'gap':'Official complete MV/alternate entry is a separate version candidate; does not close the exact catalogue recording/ISRC gap.'})
    for key,group in groups.items():
        if key not in route_keys and key not in inherited_catalogue_routes and not any(gap.get('candidate_key')==key for gap in gaps):
            gaps.append({'candidate_key':key,'candidate':group['candidate'],'requested_extent':'full_recording',
                         'research_links':group['links'],'status':'needs_verified_normal_official_full_entry',
                         'gap':'Only an independent preview is currently linked. No bound official full-source route supplied; not a claim that no full recording exists online.'})
    unique_gaps={}
    for gap in gaps:
        identity=(gap.get('candidate_key'),gap['status'])
        if identity in unique_gaps:
            original=unique_gaps[identity]
            original.setdefault('related_alternate_full_task_keys',[original.get('alternate_full_task_key')])
            if gap.get('alternate_full_task_key') not in original['related_alternate_full_task_keys']:
                original['related_alternate_full_task_keys'].append(gap.get('alternate_full_task_key'))
        else:unique_gaps[identity]=gap
    gaps=list(unique_gaps.values())
    result = {'schema_version':1,'kind':'first10_independent_full_recording_consumer_queue','created_at_utc':datetime.now(timezone.utc).isoformat(),
              'requested_extent':'full_recording','tasks':tasks,'full_source_gaps':gaps,'inputs':{'routes':route_binding,'first10_queue':queue_binding,
              'candidate_index_readonly_transaction':str(args.candidate_index),'project_policy':policy,
              'project_policy_origin_at_build':policy_origin,'yt_dlp':tool},
              'scope':{'screenshot_works':115,'first10_full_episode_targets':1145,'screenshot_episode_positions':8926,
                       'later_fullrange_preserved':True,'heldout_isolated':True},
              'separate_from_preview_cache':True,'worker_started':False,'downloads':0,'Ready_packages':0,'paid_calls':0,'new_user_film_trials':0}
    if previous:
        result['previous_queue']=full.bind(args.previous_queue)
        result['append_validation']={'old_task_keys_preserved':len(inherited_keys),'added_task_keys':len(current_keys-inherited_keys),
                                     'old_inputs_and_commands_preserved':True,'old_completed_jobs_not_rescheduled':True}
    result['implementation']={'acquisition':full.bind(Path(full.__file__)),'builder':full.bind(Path(__file__))}
    if getattr(args,'acquisition_state',None):
        result['inputs']['acquisition_state_readonly_transaction']=str(args.acquisition_state)
    result['distinct_named_candidate_tuples']=len(groups)
    binding = full.write_new(out/'full-recording-requests.json',result)
    return binding,result


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes',type=Path,required=True)
    parser.add_argument('--candidate-index',type=Path,required=True)
    parser.add_argument('--first10-queue',type=Path,required=True)
    parser.add_argument('--project-policy',type=Path,required=True)
    parser.add_argument('--yt-dlp',type=Path,required=True)
    parser.add_argument('--python',required=True)
    parser.add_argument('--state-root',type=Path,required=True)
    parser.add_argument('--recording-root',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--previous-queue',type=Path,help='Append new tasks while retaining every previous exact input and command')
    parser.add_argument('--acquisition-state',type=Path,help='Also retain named leads with no preview/index row')
    args = parser.parse_args()
    artifact,result = build(args)
    print(json.dumps({'artifact':artifact,'executable_full_tasks':len(result['tasks']),'distinct_full_source_gaps':len(result['full_source_gaps']),
                      'requested_extent':'full_recording','worker_started':False,'downloads':0,'Ready':False},ensure_ascii=False))
