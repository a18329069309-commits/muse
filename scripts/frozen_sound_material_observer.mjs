import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readJson,saveJson,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {createSpecialistResearchObserver} from './specialist_research_runtime.mjs';

const implementation=fileURLToPath(import.meta.url);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const range=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)
  &&value[0]>=0&&value[1]>value[0];
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const load=async binding=>{await verifyEvidenceBindings(binding);return readJson(binding.path);};

// This adapter consumes actual offline PCM receipts. It is a technical observer,
// has no model forward, and neither identifies a sound nor approves its scene use.
export async function createFrozenSoundMaterialObserver(supplied,options={}){
  if(!supplied?.publication)throw Error('frozen_sound_publication_binding_required');
  const publication=await load(supplied.publication),library=supplied.library
    ??(supplied.db?{path:path.resolve(supplied.db),sha256:supplied.sha256}:publication.library);
  if(publication.kind!=='diagnostic_sound_library'||publication.status!=='diagnostic_only_not_approved_sound_pack'
    ||publication.library?.sha256!==library?.sha256
    ||path.resolve(publication.library?.path??'')!==path.resolve(library?.path??'')
    ||publication.human_audition_performed!==false||publication.professional_audio_review_qualified!==false)
    throw Error('frozen_sound_diagnostic_publication_required');
  await verifyEvidenceBindings([library,publication.assets,publication.segments]);
  const assets=(await readJson(publication.assets.path)).assets,segments=(await readJson(publication.segments.path)).segments;
  const byAsset=new Map(assets.map(row=>[row.asset_id,row])),bySegment=new Map(segments.map(row=>[row.segment_id,row]));
  if(byAsset.size!==assets.length||bySegment.size!==segments.length)throw Error('frozen_sound_identity_ambiguous');
  const specialist=await optionalSpecialist({specialist_receipts:options.specialist_receipts===undefined
    ?supplied.specialist_receipts:options.specialist_receipts});
  const adapter=await bind(implementation),revision='ffmpeg-pcm-offline/'+(specialist
    ?shaBytes(JSON.stringify({adapter:adapter.sha256,specialist:specialist.revision})):adapter.sha256);
  const resolve=async job=>{
    const segment=bySegment.get(job.segment_id),asset=byAsset.get(segment?.asset_id);
    const sourcePath=typeof job.source_file==='string'?job.source_file:job.source_file?.path;
    if(!asset||!['sfx','ambient','ambience'].includes(asset.asset_kind)||!range(job.source_range)
      ||segment.source_sha256!==job.source_sha256||asset.source_sha256!==job.source_sha256
      ||path.resolve(sourcePath??'')!==path.resolve(asset.local_path??asset.path??'')
      ||job.source_range[0]<segment.source_range[0]||job.source_range[1]>segment.source_range[1]
      ||asset.full_decode_verified!==true||asset.production_approval!==false)
      throw Error('frozen_sound_source_window_not_registered');
    const receiptBinding=asset.pcm_proxy?.receipt;
    if(!receiptBinding)throw Error('frozen_sound_actual_pcm_receipt_required');
    const receipt=await load(receiptBinding),source={path:path.resolve(sourcePath),sha256:job.source_sha256};
    // Only the selected source is read again. No full-library decoding or hashing.
    await verifyEvidenceBindings([source,asset.original_source,adapter]);
    const samples=receipt.decoded_samples,profile=receipt.profile;
    if(receipt.kind!=='local_sound_actual_pcm_decode'||receipt.pcm_sha256!==source.sha256
      ||path.resolve(receipt.pcm_path??'')!==source.path||receipt.original_sha256!==asset.original_source?.sha256
      ||path.resolve(receipt.original_path??'')!==path.resolve(asset.original_source?.path??'')
      ||receipt.sample_rate_hz!==48000||receipt.channels!==2||!Number.isSafeInteger(samples)||samples<=0
      ||receipt.full_decode?.exit_code!==0||receipt.full_decode.strict_errors!==true
      ||receipt.full_decode.decoder!=='ffmpeg'||receipt.sound_facts_qualified!==false
      ||profile?.decoded_samples!==samples||profile.decoded_sample_rate!==48000
      ||profile.sound_facts_qualified!==false||profile.auditory_anchor_verified!==false
      ||asset.actual_clock?.samples!==samples||asset.actual_clock.sample_rate_hz!==48000
      ||Math.abs(asset.duration_seconds-samples/48000)>1/48000
      ||job.source_range[1]>samples/48000||!/^[a-f0-9]{64}$/.test(receipt.processor_sha256??''))
      throw Error('frozen_sound_actual_pcm_clock_or_proof_invalid');
    const transientCandidates=(profile.transient_candidates??[]).filter(row=>Number.isSafeInteger(row.sample_index)
      &&row.sample_index>=0&&row.sample_index<samples&&row.seconds===row.sample_index/48000
      &&row.seconds>=job.source_range[0]&&row.seconds<job.source_range[1]);
    return {asset,segment,source,receipt,receiptBinding,profile,samples,transientCandidates};
  };
  const observe=async(job,directory)=>{
    const row=await resolve(job);await mkdir(directory,{recursive:true});
    const supplemental=specialist?await specialist.observe(job,path.join(directory,'optional-panns')):null;
    const evidence=await saveJson(path.join(directory,'frozen-pcm-technical-evidence.json'),{
      schema_version:1,kind:'frozen_offline_pcm_technical_observation',protocol:'ffmpeg_pcm_offline',
      source_audio:row.source,source_sha256:row.source.sha256,source_range:job.source_range,
      processed_source_range:[0,row.samples/48000],pcm_receipt:row.receiptBinding,
      publication:supplied.publication,library,adapter,processor_revision:row.receipt.processor_sha256,
      model_revision:revision,actual_audio_processed:true,evidence_status:'unqualified_technical_measurement',
      execution:{actual_audio_processed:true,offline_full_decode_reused:true,new_decode_calls:0,model_calls:0,
        decoder:'ffmpeg',exit_code:0,decoded_samples:row.samples,sample_rate_hz:48000,channels:2},
      ...(supplemental?{optional_specialist:{status:supplemental.status,
        receipt_bindings:specialist.receipts,...(supplemental.response?{
          response:supplemental.response.raw_response,historical_inference_evidence_reused:true,
          new_model_calls:0}:{}),qualified:false,cleanliness_approved:false,usage_approved:false}}:{}),
      actual_audio_listened:false,qualified:false,artistic_approval:false,production_approval:false});
    const observations={scope:'technical_pcm_measurements_only',protocol:'ffmpeg_pcm_offline',
      actual_clock:{samples:row.samples,sample_rate_hz:48000,source_range:[0,row.samples/48000]},
      window_source_range:job.source_range,measured_transient_candidates:row.transientCandidates,
      whole_recording_measurements:{source_range:[0,row.samples/48000],peak_dbfs:row.profile.peak_dbfs,
        rms_dbfs:row.profile.rms_dbfs},
      sound_class_candidate:row.asset.sound_class_candidate,
      sound_class_basis:'directory_duration_and_pcm_hypothesis_not_verified_sound_category',
      publisher_hints:{title:row.asset.title,directory_tags:row.asset.source_tags??[],
        status:'unverified_filename_not_sound_fact'},
      sound_identity:'unknown',cleanliness:'unknown',speech_presence:'unknown',music_presence:'unknown',
      sound_semantics_verified:false,usage_approved:false,auditory_anchor_verified:false,lyrics_verified:false,
      ...(supplemental?{specialist_prediction_status:supplemental.status,
        specialist_predictions:supplemental.response?.value.predictions??[],
        specialist_limitations:supplemental.response?.value.limitations??[
          'No exact prepared PANNs window; PCM evidence remains available and sound semantics remain unknown.']} :{}),
      limitation:supplemental?.response
        ?'Actual offline PCM measurements plus separately bound, unqualified PANNs predictions. Neither class probabilities nor filename hints prove cleanliness, exact sound identity, scene fit or precise onset.'
        :'Actual offline PCM clock and waveform measurements only. No model inference or hearing occurred; filename hints cannot prove sound identity, cleanliness or scene fit.'};
    return {source_sha256:job.source_sha256,source_range:job.source_range,actual_audio_processed:true,
      actual_audio_listened:false,protocol:'ffmpeg_pcm_offline',processor_revision:revision,
      // Legacy selection uses this field for a nonempty processing identity. Its value
      // explicitly identifies a technical processor, never an audio model.
      model_revision:revision,observations,observation_record:evidence,
      files:[supplied.publication,library,publication.assets,publication.segments,row.receiptBinding,
        row.source,assetOriginal(row.asset),adapter,evidence,
        ...(supplemental?.response?[supplemental.response.raw_response,...supplemental.response.evidence_files]:[])],
      evidence_status:'unqualified_technical_measurement',qualified:false,artistic_approval:false,production_approval:false};
  };
  const anchor=async({source,sourceRange,segmentId,outputDir})=>{
    const row=await resolve({source_file:source.path,source_sha256:source.sha256,source_range:sourceRange,segment_id:segmentId});
    const candidates=row.transientCandidates.map(item=>({basis:'offline_stereo_pcm_local_energy_peak',
      sample:item.sample_index,seconds:item.seconds,peak_amplitude:item.peak_amplitude}));
    const global=row.profile.global_peak_sample;
    if(Number.isSafeInteger(global)&&global>=0&&global<row.samples&&global/48000>=sourceRange[0]
      &&global/48000<sourceRange[1]&&!candidates.some(item=>item.sample===global))
      candidates.push({basis:'offline_stereo_pcm_global_peak',sample:global,seconds:global/48000});
    candidates.sort((a,b)=>(b.peak_amplitude??0)-(a.peak_amplitude??0)||a.sample-b.sample);
    await mkdir(outputDir,{recursive:true});
    return saveJson(path.join(outputDir,'measurement.json'),{schema_version:1,
      kind:'decoded_waveform_transient_measurement',source_audio:row.source,source_sha256:row.source.sha256,
      source_range:sourceRange,processed_source_range:[0,row.samples/48000],
      decoded_audio:row.source,pcm_receipt:row.receiptBinding,publication:supplied.publication,
      sample_rate:48000,decoded_samples:row.samples,
      peak_linear:Math.pow(10,row.profile.peak_dbfs/20),anchor_candidates:candidates,implementation:adapter,
      offline_full_decode_reused:true,new_decode_calls:0,actual_audio_processed:true,actual_audio_listened:false,
      qualified:false,production_approval:false,auditory_anchor_approval:false,usage_approval:false,
      basis:'offline_stereo_pcm_measured_candidates_not_perceptual_contact_or_scene_approval'});
  };
  const batch=async jobs=>Promise.all(jobs.map(async item=>{
    try{return {status:'fulfilled',value:await observe(item.job,item.directory)};}
    catch(reason){return {status:'rejected',reason};}
  }));
  return {materialObserver:observe,materialObserverBatch:batch,materialObserver_backend_id:'ffmpeg_pcm_offline',
    materialObserver_model_revision:revision,sfxMaterialObserver:observe,sfxMaterialObserverBatch:batch,
    sfxMaterialObserver_backend_id:'ffmpeg_pcm_offline',sfxMaterialObserver_model_revision:revision,
    sfxAnchorMeasurer:anchor,registered_window_count:segments.length,qualified:false};
}
const assetOriginal=asset=>({path:asset.original_source.path,sha256:asset.original_source.sha256});

