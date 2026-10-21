import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { objectSchema, readJson, validateSchema, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { directionSemanticGaps } from './direction_semantics.mjs';
import { typedStyleExpandedProviderSchema, typedStyleProviderSchema } from './typed_bounded_style_director.mjs';
export const nativeRouteAnchorRepairStage='research_style_route_anchors_v1';
export const nativeRouteAnchorRepairRevision='completed-native-route-anchor-repair-v1';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b), fail=why=>{throw Error('native_route_recovery_'+why);};

export async function loadCompletedNativeRoute(binding) {
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
  if(raw.execution_kind!=='codex_cli_inference'||raw.completion_status!=='complete'||raw.actual_runtime_executed!==true
    ||raw.actual_input_processed!==true||raw.qualified!==false||raw.artistic_approval!==false||raw.production_approval!==false
    ||raw.backend_id!=='codex-cli-chatgpt'||raw.actual_audio_processed!==false||raw.actual_video_processed!==false
    ||raw.actual_frames_submitted!==0||!same(raw.scopes,[])||!raw.restoration)fail('completed_unadopted_route_required');
  await verifyEvidenceBindings(raw.evidence_files);await verifyEvidenceBindings(raw.restoration);
  const restoration=await readJson(raw.restoration.path);
  if(restoration.native_completed_owned_timeout!==true||restoration.route_adoption_allowed!==false
    ||restoration.cli_invocations!==0||restoration.original_outcome_state_unchanged!==true||restoration.original_timeout_receipt_unchanged!==true
    ||restoration.semantic_validation_revision!=='typed-native-completed-route-preserved-unaccepted-v1')fail('explicit_native_terminal_restoration_required');
  await verifyEvidenceBindings([restoration.original_state,restoration.original_request,restoration.original_attempt,restoration.process_exit_evidence]);
  const payload=await readJson(restoration.original_request.path),receipt=await readJson(restoration.original_attempt.path),state=await readJson(restoration.original_state.path);
  if(payload.input?.stage!=='research_style_route_v1'||shaBytes(canonical(payload))!==raw.request_sha256
    ||receipt.request_sha256!==raw.request_sha256||receipt.request?.sha256!==restoration.original_request.sha256
    ||receipt.model_revision!==payload.model_revision||raw.model_revision!==payload.model_revision
    ||receipt.status!=='timeout'||receipt.timed_out!==true||receipt.process_terminated!==true||state.status!=='timeout'
    ||state.request_sha256!==raw.request_sha256||payload.source_video_sha256!==raw.source_video_sha256
    ||payload.input.data?.source_video_sha256!==raw.source_video_sha256)fail('original_route_identity_changed');
  await verifyEvidenceBindings([receipt.schema,receipt.jsonl,receipt.prompt,...payload.input_bindings]);
  const events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const{baseStructuredEvidencePrompt,completedCliEventsValid}=await import('./codex_cli_runtime.mjs');
  if(!completedCliEventsValid(events))fail('actual_completed_event_required');
  const value=JSON.parse(events.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null');
  const{projectTypedStyleModelInput}=await import('./typed_bounded_style_director.mjs');
  if(await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projectTypedStyleModelInput(payload.input).input))fail('original_route_prompt_changed');
  validateSchema(value,typedStyleExpandedProviderSchema(payload.input.schema));
  const usage={reported_turns:1,tokens:events.find(row=>row.type==='turn.completed').usage,source:'cli_turn_completed_events'};
  if(!same(receipt.usage,usage)||!same(raw.usage,usage))fail('original_native_usage_changed');
  if(receipt.final){
    await verifyEvidenceBindings([restoration.original_final,receipt.final]);
    if(!same(receipt.final,restoration.original_final)||!same(value,await readJson(receipt.final.path))
      ||restoration.original_final_absent===true||restoration.reconstructed_from_terminal_event===true)fail('original_native_final_changed');
  }else{
    if(restoration.original_final!==null||restoration.original_final_absent!==true
      ||restoration.reconstructed_from_terminal_event!==true||!restoration.reconstructed_final
      ||!same(restoration.verified_terminal_usage,usage))fail('missing_native_final_reconstruction_required');
    await verifyEvidenceBindings(restoration.reconstructed_final);
    if(!same(value,await readJson(restoration.reconstructed_final.path))
      ||path.dirname(restoration.reconstructed_final.path)!==path.dirname(raw.restoration.path)
      ||path.resolve(path.dirname(raw.restoration.path))===path.resolve(path.dirname(restoration.original_request.path)))fail('reconstructed_native_final_changed');
    for(const file of [path.join(path.dirname(restoration.original_attempt.path),'final.json'),
      path.join(path.dirname(restoration.original_state.path),`attempt-${receipt.attempt??1}`,'final.json')]){
      try{await readFile(file);fail('unbound_original_final_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  if(!same(value,raw.value)||!same(await readJson(receipt.schema.path),typedStyleProviderSchema(payload.input.schema)))fail('original_native_value_changed');
  await verifyEvidenceBindings(payload.input.data.full_direction_request);
  const full=await readJson(payload.input.data.full_direction_request.path);
  return {binding,raw,payload,receipt,restoration,full};
}

export async function prepareNativeRouteAnchorRepair(binding) {
  const original=await loadCompletedNativeRoute(binding),value=original.raw.value,analysis=original.full.data.analysis;
  const gaps=directionSemanticGaps(value,analysis),cues=value.cues.filter(cue=>gaps.includes('words_opportunity_outside_story:'+cue.cue_id));
  if(!gaps.length||gaps.length!==cues.length||gaps.some(gap=>!gap.startsWith('words_opportunity_outside_story:')))fail('only_word_anchor_gaps_may_be_repaired');
  const ids=analysis.story_beats.map(beat=>beat.id);
  const schema=objectSchema({fixes:{type:'array',minItems:cues.length,maxItems:cues.length,items:objectSchema({cue_id:{type:'string',enum:cues.map(cue=>cue.cue_id)},
    anchor_event_ids:{type:'array',minItems:1,items:{type:'string',enum:ids}},basis:{type:'array',minItems:1,items:objectSchema({story_beat_id:{type:'string',enum:ids},reason:{type:'string'}})}})}});
  const input={stage:nativeRouteAnchorRepairStage,schema,frames:[],prompt:'Repair ONLY the listed words_opportunity.anchor_event_ids of this actual completed, unadopted route. '
    +'Return real story_beat IDs and a brief basis; sound_event IDs are invalid. Preserve all music, ranges, lyrics intervals and other decisions exactly. '
    +'Choose IDs grounded in the corresponding current cue and actual story. No source selection, lyric facts, hearing or adoption approval is allowed.',
    data:{source_video_sha256:original.raw.source_video_sha256,frozen_native_route:binding,actual_story_beats:analysis.story_beats,
      affected_cues:cues.map(cue=>({cue_id:cue.cue_id,target_range:cue.target_range,story_beat_ids:cue.story_beat_ids,
        function:cue.function,sound_goal:cue.sound_goal,words_function:cue.words_function,words_opportunity:cue.words_opportunity})),
      actual_audio_listened:false,production_approval:false}};
  return {original,input,cues,analysis};
}
export function mergeNativeRouteAnchorRepair(prepared,patch) {
  validateSchema(patch,prepared.input.schema);
  if(new Set(patch.fixes.map(row=>row.cue_id)).size!==prepared.cues.length)fail('exact_affected_cues_required');
  const value=structuredClone(prepared.original.raw.value);
  for(const fix of patch.fixes){const cue=value.cues.find(row=>row.cue_id===fix.cue_id);
    if(fix.anchor_event_ids.some(id=>!cue.story_beat_ids.includes(id))||!fix.basis.length||fix.basis.some(row=>!cue.story_beat_ids.includes(row.story_beat_id)||!row.reason.trim()))fail('anchor_basis_outside_current_cue');
    cue.words_opportunity.anchor_event_ids=fix.anchor_event_ids;}
  validateSchema(value,prepared.original.payload.input.schema);
  if(directionSemanticGaps(value,prepared.analysis).length)fail('repaired_route_semantics_invalid');
  return value;
}
export async function loadNativeRouteAnchorRecovery(binding,{input=null,validateRoute=null,expectedModelRevision=null}={}) {
  await verifyEvidenceBindings(binding);const candidate=await readJson(binding.path);
  if(candidate.host_single_cue_boundary_normalization){const{loadNativeSingleCueBoundaryNormalization}=await import('./native_route_boundary_recovery.mjs');
    return loadNativeSingleCueBoundaryNormalization(binding,{input,validateRoute,expectedModelRevision});}
  if(candidate.host_completed_native_route_reuse||candidate.execution_kind==='codex_cli_inference'
    &&candidate.completion_status==='complete'&&!candidate.restoration&&!candidate.host_route_anchor_merge&&!candidate.host_boundary_merge){
    const{loadCompletedTypedRouteRecovery}=await import('./completed_typed_route_recovery.mjs');
    return loadCompletedTypedRouteRecovery(binding,{input,validateRoute,expectedModelRevision});}
  if(candidate.host_boundary_merge){const{loadNativeRouteBoundaryRecovery}=await import('./native_route_boundary_recovery.mjs');
    return loadNativeRouteBoundaryRecovery(binding,{input,validateRoute,expectedModelRevision});}
  if(candidate.restoration&&!candidate.host_route_anchor_merge){
    const original=await loadCompletedNativeRoute(binding);
    const{compareCompletedTypedRouteIntents}=await import('./completed_typed_route_recovery.mjs');
    const{expandTypedStyleLiterals,expandTypedStyleTables,validateTypedStyleRoutePolicy}=await import('./typed_bounded_style_director.mjs');
    if(!input||expectedModelRevision&&original.raw.model_revision!==expectedModelRevision)fail('current_native_route_identity_required');
    await compareCompletedTypedRouteIntents(original.payload.input,input);
    const analysis=expandTypedStyleTables(expandTypedStyleLiterals(original.payload.input)).data.analysis;
    if(directionSemanticGaps(original.raw.value,analysis).length)fail('restored_route_semantics_invalid');
    validateTypedStyleRoutePolicy(original.raw.value,{route:input,analysis});
    await validateRoute?.(original.raw.value);
    return{...original.raw,raw_response:binding,reused:true,cli_receipts:[],historical_cli_receipts:original.raw.historical_cli_receipts,new_model_calls:0};
  }
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path),merge=raw.host_route_anchor_merge;
  if(merge?.revision!==nativeRouteAnchorRepairRevision||raw.production_approval!==false||raw.qualified!==false)fail('explicit_anchor_merge_required');
  const prepared=await prepareNativeRouteAnchorRepair(merge.original_completed_route);
  await verifyEvidenceBindings(merge.patch_response);const patch=await readJson(merge.patch_response.path);
  if(patch.execution_kind!=='codex_cli_inference'||patch.actual_runtime_executed!==true||patch.completion_status!=='complete'
    ||patch.source_video_sha256!==raw.source_video_sha256||patch.model_revision!==raw.model_revision
    ||patch.qualified!==false||patch.production_approval!==false||patch.cli_receipts?.length!==1)fail('actual_patch_required');
  await verifyEvidenceBindings(patch.evidence_files);await verifyEvidenceBindings(patch.cli_receipts);
  const request=patch.evidence_files.find(row=>path.resolve(row.path)===path.join(path.dirname(merge.patch_response.path),'request.json'));
  if(!request)fail('patch_request_required');const document=await readJson(request.path),receipt=await readJson(patch.cli_receipts[0].path);
  if(!same(document.input,prepared.input)||shaBytes(canonical(document))!==patch.request_sha256||receipt.status!=='complete'
    ||receipt.cli_invocations!==1||receipt.timed_out!==false||receipt.exit_code!==0&&!receipt.completed_turn_cleanup)fail('patch_intent_or_execution_changed');
  await verifyEvidenceBindings([receipt.final,receipt.schema,receipt.prompt,receipt.jsonl]);
  const {baseStructuredEvidencePrompt,validateCompletedTurnCleanup}=await import('./codex_cli_runtime.mjs');
  const promptInput=structuredClone(document.input);delete promptInput.schema;delete promptInput.response_schema;
  if(await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',promptInput))fail('patch_stdin_changed');
  const events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse),turns=events.filter(row=>row.type==='turn.completed');
  const message=JSON.parse(events.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null');
  if(turns.length!==1||events.some(row=>['turn.failed','error'].includes(row.type))||!same(message,patch.value)
    ||receipt.usage?.reported_turns!==1||receipt.usage?.tokens?.input_tokens!==turns[0].usage?.input_tokens
    ||receipt.usage?.tokens?.output_tokens!==turns[0].usage?.output_tokens||!same(receipt.usage,patch.usage))fail('actual_patch_model_event_changed');
  if(receipt.completed_turn_cleanup)validateCompletedTurnCleanup(receipt.completed_turn_cleanup,{events,
    finalBytes:await readFile(receipt.final.path),schema:typedStyleExpandedProviderSchema(prepared.input.schema)});
  if(!same(await readJson(receipt.final.path),patch.value)||!same(await readJson(receipt.schema.path),typedStyleProviderSchema(prepared.input.schema)))fail('patch_final_changed');
  const value=mergeNativeRouteAnchorRepair(prepared,patch.value);
  if(!same(value,raw.value)||raw.source_video_sha256!==prepared.original.raw.source_video_sha256
    ||expectedModelRevision&&raw.model_revision!==expectedModelRevision)fail('restored_route_changed');
  if(input){const comparable=source=>{source=structuredClone(source);delete source.data.full_direction_request;delete source.data.typed_parent_input_sha256;return source;};
    if(!same(comparable(input),comparable(prepared.original.payload.input)))fail('current_native_route_intent_changed');}
  await validateRoute?.(value);
  return {...raw,raw_response:binding,reused:true,cli_receipts:[],historical_cli_receipts:raw.historical_cli_receipts,new_model_calls:0};
}
