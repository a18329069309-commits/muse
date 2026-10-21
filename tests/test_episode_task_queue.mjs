import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import {createHash} from 'node:crypto';
import { EpisodeTaskQueue, runEpisodeQueue, stageRepairQueueIdentity } from '../scripts/episode_task_queue.mjs';
import { hashFile } from '../scripts/render_binding.mjs';
import {createIndependentTrialBudget} from '../scripts/independent_trial_budget.mjs';
import {saveJson} from '../scripts/audio_api.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdr-durable-queue-'));
  const episodes = [];
  for (let i = 0; i < 4; i++) {
    const video = path.join(root, `upload-${i}.bin`); await writeFile(video, `distinct engineering source ${i}`);
    episodes.push({ episode_id: `e${i}`, config: { video, mode: 'research' } });
  }
  return { root, episodes };
}

test('explicit music projection reopens only the same failed materials job once and preserves completed stages and budget',async()=>{
 const f=await fixture(),entry=f.episodes[0];entry.config.material_strategy='independent_music_packs';
 entry.config.independent_music_comparison_policy={revision:'bounded-family-comparison-v1',first_music_family_limit:3,first_words_family_limit:2,numeric_low_energy_risk_dbfs:-35};
 const config={output_dir:f.root,episodes:[entry]},budget=await saveJson(path.join(f.root,'original-music-budget.json'),{requests:5,elapsed_ms:344722});
 let calls=0;const paths=[];
 const compose=async(cfg,runtime)=>{calls++;paths.push(cfg.output_dir);await runtime.onProgress({stages:{analysis:{status:'completed',attempt:1},
   direction:{status:'completed',attempt:1},materials:{status:'failed',attempt:calls}}});
   return{status:'automatic_episode_failed',error:'codex_cli_single_item_exceeds_input_budget',original_budget:budget};};
 const first=await runEpisodeQueue(config,{}, {compose}),job=first.job_versions[0],current=await stageRepairQueueIdentity(entry.config);
 const prior=structuredClone(current);prior.contracts=prior.contracts.filter(c=>c.field!=='independent_music_selection_projection');
 const queue=new EpisodeTaskQueue(first.queue_file);try{savePriorRepairIdentity(queue,job.job_id,prior);}finally{queue.close();}
 const next=await runEpisodeQueue(config,{}, {compose});assert.equal(calls,2);assert.equal(next.job_versions[0].job_id,job.job_id);
 assert.deepEqual(paths,[job.output_dir,job.output_dir]);await runEpisodeQueue(config,{}, {compose});assert.equal(calls,2);
 assert.equal(await hashFile(budget.path),budget.sha256);
 const module=current.contracts.find(c=>c.field==='independent_music_selection_projection');assert.equal(module.stage,'materials');
 assert.equal(module.implementation.length,5);
});

test('new music projection does not reopen success, exhausted, auth, unknown or unrelated analysis and assembly failures',async()=>{
 const policy={revision:'bounded-family-comparison-v1',first_music_family_limit:3,first_words_family_limit:2,numeric_low_energy_risk_dbfs:-35};
 for(const[status,error,stage]of[['director_trial_pending_audition',null,'materials'],
  ['independent_trial_budget_exhausted','request_budget_exhausted','materials'],['automatic_episode_failed','HTTP401 authentication failed','materials'],
  ['automatic_episode_failed','codex_cli_timeout','materials'],['automatic_episode_failed','unknown_execution_outcome','materials'],
  ['automatic_episode_failed','plot_invalid','analysis'],['automatic_episode_failed','assembly_invalid','assembly']]){
   const f=await fixture(),entry=f.episodes[0];entry.config={...entry.config,material_strategy:'independent_music_packs',independent_music_comparison_policy:policy};
   let calls=0;const config={output_dir:f.root,episodes:[entry]};
   const compose=async(_,r)=>{calls++;await r.onProgress({stages:{[stage]:{status:'failed',attempt:1}}});return{status,...(error?{error}:{})};};
   const first=await runEpisodeQueue(config,{}, {compose}),identity=await stageRepairQueueIdentity(entry.config),prior=structuredClone(identity);
   prior.contracts=prior.contracts.filter(c=>c.field!=='independent_music_selection_projection');
   const q=new EpisodeTaskQueue(first.queue_file);try{savePriorRepairIdentity(q,first.job_versions[0].job_id,prior);}finally{q.close();}
   const next=await runEpisodeQueue(config,{}, {compose});assert.equal(calls,1,error??status);
   assert.equal(next.job_versions[0].job_id,first.job_versions[0].job_id);
 }
});

