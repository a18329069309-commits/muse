import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {readJson,saveJson,shaBytes,verifyEvidenceBindings} from './audio_api.mjs';
import {validateRestoredCompactBusinessValue} from './compact_business_contract.mjs';
import {prepareTypedStyleContract,typedStyleUnknownItems,buildTypedStyleUncertaintyBatch,
  validateTypedStyleBatch,mergeTypedStyleResult} from './typed_bounded_style_director.mjs';
import {verifyActualBatch,loadBoundDirectionExecutionEvidence,produceBoundDirectionExecutionEvidence,
  reloadDirectionExecutionBasis} from './bound_direction_execution_evidence.mjs';
import {inspectDirectionUncertainties,directionSemanticGaps} from './direction_semantics.mjs';
import {loadNativeRouteAnchorRecovery,loadCompletedNativeRoute} from './native_route_anchor_recovery.mjs';

export const selectedUnknownRecoveryRevision='actual-selected-global-unknown-recovery-v1';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),key=row=>`${row.origin}/${row.uncertainty_index}`;
const fail=reason=>{throw Error('selected_unknown_recovery_'+reason);};
async function immutable(file,value){
 try{return await saveJson(file,value);}catch(error){if(error.code!=='EEXIST')throw error;
  if(!same(await readJson(file),value))fail('existing_record_changed');
  return{path:path.resolve(file),sha256:shaBytes(await readFile(file))};}
}
const pair=(value,id)=>Object.fromEntries(['uncertainty_scopes','uncertainty_dispositions'].map(field=>[field,value[field].filter(row=>key(row)===id)]));
const allReceipts=rows=>[...new Map(rows.flatMap(row=>[...(row.historical_cli_receipts??[]),...(row.cli_receipts??[])])
 .map(ref=>[ref.sha256,ref])).values()];
async function fullIdentity(input){
 const value=structuredClone(input),source=value.data?.source_video_sha256;
 // Request files remain hash-verified. Compare their bound facts separately
 // from the response schema, which may receive a compatible host-only fix.
 delete value.schema;delete value.response_schema;
 for(const field of ['completed_story','source_frame_mapping']){
  const ref=value.data[field];if(!ref)fail('complete_story_and_frames_required');await verifyEvidenceBindings(ref);
  const stored=await readJson(ref.path);if(stored.source_video_sha256!==source)fail('bound_story_or_frames_source_changed');
  if(field==='completed_story'){
   const analysis=stored.value??stored;if(!same(analysis,value.data.analysis))fail('bound_story_facts_changed');
   value.data[field]={verified_analysis:analysis};
  }else{
   if(!Array.isArray(stored.source_frames)||!stored.source_frames.length)fail('bound_actual_frames_required');
   await verifyEvidenceBindings(stored.source_frames);value.data[field]={verified_source_frames:stored.source_frames};
  }
 }
 const prior=value.data.host_execution_notes?.prior_story;
 if(prior){await verifyEvidenceBindings(prior);const stored=await readJson(prior.path);
  if(stored.source_video_sha256!==source||!same(stored.value??stored,value.data.analysis))fail('prior_story_facts_changed');
  value.data.host_execution_notes.prior_story={verified_analysis:value.data.analysis};}
 return value;
}

