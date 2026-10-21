import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readJson,validateSchema,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {directionSemanticGaps} from './direction_semantics.mjs';
import {expandTypedStyleTables,expandTypedStyleLiterals,projectTypedStyleModelInput,
  typedStyleExpandedProviderSchema,typedStyleProviderSchema,typedBoundedStyleRevision,
  typedStyleRouteStage,validateTypedStyleRoutePolicy,routeLanguageSummaryPolicyRevision,
  typedRouteCreativeProjectionRevision} from './typed_bounded_style_director.mjs';

export const completedTypedRouteRecoveryRevision='actual-completed-typed-route-equivalent-host-intent-v1';
const implementation=fileURLToPath(import.meta.url);
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('completed_typed_route_recovery_'+reason);};

// Only content-bound file locations may move. All nonlocator fields, words,
// original unknowns, constraints, source SHA and clocks remain exact.
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
function decodedIntent(input){
  const value=expandTypedStyleTables(expandTypedStyleLiterals(structuredClone(input)));
  delete value.data?.literal_table;
  delete value.data?.typed_parent_input_sha256;
  delete value.data?.full_direction_request;
  return value;
}
export async function compareCompletedTypedRouteIntents(original,current){
  if(original.stage!==typedStyleRouteStage||current.stage!==typedStyleRouteStage)fail('route_stage_required');
  const oldFull=original.data?.full_direction_request,newFull=current.data?.full_direction_request;
  if(!oldFull||!newFull)fail('complete_parent_bindings_required');
  await verifyEvidenceBindings([oldFull,newFull]);
  const before=await readJson(oldFull.path),after=await readJson(newFull.path);
  if(before.stage!=='research_style_director'||after.stage!=='research_style_director'
    ||before.data?.source_video_sha256!==original.data.source_video_sha256
    ||after.data?.source_video_sha256!==current.data.source_video_sha256)fail('full_parent_source_changed');
  const oldIntent=await locationIndependent(decodedIntent(original)),newIntent=await locationIndependent(decodedIntent(current));
  const oldParent=await locationIndependent(before),newParent=await locationIndependent(after);
  if(!same(oldParent,newParent)||!same(oldIntent,newIntent))fail('complete_route_facts_constraints_or_contract_changed');
  const oldProjected=projectTypedStyleModelInput(original),newProjected=projectTypedStyleModelInput(current);
  // Projection may omit prior creative suggestions, never an original fact or unknown.
  if(oldProjected.audit?.revision!==newProjected.audit?.revision
    ||!same(await locationIndependent(decodedIntent(oldProjected.input)),await locationIndependent(decodedIntent(newProjected.input))))
    fail('submitted_projection_contract_changed');
  return{revision:completedTypedRouteRecoveryRevision,semantic_route_sha256:shaBytes(canonical(oldIntent)),
    semantic_parent_sha256:shaBytes(canonical(oldParent)),original_full_request:oldFull,current_full_request:newFull,
    source_video_sha256:original.data.source_video_sha256,
    host_locator_fields_only:['content_bound_evidence.path','data.full_direction_request','data.typed_parent_input_sha256'],
    source_facts_clocks_unknowns_preferences_prompt_schema_and_projection_unchanged:true,
    qualified:false,production_approval:false};
}

async function verifiedCompletedChild(binding){
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
  if(raw.execution_kind!=='codex_cli_inference'||raw.actual_runtime_executed!==true||raw.actual_input_processed!==true
    ||raw.completion_status!=='complete'||raw.backend_id!=='codex-cli-chatgpt'||raw.actual_audio_processed!==false
    ||raw.actual_video_processed!==false||raw.actual_frames_submitted!==0||raw.qualified!==false
    ||raw.artistic_approval!==false||raw.production_approval!==false||!same(raw.scopes,[])
    ||raw.synthetic_protocol_fixture||raw.restoration||raw.host_route_anchor_merge||raw.host_boundary_merge
    ||raw.cli_receipts?.length!==1||(raw.historical_cli_receipts??[]).length)fail('normal_actual_completed_child_required');
  await verifyEvidenceBindings(raw.evidence_files);await verifyEvidenceBindings(raw.cli_receipts);
  const requestBinding=raw.evidence_files.find(ref=>path.resolve(ref.path)===path.join(path.dirname(binding.path),'request.json'));
  if(!requestBinding)fail('actual_child_request_required');
  const payload=await readJson(requestBinding.path),receiptBinding=raw.cli_receipts[0],receipt=await readJson(receiptBinding.path);
  if(payload.execution_kind!=='codex_cli_inference'||payload.role!=='director'||payload.input?.stage!==typedStyleRouteStage
    ||payload.typed_output_revision!==typedBoundedStyleRevision||payload.model_revision!==raw.model_revision
    ||payload.model_requested!==raw.model||payload.backend_id!==raw.backend_id
    ||payload.source_video_sha256!==raw.source_video_sha256||payload.input.data?.source_video_sha256!==raw.source_video_sha256
    ||payload.input_sha256!==raw.input_sha256||shaBytes(canonical(payload))!==raw.request_sha256
    ||payload.submitted_images?.length||payload.input.frames?.length)fail('actual_child_model_source_or_request_changed');
  await verifyEvidenceBindings(payload.input_bindings);
  await verifyEvidenceBindings([payload.worker_instructions,receipt.worker_instructions]);
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
  validateSchema(raw.value,typedStyleExpandedProviderSchema(payload.input.schema));
  const analysis=expandTypedStyleTables(expandTypedStyleLiterals(payload.input).data.analysis);
  if(directionSemanticGaps(raw.value,analysis).length)fail('normal_route_semantics_required');
  validateTypedStyleRoutePolicy(raw.value,{route:payload.input,analysis});
  // Also verify that the full original parent binds exactly this analysis.
  await verifyEvidenceBindings(payload.input.data.full_direction_request);
  const full=await readJson(payload.input.data.full_direction_request.path);
  if(!same(analysis,expandTypedStyleTables(expandTypedStyleLiterals({...full,host_contract:full.host_contract??{}}).data.analysis)))fail('complete_analysis_binding_changed');
  await verifyEvidenceBindings(binding);
  return{binding,raw,payload,receipt,requestBinding,receiptBinding};
}