// Model a previously admitted release without changing production module files.
// The stored contract is the exact queue audit, not a fabricated model result.
function savePriorRepairIdentity(queue, jobId, identity) {
  const json = JSON.stringify(identity, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const sha = createHash('sha256').update(json).digest('hex');
  queue.db.prepare('UPDATE episode_repair_admissions SET identity_sha=?,identity_json=? WHERE job_id=?')
    .run(sha, json, jobId);
}

test('only a validated source-bound human allowance can reopen the waiting-budget job, preserving its old failure',async()=>{
  const f=await fixture(),q=await EpisodeTaskQueue.open(f.root);
  try{
    const entry={...f.episodes[0],config:{...f.episodes[0].config,trial_budget_revision:'generic-adaptation-v1'}};
    const id=await q.enqueue(entry),job=q.claim();
    let clock=Date.now()-1200001;
    const budget=await createIndependentTrialBudget({directory:path.join(job.output_dir,'independent-trial-budget'),
      outputRoot:job.output_dir,sourceSha256:job.source_sha,activeRuns:true,policyRevision:'generic-adaptation-v1',now:()=>clock});
    await budget.openRun();clock+=1200001;
    await assert.rejects(budget.inspectLocal({stage:'synthetic-long-local-work'}),/budget_exhausted/);
    await budget.closeRun();const baseline=await budget.snapshot();
    q.finish(job,{status:'independent_trial_budget_exhausted',error:'old_elapsed_stop'});
    const scope={source_video_sha256:job.source_sha,output_root:job.output_dir,max_requests:2,max_elapsed_ms:600000,
      qualified:false,production_approval:false};
    const human=await saveJson(path.join(f.root,'human.json'),{schema_version:1,kind:'human_user_recovery_authorization',
      authorization_source:'direct_user_message',approved:true,...scope,received_at:new Date().toISOString(),
      user_request_quote:'SYNTHETIC ENGINEERING AUTHORIZATION ONLY; no real account usage.'});
    const grantData={schema_version:1,kind:'independent_trial_budget_supplemental_recovery_grant',grant_id:'test-one',...scope,
      charged_before:baseline.charged_request_slots,cumulative_elapsed_before_ms:baseline.elapsed_ms,
      prior_stop:baseline.stops.at(-1),human_authorization:human};
    const wrong=await saveJson(path.join(f.root,'wrong.json'),{...grantData,source_video_sha256:'e'.repeat(64)});
    await assert.rejects(q.authorizeBudgetRecovery(id,wrong),/scope_mismatch/);
    assert.equal(q.list()[0].status,'waiting_budget');
    const grant=await saveJson(path.join(f.root,'grant.json'),grantData);
    const accepted=await q.authorizeBudgetRecovery(id,grant);
    assert.equal(accepted.supplemental_recovery.remaining_requests,2);
    assert.equal(q.list()[0].status,'ready');assert.equal(q.list()[0].error,'old_elapsed_stop');
    clock=Date.now();
    assert.equal((await budget.snapshot()).identity.limits.max_elapsed_ms,1200000);
    await assert.rejects(q.authorizeBudgetRecovery(id,grant),/status_invalid/);
  }finally{q.close();}
});

test('durable admission is idempotent; isolated failures do not end other episodes; completed work is not replayed', async () => {
  const f = await fixture(), calls = [], stages = [];
  const config = { output_dir: f.root, episodes: f.episodes, concurrency: 2 };
  const compose = async (config, runtime) => {
    calls.push(runtime.episode_id);
    await runtime.onProgress({ status: 'running', stages: { analysis: { status: 'completed', attempt: 1 } } });
    if (runtime.episode_id === 'e1') throw Error('decode_bad_source');
    return { status: 'director_trial_pending_audition', render_registry: [], gaps: [], checkpoint: { path: path.join(config.output_dir, 'result.json') } };
  };
  const first = await runEpisodeQueue(config, {}, { compose });
  assert.equal(first.counts.completed, 3); assert.equal(first.counts.failed_isolated, 1);
  const second = await runEpisodeQueue(config, {}, { compose });
  assert.equal(calls.length, 4); assert.equal(second.counts.completed, 3);
  const q = new EpisodeTaskQueue(first.queue_file);
  for (const row of q.list()) stages.push(...q.stages(row.job_id));
  assert.equal(stages.filter(row => row.stage === 'analysis' && row.status === 'completed').length, 4);
  q.close();
});

test('an explicit changed assembly repair reenters the original terminal job once with its path budget and failure retained', async () => {
  const f = await fixture(), calls = [], config = { output_dir: f.root, episodes: [f.episodes[0]], concurrency: 1 };
  let budget;
  const compose = async (active, runtime) => {
    calls.push({ output: active.output_dir, episode: runtime.episode_id, revision: runtime.boundedAssemblyProjectionRevision });
    if (!budget) budget = await saveJson(path.join(f.root, 'unchanged-original-budget.json'), { charged_calls: 6, elapsed_ms: 463656 });
    await runtime.onProgress({ stages: { analysis: { status: 'completed', attempt: 1 },
      materials: { status: 'completed', attempt: 1 }, assembly: { status: 'failed', attempt: calls.length } } });
    return { status: 'automatic_episode_failed', error: 'bounded_assembly_single_mother_cue_exceeds_capacity',
      old_selection: 'actual existing selection remains in controller checkpoint' };
  };
  const first = await runEpisodeQueue(config, {}, { compose }), job = first.job_versions[0];
  const runtime = { boundedAssemblyProjectionRevision: 'mother-cue-complete-action-subparts-v1' };
  const second = await runEpisodeQueue(config, runtime, { compose });
  assert.equal(calls.length, 2); assert.equal(second.job_versions.length, 1);
  assert.equal(second.job_versions[0].job_id, job.job_id);
  assert.equal(second.job_versions[0].output_dir, job.output_dir);
  assert.deepEqual(calls.map(row => row.output), [job.output_dir, job.output_dir]);
  assert.equal(second.job_versions[0].attempts, 2);
  assert.equal(await hashFile(budget.path), budget.sha256);
  await runEpisodeQueue(config, runtime, { compose });
  assert.equal(calls.length, 2, 'unchanged failed repair is not resubmitted');
  const q = new EpisodeTaskQueue(first.queue_file);
  try {
    const events = q.db.prepare("SELECT details_json FROM episode_events WHERE job_id=? AND kind='changed_stage_repair_reuses_existing_job'").all(job.job_id);
    assert.equal(events.length, 1);
    const event = JSON.parse(events[0].details_json);
    assert.equal(event.previous_error, job.error);
    assert.equal(event.previous_result.old_selection, job.old_selection);
    assert.equal(event.budgets_reset, false);
    assert.equal(q.stages(job.job_id).find(row => row.stage === 'analysis').status, 'completed');
  } finally { q.close(); }
});

test('a fresh job with the same explicit repair that fails is not automatically retried', async () => {
  const f = await fixture(), config = { output_dir: f.root, episodes: [f.episodes[0]] }, calls = [];
  const runtime = { storyPartEvidenceRepair: 'evidence_ids_once' };
  const compose = async (_, active) => {
    calls.push(active.episode_id); await active.onProgress({ stages: { analysis: { status: 'failed', attempt: 1 } } });
    return { status: 'automatic_episode_failed', error: 'story_part_evidence_repair_actual_support_gap' };
  };
  await runEpisodeQueue(config, runtime, { compose }); await runEpisodeQueue(config, runtime, { compose });
  assert.equal(calls.length, 1);
  await runEpisodeQueue(config, { ...runtime, boundedAssemblyProjectionRevision: 'mother-cue-complete-action-subparts-v1' }, { compose });
  assert.equal(calls.length, 1, 'adding an unrelated assembly repair cannot retry the unchanged failed analysis contract');
});

test('concrete assembly dependencies reenter the same failed job once without replaying completed upstream stages or resetting budget', async () => {
  const f = await fixture(), config = {output_dir:f.root,episodes:[f.episodes[0]],concurrency:1};
  const runtime = {boundedAssemblyProjectionRevision:'mother-cue-complete-action-subparts-v1'};
  const budget = await saveJson(path.join(f.root,'retained-budget.json'), {actual_calls:8,max_requests:12,elapsed_ms:882533});
  const paths = [];
  const compose = async (active, session) => {
    paths.push(active.output_dir);
    await session.onProgress({stages:{analysis:{status:'completed',attempt:1},direction:{status:'completed',attempt:1},
      materials:{status:'completed',attempt:1},assembly:{status:'failed',attempt:paths.length}}});
    return {status:'automatic_episode_failed',error:'Cannot convert undefined or null to object',
      retained_budget:budget,retained_selection:'original frozen music and sound pool'};
  };
  const first = await runEpisodeQueue(config,runtime,{compose}), job = first.job_versions[0];
  const expected = await stageRepairQueueIdentity(config.episodes[0].config,runtime);
  const modules = expected.contracts[0].implementation;
  assert.deepEqual(modules.map(row=>row.file),['bounded_mother_action_projection.mjs','bounded_inline_record_encoding.mjs',
    'bounded_assembly_continuation.mjs','bounded_research_assembly.mjs','assemble_research_episode.mjs',
    'assembly_material_observation.mjs','sound_arc_edit.mjs']);
  for (const row of modules) assert.equal(row.sha256,await hashFile(path.join(import.meta.dirname,'../scripts',row.file)));
  let queue = new EpisodeTaskQueue(first.queue_file);
  try {
    const previous = structuredClone(expected);
    previous.contracts[0].implementation = previous.contracts[0].implementation.slice(0,4);
    savePriorRepairIdentity(queue,job.job_id,previous);
  } finally {queue.close();}
  const resumed = await runEpisodeQueue(config,runtime,{compose});
  assert.equal(paths.length,2);assert.equal(resumed.job_versions.length,1);
  assert.equal(resumed.job_versions[0].job_id,job.job_id);
  assert.deepEqual(paths,[job.output_dir,job.output_dir]);
  await runEpisodeQueue(config,runtime,{compose});assert.equal(paths.length,2,'unchanged implementation is not retried');
  queue = new EpisodeTaskQueue(first.queue_file);
  try {
    for (const stage of ['analysis','direction','materials']) {
      const row = queue.stages(job.job_id).find(item=>item.stage===stage);
      assert.equal(row.status,'completed');assert.equal(JSON.parse(row.evidence_json).attempt,1);
    }
    // A later actual helper-only release must also be visible to admission.
    const previous = structuredClone(expected);
    previous.contracts[0].implementation.find(row=>row.file==='assembly_material_observation.mjs').sha256='0'.repeat(64);
    savePriorRepairIdentity(queue,job.job_id,previous);
  } finally {queue.close();}
  await runEpisodeQueue(config,runtime,{compose});assert.equal(paths.length,3);
  await runEpisodeQueue(config,runtime,{compose});assert.equal(paths.length,3);
  queue = new EpisodeTaskQueue(first.queue_file);
  try {
    const events = queue.db.prepare("SELECT details_json FROM episode_events WHERE job_id=? AND kind='changed_stage_repair_reuses_existing_job'").all(job.job_id);
    assert.equal(events.length,2);
    for (const {details_json} of events) {
      const evidence = JSON.parse(details_json);
      assert.equal(evidence.previous_error,'Cannot convert undefined or null to object');
      assert.equal(evidence.previous_result.retained_selection,'original frozen music and sound pool');
      assert.equal(evidence.output_dir,job.output_dir);assert.equal(evidence.budgets_reset,false);
    }
  } finally {queue.close();}
  assert.equal(await hashFile(budget.path),budget.sha256);
});

test('assembly dependency changes cannot reopen success, waiting, exhausted, authentication, unknown, or an unrelated failed stage', async () => {
  const runtime = {boundedAssemblyProjectionRevision:'mother-cue-complete-action-subparts-v1'};
  for (const [status,error,stage] of [
    ['director_trial_pending_audition',null,'assembly'],
    ['research_assembly_execution_gap',null,'assembly'],
    ['independent_trial_budget_exhausted','request_budget_exhausted','assembly'],
    ['automatic_episode_failed','HTTP 401 authentication failed','assembly'],
    ['assembly_host_response_pending',null,'assembly'],
    ['automatic_episode_failed','codex_cli_timeout','assembly'],
    ['automatic_episode_failed','unknown_execution_outcome','assembly'],
    ['automatic_episode_failed','audio_evidence_binding_changed','assembly'],
    ['automatic_episode_failed','generic_target_analysis_invalid','analysis'],
    ['automatic_episode_failed','material_observation_missing','materials'],
  ]) {
    const f = await fixture(), config = {output_dir:f.root,episodes:[f.episodes[0]]};let calls=0;
    const compose = async (_,session)=>{calls++;await session.onProgress({stages:{[stage]:{status:'failed',attempt:1}}});
      return {status,...(error?{error}:{})};};
    const first = await runEpisodeQueue(config,runtime,{compose}), job=first.job_versions[0];
    const identity=await stageRepairQueueIdentity(config.episodes[0].config,runtime),old=structuredClone(identity);
    old.contracts[0].implementation=old.contracts[0].implementation.slice(0,4);
    const queue=new EpisodeTaskQueue(first.queue_file);
    try {savePriorRepairIdentity(queue,job.job_id,old);} finally {queue.close();}
    const next=await runEpisodeQueue(config,runtime,{compose});
    assert.equal(calls,1,error??status);assert.equal(next.job_versions[0].job_id,job.job_id);
    assert.equal(next.job_versions[0].queue_status,job.queue_status);
    assert.equal(next.job_versions[0].attempts,1);
  }
});

test('repair admission requires its own terminal stage and cannot bypass unknown auth budget or changed evidence', async () => {
  for (const [status, error, stage] of [
    ['automatic_episode_failed', 'codex_cli_timeout', 'analysis'],
    ['automatic_episode_failed', 'audio_evidence_binding_changed', 'analysis'],
    ['automatic_episode_failed', 'HTTP 401 authentication failed', 'analysis'],
    ['independent_trial_budget_exhausted', 'elapsed_budget_exhausted', 'analysis'],
    ['analysis_host_response_pending', null, 'analysis'],
    ['automatic_episode_failed', 'decoder_bad_source', 'prepare'],
    ['automatic_episode_failed', 'bounded_assembly_gap', 'assembly'],
  ]) {
    const f = await fixture(), config = { output_dir: f.root, episodes: [f.episodes[0]] };
    let calls = 0;
    const compose = async (_, runtime) => { calls++; await runtime.onProgress({ stages: { [stage]: { status: 'failed', attempt: 1 } } });
      return { status, ...(error ? { error } : {}) }; };
    const first = await runEpisodeQueue(config, {}, { compose });
    const second = await runEpisodeQueue(config, { storyPartEvidenceRepair: 'evidence_ids_once' }, { compose });
    assert.equal(calls, 1, error ?? status); assert.equal(second.job_versions[0].job_id, first.job_versions[0].job_id);
    assert.equal(second.job_versions[0].queue_status, first.job_versions[0].queue_status);
  }
});

test('the three exact versioned repair contracts bind their own source modules and ignore irrelevant runtime callbacks', async () => {
  assert.equal(await stageRepairQueueIdentity({}, { onProgress() {} }), null);
  const identity = await stageRepairQueueIdentity({ codex_cli: { story_part_evidence_repair: 'evidence_ids_once',
    sound_query_repair_contract: 'sound_query_field_projection_v1', bounded_assembly_projection_revision: 'mother-cue-complete-action-subparts-v1' } });
  assert.deepEqual(identity.contracts.map(row => row.stage), ['analysis', 'materials', 'assembly']);
  for (const row of identity.contracts) for (const binding of row.implementation) assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await stageRepairQueueIdentity({}, { soundQueryRepairContract: 'sound_query_field_projection_v1' }),
    await stageRepairQueueIdentity({ codex_cli: { sound_query_repair_contract: 'sound_query_field_projection_v1' } }));
  await assert.rejects(stageRepairQueueIdentity({}, { storyPartEvidenceRepair: 'arbitrary' }), /repair_contract_invalid/);
});