export async function prepareSelectedUnknownRecovery(binding){
 await verifyEvidenceBindings(binding);const spec=await readJson(binding.path);
 if(spec.kind!=='actual_selected_unknown_repair_input'||!Array.isArray(spec.completed_batches)||!spec.completed_batches.length)fail('explicit_actual_input_required');
 await verifyEvidenceBindings([spec.projected_input,spec.completed_route,...(spec.execution_basis?[spec.execution_basis]:[]),...spec.completed_batches]);
 const original=await readJson(spec.projected_input.path),prepared=await prepareTypedStyleContract(original),source=original.data.source_video_sha256;
 const fullBinding=original.data.independent_style_projection?.full_request;
 if(!fullBinding)fail('bound_full_input_required');await verifyEvidenceBindings(fullBinding);const full=await readJson(fullBinding.path);
 if(full.data.source_video_sha256!==source||full.data.analysis.source_video_sha256!==source)fail('full_input_source_changed');
 const route=await loadNativeRouteAnchorRecovery(spec.completed_route),routeRaw=await readJson(spec.completed_route.path);
 const routeOriginal=routeRaw.host_route_anchor_merge
  ?await loadCompletedNativeRoute(routeRaw.host_route_anchor_merge.original_completed_route)
  :await(await import('./native_route_boundary_recovery.mjs')).loadUnadoptedNativeBoundaryRoute(
   routeRaw.host_single_cue_boundary_normalization?.original_route??routeRaw.host_boundary_merge?.original_route);
 if(!same(await fullIdentity(routeOriginal.full),await fullIdentity(full))||route.source_video_sha256!==source
  ||directionSemanticGaps(route.value,full.data.analysis).length)fail('actual_route_facts_changed');
 const items=typedStyleUnknownItems(prepared,route.value),batches=[],batchSources=[];let start=0;
 for(const ref of spec.completed_batches){
  const actual=await verifyActualBatch(ref,source),count=actual.input.data.selected_uncertainties.length;
  if(actual.raw.model_revision!==route.model_revision||actual.input.data.completed_route?.sha256!==spec.completed_route.sha256)fail('actual_batch_route_or_model_changed');
  const expected=buildTypedStyleUncertaintyBatch(prepared,route.value,actual.input.data.completed_route,items.slice(start,start+count),
   {maximumItems:actual.input.data.uncertainty_batch.maximum_items??8,
    semanticPreflight:Boolean(actual.input.data.uncertainty_batch.semantic_contract_revision)});
  // Compare original serialized request; the verifier's expanded view is for lookup only.
  if(!same(actual.request.input,expected))fail('actual_batch_input_changed');
  validateTypedStyleBatch(actual.raw.value,expected);batches.push({...actual.raw,raw_response:ref});
  batchSources.push({actual_raw_response:ref,request:actual.requestBinding});start+=count;
 }
 if(start!==items.length)fail('all_original_items_required');
 // A malformed model range/reference remains an unadopted row. Decode each
 // exact global row independently so it cannot hide valid sibling responses.
 const errors=[],validPairs=[],validSources=[];
 for(const item of items){const index=batches.findIndex(row=>row.value.uncertainty_dispositions.some(value=>key(value)===key(item)));
  if(index<0)fail('original_item_missing');const single=pair(batches[index].value,key(item));
  try{mergeTypedStyleResult(prepared,route.value,[single],{encodingAudit:[],batchSources:[batchSources[index]]});
   validPairs.push(single);validSources.push(batchSources[index]);}
  catch(error){if(!['compact_direction_component_range_invalid','compact_direction_basis_reference_invalid','compact_direction_condition_reference_invalid'].includes(error.message))throw error;
   errors.push({origin:item.origin,uncertainty_index:item.uncertainty_index,error:error.message,original_unicode_length:[...item.text].length});}}
 if(!validPairs.length)fail('no_valid_original_rows_for_bounded_recovery');
 const encodingAudit=[],direction=mergeTypedStyleResult(prepared,route.value,validPairs,{encodingAudit,batchSources:validSources});
 let executionBasis=null;
 if(spec.execution_basis){const review=await readJson(spec.execution_basis.path);
  if(review.input.sha256!==fullBinding.sha256||!same(await readJson(review.direction.path),direction))fail('original_execution_basis_changed');
  executionBasis=await loadBoundDirectionExecutionEvidence(spec.execution_basis,{sourceSha:source,inputBinding:review.input,input:full,
   directionBinding:review.direction,direction,mode:'assisted_trial'});}
 for(const row of direction.uncertainty_dispositions){const scope=direction.uncertainty_scopes.find(item=>key(item)===key(row));
  try{inspectDirectionUncertainties({...direction,uncertainty_scopes:[scope],uncertainty_dispositions:[row]},full.data.analysis,{mode:'assisted_trial',executionBasis});}
  catch(error){if(!/^direction_(?:uncertainty_|pending_work_|evidence_gap_)/.test(error.message))throw error;
   errors.push({origin:row.origin,uncertainty_index:row.uncertainty_index,error:error.message});}}
 if(!errors.length||errors.length>16)fail('one_bounded_invalid_batch_required');
 const selectedIds=new Set(errors.map(key)),selected=items.filter(row=>selectedIds.has(key(row)));
 const input=buildTypedStyleUncertaintyBatch(prepared,route.value,spec.completed_route,selected,{maximumItems:16});
 const errorCodes=[...new Set(errors.map(row=>row.error))];
 input.data.selected_recovery_errors={columns:['origin_index','global_index','error_code_index','original_unicode_length'],
  origins:['analysis','direction'],error_codes:errorCodes,
  rows:errors.map(row=>[row.origin==='analysis'?0:1,row.uncertainty_index,errorCodes.indexOf(row.error),row.original_unicode_length??null])};
 input.data.selected_recovery_source=binding;
 input.prompt+=' Correct selected_recovery_errors: labelled rows use origins/error_codes lookup and original Unicode lengths. Preserve original text, constraints and global IDs.';
 return{binding,spec,original,prepared,full,fullBinding,source,route,batches,batchSources,items,direction,executionBasis,errors,selectedIds,input};
}

