import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {readJson,saveJson,shaBytes,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
export const automaticStageFailureEvidenceRevision='source-bound-automatic-stage-failure-v1';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
 ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('automatic_stage_failure_'+reason);};
const within=(file,directory)=>{const relative=path.relative(path.resolve(directory),path.resolve(file));
 return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const summary=receipt=>({status:receipt.status??null,detail:receipt.detail??null,execution_kind:receipt.execution_kind??null,
 source_video_sha256:receipt.source_video_sha256??null,request:receipt.request??null,request_sha256:receipt.request_sha256??null,
 model_revision:receipt.model_revision??null,cli_invocations:receipt.cli_invocations??null,usage:receipt.usage??null,
 qualified:receipt.qualified??null,artistic_approval:receipt.artistic_approval??null,production_approval:receipt.production_approval??null});
async function immutable(file,value){try{return await saveJson(file,value);}catch(error){if(error.code!=='EEXIST')throw error;
 if(!same(await readJson(file),value))fail('immutable_record_changed');return{path:path.resolve(file),sha256:shaBytes(await readFile(file))};}}

// Preserve directly reported child references only. No directory discovery,
// inferred completed call, model submission or qualification takes place here.
export async function captureAutomaticStageFailure(error,{stage,source,episodeRoot,stageDirectory,outputFile}){
 if(!stage||!path.isAbsolute(episodeRoot??'')||!path.isAbsolute(stageDirectory??'')||!path.isAbsolute(outputFile??''))fail('explicit_stage_scope_required');
 if(!within(stageDirectory,episodeRoot)||!within(outputFile,stageDirectory))fail('failure_record_outside_stage_scope');
 await verifyEvidenceBindings(source);
 const reported=Array.isArray(error.cli_receipts)?structuredClone(error.cli_receipts):[],entries=[],captureErrors=[];
 let primary=null;
 const add=async(ref,label)=>{try{
   if(!path.isAbsolute(ref?.path??'')||!/^[a-f0-9]{64}$/.test(ref.sha256??''))fail('reported_receipt_binding_required');
   await verifyEvidenceBindings(ref);const receipt=await readJson(ref.path);
   if(receipt.request)await verifyEvidenceBindings(receipt.request);
   if(receipt.source_video_sha256&&receipt.source_video_sha256!==source.sha256)fail('reported_receipt_source_changed');
   if(!entries.some(row=>row.binding.sha256===ref.sha256&&path.resolve(row.binding.path)===path.resolve(ref.path)))
     entries.push({binding:{path:path.resolve(ref.path),sha256:ref.sha256},summary:summary(receipt)});
   return{path:path.resolve(ref.path),sha256:ref.sha256};
  }catch(cause){captureErrors.push({label,reference:ref,reason:cause.message});return null;}};
 if(error.receipt_file){if(path.isAbsolute(error.receipt_file)){
   try{primary=await add(await bind(error.receipt_file),'primary');}catch(cause){captureErrors.push({label:'primary',reference:{path:error.receipt_file},reason:cause.message});}
  }else captureErrors.push({label:'primary',reference:{path:error.receipt_file},reason:'absolute_primary_receipt_required'});}
 for(const[index,ref]of reported.entries())await add(ref,'cli_receipts/'+index);
 const document={revision:automaticStageFailureEvidenceRevision,kind:'automatic_stage_failure_evidence',stage,source,
  episode_root:path.resolve(episodeRoot),stage_directory:path.resolve(stageDirectory),
  original_error:{message:error.message??String(error),code:error.code??null,status:error.status??null},
  reported_receipt_file:error.receipt_file??null,reported_cli_receipts:reported,primary_receipt:primary,
  receipt_entries:entries,capture_errors:captureErrors,new_model_calls:0,
  old_outcomes_and_account_usage_unchanged:true,qualified:false,artistic_approval:false,production_approval:false};
 return{binding:await immutable(outputFile,document),document};
}

export async function readAutomaticStageFailure(binding,{stage,source,episodeRoot}={}){
 if(!stage||!path.isAbsolute(episodeRoot??'')||!source)fail('explicit_stage_scope_required');
 await verifyEvidenceBindings(binding);const document=await readJson(binding.path);
 if(document.revision!==automaticStageFailureEvidenceRevision||document.kind!=='automatic_stage_failure_evidence'
  ||document.stage!==stage||!same(document.source,source)
  ||!path.isAbsolute(document.episode_root??'')||!path.isAbsolute(document.stage_directory??'')
  ||path.resolve(document.episode_root)!==path.resolve(episodeRoot)
  ||!within(document.stage_directory,episodeRoot)||!within(binding.path,document.stage_directory)
  ||document.new_model_calls!==0||document.old_outcomes_and_account_usage_unchanged!==true
  ||document.qualified!==false||document.artistic_approval!==false||document.production_approval!==false
  ||!Array.isArray(document.reported_cli_receipts)||!Array.isArray(document.receipt_entries)||!Array.isArray(document.capture_errors))fail('bound_stage_source_and_nonapproval_scope_required');
 await verifyEvidenceBindings(document.source);
 for(const entry of document.receipt_entries){await verifyEvidenceBindings(entry.binding);const receipt=await readJson(entry.binding.path);
  if(receipt.request)await verifyEvidenceBindings(receipt.request);
  if(!same(entry.summary,summary(receipt))||receipt.source_video_sha256&&receipt.source_video_sha256!==source.sha256)fail('recorded_receipt_or_usage_changed');}
 if(document.primary_receipt&&!document.receipt_entries.some(row=>same(row.binding,document.primary_receipt)))fail('primary_receipt_not_recorded');
 return document;
}

// Only the exact terminal failed child is considered. Earlier route failures
// in the same receipt list may have already been repaired and are never picked.
export async function resolvePersistedFailedNativeRoute(binding,{source,episodeRoot,outputDirectory}){
 if(!path.isAbsolute(outputDirectory??'')||!within(outputDirectory,episodeRoot))fail('explicit_recovery_scope_required');
 const document=await readAutomaticStageFailure(binding,{stage:'direction',source,episodeRoot});
 if(document.capture_errors.length)fail('unverified_failure_references_cannot_restore');
 const primary=document.primary_receipt;
 if(!primary)return{status:'no_recorded_terminal_native_route_failure',new_model_calls:0};
 const receipt=await readJson(primary.path);
 if(receipt.status!=='semantic_invalid'||receipt.detail!=='direction_story_or_words_semantics_invalid'
   ||receipt.execution_kind!=='codex_cli_inference'||!receipt.request)return{status:'recorded_failure_requires_other_recovery',new_model_calls:0};
 const request=await readJson(receipt.request.path);
 if(request.input?.stage!=='research_style_route_v1')return{status:'recorded_failure_requires_other_recovery',new_model_calls:0};
 const spec={kind:'actual_native_route_boundary_repair_input',request:receipt.request,receipt:primary};
 const sourceSpec=await immutable(path.join(path.resolve(outputDirectory),'native-route-source-spec.json'),spec);
 const{prepareNativeRouteBoundaryRepair,assertSingleCueBoundaryNormalizationEligible}=await import('./native_route_boundary_recovery.mjs');
 const prepared=await prepareNativeRouteBoundaryRepair(sourceSpec);
 if(prepared.original.request.source_video_sha256!==source.sha256)fail('verified_route_source_changed');
 if(!prepared.cues.length)assertSingleCueBoundaryNormalizationEligible(prepared);
 return{status:'bound_failed_native_route_recovery_prepared',binding:sourceSpec,failure_evidence:binding,
  recovery_kind:prepared.cues.length?'actual_boundary_patch_required':'single_cue_host_normalization',
  strict_current_intent_comparison_still_required:true,new_model_calls:0,old_outcomes_and_account_usage_unchanged:true,
  qualified:false,artistic_approval:false,production_approval:false};
}