test('lossless SFX selection repair reopens a terminal material failure once and unrelated story changes cannot repeat it',async()=>{
  const f=await fixture(),config={output_dir:f.root,episodes:[f.episodes[0]]};let calls=0;
  const compose=async(_,runtime)=>{calls++;await runtime.onProgress({stages:{analysis:{status:'completed'},materials:{status:'failed'}}});
    return{status:'automatic_episode_failed',error:'sound_material_selection_input_capacity_exceeded'};};
  const prior={soundQueryRepairContract:'sound_query_field_projection_v1'};
  const first=await runEpisodeQueue(config,prior,{compose});
  const nextRuntime={...prior,sfxMaterialSelectionProjection:'sfx_lossless_shared_observations_v1'};
  const next=await runEpisodeQueue(config,nextRuntime,{compose});
  assert.equal(calls,2);assert.equal(next.job_versions[0].job_id,first.job_versions[0].job_id);
  assert.equal(next.job_versions[0].output_dir,first.job_versions[0].output_dir);
  await runEpisodeQueue(config,nextRuntime,{compose});
  await runEpisodeQueue(config,{...nextRuntime,storyPartEvidenceRepair:'evidence_ids_once'},{compose});
  assert.equal(calls,2);
  const identity=await stageRepairQueueIdentity({codex_cli:{sfx_material_selection_projection:'sfx_lossless_shared_observations_v1'}});
  assert.equal(identity.contracts[0].stage,'materials');
  assert.deepEqual(identity.contracts[0].implementation.map(row=>row.file),['material_selection.mjs','target_sfx_material_bridge.mjs',
    'sfx_material_selection_projection.mjs','material_observation_projection.mjs']);
  for (const row of identity.contracts[0].implementation)
    assert.equal(row.sha256,await hashFile(path.join(import.meta.dirname,'../scripts',row.file)));
  await assert.rejects(stageRepairQueueIdentity({}, {sfxMaterialSelectionProjection:'unknown'}),/repair_contract_invalid/);
});

