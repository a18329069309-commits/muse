import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readJson,objectSchema,validateSchema,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {typedStyleUncertaintyStage,typedBoundedStyleRevision,typedStyleProviderSchema,
  typedStyleExpandedProviderSchema,projectTypedStyleModelInput,expandTypedStyleTables,
  expandTypedStyleLiterals,validateTypedStyleBatch} from './typed_bounded_style_director.mjs';
import {compareCompletedTypedUncertaintyIntents} from './completed_typed_uncertainty_recovery.mjs';
import {completedBatchEventsValid,verifyActualBatch} from './bound_direction_execution_evidence.mjs';

export const typedUnknownRangeRecoveryRevision='actual-typed-unknown-range-fields-only-v1';
const implementation=fileURLToPath(import.meta.url);
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),key=row=>row.origin+'/'+row.uncertainty_index;
const fail=reason=>{throw Error('typed_unknown_range_recovery_'+reason);};
async function immutable(file,value){
  await mkdir(path.dirname(file),{recursive:true});const bytes=JSON.stringify(value,null,2)+'\n';
  try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;
    if(await readFile(file,'utf8')!==bytes)fail('immutable_record_changed');}
  return{path:file,sha256:await hashFile(file)};
}

// A rejected consumer result is never relabelled as a completed batch. Its
// actual completed CLI turn, prompt, schema, original facts and failure remain
// separate immutable inputs to a new, field-only model request.
async function rejectedBatch(binding){
  await verifyEvidenceBindings(binding);const spec=await readJson(binding.path);
  if(spec.kind!=='actual_typed_unknown_range_repair_input')fail('explicit_source_spec_required');
  await verifyEvidenceBindings([spec.request,spec.receipt]);
  const request=await readJson(spec.request.path),receipt=await readJson(spec.receipt.path);
  if(request.execution_kind!=='codex_cli_inference'||request.role!=='director'||request.backend_id!=='codex-cli-chatgpt'
    ||request.input?.stage!==typedStyleUncertaintyStage||request.typed_output_revision!==typedBoundedStyleRevision
    ||request.input.frames?.length||request.submitted_images?.length||request.synthetic_protocol_fixture
    ||receipt.status!=='semantic_invalid'||receipt.detail!=='typed_style_batch_component_range_invalid'
    ||receipt.execution_kind!=='codex_cli_inference'||receipt.cli_invocations!==1||receipt.repair_of||receipt.synthetic_protocol_fixture
    ||receipt.request_sha256!==shaBytes(canonical(request))||!same(receipt.request,spec.request)
    ||receipt.model_revision!==request.model_revision||receipt.model_requested!==request.model_requested
    ||receipt.source_video_sha256!==request.source_video_sha256||request.input.data.source_video_sha256!==request.source_video_sha256
    ||receipt.submitted_image_count!==0||receipt.caller_semantic_validator_used!==true
    ||receipt.qualified!==false||receipt.artistic_approval!==false||receipt.production_approval!==false)fail('actual_range_rejection_required');
  await verifyEvidenceBindings([receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,receipt.stderr,
    receipt.host_cli_resolution,request.worker_instructions,receipt.worker_instructions,...request.input_bindings]);
  const resolution=await readJson(receipt.host_cli_resolution.path);
  if(resolution.injected===true||!['configured_path','verified_application_fallback'].includes(resolution.resolution_kind)
    ||receipt.command!==resolution.actual_path||request.worker_profile!=='structured_evidence_v2'
    ||request.worker_profile!==receipt.worker_profile||request.worker_instructions.sha256!==receipt.worker_instructions.sha256
    ||request.worker_settings?.instructions_sha256!==request.worker_instructions.sha256
    ||!same(request.transport,receipt.transport))fail('original_worker_cli_or_transport_changed');
  const value=await readJson(receipt.final.path),schema=typedStyleExpandedProviderSchema(request.input.schema);
  validateSchema(value,schema);
  const projected=projectTypedStyleModelInput(request.input);
  const {baseStructuredEvidencePrompt}=await import('./codex_cli_runtime.mjs');
  if(!same(await readJson(receipt.schema.path),typedStyleProviderSchema(request.input.schema))
    ||await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projected.input))fail('original_schema_or_prompt_changed');
  if(receipt.typed_consumer_projection){await verifyEvidenceBindings(receipt.typed_consumer_projection);
    if(!same(await readJson(receipt.typed_consumer_projection.path),projected.audit))fail('original_projection_changed');}
  const events=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const turns=events.filter(row=>row.type==='turn.completed');
  if(!completedBatchEventsValid(events,receipt,{finalBytes:await readFile(receipt.final.path),schema})||turns.length!==1
    ||!same(JSON.parse(events.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null'),value)
    ||receipt.usage?.reported_turns!==1||!same(receipt.usage.tokens,turns[0].usage))fail('original_actual_final_completion_or_usage_changed');
  await compareCompletedTypedUncertaintyIntents(request.input,request.input);
  let rejected=false;try{validateTypedStyleBatch(value,request.input);}catch(error){
    if(error.message!=='typed_style_batch_component_range_invalid')throw error;rejected=true;}
  if(!rejected)fail('actual_invalid_component_range_required');
  return{binding,spec,request,receipt,value};
}

export function prepareTypedUnknownRangeFields(original){
  const data=expandTypedStyleTables(expandTypedStyleLiterals(structuredClone(original.request.input)).data);
  const affected=[];
  for(const row of original.value.uncertainty_dispositions){
    const selected=data.selected_uncertainties.find(item=>key(item)===key(row));
    if(!selected)fail('original_global_row_changed');
    const chars=Array.from(selected.text);let end=0,invalid=false;
    for(const component of row.components){const range=component.text_range===null?[0,chars.length]:component.text_range;
      if(!Array.isArray(range)||range.length!==2||range.some(n=>!Number.isSafeInteger(n))
        ||range[0]!==end||range[1]<=range[0]||range[1]>chars.length)invalid=true;
      end=range?.[1];}
    if(end!==chars.length&&!(end===chars.length-1&&chars[end]==='。'))invalid=true;
    if(invalid)affected.push({origin:row.origin,uncertainty_index:row.uncertainty_index,original_text:selected.text,
      unicode_length:chars.length,unicode_positions:chars.map((text,index)=>[index,text]),
      original_scope:original.value.uncertainty_scopes.find(item=>key(item)===key(row)),
      frozen_components:structuredClone(row.components)});
    else{
      const input=structuredClone(original.request.input);input.data.selected_uncertainties=[selected];
      for(const field of ['uncertainty_scopes','uncertainty_dispositions']){
        input.schema.properties[field].minItems=1;input.schema.properties[field].maxItems=1;
      }
      const value=Object.fromEntries(['uncertainty_scopes','uncertainty_dispositions'].map(field=>[field,
        original.value[field].filter(item=>key(item)===key(row))]));
      validateTypedStyleBatch(value,input);
    }
  }
  if(affected.length!==1)fail('one_invalid_global_row_required');
  const row=affected[0],count=row.frozen_components.length;
  const schema=objectSchema({uncertainty_scopes:{type:'array',maxItems:0,items:objectSchema({})},
    uncertainty_dispositions:{type:'array',minItems:1,maxItems:1,items:objectSchema({origin:{type:'string',enum:[row.origin]},
      uncertainty_index:{type:'integer',enum:[row.uncertainty_index]},components:{type:'array',minItems:count,maxItems:count,
        items:objectSchema({component_index:{type:'integer',minimum:0,maximum:count-1},
          text_range:{type:'array',minItems:2,maxItems:2,items:{type:'integer',minimum:0,maximum:row.unicode_length}}})}})}});
  const basisIds=new Set(row.frozen_components.flatMap(part=>part.basis.map(basis=>basis.story_beat_id)));
  const cueIds=new Set(row.frozen_components.flatMap(part=>part.condition_refs.map(ref=>ref.cue_id)));
  const input={stage:typedStyleUncertaintyStage,schema,frames:[],host_contract:{revision:typedUnknownRangeRecoveryRevision},
    prompt:'Repair ONLY text_range of the one listed original global uncertainty row. Return uncertainty_scopes=[] and uncertainty_dispositions containing only origin/index and each frozen component_index/text_range. '
      +'Use Unicode code-point indexes (the supplied unicode_positions), half-open [start,end). In original component order the ranges must cover the complete original text exactly once, starting 0 and ending unicode_length, with no gaps, overlap, empty component or extra character. '
      +'Choose boundaries that correspond to each unchanged component classification, reason and retained constraints. Do not alter text, classifications, stages, scope, story basis, conditions, route, material choices or any sibling uncertainty. No factual, listening or production approval is granted. If the frozen classifications cannot truthfully cover the text, do not disguise the incompatibility with a range; the unchanged semantic validator must reject it.',
    data:{source_video_sha256:original.request.source_video_sha256,range_recovery_revision:typedUnknownRangeRecoveryRevision,
      original_failed_request:original.spec.request,original_semantic_rejection:original.spec.receipt,
      original_full_direction_request:data.full_direction_request,original_completed_route:data.completed_route,
      selected_original_row:row,global_route_summary:data.global_route_summary,
      original_basis_beats:data.analysis.story_beats.filter(beat=>basisIds.has(beat.id)),
      original_cue_conditions:data.cue_context.filter(cue=>cueIds.has(cue.cue_id)).map(cue=>({...cue,
        case_conditions:Object.hasOwn(cue.case_conditions??{},'condition_row')?data.cue_condition_table[cue.case_conditions.condition_row]:cue.case_conditions,
        ...(cue.exclude_case_conditions?{exclude_case_conditions:cue.exclude_case_conditions.map(condition=>Object.hasOwn(condition??{},'condition_row')
          ?data.cue_condition_table[condition.condition_row]:condition)}:{})})),
      qualified:false,sound_facts_approved:false,artistic_approval:false,production_approval:false}};
  return{original,input,affected};
}
export async function prepareTypedUnknownRangeRecovery(binding){return prepareTypedUnknownRangeFields(await rejectedBatch(binding));}
export async function resolvePersistedFailedUnknownRange(binding,{source,episodeRoot,outputDirectory}){
  if(!path.isAbsolute(outputDirectory??''))fail('absolute_recovery_scope_required');
  const{readAutomaticStageFailure}=await import('./automatic_stage_failure_evidence.mjs');
  const document=await readAutomaticStageFailure(binding,{stage:'direction',source,episodeRoot});
  if(document.capture_errors.length)fail('unverified_failure_references_cannot_restore');
  const primary=document.primary_receipt;
  if(!primary)return{status:'no_recorded_terminal_unknown_range_failure',new_model_calls:0};
  const receipt=await readJson(primary.path);
  if(receipt.status!=='semantic_invalid'||receipt.detail!=='typed_style_batch_component_range_invalid'
    ||receipt.execution_kind!=='codex_cli_inference'||!receipt.request)
    return{status:'recorded_failure_requires_other_recovery',new_model_calls:0};
  const spec=await immutable(path.join(outputDirectory,'unknown-range-'+primary.sha256+'-source-spec.json'),
    {kind:'actual_typed_unknown_range_repair_input',request:receipt.request,receipt:primary});
  const prepared=await prepareTypedUnknownRangeRecovery(spec);
  if(prepared.original.request.source_video_sha256!==source.sha256)fail('verified_failed_source_changed');
  return{status:'bound_failed_unknown_range_recovery_prepared',revision:typedUnknownRangeRecoveryRevision,binding:spec,
    failure_evidence:binding,completed_route:prepared.original.request.input.data.completed_route,
    strict_current_intent_comparison_still_required:true,new_model_calls:0,old_outcomes_and_account_usage_unchanged:true,
    qualified:false,artistic_approval:false,production_approval:false};
}
export async function validateTypedUnknownRangeRecoveryIntent(prepared,input,{expectedModelRevision=null}={}){
  if(expectedModelRevision&&prepared.original.request.model_revision!==expectedModelRevision)fail('original_model_revision_changed');
  return compareCompletedTypedUncertaintyIntents(prepared.original.request.input,input);
}
export function mergeTypedUnknownRangeRecovery(prepared,patch){
  validateSchema(patch,prepared.input.schema);const target=prepared.affected[0],row=patch.uncertainty_dispositions[0];
  if(row.components.some((part,index)=>part.component_index!==index))fail('component_identity_order_changed');
  const value=structuredClone(prepared.original.value),changed=value.uncertainty_dispositions.find(item=>key(item)===key(target));
  changed.components.forEach((part,index)=>{part.text_range=[...row.components[index].text_range];});
  validateTypedStyleBatch(value,prepared.original.request.input);
  return value;
}

async function checkedPatch(prepared,binding){
  const checked=await verifyActualBatch(binding,prepared.original.request.source_video_sha256),{raw,request}=checked;
  if(raw.model_revision!==prepared.original.request.model_revision||!same(request.input,prepared.input)
    ||raw.cli_receipts?.length!==1||(raw.historical_cli_receipts??[]).length)fail('one_actual_range_patch_required');
  const receipt=await readJson(raw.cli_receipts[0].path);
  await verifyEvidenceBindings([request.worker_instructions,receipt.worker_instructions,receipt.host_cli_resolution,...request.input_bindings]);
  if(request.worker_profile!==prepared.original.request.worker_profile
    ||request.worker_instructions.sha256!==prepared.original.request.worker_instructions.sha256
    ||request.worker_settings?.instructions_sha256!==request.worker_instructions.sha256
    ||receipt.worker_instructions.sha256!==request.worker_instructions.sha256
    ||receipt.worker_profile!==request.worker_profile||!same(request.transport,prepared.original.request.transport)
    ||!same(receipt.transport,request.transport)||receipt.repair_of||![0,1].includes(receipt.configured_max_repairs)
    ||receipt.stage_repair_limit!==0||receipt.caller_semantic_validator_used!==true)fail('range_patch_worker_transport_or_repair_policy_changed');
  mergeTypedUnknownRangeRecovery(prepared,raw.value);return checked;
}
export async function finalizeTypedUnknownRangeRecovery(prepared,patch,{input,directory}={}){
  if(!path.isAbsolute(directory??'')||!input)fail('bound_current_input_and_output_required');
  const verified=await prepareTypedUnknownRangeRecovery(prepared.original.binding);
  if(!same(prepared.input,verified.input)||!same(prepared.original.value,verified.original.value)
    ||!same(prepared.original.spec,verified.original.spec))fail('prepared_original_or_range_intent_changed');
  prepared=verified;
  await validateTypedUnknownRangeRecoveryIntent(prepared,input,{expectedModelRevision:patch.model_revision});
  const actual=await checkedPatch(prepared,patch.raw_response);
  const current=await immutable(path.join(directory,'batch-input.json'),input),impl={path:implementation,sha256:await hashFile(implementation)};
  const raw={...actual.raw,value:mergeTypedUnknownRangeRecovery(prepared,actual.raw.value),
    completion_origin:'actual_model_range_patch_and_original_failed_batch_host_merge',
    host_typed_unknown_range_merge:{revision:typedUnknownRangeRecoveryRevision,original_failed_batch:prepared.original.binding,
      original_request:prepared.original.spec.request,original_execution_receipt:prepared.original.spec.receipt,
      patch_response:patch.raw_response,current_batch_input:current,implementation:impl,
      edited_fields:'only_one_original_global_row_components_text_range',original_row:key(prepared.affected[0]),
      original_classifications_scopes_text_facts_and_other_rows_unchanged:true,original_failure_unchanged:true,qualification_granted:false},
    request_sha256:prepared.original.receipt.request_sha256,input_sha256:prepared.original.request.input_sha256,
    usage:prepared.original.receipt.usage,usage_origin:'original_rejected_batch_patch_usage_in_constituent_receipts',
    cli_receipts:actual.raw.cli_receipts,historical_cli_receipts:[prepared.original.spec.receipt],
    evidence_files:[...actual.raw.evidence_files,current,impl,prepared.original.binding,prepared.original.spec.request,
      prepared.original.spec.receipt,prepared.original.receipt.final,...prepared.original.request.input_bindings],new_model_calls:1};
  const binding=await immutable(path.join(directory,'response.json'),raw);
  return{...raw,raw_response:binding,reused:patch.reused===true,
    ...(patch.reused===true?{cli_receipts:[],historical_cli_receipts:[...raw.historical_cli_receipts,...raw.cli_receipts],new_model_calls:0}:{})};
}
export async function loadTypedUnknownRangeRecovery(binding,{input,expectedModelRevision=null}={}){
  await verifyEvidenceBindings(binding);const raw=await readJson(binding.path),proof=raw.host_typed_unknown_range_merge;
  if(proof?.revision!==typedUnknownRangeRecoveryRevision)fail('explicit_range_merge_required');
  await verifyEvidenceBindings([proof.current_batch_input,proof.implementation]);
  if(proof.implementation.sha256!==await hashFile(implementation))fail('range_implementation_changed');
  const prepared=await prepareTypedUnknownRangeRecovery(proof.original_failed_batch),storedInput=await readJson(proof.current_batch_input.path);
  await validateTypedUnknownRangeRecoveryIntent(prepared,storedInput,{expectedModelRevision});
  if(input)await validateTypedUnknownRangeRecoveryIntent(prepared,input,{expectedModelRevision});
  const patch=await checkedPatch(prepared,proof.patch_response);
  // Recompute the full derived record. A caller cannot bless a hand edited
  // batch with a wrapper kind, an approved boolean or a forged corrected range.
  const expected=await finalizeTypedUnknownRangeRecovery(prepared,{...patch.raw,raw_response:proof.patch_response},
    {input:storedInput,directory:path.dirname(binding.path)});
  delete expected.raw_response;delete expected.reused;
  if(!same(raw,expected))fail('range_derived_value_or_proof_changed');
  return{...raw,raw_response:binding,reused:true,cli_receipts:[],
    historical_cli_receipts:[...raw.historical_cli_receipts,...raw.cli_receipts],new_model_calls:0};
}
