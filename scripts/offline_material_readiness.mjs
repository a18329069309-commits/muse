// Offline evidence can make a window executable for diagnostic selection.
// It cannot make ASR, a phrase boundary, a genre label or an artistic use approved.
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJson,saveJson,verifyEvidenceBindings,verifyLocalAudioExecution,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {createSpecialistMaterialObserver} from './specialist_material_observer.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const key=(sha,range)=>JSON.stringify([sha,range]);
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const isRange=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&value[0]>=0&&value[1]>value[0];

export function diagnosticWindowReady(window){
  const state=window?.readiness;
  return Boolean(state?.decode_ready===true&&state.observation_ready===true&&state.edit_ready===true
    &&state.diagnostic_selectable===true&&window.offline_observation?.path
    &&/^[a-f0-9]{64}$/.test(window.offline_observation?.sha256??''));
}

export async function validateFrozenObservation(window,result){
  if(!isRange(window.source_range)||result?.actual_audio_processed!==true
    ||result.source_sha256!==window.source_sha256||!same(result.source_range,window.source_range)
    ||!result.model_revision||!result.observations||!result.files?.length
    ||result.qualified===true||result.artistic_approval===true||result.production_approval===true
    ||!result.observation_record?.path)throw Error('offline_observation_identity_or_scope_invalid');
  await verifyEvidenceBindings(result);
  const executionBinding=result.files.find(file=>path.basename(file.path)==='execution-record.json');
  if(!executionBinding)throw Error('offline_actual_execution_record_required');
  const execution=await readJson(executionBinding.path);
  if(execution.execution_kind!=='local_subprocess'||execution.actual_audio_processed!==true
    ||execution.source?.sha256!==window.source_sha256||!same(execution.source_range,window.source_range)
    ||execution.fixture_only===true||execution.qualified!==false)
    throw Error('offline_actual_execution_record_required');
  const record=await readJson(result.observation_record.path);
  if(record.source_sha256!==window.source_sha256||!same(record.source_range,window.source_range)
    ||!same(record.observation,result.observations))throw Error('offline_observation_record_mismatch');
  await verifyLocalAudioExecution(record,{protocol:record.protocol,backend_id:record.backend_id,model_revision:record.model_revision});
  return {...result,qualified:false,sound_facts_qualified:false,actual_audio_listened:false,
    artistic_approval:false,production_approval:false,offline_cached:true};
}

export async function createFrozenMaterialObserver({publication}){
  await verifyEvidenceBindings(publication);
  const frozen=await readJson(publication.path);
  if(frozen.kind!=='independent_music_pack_publication'||frozen.production_approval!==false
    ||frozen.offline_readiness_contract!==1)throw Error('offline_ready_publication_required');
  const windows=new Map();
  for(const window of frozen.windows??[]){
    if(!diagnosticWindowReady(window))continue;
    const id=key(window.source_sha256,window.source_range);
    if(windows.has(id))throw Error('offline_window_identity_ambiguous');
    windows.set(id,window);
  }
  const observe=async job=>{
    const window=windows.get(key(job.source_sha256,job.source_range));
    if(!window)throw Error('offline_material_window_not_ready');
    const file=typeof job.source_file==='string'?job.source_file:job.source_file?.path;
    if(path.resolve(file??'')!==path.resolve(window.local_path??window.path)){
      // An exact-content alias is legal; a merely similar filename is not.
      if(await hashFile(file)!==job.source_sha256)throw Error('offline_recording_alias_changed');
    }
    await verifyEvidenceBindings([publication,window.offline_observation]);
    return validateFrozenObservation(window,await readJson(window.offline_observation.path));
  };
  return {materialObserver:observe,
    materialObserverBatch:async entries=>Promise.all(entries.map(async entry=>{
      try{return {status:'fulfilled',value:await observe(entry.job)};}
      catch(reason){return {status:'rejected',reason};}
    })),materialObserver_backend_id:'frozen_offline_specialist_evidence',
    materialObserver_model_revision:publication.sha256,
    materialObserver_audio_backend:null,offline_only:true,online_model_calls:0};
}