test('a local live owner is never stolen on lease timeout and an unknown in-flight return requires reconciliation', async () => {
  const f = await fixture(), q = await EpisodeTaskQueue.open(f.root);
  await q.enqueue(f.episodes[0]);
  const claimed = q.claim({ lease_ms: 1 }); assert.ok(claimed);
  q.markStages(claimed, { analysis: { status: 'running', pending_request: { request_id: 'actual-request-unknown' } } });
  q.reconcileOwners(); assert.equal(q.list()[0].status, 'running');
  q.db.prepare('UPDATE episode_jobs SET owner_pid=? WHERE job_id=?').run(2147483646, claimed.job_id);
  q.reconcileOwners(); assert.equal(q.list()[0].status, 'recovery_required');
  assert.equal(q.claim(), null); q.close();
});

test('explicit event-role catalog repair reopens only a terminal material failure and keeps the original job and budget',async()=>{
  const f=await fixture(),config={output_dir:f.root,episodes:[f.episodes[0]]};let calls=0;
  const compose=async(_,runtime)=>{calls++;await runtime.onProgress({stages:{analysis:{status:'completed'},direction:{status:'completed'},materials:{status:'failed'}}});
    return{status:'automatic_episode_failed',error:'target_sfx_actual_event_query_kind_required',budget:{calls_used:5}};};
  const old=await runEpisodeQueue(config,{}, {compose});
  const repaired=await runEpisodeQueue(config,{soundCatalogRoutingRevision:'event-role-sound-catalog-v1'},{compose});
  assert.equal(calls,2);assert.equal(repaired.job_versions[0].job_id,old.job_versions[0].job_id);
  assert.equal(repaired.job_versions[0].output_dir,old.job_versions[0].output_dir);
  await runEpisodeQueue(config,{soundCatalogRoutingRevision:'event-role-sound-catalog-v1'},{compose});assert.equal(calls,2);
  const identity=await stageRepairQueueIdentity({}, {soundCatalogRoutingRevision:'event-role-sound-catalog-v1'});
  assert.equal(identity.contracts[0].stage,'materials');
  assert.deepEqual(identity.contracts[0].implementation.map(row=>row.file),['sound_catalog_routing.mjs','target_sfx_material_bridge.mjs']);
  await assert.rejects(stageRepairQueueIdentity({}, {soundCatalogRoutingRevision:'invalid'}),/repair_contract_invalid/);
});

