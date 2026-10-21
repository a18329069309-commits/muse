import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import * as quality from '../scripts/post_render_quality_review.mjs';
import {composeAutomaticEpisode} from '../scripts/automatic_episode_controller.mjs';
import {ApiSession,DEFAULT_AUDIO_BACKEND,saveJson,readJson} from '../scripts/audio_api.mjs';
import {createIndependentTrialBudget} from '../scripts/independent_trial_budget.mjs';
import {hashFile} from '../scripts/render_binding.mjs';
import {createHash} from 'node:crypto';
import {createCodexEpisodeRuntime} from '../scripts/compose_codex_episode.mjs';
import {execFileSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../.muse/quality-review-tests');
const fixtureRoots=new Set();
async function fixture(){await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'fixture-'));fixtureRoots.add(directory);return directory;}
test.after(async()=>{for(const directory of fixtureRoots){
  const resolved=path.resolve(directory);
  assert.equal(path.dirname(resolved),root);assert.ok(path.basename(resolved).startsWith('fixture-'));
  await rm(resolved,{recursive:true,force:true});
}});
async function qualifiedFixture(directory,backend=DEFAULT_AUDIO_BACKEND){
  // Synthetic data exercises binding validation; it is not an applicant's qualification or listening result.
  const evidence=await saveJson(path.join(directory,'synthetic-calibration.json'),{engineering_fixture_only:true});
  return saveJson(path.join(directory,'synthetic-qualification.json'),{schema_version:2,status:'qualified',...backend,
    engineering_fixture_only:true,scopes:['audio_observation','music_candidate_judgment'],evidence,fixture_manifest:evidence,
    results:[{...backend,actual_audio_processed:true,audit_binding_verified:true,completion_status:'complete',api_evidence:evidence}],
    truth_coverage:{real_audio_sufficient:true,scene_truth_sufficient:true},
    fixture_results:Array.from({length:16},()=>({truth_group:'real_audio',status:'scored',reasons:[]})),
    scene_pair_results:['engineering-a','engineering-b','engineering-c'].map(scene_kind=>({scene_kind,status:'scored',reasons:[]}))});
}
function sessionFixture(directory,transport=async()=>{throw Error('unexpected_transport_submission');},timeoutMs=10000){
  return new ApiSession({directory:path.join(directory,'api'),environment:{GEMINI_API_KEY:'offline-test-not-a-secret'},transport,
    budget:{enabled:true,max_calls:2,max_estimated_cost_usd:1,per_call_cost_ceiling_usd:0.1},timeoutMs});
}

test('the read-only capability phase cannot claim whole-system readiness or require an episode allowance',async()=>{
  const result=await quality.preflightPostRenderQualityCapabilities({quality_review_policy:'automatic_required'},{});
  assert.equal(result.ready,false);
  assert.equal(result.capabilities_ready,false);
  assert.equal(result.new_budget_created,false);
  assert.equal(result.new_requests,0);
  assert.ok(result.missing.includes('actual_audio_review_session'));
  assert.ok(!result.missing.includes('existing_shared_episode_budget_required'));
});

