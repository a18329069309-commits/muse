import path from'node:path';
import{readFile}from'node:fs/promises';
import{objectSchema,readJson,saveJson,validateSchema,verifyEvidenceBindings,shaBytes}from'./audio_api.mjs';
import{completedCliEventsValid,validateCompletedTurnCleanup}from'./codex_cli_runtime.mjs';

const verified=new WeakSet();
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
 ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
const fail=reason=>{throw Error('direction_execution_basis_'+reason);};
export const actualTerminalEncodingRevalidationRevision='actual-terminal-u3002-revalidation-v1';
const reference=objectSchema({path:{type:'string'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}});
export const boundDirectionExecutionEvidenceSchema=objectSchema({schema_version:{type:'integer',enum:[1]},
 kind:{type:'string',enum:['bound_direction_execution_basis']},source_video_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
 input:reference,direction:reference,reviewer_kind:{type:'string',enum:['codex_text_contract_review']},
 entries:{type:'array',minItems:1,items:objectSchema({origin:{type:'string',enum:['analysis','direction']},
  uncertainty_index:{type:'integer',minimum:0},component_index:{type:'integer',minimum:0},basis_kind:{type:'string',enum:['execution']},
  claim_kind:{type:'string',enum:['unqualified_audio_prediction_provenance','model_input_modality_limit']},
  actual_batch_response:reference,evidence_refs:{type:'array',items:reference}})},
 classifies_text_only:{type:'boolean',enum:[true]},actual_audio_listened:{type:'boolean',enum:[false]},
 sound_facts_approved:{type:'boolean',enum:[false]},professional_qualification:{type:'boolean',enum:[false]},
 production_approval:{type:'boolean',enum:[false]}});

// Exact finite provenance statements. This is not a substring exemption for an
// arbitrary uncertainty: mixed story, lyric, contamination and physical claims
// must retain their ordinary basis and scope checks.
const rangePrefix='\\[(?:\\d+(?:\\.\\d+)?),(?:\\d+(?:\\.\\d+)?)\\)：';
const permitted={
 unqualified_audio_prediction_provenance:[
  new RegExp('^全窗口'+rangePrefix+'audio_observation_\\d+至audio_observation_\\d+均为未核准预测，原始预测文本与活动区间仍以输入为准；不能将其当成核准对白或词级同步。$','u'),
  new RegExp('^'+rangePrefix+'全部音频观察均未核准；ASR原文与VAD时钟不是合格对白或词级同步证据，不能据此确认原声种类、歌词、乐器或现有效果。$','u'),
  new RegExp('^'+rangePrefix+'未听原音或观看连续视频；audio_observation_\\d+、audio_observation_\\d+的ASR和语音活动时钟均不合格于核准对白、词级同步或声音事实，原始材料仍以绑定输入为准。$','u')],
 model_input_modality_limit:[/^本次frames为空，画面事实仅来自绑定文字中的静帧描述，未直接检视图像。$/u]
};
const reasons={
 unqualified_audio_prediction_provenance:new Set([
  '预测文本及活动区间不构成核准对白或词级同步；完成路线不改变其证据等级。',
  'ASR和VAD仅为未核准预测，不能升级为对白、同步或声音种类证据。',
  '未听原音或观看连续视频，预测及活动时钟不能建立对白、同步或声音事实。',
  '本次只基于绑定文字与静帧；未经听音或连续视频核验的ASR及活动时钟不具备声音事实或词级同步效力。']),
 model_input_modality_limit:new Set(['本批次没有图像附件；画面事实仅为绑定文字中的静帧描述，不能称为直接图像观察。'])};