export function mergeSelectedUnknownRecovery(prepared,patch,{patchBinding=null,patchRequest=null}={}){
 validateTypedStyleBatch(patch,prepared.input);
 const values=[],sources=[];
 for(const item of prepared.items){const id=key(item),oldIndex=prepared.batches.findIndex(row=>row.value.uncertainty_dispositions.some(value=>key(value)===id));
  if(oldIndex<0)fail('original_item_missing');const changed=prepared.selectedIds.has(id);
  values.push(pair(changed?patch:prepared.batches[oldIndex].value,id));
  sources.push(changed?{actual_raw_response:patchBinding,request:patchRequest}:prepared.batchSources[oldIndex]);}
 const encodingAudit=[],value=mergeTypedStyleResult(prepared.prepared,prepared.route.value,values,{encodingAudit,batchSources:sources});
 const exclude=source=>{source=structuredClone(source);delete source.uncertainty_scopes;delete source.uncertainty_dispositions;return source;};
 if(!same(exclude(value),exclude(prepared.direction)))fail('route_or_original_facts_changed');
 for(const field of ['uncertainty_scopes','uncertainty_dispositions'])for(const original of prepared.direction[field])
  if(!prepared.selectedIds.has(key(original))&&!same(original,value[field].find(row=>key(row)===key(original))))fail('unselected_item_changed');
 validateRestoredCompactBusinessValue(value,prepared.prepared.contract);
 return{value,encodingAudit};
}

export async function finalizeSelectedUnknownRecovery(prepared,patch,{directory,validateValue}={}){
 const actual=await verifyActualBatch(patch.raw_response,prepared.source);
 if(!same(actual.request.input,prepared.input)||actual.raw.model_revision!==prepared.route.model_revision)fail('actual_patch_input_or_model_changed');
 if([...(actual.raw.cli_receipts??[]),...(actual.raw.historical_cli_receipts??[])].length!==1)fail('one_actual_patch_required');
 const merged=mergeSelectedUnknownRecovery(prepared,actual.raw.value,{patchBinding:patch.raw_response,patchRequest:actual.requestBinding});
 const valueBinding=await immutable(path.join(directory,'full-direction.json'),merged.value);
 const effectiveBatches=prepared.batches.map(row=>({...row,value:Object.fromEntries(['uncertainty_scopes','uncertainty_dispositions']
  .map(field=>[field,row.value[field].filter(item=>!prepared.selectedIds.has(key(item)))]))}));
 const produced=await produceBoundDirectionExecutionEvidence({inputBinding:prepared.fullBinding,input:prepared.full,directionBinding:valueBinding,
  direction:merged.value,batchResponses:[...effectiveBatches,{...actual.raw,raw_response:patch.raw_response}],outputFile:path.join(directory,'execution-basis.json'),mode:'assisted_trial'});
 const {createCodexStyleSemanticValidator}=await import('./compose_codex_episode.mjs');
 await createCodexStyleSemanticValidator(prepared.original,{mode:'assisted_trial',executionBasis:produced.executionBasis})(merged.value);
 await validateValue?.(merged.value,{executionBasis:produced.executionBasis});
 const historical=allReceipts([prepared.route,...prepared.batches,actual.raw]);
 const raw={...actual.raw,value:merged.value,direction_execution_basis:produced.binding,usage:null,usage_is_in_constituent_receipts:true,
  host_selected_unknown_merge:{revision:selectedUnknownRecoveryRevision,original_input:prepared.binding,actual_patch_response:patch.raw_response,
   affected_global_ids:prepared.errors.map(key),other_items_unchanged:true,source_facts_or_clocks_changed:false,
   encoding_recoveries:merged.encodingAudit,complete_original_semantic_validator_used:true},
  historical_cli_receipts:historical,cli_receipts:[],reused:false,
  evidence_files:[...new Map([prepared.binding,prepared.spec.projected_input,prepared.spec.completed_route,...prepared.spec.completed_batches,
   ...(prepared.spec.execution_basis?[prepared.spec.execution_basis]:[]),patch.raw_response,...actual.raw.evidence_files,valueBinding,...(produced.binding?[produced.binding]:[])]
   .map(ref=>[ref.sha256,ref])).values()]};
 delete raw.raw_response;
 const binding=await immutable(path.join(directory,'approved-direction-response.json'),raw);
 return{...raw,raw_response:binding,cli_receipts:patch.cli_receipts??[],
  historical_cli_receipts:historical.filter(ref=>!(patch.cli_receipts??[]).some(actual=>actual.sha256===ref.sha256)),reused:patch.reused===true};
}

