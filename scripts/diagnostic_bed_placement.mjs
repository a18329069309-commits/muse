import path from 'node:path';import {mkdir,readFile} from 'node:fs/promises';import {execFile} from 'node:child_process';
import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {readJson,saveJson,verifyEvidenceBindings} from './audio_api.mjs';import {hashFile} from './render_binding.mjs';
const run=promisify(execFile),implementation=fileURLToPath(import.meta.url);
const kind='technical_source_window_start_not_transient';
const range=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&v[0]>=0&&v[1]>v[0];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// A sustained diagnostic bed starts at the selected source window boundary.
// Full-window PCM validation binds placement; it grants no heard attack or use.
export async function measureDiagnosticBedPlacement({source,sourceRange,targetSource,event,outputDir}){
 const targetRange=[event?.start_seconds,event?.end_seconds],duration=sourceRange?.[1]-sourceRange?.[0];
 if(!path.isAbsolute(source?.path??'')||!path.isAbsolute(targetSource?.path??'')||!path.isAbsolute(outputDir??'')
  ||!range(sourceRange)||!range(targetRange)||typeof event?.id!=='string'||!event.id.trim()
  ||duration>300||Math.round(duration*48000)<Math.round((targetRange[1]-targetRange[0])*48000))
  throw Error('diagnostic_bed_placement_input_invalid');
 await verifyEvidenceBindings([source,targetSource]);await mkdir(outputDir,{recursive:true});
 const decodedPath=path.join(outputDir,'decoded-window.f32');
 await run('ffmpeg',['-v','error','-nostdin','-n','-i',source.path,'-ss',String(sourceRange[0]),'-t',String(duration),
  '-vn','-ar','48000','-ac','2','-f','f32le',decodedPath],{windowsHide:true,maxBuffer:1024*1024});
 const bytes=await readFile(decodedPath),samples=bytes.length/8,expected=Math.round(duration*48000);
 if(!Number.isInteger(samples)||samples!==expected)throw Error('diagnostic_bed_placement_sample_count_mismatch');
 let peak=0;for(let offset=0;offset<bytes.length;offset+=4){const amplitude=Math.abs(bytes.readFloatLE(offset));
  if(!Number.isFinite(amplitude))throw Error('diagnostic_bed_placement_nonfinite_pcm');peak=Math.max(peak,amplitude);}
 if(peak<.001)throw Error('diagnostic_bed_placement_signal_empty');
 await verifyEvidenceBindings([source,targetSource]);
 return saveJson(path.join(outputDir,'measurement.json'),{schema_version:1,kind,duration_role:'bed',
  source_audio:source,source_sha256:source.sha256,source_range:sourceRange,source_anchor_seconds:sourceRange[0],
  target_video:targetSource,current_target_video_sha256:targetSource.sha256,event_id:event.id,current_event_target_range:targetRange,
  target_start_seconds:targetRange[0],required_duration_samples:Math.round((targetRange[1]-targetRange[0])*48000),
  sample_rate:48000,channels:2,decoded_samples:samples,expected_decoded_samples:expected,peak_linear:peak,
  decoded_audio:{path:decodedPath,sha256:await hashFile(decodedPath)},implementation:{path:implementation,sha256:await hashFile(implementation)},
  actual_audio_processed:true,actual_audio_listened:false,qualified:false,production_approval:false,
  auditory_anchor_approval:false,usage_approval:false,basis:'technical_window_start_and_duration_not_perceptual_attack_or_scene_fit'});
}

export async function verifyDiagnosticBedPlacement(candidate){
 await verifyEvidenceBindings(candidate.source_anchor_evidence);const receipt=await readJson(candidate.source_anchor_evidence.path);
 const selectedRange=candidate.sound_function_intent?.revision==='sound-event-function-v2'&&!candidate.actual_adoption_response
   &&candidate.assembly_sfx_pool_contract_revision!=='observed-candidates-final-assembly-v1'
   ?candidate.sound_usage?.usable_source_range:candidate.source_range;
 if(receipt.kind!==kind||receipt.duration_role!=='bed'||candidate.duration_role!=='bed'
  ||receipt.source_sha256!==candidate.source_sha256||receipt.source_audio?.sha256!==candidate.source_sha256
  ||path.resolve(receipt.source_audio?.path??'')!==path.resolve(candidate.local_path??'')
  ||!range(receipt.source_range)||!same(receipt.source_range,selectedRange)
  ||receipt.source_anchor_seconds!==receipt.source_range[0]||candidate.source_anchor_seconds!==receipt.source_anchor_seconds
  ||receipt.event_id!==candidate.event_id||!same(receipt.current_event_target_range,candidate.current_event_target_range)
  ||receipt.current_target_video_sha256!==candidate.current_target_video_sha256
  ||receipt.target_video?.sha256!==candidate.current_target_video_sha256||!range(receipt.current_event_target_range)
  ||receipt.target_start_seconds!==receipt.current_event_target_range[0]||receipt.sample_rate!==48000||receipt.channels!==2
  ||receipt.decoded_samples!==Math.round((receipt.source_range[1]-receipt.source_range[0])*48000)
  ||receipt.required_duration_samples!==Math.round((receipt.current_event_target_range[1]-receipt.current_event_target_range[0])*48000)
  ||receipt.decoded_samples<receipt.required_duration_samples||!Number.isFinite(receipt.peak_linear)||receipt.peak_linear<.001
  ||receipt.actual_audio_processed!==true||receipt.actual_audio_listened!==false||receipt.qualified!==false
  ||receipt.production_approval!==false||receipt.auditory_anchor_approval!==false||receipt.usage_approval!==false
  ||candidate.human_review_record||candidate.anchor_review_status!=='measured_diagnostic_pending_audition')
  throw Error('diagnostic_bed_placement_binding_invalid');
 await verifyEvidenceBindings(receipt);
 const bytes=await readFile(receipt.decoded_audio.path);if(bytes.length!==receipt.decoded_samples*8)
  throw Error('diagnostic_bed_placement_binding_invalid');
 return receipt;
}
