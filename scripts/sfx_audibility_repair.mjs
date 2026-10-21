import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {reconstructSoundContribution,compareSoundToCompetingMix} from './sound_audibility_measurement.mjs';
import {validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {validatePreparedSoundFunction,sfxEventFunctionRevision} from './sfx_event_function.mjs';
import {assemblySfxCandidatePoolRevision,verifyObservedAssemblySfxCandidate} from './assembly_sfx_candidate_pool.mjs';

export const sfxAudibilityRepairRevision='bounded-diagnostic-sfx-gain-v1';
const RATE=48000,implementation=fileURLToPath(import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const need=(value,reason)=>{if(!value)throw Error('sfx_audibility_repair_'+reason);};
const db=v=>v>0?20*Math.log10(v):null;
const noApproval={qualification_granted:false,original_sound_fact_approval:false,artistic_approval:false,production_approval:false};
const pcm24=v=>Math.max(-8388608,Math.min(8388607,Math.round(v*8388608)))/8388608;
const peak=data=>{let max=0;for(const v of data){need(Number.isFinite(v),'nonfinite_pcm');max=Math.max(max,Math.abs(v));}return max;};
const bind=async file=>({path:path.resolve(file),sha256:hash(await readFile(file))});
async function boundJson(ref){need(path.isAbsolute(ref?.path??'')&&/^[a-f0-9]{64}$/.test(ref.sha256??''),'bound_file_required');
  const b=await readFile(ref.path);need(hash(b)===ref.sha256,'bound_file_changed');return JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));}

export function validateSfxAudibilityRepairPolicy(value){
  need(same(value,{revision:sfxAudibilityRepairRevision}),'explicit_supported_policy_required');
  return {revision:sfxAudibilityRepairRevision};
}