export async function loadSelectedUnknownRecovery(binding,{input,validateValue,expectedModelRevision}={}){
 await verifyEvidenceBindings(binding);const raw=await readJson(binding.path),merge=raw.host_selected_unknown_merge;
 if(merge?.revision!==selectedUnknownRecoveryRevision||merge.other_items_unchanged!==true||merge.source_facts_or_clocks_changed!==false
  ||merge.complete_original_semantic_validator_used!==true||raw.execution_kind!=='codex_cli_inference'||raw.actual_runtime_executed!==true
  ||raw.actual_input_processed!==true||raw.actual_audio_processed!==false||raw.actual_video_processed!==false||raw.actual_frames_submitted!==0
  ||raw.qualified!==false||raw.production_approval!==false||raw.artistic_approval!==false||raw.completion_status!=='complete'
  ||expectedModelRevision&&raw.model_revision!==expectedModelRevision)fail('actual_merged_response_required');
 await verifyEvidenceBindings(raw.evidence_files);const prepared=await prepareSelectedUnknownRecovery(merge.original_input);
 const patch=await verifyActualBatch(merge.actual_patch_response,prepared.source);
 if(!same(patch.request.input,prepared.input)||raw.source_video_sha256!==prepared.source||raw.model_revision!==patch.raw.model_revision
  ||raw.model_revision!==prepared.route.model_revision||raw.model!==patch.raw.model||raw.backend_id!==patch.raw.backend_id
  ||raw.request_sha256!==patch.raw.request_sha256||!same(merge.affected_global_ids,prepared.errors.map(key)))fail('merged_patch_identity_changed');
 if([...(patch.raw.cli_receipts??[]),...(patch.raw.historical_cli_receipts??[])].length!==1
  ||!same(raw.historical_cli_receipts,allReceipts([prepared.route,...prepared.batches,patch.raw]))
  ||raw.cli_receipts?.length!==0||raw.usage!==null||raw.usage_is_in_constituent_receipts!==true)fail('merged_accounting_changed');
 const value=mergeSelectedUnknownRecovery(prepared,patch.raw.value,{patchBinding:merge.actual_patch_response,patchRequest:patch.requestBinding});
 if(!same(value.value,raw.value)||!same(value.encodingAudit,merge.encoding_recoveries))fail('merged_value_changed');
 if(input){
  const ref=input.data?.independent_style_projection?.full_request;let full=input;
  if(ref){await verifyEvidenceBindings(ref);full=await readJson(ref.path);}
  if(!same(await fullIdentity(full),await fullIdentity(prepared.full)))fail('current_full_input_changed');
 }
 if(raw.direction_execution_basis){await verifyEvidenceBindings(raw.direction_execution_basis);const basis=await readJson(raw.direction_execution_basis.path);
  await verifyEvidenceBindings([basis.input,basis.direction]);
  if(!same(await readJson(basis.direction.path),raw.value)||!same(await fullIdentity(await readJson(basis.input.path)),await fullIdentity(prepared.full)))fail('merged_execution_basis_changed');}
 const executionBasis=await reloadDirectionExecutionBasis(raw.direction_execution_basis,{sourceSha:prepared.source,input:prepared.full,
  analysis:prepared.full.data.analysis,mode:'assisted_trial'});
 const {createCodexStyleSemanticValidator}=await import('./compose_codex_episode.mjs');
 await createCodexStyleSemanticValidator(prepared.original,{mode:'assisted_trial',executionBasis})(raw.value);
 await validateValue?.(raw.value,{executionBasis});
 return{...raw,raw_response:binding,reused:true,cli_receipts:[],historical_cli_receipts:raw.historical_cli_receipts,new_model_calls:0};
}
