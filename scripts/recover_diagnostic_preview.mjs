import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile, verifyRenderBinding } from './render_binding.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)), execute=promisify(execFile);
const tracks=['bgm','sfx','ambience','accompaniment'];
const allowedIssues=new Set(['original_plus_accompaniment_digital_overload',
  'complete_mix_true_peak_at_or_above_0_dbfs','original_audio_kind_requires_review']);
const fail=reason=>{throw Error(`diagnostic_preview_${reason}`);};
const run=(command,args)=>execute(command,args,{windowsHide:true,maxBuffer:4*1024*1024});
const inside=(file,root)=>{const r=path.relative(path.resolve(root),path.resolve(file));return !r||(!r.startsWith('..')&&!path.isAbsolute(r));};
const bound=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const load=async reference=>{
  if(!path.isAbsolute(reference?.path??'')||!/^[a-f0-9]{64}$/.test(reference.sha256??''))fail('absolute_binding_required');
  await verifyEvidenceBindings(reference);return readJson(reference.path);
};

async function waveFacts(file,N){
  const probe=JSON.parse((await run('ffprobe',['-v','error','-select_streams','a:0','-show_streams','-of','json',file])).stdout);
  const stream=probe.streams?.[0],clock=stream?.time_base?.split('/').map(Number);
  const samples=clock?.length===2?Number(stream.duration_ts)*clock[0]*48000/clock[1]:NaN;
  if(!stream||Number(stream.sample_rate)!==48000||stream.channels!==2||samples!==N
    ||stream.codec_name!=='pcm_s24le'||Number(stream.bits_per_raw_sample??stream.bits_per_sample)!==24)
    fail('actual_stem_sample_or_format_mismatch');
  const measured=(await run('ffmpeg',['-hide_banner','-nostats','-i',file,'-af','astats=metadata=0:reset=0','-f','null','-'])).stderr;
  const peakText=measured.slice(measured.lastIndexOf('Overall')).match(/Peak level dB:\s*(-inf|[-+\d.]+)/)?.[1];
  const peak=peakText==='-inf'?-Infinity:Number(peakText);
  if(peakText===undefined||peak>=0||Number.isNaN(peak))fail('actual_stem_not_safe');
  return {duration_samples:samples,channels:2,sample_rate:48000,bit_depth:24,
    sample_peak_dbfs:Number.isFinite(peak)?peak:null,digital_silence:peak===-Infinity};
}
async function measureRawMix(original,accompaniment,N){
  const measured=(await run('ffmpeg',['-hide_banner','-nostats','-i',original,'-i',accompaniment,
    '-filter_complex',`[0:a:0][1:a:0]amix=inputs=2:normalize=0:duration=first,atrim=end_sample=${N},ebur128=peak=true[m]`,
    '-map','[m]','-f','null','-'])).stderr;
  const peakText=measured.slice(measured.lastIndexOf('Summary:')).match(/Peak:\s*([-+\d.]+|[-+]?inf)\s+dBFS/i)?.[1];
  const peak=Number(peakText);if(!Number.isFinite(peak))fail('raw_mix_peak_measurement_required');
  return {true_peak_dbfs:peak,method:'actual_FFmpeg_original_once_plus_accompaniment_once_no_normalization',account_calls:0};
}