// The normal research consumer has already verified the candidate's selector
// and final adoption chain. Preserve only its explicit point function; no role
// is inferred from sync, file name or a short source window.
export async function preserveExplicitPointSoundPlacement({design,plan,candidates,analysis,edits,sourceSha}){
  let result=design;
  for(const row of edits.sounds){
    if(row.decision!=='new_asset')continue;
    const matches=candidates.filter(c=>c.event_id===row.event_id&&c.segment_id===row.selected_segment_id);
    const pointer=matches[0];
    if(pointer?.sound_function_intent===undefined&&pointer?.sound_usage===undefined)continue;
    if(pointer?.sound_function_intent?.expected_function!=='point'&&pointer?.sound_usage?.function!=='point')continue;
    need(matches.length===1,'point_candidate_ownership_not_unique');
    const events=analysis.sound_events.filter(e=>e.id===row.event_id);need(events.length===1,'point_event_ownership_not_unique');
    const selection=await boundJson(pointer.selection_record);
    need(selection.source_video_sha256===sourceSha&&selection.decisions?.some(d=>d.event_id===row.event_id
      &&d.selected_segment_id===pointer.segment_id&&same(d.selected_source_range,row.source_range)), 'point_actual_selection_changed');
    const pool=selection.original_pool?await boundJson(selection.original_pool):null;
    const prepared=pool?.prepared_candidate??pointer;
    if(pool)need(pool.kind==='sound_pool_pending_final_assembly'&&pool.source_video_sha256===sourceSha
      &&pool.qualified===false&&pool.production_approval===false,'point_original_pool_changed');
    const observedPool=pointer.assembly_sfx_pool_contract_revision===assemblySfxCandidatePoolRevision;
    // An observed pool has no chosen usage. The actual assembly return owns
    // usage, independently bound back to the unchanged original observations.
    if(observedPool)await verifyObservedAssemblySfxCandidate({candidate:pointer,sourceSha});
    const explicit=validatePreparedSoundFunction(observedPool?pointer:prepared,events[0]);
    need((observedPool?['sound_function_intent','duration_role','segment_id','source_sha256','local_path','event_id','source_anchor_seconds']
      :['sound_function_intent','sound_usage','selector_adopt_reason','duration_role','segment_id','source_sha256','local_path',
        'event_id','source_anchor_seconds']).every(k=>same(prepared[k],pointer[k])),'point_selected_function_changed');
    if(explicit.usage.function!=='point')continue;
    need(explicit.intent.revision===sfxEventFunctionRevision&&pointer.duration_role==='transient','explicit_point_role_required');
    const permitted=observedPool?pointer.selection_source_ranges:prepared.selection_source_ranges;
    need(permitted.some(r=>row.source_range?.length===2&&row.source_range[0]>=r[0]&&row.source_range[1]<=r[1])
      &&row.source_anchor_seconds===pointer.source_anchor_seconds&&row.source_anchor_seconds>=row.source_range[0]
      &&row.source_anchor_seconds<row.source_range[1],'point_selected_window_or_anchor_changed');
    need(pointer.event_id===row.event_id&&pointer.current_target_video_sha256===sourceSha
      &&same(pointer.current_event_target_range,[events[0].start_seconds,events[0].end_seconds])
      &&Number.isFinite(row.target_seconds)&&row.target_seconds>=events[0].start_seconds
      &&row.target_seconds<events[0].end_seconds,'point_target_event_changed');
    const eventRows=design.sound_events.filter(e=>e.id===row.event_id),cue=plan.cues.find(c=>c.id===eventRows[0]?.cue_id);
    const asset=plan.assets.find(a=>a.id===cue?.asset_id);
    need(eventRows.length===1&&eventRows[0].decision==='new_asset'&&cue?.track==='sfx'&&cue.source_in_seconds===row.source_range[0]
      &&cue.source_out_seconds===row.source_range[1]&&same(cue.sync,{target_seconds:row.target_seconds,source_anchor_seconds:row.source_anchor_seconds})
      &&asset?.path===pointer.local_path&&asset.sha256===pointer.source_sha256,'point_compiled_operands_changed');
    if(result===design)result=structuredClone(design);
    const event=result.sound_events.find(e=>e.id===row.event_id);event.duration_role='transient';
    event.current_event_target_range=[...pointer.current_event_target_range];
    event.source_placement=Object.fromEntries(['duration_role','local_path','source_sha256','source_anchor_seconds','event_id',
      'current_event_target_range','current_target_video_sha256','source_anchor_evidence','anchor_review_status'].map(k=>[k,pointer[k]]));
    event.source_placement.source_range=[...row.source_range];
    event.source_placement.function_review_status=observedPool?'unapproved_assembly_hypothesis':'unapproved_selector_hypothesis';
    Object.assign(event.source_placement,noApproval);
  }
  return result;
}
function normalizePlan(plan,file){const value=structuredClone(plan),base=path.dirname(path.resolve(file));
  value.manifest=path.resolve(base,value.manifest);for(const a of value.assets)value.assets[value.assets.indexOf(a)].path=path.resolve(base,a.path);
  delete value.technical_sfx_gain_origin;return value;}
