import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readJson,saveJson,verifyEvidenceBindings,validateSchema,objectSchema} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {buildResearchAudioWindows,createLocalResearchAudioObserver} from './local_research_audio_observer.mjs';
import {isIndependentMusicPackTrial} from './independent_music_policy.mjs';
import {validateEpisodeCallPlan} from './episode_call_admission.mjs';
import {execOwnedFile} from './owned_process_runner.mjs';
import {validateReviewInputLimitPolicy} from './independent_trial_budget.mjs';
import {readPostRenderSoundGaps} from './post_render_sound_gaps.mjs';

export const compositeResearchRevision='actual-mix-picture-composite-research-v1';
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>canonical(a)===canonical(b), digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const str={type:'string'},strings={type:'array',items:str};
const range={type:'array',items:{type:'number'},minItems:2,maxItems:2};
const overlap=(a,b)=>a[0]<b[1]&&b[0]<a[1];
const need=(v,code)=>{if(!v)throw Error('composite_research_'+code);};
export function assertCompositeSoundCompletion(review,gaps){
  need(Array.isArray(gaps),'required_sound_coverage_gaps_required');
  if(review.status==='composite_research_passed')need(!gaps.some(g=>g.blocks_completion===true&&g.status!=='resolved'),
    'required_sound_gaps_unresolved');
  return review;
}
async function compositeRequiredSoundGaps(rendered,input){
  const coverage=await readPostRenderSoundGaps(rendered,input.render_binding,input.source);
  return coverage.gaps.map(gap=>({...gap,origin:'host_required_sound_coverage'}));
}
async function exists(file){try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function saveCompositeArtifact(file,value){
  try{return await saveJson(file,value);}catch(e){if(e.code!=='EEXIST')throw e;
    need(same(await readJson(file),value),'immutable_artifact_changed');return bind(file);}
}
export const issueRepairs=Object.freeze({
  wrong_music:{repair_stage:'material_reselection',allowed_operations:['reselect','source_window','transition','gain','envelope']},
  lyric_perspective:{repair_stage:'material_reselection',allowed_operations:['reselect','source_window','transition','gain','envelope']},
  wrong_emotion:{repair_stage:'material_reselection',allowed_operations:['reselect','source_window','transition','gain','envelope']},
  broken_phrase:{repair_stage:'targeted_edit_revision',allowed_operations:['source_window','transition']},
  abrupt_seam:{repair_stage:'targeted_edit_revision',allowed_operations:['source_window','transition','gain','envelope']},
  missing_sfx:{repair_stage:'sound_material_reselection',allowed_operations:['sound_selection','anchor','gain']},
  inaudible_sfx:{repair_stage:'bounded_sfx_repair',allowed_operations:['gain','envelope']},
  dialogue_masking:{repair_stage:'targeted_edit_revision',allowed_operations:['gain','envelope']},
  overload:{repair_stage:'targeted_edit_revision',allowed_operations:['gain','envelope']},
});
export function validateCompositeResearchConfig(config){
  if(config.review_input_limit_policy!==undefined){
    need(config.quality_review_policy==='composite_research','review_input_limit_composite_scope_required');
    validateReviewInputLimitPolicy(config.review_input_limit_policy);
  }
  if(config.trial_call_plan!==undefined){
    need(isIndependentMusicPackTrial(config),'call_plan_independent_diagnostic_scope_required');
    validateEpisodeCallPlan(config.trial_call_plan);
  }
  if(config.quality_review_policy!=='composite_research')return null;
  need(config.mode==='research'&&config.automatic_trial===true&&isIndependentMusicPackTrial(config)
    &&config.trial_review_policy==='diagnostic_candidates','independent_diagnostic_scope_required');
  const value=config.composite_review;
  need(value?.revision===compositeResearchRevision&&Object.keys(value).every(k=>['revision','audio_observer'].includes(k)),
    'explicit_supported_configuration_required');
  const audio=value.audio_observer;
  need(audio&&Object.keys(audio).every(k=>['python','weights','deps','ffmpeg','gpu_slot'].includes(k))
    &&['python','weights','deps'].every(k=>path.isAbsolute(audio[k]??'')),'bound_local_audio_runtime_required');
  return value;
}
export function researchAudioCompletionGaps(screen){
  return (screen.windows??[]).flatMap(w=>{
    const t=w.generation_termination;
    const reason=w.actual_audio_processed!==true?'research_audio_not_processed':!t?'research_audio_generation_termination_unknown'
      :t.last_token_is_configured_eos!==true||t.max_tokens_reached!==false||t.max_time_threshold_reached!==false
        ?'research_audio_generation_truncated':typeof w.raw_observation!=='string'||!w.raw_observation.trim()
          ?'research_audio_observation_empty':null;
    return reason?[{reason,window_id:w.id,target_range:w.source_range??null}]:[];
  });
}

// Compare the entire decision, masking only host-authorized operands on owned objects.
// In particular, global ducking and original-track controls are never local repair operands.
export function auditScopedRepair(before,after,scope){
  const left=structuredClone(before),right=structuredClone(after),
    cueOwned=id=>scope.cue_ids.some(c=>id===c||id?.startsWith(c+'/arc/'));
  const cueOps=id=>new Set(scope.cue_operations?.[scope.cue_ids.find(c=>id===c||id?.startsWith(c+'/arc/'))]
    ??scope.allowed_operations),eventOps=id=>new Set(scope.event_operations?.[id]??scope.allowed_operations);
  const mask=(a,b,keys)=>{for(const key of keys){delete a[key];delete b[key];}};
  const musicKeys=ops=>[...(ops.has('gain')?['gain_db']:[]),...(ops.has('envelope')?['gain_envelope']:[]),
    ...(ops.has('transition')?['fade_in_seconds','fade_out_seconds']:[]),'transition_reason'];
  const musicA=left.edits.music_edits,musicB=right.edits.music_edits;
  need(musicA.length===musicB.length,'scoped_repair_music_identity_changed');
  for(let i=0;i<musicA.length;i++)if(cueOwned(musicA[i].music_task_cue_id))
    mask(musicA[i],musicB[i],musicKeys(cueOps(musicA[i].music_task_cue_id)));
  need(left.plan.arcs.length===right.plan.arcs.length,'scoped_repair_arc_count_changed');
  for(let i=0;i<left.plan.arcs.length;i++){
    const a=left.plan.arcs[i],b=right.plan.arcs[i];
    if(!scope.cue_ids.includes(a.cue_id))continue;
    const ops=cueOps(a.cue_id);
    need(a.pieces.length===b.pieces.length,'scoped_repair_piece_identity_changed');
    for(let j=0;j<a.pieces.length;j++)mask(a.pieces[j],b.pieces[j],[
      ...(ops.has('reselect')||ops.has('source_window')?['source_window']:[]),
      ...(ops.has('transition')?['connection_from']:[])]);
  }
  need(left.edits.sounds.length===right.edits.sounds.length,'scoped_repair_event_count_changed');
  for(let i=0;i<left.edits.sounds.length;i++)if(scope.event_ids.includes(left.edits.sounds[i].event_id)){
    const ops=eventOps(left.edits.sounds[i].event_id);
    mask(left.edits.sounds[i],right.edits.sounds[i],[...(ops.has('sound_selection')?['decision','selected_segment_id','source_range']:[]),
      ...(ops.has('anchor')?['target_seconds','source_anchor_seconds','anchor_evidence']:[]),
      ...(ops.has('gain')?['gain_db']:[]),...(ops.has('envelope')?['gain_envelope']:[]),'reason']);
  }
  need(left.edits.action_responses.length===right.edits.action_responses.length,'scoped_repair_action_count_changed');
  for(let i=0;i<left.edits.action_responses.length;i++)if(scope.action_ids.includes(left.edits.action_responses[i].action_id))
    mask(left.edits.action_responses[i],right.edits.action_responses[i],['music_task_cue_id','music_task_cue_ids',
      'response_kind','actual_edit_operation','reason']);
  need(same(left,right),'scoped_repair_modified_unowned_or_forbidden_operand');
  return {changed:!same(before,after),scope,unaffected_operands_preserved:true};
}

export const compositeIssueSchema=objectSchema({issue_id:str,kind:{type:'string',enum:Object.keys(issueRepairs)},
  cue_ids:strings,event_ids:strings,target_range:range,evidence_ids:strings,reason:str});
export const compositeReviewSchema=objectSchema({issues:{type:'array',items:compositeIssueSchema},unresolved:strings});
export function bindCompositeIssues(value,{director,analysis,duration,evidenceIds}){
  validateSchema(value,compositeReviewSchema);const ids=new Set();
  return value.issues.map(issue=>{
    need(issue.issue_id&&!ids.has(issue.issue_id),'unique_issue_ids_required');ids.add(issue.issue_id);
    need(issue.target_range[0]>=0&&issue.target_range[1]>issue.target_range[0]&&issue.target_range[1]<=duration,
      'issue_outside_actual_mix');
    need(issue.evidence_ids.length&&issue.evidence_ids.every(id=>evidenceIds.includes(id)),'issue_actual_evidence_required');
    need(issue.cue_ids.every(id=>director.cues.some(c=>c.cue_id===id&&overlap(c.target_range,issue.target_range)))
      &&issue.event_ids.every(id=>analysis.sound_events.some(e=>e.id===id&&overlap([e.start_seconds,e.end_seconds],issue.target_range))),
      'issue_object_or_clock_mismatch');
    need(issue.cue_ids.length+issue.event_ids.length>0,'issue_scoped_objects_required');
    return {...issue,...issueRepairs[issue.kind]};
  });
}

async function localCommand(command,args,trialBudget,stage){
  need(typeof trialBudget?.inspectLocal==='function','shared_episode_budget_required');
  const budget=await trialBudget.inspectLocal({stage});
  need(Number.isFinite(budget.remaining_ms)&&budget.remaining_ms>0,'no_remaining_episode_time');
  const result=await execOwnedFile(command,args,{python:process.env.SDR_PYTHON,
    deadlineAtMs:budget.request_deadline_at_ms??budget.deadline_at_ms??null,
    timeout:Math.max(1,Math.floor(budget.remaining_ms)),maxBuffer:8*1024*1024});
  await trialBudget.inspectLocal({stage:stage+'_result_io'});return result;
}
export async function verifyCompositeModelResponse(response,source,{allowInjectedTestTransport=false}={}){
  const test=allowInjectedTestTransport&&response?.execution_kind==='injected_test_transport'
    &&response.actual_runtime_executed===false&&response.actual_model_inference===false;
  need(response?.raw_response&&response.actual_input_processed===true&&response.actual_runtime_executed===true
    &&response.completion_status==='complete'&&response.execution_kind==='codex_cli_inference'||test&&response.raw_response
      &&response.actual_input_processed===true&&response.completion_status==='complete','actual_cli_response_required');
  await verifyEvidenceBindings(response.raw_response);const raw=await readJson(response.raw_response.path);
  need(same(raw.value,response.value)&&raw.source_video_sha256===source.sha256
    &&raw.actual_input_processed===true&&raw.completion_status==='complete'
    &&(test?raw.execution_kind==='injected_test_transport'&&raw.actual_runtime_executed===false&&raw.actual_model_inference===false
      :raw.actual_runtime_executed===true&&raw.execution_kind==='codex_cli_inference')&&raw.actual_audio_processed===false
    &&raw.production_approval===false,'actual_cli_response_identity_mismatch');
  await verifyEvidenceBindings(raw.evidence_files??[]);return raw;
}
export async function verifyCompositeRequestEnvelope(raw,requestBinding,{allowInjectedTestTransport=false}={}){
  await verifyEvidenceBindings(requestBinding);const original=await readJson(requestBinding.path);
  let paired;
  for(const ref of raw.evidence_files??[]){
    if(path.basename(ref.path)!=='request.json')continue;
    const payload=await readJson(ref.path),input=payload.input??payload.payload?.input;
    if(input?.stage===original.stage&&same(input.data?.composite_request_binding,requestBinding))paired=input;
  }
  need(paired,'paired_submitted_request_required');
  need(Object.entries(original.data).every(([k,v])=>same(paired.data[k],v)),'submitted_request_data_changed');
  if(original.stage==='composite_research_review'){
    const pictures=paired.data.picture_submission;
    need(pictures?same(pictures.source_frames,original.frames)&&pictures.actual_video_processed===false
      &&pictures.audio_submitted_to_reasoner===false:allowInjectedTestTransport&&same(paired.frames,original.frames),
    'submitted_actual_picture_mapping_changed');
  }else need(!paired.frames?.length,'scoped_repair_unbound_new_pictures');
  return paired;
}
export async function verifyCompositeAudioEvidence(screen,{preview,source,windows}){
  need(same(screen.source,preview)&&same(screen.source_video,preview)
    &&screen.original_source_video_sha256===source.sha256&&screen.raw_report
    &&screen.windows?.length===windows.length,'actual_audio_input_identity_required');
  need(['qualified','sound_facts_qualified','artistic_approval','production_approval','audio_review_accepted',
    'actual_picture_processed'].every(k=>screen[k]===false),'audio_prediction_cannot_grant_approval');
  await verifyEvidenceBindings(screen);const raw=await readJson(screen.raw_report.path);
  need(raw.qualified===false&&raw.jobs?.length===windows.length,'actual_audio_report_required');
  for(let i=0;i<windows.length;i++){
    const w=screen.windows[i],job=raw.jobs[i],expected=windows[i];
    need(w.id===expected.id&&job.id===expected.id&&same(w.source_range,expected.source_range)
      &&same(job.source_range,expected.source_range)&&same(job.source_binding,preview)
      &&w.source_sha256===preview.sha256&&w.source_video_sha256===preview.sha256
      &&same(w.input_audio,job.input_audio)&&same(w.generation_termination,job.generation_termination)
      &&same(w.raw_observation,job.raw_observation),'actual_audio_window_identity_mismatch');
    need(w.actual_audio_processed===(job.execution?.actual_audio_processed===true),'actual_audio_forward_mismatch');
    if(w.actual_audio_processed)need(/^[a-f0-9]{64}$/.test(job.input_audio?.pcm_sha256??'')
      &&job.execution.processor_pcm_sha256===job.input_audio.pcm_sha256
      &&job.execution.actual_audio_tokens>0&&job.execution.encoder_forward_count>0,'actual_audio_pcm_forward_required');
  }
  return researchAudioCompletionGaps(screen);
}

// Decode the delivered AAC, never reconstruct original + accompaniment. All images
// below come from that same rendition and have an explicit sampling clock.
export async function prepareCompositeMedia({source,render_binding,render_files,output_dir},{trialBudget}){
  await verifyEvidenceBindings([source,render_binding,render_files]);const rendered=await readJson(render_binding.path);
  need(rendered.preview&&!rendered.diagnostic_sample,'full_delivered_preview_required');
  const preview=render_files.find(r=>path.resolve(r.path)===path.resolve(rendered.preview));
  need(preview&&rendered.inputs?.manifest&&rendered.inputs?.analysis&&rendered.inputs?.director&&rendered.inputs?.arc_plan
    &&rendered.inputs?.edits,'bound_render_story_inputs_required');
  await verifyEvidenceBindings(rendered.inputs);
  const manifest=await readJson(rendered.inputs.manifest.path),duration=manifest.timeline.duration_samples/48000;
  need(manifest.source_sha256===source.sha256&&manifest.timeline.sample_rate===48000&&duration>0,'exact_source_clock_required');
  const probe=JSON.parse((await localCommand('ffprobe',['-v','error','-show_streams','-of','json',preview.path],trialBudget,
    'composite_media_probe')).stdout),video=probe.streams.find(s=>s.codec_type==='video');
  need(video&&probe.streams.some(s=>s.codec_type==='audio')&&Number(video.duration)+0.1>=duration,'complete_audio_picture_required');
  const directory=path.join(output_dir,'media-'+digest({preview,inputs:rendered.inputs,revision:compositeResearchRevision,picture_sampling:'bounded31-v1'}));
  await mkdir(directory,{recursive:true});const receiptFile=path.join(directory,'media.json');
  if(await exists(receiptFile)){
    const previous=await readJson(receiptFile);await verifyEvidenceBindings(previous);
    need(same(previous.preview,preview)&&same(previous.render_binding,render_binding),'cached_media_identity_changed');return previous;
  }
  const mix=path.join(directory,'actual-delivered-mix.wav'),N=manifest.timeline.duration_samples;
  if(await exists(mix))throw Error('composite_research_partial_media_requires_reconciliation');
  await localCommand('ffmpeg',['-v','error','-nostdin','-n','-i',preview.path,'-map','0:a:0','-af',
    `aresample=48000,atrim=end_sample=${N},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','2','-c:a','pcm_f32le',mix],
    trialBudget,'composite_actual_mix_decode');
  const stream=JSON.parse((await localCommand('ffprobe',['-v','error','-show_streams','-of','json',mix],trialBudget,
    'composite_pcm_clock')).stdout).streams[0];
  need(Number(stream.duration_ts)===N&&stream.time_base==='1/48000','incomplete_delivered_audio');
  const frames=[];
  // Two-second ordered samples plus the final frame; all intervals/limits are
  // disclosed to the reasoning model. No continuous-video inference is claimed.
  const samplingStep=Math.max(2,Math.ceil(duration/30)),times=[];for(let t=0;t<duration;t+=samplingStep)times.push(t);
  const rate=String(video.avg_frame_rate??video.r_frame_rate??'0/1').split('/').map(Number),
    framePeriod=rate[0]>0&&rate[1]>0?rate[1]/rate[0]:0.1;
  const last=Math.max(0,duration-Math.max(0.08,framePeriod*2));if(last>times.at(-1)+0.01)times.push(last);
  for(const [i,t]of times.entries()){
    const file=path.join(directory,`frame-${String(i).padStart(4,'0')}.png`);
    await localCommand('ffmpeg',['-v','error','-nostdin','-n','-ss',String(t),'-i',preview.path,'-frames:v','1',
      '-vf','scale=480:480:force_original_aspect_ratio=decrease:reset_sar=1',file],trialBudget,'composite_picture_decode');
    frames.push({id:`picture-${i}`,timeline_seconds:t,source_video_sha256:preview.sha256,...await bind(file)});
  }
  const result={schema_version:1,source,preview,render_binding,inputs:rendered.inputs,duration_seconds:duration,
    duration_samples:N,mix:await bind(mix),frames,picture_sampling_step_seconds:samplingStep,
    actual_video_processed:false,actual_picture_decoded:true,continuous_picture_input:false,production_approval:false};
  await verifyEvidenceBindings([source,preview,render_binding,result.mix,frames]);
  await saveCompositeArtifact(receiptFile,result);return result;
}

export async function buildCompositeReviewInput({input,media,analysis,director,plan,screenBinding,observations,rendered,unresolved}){
  const duration=media.duration_seconds,evidenceIds=[...observations.map(w=>w.id),...media.frames.map(f=>f.id)];
  const requiredSoundGaps=await compositeRequiredSoundGaps(rendered,input);
  return {stage:'composite_research_review',call_plan_phase:input.prior_review_binding?'recheck':'review',
      prompt:'Assess the actual ordered delivered-picture samples, current plot and separate unqualified audio predictions. '
        +'You receive images and text, not PCM or native continuous video. Do not claim you heard audio. '
        +'Report concrete wrong music/emotion/lyric perspective, broken phrases/seams, missing or inaudible events, dialogue masking and overload. '
        +'Keep truncation, unsupported claims and unknowns unresolved. Cite supplied evidence IDs and actual cue/event IDs with target ranges. '
        +'A numerical risk or prediction alone cannot establish a sound fact or artistic approval. Empty issues means only no supported research issue. '
        +'Do not remove mandatory events, invent lyrics, or approve production.',
      data:{source_video_sha256:input.source.sha256,source:input.source,preview:media.preview,render_binding:input.render_binding,
        full_render_inputs:media.inputs,timeline: {duration_seconds:duration,sample_rate:48000},analysis,director,
        plan,edits:await readJson(media.inputs.edits.path),audio_screen:screenBinding,audio_predictions:observations,
        retained_render_unresolved:rendered.unresolved??[],required_sound_coverage_gaps:requiredSoundGaps,
        deterministic_unresolved:[...unresolved,...requiredSoundGaps],
        picture_sampling_step_seconds:media.picture_sampling_step_seconds,continuous_picture_input:false,prior_review:input.prior_review_binding??null,
        evidence_ids:evidenceIds},frames:media.frames,schema:compositeReviewSchema};
}

export function createCompositeReviewer(config,{researchAudioObserver,execution_kind}={}){
  const verification={allowInjectedTestTransport:execution_kind==='injected_test_transport'};
  const options=validateCompositeResearchConfig(config);
  need(options,'explicit_policy_required');const observer=researchAudioObserver??createLocalResearchAudioObserver(options.audio_observer);
  const review=async(input,{session,trialBudget})=>{
    need(typeof session?.director==='function','same_episode_session_required');
    const media=await prepareCompositeMedia(input,{trialBudget}),rendered=await readJson(input.render_binding.path),
      analysis=await readJson(media.inputs.analysis.path),director=await readJson(media.inputs.director.path),
      plan=await readJson(media.inputs.arc_plan.path),duration=media.duration_seconds;
    const extras=plan.arcs.flatMap(arc=>arc.pieces.map(p=>p.target_range[0])).filter(t=>t>0&&t<duration)
      .map((t,i)=>({id:`seam-${i}`,kind:'actual_seam',source_range:[Math.max(0,t-3),Math.min(duration,t+3)]}));
    const windows=buildResearchAudioWindows(duration,extras),identity=await review.getIdentity();
    const key=digest({source:input.source,render_binding:input.render_binding,preview:media.preview,identity});
    const directory=path.join(input.output_dir,'review-'+key);await mkdir(directory,{recursive:true});
    const artifactFile=path.join(directory,'review.json');
    if(await exists(artifactFile)){
      const artifact=await bind(artifactFile),value=await verifyCompositeReview(artifact,input,verification);return {...value,artifact};
    }
    // Always reobserve the complete new rendition. This includes any uniform
    // master change; no stale window reuse is inferred from unchanged edits.
    const screen=await observer({source:media.preview,source_video:media.preview,
      original_source_video_sha256:input.source.sha256,windows:windows.windows,duration_seconds:duration,
      directory:path.join(directory,'audio'),trialBudget});
    const unresolved=await verifyCompositeAudioEvidence(screen,{preview:media.preview,source:input.source,windows:windows.windows});
    unresolved.push(...windows.omitted_extras.map(w=>({reason:'supplemental_window_capacity_gap',window_id:w.id,target_range:w.source_range})));
    const screenBinding=await saveCompositeArtifact(path.join(directory,'audio-screen.json'),screen);
    const observations=screen.windows.map(w=>({id:w.id,source_range:w.source_range,actual_audio_processed:w.actual_audio_processed,
      raw_observation:w.raw_observation,generation_termination:w.generation_termination,
      evidence:{report:screen.raw_report,job_index:w.evidence.job_index},qualified:false}));
    for(const w of observations)if(/stereo|pann?ing|spatial|立体声|左右声道|声像/i.test(w.raw_observation??''))
      unresolved.push({reason:'unsupported_spatial_prediction_from_mono_input',window_id:w.id});
    const evidenceIds=[...observations.map(w=>w.id),...media.frames.map(f=>f.id)];
    const request=await buildCompositeReviewInput({input,media,analysis,director,plan,screenBinding,observations,rendered,unresolved});
    unresolved.push(...request.data.required_sound_coverage_gaps);
    const requestBinding=await saveCompositeArtifact(path.join(directory,'request.json'),request);
    const response=await session.director({...request,data:{...request.data,composite_request_binding:requestBinding}});
    const raw=await verifyCompositeModelResponse(response,input.source,verification);
    await verifyCompositeRequestEnvelope(raw,requestBinding,verification);
    const issues=bindCompositeIssues(response.value,{director,analysis,duration,evidenceIds});
    const retainedLimitations=(rendered.unresolved??[]).filter(reason=>reason==='independent_candidates_await_actual_audition');
    unresolved.push(...response.value.unresolved.map(reason=>({reason})),...(rendered.unresolved??[])
      .filter(reason=>!retainedLimitations.includes(reason)).map(reason=>({reason})));
    const result={schema_version:1,kind:'composite_research_review',revision:compositeResearchRevision,source:input.source,
      render_binding:input.render_binding,preview:media.preview,media:await bind(path.join(path.dirname(media.mix.path),'media.json')),
      request:requestBinding,raw_response:response.raw_response,audio_screen:screenBinding,identity,
      prior_review:input.prior_review_binding??null,issues,unresolved,retained_limitations:retainedLimitations,
      execution_kind:response.execution_kind,actual_model_inference:response.execution_kind==='codex_cli_inference',
      status:issues.length?'composite_review_needs_repair':unresolved.length?'composite_review_unresolved':'composite_research_passed',
      actual_research_audio_processed:screen.actual_observation_count>0,actual_picture_samples_submitted:true,
      actual_audio_listened:false,actual_video_processed:false,quality_status:'not_assessed',
      qualified:false,formal_adoption_allowed:false,artistic_approval:false,production_approval:false};
    const artifact=await saveCompositeArtifact(artifactFile,result);return {...result,artifact};
  };
  Object.defineProperty(review,'getIdentity',{value:async()=>({revision:compositeResearchRevision,
    audio_observer:await observer.getIdentity(),implementation:await bind(fileURLToPath(import.meta.url))})});
  return review;
}

export async function verifyCompositeReview(artifact,input,verification={}){
  await verifyEvidenceBindings([artifact,input.source,input.render_binding]);const review=await readJson(artifact.path);
  need(review.kind==='composite_research_review'&&same(review.source,input.source)&&same(review.render_binding,input.render_binding)
    &&same(review.prior_review,input.prior_review_binding??null)
    &&review.quality_status==='not_assessed'&&review.actual_audio_listened===false
    &&['qualified','formal_adoption_allowed','artistic_approval','production_approval','actual_video_processed']
      .every(k=>review[k]===false),
    'review_identity_or_approval_mismatch');
  await verifyEvidenceBindings(review);const media=await readJson(review.media.path),request=await readJson(review.request.path),
    raw=await readJson(review.raw_response.path),screen=await readJson(review.audio_screen.path);
  need(same(media.preview,review.preview)&&same(media.render_binding,input.render_binding),'review_media_identity_changed');
  await verifyCompositeModelResponse({...raw,raw_response:review.raw_response},input.source,verification);
  await verifyCompositeRequestEnvelope(raw,review.request,verification);
  need(same(request.frames,media.frames)&&same(request.data.preview,media.preview)
    &&same(request.data.full_render_inputs,media.inputs)&&same(request.data.audio_screen,review.audio_screen)
    &&same(request.data.prior_review,review.prior_review),'review_request_media_or_history_changed');
  const rendered=await readJson(input.render_binding.path);
  need(same(media.inputs,rendered.inputs),'review_render_inputs_changed');
  for(const key of ['analysis','director','arc_plan','edits'])need(same(request.data[key==='arc_plan'?'plan':key],
    await readJson(media.inputs[key].path)),'review_story_or_decision_changed');
  const duration=media.duration_seconds,extras=request.data.plan.arcs.flatMap(a=>a.pieces.map(p=>p.target_range[0]))
    .filter(t=>t>0&&t<duration).map((t,i)=>({id:`seam-${i}`,kind:'actual_seam',
      source_range:[Math.max(0,t-3),Math.min(duration,t+3)]})),expectedWindows=buildResearchAudioWindows(duration,extras);
  const audioGaps=await verifyCompositeAudioEvidence(screen,{preview:media.preview,source:input.source,
    windows:expectedWindows.windows});
  const issues=bindCompositeIssues(raw.value,{director:request.data.director,analysis:request.data.analysis,
    duration:media.duration_seconds,evidenceIds:request.data.evidence_ids});
  const requiredSoundGaps=await compositeRequiredSoundGaps(rendered,input);
  const deterministic=[...audioGaps,...expectedWindows.omitted_extras.map(w=>({reason:'supplemental_window_capacity_gap',
    window_id:w.id,target_range:w.source_range})),...screen.windows.filter(w=>/stereo|pann?ing|spatial|立体声|左右声道|声像/i.test(w.raw_observation??''))
    .map(w=>({reason:'unsupported_spatial_prediction_from_mono_input',window_id:w.id})),...requiredSoundGaps];
  const limitations=(rendered.unresolved??[]).filter(reason=>reason==='independent_candidates_await_actual_audition');
  const unresolved=[...deterministic,...raw.value.unresolved.map(reason=>({reason})),...(rendered.unresolved??[])
    .filter(reason=>!limitations.includes(reason)).map(reason=>({reason}))];
  need(same(issues,review.issues)&&same(deterministic,request.data.deterministic_unresolved)
    &&same(requiredSoundGaps,request.data.required_sound_coverage_gaps)
    &&same(unresolved,review.unresolved)&&same(limitations,review.retained_limitations),'review_issues_or_unknowns_changed');
  const expected=issues.length?'composite_review_needs_repair':review.unresolved.length?'composite_review_unresolved':'composite_research_passed';
  need(review.status===expected,'review_status_changed');return review;
}
