// Content identity and strictly bound cache reuse. No audio inference or approval.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

export const specialistCacheIdentityRevision = 'specialist_runtime_content_identity_v2';
// This predecessor is audited: v2 changes cache lookup/receipts only. Runner,
// preparation, model configuration and actual per-backend execution stay exact.
export const cacheOnlyPredecessorExecutorSha = 'b60319de25d504298c9a063267eb20ce7ca85b6117171368116b467625e39830';
export const compatiblePredecessorPreparationSha = '176b1398622d0bc4b8a2d9aca1a20b4c056761f559075d11eb305b5ea7e5f01a';
const preparationCoreSha='9724d59e5e52308c2e0b57ea3b553258c6336de4ac9f891da38115d03a1f3349';
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const bind = async file => ({path:path.resolve(file),sha256:await hashFile(file)});
const modelOnly = ({jobs,output_dir,array_dir,gpu_slot,...model}) => model;
export const validSpecialistDevice = value => typeof value==='string'&&/^(cpu|cuda(?::\d+)?)$/.test(value);
export function specialistModelEnvironment(model,environment={},inherited=process.env){
  if(!validSpecialistDevice(model.device))throw Error('specialist_model_device_required');
  const visible=model.device==='cpu'?'':environment.CUDA_VISIBLE_DEVICES??inherited.CUDA_VISIBLE_DEVICES??'0';
  if(model.device!=='cpu'&&visible==='')throw Error('cuda_specialist_visible_device_required');
  return {...inherited,...environment,CUDA_VISIBLE_DEVICES:visible,HF_HUB_OFFLINE:'1',
    TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2'};
}
export function specialistInferenceContracts(templates,environment={},inherited=process.env){
  return templates.map(({model})=>({backend:model.backend,device:model.device,
    cuda_visible_devices:specialistModelEnvironment(model,environment,inherited).CUDA_VISIBLE_DEVICES,
    worker_dtype:model.backend==='qwen3_asr'&&model.device!=='cpu'?'bfloat16':'float32',
    dtype_basis:'exact_bound_specialist_audio_observer_worker_policy'}));
}
const reuseProof = (originalBinding,original,options,legacy) => ({kind:'specialist_exact_legacy_cache_reuse_v1',
  original_execution_record:originalBinding,original_revision:original.revision,
  original_runtime_bindings:legacy.bindings,
  current_revision:options.identity.revision,predecessor_executor_sha256:cacheOnlyPredecessorExecutorSha,
  unchanged_preparation_core_sha256:preparationCoreSha,
  source_sha256:options.source.sha256,source_range:options.range,new_inference_calls:0,
  qualification_granted:false,original_values_and_provenance_preserved:true});

export function specialistRuntimeContentIdentity({bindings,python,environment={},executionKind,inferenceContracts=[]}) {
  if (!Array.isArray(bindings) || bindings.length < 5 || !python || !executionKind)
    throw Error('specialist_content_identity_inputs_required');
  const identity = {kind:specialistCacheIdentityRevision,
    implementation:bindings.map((row,index)=>({index,name:path.basename(row.path),sha256:row.sha256})),
    python,execution_kind:executionKind,environment_sha256:shaBytes(JSON.stringify(environment)),
    inference_contracts:inferenceContracts};
  return {...identity,revision:shaBytes(JSON.stringify(identity))};
}

export function legacySpecialistRevision({bindings,python,environment={},executionKind}) {
  return shaBytes(JSON.stringify({bindings,python,execution_kind:executionKind,
    environment_sha256:shaBytes(JSON.stringify(environment))}));
}

export function legacySpecialistCandidates({directory,bindings,python,environment={},executionKind,
  locations,source,range}) {
  return [...new Set(locations.map(row=>path.resolve(row)))].map(location=>{
    const legacyBindings=bindings.slice(0,5).map((row,index)=>index<3
      ? {path:path.join(location,path.basename(row.path)),sha256:index===2?cacheOnlyPredecessorExecutorSha
        :index===1?compatiblePredecessorPreparationSha:row.sha256}
      : row);
    const revision=legacySpecialistRevision({bindings:legacyBindings,python,environment,executionKind});
    const key=shaBytes(JSON.stringify([revision,source.sha256,range]));
    return {revision,bindings:legacyBindings,
      receiptFile:path.join(path.resolve(directory),key,'execution-record.json'),
      failureFile:path.join(path.resolve(directory),key,'failure-record.json')};
  });
}

export async function verifySpecialistCacheRecord(record,{identity,bindings,templates,source,range,
  executionKind,actualAudioProcessed,completedStatus,legacy=null}) {
  if(record.status!==completedStatus || record.execution_kind!==executionKind
    ||record.actual_audio_processed!==actualAudioProcessed ||record.source?.sha256!==source.sha256
    ||!same(record.source_range,range)||record.qualified!==false
    ||record.artistic_approval!==false||record.production_approval!==false)
    throw Error('specialist_window_cached_identity_changed');
  if(legacy){
    if(templates.some(({model})=>model.device!=='cpu')
      ||legacy.bindings?.[2]?.sha256!==cacheOnlyPredecessorExecutorSha
      ||legacy.bindings?.[1]?.sha256!==compatiblePredecessorPreparationSha
      ||record.revision!==legacy.revision ||record.bindings?.length!==5
      ||!record.bindings.every((row,i)=>row.sha256===legacy.bindings[i].sha256))
      throw Error('specialist_legacy_runtime_contract_changed');
    // GPU acceptance changes only the batch/receipt validator. Exact window
    // preparation below is byte-identical to this audited predecessor.
    for(const file of [record.bindings[1].path,bindings[1].path]){
      const text=await readFile(file,'utf8');
      const begin=text.indexOf('export async function prepareSpecialistCandidateWindow');
      const end=text.indexOf('export async function prepareSpecialistCandidateBatch');
      if(begin<0||end<=begin||shaBytes(text.slice(begin,end))!==preparationCoreSha)
        throw Error('specialist_legacy_preparation_contract_changed');
    }
  }else if(record.revision!==identity.revision ||!same(record.runtime_content_identity,identity)
    ||record.bindings?.length!==bindings.length
    ||!record.bindings.every((row,i)=>row.sha256===bindings[i].sha256))
    throw Error('specialist_window_cached_identity_changed');
  // Verify the complete old evidence graph, not merely its cached audio or scores.
  await verifyEvidenceBindings(record);
  if(!record.input_audio?.path || !record.input_audio.sha256
    ||record.receipts?.length!==2||record.processes?.length!==2)
    throw Error('specialist_cached_complete_execution_required');
  for(const {model} of templates){
    const process=record.processes.find(row=>row.backend===model.backend);
    if(!process?.configuration ||process.exit_code!==0)
      throw Error('specialist_cached_backend_process_required');
    const config=await readJson(process.configuration.path);
    if(!same(modelOnly(config),model))throw Error('specialist_cached_model_configuration_changed');
    if(model.device!=='cpu'&&config.gpu_slot){
      if(!bindings.some(row=>row.path===config.gpu_slot.path&&row.sha256===config.gpu_slot.sha256))
        throw Error('specialist_cached_gpu_slot_binding_changed');
      await verifyEvidenceBindings(config.gpu_slot);
    }
    const jobs=config.jobs?.filter(job=>job.source_sha256===source.sha256
      &&same(job.source_window_seconds,range)&&job.input_sha256===record.input_audio.sha256);
    if(jobs?.length!==1)throw Error('specialist_cached_exact_prepared_input_required');
    const prepared=jobs[0];
    const candidates=[];
    for(const binding of record.receipts){
      const value=await readJson(binding.path);
      if(value.backend===model.backend)candidates.push(value);
    }
    if(candidates.length!==1)throw Error('specialist_cached_backend_receipt_required');
    const value=candidates[0],job=value.jobs?.find(row=>row.id===prepared.id);
    if(!validSpecialistDevice(model.device)||value.status!=='completed_unqualified'
      ||value.device!==model.device||value.qualified!==false
      ||value.model_revision!==model.model_revision||value.model_sha256!==model.model_sha256
      ||!job||job.status!=='predicted'||!(job.forward_calls>0)||!job.raw_receipt||!job.raw_sha256)
      throw Error('specialist_cached_backend_inference_required');
    const rawBinding={path:job.raw_receipt,sha256:job.raw_sha256};
    await verifyEvidenceBindings(rawBinding);
    const raw=await readJson(rawBinding.path);
    if(raw.status!=='predicted'||raw.qualified!==false||raw.source_sha256!==source.sha256
      ||!same(raw.source_window_seconds,range)||raw.input_sha256!==record.input_audio.sha256
      ||raw.forward_calls!==job.forward_calls||!raw.model_input_pcm_sha256)
      throw Error('specialist_cached_raw_identity_changed');
    await verifyEvidenceBindings({path:raw.input_file,sha256:raw.input_sha256});
  }
  return true;
}

export async function resolveSpecialistCachedExecution({receiptFile,legacyCandidates,...options}) {
  let cached;
  try{cached=await readJson(receiptFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(cached){
    if(cached.cache_reuse){
      const proof=cached.cache_reuse;
      if(proof.kind!=='specialist_exact_legacy_cache_reuse_v1'
        ||!same(cached.runtime_content_identity,options.identity)
        ||cached.revision!==options.identity.revision||proof.new_inference_calls!==0)
        throw Error('specialist_cached_reuse_proof_changed');
      await verifyEvidenceBindings(proof.original_execution_record);
      // After first migration, the proof carries the original locators solely
      // to reconstruct its old identity. A later directory move needs no
      // repeated declaration of those obsolete executable locations.
      const oldBindings=proof.original_runtime_bindings;
      if(!Array.isArray(oldBindings)||oldBindings.length!==5
        ||oldBindings.some((row,i)=>row.sha256!==(i===2?cacheOnlyPredecessorExecutorSha
          :i===1?compatiblePredecessorPreparationSha:options.bindings[i].sha256)))
        throw Error('specialist_legacy_runtime_contract_changed');
      const oldRevision=shaBytes(JSON.stringify({bindings:oldBindings,python:options.identity.python,
        execution_kind:options.identity.execution_kind,environment_sha256:options.identity.environment_sha256}));
      if(oldRevision!==proof.original_revision)throw Error('specialist_legacy_runtime_contract_changed');
      const legacy={revision:oldRevision,bindings:oldBindings};
      const original=await readJson(proof.original_execution_record.path);
      await verifySpecialistCacheRecord(original,{...options,legacy});
      if(!same(proof,reuseProof(proof.original_execution_record,original,options,legacy)))
        throw Error('specialist_cached_reuse_proof_changed');
      const expected={...original,revision:options.identity.revision,runtime_content_identity:options.identity,
        cache_reuse:proof};
      if(!same(cached,expected))throw Error('specialist_cached_reuse_value_changed');
    }else await verifySpecialistCacheRecord(cached,options);
    return {...cached,execution_record:await bind(receiptFile),cache_reused:true,new_inference_calls:0};
  }
  for(const legacy of legacyCandidates){
    let original;
    try{original=await readJson(legacy.receiptFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(original){
      await verifySpecialistCacheRecord(original,{...options,legacy});
      const proof=reuseProof(await bind(legacy.receiptFile),original,options,legacy);
      const alias={...original,revision:options.identity.revision,runtime_content_identity:options.identity,
        cache_reuse:proof};
      await saveJson(receiptFile,alias);
      return {...alias,execution_record:await bind(receiptFile),cache_reused:true,new_inference_calls:0};
    }
    try{
      const failure=await readJson(legacy.failureFile);
      if(failure.revision===legacy.revision&&failure.source?.sha256===options.source.sha256
        &&same(failure.source_range,options.range))
        throw Error('specialist_window_inference_failed_previous_attempt');
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return null;
}