test('authentication failure suspends model admission without discarding queued jobs', async () => {
  const f = await fixture();
  const result = await runEpisodeQueue({ output_dir: f.root, episodes: f.episodes, concurrency: 1 }, {}, {
    compose: async () => ({ status: 'automatic_episode_failed', error: 'HTTP 401 authentication failed', render_registry: [] }),
  });
  assert.equal(result.counts.waiting_auth, 1); assert.equal(result.counts.ready, 3);
  assert.equal(result.executor_state, 'waiting_auth');
  const q = new EpisodeTaskQueue(result.queue_file);
  assert.throws(() => q.resumeExecutor(), /verified_authentication_recovery_required/); q.close();
});

test('two actual source versions of one episode keep separate output, checkpoints and history', async () => {
  const f = await fixture(), q = await EpisodeTaskQueue.open(f.root);
  const first = { ...f.episodes[0], episode_id: 'same-episode' };
  const second = { ...f.episodes[1], episode_id: 'same-episode' };
  const firstId = await q.enqueue(first), firstPath = q.list()[0].output_dir;
  // Simulate a pre-upgrade checkpoint path: upgrading must preserve it.
  const legacyPath = path.join(f.root, 'episodes', 'existing-version-checkpoint');
  const row = q.list()[0], legacyConfig = JSON.parse(row.config_json);
  legacyConfig.output_dir = legacyPath;
  q.db.prepare('UPDATE episode_jobs SET output_dir=? WHERE job_id=?').run(legacyPath, firstId);
  await q.enqueue(first);
  const secondId = await q.enqueue(second);
  assert.notEqual(firstId, secondId);
  assert.equal(q.list().find(r => r.job_id === firstId).output_dir, legacyPath);
  assert.notEqual(q.list().find(r => r.job_id === secondId).output_dir, legacyPath);
  assert.notEqual(q.list().find(r => r.job_id === secondId).output_dir, firstPath);
  q.close();
  const result = await runEpisodeQueue({ output_dir: f.root, episodes: [first, second], concurrency: 2 }, {}, {
    compose: async config => ({ status: 'director_trial_pending_audition', render_registry: [], source_used: config.video }),
  });
  assert.equal(result.job_versions.length, 2);
  assert.equal(new Set(result.job_versions.map(r => r.output_dir)).size, 2);
  assert.equal(result.episodes['same-episode'].source_used, second.config.video);
  assert.equal(result.counts.completed, 2);
});

