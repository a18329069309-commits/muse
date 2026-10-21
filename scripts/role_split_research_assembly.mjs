import path from 'node:path';
import {readJson,saveJson,validateSchema,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {assemblySessionEnvelope,actualAssemblyTail,finitePartSchema} from './bounded_research_assembly.mjs';
import {verifyBoundedAssemblyPartExecution} from './bounded_assembly_execution_evidence.mjs';
import {projectRoleSplitAssemblyInputs,mergeRoleSplitAssemblyValues,roleSplitAssemblyRevision} from './role_split_assembly_projection.mjs';
import {gainAt,actionTasksCover} from './music_edit_operation_contract.mjs';
import {assemblyDecisionContractRevision} from './assembly_decision_contract.mjs';
import {motherActionUnits,projectMotherActionGroup,mergeMotherActionValues} from './bounded_mother_action_projection.mjs';
import {boundedActualTailCapacity} from './bounded_assembly_continuation.mjs';
import {compileSoundArcPlan} from './sound_arc_plan.mjs';

const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
const fail=reason=>{throw Error('role_split_assembly_'+reason);};
async function stable(file,value){
  try{return await saveJson(file,value);}catch(error){
    if(error.code!=='EEXIST')throw error;
    if(!same(await readJson(file),value))fail('immutable_record_changed');
    return {path:path.resolve(file),sha256:await hashFile(file)};
  }
}

// This is a division of editing responsibilities, not a new source selector.
// The complete parent remains immutable. Each child has its own actual model
// response, budget, source binding and proof; the host only merges typed fields.
export function preflightRoleSplitAssembly(request,session){
  if(request.data?.assembly_decision_contract_revision===assemblyDecisionContractRevision
    &&(typeof session.inputBudget!=='function'||request.data?.diagnostic_sample)){
    const error=Error('role_split_assembly_capacity_gap');error.capacity_report={status:'capacity_gap',
      reason:'complete_production_estimator_and_episode_scope_required',new_model_calls:0};throw error;
  }
  if(typeof session.inputBudget!=='function'||request.data?.diagnostic_sample)return null;
  if(request.data?.assembly_decision_contract_revision===assemblyDecisionContractRevision)return preflightDecisionRoles(request,session);
  const maximum=session.maxSubmittedInputTokens??16000;
  const parentBudget=session.inputBudget(assemblySessionEnvelope(request,session));
  if((parentBudget.submitted_input_tokens??parentBudget.estimated_tokens)<=maximum)return null;
  const projected=projectRoleSplitAssemblyInputs(request);
  const parts=projected.parts.map(part=>({...part,budget:session.inputBudget(assemblySessionEnvelope(part.input,session))}));
  const soundContextReserve=640;
  if(parts.some(part=>(part.budget.submitted_input_tokens??part.budget.estimated_tokens)
    +(part.role==='sounds'?soundContextReserve:0)>maximum))return null;
  if(session.runtime?.stageRepairCap?.(request.stage)!==0)fail('zero_implicit_repair_policy_required');
  return {...projected,parts,parent_budget:parentBudget,max_input_tokens:maximum,
    maximum_new_calls:parts.length,reserved_actual_music_context_tokens:soundContextReserve,implicit_repair_calls:0,new_model_calls:0};
}

const tokens=budget=>budget.submitted_input_tokens??budget.estimated_tokens;
function soundContextBound(request,musicParts){
 const number='9'.repeat(25),selected=new Set(request.data.candidates.sounds.map(row=>row.event_id));
 return {actual_music_responses:Array.from({length:musicParts},(_,i)=>({path:'D:/host-bound-actual-music-response/'+i,sha256:'f'.repeat(64)})),
  scope:'authored_nominal_gain_at_coarse_event_start; not post-duck PCM or hearing',rows:request.data.analysis.sound_events.filter(e=>selected.has(e.id)).map(event=>({
   event_id:event.id,target_seconds:number,source_sha256:'f'.repeat(64),nominal_gain_db:number,dialogue_ducking_db:number}))};
}
function preflightDecisionRoles(request,session){
 if(session.runtime?.stageRepairCap?.(request.stage)!==0)fail('zero_implicit_repair_policy_required');
 const maximum=session.maxSubmittedInputTokens??16000,units=motherActionUnits(request),evaluated=[];
 const assess=projection=>{
  const musicParts=projection.parts.filter(p=>p.role==='music').length;
  const parts=projection.parts.map(part=>{
   const input=structuredClone(part.input),group=part.audit.parent_projection;
   let reserved_previous_tail_tokens=0,continuation_capacity=null,sound_context_bound=null;
   if(part.role==='music'&&group.action_start){
    const original=projectMotherActionGroup(request,group.action_start,group.action_end);
    continuation_capacity=boundedActualTailCapacity(original.input,{originalActionCount:units.actions.length});
    reserved_previous_tail_tokens=continuation_capacity.reserved_input_tokens;
   }
   if(part.role==='sounds'){sound_context_bound=soundContextBound(request,musicParts);input.data.actual_music_context=sound_context_bound;}
   const budget=session.inputBudget(assemblySessionEnvelope(input,session));
   if(!Number.isFinite(tokens(budget))||tokens(budget)<=0)fail('complete_input_budget_required');
   return {...part,budget,reserved_previous_tail_tokens,continuation_capacity,sound_context_bound,
    complete_reserved_input_tokens:tokens(budget)+reserved_previous_tail_tokens};
  });
  evaluated.push({music_action_groups:projection.music_action_groups??[[0,units.actions.length]],
   parts:parts.map(p=>({role:p.role,target_range:p.audit.parent_projection.target_range,
    complete_reserved_input_tokens:p.complete_reserved_input_tokens,reserved_previous_tail_tokens:p.reserved_previous_tail_tokens}))});
  if(parts.some(p=>p.complete_reserved_input_tokens>maximum))return null;
  return {...projection,parts,parent_budget:session.inputBudget(assemblySessionEnvelope(request,session)),max_input_tokens:maximum,
   maximum_new_calls:parts.length,implicit_repair_calls:0,new_model_calls:0,full_actual_tail_capacity_reserved:true,
   sound_context_bound_in_complete_envelope:true};
 };
 const whole=assess(projectRoleSplitAssemblyInputs(request));if(whole)return whole;
 for(let split=units.actions.length-1;split>0;split--){
  if(!units.legal_boundary(units.actions[split].target_range[0]))continue;
  const result=assess(projectRoleSplitAssemblyInputs(request,{musicActionGroups:[[0,split],[split,units.actions.length]]}));
  if(result)return result;
 }
 const error=Error('role_split_assembly_capacity_gap');
 error.capacity_report={revision:assemblyDecisionContractRevision,status:'capacity_gap',maximum_new_calls:3,
  max_input_tokens:maximum,evaluated_groups:evaluated,new_model_calls:0,production_approval:false};throw error;
}

// Numeric context from the actual first editor, not an unheard sound claim or
// a suggested alternative song. It lets the second editor consider competition.
export function actualMusicAtSelectedSoundAnchors(request,response){
  const value=response.value,ids=new Set((request.data.candidates.sounds??[]).map(row=>row.event_id));
  return {actual_music_response:response.raw_response,scope:'authored_nominal_gain_at_coarse_event_start; not post-duck PCM or hearing',
    rows:request.data.analysis.sound_events.filter(event=>ids.has(event.id)).map(event=>{
      const time=event.start_seconds,owners=value.plan.arcs.flatMap(arc=>arc.pieces.filter(piece=>piece.target_range[0]<=time&&time<piece.target_range[1])
        .map(piece=>({arc,piece})));
      if(owners.length!==1)fail('actual_music_anchor_unique_piece_required');
      const {arc,piece}=owners[0],task=`${arc.cue_id}/arc/${arc.arc_id}/${piece.piece_id}`,
        edits=value.edits.music_edits.filter(row=>row.music_task_cue_id===task);
      if(piece.source_window===null)return {event_id:event.id,target_seconds:time,source_sha256:null,
        nominal_gain_db:null,dialogue_ducking_db:value.edits.dialogue_ducking_db};
      if(edits.length!==1)fail('actual_music_anchor_unique_edit_required');
      return {event_id:event.id,target_seconds:time,source_sha256:piece.source_window?.source_sha256??null,
        nominal_gain_db:edits[0].gain_db+(edits[0].gain_envelope?gainAt(edits[0].gain_envelope,time-piece.target_range[0]):0),
        dialogue_ducking_db:value.edits.dialogue_ducking_db};
    })};
}

function mergedMusicRoles(responses,request,{complete=true}={}){
 return mergeMotherActionValues(responses.filter(r=>r.role==='music').map(r=>({...r,
  mother_action_partition:r.audit.parent_projection,value:{...r.value,edits:{...r.value.edits,sounds:[]}}})),
  {...request,schema:finitePartSchema(request.schema)},{complete});
}
// Validate the real prefix, including its actual preceding source and complete
// curve, before authorizing the next account request. Scope aliases never
// create a new cue or permit a neighboring group's actions to be edited.
function validateDecisionMusicRole(response,part,previous,request){
 const all=[...previous,{...response,role:'music',audit:part.audit}],merged=mergedMusicRoles(all,request,{complete:false});
 const compiled=compileSoundArcPlan({plan:merged.value.plan,director:merged.director,
  candidates:request.data.candidates.music,wordsCandidates:request.data.candidates.words});
 const owned=part.audit.parent_projection.owned_action_ids,actual=response.value.edits.action_responses;
 if(actual.length!==owned.length||new Set(actual.map(a=>a.action_id)).size!==owned.length||actual.some(a=>!owned.includes(a.action_id)))fail('action_ownership_changed');
 const restored=merged.value.edits.action_responses.slice(-actual.length);
 for(const actionResponse of restored){const action=request.data.director.music_actions.find(a=>a.id===actionResponse.action_id);
  if(!actionTasksCover(actionResponse,action,compiled.splitCues.flatMap(c=>[c,...(c.words_target_range?[{cue_id:c.cue_id+'/words',target_range:c.words_target_range}]:[])]),2))fail('complete_action_task_coverage_required');}
 const pieceIds=new Set(response.value.plan.arcs.flatMap(a=>a.pieces.map(p=>p.piece_id)));
 const expected=compiled.splitCues.filter(c=>pieceIds.has(c.piece_id)).flatMap(c=>[c.cue_id,...(c.words_target_range?[c.cue_id+'/words']:[])]);
 const edits=merged.value.edits.music_edits.slice(-response.value.edits.music_edits.length).map(e=>e.music_task_cue_id);
 if(expected.length!==edits.length||new Set(edits).size!==edits.length||edits.some(id=>!expected.includes(id)))fail('exact_owned_piece_edits_required');
 return merged;
}

export async function executeRoleSplitResearchAssembly({request,requestBinding,session,directory,validateFinal}){
  const prepared=preflightRoleSplitAssembly(request,session);
  if(!prepared)return null;
  const available=session.trialBudget?await session.trialBudget.inspect({budget:{submitted_input_tokens:0,
    scope:'role_split_whole_assembly_preflight_only'}}):{remaining_requests:prepared.parts.length};
  if(available.remaining_requests<prepared.parts.length)fail('whole_remaining_request_budget_insufficient');
  if(available.remaining_ms!==undefined&&(!Number.isFinite(available.remaining_ms)||available.remaining_ms<=0))
    fail('whole_remaining_activity_budget_insufficient');
  const phase=request.call_plan_phase??'assembly';
  if(typeof session.trialBudget?.inspectPhasePlan==='function')await session.trialBudget.inspectPhasePlan({
    phase,requests:prepared.parts.length,capacityChecks:prepared.parts.map((part,index)=>({
      stage:part.input.stage,phase,request_index:index,submitted_input_tokens:part.complete_reserved_input_tokens??tokens(part.budget)}))});
  await verifyEvidenceBindings(requestBinding);
  if(!same(await readJson(requestBinding.path),request))fail('complete_parent_changed');
  const preflight=await stable(path.join(directory,'preflight.json'),{...prepared,original_request:requestBinding,
    available_requests_before_submission:available.remaining_requests,remaining_ms_before_submission:available.remaining_ms??null});
  const responses=[],parts=[];
  const decisions=request.data.assembly_decision_contract_revision===assemblyDecisionContractRevision;
  for(const [index,part]of prepared.parts.entries()){
    const actualInput=structuredClone(part.input);
    actualInput.call_plan_phase=phase;
    if(decisions&&part.role==='music'&&responses.some(r=>r.role==='music')){
      const previous=responses.findLast(r=>r.role==='music');
      actualInput.data.actual_previous_assembly_tail=actualAssemblyTail(previous.value,previous.raw_response,request);
      actualInput.schema.properties.edits.properties.dialogue_ducking_db.enum=[previous.value.edits.dialogue_ducking_db];
    }
    if(part.role==='sounds'){
      const music=responses.find(row=>row.role==='music');if(!music)fail('actual_music_before_sound_required');
      if(decisions){const merged=mergedMusicRoles(responses,request),context=actualMusicAtSelectedSoundAnchors(request,{value:merged.value,raw_response:null});
        delete context.actual_music_response;context.actual_music_responses=responses.filter(r=>r.role==='music').map(r=>r.raw_response);
        actualInput.data.actual_music_context=context;
      }else actualInput.data.actual_music_context=actualMusicAtSelectedSoundAnchors(request,music);
    }
    const actualBudget=session.inputBudget(assemblySessionEnvelope(actualInput,session));
    if((actualBudget.submitted_input_tokens??actualBudget.estimated_tokens)>prepared.max_input_tokens)
      fail('actual_music_context_exceeds_complete_capacity');
    const input=await stable(path.join(directory,`role-${index+1}-${part.role}`,'input.json'),actualInput);
    const response=typeof session.director==='function'?await session.director(actualInput):await session.request(actualInput.stage,actualInput);
    const execution=await verifyBoundedAssemblyPartExecution(response,{input:actualInput,session});
    validateSchema(response.value,actualInput.schema);
    if(decisions&&part.role==='music')validateDecisionMusicRole(response,part,responses,request);
    parts.push(await stable(path.join(directory,`role-${index+1}-${part.role}`,'completed.json'),{
      role:part.role,input,raw_response:response.raw_response,budget:actualBudget,execution,
      source_video_sha256:request.data.source_video_sha256,actual_audio_hearing_approved:false,production_approval:false}));
    responses.push({...response,role:part.role,audit:part.audit});
  }
  const value=mergeRoleSplitAssemblyValues(responses,request);
  validateSchema(value,request.schema);
  if(!value.execution_gaps.length)await validateFinal(value);
  const raw={schema_version:1,kind:'role_split_research_assembly_result',revision:roleSplitAssemblyRevision,
    execution_kind:'host_role_split_assembly_merge',source_video_sha256:request.data.source_video_sha256,
    input_sha256:requestBinding.sha256,original_request:requestBinding,preflight,parts,
    constituent_responses:responses.map(row=>row.raw_response),value,completion_status:'complete',
    actual_model_parts_executed:true,actual_runtime_executed:false,actual_input_processed:true,
    actual_audio_processed:false,actual_video_processed:false,qualified:false,artistic_approval:false,production_approval:false,
    usage:null,usage_is_in_constituent_receipts:true,new_account_call_not_created_by_merge:true};
  const rawResponse=await stable(path.join(directory,'merged-response.json'),raw);
  return {...raw,raw_response:rawResponse,role_split_assembly:{preflight,parts},
    cli_receipts:responses.flatMap(row=>row.cli_receipts??[]),
    historical_cli_receipts:responses.flatMap(row=>row.historical_cli_receipts??[])};
}