async function observationFixture(receiptChanges={},storedChanges={}){
  const directory=await fixture(),audio=path.join(directory,'synthetic-audio.bin'),picture=path.join(directory,'synthetic-video.bin');
  await writeFile(audio,'synthetic audio bytes - not actual listening evidence');
  await writeFile(picture,'synthetic picture bytes - not actual listening evidence');
  const bound=async file=>({path:file,sha256:await hashFile(file)}),input_audio=await bound(audio),video=await bound(picture);
  const job={path:audio,source_sha256:input_audio.sha256,source_video_sha256:video.sha256,source_range:[0,1]};
  const observation={vocal_type:'unknown',language:'unknown',description:'Engineering fixture only',instruments:[],
    original_audio_kind:'unknown',words:[],changes:[],issues:[],uncertainties:['Not a real qualification or audition.']};
  const payload={model:'gemini-3.8-flash',input:[{type:'audio',data:Buffer.from('synthetic audio bytes - not actual listening evidence').toString('base64')},
    {type:'video',data:Buffer.from('synthetic picture bytes - not actual listening evidence').toString('base64')}]};
  const requestFile=path.join(directory,'request.json');await writeFile(requestFile,JSON.stringify(payload));
  const request_payload=await bound(requestFile),bodyHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const preparation=await saveJson(path.join(directory,'prepared.json'),{schema_version:1,contract:'exact_audio_picture_submission_v1',
    request_payload,request_body_sha256:bodyHash,backend:DEFAULT_AUDIO_BACKEND,job,identity:{input_audio,pcm_sha256:'a'.repeat(64)},
    options:{purpose:'mix',frames:[],video}});
  const raw_response=await saveJson(path.join(directory,'response.json'),{id:'offline-request-1',status:'completed',
    model:'gemini-3.8-flash',outputs:[{type:'text',text:JSON.stringify(observation)}]});
  const submission_receipt=await saveJson(path.join(directory,'submission.json'),{...DEFAULT_AUDIO_BACKEND,provider:'gemini',stage:'mix',
    model:'gemini-3.8-flash',request_id:'offline-request-1',status:'completed',request_body_sha256:bodyHash,
    response:raw_response,...receiptChanges});
  const api_evidence=await saveJson(path.join(directory,'audit.json'),{...DEFAULT_AUDIO_BACKEND,
    provider:'gemini',purpose:'mix',audio_sha256:input_audio.sha256,submitted_pcm_sha256:'a'.repeat(64),
    source_sha256:job.source_sha256,source_window:[0,1],request_id:'offline-request-1',model:'gemini-3.8-flash',
    finish_reason:'complete',request_body_sha256:bodyHash,request_payload,submission_receipt,raw_response,preparation});
  const stored={...DEFAULT_AUDIO_BACKEND,actual_audio_processed:true,completion_status:'complete',finish_reason:'complete',purpose:'mix',
    request_id:'offline-request-1',model:'gemini-3.8-flash',source_sha256:job.source_sha256,source_video_sha256:job.source_video_sha256,
    source_range:[0,1],synchronized_video:video,input_audio,pcm_sha256:'a'.repeat(64),observation,request_payload,submission_receipt,api_evidence,
    request_body_sha256:bodyHash,preparation,...storedChanges};
  const file=await saveJson(path.join(directory,'observation.json'),stored);
  return{result:{...stored,file},backend:DEFAULT_AUDIO_BACKEND,job,video};
}

test('rendered mix verification rejects a receipt from a different provider even when every file hash is current',async()=>{
  const f=await observationFixture({provider:'not-gemini'});
  await assert.rejects(quality.verifyRenderedAudioObservation(f.result,f),/quality_review_submission_receipt_mismatch/);
});

test('a strict single-film real runtime factory and missing capabilities never allocate an episode budget',async()=>{
  const directory=await fixture(),video=path.join(directory,'source.bin');await writeFile(video,'synthetic source - engineering only');
  const config={schema_version:1,mode:'research',direction_contract_version:2,automatic_trial:true,
    material_strategy:'independent_music_packs',source_policy:{kind:'independent_pack_trial'},trial_review_policy:'diagnostic_candidates',
    quality_review_policy:'automatic_required',account_cli_slot_directory:path.join(directory,'slots'),
    video,output_dir:path.join(directory,'episode')};
  const runtime=await createCodexEpisodeRuntime(config,{});
  assert.equal(runtime.trialBudget,null);
  assert.equal(runtime.trialBudgets.size,0);
  const result=await composeAutomaticEpisode(config,runtime);
  assert.equal(result.status,'audio_review_backend_unavailable');
  assert.equal(runtime.trialBudgets.size,0);
  assert.equal(result.actual_audio_listened,false);
  assert.ok(!(await readJson(result.quality_readiness.path)).missing.includes('existing_shared_episode_budget_required'));
});

test('valid capabilities are not whole-system readiness and strict full preflight requires the current film identity',async()=>{
  const directory=await fixture(),config={quality_review_policy:'automatic_required',quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,
    quality_review_qualification:await qualifiedFixture(directory)},runtime={audioReviewSession:sessionFixture(directory)};
  const capabilities=await quality.preflightPostRenderQualityCapabilities(config,runtime);
  assert.equal(capabilities.capabilities_ready,true);assert.equal(capabilities.ready,false);
  runtime.trialBudget=await createIndependentTrialBudget({directory:path.join(directory,'budget'),sourceSha256:'b'.repeat(64),outputRoot:directory});
  const full=await quality.preflightPostRenderQuality(config,runtime);
  assert.equal(full.ready,false);
  assert.ok(full.missing.includes('bound_current_episode_budget_identity_required'));
});