test('a changed completed artifact is rejected locally while an unrelated new upload still runs', async () => {
  const f = await fixture(), artifact = path.join(f.root, 'bound-output.json');
  await writeFile(artifact, '{"engineering":true}');
  const binding = { path: artifact, sha256: await hashFile(artifact) };
  await runEpisodeQueue({ output_dir: f.root, episodes: [f.episodes[0]] }, {}, {
    compose: async () => ({ status: 'director_trial_pending_audition', actual_output: binding }),
  });
  await writeFile(artifact, '{"engineering":"changed"}');
  const calls = [];
  const result = await runEpisodeQueue({ output_dir: f.root, episodes: [f.episodes[0], f.episodes[1]] }, {}, {
    compose: async (config, runtime) => {
      calls.push(runtime.episode_id); return { status: 'director_trial_pending_audition', render_registry: [] };
    },
  });
  assert.deepEqual(calls, ['e1']);
  assert.equal(result.episodes.e0.status, 'automatic_episode_failed');
  assert.equal(result.episodes.e0.error, 'audio_evidence_binding_changed');
  assert.equal(result.counts.failed_isolated, 1);
  assert.equal(result.counts.completed, 1);
  const q = new EpisodeTaskQueue(result.queue_file);
  assert.ok(q.list().find(row => row.episode_id === 'e0').result_json.includes(binding.sha256));
  q.close();
});

