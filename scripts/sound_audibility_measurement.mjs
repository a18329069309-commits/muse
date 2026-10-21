import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,saveJson,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile,verifyRenderBinding} from './render_binding.mjs';

const run=promisify(execFile),RATE=48000,implementation=fileURLToPath(import.meta.url);
const dB=value=>value>0?20*Math.log10(value):null;
const sample=value=>Math.round(value*RATE);
const stats=data=>{
  let power=0,peak=0,peakIndex=0;
  for(let index=0;index<data.length;index++){
    const value=data[index];if(!Number.isFinite(value))throw Error('sound_measurement_nonfinite_pcm');
    power+=value*value;if(Math.abs(value)>peak){peak=Math.abs(value);peakIndex=index;}
  }
  return {peak_linear:peak,peak_dbfs:dB(peak),rms_linear:Math.sqrt(power/data.length),
    rms_dbfs:dB(Math.sqrt(power/data.length)),peak_frame:Math.floor(peakIndex/2)};
};
const finiteDifference=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a-b:null;

async function decode(file,start,end){
  const command=['-v','error','-nostdin','-i',file,'-map','0:a:0','-af',
    `aresample=${RATE},atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS`,
    '-ar',String(RATE),'-ac','2','-f','f32le','pipe:1'];
  const {stdout,stderr}=await run('ffmpeg',command,{windowsHide:true,encoding:'buffer',maxBuffer:128*1024*1024});
  if(stderr.length||stdout.length!==(end-start)*8)throw Error('sound_measurement_exact_pcm_range_required');
  return {data:new Float32Array(stdout.buffer.slice(stdout.byteOffset,stdout.byteOffset+stdout.length)),command};
}

// Match the renderer's actual gain, envelope, fades and leading trim. No gain is changed.
export function reconstructSoundContribution(input,placement){
  const length=placement.source_out_sample-placement.source_in_sample;
  if(input.length!==length*2)throw Error('sound_contribution_exact_source_range_required');
  const trim=placement.leading_trim_samples??0,result=new Float32Array((length-trim)*2);
  let envelopeIndex=0;
  for(let index=trim;index<length;index++){
    const position=Math.min(1,placement.fade_in_samples?index/placement.fade_in_samples:1,
      placement.fade_out_samples?(length-1-index)/placement.fade_out_samples:1);
    const fade=placement.fade_curve==='raised_cosine'?(1-Math.cos(Math.PI*position))/2
      :placement.fade_curve==='equal_power'?Math.sin(Math.PI*position/2):position;
    let envelopeGain=1;
    if(placement.gain_envelope){
      while(envelopeIndex<placement.gain_envelope.length-2&&index>=placement.gain_envelope[envelopeIndex+1].offset_sample)envelopeIndex++;
      const a=placement.gain_envelope[envelopeIndex],b=placement.gain_envelope[envelopeIndex+1];
      envelopeGain=10**((a.gain_db+(b.gain_db-a.gain_db)*(index-a.offset_sample)/(b.offset_sample-a.offset_sample))/20);
    }
    const gain=10**(placement.gain_db/20)*envelopeGain*fade;
    for(let channel=0;channel<2;channel++)result[(index-trim)*2+channel]=input[index*2+channel]*gain;
  }
  return result;
}

export function compareSoundToCompetingMix(contribution,competing,{startSample=0,targetSample=null,durationRole='transient'}={}){
  if(!contribution.length||contribution.length!==competing.length)throw Error('sound_competition_equal_nonempty_ranges_required');
  const own=stats(contribution),background=stats(competing),center=own.peak_frame;
  const from=Math.max(0,center-sample(.05)),to=Math.min(contribution.length/2,center+sample(.05));
  const ownAttack=stats(contribution.subarray(from*2,to*2)),backgroundAttack=stats(competing.subarray(from*2,to*2));
  const peakMargin=finiteDifference(ownAttack.peak_dbfs,backgroundAttack.rms_dbfs);
  const rmsMargin=finiteDifference(own.rms_dbfs,background.rms_dbfs),risks=[];
  if(own.peak_linear===0)risks.push('selected_sound_has_zero_actual_contribution');
  if(own.peak_linear>=1)risks.push('individual_sound_digital_overload');
  if(durationRole==='bed'&&rmsMargin!==null&&rmsMargin<-12)risks.push('sound_bed_low_relative_energy_requires_audio_review');
  if(durationRole!=='bed'&&peakMargin!==null&&peakMargin<-6)risks.push('point_sound_peak_below_competing_local_rms_requires_audio_review');
  return {source_duration_role:durationRole,actual_contribution:own,competing_mix:background,
    attack_window:{target_range:[(startSample+from)/RATE,(startSample+to)/RATE],
      contribution:ownAttack,competing_mix:backgroundAttack,peak_minus_competing_rms_db:peakMargin},
    whole_window_rms_margin_db:rmsMargin,actual_peak_target_seconds:(startSample+center)/RATE,
    requested_anchor_target_seconds:targetSample===null?null:targetSample/RATE,
    technical_risks:risks,audible_quality:'not_judged',perceptual_approval:false,
    threshold_basis:'diagnostic_energy_risk_only_not_hearing_or_semantic_correctness'};
}

