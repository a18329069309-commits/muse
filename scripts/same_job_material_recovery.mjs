import path from 'node:path';
import {access,readdir} from 'node:fs/promises';
import {readJson,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {readAutomaticStageFailure} from './automatic_stage_failure_evidence.mjs';

export const sameJobMaterialRecoveryRevision='same-job-completed-material-recovery-v1';
const fail=reason=>{throw Error('same_job_material_recovery_'+reason);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bound=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const present=async file=>{try{await access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const load=async ref=>{await verifyEvidenceBindings(ref);return readJson(ref.path);};
const within=(file,root)=>{const relative=path.relative(path.resolve(root),path.resolve(file??''));
  return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

// Admission comes from this job's already persisted controller history. No
// search of other episodes, CLI result directories or global caches is allowed.
export async function sameJobMaterialRecoveryCandidates(context,{kind,source,session}){
  if(!context)return{candidates:[],rejections:[],unreconciled_attempts:[]};
  if(context.revision!==sameJobMaterialRecoveryRevision||!['music','sound_query'].includes(kind)
    ||!path.isAbsolute(context.attempt_directory??''))fail('explicit_contract_required');
  const state=await load(context.checkpoint),episodeRoot=path.dirname(context.checkpoint.path);
  const attemptRoot=path.resolve(context.attempt_directory),relative=path.relative(episodeRoot,attemptRoot);
  const match=/^materials[\\/]attempt-([1-9][0-9]*)$/.exec(relative);
  if(path.basename(context.checkpoint.path)!=='automatic-state.json'||!match
    ||state.kind!=='automatic_episode_controller'||state.source?.sha256!==source.sha256
    ||!same(state.source,source)||path.resolve(state.stages?.materials?.directory??'')!==attemptRoot
    ||state.stages.materials.attempt!==Number(match[1]))fail('same_job_source_or_attempt_required');
  const analysis=state.stages.analysis,direction=state.stages.direction;
  if(analysis?.status!=='completed'||direction?.status!=='completed'
    ||!same(analysis.result?.artifact,context.analysis)||!same(direction.result?.direction_binding,context.direction))
    fail('completed_host_story_binding_changed');
  await verifyEvidenceBindings([source,context.analysis,context.direction,analysis.result_binding,direction.result_binding]);
  if(analysis.result_binding&&!same(await load(analysis.result_binding),analysis.result)
    ||direction.result_binding&&!same(await load(direction.result_binding),direction.result))fail('completed_host_story_result_changed');
  if(session?.trialBudget?.identity&&(session.trialBudget.identity.source_video_sha256!==source.sha256
    ||path.resolve(session.trialBudget.identity.output_root??'')!==path.resolve(episodeRoot)))fail('original_budget_scope_required');
  const histories=[...(state.stage_attempt_history??[]).filter(row=>row.stage==='materials'),
    ...(state.material_history??[]).map(row=>row.stages?.materials),
    ...(state.publication_history??[]).map(row=>row.stages?.materials)].filter(Boolean);
  const attempts=new Map();
  for(const row of histories){
    if(!Number.isSafeInteger(row.attempt)||row.attempt<1||row.attempt>=Number(match[1])||!row.directory)continue;
    const expected=path.join(episodeRoot,'materials',`attempt-${row.attempt}`);
    if(path.resolve(row.directory)!==path.resolve(expected))fail('historical_attempt_outside_same_job');
    if(!['failed','completed','waiting'].includes(row.status)||!row.failure_evidence&&!row.result_binding)continue;
    const key=path.resolve(row.directory),old=attempts.get(key);
    if(old&&(!same(old.failure_evidence,row.failure_evidence)||!same(old.result_binding,row.result_binding)))
      fail('conflicting_historical_attempt_bindings');
    attempts.set(key,row);
  }
  if(attempts.size>32)fail('historical_attempt_scope_exceeds_bound');
  const candidates=[],rejections=[],unreconciled=[];
  for(const row of [...attempts.values()].sort((a,b)=>b.attempt-a.attempt)){
    if(row.failure_evidence){
      const failure=await readAutomaticStageFailure(row.failure_evidence,{stage:'materials',source,episodeRoot});
      if(path.resolve(failure.stage_directory)!==path.resolve(row.directory))fail('historical_failure_scope_changed');
    }
    if(row.result_binding){
      const result=await load(row.result_binding);
      if(row.result&&!same(result,row.result)||result.source_video_sha256&&result.source_video_sha256!==source.sha256)
        fail('historical_result_source_or_body_changed');
    }
    const files=[];
    if(kind==='music'){
      for(const limit of [20,50]){
        const file=path.join(row.directory,`selection-${limit}`,'selection-record.json');
        if(await present(file))files.push(file);
      }
    }else{
      const queryRoot=path.join(row.directory,'sounds','query-repair-fields-v1');
      if(!await present(queryRoot))continue;
      const names=(await readdir(queryRoot)).filter(name=>/^batch-status-[a-f0-9]{64}\.json$/.test(name));
      if(names.length>32)fail('historical_query_record_scope_exceeds_bound');
      for(const name of names.sort())files.push(path.join(queryRoot,name));
      const completedRequests=[];
      for(const file of files){const value=await readJson(file);
        if(['query_projection_completed_materials_still_pending','query_projection_recorded_with_explicit_retrieval_gaps'].includes(value.status)){
          const queue=await load(value.queue);
          if(!Array.isArray(queue.requests)||queue.requests.length!==1)fail('historical_query_single_request_required');
          completedRequests.push(queue.requests[0]);
        }}
      if(await present(path.join(queryRoot,'attempt-started.json'))){
        const marker=await readJson(path.join(queryRoot,'attempt-started.json'));
        await verifyEvidenceBindings([marker.request,marker.source]);
        if(marker.source?.sha256!==source.sha256)fail('historical_query_marker_source_changed');
        // The current field contract owns one request. A completed status for
        // a different request cannot reconcile this submitted marker.
        if(!completedRequests.length||!completedRequests.every(request=>same(request,marker.request))){
          const failureFile=path.join(queryRoot,'attempt-failure.json');
          const failure=await present(failureFile)?await readJson(failureFile):null;
          if(!failure||failure.error!=='codex_cli_complete_input_capacity_gap'||failure.cli_receipts?.length)
            unreconciled.push({attempt:row.attempt,directory:queryRoot,attempt_started:await bound(path.join(queryRoot,'attempt-started.json'))});
        }
      }
    }
    for(const file of files){const value=await readJson(file);
      const complete=kind==='music'?value.kind==='independent_pack_material_selection'&&value.actual_asset_selection_performed===true
        :['query_projection_completed_materials_still_pending','query_projection_recorded_with_explicit_retrieval_gaps'].includes(value.status);
      const sha=kind==='music'?value.source_video_sha256:value.source?.sha256;
      if(!complete||sha!==source.sha256){rejections.push({path:file,reason:'historical_child_not_completed_for_current_source'});continue;}
      candidates.push({binding:await bound(file),attempt:row.attempt,stage_evidence:row.failure_evidence??row.result_binding});
    }
  }
  return{candidates,rejections,unreconciled_attempts:unreconciled,checkpoint:context.checkpoint,
    episode_root:episodeRoot,current_attempt_directory:attemptRoot,source_video_sha256:source.sha256,
    new_model_calls:0,qualification_granted:false,old_account_usage_unchanged:true};
}

// The existing complete-chain reader is the authority for schema, tasks,
// candidates, windows, observations, current story and actual terminal usage.
// This layer only adds same-job admission and the current execution profile.
export async function recoverSameJobCompletedMaterial(context,{kind,source,session,runtime={},loadCompleted}){
  const admission=await sameJobMaterialRecoveryCandidates(context,{kind,source,session});
  const attempts=[...admission.rejections];
  const executor=session?.runtime;
  for(const candidate of admission.unreconciled_attempts.length?[]:admission.candidates){
    try{
      const record=await load(candidate.binding);
      const result=kind==='music'?record:await load(record.result);
      const requestBinding=kind==='music'?record.input:(await load(record.queue)).requests[0];
      if(!within(requestBinding?.path,admission.episode_root)||!within(result.raw_response?.path,admission.episode_root))
        throw Error('original_child_provenance_outside_same_job');
      const request=await load(requestBinding);
      const raw=await load(result.raw_response);
      const expected=executor?.expectedStageModelRevision?.(request.stage)
        ??runtime.expectedStageModelRevision?.(request.stage)
        ??(kind==='music'?runtime.materialSelector_model_revision:undefined);
      const backend=executor?.director_backend_id??runtime.materialSelector_backend_id??session?.backend?.backend_id;
      if(!expected||backend!=='codex-cli-chatgpt')throw Error('current_model_profile_unavailable');
      if(raw.model_revision!==expected||raw.backend_id!==backend)throw Error('current_model_profile_changed');
      const recovered=await loadCompleted(candidate.binding);
      return{binding:candidate.binding,recovered,audit:{revision:sameJobMaterialRecoveryRevision,kind,
        checkpoint:context.checkpoint,current_attempt_directory:context.attempt_directory,
        original_completed_child:candidate.binding,original_stage_evidence:candidate.stage_evidence,
        source_video_sha256:source.sha256,current_model_revision:expected,rejections:attempts,
        original_response_tasks_windows_and_usage_preserved:true,new_model_calls:0,new_budget_reservations:0,
        qualification_granted:false,production_approval:false}};
    }catch(error){attempts.push({binding:candidate.binding,reason:error.message});}
  }
  return{binding:null,recovered:null,audit:{revision:sameJobMaterialRecoveryRevision,kind,
    checkpoint:context?.checkpoint??null,rejections:attempts,unreconciled_attempts:admission.unreconciled_attempts,
    new_model_calls:0,new_budget_reservations:0,qualification_granted:false,production_approval:false}};
}