// Optional specialist evidence never runs a model online, extrapolates another
// window or grants sound/use qualification. Pure-PCM callers stay compatible.
async function optionalSpecialist(options){
  const receipts=options.specialist_receipts;
  if(receipts===undefined)return null;
  if(!Array.isArray(receipts))throw Error('frozen_sound_optional_receipts_required');
  if(!receipts.length)return null;
  const inputs=new Map();
  for(const receipt of receipts){
    const run=await load(receipt);
    if(run.backend!=='panns_sed')throw Error('frozen_sound_optional_panns_receipt_required');
    for(const job of run.jobs??[]){
      if(job.status!=='predicted')continue;
      const raw=await load({path:job.raw_receipt,sha256:job.raw_sha256});
      const key=JSON.stringify([raw.source_sha256,raw.source_window_seconds]);
      inputs.set(key,[...(inputs.get(key)??[]),{path:raw.input_file,sha256:raw.input_sha256}]);
    }
  }
  const observer=await createSpecialistResearchObserver({receipts,requiredBackends:['panns_sed']});
  return {receipts,revision:observer.model_revision,observe:async(job,directory)=>{
    const selected=inputs.get(JSON.stringify([job.source_sha256,job.source_range]))??[];
    if(!selected.length)return {status:'exact_window_not_prepared'};
    if(selected.length!==1)throw Error('frozen_sound_optional_window_ambiguous');
    await mkdir(directory,{recursive:true});
    const response=await observer({source_video_sha256:job.source_sha256,source_range:job.source_range,
      input_audio:selected[0]},directory);
    return {status:'unqualified_predictions_consumed',response};
  }};
}