export async function inspectSfxGainOrigin(plan,planFile){
  const ref=plan.technical_sfx_gain_origin;
  if(ref===undefined)return {original:structuredClone(plan),origin:await bind(planFile),cumulative:new Map(plan.cues.map(c=>[c.id,0]))};
  need(ref.revision===sfxAudibilityRepairRevision&&same(Object.keys(ref).sort(),['original_plan','revision']),'origin_contract_invalid');
  const original=await boundJson(ref.original_plan);need(original.technical_sfx_gain_origin===undefined,'origin_rebase_forbidden');
  const current=normalizePlan(plan,planFile),prior=normalizePlan(original,ref.original_plan.path),cumulative=new Map();
  need(current.cues.length===prior.cues.length,'origin_cue_count_changed');
  for(let i=0;i<current.cues.length;i++){
    const cue=current.cues[i],before=prior.cues[i];need(cue.id===before.id,'origin_cue_identity_changed');
    const delta=(cue.gain_db??0)-(before.gain_db??0);
    need(Number.isFinite(delta)&&delta>=0&&delta<=6&&(delta===0||cue.track==='sfx'),'cumulative_gain_limit_or_foreign_edit');
    cumulative.set(cue.id,delta);cue.gain_db=before.gain_db;
    if(before.gain_db===undefined)delete cue.gain_db;
  }
  need(same(current,prior),'origin_non_gain_operand_changed');
  return {original,origin:ref.original_plan,cumulative};
}
function diagnostic(plan){const c=plan.independent_trial_context;
  need(c?.mode==='research'&&c.automatic_trial===true&&c.material_strategy==='independent_music_packs'
    &&c.source_policy?.kind==='independent_pack_trial'&&c.trial_review_policy==='diagnostic_candidates'
    &&c.production_approval===false,'independent_diagnostic_scope_required');
  return c.source_policy.authorization;
}
function dialogueRisk(own,original,start,intervals){
  const rows=[];
  for(const interval of intervals){
    const begin=Math.max(start,Math.round(interval.start_seconds*RATE)),end=Math.min(start+own.length/2,Math.round(interval.end_seconds*RATE));
    for(let from=begin;from<end;from+=4800){const to=Math.min(end,from+4800);let op=0,bp=0;
      for(let i=from*2;i<to*2;i++){op+=own[i-start*2]**2;bp+=original[i]**2;}
      const ownDb=db(Math.sqrt(op/((to-from)*2))),originalDb=db(Math.sqrt(bp/((to-from)*2)));
      // Original-track activity is a numeric proxy, never a speech or hearing certificate.
      if(originalDb!==null&&originalDb>=-50)rows.push({target_sample_range:[from,to],original_rms_dbfs:originalDb,
        contribution_rms_dbfs:ownDb,relative_rms_db:ownDb===null?null:ownDb-originalDb});
    }
  }
  return {window_samples:4800,original_activity_floor_dbfs:-50,maximum_relative_rms_db:rows.length?Math.max(...rows.map(r=>r.relative_rms_db??-Infinity)):null,
    risk:rows.some(r=>r.relative_rms_db!==null&&r.relative_rms_db>-12),measurements:rows,
    interpretation:'conservative_bound_original_track_energy_proxy_not_verified_speech_or_masking',...noApproval};
}
function deliveredBus(original,stems){return Float32Array.from(original,(v,i)=>v+pcm24(stems.bgm[i]+stems.sfx[i]+stems.ambience[i]));}
function competition(original,stems,own,start){return Float32Array.from(own,(_,i)=>{
  const at=start*2+i;return original[at]+pcm24(stems.bgm[at])+pcm24(stems.sfx[at])+pcm24(stems.ambience[at])-own[i];});}
export async function measureSfxRepairBus(data,outputDirectory,label){
  const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
  const args=['-hide_banner','-nostats','-nostdin','-f','f32le','-ar',String(RATE),'-ac','2','-i','pipe:0',
    '-map','0:a:0','-af','ebur128=peak=true:framelog=verbose','-f','null','-'];
  const stderr=await new Promise((resolve,reject)=>{const child=spawn('ffmpeg',args,{windowsHide:true,shell:false});let text='';
    child.stderr.on('data',b=>{text+=b.toString();});child.stdout.resume();child.on('error',reject);
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});
    child.on('close',code=>code===0?resolve(text):reject(Error('sfx_audibility_repair_true_peak_meter_failed')));child.stdin.end(bytes);});
  const summary=stderr.slice(stderr.lastIndexOf('Summary:'));
  const parse=re=>{const v=summary.match(re)?.[1];need(v!==undefined,'true_peak_summary_required');return Number.isFinite(Number(v))?Number(v):null;};
  const file=path.join(outputDirectory,label+'-ebur128.log');await writeFile(file,stderr,{flag:'wx'});
  return {true_peak_dbtp:parse(/Peak:\s*([-+\d.]+|[-+]?inf)\s+dBFS/i),integrated_lufs:parse(/I:\s*([-+\d.]+|[-+]?inf)\s+LUFS/i),
    precision_db:.1,duration_samples:data.length/2,pcm_f32_sha256:hash(bytes),receipt:await bind(file),command:'ffmpeg',args,
    source_decodes:0,measurement:'existing_pcm_sum_only'};
}

