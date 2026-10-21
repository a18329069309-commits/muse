// Research-only full-span observations composed from verified, overlapping specialist windows.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';
import { createSpecialistMaterialObserver } from './specialist_material_observer.mjs';

export function requireWindowCoverage(range, windows) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]
    || !Array.isArray(windows) || windows.some(x=>!Array.isArray(x)||x.length!==2||!x.every(Number.isFinite)))
    throw new Error('material_window_range_invalid');
  let end = range[0];
  for (const window of [...windows].sort((a,b)=>a[0]-b[0])) {
    if (window[0] < range[0] - 1/16000 || window[1] > range[1] + 1/16000 || window[1] <= window[0] || window[0] > end + 1/16000)
      throw new Error('material_window_coverage_gap_or_bounds');
    end = Math.max(end, window[1]);
  }
  if (!windows.length || Math.abs(end-range[1]) > 1/16000) throw new Error('material_window_coverage_incomplete');
}

function pcm(bytes) {
  if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('material_window_pcm_required');
  let format, data;
  for(let offset=12;offset+8<=bytes.length;){
    const size=bytes.readUInt32LE(offset+4),kind=bytes.toString('ascii',offset,offset+4);
    if(kind==='fmt ')format=[bytes.readUInt16LE(offset+8),bytes.readUInt16LE(offset+10),bytes.readUInt32LE(offset+12),bytes.readUInt16LE(offset+22)];
    if(kind==='data')data=bytes.subarray(offset+8,offset+8+size);
    offset+=8+size+(size%2);
  }
  if(JSON.stringify(format)!=='[1,1,16000,16]'||!data)throw new Error('material_window_pcm_format_required');
  return data;
}

export async function createWindowedMaterialObserver({ preparation, receipts, featureReceipts }) {
  await verifyEvidenceBindings([preparation,...receipts,...featureReceipts]);
  const prepared=await readJson(preparation.path), child=await createSpecialistMaterialObserver({receipts});
  const featureMap=new Map();
  for(const file of featureReceipts){
    const run=await readJson(file.path);
    if(run.backend!=='beat_this_librosa_cpu'||run.device!=='cpu'||run.qualified!==false)throw new Error('material_full_feature_run_required');
    await verifyEvidenceBindings([run.script_binding,run.checkpoint_binding]);
    for(const job of run.jobs){
      if(job.status!=='measured')continue;
      const rawFile={path:job.raw_receipt,sha256:job.raw_sha256};await verifyEvidenceBindings(rawFile);
      const raw=await readJson(rawFile.path);
      if(raw.actual_audio_processed!==true||raw.device!=='cpu'||raw.model_revision!==run.model_revision||raw.forward_calls!==job.forward_calls||!Number.isSafeInteger(raw.forward_calls)||raw.forward_calls<1||raw.qualified!==false
        || raw.artistic_approval!==false || raw.features?.lyrics_verified!==false || raw.features?.phrase_boundaries_verified!==false || raw.features?.named_sections_verified!==false)
        throw new Error('material_full_feature_execution_invalid');
      featureMap.set(JSON.stringify([raw.source_sha256,raw.source_window_seconds]),{raw,file,rawFile,run});
    }
  }
  const revision=shaBytes(JSON.stringify([preparation.sha256,child.materialObserver_model_revision,featureReceipts.map(x=>x.sha256)]));
  const backend={protocol:'local_audio_model',backend_id:'local_specialist_window_coverage',model_revision:revision};
  return {materialObserver_backend_id:backend.backend_id,materialObserver_model_revision:revision,materialObserver_audio_backend:backend,
    materialObserver:async(job,directory)=>{
      const key=JSON.stringify([job.source_sha256,job.source_range]);
      const full=prepared.full_jobs.find(x=>JSON.stringify([x.source_sha256,x.source_window_seconds])===key), feature=featureMap.get(key);
      if(!full||!feature||feature.raw.input_sha256!==full.input_sha256)throw new Error('material_full_span_not_observed');
      const source={path:path.resolve(typeof job.source_file==='string'?job.source_file:job.source_file.path),sha256:job.source_sha256};
      const input={path:full.input_file,sha256:full.input_sha256};await verifyEvidenceBindings([source,input]);
      const wholePCM=pcm(await readFile(input.path));
      if(Math.abs(wholePCM.length/32000-(job.source_range[1]-job.source_range[0]))>1/16000)throw new Error('material_full_pcm_duration_mismatch');
      const windows=prepared.child_jobs.filter(x=>x.parent_id===full.id);
      requireWindowCoverage(job.source_range,windows.map(x=>x.source_window_seconds));
      const children=[];let forwards=feature.raw.forward_calls;const files=[preparation,source,input,feature.file,feature.rawFile,feature.run.script_binding,feature.run.checkpoint_binding];
      for(const [index,window] of windows.entries()){
        await verifyEvidenceBindings({path:window.input_file,sha256:window.input_sha256});
        const bytes=pcm(await readFile(window.input_file));
        const first=Math.round((window.source_window_seconds[0]-job.source_range[0])*16000)*2;
        if(!wholePCM.subarray(first,first+bytes.length).equals(bytes))throw new Error('material_child_pcm_not_full_span_slice');
        const result=await child.materialObserver({source_file:source.path,source_sha256:job.source_sha256,source_range:window.source_window_seconds},path.join(directory,'windows',String(index)));
        const execution=await verifyLocalAudioExecution(await readJson(result.observation_record.path),child.materialObserver_audio_backend);
        forwards+=execution.execution.forward_count;
        children.push({source_range:window.source_window_seconds,predictions:result.observations.predictions,observation_record:result.observation_record,local_evidence:result.local_evidence});
        files.push(...result.files);
      }
      const observation={scope:'full_source_span_from_verified_overlapping_windows',window_predictions:children,
        auxiliary_acoustic_features:feature.raw.features,lyrics_verified:false,sound_semantics_verified:false,artistic_approval:false,
        limitations:['Overlapping ASR/event predictions are unqualified; blank ASR does not prove instrumental music.','Beat/onset/energy measurements do not verify phrases, instruments, genre or scene suitability.']};
      const raw=await saveJson(path.join(directory,'material-observation-raw.json'),{observation});
      const evidence=await saveJson(path.join(directory,'material-local-evidence.json'),{schema_version:1,...backend,source_sha256:job.source_sha256,source_range:job.source_range,
        source_binding:source,input_audio:input,raw_result:raw,execution:{actual_audio_processed:true,model_revision:revision,input_audio_sha256:input.sha256,forward_count:forwards,
          scope:'full_span_beat_this_and_complete_per_window_specialist_execution',child_observation_records:children.map(x=>x.observation_record),feature_run:feature.file,feature_raw:feature.rawFile},qualified:false,artistic_approval:false,production_approval:false});
      const record={schema_version:1,...backend,source_sha256:job.source_sha256,source_range:job.source_range,input_audio:input,observation,completion_status:'complete',actual_audio_processed:true,
        local_evidence:evidence,qualified:false,artistic_approval:false,production_approval:false};
      await verifyLocalAudioExecution(record,backend);const observationRecord=await saveJson(path.join(directory,'material-observation-record.json'),record);
      files.push(raw,evidence,observationRecord);await verifyEvidenceBindings(files);
      return {source_sha256:job.source_sha256,source_range:job.source_range,actual_audio_processed:true,model_revision:revision,observations:observation,
        observation_record:observationRecord,local_evidence:evidence,files:[...new Map(files.map(x=>[x.path,x])).values()],evidence_status:'unqualified_research_prediction',artistic_approval:false,production_approval:false};
    }};
}
