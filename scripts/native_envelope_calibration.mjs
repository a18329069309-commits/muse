import path from'node:path';
import{readJson,saveJson,verifyEvidenceBindings}from'./audio_api.mjs';
import{sampleBoundEnvelopeReceipt}from'./nonimage_envelope_calibration.mjs';
const verified=new WeakSet();
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('native_envelope_calibration_'+reason);};
export const nativeEnvelopeRevision='three-native-family-residuals-route-holdout-v1';
const stages=['research_style_route_v1','research_style_uncertainties_v1'];
export function nativeEnvelopeSchemaFamily(schema){const keys=Object.keys(schema?.properties??{}).sort();
 if(schema?.type!=='object'||schema.additionalProperties!==false||keys.includes('business_json'))return null;
 const resolve=node=>{const seen=new Set();while(node?.$ref){if(seen.has(node.$ref)||!node.$ref.startsWith('#/$defs/'))return null;
   seen.add(node.$ref);node=schema.$defs?.[node.$ref.slice(8)];}return node;};
 const typed=(key,type)=>resolve(schema.properties[key])?.type===type;
 const objects=key=>typed(key,'array')&&resolve(resolve(schema.properties[key]).items)?.type==='object';
 if(same(keys,['uncertainty_dispositions','uncertainty_scopes'])&&objects('uncertainty_dispositions')&&objects('uncertainty_scopes'))return'typed_uncertainty_classification';
 if(['cues','boundary_events','direction_version','global_route_summary','uncertainties'].every(key=>keys.includes(key))
   &&objects('cues')&&objects('boundary_events')&&typed('direction_version','integer')&&typed('global_route_summary','string')
   &&typed('uncertainties','array')&&resolve(resolve(schema.properties.uncertainties).items)?.type==='string'
   &&!keys.includes('uncertainty_scopes')&&!keys.includes('uncertainty_dispositions'))return'typed_complete_story_route';return null;}