const constraints=[
 /^保留绑定输入中的原始预测与区间；具体对白编辑仍须独立核验。$/u,
 /^不确认原声种类、歌词、乐器或现有效果；具体同步与对白避让须另行核验。$/u,
 /^保留audio_observation_\d+、audio_observation_\d+的预测身份及绑定原始材料；不声称听音或连续观看。$/u,
 /^不声称听原音或观看连续视频。$/u,/^原始材料以绑定输入为准，不升级预测证据。$/u,
 /^具体对白及同步编辑仍需另行核验。$/u,/^未直接检视图像，未听原音，未观看连续视频。$/u];
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function modelFields(part){const value=structuredClone(part);delete value.text;delete value.text_range;
 for(const basis of value.basis??[])delete basis.quote;
 for(const ref of value.condition_refs??[]){delete ref.relationship;delete ref.threat_resolved;}return value;}

// Share the executor's strict terminal semantics. A killed owned process is
// accepted only after the same completed result and cleanup proof validate.
export function completedBatchEventsValid(events,receipt,{finalBytes,schema}={}){
 if(!completedCliEventsValid(events)||receipt?.timed_out!==false||receipt.process_terminated!==true)return false;
 if(receipt.terminal_result_origin!==undefined&&(receipt.terminal_result_origin!=='owned_completed_event'
  ||receipt.original_last_message_absent_at_capture!==true||path.basename(receipt.final?.path??'')!=='terminal-event-final.json'
  ||!path.isAbsolute(receipt.original_last_message_path??'')
  ||path.resolve(receipt.original_last_message_path)===path.resolve(receipt.final.path))
  ||receipt.completed_turn_cleanup?.result_origin!==undefined
    &&receipt.completed_turn_cleanup.result_origin!==receipt.terminal_result_origin)return false;
 if(receipt.completed_turn_cleanup){
  try{return validateCompletedTurnCleanup(receipt.completed_turn_cleanup,{events,finalBytes,schema});}catch{return false;}
 }
 return receipt.exit_code===0;
}