export async function readCompletedTypedRouteRecoveryPolicy(binding){
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path);
  if(raw.host_completed_native_route_reuse){const original=await verifiedCompletedChild(raw.host_completed_native_route_reuse.original_completed_route);
    return readPolicy(original.payload.input);}
  return readPolicy((await verifiedCompletedChild(binding)).payload.input);
}
function readPolicy(input){
  const policy=input.data.route_policy_revision,creative=input.data.route_creative_projection_revision;
  if(policy!==undefined&&policy!==routeLanguageSummaryPolicyRevision
    ||creative!==undefined&&creative!==typedRouteCreativeProjectionRevision)fail('original_projection_policy_unknown');
  return{routePolicyPreflight:policy===routeLanguageSummaryPolicyRevision,routeCreativeProjectionRevision:creative??null};
}
async function immutableJson(file,value){
  await mkdir(path.dirname(file),{recursive:true});const data=JSON.stringify(value,null,2)+'\n';
  try{await writeFile(file,data,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;
    if(await readFile(file,'utf8')!==data)fail('immutable_reuse_receipt_changed');}
  return{path:file,sha256:await hashFile(file)};
}

export async function loadCompletedTypedRouteRecovery(binding,{input=null,validateRoute=null,expectedModelRevision=null,outputFile=null}={}){
  await verifyEvidenceBindings(binding);const stored=await readJson(binding.path),merge=stored.host_completed_native_route_reuse;
  const original=await verifiedCompletedChild(merge?merge.original_completed_route:binding);
  if(expectedModelRevision&&original.raw.model_revision!==expectedModelRevision)fail('current_model_revision_changed');
  if(!input)fail('current_complete_route_input_required');
  const equivalence=await compareCompletedTypedRouteIntents(original.payload.input,input);
  await validateRoute?.(original.raw.value);
  if(merge){
    await verifyEvidenceBindings([merge.current_route_input,merge.implementation]);
    if(merge.revision!==completedTypedRouteRecoveryRevision||merge.implementation.sha256!==await hashFile(implementation)
      ||!same(await readJson(merge.current_route_input.path),input)||!same(merge.equivalence,equivalence)
      ||!same(stored.value,original.raw.value)||!same(stored.usage,original.raw.usage)
      ||stored.request_sha256!==original.raw.request_sha256||stored.new_model_calls!==0
      ||stored.qualified!==false||stored.production_approval!==false||stored.artistic_approval!==false)
      fail('host_reuse_proof_or_value_changed');
    return{...stored,raw_response:binding,reused:true};
  }
  const implementationBinding={path:implementation,sha256:await hashFile(implementation)};
  const file=outputFile??path.join(path.dirname(input.data.full_direction_request.path),'completed-native-route-reuse',
    shaBytes(canonical({input,implementation_sha256:implementationBinding.sha256})),'response.json');
  if(!path.isAbsolute(file))fail('absolute_reuse_output_required');
  const inputBinding=await immutableJson(path.join(path.dirname(file),'route-input.json'),input);
  const value={...original.raw,cli_receipts:[],historical_cli_receipts:original.raw.cli_receipts,new_model_calls:0,
    host_completed_native_route_reuse:{revision:completedTypedRouteRecoveryRevision,original_completed_route:original.binding,
      original_request:original.requestBinding,original_execution_receipt:original.receiptBinding,current_route_input:inputBinding,
      equivalence,implementation:implementationBinding,
      original_model_value_and_usage_preserved:true,source_and_all_original_unknowns_unchanged:true,
      new_model_calls:0,qualification_granted:false}};
  const ref=await immutableJson(file,value);
  return{...value,raw_response:ref,reused:true};
}