// Called by the normal renderer before writing any stems. This owns no model call.
export async function executeSfxAudibilityRepair({policy,planFile,plan,manifest,placements,assets,original,stems,
  inputBinding,soundDecisionsFile,finalMixMaster,outputDirectory}){
  validateSfxAudibilityRepairPolicy(policy);const authorization=diagnostic(plan);await boundJson(authorization);
  await validateIndependentMusicPackPolicy(plan.independent_trial_context,{outputDirectory:path.resolve(outputDirectory),operation:'render_plan'});
  need(same(finalMixMaster,{revision:'uniform-final-bus-master-v1',target_true_peak_dbtp:-2}),'safe_final_master_required');
  need(Array.isArray(plan.dialogue_intervals),'bound_dialogue_intervals_required');
  const N=manifest.timeline.duration_samples;need(Number.isSafeInteger(N)&&N>0&&original.length===N*2,'full_pcm_clock_required');
  need((await bind(planFile)).sha256===inputBinding?.plan_sha256,'current_plan_binding_changed');
  const manifestFile=path.resolve(path.dirname(planFile),plan.manifest);
  need((await bind(manifestFile)).sha256===inputBinding.manifest_sha256,'manifest_binding_changed');
  const originalFile=path.resolve(path.dirname(manifestFile),manifest.original_audio);
  need((await bind(originalFile)).sha256===inputBinding.original_audio_sha256,'original_binding_changed');
  for(const asset of plan.assets)need((await bind(path.resolve(path.dirname(planFile),asset.path))).sha256===inputBinding.asset_sha256[asset.id],
    'actual_asset_binding_changed');
  for(const name of ['bgm','sfx','ambience'])need(stems[name]?.length===original.length,'stem_clock_changed');
  const designBinding=await bind(soundDecisionsFile),design=await boundJson(designBinding);
  need(Array.isArray(design.sound_events),'sound_decisions_required');
  const history=await inspectSfxGainOrigin(plan,planFile),out=path.resolve(outputDirectory);await mkdir(out,{recursive:true});
  const inputs={source_video_sha256:manifest.source_sha256,plan:await bind(planFile),origin_plan:history.origin,
    authorization,sound_decisions:designBinding,render_input_binding:structuredClone(inputBinding),
    original_pcm_f32_sha256:hash(Buffer.from(original.buffer,original.byteOffset,original.byteLength)),
    stem_pcm_f32_sha256:Object.fromEntries(Object.entries(stems).map(([k,v])=>[k,hash(Buffer.from(v.buffer,v.byteOffset,v.byteLength))]))};
  const fixed={maximum_per_attempt_db:3,maximum_cumulative_db:6,steps_db:[1,2,3],local_peak_minus_competing_rms_max_db:-3,
    absolute_effective_gain_min_db:-40,absolute_effective_gain_max_db:12,
    dialogue_contribution_minus_active_original_rms_max_db:-12,original_activity_floor_dbfs:-50,
    final_bus_true_peak_limit_dbtp:-2.1,baseline_uniform_master_held:true,warning_threshold_is_not_target:true};
  const request={schema_version:1,kind:'bound_diagnostic_sfx_gain_repair_request',policy,limits:fixed,inputs,
    adopted_scope:placements.filter(p=>p.track==='sfx').map(p=>({cue_id:p.id,asset_id:p.asset_id,
      source_sha256:inputBinding.asset_sha256[p.asset_id],source_sample_range:[p.source_in_sample,p.source_out_sample],
      target_sample_range:[p.rendered_start_sample,p.end_sample],gain_db:p.gain_db,
      event_ids:design.sound_events.filter(e=>e.cue_id===p.id).map(e=>e.id)})),
    duration_samples:N,actual_pcm_consumer:true,model_calls:0,...noApproval};
  const requestFile=path.join(out,'request.json');await writeFile(requestFile,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
  const baselineBus=deliveredBus(original,stems),baseline=await measureSfxRepairBus(baselineBus,out,'baseline');
  const baselineMasterGain=baseline.true_peak_dbtp===null?0:-Math.ceil(Math.max(0,baseline.true_peak_dbtp+2.1)*10)/10;
  const appliedStems={...stems,sfx:new Float32Array(stems.sfx)},tasks=[],changes=[];
  for(let index=0;index<placements.length;index++){
    const placement=placements[index];if(placement.track!=='sfx')continue;
    const rows=design.sound_events.filter(e=>e.cue_id===placement.id);
    need(rows.length===1,'event_ownership_not_unique');const event=rows[0];
    need(event.decision==='new_asset','only_actual_adopted_sound_allowed');
    const role=event.duration_role??null;
    const task={event_id:event.id,cue_id:placement.id,duration_role:role,required:event.required===true,
      source_sample_range:[placement.source_in_sample,placement.source_out_sample],
      target_sample_range:[placement.rendered_start_sample,placement.end_sample],original_gain_db:placement.gain_db,
      cumulative_gain_before_db:history.cumulative.get(placement.id),candidates:[],selected_delta_db:0,...noApproval};
    tasks.push(task);
    if(!['bed','transient'].includes(role)){task.unresolved=['explicit_actual_duration_role_required'];continue;}
    const asset=plan.assets.filter(a=>a.id===placement.asset_id);need(asset.length===1,'asset_identity_not_unique');
    need(asset[0].sha256===inputBinding.asset_sha256[placement.asset_id],'asset_sha_changed');
    if(role==='bed')need(same(event.current_event_target_range,[placement.rendered_start_sample/RATE,placement.end_sample/RATE])
      &&event.source_placement?.source_sha256===asset[0].sha256
      &&same(event.source_placement?.source_range,[placement.source_in_sample/RATE,placement.source_out_sample/RATE])
      &&path.resolve(event.source_placement?.local_path??'')===path.resolve(path.dirname(planFile),asset[0].path)
      &&event.source_placement?.event_id===event.id&&event.source_placement?.current_target_video_sha256===manifest.source_sha256,'bed_window_or_event_changed');
    const source=assets.get(placement.asset_id);need(source&&placement.source_out_sample<=source.length/2,'adopted_source_window_changed');
    const own=reconstructSoundContribution(source.subarray(placement.source_in_sample*2,placement.source_out_sample*2),placement);
    const background=competition(original,appliedStems,own,placement.rendered_start_sample);
    const before=compareSoundToCompetingMix(own,background,{startSample:placement.rendered_start_sample,durationRole:role});
    task.baseline=before;
    const eligible=before.technical_risks.includes(role==='bed'?'sound_bed_low_relative_energy_requires_audio_review'
      :'point_sound_peak_below_competing_local_rms_requires_audio_review');
    if(!eligible){task.unresolved=[];task.status='no_low_energy_risk';continue;}
    const remaining=6-task.cumulative_gain_before_db;
    const common=[];
    if(before.attack_window.peak_minus_competing_rms_db===null||before.attack_window.peak_minus_competing_rms_db>=-3)common.push('local_spike_already_strong');
    if(!plan.dialogue_intervals.length&&manifest.has_source_audio)common.push('dialogue_intervals_not_available');
    const previousDialogue=dialogueRisk(own,original,placement.rendered_start_sample,plan.dialogue_intervals);
    if(previousDialogue.risk)common.push('existing_dialogue_energy_risk');
    if(remaining<=0)common.push('cumulative_gain_limit_reached');
    let chosenStems;
    for(const delta of [1,2,3].filter(v=>v<=remaining)){
      const increased=reconstructSoundContribution(source.subarray(placement.source_in_sample*2,placement.source_out_sample*2),
        {...placement,gain_db:placement.gain_db+delta}),candidateStems={...appliedStems,sfx:new Float32Array(appliedStems.sfx)};
      for(let i=0;i<increased.length;i++)candidateStems.sfx[placement.rendered_start_sample*2+i]+=increased[i]-own[i];
      const contribution=compareSoundToCompetingMix(increased,background,{startSample:placement.rendered_start_sample,durationRole:role});
      const dialogue=dialogueRisk(increased,original,placement.rendered_start_sample,plan.dialogue_intervals);
      const bus=deliveredBus(original,candidateStems),meter=await measureSfxRepairBus(bus,out,'cue-'+index+'-plus-'+delta);
      const reasons=[...common];
      const gainOperands=[0,...(placement.gain_envelope??[]).map(point=>point.gain_db)];
      if(gainOperands.some(relative=>!Number.isFinite(relative)||placement.gain_db+delta+relative< -40
        ||placement.gain_db+delta+relative>12))reasons.push('candidate_absolute_effective_gain_out_of_contract');
      if(contribution.attack_window.peak_minus_competing_rms_db===null||contribution.attack_window.peak_minus_competing_rms_db>=-3)reasons.push('candidate_local_spike_risk');
      if(dialogue.risk)reasons.push('candidate_dialogue_energy_risk');
      if(peak(candidateStems.sfx)>=1||peak(Float32Array.from(original,(_,i)=>candidateStems.bgm[i]+candidateStems.sfx[i]+candidateStems.ambience[i]))>=1)reasons.push('candidate_stem_overload');
      if(meter.true_peak_dbtp!==null&&meter.true_peak_dbtp+baselineMasterGain> -2.1+.000001)reasons.push('candidate_fixed_master_true_peak_risk');
      const candidate={delta_gain_db:delta,cumulative_gain_db:task.cumulative_gain_before_db+delta,
        measurement:contribution,dialogue_energy:dialogue,bus_measurement:meter,
        baseline_uniform_master_gain_db:baselineMasterGain,fixed_master_true_peak_dbtp:meter.true_peak_dbtp===null?null:meter.true_peak_dbtp+baselineMasterGain,
        accepted_for_diagnostic_edit:!reasons.length,rejections:[...new Set(reasons)],...noApproval};
      task.candidates.push(candidate);
      if(candidate.accepted_for_diagnostic_edit&&!chosenStems)chosenStems=candidateStems;
    }
    const chosen=task.candidates.find(c=>c.accepted_for_diagnostic_edit);
    task.unresolved=chosen?chosen.measurement.technical_risks:[...new Set([...common,...task.candidates.flatMap(c=>c.rejections)])];
    task.status=chosen?'bounded_gain_improvement_selected_risks_retained':'no_legal_gain_improvement';
    if(chosen){appliedStems.sfx=chosenStems.sfx;
      task.selected_delta_db=chosen.delta_gain_db;changes.push({cue_id:placement.id,event_id:event.id,delta_gain_db:chosen.delta_gain_db,
        gain_before_db:placement.gain_db,gain_after_db:placement.gain_db+chosen.delta_gain_db,cumulative_gain_db:chosen.cumulative_gain_db});}
  }
  let appliedPlan;
  if(changes.length){const value=normalizePlan(plan,planFile);
    for(const change of changes)value.cues.find(c=>c.id===change.cue_id).gain_db=change.gain_after_db;
    value.technical_sfx_gain_origin={revision:sfxAudibilityRepairRevision,original_plan:history.origin};
    const file=path.join(out,'applied-plan.json');await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});appliedPlan=await bind(file);
    await inspectSfxGainOrigin(value,file);
  }
  const result={schema_version:1,kind:'executed_bounded_diagnostic_sfx_gain_repair',policy,request:await bind(requestFile),
    baseline_bus:baseline,baseline_uniform_master_gain_db:baselineMasterGain,tasks,changes,
    status:changes.length?'bounded_gain_improvement_applied_review_risks_retained':'no_legal_gain_improvement_outputs_retained',
    ...(appliedPlan?{applied_plan:appliedPlan}:{}),required_omissions:design.sound_events.filter(e=>e.required===true&&e.decision!=='new_asset')
      .map(e=>({event_id:e.id,required:true,decision:e.decision,reason:e.reason,independent_of_gain_repair:true})),
    implementation:await bind(implementation),original_track_changed:false,bgm_operands_changed:false,
    source_windows_changed:false,event_ownership_changed:false,fully_repaired:false,model_calls:0,new_decodes:0,
    encoded_readback:'normal_final_mix_master_consumer_required',...noApproval};
  const resultFile=path.join(out,'result.json');await writeFile(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return {record:await bind(resultFile),result,stems:appliedStems,appliedPlan};
}