test('an unregistered mix model cannot pass capability admission or allocate an allowance',async()=>{
  const directory=await fixture(),backend={protocol:'gemini_interactions',backend_id:'gemini-other',model_revision:'gemini-other'};
  const config={quality_review_policy:'automatic_required',quality_review_audio_backend:backend,
    quality_review_qualification:await qualifiedFixture(directory,backend)};
  const session=new ApiSession({directory:path.join(directory,'api'),audioBackend:backend,
    environment:{GEMINI_API_KEY:'offline-test-not-a-secret'},budget:{enabled:true,max_calls:1,max_estimated_cost_usd:1,per_call_cost_ceiling_usd:0.1},
    transport:async()=>{throw Error('unregistered_model_must_not_submit');}});
  const result=await quality.preflightPostRenderQualityCapabilities(config,{audioReviewSession:session});
  assert.equal(result.capabilities_ready,false);
  assert.ok(result.missing.includes('bound_audio_picture_submission_preparer_unsupported'));
  assert.equal(result.new_budget_created,false);
});

test('the strict controller binds its film allowance only after capability discovery and stores full readiness',async()=>{
  const directory=await fixture(),video=path.join(directory,'source.bin');await writeFile(video,'synthetic controller source');
  const config={schema_version:1,mode:'research',video,output_dir:path.join(directory,'episode'),
    quality_review_policy:'automatic_required',quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,
    quality_review_qualification:await qualifiedFixture(directory)};
  let ownedBudget=null;
  const result=await composeAutomaticEpisode(config,{execution_kind:'injected_test_transport',audioReviewSession:sessionFixture(directory),
    ensureBudget:async()=>ownedBudget=await createIndependentTrialBudget({directory:path.join(directory,'budget'),
      sourceSha256:await hashFile(video),outputRoot:config.output_dir}),
    controllerStages:{analyzeTarget:async()=>({status:'target_analysis_host_response_pending',unresolved:['synthetic stop before inference']})}});
  assert.equal(result.status,'target_analysis_host_response_pending');
  const state=await readJson(result.checkpoint.path);
  assert.equal((await readJson(state.quality_readiness.path)).ready,true);
  assert.equal((await ownedBudget.snapshot()).charged_request_slots,0);
});

test('the strict controller refuses another source or output-root allowance before analysis',async()=>{
  for(const mismatch of ['source','output']){
    const directory=await fixture(),video=path.join(directory,'source.bin');await writeFile(video,'synthetic bound film');
    const config={schema_version:1,mode:'research',video,output_dir:path.join(directory,'episode'),quality_review_policy:'automatic_required',
      quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,quality_review_qualification:await qualifiedFixture(directory)};
    const foreign=await createIndependentTrialBudget({directory:path.join(directory,'foreign-budget'),
      sourceSha256:mismatch==='source'?'c'.repeat(64):await hashFile(video),
      outputRoot:mismatch==='output'?path.join(directory,'other-film'):config.output_dir});
    const result=await composeAutomaticEpisode(config,{execution_kind:'injected_test_transport',audioReviewSession:sessionFixture(directory),
      ensureBudget:async()=>foreign,controllerStages:{analyzeTarget:async()=>{throw Error('analysis_must_not_start');}}});
    assert.equal(result.status,'audio_review_backend_unavailable');
    const readiness=await readJson(result.quality_readiness.path);
    assert.ok(readiness.missing.includes('bound_current_episode_budget_identity_required'));
    assert.equal((await foreign.snapshot()).charged_request_slots,0);
  }
});