// Technical preview continuation only. Never edits stems or approves the raw mix.
export async function recoverDiagnosticPreview({trial_binding,config,output_dir}){
  const started=performance.now(),startedAt=new Date().toISOString();
  if(!isIndependentMusicPackTrial(config)||!path.isAbsolute(output_dir??''))fail('diagnostic_policy_required');
  // This is a local continuation of the already authorized diagnostic render.
  const policy=await validateIndependentMusicPackPolicy(config,{outputDirectory:output_dir,operation:'render_research_trial'});
  const trial=await load(trial_binding),render=trial.render,N=trial.duration_samples;
  if(trial.schema_version!==1||trial.purpose!=='technical_diagnostic'||trial.production_approval!==false
    ||render?.purpose!=='technical_diagnostic'||render.production_approval!==false
    ||render.source_policy?.kind!=='independent_pack_trial'
    ||render.source_policy?.authorization?.sha256!==policy.authorization.sha256
    ||!Number.isSafeInteger(N)||N<=0||!path.isAbsolute(trial.audio_dir??''))fail('actual_diagnostic_trial_required');
  if(inside(output_dir,trial.audio_dir))fail('separate_output_directory_required');
  const audioDir=path.resolve(trial.audio_dir),jobDir=path.dirname(audioDir);
  const outputBinding=key=>{const entry=render.outputs?.[key];
    if(!entry?.path||!/^[a-f0-9]{64}$/.test(entry.sha256??''))fail('actual_output_binding_required');
    const file=path.resolve(jobDir,entry.path);if(!inside(file,jobDir))fail('output_outside_bound_render_job');
    return {path:file,sha256:entry.sha256};};
  const planBinding=outputBinding('plan.json'),reportBinding=outputBinding('render/report.json');
  const [plan,report]=await Promise.all([load(planBinding),load(reportBinding)]);
  if(typeof plan.manifest!=='string'||!plan.manifest.trim())fail('actual_plan_manifest_required');
  const manifestBinding={path:path.resolve(path.dirname(planBinding.path),plan.manifest),sha256:report.input_binding?.manifest_sha256};
  const manifest=await load(manifestBinding);
  await verifyEvidenceBindings([trial.inputs.manifest,config.manifest]);
  if(trial.inputs.manifest.sha256!==config.manifest.sha256)fail('config_source_manifest_mismatch');
  const originalManifest=await readJson(config.manifest.path);
  if(manifest.analysis_window||originalManifest.analysis_window||report.duration_samples!==N||manifest.timeline?.duration_samples!==N
    ||originalManifest.timeline?.duration_samples!==N||report.sample_rate!==48000
    ||manifest.source_sha256!==trial.source_video_sha256||originalManifest.source_sha256!==trial.source_video_sha256
    ||report.source_sha256!==trial.source_video_sha256)fail('source_or_full_timeline_mismatch');
  for(const key of ['analysis','director','arc_plan','candidates','edits','case_routes','current_materials']){
    if(config[key]||trial.inputs[key]){
      if(config[key]?.sha256!==trial.inputs[key]?.sha256)fail('config_trial_input_mismatch');
      await verifyEvidenceBindings([config[key],trial.inputs[key]]);
    }
  }
  const problems=await verifyRenderBinding(planBinding.path,audioDir,report);
  if(problems.length)fail('render_binding_changed:'+problems.join(','));
  if(!['technical_ok','needs_mix_review'].includes(report.status)||!Array.isArray(report.issues)
    ||report.issues.some(issue=>!allowedIssues.has(issue)))fail('raw_mix_issue_not_recoverable');
  if(report.status==='technical_ok'&&report.issues.length)fail('raw_report_status_mismatch');
  const files=[trial_binding,planBinding,reportBinding,manifestBinding,trial.inputs.manifest,config.manifest];
  const stemFacts={};
  for(const track of tracks){
    const binding=outputBinding(track);
    if(binding.path!==path.join(audioDir,`${track}.wav`)||binding.sha256!==report.output_sha256?.[track])fail('stem_report_binding_mismatch');
    await verifyEvidenceBindings(binding);
    if(report.output_sample_peaks_before_pcm_clamping?.[track]?.clipped!==false)fail('upstream_stem_overload');
    stemFacts[track]=await waveFacts(binding.path,N);files.push(binding);
  }
  const original=path.resolve(path.dirname(manifestBinding.path),manifest.original_audio);
  const source=path.resolve(path.dirname(manifestBinding.path),manifest.source_video);
  files.push({path:original,sha256:report.input_binding.original_audio_sha256},{path:source,sha256:manifest.source_sha256});
  await verifyEvidenceBindings(files);
  const raw=await measureRawMix(original,path.join(audioDir,'accompaniment.wav'),N);
  if(!Number.isFinite(report.complete_mix?.true_peak_dbfs)||Math.abs(raw.true_peak_dbfs-report.complete_mix.true_peak_dbfs)>.11)
    fail('raw_mix_peak_report_mismatch');
  const overload=report.issues.some(issue=>issue==='original_plus_accompaniment_digital_overload'
    ||issue==='complete_mix_true_peak_at_or_above_0_dbfs')||raw.true_peak_dbfs>=0;
  let gain=overload?-Math.ceil((raw.true_peak_dbfs+2)*10)/10:0;
  if(gain<-6||gain>0)fail('bounded_preview_trim_insufficient');
  try{if((await readdir(output_dir)).length)fail('output_directory_must_be_empty');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(output_dir,{recursive:true});
  const attempts=[];let accepted;
  for(let attempt=1;attempt<=2;attempt++){
    const preview=path.join(output_dir,`diagnostic-preview-${attempt}.mp4`);
    const flags=gain<0?['--review-only','--preview-master-gain-db',String(gain)]
      :report.status==='needs_mix_review'?['--assisted-review-only']:['--review-only'];
    let executionError=null;const attemptStarted=performance.now(),attemptStartedAt=new Date().toISOString();
    try{await run(process.execPath,[path.join(here,'export_preview.mjs'),planBinding.path,'--render',audioDir,'--out',preview,...flags]);}
    catch(error){executionError=String(error.stderr||error.stdout||error.message).slice(-4000);}
    const attemptFinishedAt=new Date().toISOString(),attemptElapsed=performance.now()-attemptStarted;
    let encoded;
    try{encoded=await readJson(`${preview}.json`);}catch{fail('export_did_not_produce_bound_report:'+executionError);}
    attempts.push({attempt,gain_db:gain,encoded_report:await bound(`${preview}.json`),
      started_at:attemptStartedAt,finished_at:attemptFinishedAt,elapsed_ms:attemptElapsed,
      encoded_technical_status:encoded.encoded_technical_status,encoded_true_peak_dbfs:encoded.encoded_true_peak_dbfs,execution_error:executionError});
    if(encoded.source_sha256!==trial.source_video_sha256||encoded.duration_samples!==N||encoded.production_approval!==false
      ||encoded.preview_mastering?.stem_files_modified!==false||encoded.preview_mastering.gain_db!==gain
      ||encoded.preview_mastering.relative_dialogue_music_balance_changed!==false)fail('encoded_preview_identity_mismatch');
    const safe=encoded.encoded_technical_status==='technical_ok'&&encoded.faststart_verified===true
      &&encoded.lightweight_preview_status==='within_size_limit'&&encoded.encoded_true_peak_dbfs!==null
      &&encoded.encoded_true_peak_dbfs<0&&(!overload||encoded.encoded_true_peak_dbfs<=-1.5);
    if(safe&&!executionError){accepted={preview:await bound(preview),report:encoded};break;}
    if(attempt===2||!overload||!Number.isFinite(encoded.encoded_true_peak_dbfs))fail('encoded_preview_not_safe');
    gain-=Math.ceil((encoded.encoded_true_peak_dbfs+1.7)*10)/10;
    if(gain<-6)fail('bounded_preview_trim_insufficient');
  }
  await verifyEvidenceBindings(files);
  const finishedAt=new Date().toISOString(),elapsedMs=performance.now()-started;
  const receipt=await saveJson(path.join(output_dir,'preview-recovery-receipt.json'),{schema_version:1,
    kind:'bounded_independent_diagnostic_preview_recovery',trial:trial_binding,raw_plan:planBinding,raw_report:reportBinding,
    source_video_sha256:trial.source_video_sha256,duration_samples:N,source_policy:policy,
    original_raw_mix_status:report.status,original_raw_mix_issues:report.issues,raw_mix_measurement:raw,stem_facts:stemFacts,
    original_sound_coverage_status:render.coverage_status??'not_declared',source_facts_approved:false,
    preview:accepted.preview,encoded_report:attempts.at(-1).encoded_report,attempts,preview_master_gain_db:gain,
    encoded_technical_status:'technical_ok',raw_outputs_modified:false,raw_mix_approved:false,relative_balance_changed:false,
    editing_or_music_changed:false,original_pending:trial.unresolved??[],production_approval:false,
    artistic_acceptance:'not_assessed',actual_listening_review:'not_performed',account_calls:0,
    started_at:startedAt,finished_at:finishedAt,elapsed_ms:elapsedMs,elapsed_seconds:elapsedMs/1000,
    timing_basis:'native_wall_clock_and_monotonic_runtime_including_all_attempts'});
  return {status:'restricted_diagnostic_preview',preview:accepted.preview,receipt,duration_samples:N,
    preview_master_gain_db:gain,production_approval:false,raw_mix_approved:false,
    started_at:startedAt,finished_at:finishedAt,elapsed_ms:elapsedMs};
}
