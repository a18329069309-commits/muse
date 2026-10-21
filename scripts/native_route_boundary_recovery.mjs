import path from'node:path';import{readFile}from'node:fs/promises';
import{readJson,objectSchema,validateSchema,verifyEvidenceBindings,shaBytes}from'./audio_api.mjs';
import{typedStyleProviderSchema,typedStyleExpandedProviderSchema,projectTypedStyleModelInput}from'./typed_bounded_style_director.mjs';
import{projectCompactBusinessContract}from'./compact_business_contract.mjs';
import{directionSemanticGaps}from'./direction_semantics.mjs';
import{validateCaseEventAnchors}from'./compose_episode.mjs';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('native_boundary_recovery_'+reason);};
export const nativeBoundaryRepairStage='research_style_boundary_fields_v1';
export const nativeBoundaryRepairRevision='actual-native-boundary-fields-only-v1';
export const singleCueBoundaryNormalizationRevision='source-bound-single-cue-boundary-host-normalization-v1';
export async function loadUnadoptedNativeBoundaryRoute(binding){
 await verifyEvidenceBindings(binding);const spec=await readJson(binding.path);
 if(spec.kind!=='actual_native_route_boundary_repair_input')fail('explicit_bound_input_required');
 await verifyEvidenceBindings([spec.request,spec.receipt]);const request=await readJson(spec.request.path),receipt=await readJson(spec.receipt.path);
 if(request.execution_kind!=='codex_cli_inference'||request.role!=='director'||request.input?.stage!=='research_style_route_v1'
  ||receipt.request_sha256!==shaBytes(canonical(request))||receipt.request?.sha256!==spec.request.sha256
  ||receipt.status!=='semantic_invalid'||receipt.detail!=='direction_story_or_words_semantics_invalid'
  ||receipt.cli_invocations!==1||receipt.execution_kind!=='codex_cli_inference'||receipt.timed_out!==false||receipt.process_terminated!==true
  ||receipt.exit_code!==0&&!receipt.completed_turn_cleanup||receipt.submitted_image_count!==0
  ||receipt.model_revision!==request.model_revision||receipt.qualified!==false||receipt.production_approval!==false
  ||request.source_video_sha256!==request.input?.data?.source_video_sha256)fail('actual_schema_valid_semantic_rejection_required');
 await verifyEvidenceBindings([receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,...request.input_bindings]);
 const value=await readJson(receipt.final.path),events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse),turns=events.filter(row=>row.type==='turn.completed');
 if(turns.length!==1||events.some(row=>['turn.failed','error'].includes(row.type))
  ||!same(JSON.parse(events.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null'),value)
  ||receipt.usage?.reported_turns!==1||receipt.usage.tokens.input_tokens!==turns[0].usage.input_tokens||receipt.usage.tokens.output_tokens!==turns[0].usage.output_tokens)
  fail('actual_final_model_event_or_usage_changed');
 const{baseStructuredEvidencePrompt,validateCompletedTurnCleanup}=await import('./codex_cli_runtime.mjs');
 if(!same(await readJson(receipt.schema.path),typedStyleProviderSchema(request.input.schema))
  ||await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projectTypedStyleModelInput(request.input).input))fail('actual_schema_or_stdin_changed');
 validateSchema(value,typedStyleExpandedProviderSchema(request.input.schema));
 if(receipt.completed_turn_cleanup)validateCompletedTurnCleanup(receipt.completed_turn_cleanup,{events,finalBytes:await readFile(receipt.final.path),schema:typedStyleExpandedProviderSchema(request.input.schema)});
 const fullBinding=request.input.data.full_direction_request;await verifyEvidenceBindings(fullBinding);const full=await readJson(fullBinding.path);
 if(full.data?.source_video_sha256!==request.source_video_sha256
   ||full.data?.analysis?.source_video_sha256!==request.source_video_sha256)fail('original_full_request_source_changed');
 const business=projectCompactBusinessContract(full).businessSchema,
  schema=objectSchema(Object.fromEntries(Object.entries(business.properties).filter(([key])=>!['uncertainty_scopes','uncertainty_dispositions'].includes(key))));
 validateSchema(value,schema);const analysis=full.data.analysis,gaps=directionSemanticGaps(value,analysis);
 const expected=value.cues.slice(1).map(cue=>'story_boundary_evidence_required:'+cue.cue_id);
 if(!gaps.length||gaps.some(gap=>gap!=='unknown_story_boundary_cue'&&!expected.includes(gap)))fail('only_boundary_fields_may_be_repaired');
 validateCaseEventAnchors({...value,source_video_sha256:full.data.source_video_sha256},analysis,full.data.timeline.duration_samples/48000);
 return{binding,spec,request,receipt,value,full,fullBinding,schema,analysis,gaps};
}
export async function prepareNativeRouteBoundaryRepair(binding){
 const original=await loadUnadoptedNativeBoundaryRoute(binding),cues=original.value.cues.slice(1);
 // A sole mother cue has no cue-entry boundaries. The model's internal
 // development suggestions stay in the immutable rejected final, while this
 // narrowly typed repair only clears the invalid boundary namespace.
 if(!cues.length&&(!original.value.cues.length||original.gaps.length!==1
   ||original.gaps[0]!=='unknown_story_boundary_cue'))fail('actual_nonfirst_cues_required');
 const eligible=cue=>original.analysis.story_beats.filter(beat=>cue.target_range[0]>=beat.start_seconds&&cue.target_range[0]<=beat.end_seconds);
 const beats=[...new Map(cues.flatMap(eligible).map(beat=>[beat.id,beat])).values()];
 const schema=objectSchema({boundaries:{type:'array',minItems:cues.length,maxItems:cues.length,items:objectSchema({cue_id:{type:'string',...(cues.length?{enum:cues.map(cue=>cue.cue_id)}:{})},
  story_beat_id:{type:'string',...(beats.length?{enum:beats.map(beat=>beat.id)}:{})},evidence_ids:{type:'array',minItems:1,items:{type:'string',
    ...(beats.length?{enum:[...new Set(beats.flatMap(beat=>beat.evidence_ids))]}:{})}},reason:{type:'string',minLength:1}})}});
 const oldBoundary=original.request.input.schema?.properties?.boundary_events?.items?.properties;
 const sharedEnumPoison=Array.isArray(oldBoundary?.cue_id?.enum)&&same(oldBoundary.cue_id.enum,oldBoundary.story_beat_id?.enum);
 const diagnosis=sharedEnumPoison
  ?'Repair ONLY boundary_events of the actual completed native route rejected because shared schema nodes forced cue IDs/reasons/evidence IDs into the story-beat namespace. '
  :'Repair ONLY boundary_events of the actual completed native route rejected because its entries do not map one-to-one to nonfirst cue starts. Do not return the first cue or internal accents as a cue-entry boundary. ';
 const input={stage:nativeBoundaryRepairStage,schema,frames:[],prompt:diagnosis
  +'Return each listed real cue_id once, a real story_beat_id at its frozen boundary, actual frame/audio evidence IDs belonging to that beat, and a reason grounded in its plot/control/expectation transition. '
  +'The host restores target_seconds from the original cue start. Never alter cues, ranges, songs, words opportunities, sound queries, relationship, danger, global route or unknowns. This grants no hearing or adoption approval.',
  data:{source_video_sha256:original.request.source_video_sha256,original_completed_request:original.spec.request,original_semantic_rejection:original.spec.receipt,
   global_route_summary:original.value.global_route_summary,story_beats:beats,affected_cues:cues.map(cue=>({cue_id:cue.cue_id,target_range:cue.target_range,
    function:cue.function,sound_goal:cue.sound_goal,case_conditions:cue.case_conditions,eligible_story_beat_ids:eligible(cue).map(beat=>beat.id)})),
   ...(cues.length?{}:{single_mother_cue_contract:'The only cue begins the episode: boundaries MUST be []; internal accents/development are not new cue entries.',
     rejected_internal_boundary_entries:original.value.boundary_events}),
   actual_audio_listened:false,production_approval:false}};
 return{original,input,cues};
}
export async function validateFailedNativeRouteRecoveryIntent(prepared,currentInput,{expectedModelRevision=null}={}){
 if(expectedModelRevision&&prepared.original.request.model_revision!==expectedModelRevision)fail('failed_route_original_model_profile_required');
 const{compareCompletedTypedRouteIntents}=await import('./completed_typed_route_recovery.mjs');
 return compareCompletedTypedRouteIntents(prepared.original.request.input,currentInput);
}
export function mergeNativeRouteBoundaryRepair(prepared,patch){
 validateSchema(patch,prepared.input.schema);
 if(new Set(patch.boundaries.map(row=>row.cue_id)).size!==prepared.cues.length)fail('every_actual_nonfirst_cue_required');
 const value=structuredClone(prepared.original.value);value.boundary_events=prepared.cues.map(cue=>{
  const row=patch.boundaries.find(row=>row.cue_id===cue.cue_id),beat=prepared.original.analysis.story_beats.find(beat=>beat.id===row.story_beat_id);
  if(!beat||cue.target_range[0]<beat.start_seconds||cue.target_range[0]>beat.end_seconds||row.evidence_ids.some(id=>!beat.evidence_ids.includes(id)))fail('boundary_evidence_outside_actual_beat');
  return{...row,target_seconds:cue.target_range[0]};});
 validateSchema(value,prepared.original.schema);
 if(directionSemanticGaps(value,prepared.original.analysis).length)fail('repaired_original_route_semantics_invalid');return value;
}
// This is a structural namespace normalization, never a model response or an
// approval of the retained internal development suggestions. Only an actual
// rejected native route with this one deterministic gap is eligible.
export function assertSingleCueBoundaryNormalizationEligible(prepared){
 const original=prepared.original,value=original.value,cue=value.cues?.[0];
 if(value.cues?.length!==1||prepared.cues?.length!==0||!same(original.gaps,['unknown_story_boundary_cue'])
   ||!Array.isArray(value.boundary_events)||!value.boundary_events.length)fail('single_cue_unique_namespace_gap_required');
 for(const entry of value.boundary_events){const beat=original.analysis.story_beats.find(row=>row.id===entry.story_beat_id);
  if(entry.cue_id!==cue.cue_id||!beat||!cue.story_beat_ids?.includes(beat.id)
   ||!Number.isFinite(entry.target_seconds)||entry.target_seconds<=cue.target_range[0]||entry.target_seconds>=cue.target_range[1]
   ||entry.target_seconds<beat.start_seconds||entry.target_seconds>beat.end_seconds
   ||!Array.isArray(entry.evidence_ids)||!entry.evidence_ids.length||entry.evidence_ids.some(id=>!beat.evidence_ids.includes(id))
   ||typeof entry.reason!=='string'||!entry.reason.trim())fail('only_bound_internal_development_entries_may_be_normalized');
 }
 return mergeNativeRouteBoundaryRepair(prepared,{boundaries:[]});
}
export function createNativeSingleCueBoundaryNormalization(prepared){
 const value=assertSingleCueBoundaryNormalizationEligible(prepared),original=prepared.original,request=original.request,receipt=original.receipt;
 return{schema_version:1,value,execution_kind:'host_structural_normalization',
  completion_origin:'host_structural_normalization_of_actual_rejected_route',completion_status:'complete',
  request_sha256:receipt.request_sha256,input_sha256:request.input_sha256,model:request.model_requested,
  model_revision:request.model_revision,backend_id:request.backend_id,transport:receipt.transport,
  source_video_sha256:request.source_video_sha256,actual_runtime_executed:false,actual_input_processed:true,
  actual_audio_processed:false,actual_video_processed:false,actual_frames_submitted:0,
  qualified:false,scopes:[],artistic_approval:false,production_approval:false,
  usage:receipt.usage,usage_origin:'unchanged_original_rejected_model_request',new_model_calls:0,
  cli_receipts:[],historical_cli_receipts:[original.spec.receipt],reused:true,
  evidence_files:[original.binding,original.spec.request,original.spec.receipt,original.fullBinding,
   receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,...request.input_bindings],
  host_single_cue_boundary_normalization:{revision:singleCueBoundaryNormalizationRevision,original_route:original.binding,
   original_model_final:receipt.final,original_model_outcome:'semantic_invalid',original_model_returned_empty_boundaries:false,
   edited_field:'boundary_events_only',normalized_boundary_events:[],
   retained_internal_development_entries:structuredClone(original.value.boundary_events),
   retained_entries_role:'unadopted_original_internal_development_evidence',
   all_other_judgments_clocks_and_source_facts_changed:false,original_failure_and_final_unchanged:true,
   qualification_granted:false,artistic_approval:false,production_approval:false}};
}
export async function loadNativeSingleCueBoundaryNormalization(binding,{input=null,validateRoute=null,expectedModelRevision=null}={}){
 await verifyEvidenceBindings(binding);const raw=await readJson(binding.path),proof=raw.host_single_cue_boundary_normalization;
 if(proof?.revision!==singleCueBoundaryNormalizationRevision)fail('explicit_single_cue_host_normalization_required');
 const prepared=await prepareNativeRouteBoundaryRepair(proof.original_route),expected=createNativeSingleCueBoundaryNormalization(prepared);
 if(!same(raw,expected)||expectedModelRevision&&raw.model_revision!==expectedModelRevision)fail('single_cue_normalization_or_identity_changed');
 if(input){const{compareCompletedTypedRouteIntents}=await import('./completed_typed_route_recovery.mjs');
  await compareCompletedTypedRouteIntents(prepared.original.request.input,input);}
 await validateRoute?.(raw.value);return{...raw,raw_response:binding};
}
export async function loadNativeRouteBoundaryRecovery(binding,{input=null,validateRoute=null,expectedModelRevision=null}={}){
 await verifyEvidenceBindings(binding);const raw=await readJson(binding.path),merge=raw.host_boundary_merge;
 if(merge?.revision!==nativeBoundaryRepairRevision||merge.edited_field!=='boundary_events_only'
   ||merge.all_other_judgments_clocks_and_source_facts_changed!==false
   ||raw.execution_kind!=='codex_cli_inference'||raw.completion_status!=='complete'
   ||raw.actual_runtime_executed!==true||raw.actual_input_processed!==true||raw.qualified!==false||raw.production_approval!==false)fail('actual_typed_boundary_merge_required');
 const prepared=await prepareNativeRouteBoundaryRepair(merge.original_route);
 await verifyEvidenceBindings(merge.patch_response);const patch=await readJson(merge.patch_response.path);
 if(patch.execution_kind!=='codex_cli_inference'||patch.actual_runtime_executed!==true||patch.actual_input_processed!==true
   ||patch.completion_status!=='complete'||patch.qualified!==false||patch.production_approval!==false
   ||patch.model_revision!==raw.model_revision||patch.backend_id!==raw.backend_id
   ||patch.source_video_sha256!==prepared.original.request.source_video_sha256
   ||raw.source_video_sha256!==prepared.original.request.source_video_sha256
   ||!same(raw.usage,patch.usage)||raw.request_sha256!==patch.request_sha256)fail('actual_patch_required');
 await verifyEvidenceBindings(patch.evidence_files);
 const requestRef=patch.evidence_files.find(ref=>path.resolve(ref.path)===path.join(path.dirname(merge.patch_response.path),'request.json'));
 if(!requestRef)fail('actual_patch_request_required');const document=await readJson(requestRef.path);
 if(document.execution_kind!=='codex_cli_inference'||document.role!=='director'
   ||document.model_revision!==patch.model_revision||document.backend_id!==patch.backend_id
   ||!same(document.input,prepared.input)||document.source_video_sha256!==prepared.original.request.source_video_sha256
   ||document.request_sha256&&document.request_sha256!==patch.request_sha256||shaBytes(canonical(document))!==patch.request_sha256)fail('actual_patch_intent_changed');
 const{sampleBoundEnvelopeReceipt}=await import('./nonimage_envelope_calibration.mjs');
 const receipts=[...(patch.cli_receipts??[]),...(patch.historical_cli_receipts??[])];
 if(receipts.length!==1)fail('one_actual_patch_request_required');await sampleBoundEnvelopeReceipt(receipts[0],{nativeFamily:true});
 const receipt=await readJson(receipts[0].path);
 if(receipt.model_revision!==patch.model_revision||receipt.request_sha256!==patch.request_sha256
   ||receipt.source_video_sha256!==patch.source_video_sha256||receipt.qualified!==false||receipt.production_approval!==false
   ||!same(receipt.usage,patch.usage)||receipt.request?.sha256!==requestRef.sha256||!same(await readJson(receipt.final.path),patch.value)
   ||patch.source_video_sha256!==raw.source_video_sha256||!same(mergeNativeRouteBoundaryRepair(prepared,patch.value),raw.value)
   ||expectedModelRevision&&expectedModelRevision!==raw.model_revision)fail('actual_patch_or_reconstructed_value_changed');
 if(input){const{prepareTypedStyleContract}=await import('./typed_bounded_style_director.mjs');
   const current=input.stage==='research_style_route_v1'?{route:input}:await prepareTypedStyleContract(input),view=value=>{value=structuredClone(value);delete value.schema;delete value.response_schema;
    delete value.data.full_direction_request;delete value.data.typed_parent_input_sha256;return value;};
   if(!same(view(current.route),view(prepared.original.request.input)))fail('current_route_facts_or_controls_changed');}
 await validateRoute?.(raw.value);
 const historical=[prepared.original.spec.receipt,...receipts];
 if(!same(raw.historical_cli_receipts,historical)||raw.cli_receipts?.length!==0)fail('merged_accounting_changed');
 return{...raw,raw_response:binding,cli_receipts:[],historical_cli_receipts:historical,reused:true,new_model_calls:0};
}