const nativeCoreRevision=value=>value?.replace(/:stage-reasoning-[a-z]+$/,'').replace(/:continuous-4x4-v1$/,'');
const common=row=>{const result=structuredClone(row.profile);delete result.wire_schema_sha256;
 result.model_revision=nativeCoreRevision(result.model_revision);
 return{...result,reasoning_effort:row.reasoning_effort,native_strict_json_schema:true};};
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
async function observations(receipts,holdout){
 if(!Array.isArray(receipts)||receipts.length!==3||new Set(receipts.map(ref=>ref.sha256)).size!==3)fail('three_distinct_fit_samples_required');
 const samples=[];for(const ref of receipts)samples.push(await sampleBoundEnvelopeReceipt(ref,{nativeFamily:true}));
 const held=await sampleBoundEnvelopeReceipt(holdout.receipt,{nativeFamily:true,nativeTerminalRecovery:holdout.native_terminal_recovery});
 const all=[...samples,held];
 if(new Set(all.map(row=>row.execution_request_sha256)).size!==4||new Set(all.map(row=>row.execution_jsonl_sha256)).size!==4)fail('four_distinct_actual_executions_required');
 if(samples.some(row=>row.stage!=='research_style_uncertainties_v1')||held.stage!=='research_style_route_v1'
   ||all.some(row=>!same(common(row),common(samples[0]))))fail('native_runtime_or_stage_family_mismatch');
 for(const row of all){const schema=await readJson(row.schema.path);const expected=row.stage===stages[0]?'typed_complete_story_route':'typed_uncertainty_classification';
   if(nativeEnvelopeSchemaFamily(schema)!==expected)fail('native_schema_family_required');row.schema_family=expected;}
 const allowance=Math.max(...samples.map(row=>row.empirical_residual_tokens))+1024;
 const predicted=Object.values(held.estimated_visible_components).reduce((sum,value)=>sum+value,0)+allowance;
 if(predicted<held.actual_input_tokens)fail('heldout_native_route_underestimated');
 return{samples,holdout:held,profile:common(samples[0]),residual_cli_allowance_tokens:allowance,
   holdout_predicted_complete_tokens:predicted,holdout_actual_input_tokens:held.actual_input_tokens};
}
export async function createNativeEnvelopeCalibration({receipts,holdout,outputFile}){
 const measured=await observations(receipts,holdout),record={schema_version:1,kind:'bound_native_schema_family_envelope_calibration',
   revision:nativeEnvelopeRevision,allowed_stages:stages,schema_families:['typed_complete_story_route','typed_uncertainty_classification'],
   ...measured,margin_tokens:1024,holdout_definition:'native_route_execution_not_used_for_fit',
   allowance_includes_input_estimation_error:true,exact_schema_equality_claimed:false,exact_tokenizer_or_sdk_context_decomposition_claimed:false,
   guaranteed_provider_token_ceiling:false,professional_qualification_granted:false,production_approval:false};
 record.historical_bytes_verified=false;record.experimental_estimate=true;record.noimage_contact_layout_cache_tag_excluded=true;
 const binding=await saveJson(outputFile,record);return loadNativeEnvelopeCalibration(binding);
}
export async function loadNativeEnvelopeCalibration(binding){
 await verifyEvidenceBindings(binding);const record=await readJson(binding.path);
 if(record.kind!=='bound_native_schema_family_envelope_calibration'||record.schema_version!==1||record.revision!==nativeEnvelopeRevision
   ||record.margin_tokens!==1024||!same(record.allowed_stages,stages)||!same(record.schema_families,['typed_complete_story_route','typed_uncertainty_classification'])
   ||record.holdout_definition!=='native_route_execution_not_used_for_fit'||record.allowance_includes_input_estimation_error!==true
   ||record.exact_schema_equality_claimed!==false||record.exact_tokenizer_or_sdk_context_decomposition_claimed!==false
   ||record.guaranteed_provider_token_ceiling!==false||record.professional_qualification_granted!==false||record.production_approval!==false)fail('explicit_experimental_native_profile_required');
 if(record.historical_bytes_verified!==false||record.experimental_estimate!==true||record.noimage_contact_layout_cache_tag_excluded!==true)fail('historical_and_experimental_limits_required');
 const recomputed=await observations(record.samples.map(row=>row.receipt),{receipt:record.holdout.receipt,native_terminal_recovery:record.holdout.native_terminal_recovery});
 for(const[key,value]of Object.entries(recomputed))if(!same(value,record[key]))fail('actual_evidence_or_calculation_changed');
 const result={...record,binding:structuredClone(binding)};
 Object.defineProperty(result,'nativeAllowance',{enumerable:false,value:options=>{
   if(!verified.has(result))fail('verified_runtime_object_required');if(options.frames?.length)return null;
   const expected=options.stage===stages[0]?'typed_complete_story_route':options.stage===stages[1]?'typed_uncertainty_classification':null;
   if(!expected)return null;const family=nativeEnvelopeSchemaFamily(options.schema);if(options.schema&&family!==expected)fail('native_wire_family_mismatch');
   const profile=result.profile,actualCli=options.cli?structuredClone(options.cli):null;
   if(actualCli&&profile.cli.recorded_executable_sha256===null){if(actualCli.recorded_executable_sha256!==null
     &&actualCli.recorded_executable_sha256!==profile.cli.current_executable_sha256)fail('native_runtime_profile_mismatch');actualCli.recorded_executable_sha256=null;}
   if(options.modelRevision&&(nativeCoreRevision(options.modelRevision)!==profile.model_revision||!options.modelRevision.endsWith(':stage-reasoning-low'))
     ||options.workerProfile&&options.workerProfile!==profile.worker_profile||options.instructionsSha256&&options.instructionsSha256!==profile.instructions_sha256
     ||options.transport&&!same(options.transport,profile.transport)||actualCli&&!same(actualCli,profile.cli)
     ||options.cwd&&path.resolve(options.cwd)!==path.resolve(profile.cwd))fail('native_runtime_profile_mismatch');
   return{allowance:result.residual_cli_allowance_tokens,calibration:result.binding,revision:result.revision,
     schema_family:family,preflight_profile_only_when_identity_omitted:!options.cli,
     exact_schema_equality_claimed:false,experiment_only_not_provider_token_ceiling:true};}});
 freeze(result);verified.add(result);return result;
}