export async function collectSoundAudibility({manifestBinding,planBinding,renderDirectory,soundEvents=[]}){
  await verifyEvidenceBindings([manifestBinding,planBinding]);
  const manifest=await readJson(manifestBinding.path),plan=await readJson(planBinding.path);
  if(path.resolve(path.dirname(planBinding.path),plan.manifest)!==path.resolve(manifestBinding.path))throw Error('sound_measurement_manifest_changed');
  const reportBinding={path:path.join(renderDirectory,'report.json'),sha256:await hashFile(path.join(renderDirectory,'report.json'))};
  const report=await readJson(reportBinding.path),problems=await verifyRenderBinding(planBinding.path,renderDirectory,report);
  if(problems.length)throw Error('sound_measurement_render_binding_invalid:'+problems.join(','));
  const original=path.resolve(path.dirname(manifestBinding.path),manifest.original_audio),rows=[];
  for(const cue of plan.cues.filter(row=>row.track==='sfx')){
    const placement=report.cues.find(row=>row.id===cue.id&&row.track==='sfx'),asset=plan.assets.find(row=>row.id===cue.asset_id);
    if(!placement||!asset)throw Error('sound_measurement_selected_cue_missing');
    const range=[placement.rendered_start_sample,placement.end_sample],sourceFile=path.resolve(path.dirname(planBinding.path),asset.path);
    const [source,originalPart,bgmPart,ambientPart,sfxPart]=await Promise.all([
      decode(sourceFile,placement.source_in_sample,placement.source_out_sample),
      decode(original,...range),decode(path.join(renderDirectory,'bgm.wav'),...range),
      decode(path.join(renderDirectory,'ambience.wav'),...range),decode(path.join(renderDirectory,'sfx.wav'),...range)]);
    const contribution=reconstructSoundContribution(source.data,placement),competing=new Float32Array(contribution.length);
    for(let index=0;index<competing.length;index++)competing[index]=originalPart.data[index]+bgmPart.data[index]
      +ambientPart.data[index]+sfxPart.data[index]-contribution[index];
    const event=soundEvents.find(row=>row.cue_id===cue.id),explicitRole=event?.duration_role??cue.duration_role;
    const measured=compareSoundToCompetingMix(contribution,competing,{startSample:range[0],targetSample:placement.target_sample,
      durationRole:explicitRole??(placement.target_sample!==null?'transient':'unknown')});
    const predictedPcm24=Math.min(8388607,Math.round(measured.actual_contribution.peak_linear*8388608))/8388608;
    if(Math.abs(predictedPcm24-placement.contribution_peak_pcm24)>1/8388608)throw Error('sound_measurement_does_not_match_render_contribution');
    rows.push({cue_id:cue.id,asset_id:cue.asset_id,source_sha256:asset.sha256,target_range:range.map(value=>value/RATE),
      gain_db:placement.gain_db,source_file:sourceFile,...measured,
      duration_role_basis:explicitRole?'actual_plan_sound_decision':placement.target_sample!==null?'actual_point_sync':'unknown',
      source_decode_command:source.command});
  }
  return {schema_version:1,kind:'actual_sound_contribution_and_competing_mix_measurement',
    manifest:manifestBinding,plan:planBinding,render_report:reportBinding,
    implementation:{path:implementation,sha256:await hashFile(implementation)},sample_rate:RATE,
    selected_sound_cues:rows.length,events:rows,actual_audio_processed:true,actual_audio_listened:false,
    production_approval:false,perceptual_approval:false,
    measurement_frame:'delivered_stems_and_original_before_preview_master_gain; uniform_master_gain_does_not_change_relative_margins',
    note:'Measures exact individual contribution against original plus BGM, ambience and other SFX; nonzero does not prove audibility.'};
}

export async function measureSoundAudibility(options){
  return saveJson(path.join(options.outputDir,'sound-audibility.json'),await collectSoundAudibility(options));
}
