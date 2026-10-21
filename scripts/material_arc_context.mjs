import {readJson,verifyEvidenceBindings,verifyLocalAudioExecution} from './audio_api.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const range=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&value[0]>=0&&value[1]>value[0];
const bound=value=>typeof value?.path==='string'&&/^[a-f0-9]{64}$/.test(value.sha256??'');

// Candidate continuity is an option, never a claim that the prior cue was rendered.
export async function attachPrecedingArcContext(input,{handoff,currentCase}){
  if(!bound(handoff)||!bound(currentCase))throw new Error('preceding_arc_evidence_binding_required');
  await verifyEvidenceBindings([handoff,currentCase]);
  const prior=await readJson(handoff.path),current=await readJson(currentCase.path);
  if(!bound(prior.bound_materials)||!bound(prior.selection)||!bound(prior.case_input)||!prior.selected_count)
    throw new Error('preceding_arc_has_no_actual_binding');
  await verifyEvidenceBindings([prior.bound_materials,prior.selection,prior.case_input]);
  const preceding=await readJson(prior.case_input.path),bindings=await readJson(prior.bound_materials.path),selection=await readJson(prior.selection.path);
  const cases=input.case_context??[],target=current.cases.find(row=>cases.some(item=>item.case_id===row.case_id));
  const previous=preceding.cases.find(row=>row.source_range[0]===prior.target_range[0]&&row.source_range[1]===prior.target_range[1]);
  if(!target||!previous||target.episode_id!==previous.episode_id||!target.evidence?.source_video_sha256
    ||target.evidence.source_video_sha256!==previous.evidence?.source_video_sha256)
    throw new Error('preceding_arc_wrong_source_or_case');
  if(Math.abs(prior.target_range[1]-target.source_range[0])>1/16000)
    throw new Error('preceding_arc_not_adjacent');
  if(selection.automatic_selection_performed!==true||!bound(selection.raw_response)||!bound(selection.input)||!bound(selection.bindings_file)
    ||selection.case_source?.sha256!==prior.case_input.sha256
    ||prior.selected_bindings&&prior.selected_bindings.sha256!==selection.bindings_file.sha256)
    throw new Error('preceding_arc_actual_selection_required');
  await verifyEvidenceBindings([selection.raw_response,selection.input,selection.bindings_file]);
  const raw=await readJson(selection.raw_response.path),request=await readJson(selection.input.path),selected=await readJson(selection.bindings_file.path);
  if(raw.actual_input_processed!==true||raw.actual_runtime_executed!==true||raw.completion_status!=='complete'
    ||raw.input_sha256!==selection.input.sha256||request.case_source?.sha256!==prior.case_input.sha256
    ||selected.case_source?.sha256!==prior.case_input.sha256||selected.input?.sha256!==selection.input.sha256
    ||selected.raw_response?.sha256!==selection.raw_response.sha256||!Array.isArray(raw.value?.decisions))
    throw new Error('preceding_arc_actual_selection_required');
  const selectedCase=selected.bindings?.find(row=>row.case_id===previous.case_id);
  if(selectedCase?.source_video_sha256!==target.evidence.source_video_sha256
    ||!same(selectedCase.case_source_range,prior.target_range))throw new Error('preceding_arc_selection_identity_mismatch');
  const selectedIds=raw.value.decisions.filter(row=>row.case_id===previous.case_id&&row.kind==='music')
    .flatMap(row=>(row.selected_segment_ids??[]).map(id=>JSON.stringify([row.step_id,id])));
  const alternatives=[],seen=new Set();
  for(const pack of bindings.packs??[])for(const window of pack.windows??[]){
    const expected=prior.alternatives?.find(row=>row.asset_id===pack.asset_id&&row.segment_id===window.segment_id
      &&row.source_sha256===pack.source_sha256&&same(row.source_range,window.source_range));
    if(!expected||!bound(window.listening_evidence?.observation_record))throw new Error('preceding_arc_binding_mismatch');
    await verifyEvidenceBindings([window.listening_evidence.observation_record]);
    const observed=await readJson(window.listening_evidence.observation_record.path);
    if(observed.actual_audio_processed!==true||observed.completion_status!=='complete'
      ||observed.source_sha256!==pack.source_sha256||!range(window.source_range)||!same(observed.source_range,window.source_range)
      ||expected.observation_record?.sha256!==window.listening_evidence.observation_record.sha256)
      throw new Error('preceding_arc_observation_identity_mismatch');
    await verifyEvidenceBindings(observed);
    if(observed.protocol==='local_audio_model')await verifyLocalAudioExecution(observed,observed);
    const chosen=selectedCase.music?.find(row=>row.segment_id===window.segment_id&&row.asset_id===pack.asset_id
      &&row.source_sha256===pack.source_sha256&&same(row.source_range,window.source_range)
      &&row.pack_id===pack.pack_id&&row.window_id===window.window_id
      &&row.listening_evidence?.observation_record?.sha256===window.listening_evidence.observation_record.sha256);
    const decision=raw.value.decisions.find(row=>row.case_id===previous.case_id&&row.step_id===chosen?.step_id
      &&row.kind==='music'&&row.selected_segment_ids?.includes(window.segment_id));
    const task=request.tasks?.find(row=>row.case_id===previous.case_id&&row.step_id===chosen?.step_id&&row.kind==='music');
    const boundCase=bindings.cases?.find(row=>row.case_id===previous.case_id);
    const step=boundCase?.development_preset?.steps?.find(row=>row.step_id===chosen?.step_id);
    const identity=JSON.stringify([pack.asset_id,window.segment_id,pack.source_sha256,window.source_range]);
    if(!chosen||!decision||!task?.candidates?.some(row=>row.segment_id===window.segment_id&&row.asset_id===pack.asset_id
      &&row.source_sha256===pack.source_sha256&&same(row.source_range,window.source_range))
      ||!boundCase?.music_pack_ids?.includes(pack.pack_id)||!step?.window_refs?.some(row=>row.pack_id===pack.pack_id&&row.window_id===window.window_id)
      ||seen.has(identity))throw new Error('preceding_arc_selection_identity_mismatch');
    seen.add(identity);
    alternatives.push({asset_id:pack.asset_id,segment_id:window.segment_id,source_sha256:pack.source_sha256,
      source_range:window.source_range,observation_record:window.listening_evidence.observation_record,
      next_contiguous_source_start:window.source_range[1],qualification:'unqualified_research_alternative'});
  }
  if(alternatives.length!==selection.selected_count||alternatives.length!==prior.selected_count
    ||alternatives.length!==selectedCase.music?.length||alternatives.length!==prior.alternatives?.length
    ||alternatives.length!==selectedIds.length||new Set(selectedIds).size!==selectedIds.length)
    throw new Error('preceding_arc_selection_count_mismatch');
  return {...input,preceding_arc_context:{revision:'actual_predecessor_binding_v1',handoff,current_case:currentCase,
    case_input:prior.case_input,selection:prior.selection,bound_materials:prior.bound_materials,
    selection_input:selection.input,selection_raw_response:selection.raw_response,selected_bindings:selection.bindings_file,
    preceding_case_id:previous.case_id,current_case_id:target.case_id,source_video_sha256:target.evidence.source_video_sha256,
    preceding_target_range:prior.target_range,current_target_range:target.source_range,alternatives,
    final_rendered_music_choice_known:false,continuity_instruction:'Compare observed contiguous same-recording windows against replacements. Preserve unresolved danger. Adjacency and source identity do not prove a phrase, suitable development, lyrics, or artistic approval.',
    qualified:false,artistic_approval:false,production_approval:false}};
}

export function nextContiguousSourceRange(previousRange,targetRange,recordingDuration){
  if(![...previousRange,...targetRange,recordingDuration].every(Number.isFinite)
    ||previousRange[0]<0||previousRange[1]<=previousRange[0]||targetRange[1]<=targetRange[0])
    throw new Error('continuity_invalid_range');
  const range=[previousRange[1],previousRange[1]+targetRange[1]-targetRange[0]];
  if(range[1]>recordingDuration+1/16000)throw new Error('continuity_recording_too_short');
  return range;
}
