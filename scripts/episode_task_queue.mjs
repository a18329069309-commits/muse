import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { hashFile } from './render_binding.mjs';
import { verifyEvidenceBindings } from './audio_api.mjs';
import {boundAssemblyGapRuntimeSpec,preflightBoundAssemblyGapControllerRecovery,
  boundAssemblyGapRuntimeRevision} from './bounded_assembly_gap_runtime.mjs';
import {typedUnknownRangeRecoveryRevision,resolvePersistedFailedUnknownRange} from './typed_unknown_range_recovery.mjs';
import {independentMusicComparisonPolicy} from './independent_music_comparison_policy.mjs';
import {independentMusicSelectionProjectionRevision} from './independent_music_selection_projection.mjs';
import {validateEpisodeCallPlan,episodeCallPlanRevision} from './episode_call_admission.mjs';
import {validateReviewInputLimitPolicy} from './independent_trial_budget.mjs';

const canonical = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const now = () => Date.now();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; } };
const authenticationError = value => /(?:\b401\b|authentication failed|unauthorized|invalid authentication)/i.test(value ?? '');
// Legacy diagnostic completion is a scheduler fact only. The automatic quality
// route is completed only after its controller has accepted an actual review.
const successful = result => ['director_trial_pending_audition', 'target_analysis_complete'].includes(result?.status)
  || result?.status === 'quality_review_accepted' && result.quality_status === 'accepted' && result.actual_audio_listened === true;

