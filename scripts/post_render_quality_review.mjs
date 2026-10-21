import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,stat} from 'node:fs/promises';
import {ApiSession,audioBackendMatches,audioSchema,readJson,saveJson,validateSchema,
  resolveAudioBackend,validateAudioQualification,verifyEvidenceBindings,verifyLocalAudioExecution,
  providerReadiness} from './audio_api.mjs';
import {HostFileSession} from './host_runtime.mjs';
import {hashFile} from './render_binding.mjs';
import {prepareReviewWindow} from './prepare_review_window.mjs';
import {auditMusicActionExecution,verifyMusicActionRenderExecution} from './music_action_execution_audit.mjs';

const execute=promisify(execFile), same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bound=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const scopes=['audio_observation','music_candidate_judgment'];
const overlap=(a,b)=>a[0]<b[1]&&b[0]<a[1];
const policy=config=>config.quality_review_policy??'diagnostic_only';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists=async file=>{try{await stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const mixResolvable=new Set(['actual_paired_seam_observation_required',
  'short_research_seams_have_unverified_vocal_overlap_pending_actual_audition',
  'research_preview_original_sound_facts_and_scene_fit_pending',
  'assisted_preview_original_sound_facts_and_scene_fit_pending']);

// Read-only. A callback, an ASR receipt or a model name does not establish a listener.
// No API session, credentials, request allowance or qualification is created here.
export async function preflightPostRenderQuality(config={},runtime={}) {
  const missing=[];
  let backend=null;
  try {if(config.quality_review_audio_backend)backend=resolveAudioBackend(config.quality_review_audio_backend);}
  catch {missing.push('valid_audio_review_backend_identity');}
  if(!backend)missing.push('explicit_audio_review_backend');
  const qualification=backend?await validateAudioQualification(config.quality_review_qualification,backend,scopes)
    :{ready:false,missing:['qualified_audio_listener']};
  if(!qualification.ready)missing.push(...qualification.missing);
  if(qualification.ready){
    const version=(await readJson(qualification.binding.path)).schema_version;
    if(!Number.isSafeInteger(version)||version<2)missing.push('actual_schema2_audio_and_scene_calibration_required');
  }
  const session=runtime.audioReviewSession;
  if(!(session instanceof ApiSession||session instanceof HostFileSession))missing.push('actual_audio_review_session');
  else {
    if(!backend||!audioBackendMatches(session.audioBackend,backend))missing.push('bound_audio_review_session_backend');
    if(session instanceof ApiSession)missing.push(...providerReadiness(session.budget,session.environment,['gemini']).missing);
    else if(typeof session.observer!=='function'||!Array.isArray(session.observerLedger))
      missing.push('actual_audio_observer_and_usage_ledger');
  }
  // Current ApiSession/HostFileSession do not yet expose this preparation contract.
  // Never expand the episode allowance or infer audio token cost from a text-only request.
  if(!runtime.trialBudget||!['inspectLocal','reserve','complete'].every(key=>typeof runtime.trialBudget[key]==='function'))
    missing.push('existing_shared_episode_budget_required');
  if(typeof session?.prepareAudioReviewRequest!=='function'
    ||session.audioReviewEvidenceContract!=='exact_audio_picture_submission_v1')
    missing.push('bound_audio_picture_submission_preparer_unsupported');
  return {schema_version:1,kind:'post_render_quality_readiness',policy:policy(config),
    ready:missing.length===0,status:missing.length?'audio_review_backend_unavailable':'audio_review_backend_ready',
    quality_status:'not_accepted',actual_audio_listened:false,production_approval:false,
    backend,qualification:qualification.binding??null,missing:[...new Set(missing)],
    new_requests:0,new_budget_created:false,manual_episode_audition_required:false,
    next_action:missing.length?'resolve_audio_review_executor_dependencies':'review_actual_rendered_mix',
    repair_dependencies:missing.map(reason=>({required_stage:'audio_review_capability',reason,executed:false}))};
}

export function qualityReviewWindows(duration,seams=[]) {
  if(!Number.isFinite(duration)||duration<=0||!Array.isArray(seams)
    ||seams.some(t=>!Number.isFinite(t)||t<=0||t>=duration))throw Error('quality_review_timeline_invalid');
  const ranges=[];
  for(let start=0;start<duration;start+=23)ranges.push([start,Math.min(start+25,duration)]);
  for(const t of seams)if(!ranges.some(r=>r[0]<t&&r[1]>t))ranges.push([Math.max(0,t-3),Math.min(duration,t+3)]);
  return ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
}

export function reviewRepairDependencies(issues) {
  return issues.map(issue=>({required_stage:/narrative|semantic|lyric|wrong_music|style|emotion/i.test(issue.kind??'')
    ?'material_reselection':/story|perspective|evidence/i.test(issue.kind??'')?'direction_evidence_repair'
      :/action_execution/.test(issue.kind??'')?'music_action_execution_repair'
        :/mask|gain|overload|peak|transition|seam|sync/i.test(issue.kind??'')?'targeted_edit_revision':'scoped_quality_issue_triage',
    target_range:[issue.start_seconds,issue.end_seconds],cue_ids:issue.cue_ids??[],event_ids:issue.event_ids??[],
    reason:issue.reason??issue.kind,issue_kind:issue.kind,executed:false,
    automatic_repair_consumer_available:false,
    next_action:'bind_actual_scoped_repair_to_existing_budget_then_rerender_and_recheck'}));
}

// This verifier checks the observation itself, not only the adapter's return flags.
export async function verifyRenderedAudioObservation(result,{backend,job,video}) {
  if(!result?.file?.sha256)throw Error('quality_review_bound_observation_required');
  await verifyEvidenceBindings([result.file,{path:job.path,sha256:job.source_sha256},video]);
  const stored=await readJson(result.file.path);
  const {file,...returned}=result;
  if(!same(stored,returned))throw Error('quality_review_observation_file_mismatch');
  if(!audioBackendMatches(stored,backend)||stored.actual_audio_processed!==true||stored.completion_status!=='complete'
    ||stored.finish_reason!=='complete'||stored.purpose!=='mix'||!stored.request_id
    ||stored.source_sha256!==job.source_sha256||stored.source_video_sha256!==job.source_video_sha256
    ||!same(stored.source_range,job.source_range)||!same(stored.synchronized_video,video))
    throw Error('quality_review_actual_mix_binding_required');
  validateSchema(stored.observation,audioSchema,'quality_audio_observation');
  await verifyEvidenceBindings(stored);
  if(backend.protocol==='local_audio_model'){
    const receipt=await verifyLocalAudioExecution(stored,backend);
    if(receipt.execution?.actual_video_processed!==true||receipt.input_video?.sha256!==video.sha256
      ||receipt.execution.input_video_sha256!==video.sha256)throw Error('quality_review_actual_picture_forward_required');
  }
  else {
    if(!stored.api_evidence?.sha256||!stored.input_audio?.sha256)throw Error('quality_review_actual_submission_required');
    const audit=await readJson(stored.api_evidence.path),raw=await readJson(audit.raw_response.path);
    if(!audioBackendMatches(audit,backend)||audit.audio_sha256!==stored.input_audio.sha256
      ||audit.submitted_pcm_sha256!==stored.pcm_sha256||audit.source_sha256!==job.source_sha256
      ||!same(audit.source_window,job.source_range)||audit.request_id!==stored.request_id
      ||audit.model!==backend.model_revision||raw.id!==stored.request_id||raw.status!=='completed'
      ||raw.model!==backend.model_revision||audit.finish_reason!=='complete'
      ||(raw.steps??[]).some(row=>row.status&&row.status!=='completed'))throw Error('quality_review_actual_submission_mismatch');
    const outputs=raw.steps?.filter(row=>row.type==='model_output').flatMap(row=>row.content??[])??raw.outputs;
    if(!Array.isArray(outputs)||outputs.some(row=>row.type==='refusal'))throw Error('quality_review_actual_response_required');
    const text=outputs.filter(row=>['text','output_text'].includes(row.type)).map(row=>row.text).join('');
    if(!text.trim()||!same(JSON.parse(text),stored.observation))throw Error('quality_review_actual_response_mismatch');
    // A synchronized_video label added after inference is insufficient. Verify exact submitted bytes.
    if(!stored.request_payload?.sha256||!stored.submission_receipt?.sha256)
      throw Error('quality_review_actual_picture_submission_required');
    const payload=await readJson(stored.request_payload.path),submission=await readJson(stored.submission_receipt.path);
    if(submission.request_body_sha256!==digest(payload)||submission.model!==backend.model_revision
      ||payload.model!==backend.model_revision||!Array.isArray(payload.input))throw Error('quality_review_submission_payload_mismatch');
    const mediaHash=kind=>payload.input.filter(row=>row.type===kind).map(row=>
      typeof row.data==='string'?createHash('sha256').update(Buffer.from(row.data,'base64')).digest('hex'):null);
    if(!mediaHash('video').includes(video.sha256)||!mediaHash('audio').includes(stored.input_audio.sha256))
      throw Error('quality_review_submitted_audio_picture_mismatch');
  }
  const duration=job.source_range[1]-job.source_range[0];
  if([...stored.observation.issues,...stored.observation.words].some(row=>row.start_seconds<0
    ||row.end_seconds<=row.start_seconds||row.end_seconds>duration+1/16000)
    ||stored.observation.changes.some(row=>row.time_seconds<0||row.time_seconds>duration))
    throw Error('quality_review_observation_range_invalid');
  return stored;
}

export async function reviewRenderedEpisode(input,runtime={}) {
  const {source,render_binding,config={}}=input;
  await verifyEvidenceBindings([source,render_binding]);
  const readiness=await preflightPostRenderQuality(config,runtime);
  const record={schema_version:1,kind:'post_render_quality_review',source,render_binding,
    status:'quality_review_unresolved',quality_status:'not_accepted',actual_audio_listened:false,
    production_approval:false,manual_episode_audition_required:false,readiness,
    observations:[],issues:[],unresolved:[],repair_dependencies:[],repair_attempts:0,
    limitations:['Engineering integration is not listening qualification.',
      'A passing rendition review does not approve a recording, all source windows, or formal production.',
      'The legacy targeted edit/reselection path is not a safe general consumer for independent arc assemblies; no repair is claimed.']};
  const finish=async values=>{
    Object.assign(record,values);
    const artifact=await saveJson(path.join(input.output_dir,'quality-review-record.json'),record);
    return {...record,artifact};
  };
  if(!readiness.ready)return finish({status:'audio_review_backend_unavailable',unresolved:readiness.missing,
    repair_dependencies:readiness.repair_dependencies,next_action:readiness.next_action});
  const rendered=await readJson(render_binding.path);
  await verifyEvidenceBindings(rendered.inputs);
  if(!rendered.preview||!rendered.inputs?.manifest||!rendered.inputs?.analysis||!rendered.inputs?.director
    ||!rendered.inputs?.arc_plan||!rendered.inputs?.edits)return finish({unresolved:['bound_full_render_and_story_context_required'],
      repair_dependencies:[{required_stage:'review_media_preparation',executed:false}],next_action:'prepare_bound_full_mix_and_picture'});
  const manifest=await readJson(rendered.inputs.manifest.path),analysis=await readJson(rendered.inputs.analysis.path),
    director=await readJson(rendered.inputs.director.path),plan=await readJson(rendered.inputs.arc_plan.path),
    edits=await readJson(rendered.inputs.edits.path);
  if(manifest.source_sha256!==source.sha256||plan.source_video_sha256!==source.sha256)
    throw Error('quality_review_wrong_source');
  const preview=input.render_files?.find(row=>path.resolve(row.path)===path.resolve(rendered.preview)),
    N=manifest.timeline?.duration_samples,duration=N/48000;
  if(!preview?.sha256)throw Error('quality_review_registered_preview_binding_required');
  await verifyEvidenceBindings(preview);
  if(!Number.isSafeInteger(N)||N<=0||manifest.timeline.sample_rate!==48000)throw Error('quality_review_exact_timeline_required');
  record.preview=preview;record.inputs=rendered.inputs;record.duration_samples=N;
  record.retained_render_unresolved=rendered.unresolved??[];
  record.render_unknown_dispositions=record.retained_render_unresolved.map(reason=>({reason,
    disposition:mixResolvable.has(reason)?'requires_all_current_mix_windows_pass':'still_requires_original_scope_evidence'}));
  record.unresolved.push(...record.render_unknown_dispositions.filter(row=>row.disposition==='still_requires_original_scope_evidence'));
  let compiled;
  if(edits.schema_version===2&&rendered.music_action_compilation){
    await verifyEvidenceBindings(rendered.music_action_compilation);
    const compilation=await readJson(rendered.music_action_compilation.path);
    await verifyEvidenceBindings([compilation.plan,...Object.values(compilation.inputs)]);
    if(compilation.source_video_sha256!==source.sha256
      ||!same(compilation.inputs.arc_plan,rendered.inputs.arc_plan)||!same(compilation.inputs.edits,rendered.inputs.edits)
      ||!same(compilation.inputs.director,rendered.inputs.director))throw Error('quality_review_action_compilation_mismatch');
    compiled={...compilation,plan:await readJson(compilation.plan.path)};
  }
  record.action_execution=auditMusicActionExecution({director,plan,edits,compiled});
  if(compiled&&rendered.music_action_render_execution_audit){
    await verifyEvidenceBindings(rendered.music_action_render_execution_audit);
    const executed=await readJson(rendered.music_action_render_execution_audit.path);
    await verifyEvidenceBindings(executed.inputs);
    if(!same(executed.inputs.compilation,rendered.music_action_compilation))throw Error('quality_review_action_render_mismatch');
    record.action_execution=verifyMusicActionRenderExecution(record.action_execution,compiled,
      await readJson(executed.inputs.render_report.path));
  }
  const technical=rendered.render?.mix_issues??[];
  record.issues.push(...technical.filter(reason=>!['original_audio_kind_requires_review','dialogue_intervals_not_provided'].includes(reason))
    .map(reason=>({kind:'technical_mix',reason,start_seconds:0,end_seconds:duration,cue_ids:[],event_ids:[]})));
  record.issues.push(...record.action_execution.actions.filter(row=>row.status==='unresolved')
    .map(row=>({kind:'action_execution',reason:row.reason,action_id:row.action_id,start_seconds:row.target_range[0],
      end_seconds:row.target_range[1],cue_ids:director.cues.filter(cue=>cue.required_action_ids?.includes(row.action_id)).map(cue=>cue.cue_id),event_ids:[]})));
  for(const scope of [rendered.research_preview?.preserved_coverage,rendered.assisted_preview?.preserved_coverage]){
    if(!scope)continue;
    const binding=scope.binding??scope;
    if(!binding?.path||!binding.sha256)throw Error('quality_review_bound_coverage_required');
    await verifyEvidenceBindings(binding);
    const coverage=await readJson(binding.path);
    record.issues.push(...(coverage.issues??[]).map(row=>({kind:'sound_coverage',reason:row.problem??JSON.stringify(row),
      start_seconds:row.target_range?.[0]??0,end_seconds:row.target_range?.[1]??duration,
      event_ids:row.id?[row.id]:[],cue_ids:[],evidence:binding})));
  }
  // Review the actual delivered preview mix, including its real mastering gain.
  // Reconstructing original + accompaniment could otherwise review a different rendition.
  await runtime.trialBudget.inspectLocal({stage:'quality_review_media_preparation'});
  const cacheRoot=input.cache_dir??path.join(input.output_dir,'cache');
  const cache=path.join(cacheRoot,digest({source,render_binding,preview,qualification:readiness.qualification,
    backend:readiness.backend,inputs:rendered.inputs}));
  await mkdir(cache,{recursive:true});
  const probe=JSON.parse((await execute('ffprobe',['-v','error','-show_streams','-of','json',preview.path],
    {windowsHide:true,maxBuffer:4*1024*1024})).stdout);
  const stream=probe.streams.find(row=>row.codec_type==='video');
  if(!stream||!probe.streams.some(row=>row.codec_type==='audio'))throw Error('quality_review_synchronized_media_required');
  const fps=String(stream.avg_frame_rate??'0/1').split('/').map(Number),frameSeconds=fps[1]/fps[0];
  if(!Number.isFinite(Number(stream.duration))||!Number.isFinite(frameSeconds)||frameSeconds<=0
    ||Number(stream.duration)+frameSeconds+1/48000<duration)throw Error('quality_review_incomplete_picture');
  const mix=path.join(cache,'review-mix.wav');
  const mixIdentityFile=path.join(cache,'review-mix-identity.json');
  if(await exists(mix)){
    if(!await exists(mixIdentityFile))throw Error('quality_review_partial_mix_requires_reconciliation');
    const identity=await readJson(mixIdentityFile);await verifyEvidenceBindings(identity);
    if(!same(identity.preview,preview)||identity.duration_samples!==N)throw Error('quality_review_mix_identity_changed');
  }else {
    await execute('ffmpeg',['-v','error','-nostdin','-n','-i',preview.path,'-map','0:a:0','-af',
    `aresample=48000,atrim=end_sample=${N},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','2','-c:a','pcm_f32le',mix],
    {windowsHide:true,maxBuffer:4*1024*1024});
    await saveJson(mixIdentityFile,{preview,mix:await bound(mix),duration_samples:N});
  }
  const mixBinding=await bound(mix),mixProbe=JSON.parse((await execute('ffprobe',['-v','error','-show_streams','-of','json',mix],
    {windowsHide:true,maxBuffer:4*1024*1024})).stdout).streams[0];
  if(Number(mixProbe.duration_ts)!==N||mixProbe.time_base!=='1/48000')throw Error('quality_review_incomplete_rendered_audio');
  const seams=plan.arcs.flatMap(arc=>arc.pieces.map(piece=>piece.target_range[0])).filter(t=>t>0&&t<duration);
  record.mix=mixBinding;record.mix_identity=await bound(mixIdentityFile);
  record.windows=qualityReviewWindows(duration,[...new Set(seams)]);
  for(let index=0;index<record.windows.length;index++){
    const source_range=record.windows[index],out=path.join(cache,`window-${index}`),verifiedFile=path.join(out,'verified-review-window.json');
    await runtime.trialBudget.inspectLocal({stage:'quality_review'});
    if(await exists(verifiedFile)){
      const saved=await readJson(verifiedFile);await verifyEvidenceBindings(saved);
      if(!same(saved.render_binding,render_binding)||!same(saved.qualification,readiness.qualification)
        ||!same(saved.job.source_range,source_range)||saved.job.source_sha256!==mixBinding.sha256)
        throw Error('quality_review_cached_window_mismatch');
      const old=await readJson(saved.observation.path);
      const observed=await verifyRenderedAudioObservation({...old,file:saved.observation},
        {backend:readiness.backend,job:saved.job,video:saved.video});
      record.observations.push(saved.observation);record.actual_audio_listened=true;
      record.issues.push(...observed.observation.issues.map(row=>({...row,start_seconds:row.start_seconds+source_range[0],
        end_seconds:row.end_seconds+source_range[0]})));
      record.unresolved.push(...observed.observation.uncertainties.map(reason=>({reason,source_range,observation:saved.observation})));
      continue;
    }
    if(await exists(path.join(out,'submission-pending.json')))return finish({status:'quality_review_unresolved',
      unresolved:[...record.unresolved,'unreconciled_audio_review_submission'],
      repair_dependencies:[{required_stage:'reconcile_exact_audio_review_submission',directory:out,executed:false}],
      next_action:'reconcile_saved_review_request_without_resubmitting'});
    const video=await prepareReviewWindow({video:preview.path,video_sha256:preview.sha256,audio:mix,
      audio_sha256:mixBinding.sha256,first_pts_seconds:Number(stream.start_time??0),source_range},path.join(out,'review.mp4'));
    const job={path:mix,source_sha256:mixBinding.sha256,source_video_sha256:source.sha256,source_range,
      segment_id:`rendered-mix/${index}`,asset_id:'actual_rendered_review_mix'};
    const options={purpose:'mix',video,frames:[],context:{source_video_sha256:source.sha256,
      rendered_preview:preview,global_direction:director.global_route_summary??null,
      story_beats:analysis.story_beats.filter(row=>overlap(source_range,[row.start_seconds,row.end_seconds])),
      cues:director.cues.filter(row=>overlap(source_range,row.target_range)),
      unresolved:analysis.uncertainties??[],direction_uncertainties:director.uncertainties??[],
      instruction:'Return actual audio/picture issues and unknowns. Check emotional development, dialogue, lyrical meaning and seams; absence of digital clipping is not dramatic suitability.'}};
    const prepared=await runtime.audioReviewSession.prepareAudioReviewRequest(job,path.join(out,'observation'),options);
    await verifyEvidenceBindings(prepared.request_payload);
    const requestSha=digest(await readJson(prepared.request_payload.path));
    const lease=await runtime.trialBudget.reserve({stage:'quality_review',attempt:1,request_sha256:requestSha,
      budget:prepared.input_budget,timeoutMs:prepared.timeout_ms});
    await saveJson(path.join(out,'submission-pending.json'),{job,video,render_binding,qualification:readiness.qualification,
      request_payload:prepared.request_payload,lease_id:lease.id,request_sha256:requestSha});
    let result;
    try {
      result=await runtime.audioReviewSession.observeAudio(job,path.join(out,'observation'),{...options,timeoutMs:lease.timeoutMs});
    }catch(error){await runtime.trialBudget.complete(lease,{runnerThrew:true});throw error;}
    // A fulfilled observeAudio call has ended. Preserve unknown outcomes above; do not
    // leave this completed invocation looking like an active child during recovery grants.
    await runtime.trialBudget.complete(lease,{terminated:true});
    if(!result.request_payload?.sha256||!same(result.request_payload,prepared.request_payload))
      throw Error('quality_review_submitted_prepared_request_mismatch');
    const observed=await verifyRenderedAudioObservation(result,{backend:readiness.backend,job,video});
    record.observations.push(result.file);record.actual_audio_listened=true;
    record.issues.push(...observed.observation.issues.map(row=>({...row,start_seconds:row.start_seconds+source_range[0],
      end_seconds:row.end_seconds+source_range[0],cue_ids:director.cues.filter(cue=>overlap(cue.target_range,
        [row.start_seconds+source_range[0],row.end_seconds+source_range[0]])).map(cue=>cue.cue_id),
      event_ids:analysis.sound_events.filter(event=>overlap([event.start_seconds,event.end_seconds],
        [row.start_seconds+source_range[0],row.end_seconds+source_range[0]])).map(event=>event.id)})));
    record.unresolved.push(...observed.observation.uncertainties.map(reason=>({reason,source_range,observation:result.file})));
    // Preserve completed windows even if the next request stops at the existing budget.
    await saveJson(path.join(out,'verified-review-window.json'),{job,video,observation:result.file,render_binding,
      qualification:readiness.qualification,actual_audio_processed:true,production_approval:false,
      budget_request:{request_sha256:requestSha,lease_id:lease.id,original_allowance_preserved:true}});
  }
  await verifyEvidenceBindings([source,render_binding,preview,readiness.qualification]);
  if(!(await validateAudioQualification(readiness.qualification,readiness.backend,scopes)).ready)
    throw Error('quality_review_qualification_changed');
  record.repair_dependencies=reviewRepairDependencies(record.issues);
  const status=record.issues.length?'quality_review_needs_repair':record.unresolved.length?'quality_review_unresolved':'quality_review_accepted';
  return finish({status,quality_status:status==='quality_review_accepted'?'accepted':'not_accepted',
    next_action:status==='quality_review_accepted'?'retain_bound_rendition_review':record.issues.length
      ?'execute_scoped_repair_dependency':'resolve_recorded_audio_review_unknowns'});
}

// Fresh and resumed acceptance use the same evidence verifier. Flags in a stage result are not evidence.
export async function verifyPostRenderQualityReview(binding,{source,render_binding,render_files,readiness}) {
  await verifyEvidenceBindings([binding,source,render_binding]);
  const review=await readJson(binding.path);
  if(!same(review.source,source)||!same(review.render_binding,render_binding))throw Error('quality_review_receipt_identity_mismatch');
  if(review.status!=='quality_review_accepted')return {accepted:false,actual_audio_listened:review.actual_audio_listened===true};
  if(review.quality_status!=='accepted'||review.actual_audio_listened!==true||review.production_approval!==false
    ||review.issues?.length!==0||review.unresolved?.length!==0||!review.observations?.length
    ||!review.readiness?.qualification?.sha256)throw Error('quality_review_acceptance_evidence_missing');
  const qualified=await validateAudioQualification(review.readiness.qualification,review.readiness.backend,scopes);
  const qualificationVersion=qualified.ready?(await readJson(qualified.binding.path)).schema_version:null;
  if(!qualified.ready||!Number.isSafeInteger(qualificationVersion)||qualificationVersion<2)
    throw Error('quality_review_acceptance_qualification_invalid');
  if(!readiness?.ready||!same(readiness.backend,review.readiness.backend)||!same(readiness.qualification,qualified.binding))
    throw Error('quality_review_current_backend_qualification_mismatch');
  await verifyEvidenceBindings(review);
  const rendered=await readJson(render_binding.path);
  if(!same(review.inputs,rendered.inputs))throw Error('quality_review_render_inputs_changed');
  if((rendered.unresolved??[]).some(reason=>!mixResolvable.has(reason)))
    throw Error('quality_review_retained_scope_evidence_unresolved');
  if((rendered.render?.mix_issues??[]).some(reason=>!['original_audio_kind_requires_review','dialogue_intervals_not_provided'].includes(reason)))
    throw Error('quality_review_technical_issue_unresolved');
  for(const scope of [rendered.research_preview?.preserved_coverage,rendered.assisted_preview?.preserved_coverage]){
    if(!scope)continue;
    const ref=scope.binding??scope;
    if(!ref?.path||!ref.sha256)throw Error('quality_review_bound_coverage_required');
    await verifyEvidenceBindings(ref);
    if((await readJson(ref.path)).issues?.length)throw Error('quality_review_required_sound_coverage_unresolved');
  }
  if(!render_files.some(row=>same(row,review.preview)))throw Error('quality_review_registered_preview_changed');
  const manifest=await readJson(review.inputs.manifest.path),director=await readJson(review.inputs.director.path),
    plan=await readJson(review.inputs.arc_plan.path),edits=await readJson(review.inputs.edits.path);
  if(manifest.source_sha256!==source.sha256||plan.source_video_sha256!==source.sha256)
    throw Error('quality_review_wrong_source');
  const actions=auditMusicActionExecution({director,plan,edits});
  if(actions.status!=='execution_evidence_complete'||!same(actions,review.action_execution))
    throw Error('quality_review_action_execution_unresolved');
  const duration=manifest.timeline.duration_samples/48000;
  const seams=[...new Set(plan.arcs.flatMap(arc=>arc.pieces.map(piece=>piece.target_range[0])).filter(t=>t>0&&t<duration))];
  const windows=qualityReviewWindows(duration,seams);
  if(!same(review.windows,windows)||review.observations.length!==windows.length)
    throw Error('quality_review_complete_window_coverage_required');
  for(let i=0;i<windows.length;i++){
    const file=review.observations[i],stored=await readJson(file.path),video=stored.synchronized_video;
    if(video?.source_video_sha256!==review.preview.sha256||video.source_audio_sha256!==review.mix.sha256
      ||!same(video.source_range,windows[i]))throw Error('quality_review_actual_render_picture_mismatch');
    const observation=await verifyRenderedAudioObservation({...stored,file},{backend:review.readiness.backend,video,
      job:{path:review.mix.path,source_sha256:review.mix.sha256,source_video_sha256:source.sha256,source_range:windows[i]}});
    if(observation.observation.issues.length||observation.observation.uncertainties.length)
      throw Error('quality_review_unresolved_observation_cannot_pass');
  }
  return {accepted:true,actual_audio_listened:true};
}
