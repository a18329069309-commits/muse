import {shaBytes} from './audio_api.mjs';
import {encodeBoundedInlineRecords,expandBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';
import {validateDiagnosticSfxSelectionPolicy} from './sfx_diagnostic_selection_policy.mjs';
import {sfxEventFunctionRevision,validateSoundFunctionIntent} from './sfx_event_function.mjs';

export const sfxMaterialSelectionProjectionRevision='sfx_lossless_shared_observations_v1';
export const sfxMaterialPartitionEvidenceRevision='sfx-current-task-evidence-closure-v1';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
const fail=reason=>{throw Error('sfx_material_projection_'+reason);};

// Keep each selected task's complete inline facts. Whole-request observations
// for other tasks remain in its immutable parent, not in every sub-request.
// Historical parts without this explicit marker retain their exact old shape.
export function projectSfxMaterialSelectionPartition(part,{fullInput}={}){
  if(part.sfx_event_function_revision!==sfxEventFunctionRevision
    ||fullInput?.sfx_event_function_revision!==sfxEventFunctionRevision
    ||part.sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision
    ||fullInput.sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision)
    fail('partition_explicit_function_v2_required');
  if(!fullInput.input?.path||!fullInput.input.sha256||!same(part.input,fullInput.input)
    ||!Number.isSafeInteger(part.partition?.item_start)||part.partition.item_start<0
    ||part.partition.total_items!==fullInput.tasks?.length||part.partition.source_order_preserved!==true
    ||!part.tasks?.length||part.partition.item_start+part.tasks.length>fullInput.tasks.length
    ||!same(part.tasks,fullInput.tasks.slice(part.partition.item_start,part.partition.item_start+part.tasks.length)))
    fail('partition_bound_parent_or_tasks_changed');
  const taskCases=new Set(part.tasks.map(task=>task.case_id));
  if(!same(part.case_context??[],(fullInput.case_context??[]).filter(context=>taskCases.has(context.case_id))))
    fail('partition_current_context_changed');
  const tables=expandBoundedInlineRecords(fullInput.shared_sound_evidence_inline);
  const observations=new Set(part.tasks.flatMap(task=>task.candidates.map(candidate=>candidate.sound_observation_ref))),
    contexts=new Set((part.case_context??[]).map(context=>context.sound_context_ref));
  const selectedContexts=tables.contexts.filter(context=>contexts.has(context.id)),
    values=new Set(selectedContexts.flatMap(context=>Object.values(context.field_values??{})));
  if(observations.has(undefined)||contexts.has(undefined)
    ||tables.observations.filter(row=>observations.has(row.id)).length!==observations.size
    ||selectedContexts.length!==contexts.size
    ||tables.contextValues.filter(row=>values.has(row.id)).length!==values.size)
    fail('partition_inline_reference_missing_or_ambiguous');
  const selected={observations:tables.observations.filter(row=>observations.has(row.id)),
    contexts:selectedContexts,contextValues:tables.contextValues.filter(row=>values.has(row.id))};
  const output=structuredClone(part);
  output.shared_sound_evidence_inline=encodeBoundedInlineRecords(selected);
  output.sfx_partition_evidence={revision:sfxMaterialPartitionEvidenceRevision,parent_full_request:fullInput.input,
    parent_inline_evidence_sha256:shaBytes(canonical(fullInput.shared_sound_evidence_inline)),
    selected_tasks_sha256:shaBytes(canonical(part.tasks)),selected_context_sha256:shaBytes(canonical(part.case_context??[])),
    observation_ids:selected.observations.map(row=>row.id),context_ids:selected.contexts.map(row=>row.id),
    context_value_ids:selected.contextValues.map(row=>row.id),
    parent_complete_evidence_unchanged:true,current_task_facts_conditions_or_probabilities_removed:false,
    qualification_granted:false};
  return output;
}

// A versioned comparison representation, not another picture/audio observation.
// It keeps the exact event/condition/PCM/prediction facts inline, once per value.
export function projectSfxMaterialSelectionInput(input){
  if(input.sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision)fail('explicit_revision_required');
  if(!input.input?.path||!input.input.sha256)fail('bound_full_request_required');
  if(!input.completed_target_story?.analysis?.path||!input.completed_target_story.analysis.sha256
    ||!input.completed_target_story.source_video_sha256)fail('completed_target_story_required');
  if(input.source_video_sha256!==input.completed_target_story.source_video_sha256)fail('completed_target_source_changed');
  if(!input.tasks?.length||input.tasks.some(task=>!['sfx','ambience'].includes(task.kind)))fail('sound_tasks_only');
  if(input.sfx_event_function_revision!==undefined){
    if(input.sfx_event_function_revision!==sfxEventFunctionRevision)fail('event_function_revision_invalid');
    for(const task of input.tasks)validateSoundFunctionIntent(task.sound_function_intent,{soundRole:task.sound_role});
  }
  validateDiagnosticSfxSelectionPolicy(input.sfx_diagnostic_selection_policy,input);
  const output=input.sfx_event_function_revision===sfxEventFunctionRevision?JSON.parse(JSON.stringify(input)):structuredClone(input),
    observations=[],contexts=[],contextValues=[],observationIds=new Map(),contextIds=new Map(),contextValueIds=new Map();
  for(const task of output.tasks)for(const candidate of task.candidates){
    if(!candidate.observation||typeof candidate.observation!=='object')fail('actual_observation_required');
    const value={observation:candidate.observation,
      ...(candidate.observation_contexts?{observation_contexts:candidate.observation_contexts}:{}),
      ...(candidate.human_context_review?{human_context_review:candidate.human_context_review}:{})};
    const identity=canonical(value);let id=observationIds.get(identity);
    if(!id){id='sound-observation-'+(observations.length+1);observationIds.set(identity,id);observations.push({id,...value});}
    delete candidate.observation;delete candidate.observation_contexts;delete candidate.human_context_review;
    candidate.sound_observation_ref=id;
  }
  for(const context of output.case_context??[]){
    const identity=canonical(context);let id=contextIds.get(identity);
    if(!id){
      id='sound-context-'+(contexts.length+1);contextIds.set(identity,id);
      const local=structuredClone(context),field_values={};
      for(const field of ['conditions','story_sequence','uncertainties'])if(Object.hasOwn(local,field)){
        const encoded=canonical(local[field]);let valueId=contextValueIds.get(encoded);
        if(!valueId){valueId='context-value-'+(contextValues.length+1);contextValueIds.set(encoded,valueId);contextValues.push({id:valueId,value:local[field]});}
        field_values[field]=valueId;delete local[field];
      }
      contexts.push({id,context:local,field_values});
    }
  }
  output.case_context=(input.case_context??[]).map(context=>({case_id:context.case_id,sound_context_ref:contextIds.get(canonical(context))}));
  output.shared_sound_evidence_inline=encodeBoundedInlineRecords({observations,contexts,contextValues});
  for(const field of ['observation_files','visual_files'])if(Array.isArray(output[field])){
    output[field+'_host_evidence']={json_pointer:'/'+field,count:output[field].length};delete output[field];
  }
  output.frames=[];
  output.completed_visual_frame_bindings={json_pointer:'/frames',count:input.frames?.length??0,
    scope:'already_completed_target_story_and_bound_frames; no_new_image_or_video_observation'};
  output.sfx_projection_proof={revision:sfxMaterialSelectionProjectionRevision,full_request:input.input,
    original_tasks_sha256:shaBytes(canonical(input.tasks)),original_context_sha256:shaBytes(canonical(input.case_context??[])),
    original_frame_bindings_sha256:shaBytes(canonical(input.frames??[])),sound_clocks_and_facts_changed:false,
    qualification_granted:false,actual_images_submitted:0,
    encoding:'shared_sound_evidence_inline expands with shared-inline-record-shapes-v1; sound_observation_ref/context_ref select exact full facts. All probabilities, transients, unknowns and conditions stay inline. Source frames were analyzed previously by completed_target_story, not this comparison.'};
  output.prompt+='\n本次复用 completed_target_story 的实际画面与剧情分析，不再次提交图片；不可声称本次观看或听音。shared_sound_evidence_inline 无损保留每个声音观察、全部概率/瞬态/未知和剧情条件；~ 是 shapes 字段表，~s 是 strings 字面量引用。候选 sound_observation_ref 与 case_context.sound_context_ref 引用其完整事实；context.field_values 把完整条件/剧情序列/未知指向 contextValues，必须一并读取，未删改剧情。文件名仍只是未核线索。保留完整禁用条件，未核声音不得冒充批准。';
  return output;
}

// Used by tests/readers to prove exact expansion against the bound producer.
export function expandSfxMaterialSelectionInput(projected,{hostInput}={}){
  if(projected.sfx_projection_proof?.revision!==sfxMaterialSelectionProjectionRevision||!hostInput)fail('host_input_required');
  const expected=projectSfxMaterialSelectionInput(hostInput);
  if(!same(projected,expected))fail('host_projection_changed');
  const {observations,contexts,contextValues}=expandBoundedInlineRecords(projected.shared_sound_evidence_inline);
  const output=structuredClone(projected),byObservation=new Map(observations.map(row=>[row.id,row])),byValues=new Map(contextValues.map(row=>[row.id,row.value]));
  const byContext=new Map(contexts.map(row=>{
    const context=structuredClone(row.context);
    for(const [field,id]of Object.entries(row.field_values)){if(!byValues.has(id))fail('context_value_reference_invalid');context[field]=structuredClone(byValues.get(id));}
    return [row.id,context];
  }));
  for(const task of output.tasks)for(const candidate of task.candidates){
    const value=byObservation.get(candidate.sound_observation_ref);if(!value)fail('observation_reference_invalid');
    delete candidate.sound_observation_ref;for(const [key,row]of Object.entries(value))if(key!=='id')candidate[key]=structuredClone(row);
  }
  output.case_context=output.case_context.map(row=>{const value=byContext.get(row.sound_context_ref);if(!value||value.case_id!==row.case_id)fail('context_reference_invalid');return structuredClone(value);});
  for(const field of ['observation_files','visual_files','frames','prompt'])if(Object.hasOwn(hostInput,field))output[field]=structuredClone(hostInput[field]);
  for(const field of ['shared_sound_evidence_inline','observation_files_host_evidence','visual_files_host_evidence',
    'completed_visual_frame_bindings','sfx_projection_proof'])delete output[field];
  if(!same(output,hostInput))fail('roundtrip_changed');
  return output;
}