// Queue admission is not a new film or stage result. Only these explicit,
// versioned repairs may reopen their own terminal failed stage; the controller
// still validates the exact source, stage cache, budget and real response.
export async function stageRepairQueueIdentity(config, runtime = {}, sourceSha = null) {
  if(config.assembly_sfx_pool_contract_revision!==undefined
    &&(config.assembly_sfx_pool_contract_revision!=='observed-candidates-final-assembly-v1'
      ||config.sfx_adoption_mode!=='assembly'||config.material_strategy!=='independent_music_packs'
      ||config.source_policy?.kind!=='independent_pack_trial'||config.trial_review_policy!=='diagnostic_candidates'))
    throw Error('episode_queue_assembly_sfx_pool_scope_invalid');
  if(config.trial_call_plan!==undefined)validateEpisodeCallPlan(config.trial_call_plan);
  if(config.review_input_limit_policy!==undefined){
    validateReviewInputLimitPolicy(config.review_input_limit_policy);
    if(config.quality_review_policy!=='composite_research')throw Error('episode_queue_review_input_policy_scope_invalid');
  }
  const settings = [
    {field:'director_source_range_revision',value:config.codex_cli?.director_source_range_revision,
      expected:'host-codepoint-source-spans-v1',stage:'direction',modules:['typed_bounded_style_director.mjs',
        'codex_cli_runtime.mjs','compose_codex_episode.mjs','compose_uploaded_episode.mjs']},
    {field:'assembly_sfx_pool_contract_revision',value:config.assembly_sfx_pool_contract_revision,
      expected:'observed-candidates-final-assembly-v1',stage:'materials',modules:['assembly_sfx_candidate_pool.mjs',
        'target_sfx_material_bridge.mjs','target_sound_query_repair_batch.mjs','sound_retrieval_contract.mjs',
        'material_selection.mjs','assembly_sfx_adoption.mjs','assembly_material_observation.mjs',
        'assembly_consumer_projection.mjs','sfx_event_function.mjs','render_research_trial.mjs']},
    {field:'review_input_limit_policy',value:config.review_input_limit_policy?.revision,
      expected:'composite-review-input-48k-v1',stage:'composite_review',modules:['independent_trial_budget.mjs',
        'codex_cli_runtime.mjs','composite_research_review.mjs','compose_codex_episode.mjs','automatic_episode_controller.mjs']},
    {field:'assembly_decision_contract_revision',value:config.assembly_decision_contract_revision,
      expected:'host-bound-editor-decisions-v1',stage:'assembly',modules:['assembly_decision_contract.mjs',
        'compact_business_contract.mjs','role_split_assembly_projection.mjs','role_split_research_assembly.mjs',
        'bounded_research_assembly.mjs','assemble_research_episode.mjs']},
    {field:'quality_review_policy',value:config.quality_review_policy==='composite_research'?'composite_research':undefined,
      expected:'composite_research',stage:'composite_review',modules:['composite_research_review.mjs','composite_scoped_repair.mjs',
        'local_research_audio_observer.mjs','codex_host_session.mjs','automatic_episode_controller.mjs',
        'assemble_research_episode.mjs','render_research_trial.mjs','post_render_quality_review.mjs']},
    {field:'trial_call_plan',value:config.trial_call_plan?.revision,expected:episodeCallPlanRevision,stage:'budget',
      modules:['episode_call_admission.mjs','independent_trial_budget.mjs','codex_cli_runtime.mjs',
        'codex_host_session.mjs','owned_process_runner.mjs','owned_process_tree.py','episode_local_task_worker.mjs',
          'render_research_trial.mjs','run_sound_job.mjs','analyze_target.mjs','prepare_episode.mjs',
          'local_research_evidence.mjs','research_story_resume.mjs','local_research_execution.mjs',
          'prepare_director_contact_sheets.py']},
    {field:'independent_music_selection_projection',value:independentMusicComparisonPolicy(config)
        ?independentMusicSelectionProjectionRevision:undefined,expected:independentMusicSelectionProjectionRevision,stage:'materials',
      modules:['independent_music_material_bridge.mjs','independent_music_selection_projection.mjs',
        'material_observation_projection.mjs','bounded_inline_record_encoding.mjs','completed_material_selection_evidence.mjs']},
    {field:'typed_unknown_range_recovery',value:config.codex_cli?.director_contract==='typed_bounded_v1'
        ?typedUnknownRangeRecoveryRevision:undefined,expected:typedUnknownRangeRecoveryRevision,stage:'direction',
      modules:['typed_unknown_range_recovery.mjs','typed_bounded_style_director.mjs','bound_direction_execution_evidence.mjs','codex_cli_runtime.mjs']},
    { field: 'story_part_evidence_repair', value: runtime.storyPartEvidenceRepair ?? config.codex_cli?.story_part_evidence_repair,
      expected: 'evidence_ids_once', stage: 'analysis', modules: ['story_part_evidence_repair.mjs', 'compose_codex_episode.mjs', 'codex_host_session.mjs'] },
    { field: 'sound_query_repair_contract', value: runtime.soundQueryRepairContract ?? config.codex_cli?.sound_query_repair_contract,
      expected: 'sound_query_field_projection_v1', stage: 'materials', modules: ['target_sound_query_repair_batch.mjs',
        'sound_query_contract.mjs', 'target_sfx_material_bridge.mjs'] },
    { field: 'sound_catalog_routing_revision', value: runtime.soundCatalogRoutingRevision ?? config.codex_cli?.sound_catalog_routing_revision,
      expected: 'event-role-sound-catalog-v1', stage: 'materials', modules: ['sound_catalog_routing.mjs',
        'target_sfx_material_bridge.mjs'] },
    {field:'sound_edit_decision_contract_revision',value:runtime.soundEditDecisionContractRevision
        ??config.sound_edit_decision_contract_revision??config.codex_cli?.sound_edit_decision_contract_revision,
      expected:'strict-sound-decisions-v1',stage:'assembly',modules:['sound_edit_decision_contract.mjs',
        'bound_sound_decision_recovery.mjs','bound_sfx_direction_provenance.mjs','assembly_sfx_adoption.mjs',
        'research_assembly_resume.mjs','assemble_research_episode.mjs']},
    { field: 'sfx_material_selection_projection', value: runtime.sfxMaterialSelectionProjection ?? config.codex_cli?.sfx_material_selection_projection,
      expected: 'sfx_lossless_shared_observations_v1', stage: 'materials', modules: ['material_selection.mjs', 'target_sfx_material_bridge.mjs',
        'sfx_material_selection_projection.mjs', 'material_observation_projection.mjs'] },
    { field: 'bounded_assembly_projection_revision', value: runtime.boundedAssemblyProjectionRevision
        ?? config.bounded_assembly_projection_revision ?? config.codex_cli?.bounded_assembly_projection_revision,
      expected: 'mother-cue-complete-action-subparts-v1', stage: 'assembly', modules: ['bounded_mother_action_projection.mjs',
        'bounded_inline_record_encoding.mjs', 'bounded_assembly_continuation.mjs', 'bounded_research_assembly.mjs',
        'assemble_research_episode.mjs', 'assembly_material_observation.mjs', 'sound_arc_edit.mjs'] },
  ];
  const contracts = [];
  for (const row of settings) {
    if (row.value === undefined) continue;
    if (row.value !== row.expected) throw Error('episode_queue_repair_contract_invalid');
    const implementation = [];
    for (const file of row.modules) implementation.push({ file, sha256: await hashFile(fileURLToPath(new URL(file, import.meta.url))) });
    contracts.push({ field: row.field, value: row.value, stage: row.stage, implementation });
  }
  if (runtime.boundedAssemblyGapClassifications) {
    sourceSha ??= await hashFile(config.video?.path ?? config.video);
    const spec = boundAssemblyGapRuntimeSpec(runtime, sourceSha);
    if (spec) {
      const implementation = [];
      for (const file of ['bounded_assembly_gap_runtime.mjs', 'bounded_assembly_gap_classification.mjs',
        'bounded_research_assembly.mjs', 'assemble_research_episode.mjs', 'bounded_assembly_execution_evidence.mjs'])
        implementation.push({file, sha256:await hashFile(fileURLToPath(new URL(file, import.meta.url)))});
      contracts.push({field:'bounded_assembly_gap_classification', value:boundAssemblyGapRuntimeRevision,
        stage:'assembly', source_sha256:sourceSha, bound_recovery:spec, implementation});
    }
  }
  if(runtime.assemblyRecoveries){
    sourceSha??=await hashFile(config.video?.path??config.video);
    const binding=runtime.assemblyRecoveries[sourceSha];
    if(binding){
      await verifyEvidenceBindings(binding);const record=JSON.parse(await readFile(binding.path,'utf8'));
      if(record.kind==='bound_completed_sound_decision_recovery'){
        if(record.source_video_sha256!==sourceSha||record.qualified!==false||record.production_approval!==false)
          throw Error('episode_queue_bound_sound_decision_source_invalid');
        const implementation=[];
        for(const file of ['bound_sound_decision_recovery.mjs','sound_edit_decision_contract.mjs','bound_sfx_direction_provenance.mjs',
          'assembly_sfx_adoption.mjs','assemble_research_episode.mjs'])
          implementation.push({file,sha256:await hashFile(fileURLToPath(new URL(file,import.meta.url)))});
        contracts.push({field:'bound_completed_sound_decision_recovery',value:'physical-noop-bound-recovery-v1',
          stage:'assembly',source_sha256:sourceSha,bound_recovery:binding,implementation});
      }
    }
  }
  return contracts.length ? { revision: 'explicit-terminal-stage-repair-admission-v1', contracts } : null;
}