test('two interleaved strict films retain separate original allowances and a first-film failure does not stop the second',async()=>{
  const directory=await fixture(),qualification=await qualifiedFixture(directory),budgets=new Map(),seen=new Map();
  const films=await Promise.all(['one','two'].map(async name=>{const video=path.join(directory,`${name}.bin`);await writeFile(video,`synthetic film ${name}`);
    return{schema_version:1,mode:'research',video,output_dir:path.join(directory,name),quality_review_policy:'automatic_required',
      quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,quality_review_qualification:qualification};}));
  let release;const bothEntered=new Promise(resolve=>release=resolve);
  const runtime={execution_kind:'injected_test_transport',audioReviewSession:sessionFixture(directory),
    ensureBudget:async({config})=>{const budget=await createIndependentTrialBudget({directory:path.join(config.output_dir,'budget'),
      sourceSha256:await hashFile(config.video),outputRoot:config.output_dir,limits:{max_requests:2,max_elapsed_ms:10000,max_input_tokens:1000}});
      budgets.set(config.video,budget);runtime.trialBudget=budget;return budget;},
    controllerStages:{analyzeTarget:async(config,context)=>{
      seen.set(config.video,context.trialBudget);if(seen.size===2)release();await bothEntered;
      const current=await context.trialBudget.snapshot();assert.equal(current.identity.source_video_sha256,await hashFile(config.video));
      const lease=await context.trialBudget.reserve({stage:'analysis',attempt:1,request_sha256:'d'.repeat(64),
        budget:{submitted_input_tokens:50},timeoutMs:1000});await context.trialBudget.complete(lease,{terminated:true});
      if(config.video===films[0].video)throw Error('synthetic_first_film_failure');
      return{status:'target_analysis_host_response_pending',unresolved:['synthetic stop before inference']};}}};
  const results=await Promise.all(films.map(config=>composeAutomaticEpisode(config,runtime)));
  assert.equal(results[0].status,'automatic_episode_failed');assert.equal(results[0].error,'synthetic_first_film_failure');
  assert.equal(results[1].status,'target_analysis_host_response_pending');
  assert.notEqual(seen.get(films[0].video),seen.get(films[1].video));
  for(const film of films){const state=await budgets.get(film.video).snapshot();
    assert.equal(state.charged_request_slots,1);assert.equal(state.identity.limits.max_requests,2);
    assert.equal(state.identity.limits.max_elapsed_ms,10000);assert.equal(state.identity.limits.max_input_tokens,1000);
    assert.equal(state.identity.output_root,film.output_dir);}
});

test('strict timeout classification never consults a foreign session allowance',async()=>{
  const directory=await fixture(),video=path.join(directory,'source.bin');await writeFile(video,'synthetic timeout source');
  const config={schema_version:1,mode:'research',video,output_dir:path.join(directory,'episode'),quality_review_policy:'automatic_required',
    quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,quality_review_qualification:await qualifiedFixture(directory)};
  let clock=100;
  const foreign=await createIndependentTrialBudget({directory:path.join(directory,'foreign-budget'),sourceSha256:'f'.repeat(64),
    outputRoot:path.join(directory,'other-film'),limits:{max_elapsed_ms:10},now:()=>clock});clock=200;
  const session=sessionFixture(directory);session.trialBudget=foreign;
  const result=await composeAutomaticEpisode(config,{execution_kind:'injected_test_transport',session,audioReviewSession:sessionFixture(directory),
    ensureBudget:async()=>createIndependentTrialBudget({directory:path.join(directory,'budget'),sourceSha256:await hashFile(video),outputRoot:config.output_dir}),
    controllerStages:{analyzeTarget:async()=>{throw Error('codex_cli_timeout');}}});
  assert.equal(result.status,'automatic_episode_failed');assert.equal(result.error,'codex_cli_timeout');
  assert.equal((await foreign.snapshot()).stops.length,0,'classification must not consume or stop the foreign film');
});