export async function verifyActualBatch(binding,sourceSha,{expectedStage='research_style_uncertainties_v1'}={}){
 await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
 if(raw.host_typed_unknown_range_merge){
  if(expectedStage!=='research_style_uncertainties_v1'||raw.source_video_sha256!==sourceSha)fail('range_batch_source_or_stage_changed');
  const proof=raw.host_typed_unknown_range_merge;
  await verifyEvidenceBindings([proof.current_batch_input,proof.original_request]);
  const input=await readJson(proof.current_batch_input.path);
  const{loadTypedUnknownRangeRecovery}=await import('./typed_unknown_range_recovery.mjs');
  const checked=await loadTypedUnknownRangeRecovery(binding,{input,expectedModelRevision:raw.model_revision});
  const{expandTypedStyleLiterals}=await import('./typed_bounded_style_director.mjs');
  return{raw:checked,request:await readJson(proof.original_request.path),requestBinding:proof.original_request,
    input:expandTypedStyleLiterals(input),actual_original_rejected_batch:proof.original_failed_batch};
 }
 if(raw.host_completed_native_uncertainty_reuse){
  if(expectedStage!=='research_style_uncertainties_v1'||raw.source_video_sha256!==sourceSha)fail('reused_batch_source_or_stage_changed');
  const proof=raw.host_completed_native_uncertainty_reuse;
  await verifyEvidenceBindings(proof.current_batch_input);const input=await readJson(proof.current_batch_input.path);
  const{loadCompletedTypedUncertaintyRecovery}=await import('./completed_typed_uncertainty_recovery.mjs');
  const checked=await loadCompletedTypedUncertaintyRecovery(binding,{input,expectedModelRevision:raw.model_revision});
  const original=await verifyActualBatch(proof.original_completed_batch,sourceSha,{expectedStage});
  const{expandTypedStyleLiterals}=await import('./typed_bounded_style_director.mjs');
  // Actual model output/request/usage stay original. Only the semantic host
  // dependency view uses the independently proved equivalent current input.
  return{...original,raw:checked,input:expandTypedStyleLiterals(input),
    actual_original_batch:proof.original_completed_batch,current_equivalent_input:proof.current_batch_input};
 }
 if(raw.execution_kind!=='codex_cli_inference'||raw.backend_id!=='codex-cli-chatgpt'||raw.synthetic_protocol_fixture
  ||raw.completion_status!=='complete'||raw.actual_runtime_executed!==true||raw.actual_input_processed!==true
  ||raw.actual_audio_processed!==false||raw.actual_video_processed!==false||raw.actual_frames_submitted!==0
  ||raw.source_video_sha256!==sourceSha||raw.qualified!==false||raw.production_approval!==false||raw.artistic_approval!==false
  ||!same(raw.scopes,[]))fail('actual_unqualified_batch_required');
 await verifyEvidenceBindings(raw.evidence_files);
 const requestBinding=raw.evidence_files.find(ref=>path.resolve(ref.path)===path.join(path.dirname(binding.path),'request.json'));
 if(!requestBinding)fail('actual_request_required');const request=await readJson(requestBinding.path);
 if(request.execution_kind!=='codex_cli_inference'||request.role!=='director'||request.source_video_sha256!==sourceSha
  ||request.model_revision!==raw.model_revision||request.model_requested!==raw.model||request.backend_id!==raw.backend_id||shaBytes(canonical(request))!==raw.request_sha256
  ||request.input?.stage!==expectedStage||request.input.frames?.length)fail('actual_request_changed');
 const{typedStyleProviderSchema,typedStyleExpandedProviderSchema,projectTypedStyleModelInput,expandTypedStyleLiterals,validateTypedStyleBatch}=await import('./typed_bounded_style_director.mjs');
 const{baseStructuredEvidencePrompt}=await import('./codex_cli_runtime.mjs');
 let revalidation=null;
 if(raw.terminal_encoding_revalidation){
  await verifyEvidenceBindings(raw.terminal_encoding_revalidation);revalidation=await readJson(raw.terminal_encoding_revalidation.path);
  if(revalidation.revision!==actualTerminalEncodingRevalidationRevision||revalidation.source_video_sha256!==sourceSha
   ||revalidation.new_model_calls!==0||revalidation.raw_model_value_changed!==false||revalidation.old_receipt_unchanged!==true
   ||expectedStage!=='research_style_uncertainties_v1'||raw.cli_receipts?.length!==0
   ||!same(raw.historical_cli_receipts,[revalidation.original_receipt]))fail('terminal_encoding_revalidation_invalid');
  await verifyEvidenceBindings([revalidation.original_request,revalidation.original_final,revalidation.original_receipt]);
  if(revalidation.original_request.sha256!==requestBinding.sha256||!same(await readJson(revalidation.original_request.path),request)
   ||!same(await readJson(revalidation.original_final.path),raw.value))fail('terminal_encoding_original_changed');
  const audit=[];validateTypedStyleBatch(raw.value,request.input,{encodingAudit:audit});
  if(!audit.length||!same(audit,revalidation.encoding_recoveries))fail('terminal_encoding_exact_reconstruction_required');
 }
 const receipts=[...(raw.cli_receipts??[]),...(raw.historical_cli_receipts??[])];let accepted=false;
 for(const ref of receipts){await verifyEvidenceBindings(ref);const receipt=await readJson(ref.path);
  const revalidated=revalidation&&same(ref,revalidation.original_receipt)&&receipt.status==='semantic_invalid'
   &&receipt.detail==='typed_style_batch_component_range_invalid'&&same(receipt.final,revalidation.original_final)
   &&same(receipt.request,revalidation.original_request)&&receipt.exit_code===0&&!receipt.completed_turn_cleanup;
  if(receipt.status!=='complete'&&!revalidated)continue;
  if(receipt.execution_kind!=='codex_cli_inference'||receipt.synthetic_protocol_fixture||receipt.cli_invocations!==1
   ||receipt.source_video_sha256!==sourceSha||receipt.request_sha256!==raw.request_sha256||receipt.request?.sha256!==requestBinding.sha256
   ||receipt.model_revision!==raw.model_revision||receipt.model_requested!==raw.model||receipt.timed_out!==false||receipt.process_terminated!==true
   ||receipt.exit_code!==0&&!receipt.completed_turn_cleanup||receipt.repair_of)fail('actual_receipt_changed');
  await verifyEvidenceBindings([receipt.final,receipt.schema,receipt.prompt,receipt.jsonl]);
  if(!same(await readJson(receipt.final.path),raw.value)||!same(await readJson(receipt.schema.path),typedStyleProviderSchema(request.input.schema))
   ||await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projectTypedStyleModelInput(request.input).input))fail('actual_final_or_stdin_changed');
  const events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const turns=events.filter(row=>row.type==='turn.completed');
  if(!completedBatchEventsValid(events,receipt,{finalBytes:await readFile(receipt.final.path),
    schema:typedStyleExpandedProviderSchema(request.input.schema)})||turns.length!==1
   ||!same(JSON.parse(events.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null'),raw.value)
   ||receipt.usage?.reported_turns!==1||receipt.usage.tokens.input_tokens!==turns[0].usage.input_tokens
   ||receipt.usage.tokens.output_tokens!==turns[0].usage.output_tokens||!same(receipt.usage,raw.usage))fail('actual_model_event_or_usage_changed');
  validateSchema(raw.value,typedStyleExpandedProviderSchema(request.input.schema));accepted=true;
 }
 if(!accepted)fail('completed_receipt_required');return{raw,request,requestBinding,input:expandTypedStyleLiterals(request.input)};
}

// Host replay of one naturally completed actual model return rejected only by
// the old preflight/decoder disagreement. The old receipt remains invalid and
// charged; this creates a separate, explicitly derived revalidation proof.
export async function recoverActualTerminalEncodingBatch(receiptBinding,{directory}={}){
 await verifyEvidenceBindings(receiptBinding);const receipt=await readJson(receiptBinding.path);
 if(receipt.status!=='semantic_invalid'||receipt.detail!=='typed_style_batch_component_range_invalid'
  ||receipt.execution_kind!=='codex_cli_inference'||receipt.synthetic_protocol_fixture||receipt.cli_invocations!==1
  ||receipt.exit_code!==0||receipt.timed_out!==false||receipt.process_terminated!==true||receipt.completed_turn_cleanup
  ||receipt.repair_of||!directory)fail('terminal_encoding_original_receipt_required');
 await verifyEvidenceBindings([receipt.request,receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,receipt.stderr]);
 const request=await readJson(receipt.request.path),value=await readJson(receipt.final.path);
 const{validateTypedStyleBatch}=await import('./typed_bounded_style_director.mjs');
 const audit=[];validateTypedStyleBatch(value,request.input,{encodingAudit:audit});
 if(!audit.length||request.input.stage!=='research_style_uncertainties_v1')fail('terminal_encoding_exact_reconstruction_required');
 async function immutable(file,data){try{return await saveJson(file,data);}catch(error){if(error.code!=='EEXIST')throw error;
  if(!same(await readJson(file),data))fail('terminal_encoding_existing_record_changed');return{path:path.resolve(file),sha256:shaBytes(await readFile(file))};}}
 const requestBinding=await immutable(path.join(directory,'request.json'),request);
 const proof=await immutable(path.join(directory,'terminal-encoding-revalidation.json'),{
  revision:actualTerminalEncodingRevalidationRevision,source_video_sha256:request.source_video_sha256,
  original_request:receipt.request,original_final:receipt.final,original_receipt:receiptBinding,
  encoding_recoveries:audit,new_model_calls:0,raw_model_value_changed:false,old_receipt_unchanged:true});
 const raw={schema_version:1,request_sha256:shaBytes(canonical(request)),value,model:request.model_requested,
  model_revision:request.model_revision,backend_id:request.backend_id,execution_kind:'codex_cli_inference',
  source_video_sha256:request.source_video_sha256,input_sha256:request.input_sha256,
  actual_input_processed:true,actual_runtime_executed:true,actual_audio_processed:false,actual_video_processed:false,
  actual_frames_submitted:0,completion_status:'complete',qualified:false,scopes:[],artistic_approval:false,production_approval:false,
  usage:receipt.usage,cli_receipts:[],historical_cli_receipts:[receiptBinding],terminal_encoding_revalidation:proof,
  evidence_files:[requestBinding,proof,receiptBinding,receipt.request,receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,receipt.stderr,...(request.input_bindings??[])]};
 const binding=await immutable(path.join(directory,'response.json'),raw);
 await verifyActualBatch(binding,request.source_video_sha256);
 return{...raw,raw_response:binding,reused:true,new_model_calls:0};
}

export async function loadBoundDirectionExecutionEvidence(binding,{sourceSha,inputBinding,input,directionBinding,direction,mode}={}){
 if(mode!=='assisted_trial')fail('assisted_trial_required');await verifyEvidenceBindings(binding);const review=await readJson(binding.path);
 validateSchema(review,boundDirectionExecutionEvidenceSchema);
 if(review.source_video_sha256!==sourceSha||review.input.sha256!==inputBinding?.sha256||review.direction.sha256!==directionBinding?.sha256)
  fail('source_or_input_changed');
 await verifyEvidenceBindings([review.input,inputBinding,review.direction,directionBinding]);
 if(!same(await readJson(review.input.path),input)||!same(await readJson(review.direction.path),direction)
  ||input.stage!=='research_style_director'||input.data?.source_video_sha256!==sourceSha
  ||input.data.analysis?.source_video_sha256!==sourceSha)fail('original_input_or_direction_changed');
 if([input.data.mode,input.data.execution_mode].includes('production'))fail('nonproduction_execution_input_required');
 const checked=[],cache=new Map(),routes=new Map(),seen=new Set();
 for(const entry of review.entries){const key=entry.origin+'/'+entry.uncertainty_index+'/'+entry.component_index;
  if(seen.has(key))fail('duplicate_component');seen.add(key);
  const row=direction.uncertainty_dispositions.find(item=>item.origin===entry.origin&&item.uncertainty_index===entry.uncertainty_index),
   scope=direction.uncertainty_scopes.find(item=>item.origin===entry.origin&&item.uncertainty_index===entry.uncertainty_index),part=row?.components[entry.component_index];
  if(!part||part.kind!=='deferred_review'||part.required_stage!=='persistent_provenance_limit'||part.basis.length
   ||!['music','mixed'].includes(scope?.impact)||!permitted[entry.claim_kind].some(pattern=>pattern.test(part.text))
   ||!reasons[entry.claim_kind].has(part.reason)||!part.retained_constraints.length
   ||part.retained_constraints.some(value=>!constraints.some(pattern=>pattern.test(value))))fail('finite_execution_text_or_kind_required');
  let batch=cache.get(entry.actual_batch_response.sha256);if(!batch){batch=await verifyActualBatch(entry.actual_batch_response,sourceSha);cache.set(entry.actual_batch_response.sha256,batch);}
  if(batch.input.data.full_direction_request?.sha256!==review.input.sha256
    ||path.resolve(batch.input.data.full_direction_request?.path??'.')!==path.resolve(review.input.path))fail('actual_full_input_changed');
  const routeBinding=batch.input.data.completed_route;await verifyEvidenceBindings(routeBinding);
  let route=routes.get(routeBinding.sha256);if(!route){const original=await readJson(routeBinding.path);
    if(original.host_single_cue_boundary_normalization||original.host_route_anchor_merge||original.host_boundary_merge||original.host_completed_native_route_reuse){const{loadNativeRouteAnchorRecovery}=await import('./native_route_anchor_recovery.mjs');route=await loadNativeRouteAnchorRecovery(routeBinding);}
    else route=(await verifyActualBatch(routeBinding,sourceSha,{expectedStage:'research_style_route_v1'})).raw;
    routes.set(routeBinding.sha256,route);}
  if(route.source_video_sha256!==sourceSha||Object.entries(route.value).some(([key,value])=>!same(value,direction[key])))fail('actual_creative_route_changed');
  const original=batch.raw.value.uncertainty_dispositions.find(item=>item.origin===entry.origin&&item.uncertainty_index===entry.uncertainty_index),
   selected=batch.input.data.selected_uncertainties.find(item=>item.origin===entry.origin&&item.uncertainty_index===entry.uncertainty_index),
   originalScope=batch.raw.value.uncertainty_scopes.find(item=>item.origin===entry.origin&&item.uncertainty_index===entry.uncertainty_index),modelPart=original?.components[entry.component_index];
  if(!modelPart||!same(scope,originalScope)||!same(modelFields(part),modelFields(modelPart))||row.original_text!==selected?.text
   ||row.source_video_sha256!==sourceSha)fail('actual_component_or_scope_changed');
  const chars=Array.from(selected.text),range=modelPart.text_range===null?[0,chars.length]:modelPart.text_range;
  if(!Array.isArray(range)||range.length!==2||part.text!==chars.slice(...range).join(''))fail('actual_component_text_changed');
  await verifyEvidenceBindings(entry.evidence_refs);
  if(entry.claim_kind==='unqualified_audio_prediction_provenance'){
   if(!entry.evidence_refs.length)fail('bound_observation_required');
   const range=part.text.match(/\[(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\)/u)?.slice(1).map(Number);
   if(!range||range[1]<=range[0])fail('finite_prediction_range_required');
   const applicable=input.data.unqualified_research_observations?.filter(item=>item.value.source_range?.[0]<range[1]
     &&item.value.source_range?.[1]>range[0])??[];
   if(!applicable.length||applicable.some(item=>!entry.evidence_refs.some(ref=>ref.sha256===item.binding.sha256
     &&path.resolve(ref.path)===path.resolve(item.binding.path))))fail('every_bound_prediction_in_range_required');
   for(const ref of entry.evidence_refs){const supplied=input.data.unqualified_research_observations?.find(item=>item.binding.sha256===ref.sha256
      &&path.resolve(item.binding.path)===path.resolve(ref.path)),observation=await readJson(ref.path);
    if(!supplied||!same(supplied.value,observation)||observation.source_video_sha256!==sourceSha
     ||observation.transcription_verified!==false||observation.dialogue_activity_verified!==false||observation.sound_facts_qualified!==false
     ||observation.artistic_approval!==false||observation.original_audio_kind!=='unknown'
     ||observation.timestamp_precision!=='source_chunks_and_speech_activity_not_words_or_actions')fail('unqualified_prediction_receipt_required');}
  }else if(entry.evidence_refs.length)fail('modality_claim_uses_actual_batch_only');
  checked.push({...entry,component_identity:canonical(part),scope_identity:canonical(scope),request:batch.requestBinding});
 }
 const result=freeze({...review,binding:structuredClone(binding),entries:checked,new_model_calls:0,
  verified_execution_facts_only:true,formal_adoption_allowed:false});verified.add(result);return result;
}
export function allowsBoundDirectionExecutionBasis(review,{sourceSha,origin,uncertainty_index,component_index,component,scope,mode}={}){
 return mode==='assisted_trial'&&verified.has(review)&&review.source_video_sha256===sourceSha&&review.entries.some(row=>row.origin===origin
  &&row.uncertainty_index===uncertainty_index&&row.component_index===component_index
  &&row.component_identity===canonical(component)&&row.scope_identity===canonical(scope));
}
// Reloadable consumer seam. The record remains an actual input/response-bound
// review; a boolean or a copied WeakSet token never substitutes for its proof.
export async function reloadDirectionExecutionBasis(binding,{sourceSha,input=null,analysis=null,mode}={}){
 if(!binding)return null;await verifyEvidenceBindings(binding);const record=await readJson(binding.path);
 await verifyEvidenceBindings([record.input,record.direction]);const originalInput=await readJson(record.input.path),originalDirection=await readJson(record.direction.path);
 if(input?.data?.completed_story&&originalInput.data?.completed_story?.sha256!==input.data.completed_story.sha256)fail('current_story_changed');
 if(analysis&&!same(analysis,originalInput.data.analysis))fail('current_analysis_changed');
 return loadBoundDirectionExecutionEvidence(binding,{sourceSha,inputBinding:record.input,input:originalInput,
   directionBinding:record.direction,direction:originalDirection,mode});
}
// Fresh producer uses only already-completed actual constituents. It cannot
// invent a parent execution, classification, quote or review from a ready flag.
export async function produceBoundDirectionExecutionEvidence({inputBinding,input,directionBinding,direction,batchResponses,outputFile,mode}={}){
 if(mode!=='assisted_trial')return{status:'execution_basis_not_enabled_for_mode',binding:null,executionBasis:null};
 const entries=[];
 for(const row of direction.uncertainty_dispositions??[])for(const[index,part]of row.components.entries()){
  const scope=direction.uncertainty_scopes.find(item=>item.origin===row.origin&&item.uncertainty_index===row.uncertainty_index);
  if(part.kind!=='deferred_review'||part.required_stage!=='persistent_provenance_limit'||part.basis.length||!['music','mixed'].includes(scope?.impact))continue;
  const kind=Object.keys(permitted).find(name=>permitted[name].some(pattern=>pattern.test(part.text))&&reasons[name].has(part.reason)
    &&part.retained_constraints.length&&part.retained_constraints.every(text=>constraints.some(pattern=>pattern.test(text))));
  if(!kind)continue;
  const batches=batchResponses.filter(response=>response.value?.uncertainty_dispositions.some(item=>item.origin===row.origin&&item.uncertainty_index===row.uncertainty_index));
  if(batches.length!==1||!batches[0].raw_response)fail('producer_actual_constituent_required');
  entries.push({origin:row.origin,uncertainty_index:row.uncertainty_index,component_index:index,basis_kind:'execution',claim_kind:kind,
    actual_batch_response:batches[0].raw_response,evidence_refs:kind==='model_input_modality_limit'?[]:(input.data.unqualified_research_observations??[]).map(item=>item.binding)});
 }
 if(!entries.length)return{status:'no_finite_execution_basis_candidates_other_semantics_remain_required',binding:null,executionBasis:null};
 await verifyEvidenceBindings([inputBinding,directionBinding]);
 if(!same(await readJson(inputBinding.path),input)||!same(await readJson(directionBinding.path),direction))fail('producer_bound_inputs_changed');
 const record={schema_version:1,kind:'bound_direction_execution_basis',source_video_sha256:input.data.source_video_sha256,
  input:inputBinding,direction:directionBinding,reviewer_kind:'codex_text_contract_review',entries,classifies_text_only:true,
  actual_audio_listened:false,sound_facts_approved:false,professional_qualification:false,production_approval:false};
 const{saveJson}=await import('./audio_api.mjs');let binding;
 try{binding=await saveJson(outputFile,record);}catch(error){if(error.code!=='EEXIST')throw error;
   if(!same(await readJson(outputFile),record))fail('producer_existing_record_changed');
   binding={path:path.resolve(outputFile),sha256:shaBytes(await readFile(outputFile))};}
 const executionBasis=await loadBoundDirectionExecutionEvidence(binding,{sourceSha:record.source_video_sha256,inputBinding,input,directionBinding,direction,mode});
 return{status:'finite_execution_basis_produced_from_actual_completed_constituents',binding,executionBasis,new_model_calls:0};
}