// Short synchronous SQLite transactions never encompass model, decode or rendering work.
export class EpisodeTaskQueue {
  constructor(file) {
    if (!path.isAbsolute(file)) throw Error('episode_queue_absolute_path_required');
    this.file = file; this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS episode_jobs(
        job_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, source_sha TEXT NOT NULL,
        config_json TEXT NOT NULL, config_sha TEXT NOT NULL, output_dir TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        owner_token TEXT, owner_pid INTEGER, owner_host TEXT, lease_until INTEGER,
        result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS episode_ready ON episode_jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS episode_stages(job_id TEXT NOT NULL,stage TEXT NOT NULL,
        status TEXT NOT NULL,evidence_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(job_id,stage));
      CREATE TABLE IF NOT EXISTS episode_events(id INTEGER PRIMARY KEY,job_id TEXT,kind TEXT NOT NULL,
        details_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_executor(name TEXT PRIMARY KEY,status TEXT NOT NULL,details_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episode_repair_admissions(job_id TEXT PRIMARY KEY,
        identity_sha TEXT NOT NULL,identity_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_executor VALUES('model','ready','{}');`);
  }
  static async open(directory) {
    await mkdir(directory, { recursive: true }); return new EpisodeTaskQueue(path.join(directory, 'episode-queue.sqlite'));
  }
  close() { this.db.close(); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(job, kind, details = {}) {
    this.db.prepare('INSERT INTO episode_events(job_id,kind,details_json,created_at) VALUES(?,?,?,?)')
      .run(job, kind, canonical(details), now());
  }
  async enqueue(entry) {
    if (!entry?.episode_id?.trim() || !path.isAbsolute(entry.config?.video ?? '')) throw Error('episode_queue_source_identity_required');
    const source_sha = await hashFile(entry.config.video), job_id = digest({ episode_id: entry.episode_id, source_sha });
    // Existing checkpoints keep their path; new source versions receive separate state and locks.
    const existing = this.db.prepare('SELECT output_dir FROM episode_jobs WHERE job_id=?').get(job_id);
    const output_dir = existing?.output_dir ?? path.join(path.dirname(this.file), 'episodes', job_id.slice(0, 24));
    const config = { ...entry.config, output_dir }, config_sha = digest(config);
    const completed = this.db.prepare("SELECT result_json FROM episode_jobs WHERE job_id=? AND status='completed'").get(job_id);
    if (completed?.result_json) {
      try { await verifyEvidenceBindings(JSON.parse(completed.result_json)); }
      catch (error) {
        this.transaction(() => {
          this.db.prepare("UPDATE episode_jobs SET status='failed_isolated',error=?,updated_at=? WHERE job_id=? AND status='completed'")
            .run(error.message, now(), job_id);
          this.event(job_id, 'completed_evidence_invalid_isolated', { error: error.message,
            previous_result_retained: true, automatic_replay: false });
        });
        return job_id;
      }
    }
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM episode_jobs WHERE job_id=?').get(job_id);
      if (!old) {
        this.db.prepare(`INSERT INTO episode_jobs(job_id,episode_id,source_sha,config_json,config_sha,output_dir,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'ready',?,?)`).run(job_id, entry.episode_id, source_sha, canonical(config), config_sha, output_dir, now(), now());
        this.event(job_id, 'admitted_actual_source', { source_sha, config_sha });
      } else if (old.config_sha !== config_sha) {
        if (['running','recovery_required','waiting_result','waiting_auth'].includes(old.status)) throw Error('episode_queue_active_configuration_change_requires_reconciliation');
        this.db.prepare(`UPDATE episode_jobs SET config_json=?,config_sha=?,status='ready',updated_at=? WHERE job_id=?`)
          .run(canonical(config), config_sha, now(), job_id);
        this.event(job_id, 'changed_configuration_reuses_stage_checkpoint', { previous: old.config_sha, next: config_sha });
      }
      return job_id;
    });
  }
  async reconcileRepairContract(job_id, config, runtime = {}) {
    const row = this.db.prepare('SELECT * FROM episode_jobs WHERE job_id=?').get(job_id);
    if (!row) throw Error('episode_queue_repair_job_missing');
    const identity = await stageRepairQueueIdentity(config, runtime, row.source_sha);
    if (!identity) return { reopened: false, reason: 'no_explicit_stage_repair' };
    const identity_sha = digest(identity);
    const previous = this.db.prepare('SELECT identity_sha,identity_json FROM episode_repair_admissions WHERE job_id=?').get(job_id);
    if (previous?.identity_sha === identity_sha) return { reopened: false, reason: 'unchanged_stage_repair' };
    if (row.status === 'ready') {
      this.transaction(() => {
        this.db.prepare(`INSERT INTO episode_repair_admissions VALUES(?,?,?,?)
          ON CONFLICT(job_id) DO UPDATE SET identity_sha=excluded.identity_sha,identity_json=excluded.identity_json,updated_at=excluded.updated_at`)
          .run(job_id, identity_sha, canonical(identity), now());
        this.event(job_id, 'stage_repair_contract_admitted', { identity_sha, identity, already_ready: true });
      });
      return { reopened: false, reason: 'already_ready' };
    }
    // Only an explicitly bound, technically executable completed model part
    // can reopen this waiting label. Missing materials and arbitrary waiting
    // results remain waiting; the old response and budget are not replaced.
    if (row.status === 'waiting_materials') {
      const contract = identity.contracts.find(item => item.field === 'bounded_assembly_gap_classification');
      const old = previous ? JSON.parse(previous.identity_json).contracts.find(item => item.field === contract?.field) : null;
      if (!contract || old && canonical(old.bound_recovery) === canonical(contract.bound_recovery))
        return {reopened:false,reason:'no_new_bound_execution_gap_recovery'};
      const result = row.result_json ? JSON.parse(row.result_json) : null;
      if (result?.status !== 'research_assembly_execution_gap' || row.error !== null
        || !result.checkpoint?.sha256 || path.resolve(result.checkpoint.path) !== path.join(path.resolve(row.output_dir),'automatic-state.json'))
        return {reopened:false,reason:'bound_terminal_execution_gap_required'};
      await verifyEvidenceBindings(result.checkpoint);
      const state = JSON.parse(await readFile(result.checkpoint.path,'utf8'));
      const savedConfig = JSON.parse(row.config_json), sourcePath = savedConfig.video?.path ?? savedConfig.video;
      const source = {path:path.resolve(sourcePath),sha256:row.source_sha};
      const proof = await preflightBoundAssemblyGapControllerRecovery(contract.bound_recovery,
        {config:savedConfig,source,state});
      this.retry(job_id,{reason:'bound_completed_part_gap_classification_changed',repairContract:{identity,identity_sha,
        previous_identity_sha:previous?.identity_sha??null,bound_execution_gap_classification:{
          revision:boundAssemblyGapRuntimeRevision,source_sha256:row.source_sha,recovery:contract.bound_recovery,
          checkpoint:result.checkpoint,materials_result:proof.materials_result,new_material_policy_executed:false,
          qualification_granted:false,production_approval:false}}});
      return {reopened:true,identity_sha,reused_completed_materials:true};
    }
    if (row.status !== 'failed_isolated') return { reopened: false, reason: 'terminal_failure_required' };
    // A failed scheduler label does not reconcile unknown execution, changed
    // delivered files, authentication or exhausted budgets.
    if (/timeout|unknown|unreconciled|binding_changed|authentication|unauthorized|\b401\b|budget_exhausted/i.test(row.error ?? ''))
      return { reopened: false, reason: 'failure_requires_existing_reconciliation' };
    const failed = this.stages(job_id).filter(stage => stage.status === 'failed').map(stage => stage.stage);
    const previousContracts = previous ? JSON.parse(previous.identity_json).contracts : [];
    const changed=identity.contracts.filter(contract=>contract.field!=='bounded_assembly_gap_classification'&&failed.includes(contract.stage)
      &&canonical(previousContracts.find(row=>row.field===contract.field))!==canonical(contract));
    let boundUnknownRange=null;
    if(changed.some(contract=>contract.field==='typed_unknown_range_recovery')){
      const result=row.result_json?JSON.parse(row.result_json):null;
      if(result?.failure_evidence&&result.checkpoint?.sha256
        &&path.resolve(result.checkpoint.path)===path.join(path.resolve(row.output_dir),'automatic-state.json')){
        await verifyEvidenceBindings(result.checkpoint);const state=JSON.parse(await readFile(result.checkpoint.path,'utf8')),
          config=JSON.parse(row.config_json),source={path:path.resolve(config.video?.path??config.video),sha256:row.source_sha};
        if(state.source?.sha256===source.sha256&&state.stages.direction?.status==='failed'
          &&canonical(state.stages.direction.failure_evidence)===canonical(result.failure_evidence))
          boundUnknownRange=await resolvePersistedFailedUnknownRange(result.failure_evidence,{source,episodeRoot:row.output_dir,
            outputDirectory:path.join(row.output_dir,'recorded-stage-repair-admission')});
      }
    }
    if (!changed.some(contract=>contract.field!=='typed_unknown_range_recovery'||boundUnknownRange?.binding))
      return { reopened: false, reason: 'repair_does_not_address_failed_stage' };
    this.retry(job_id, { reason: 'effective_versioned_stage_repair_changed',
      repairContract: { identity, identity_sha, previous_identity_sha: previous?.identity_sha ?? null,
        ...(boundUnknownRange?.binding?{bound_unknown_range_recovery:boundUnknownRange}:{}) } });
    return { reopened: true, identity_sha };
  }
  executorState() { return this.db.prepare("SELECT status FROM queue_executor WHERE name='model'").get().status; }
  claim({ lease_ms = 60000, max_running = 2 } = {}) {
    if (!Number.isInteger(max_running) || max_running < 1 || max_running > 2) throw Error('episode_queue_concurrency_maximum_two');
    return this.transaction(() => {
      if (this.executorState() !== 'ready') return null;
      if (this.db.prepare("SELECT count(*) AS count FROM episode_jobs WHERE status='running'").get().count >= max_running) return null;
      const row = this.db.prepare("SELECT * FROM episode_jobs WHERE status='ready' ORDER BY created_at,episode_id LIMIT 1").get();
      if (!row) return null;
      const owner_token = randomUUID();
      this.db.prepare(`UPDATE episode_jobs SET status='running',attempts=attempts+1,owner_token=?,owner_pid=?,owner_host=?,lease_until=?,updated_at=? WHERE job_id=?`)
        .run(owner_token, process.pid, os.hostname(), now()+lease_ms, now(), row.job_id);
      this.event(row.job_id, 'claimed', { owner_token, pid: process.pid });
      return { ...row, owner_token, config: JSON.parse(row.config_json) };
    });
  }
  heartbeat(job, lease_ms = 60000) {
    const changes = this.db.prepare("UPDATE episode_jobs SET lease_until=?,updated_at=? WHERE job_id=? AND owner_token=? AND status='running'")
      .run(now()+lease_ms, now(), job.job_id, job.owner_token).changes;
    if (!changes) throw Error('episode_queue_ownership_changed');
  }
  markStages(job, stages) {
    this.transaction(() => {
      const owner = this.db.prepare('SELECT owner_token,status FROM episode_jobs WHERE job_id=?').get(job.job_id);
      if (owner?.owner_token !== job.owner_token || owner.status !== 'running') throw Error('episode_queue_stage_owner_changed');
      for (const [stage, evidence] of Object.entries(stages ?? {})) this.db.prepare(`INSERT INTO episode_stages VALUES(?,?,?,?,?)
        ON CONFLICT(job_id,stage) DO UPDATE SET status=excluded.status,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
        .run(job.job_id, stage, evidence.status ?? 'unknown', canonical(evidence), now());
    });
  }
  finish(job, result, error = null) {
    const auth = authenticationError(error ?? result?.error);
    const status = auth ? 'waiting_auth' : successful(result) ? 'completed'
      : /host_response_pending|director_pending/.test(result?.status ?? '') ? 'waiting_result'
      : /budget_exhausted/.test(result?.status ?? '') ? 'waiting_budget'
      : /^(?:audio_review_backend_unavailable|quality_review_)/.test(result?.status ?? '') ? 'waiting_quality'
      : /failed/.test(result?.status ?? '') || error ? 'failed_isolated' : 'waiting_materials';
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE episode_jobs SET status=?,result_json=?,error=?,owner_token=NULL,lease_until=NULL,updated_at=?
        WHERE job_id=? AND owner_token=? AND status='running'`)
        .run(status, result ? canonical(result) : null, error ?? result?.error ?? null, now(), job.job_id, job.owner_token);
      if (!update.changes) throw Error('episode_queue_completion_owner_changed');
      this.event(job.job_id, status, { result_status: result?.status ?? null, error: error ?? result?.error ?? null });
      if (auth) this.db.prepare("UPDATE queue_executor SET status='waiting_auth',details_json=? WHERE name='model'")
        .run(canonical({ job_id: job.job_id, error: error ?? result?.error }));
    });
  }
  reconcileOwners() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM episode_jobs WHERE status='running'").all()) {
        if (row.owner_host !== os.hostname() || alive(row.owner_pid) !== false) continue;
        const stages = this.stages(row.job_id);
        // A dead parent does not prove that a model/decoder child has stopped or its response was lost.
        const unknown = stages.some(stage => ['running','waiting','waiting_result'].includes(stage.status));
        const status = unknown ? 'recovery_required' : 'ready';
        this.db.prepare('UPDATE episode_jobs SET status=?,owner_token=NULL,lease_until=NULL,updated_at=? WHERE job_id=?')
          .run(status, now(), row.job_id);
        this.event(row.job_id, 'dead_owner_reconciled', { status, do_not_replay_unknown_response: unknown });
      }
    });
  }
  resumeExecutor(verified = false) {
    if (verified !== true) throw Error('verified_authentication_recovery_required');
    this.transaction(() => {
      this.db.prepare("UPDATE queue_executor SET status='ready',details_json='{}' WHERE name='model'").run();
      this.db.prepare("UPDATE episode_jobs SET status='ready',updated_at=? WHERE status='waiting_auth'").run(now());
      this.event(null, 'authentication_recovery_verified');
    });
  }
  async reconcilePendingResponses() {
    for (const row of this.db.prepare("SELECT job_id FROM episode_jobs WHERE status='waiting_result'").all()) {
      for (const stage of this.stages(row.job_id)) {
        const evidence = JSON.parse(stage.evidence_json), pending = evidence.result;
        if (!path.isAbsolute(pending?.host_response_file ?? '') || !pending.host_request?.sha256) continue;
        try {
          await verifyEvidenceBindings(pending.host_request);
          const request = JSON.parse(await readFile(pending.host_request.path,'utf8'));
          const response = JSON.parse(await readFile(pending.host_response_file,'utf8'));
          if (response.request_sha256 !== request.request_sha256) continue;
          this.db.prepare("UPDATE episode_jobs SET status='ready',updated_at=? WHERE job_id=? AND status='waiting_result'")
            .run(now(), row.job_id);
          this.event(row.job_id, 'bound_pending_response_available', { request: pending.host_request,
            response_file: pending.host_response_file, new_inference_calls: 0 });
        } catch (error) { if (!['ENOENT','audio_evidence_binding_changed'].includes(error.code ?? error.message)) throw error; }
      }
    }
  }
  retry(job_id, { reason, reconciled = false, repairContract = null } = {}) {
    if (!reason?.trim()) throw Error('episode_queue_targeted_repair_reason_required');
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM episode_jobs WHERE job_id=?').get(job_id);
      if (!row || row.status === 'running' || row.status === 'completed') throw Error('episode_queue_retry_status_invalid');
      if (['recovery_required','waiting_result'].includes(row.status) && !reconciled) throw Error('episode_queue_unknown_result_reconciliation_required');
      if (row.status === 'waiting_auth' || row.status === 'waiting_budget') throw Error('episode_queue_executor_or_budget_recovery_required');
      if (repairContract) {
        const bound = repairContract.bound_execution_gap_classification;
        const waitingBound = row.status === 'waiting_materials' && bound?.revision === boundAssemblyGapRuntimeRevision
          && bound.source_sha256 === row.source_sha && JSON.parse(row.result_json??'null')?.status === 'research_assembly_execution_gap'
          && repairContract.identity.contracts.some(item=>item.field==='bounded_assembly_gap_classification'
            && item.source_sha256===row.source_sha && canonical(item.bound_recovery)===canonical(bound.recovery));
        if (row.status !== 'failed_isolated' && !waitingBound || repairContract.identity_sha !== digest(repairContract.identity))
          throw Error('episode_queue_repair_contract_admission_invalid');
        const old = this.db.prepare('SELECT identity_sha FROM episode_repair_admissions WHERE job_id=?').get(job_id);
        if ((old?.identity_sha ?? null) !== repairContract.previous_identity_sha)
          throw Error('episode_queue_repair_contract_admission_changed');
        this.db.prepare(`INSERT INTO episode_repair_admissions VALUES(?,?,?,?)
          ON CONFLICT(job_id) DO UPDATE SET identity_sha=excluded.identity_sha,identity_json=excluded.identity_json,updated_at=excluded.updated_at`)
          .run(job_id, repairContract.identity_sha, canonical(repairContract.identity), now());
        this.event(job_id, 'changed_stage_repair_reuses_existing_job', { ...repairContract,
          previous_error: row.error, previous_result: row.result_json ? JSON.parse(row.result_json) : null,
          output_dir: row.output_dir, config_sha: row.config_sha, budgets_reset: false });
      }
      this.db.prepare("UPDATE episode_jobs SET status='ready',updated_at=? WHERE job_id=?").run(now(), job_id);
      this.event(job_id, 'targeted_repair_requested', { reason, reconciled });
    });
  }
  async authorizeBudgetRecovery(job_id, grantBinding) {
    const row=this.db.prepare('SELECT * FROM episode_jobs WHERE job_id=?').get(job_id);
    if(!row || row.status!=='waiting_budget') throw Error('episode_queue_budget_recovery_status_invalid');
    await verifyEvidenceBindings(grantBinding);
    const grant=JSON.parse(await readFile(grantBinding.path,'utf8'));
    if(grant.source_video_sha256!==row.source_sha || path.resolve(grant.output_root??'')!==path.resolve(row.output_dir))
      throw Error('episode_queue_budget_recovery_scope_mismatch');
    const config=JSON.parse(row.config_json);
    const {createIndependentTrialBudget}=await import('./independent_trial_budget.mjs');
    const budget=await createIndependentTrialBudget({directory:path.join(row.output_dir,'independent-trial-budget'),
      outputRoot:row.output_dir,sourceSha256:row.source_sha,limits:config.trial_budget??{},activeRuns:true,
      policyRevision:config.trial_budget_revision??'independent-trial-v1'});
    const application=await budget.applyRecoveryGrant(grantBinding);
    this.transaction(()=>{
      if(this.db.prepare('SELECT status FROM episode_jobs WHERE job_id=?').get(job_id)?.status!=='waiting_budget')
        throw Error('episode_queue_budget_recovery_status_changed');
      this.db.prepare("UPDATE episode_jobs SET status='ready',updated_at=? WHERE job_id=?").run(now(),job_id);
      this.event(job_id,'scoped_human_budget_recovery_authorized',{grant:grantBinding,application:application.receipt,
        previous_error_retained:true,old_budget_identity_and_calls_unchanged:true});
    });
    return application;
  }
  stages(job_id) { return this.db.prepare('SELECT * FROM episode_stages WHERE job_id=? ORDER BY stage').all(job_id); }
  list() { return this.db.prepare('SELECT * FROM episode_jobs ORDER BY created_at,episode_id').all(); }
}

export async function runEpisodeQueue(config, runtime = {}, { compose } = {}) {
  if (!path.isAbsolute(config?.output_dir ?? '') || !Array.isArray(config.episodes) || !config.episodes.length)
    throw Error('episode_queue_configuration_required');
  const concurrency = config.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw Error('episode_queue_concurrency_maximum_two');
  compose ??= (await import('./automatic_episode_controller.mjs')).composeAutomaticEpisode;
  const queue = await EpisodeTaskQueue.open(config.output_dir);
  try {
    const admission_gaps = [];
    for (const entry of config.episodes) {
      try {
        const job = await queue.enqueue(entry);
        await queue.reconcileRepairContract(job, entry.config, runtime);
      }
      catch (error) {
        if (error.message !== 'episode_queue_active_configuration_change_requires_reconciliation') throw error;
        admission_gaps.push({ episode_id: entry.episode_id, reason: error.message,
          new_configuration_applied: false, next_action: 'reconcile_existing_response_before_configuration_change' });
      }
    }
    queue.reconcileOwners();
    await queue.reconcilePendingResponses();
    const work = async () => {
      while (!runtime.signal?.aborted) {
        const job = queue.claim({ max_running: concurrency }); if (!job) break;
        const heartbeat = setInterval(() => queue.heartbeat(job), 10000); heartbeat.unref();
        try {
          const result = await compose(job.config, { ...runtime, episode_id: job.episode_id, onProgress: async progress => {
            let stages = progress.stages;
            if (!stages && typeof progress.checkpoint === 'string') {
              const checkpoint = JSON.parse(await readFile(progress.checkpoint, 'utf8')); stages = checkpoint.stages;
            }
            queue.markStages(job, stages); await runtime.onProgress?.({ ...progress, queue_job_id: job.job_id });
          } });
          queue.finish(job, result);
        } catch (error) { queue.finish(job, null, error.message); }
        finally { clearInterval(heartbeat); }
      }
    };
    do {
      await Promise.all(Array.from({ length: concurrency }, work));
      if (!config.watch || runtime.signal?.aborted || queue.executorState() !== 'ready') break;
      await runtime.onQueueIdle?.({ queue_file: queue.file, status: 'available_queue_finished_with_gaps' });
      await delay(30000, undefined, { signal: runtime.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      await queue.reconcilePendingResponses();
      if (typeof runtime.discoverEpisodes === 'function') for (const row of await runtime.discoverEpisodes()) {
        const job = await queue.enqueue(row);
        await queue.reconcileRepairContract(job, row.config, runtime);
      }
    } while (!runtime.signal?.aborted);
    const rows = queue.list(), counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const reportRow = row => {
      const result = row.result_json ? JSON.parse(row.result_json) : {};
      return { ...result, job_id: row.job_id, source_sha256: row.source_sha, queue_status: row.status,
        status: row.status === 'failed_isolated' && (!result.status || successful(result))
          ? 'automatic_episode_failed' : result.status ?? row.status,
        attempts: row.attempts, output_dir: row.output_dir, ...(row.error ? { error: row.error } : {}) };
    };
    const byJob = new Map(rows.map(row => [row.job_id, row])), activeEntries = {};
    // Compatibility summary describes the requested versions; the complete version ledger remains available.
    for (const entry of config.episodes) {
      const requestedSha = await hashFile(entry.config.video);
      const row = byJob.get(digest({ episode_id: entry.episode_id, source_sha: requestedSha }));
      if (row) activeEntries[entry.episode_id] = reportRow(row);
    }
    return { schema_version: 1, kind: 'persistent_automatic_episode_queue', queue_file: queue.file,
      executor_state: queue.executorState(), counts, episodes: activeEntries, admission_gaps,
      job_versions: rows.map(row => ({ episode_id: row.episode_id, ...reportRow(row) })),
      production_approval: false, entire_corpus_complete: false };
  } finally { queue.close(); }
}