async function renderedFixture(transport,timeoutMs=10000,color='blue'){
  const directory=await fixture(),previewFile=path.join(directory,'synthetic-preview.mp4');
  execFileSync('ffmpeg',['-v','error','-nostdin','-n','-f','lavfi','-i',`color=${color}:s=64x48:r=10:d=1`,
    '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',previewFile],{windowsHide:true});
  const source={path:previewFile,sha256:await hashFile(previewFile)},sourceHash=source.sha256;
  const inputs={
    manifest:await saveJson(path.join(directory,'manifest.json'),{source_sha256:sourceHash,timeline:{duration_samples:48000,sample_rate:48000}}),
    analysis:await saveJson(path.join(directory,'analysis.json'),{story_beats:[],sound_events:[],uncertainties:['engineering fixture']}),
    director:await saveJson(path.join(directory,'director.json'),{source_video_sha256:sourceHash,music_actions:[],cues:[],uncertainties:[]}),
    arc_plan:await saveJson(path.join(directory,'plan.json'),{source_video_sha256:sourceHash,arcs:[]}),
    edits:await saveJson(path.join(directory,'edits.json'),{schema_version:1,action_responses:[],music_edits:[]})};
  const render_binding=await saveJson(path.join(directory,'render.json'),{inputs,preview:previewFile,render:{mix_issues:[]},unresolved:[]});
  const config={quality_review_policy:'automatic_required',quality_review_audio_backend:DEFAULT_AUDIO_BACKEND,
    quality_review_qualification:await qualifiedFixture(directory)};
  const trialBudget=await createIndependentTrialBudget({directory:path.join(directory,'budget'),sourceSha256:sourceHash,outputRoot:directory});
  return{directory,input:{source,render_binding,config,episode_output_root:directory,output_dir:path.join(directory,'review-1'),render_files:[source],cache_dir:path.join(directory,'cache')},
    runtime:{audioReviewSession:sessionFixture(directory,transport,timeoutMs),trialBudget,
      qualityReviewIdentity:{source_video_sha256:sourceHash,output_root:directory}}};
}

test('rendered review submits its explicit frozen preparation through the actual API transport boundary',async()=>{
  const bodies=[],f=await renderedFixture(async(_url,options)=>{bodies.push(options.body);return new Response(JSON.stringify({id:'offline-review-success',
    model:'gemini-3.8-flash',status:'completed',outputs:[{type:'text',text:JSON.stringify({vocal_type:'unknown',language:'unknown',
      description:'Synthetic engineering transport only',instruments:[],original_audio_kind:'unknown',words:[],changes:[],issues:[],
      uncertainties:['Synthetic transport is not a listening qualification or artistic acceptance.']})}]}),{status:200});});
  const result=await quality.reviewRenderedEpisode(f.input,f.runtime);
  assert.equal(result.status,'quality_review_unresolved');assert.equal(bodies.length,1);
  const observed=await readJson(result.observations[0].path),payload=await readJson(observed.request_payload.path);
  assert.equal(bodies[0],JSON.stringify(payload));
  assert.equal((await f.runtime.trialBudget.snapshot()).charged_request_slots,1);
  const cached=await quality.reviewRenderedEpisode({...f.input,output_dir:path.join(f.directory,'review-2')},f.runtime);
  assert.equal(cached.status,'quality_review_unresolved');assert.equal(bodies.length,1);
  await writeFile(observed.submission_receipt.path,'{"tampered":true}');
  await assert.rejects(quality.reviewRenderedEpisode({...f.input,output_dir:path.join(f.directory,'review-3')},f.runtime),/audio_evidence_binding_changed/);
  assert.equal(bodies.length,1,'a changed cached receipt cannot cause resubmission');
});

test('timed out unknown review keeps its pending identity and restart cannot submit it again',async()=>{
  let submitted=0;
  const f=await renderedFixture(async()=>{submitted++;return new Promise(()=>{});},25);
  await assert.rejects(quality.reviewRenderedEpisode(f.input,f.runtime),/gemini_provider_outcome_unknown/);
  const first=await f.runtime.trialBudget.snapshot();
  assert.equal(first.charged_request_slots,1);assert.equal(first.requests[0].status,'child_outcome_unknown');
  assert.equal(first.requests[0].confirmed_invocations,null);
  const resumed=await quality.reviewRenderedEpisode({...f.input,output_dir:path.join(f.directory,'review-resumed')},f.runtime);
  assert.equal(resumed.status,'quality_review_unresolved');assert.equal(submitted,1);
  assert.ok(resumed.unresolved.includes('unreconciled_audio_review_submission'));
  const final=await f.runtime.trialBudget.snapshot();assert.equal(final.charged_request_slots,1);
  assert.deepEqual(final.identity.limits,first.identity.limits);
});