// A bounded call explicitly selects a sub-batch of windows, not a directory.
// Completed exact windows are reusable; failed windows never become ready.
export async function prepareOfflineMusicReadiness(config,runtime={}){
  if(config.mode!=='research'||config.trial_review_policy!=='diagnostic_candidates'
    ||!path.isAbsolute(config.output_dir??'')||!config.publication?.path)
    throw Error('offline_diagnostic_configuration_required');
  const limit=config.max_windows??20;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('offline_bounded_window_limit_required');
  await verifyEvidenceBindings(config.publication);
  const original=await readJson(config.publication.path);
  if(original.kind!=='independent_music_pack_publication'||original.production_approval!==false)
    throw Error('offline_candidate_publication_required');
  const byId=new Map((original.windows??[]).map(window=>[window.window_id,window]));
  const selected=config.window_ids?config.window_ids.map(id=>{
    if(!byId.has(id))throw Error('offline_window_not_in_frozen_publication');return byId.get(id);
  }):[...new Map((original.windows??[]).map(window=>[window.asset_id,window])).values()].slice(0,limit);
  if(!selected.length||selected.length>limit)throw Error('offline_sub_batch_required');
  const root=path.resolve(config.output_dir);await mkdir(root,{recursive:true});
  const observer=runtime.observer??await createSpecialistMaterialObserver({execution:config.execution,receipts:config.receipts??[]});
  if(typeof observer.materialObserverBatch!=='function')throw Error('offline_actual_batch_observer_required');
  const results=new Map(),gaps=[];
  const started=Date.now();
  for(let start=0;start<selected.length;start+=8){
    const batch=selected.slice(start,start+8),missing=[];
    for(const window of batch){
      const directory=path.join(root,'windows',shaBytes(key(window.source_sha256,window.source_range)).slice(0,24));
      const file=path.join(directory,'frozen-observation.json');
      try{
        const existing=await readJson(file);await validateFrozenObservation(window,existing);
        results.set(window.window_id,await bind(file));
      }catch(error){
        if(error.code!=='ENOENT'){
          gaps.push({window_id:window.window_id,source_sha256:window.source_sha256,source_range:window.source_range,
            stage:'reuse_verification',reason:error.message,blocks_other_windows:false});continue;
        }
        missing.push({window,directory,job:{source_file:window.local_path??window.path,
          source_sha256:window.source_sha256,source_range:window.source_range,
          segment_id:window.segment_id,pack_id:window.pack_id,window_id:window.window_id}});
      }
    }
    if(missing.length){
      let rows;
      try{rows=await observer.materialObserverBatch(missing.map(({directory,job})=>({directory,job})));}
      catch(error){rows=missing.map(()=>({status:'rejected',reason:error}));}
      if(rows.length!==missing.length)throw Error('offline_batch_cardinality_invalid');
      for(const [index,row] of rows.entries()){
        const entry=missing[index];
        try{
          if(row.status!=='fulfilled')throw row.reason;
          const value=await validateFrozenObservation(entry.window,row.value);
          const saved=await saveJson(path.join(entry.directory,'frozen-observation.json'),value);
          results.set(entry.window.window_id,saved);
        }catch(error){gaps.push({window_id:entry.window.window_id,source_sha256:entry.window.source_sha256,
          source_range:entry.window.source_range,stage:'offline_observation',reason:error?.message??String(error),blocks_other_windows:false});}
      }
    }
    await saveJson(path.join(root,'progress',randomUUID()+'.json'),{schema_version:1,status:'building',
      attempted:Math.min(start+8,selected.length),requested:selected.length,ready:results.size,gaps,
      actual_account_calls:0,production_approval:false});
  }
  const selectedIds=new Set(selected.map(window=>window.window_id));
  const windows=(original.windows??[]).map(window=>{
    const reference=results.get(window.window_id),old=diagnosticWindowReady(window);
    return reference?{...window,offline_observation:reference,
      readiness:{decode_ready:true,observation_ready:true,edit_ready:true,diagnostic_selectable:true,
        edit_scope:'exact_decoded_source_window; envelope/cut/merge only; phrases and development remain unverified'},
      sound_review:window.sound_review??'pending',usage_review:window.usage_review??'pending',
      phrase_boundaries_verified:window.phrase_boundaries_verified===true,
      sound_facts_qualified:false,artistic_approval:false,production_approval:false}
      :old?window:{...window,readiness:{decode_ready:true,observation_ready:false,edit_ready:false,diagnostic_selectable:false},
        offline_task_status:selectedIds.has(window.window_id)?'failed_with_gap':'not_yet_scheduled'};
  });
  const packs=(original.packs??[]).map(pack=>({...pack,windows:windows.filter(window=>window.pack_id===pack.pack_id)}));
  const version=shaBytes(JSON.stringify([config.publication,windows,gaps,
    await hashFile(fileURLToPath(import.meta.url))]));
  const snapshot=path.join(root,'snapshots',version.slice(0,20));
  await mkdir(snapshot,{recursive:true});
  let publication;
  const publicationFile=path.join(snapshot,'publication.json');
  try{publication=await bind(publicationFile);await verifyEvidenceBindings(publication);}
  catch(error){if(error.code!=='ENOENT')throw error;publication=await saveJson(publicationFile,{...original,
    publication_id:'offline-ready/'+version,offline_readiness_contract:1,parent_publication:config.publication,
    windows,packs,counts:{...original.counts,observation_ready_windows:windows.filter(diagnosticWindowReady).length,
      diagnostic_selectable_windows:windows.filter(diagnosticWindowReady).length},offline_gaps:gaps,
    offline_preparation:{execution_kind:'existing_specialist_batch',actual_account_calls:0,elapsed_ms:Date.now()-started},
    professional_audio_review_qualified:false,human_audition_performed:false,production_approval:false});}
  const result={schema_version:1,status:results.size?'frozen_offline_ready_sub_batch':'offline_sub_batch_failed',publication,
    requested_windows:selected.length,ready_windows:results.size,gaps,elapsed_ms:Date.now()-started,actual_account_calls:0,
    existing_analysis_or_film_budget_reset:false,qualified:false,production_approval:false};
  await saveJson(path.join(root,'results',randomUUID()+'.json'),result);return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{config:{type:'string'}}});
  const result=await prepareOfflineMusicReadiness(await readJson(values.config));
  process.stdout.write(JSON.stringify(result)+'\n');
}