test('changing packs cannot replay an unknown request and does not block an unrelated upload', async () => {
  const f = await fixture(), q = await EpisodeTaskQueue.open(f.root);
  const firstId = await q.enqueue(f.episodes[0]), claimed = q.claim();
  q.finish(claimed, { status: 'materials_host_response_pending', host_response_file: path.join(f.root, 'unreturned.json') });
  const old = q.list()[0], changed = { ...f.episodes[0], config: { ...f.episodes[0].config, music_packs: { path: 'new-not-applied' } } };
  await assert.rejects(q.enqueue(changed), /active_configuration_change_requires_reconciliation/);
  assert.equal(q.list()[0].config_sha, old.config_sha);
  assert.equal(q.list()[0].status, 'waiting_result'); q.close();
  const calls = [];
  const result = await runEpisodeQueue({ output_dir: f.root, episodes: [changed, f.episodes[1]] }, {}, {
    compose: async (config, runtime) => { calls.push(runtime.episode_id); return { status: 'director_trial_pending_audition' }; },
  });
  assert.deepEqual(calls, ['e1']);
  assert.equal(result.admission_gaps.length, 1);
  assert.equal(result.admission_gaps[0].new_configuration_applied, false);
  assert.equal(result.counts.waiting_result, 1);
  assert.equal(result.counts.completed, 1);
  assert.equal(result.job_versions.find(row => row.job_id === firstId).attempts, 1);
});

test('two queue connections cannot exceed the shared active-film limit', async () => {
  const f = await fixture(), first = await EpisodeTaskQueue.open(f.root);
  for (const entry of f.episodes) await first.enqueue(entry);
  const second = new EpisodeTaskQueue(first.file);
  const a = first.claim(), b = second.claim();
  assert.ok(a); assert.ok(b); assert.notEqual(a.job_id, b.job_id);
  assert.equal(first.claim(), null); assert.equal(second.claim(), null);
  first.finish(a, { status: 'director_trial_pending_audition' });
  assert.ok(second.claim());
  first.close(); second.close();
});