test('direct strict review cannot use a self-consistent ledger and runtime identity belonging to another film or output',async()=>{
  for(const mismatch of ['source','output']){
    const f=await renderedFixture(async()=>{throw Error('foreign_budget_must_not_submit');});
    const foreignIdentity={source_video_sha256:mismatch==='source'?'c'.repeat(64):f.input.source.sha256,
      output_root:mismatch==='output'?path.join(f.directory,'other-film'):f.directory};
    f.runtime.trialBudget=await createIndependentTrialBudget({directory:path.join(f.directory,'foreign-budget'),
      sourceSha256:foreignIdentity.source_video_sha256,outputRoot:foreignIdentity.output_root});
    f.runtime.qualityReviewIdentity=foreignIdentity;
    await assert.rejects(quality.reviewRenderedEpisode(f.input,f.runtime),/quality_review_current_episode_budget_identity_mismatch/);
    assert.equal((await f.runtime.trialBudget.snapshot()).charged_request_slots,0);
  }
});

test('rendered observation checks each completed receipt identity and byte binding, with a valid positive control',async()=>{
  const valid=await observationFixture();
  assert.equal((await quality.verifyRenderedAudioObservation(valid.result,valid)).purpose,'mix');
  for(const changes of [{stage:'candidate'},{status:'submitted'},{request_id:'other-request'},{model:'gemini-other'},
    {request_body_sha256:'e'.repeat(64)},{response:{path:valid.result.api_evidence.path,sha256:valid.result.api_evidence.sha256}}]){
    const f=await observationFixture(changes);
    await assert.rejects(quality.verifyRenderedAudioObservation(f.result,f),/quality_review_submission_receipt_mismatch/);
  }
  await writeFile(valid.result.request_payload.path,'{"modified":true}');
  await assert.rejects(quality.verifyRenderedAudioObservation(valid.result,valid),/audio_evidence_binding_changed/);
});

test('cached observation cannot relabel its frozen body, preparation, or receipt backend with freshly hashed records',async()=>{
  const unrelated=await observationFixture();
  for(const [receiptChanges,storedChanges] of [[{protocol:'local_audio_model'},{}],[{backend_id:'other-backend'},{}],
    [{},{request_body_sha256:'b'.repeat(64)}],[{},{preparation:unrelated.result.preparation}]]){
    const f=await observationFixture(receiptChanges,storedChanges);
    await assert.rejects(quality.verifyRenderedAudioObservation(f.result,f),/quality_review_(submission_receipt|prepared_request)_mismatch/);
  }
});

test('a current cached window cannot reuse a self-consistent observation of another picture with identical mix audio',async()=>{
  const transport=async()=>new Response(JSON.stringify({id:'offline-other-picture',model:'gemini-3.8-flash',status:'completed',
    outputs:[{type:'text',text:JSON.stringify({vocal_type:'unknown',language:'unknown',description:'Synthetic fixture only',
      instruments:[],original_audio_kind:'unknown',words:[],changes:[],issues:[],uncertainties:['Not actual audition.']})}]}),{status:200});
  const first=await renderedFixture(transport,10000,'blue'),second=await renderedFixture(transport,10000,'red');
  const current=await quality.reviewRenderedEpisode(first.input,first.runtime),foreign=await quality.reviewRenderedEpisode(second.input,second.runtime);
  assert.equal(current.mix.sha256,foreign.mix.sha256,'the audio is deliberately the same but source pictures differ');
  assert.notEqual(first.input.source.sha256,second.input.source.sha256);
  const currentWindow=path.join(path.dirname(current.mix.path),'window-0','verified-review-window.json'),
    foreignWindow=await readJson(path.join(path.dirname(foreign.mix.path),'window-0','verified-review-window.json'));
  foreignWindow.render_binding=first.input.render_binding;foreignWindow.qualification=first.input.config.quality_review_qualification;
  await writeFile(currentWindow,JSON.stringify(foreignWindow));
  await assert.rejects(quality.reviewRenderedEpisode({...first.input,output_dir:path.join(first.directory,'review-foreign-cache')},first.runtime),
    /quality_review_cached_window_mismatch/);
});
