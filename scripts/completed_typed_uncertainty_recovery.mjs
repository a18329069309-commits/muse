import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readJson,validateSchema,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {expandTypedStyleTables,expandTypedStyleLiterals,projectTypedStyleModelInput,typedStyleProviderSchema,
  typedStyleExpandedProviderSchema,typedStyleUncertaintyStage,typedBoundedStyleRevision,
  validateTypedStyleBatch} from './typed_bounded_style_director.mjs';
import {readCompletedTypedRouteRecoveryPolicy,loadCompletedTypedRouteRecovery} from './completed_typed_route_recovery.mjs';

export const completedTypedUncertaintyRecoveryRevision='actual-completed-typed-unknown-equivalent-host-intent-v1';
const implementation=fileURLToPath(import.meta.url);
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('completed_typed_uncertainty_recovery_'+reason);};
async function locationIndependent(value){
  if(Array.isArray(value))return Promise.all(value.map(locationIndependent));
  if(!value||typeof value!=='object')return value;
  if(typeof value.path==='string'&&/^[a-f0-9]{64}$/.test(value.sha256??'')){
    await verifyEvidenceBindings({path:value.path,sha256:value.sha256});
    return Object.fromEntries(await Promise.all(Object.entries(value).filter(([key])=>key!=='path')
      .map(async([key,item])=>[key,await locationIndependent(item)])));
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await locationIndependent(item)])));
}
async function verifiedRoute(binding){
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
  if(raw.host_single_cue_boundary_normalization){const{loadNativeRouteAnchorRecovery}=await import('./native_route_anchor_recovery.mjs');
    const checked=await loadNativeRouteAnchorRecovery(binding);
    return{value:checked.value,original:binding,source_video_sha256:checked.source_video_sha256};}
  if(raw.host_route_anchor_merge||raw.host_boundary_merge)fail('normal_completed_route_required');
  if(raw.restoration){
    const{loadCompletedNativeRoute,loadNativeRouteAnchorRecovery}=await import('./native_route_anchor_recovery.mjs');
    const original=await loadCompletedNativeRoute(binding);
    const checked=await loadNativeRouteAnchorRecovery(binding,{input:original.payload.input,expectedModelRevision:raw.model_revision});
    return{value:checked.value,original:binding,source_video_sha256:checked.source_video_sha256};
  }
  if(raw.host_completed_native_route_reuse){
    const merge=raw.host_completed_native_route_reuse;
    await verifyEvidenceBindings(merge.current_route_input);
    const checked=await loadCompletedTypedRouteRecovery(binding,{input:await readJson(merge.current_route_input.path),
      expectedModelRevision:raw.model_revision});
    return{value:checked.value,original:merge.original_completed_route,source_video_sha256:checked.source_video_sha256};
  }
  await readCompletedTypedRouteRecoveryPolicy(binding);
  return{value:raw.value,original:binding,source_video_sha256:raw.source_video_sha256};
}
function decodedIntent(input){
  const value=expandTypedStyleTables(expandTypedStyleLiterals(structuredClone(input)));
  delete value.data?.literal_table;delete value.data?.typed_parent_input_sha256;
  delete value.data?.full_direction_request;delete value.data?.completed_route;
  return value;
}
async function checkedParent(input,route){
  const ref=input.data?.full_direction_request;
  if(!ref)fail('complete_parent_binding_required');await verifyEvidenceBindings(ref);
  const full=await readJson(ref.path),data=expandTypedStyleTables(expandTypedStyleLiterals(input).data);
  if(full.stage!=='research_style_director'||full.data?.source_video_sha256!==input.data.source_video_sha256
    ||route.source_video_sha256!==input.data.source_video_sha256)fail('full_parent_or_route_source_changed');
  const analysis=expandTypedStyleTables(expandTypedStyleLiterals({...full,host_contract:full.host_contract??{}}).data.analysis);
  const selected=data.selected_uncertainties;
  if(!Array.isArray(selected)||!selected.length||new Set(selected.map(row=>row.origin+'/'+row.uncertainty_index)).size!==selected.length
    ||selected.some(row=>!['analysis','direction'].includes(row.origin)||!Number.isInteger(row.uncertainty_index)
      ||row.uncertainty_index<0||row.text!==(row.origin==='analysis'?analysis.uncertainties:route.value.uncertainties)?.[row.uncertainty_index]))
    fail('original_global_unknown_text_or_index_changed');
  const counts=data.uncertainty_batch?.global_origin_counts;
  if(counts&&!same(counts,{analysis:analysis.uncertainties.length,direction:route.value.uncertainties.length}))
    fail('global_origin_count_changed');
  if(!same(data.global_route_summary,route.value.global_route_summary))fail('original_route_summary_changed');
  return full;
}
export async function compareCompletedTypedUncertaintyIntents(original,current){
  if(original.stage!==typedStyleUncertaintyStage||current.stage!==typedStyleUncertaintyStage)fail('uncertainty_stage_required');
  const beforeRoute=await verifiedRoute(original.data?.completed_route),afterRoute=await verifiedRoute(current.data?.completed_route);
  if(beforeRoute.original.sha256!==afterRoute.original.sha256||!same(beforeRoute.value,afterRoute.value))fail('original_completed_route_changed');
  const beforeParent=await checkedParent(original,beforeRoute),afterParent=await checkedParent(current,afterRoute);
  const before=await locationIndependent(decodedIntent(original)),after=await locationIndependent(decodedIntent(current));
  const a=await locationIndependent(beforeParent),b=await locationIndependent(afterParent);
  if(!same(before,after)||!same(a,b))fail('all_original_unknowns_facts_conditions_or_contract_changed');
  const oldProjected=projectTypedStyleModelInput(original),newProjected=projectTypedStyleModelInput(current);
  if(oldProjected.audit?.revision!==newProjected.audit?.revision
    ||!same(await locationIndependent(decodedIntent(oldProjected.input)),await locationIndependent(decodedIntent(newProjected.input))))
    fail('submitted_projection_contract_changed');
  return{revision:completedTypedUncertaintyRecoveryRevision,semantic_batch_sha256:shaBytes(canonical(before)),
    semantic_parent_sha256:shaBytes(canonical(a)),original_completed_route:beforeRoute.original,
    original_full_request:original.data.full_direction_request,current_full_request:current.data.full_direction_request,
    source_video_sha256:original.data.source_video_sha256,global_indexes_and_original_texts:before.data.selected_uncertainties,
    host_locator_fields_only:['content_bound_evidence.path','data.full_direction_request','data.typed_parent_input_sha256','data.completed_route_verified_same_original_child'],
    complete_facts_clocks_unknowns_conditions_schema_prompt_projection_and_original_route_unchanged:true,
    qualified:false,production_approval:false};
}
async function verifiedCompletedChild(binding){
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
  if(raw.execution_kind!=='codex_cli_inference'||raw.actual_runtime_executed!==true||raw.actual_input_processed!==true
    ||raw.completion_status!=='complete'||raw.backend_id!=='codex-cli-chatgpt'||raw.actual_audio_processed!==false
    ||raw.actual_video_processed!==false||raw.actual_frames_submitted!==0||raw.qualified!==false
    ||raw.artistic_approval!==false||raw.production_approval!==false||!same(raw.scopes,[])
    ||raw.synthetic_protocol_fixture||raw.restoration||raw.host_single_cue_boundary_normalization||raw.host_route_anchor_merge||raw.host_boundary_merge
    ||raw.cli_receipts?.length!==1||(raw.historical_cli_receipts??[]).length)fail('normal_actual_completed_child_required');
  await verifyEvidenceBindings(raw.evidence_files);await verifyEvidenceBindings(raw.cli_receipts);
  const requestBinding=raw.evidence_files.find(ref=>path.resolve(ref.path)===path.join(path.dirname(binding.path),'request.json'));
  if(!requestBinding)fail('actual_child_request_required');
  const payload=await readJson(requestBinding.path),receiptBinding=raw.cli_receipts[0],receipt=await readJson(receiptBinding.path);
  if(payload.execution_kind!=='codex_cli_inference'||payload.role!=='director'||payload.input?.stage!==typedStyleUncertaintyStage
    ||payload.typed_output_revision!==typedBoundedStyleRevision||payload.model_revision!==raw.model_revision
    ||payload.model_requested!==raw.model||payload.backend_id!==raw.backend_id
    ||payload.source_video_sha256!==raw.source_video_sha256||payload.input.data?.source_video_sha256!==raw.source_video_sha256
    ||payload.input_sha256!==raw.input_sha256||shaBytes(canonical(payload))!==raw.request_sha256
    ||payload.submitted_images?.length||payload.input.frames?.length)fail('actual_child_model_source_or_request_changed');
  await verifyEvidenceBindings(payload.input_bindings);await verifyEvidenceBindings([payload.worker_instructions,receipt.worker_instructions]);
  if(!payload.worker_instructions?.sha256||payload.worker_instructions.sha256!==receipt.worker_instructions?.sha256
    ||payload.worker_settings?.instructions_sha256!==payload.worker_instructions.sha256
    ||payload.worker_profile!==receipt.worker_profile||payload.worker_profile!=='structured_evidence_v2'
    ||!same(payload.transport,receipt.transport)||!same(raw.transport,receipt.transport))fail('original_worker_or_transport_changed');
  if(receipt.status!=='complete'||receipt.execution_kind!=='codex_cli_inference'||receipt.cli_invocations!==1
    ||receipt.caller_semantic_validator_used!==true||receipt.timed_out!==false||receipt.process_terminated!==true
    ||receipt.exit_code!==0&&!receipt.completed_turn_cleanup||receipt.repair_of||receipt.synthetic_protocol_fixture||receipt.submitted_image_count!==0
    ||receipt.source_video_sha256!==raw.source_video_sha256||receipt.model_revision!==raw.model_revision
    ||receipt.request_sha256!==raw.request_sha256||!same(receipt.request,requestBinding)
    ||receipt.qualified!==false||receipt.artistic_approval!==false||receipt.production_approval!==false
    ||!same(receipt.usage,raw.usage))fail('actual_normal_completed_receipt_required');
  await verifyEvidenceBindings([receipt.final,receipt.schema,receipt.prompt,receipt.jsonl]);
  const projected=projectTypedStyleModelInput(payload.input);
  const{baseStructuredEvidencePrompt,completedCliEventsValid,validateCompletedTurnCleanup}=await import('./codex_cli_runtime.mjs');
  if(await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projected.input)
    ||!same(await readJson(receipt.schema.path),typedStyleProviderSchema(payload.input.schema)))fail('actual_prompt_or_provider_schema_changed');
  if(receipt.typed_consumer_projection){await verifyEvidenceBindings(receipt.typed_consumer_projection);
    if(!same(await readJson(receipt.typed_consumer_projection.path),projected.audit))fail('actual_projection_audit_changed');}
  const events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const turns=events.filter(row=>row.type==='turn.completed'),messages=events.filter(row=>row.type==='item.completed'&&row.item?.type==='agent_message');
  if(!completedCliEventsValid(events)
    ||!same(JSON.parse(messages[0].item.text),raw.value)||!same(await readJson(receipt.final.path),raw.value)
    ||raw.usage?.reported_turns!==1||!same(turns[0].usage,raw.usage.tokens))
    fail('actual_model_value_completion_or_usage_changed');
  if(receipt.terminal_result_origin!==undefined&&(receipt.terminal_result_origin!=='owned_completed_event'
    ||receipt.original_last_message_absent_at_capture!==true||path.basename(receipt.final.path)!=='terminal-event-final.json'
    ||!path.isAbsolute(receipt.original_last_message_path??'')
    ||path.resolve(receipt.original_last_message_path)===path.resolve(receipt.final.path))
    ||receipt.completed_turn_cleanup?.result_origin!==undefined
      &&receipt.completed_turn_cleanup.result_origin!==receipt.terminal_result_origin)fail('actual_terminal_result_origin_changed');
  if(receipt.completed_turn_cleanup)validateCompletedTurnCleanup(receipt.completed_turn_cleanup,{events,
    finalBytes:await readFile(receipt.final.path),schema:typedStyleExpandedProviderSchema(payload.input.schema)});
  validateSchema(raw.value,typedStyleExpandedProviderSchema(payload.input.schema));validateTypedStyleBatch(raw.value,payload.input);
  await checkedParent(payload.input,await verifiedRoute(payload.input.data.completed_route));
  await verifyEvidenceBindings(binding);
  return{binding,raw,payload,receipt,requestBinding,receiptBinding};
}
async function immutableJson(file,value){
  await mkdir(path.dirname(file),{recursive:true});const bytes=JSON.stringify(value,null,2)+'\n';
  try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;
    if(await readFile(file,'utf8')!==bytes)fail('immutable_reuse_receipt_changed');}
  return{path:file,sha256:await hashFile(file)};
}
export async function loadCompletedTypedUncertaintyRecovery(binding,{input,expectedModelRevision=null,outputFile=null}={}){
  await verifyEvidenceBindings(binding);const stored=await readJson(binding.path),merge=stored.host_completed_native_uncertainty_reuse;
  const original=await verifiedCompletedChild(merge?merge.original_completed_batch:binding);
  if(expectedModelRevision&&original.raw.model_revision!==expectedModelRevision)fail('current_model_revision_changed');
  if(!input)fail('current_complete_batch_input_required');
  const equivalence=await compareCompletedTypedUncertaintyIntents(original.payload.input,input);
  validateTypedStyleBatch(original.raw.value,input);
  if(merge){
    await verifyEvidenceBindings([merge.current_batch_input,merge.implementation]);
    if(merge.revision!==completedTypedUncertaintyRecoveryRevision||merge.implementation.sha256!==await hashFile(implementation)
      ||!same(await readJson(merge.current_batch_input.path),input)||!same(merge.equivalence,equivalence)
      ||!same(stored.value,original.raw.value)||!same(stored.usage,original.raw.usage)
      ||stored.request_sha256!==original.raw.request_sha256||stored.new_model_calls!==0
      ||stored.qualified!==false||stored.production_approval!==false||stored.artistic_approval!==false)
      fail('host_reuse_proof_or_value_changed');
    return{...stored,raw_response:binding,reused:true};
  }
  const implementationBinding={path:implementation,sha256:await hashFile(implementation)};
  const file=outputFile??path.join(path.dirname(input.data.full_direction_request.path),'completed-native-unknown-reuse',
    shaBytes(canonical({input,implementation_sha256:implementationBinding.sha256})),'response.json');
  if(!path.isAbsolute(file))fail('absolute_reuse_output_required');
  const inputBinding=await immutableJson(path.join(path.dirname(file),'batch-input.json'),input);
  const value={...original.raw,cli_receipts:[],historical_cli_receipts:original.raw.cli_receipts,new_model_calls:0,
    host_completed_native_uncertainty_reuse:{revision:completedTypedUncertaintyRecoveryRevision,original_completed_batch:original.binding,
      original_request:original.requestBinding,original_execution_receipt:original.receiptBinding,current_batch_input:inputBinding,
      equivalence,implementation:implementationBinding,original_model_value_and_usage_preserved:true,
      source_global_indexes_and_original_unknowns_unchanged:true,new_model_calls:0,qualification_granted:false}};
  const ref=await immutableJson(file,value);
  return{...value,raw_response:ref,reused:true};
}
