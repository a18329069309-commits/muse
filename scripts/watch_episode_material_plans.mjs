import path from 'node:path';
import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { makeRuntime, materialSchema, materialPlanPrompt, validateMaterialPlan, materialPlanCoverage, acquireBatchLock } from './run_corpus_batch.mjs';
import { verifySemanticSourceInputs } from './semantic_recall_evidence.mjs';

const execute = promisify(execFile), scripts = path.dirname(fileURLToPath(import.meta.url));
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const optional = async file => { try { return await readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const writeNew = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function casePlanIdentity(row, document) {
  const episode = document.episodes?.find(item => item.episode_id === row.episode_id);
  const work = document.works?.find(item => item.work_id === episode?.work_id);
  return work?.split === 'research' && episode?.source_video?.sha256
    ? shaBytes(JSON.stringify([row, episode.source_video, work.work_id, work.split])) : null;
}

export function eligibleEpisodeMaterialInput(episode, document) {
  if (episode.status !== 'research_processed' || episode.split !== 'research'
    || episode.identity_dispute_requires_resolution || !episode.case_import?.sha256
    || episode.coverage?.complete_processed !== true || episode.coverage.missing_ranges?.length
    || episode.coverage.unclassified_ranges?.length) return false;
  const source = document.episodes?.find(row => row.episode_id === episode.episode_id);
  const work = document.works?.find(row => row.work_id === episode.work_id);
  return work?.split === 'research' && source?.work_id === episode.work_id
    && source.source_video?.sha256 === episode.source_sha256 && document.cases?.length > 0
    && document.cases.every(row => row.episode_id === episode.episode_id && row.status === 'research');
}

export async function trialsArchived(config, verifiedArchives = new Set()) {
  if (!config.defer_until_trial_status) return true;
  const status = await optional(config.defer_until_trial_status);
  if (status?.all_nine_archived !== true || status.actual_whole_episode_music_previews !== 9
    || status.videos?.length !== 9 || new Set(status.videos.map(row => row.id)).size !== 9
    || status.videos.some(row => !row.stem_archive?.path || !row.stem_archive.sha256)) return false;
  const identity = shaBytes(JSON.stringify(status.videos.map(row => [row.id, row.stem_archive])));
  if (verifiedArchives.has(identity)) return true;
  try {
    for (const video of status.videos) {
      await verifyEvidenceBindings(video.stem_archive);
      const archive = await readJson(video.stem_archive.path);
      if (['bgm', 'sfx', 'ambience', 'accompaniment'].some(key => !archive.stems?.[key]?.path || !archive.stems[key].sha256)) return false;
      await verifyEvidenceBindings(archive.stems);
    }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  verifiedArchives.add(identity); return true;
}

export async function planEpisodeCaseBatches(cli, cases, input, sourceHash, directory) {
  const responses = [];
  for (let start = 0; start < cases.length; start += 20) {
    const batch = cases.slice(start, start + 20);
    const response = await cli.materialPlanner({ stage: 'material_task_planning', schema: materialSchema, prompt: materialPlanPrompt,
      data: { case_imports: [input], cases: batch, source_video_sha256: sourceHash } }, directory,
      { validateValue: value => validateMaterialPlan(value, batch) });
    validateMaterialPlan(response.value, batch); responses.push(response);
  }
  const value = { schema_version: 1, tasks: responses.flatMap(row => row.value.tasks), gaps: responses.flatMap(row => row.value.gaps),
    ...(responses.some(row => row.value.case_gaps) ? { case_gaps: responses.flatMap(row => row.value.case_gaps ?? []) } : {}) };
  validateMaterialPlan(value, cases);
  return { value, cli_receipts: responses.flatMap(row => row.cli_receipts ?? []), raw_responses: responses.map(row => row.raw_response).filter(Boolean),
    case_batch_sizes: Array.from({ length: responses.length }, (_, i) => Math.min(20, cases.length - i * 20)) };
}

async function plannedCaseIds(batch, state, cache) {
  const plans = [...Object.values(batch.works ?? {}), ...Object.values(batch.work_history ?? {}).flat(), ...Object.values(state.jobs)];
  const ids = new Map();
  for (const plan of plans) {
    const inputs = plan.input ? [plan.input] : plan.inputs;
    const records = plan.material_plan_records ?? (plan.material_tasks ? [plan.material_tasks] : []);
    if (!inputs?.length || !records.length) continue;
    const identity = shaBytes(JSON.stringify([inputs, records]));
    try {
      const stamps = await Promise.all([...inputs, ...records].map(async row => { const value = await stat(row.path); return [value.size, value.mtimeMs, value.ctimeMs]; }));
      const key = shaBytes(JSON.stringify([identity, stamps]));
      let entries = cache.get(key);
      if (!entries) {
        await verifyEvidenceBindings([...inputs, ...records]);
        const documents = await Promise.all(inputs.map(row => readJson(row.path))), tasks = await Promise.all(records.map(row => readJson(row.path)));
        const covered = new Set(tasks.flatMap(row => [...row.tasks, ...(row.case_gaps ?? [])]).map(row => row.case_id));
        entries = documents.flatMap(doc => (doc.cases ?? []).filter(row => covered.has(row.case_id))
          .map(row => [row.case_id, casePlanIdentity(row, doc)]).filter(row => row[1]));
        cache.set(key, entries);
      }
      for (const [id, definition] of entries) { if (!ids.has(id)) ids.set(id, new Set()); ids.get(id).add(definition); }
    } catch (error) {
      state.unverified_prior_plans ??= {};
      state.unverified_prior_plans[identity] = { inputs, records, error: error.code ?? error.message, excluded_current_cases: false };
    }
  }
  return ids;
}

export async function recoverEpisodeRetrieval(job, recovery, input) {
  const identity = shaBytes(JSON.stringify(recovery));
  const previous = job?.retrieval_recovery_history?.find(row => row.recovery_id === recovery.recovery_id);
  if (previous) {
    if (previous.operation_identity !== identity) throw new Error('retrieval_recovery_id_conflict');
    return false;
  }
  if (!job || job.status !== 'gap' || recovery.kind !== 'local_sqlite_retrieval'
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(recovery.recovery_id ?? '') || !recovery.reason?.trim()
    || recovery.expected_stage !== 'retrieving_candidates' || recovery.expected_error !== 1
    || recovery.key !== shaBytes(JSON.stringify([job.episode_id, input.sha256]))
    || [recovery.previous_failure, recovery.material_tasks, recovery.case_input].some(row => !row?.path || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
    || path.resolve(job.failure?.path ?? '') !== path.resolve(recovery.previous_failure.path)
    || job.failure?.sha256 !== recovery.previous_failure.sha256
    || path.resolve(job.material_tasks?.path ?? '') !== path.resolve(recovery.material_tasks.path)
    || job.material_tasks?.sha256 !== recovery.material_tasks.sha256
    || path.resolve(input.path) !== path.resolve(recovery.case_input.path) || input.sha256 !== recovery.case_input.sha256
    || path.resolve(job.input?.path ?? '') !== path.resolve(input.path) || job.input?.sha256 !== input.sha256)
    throw new Error('retrieval_recovery_bound_failed_plan_required');
  try { await verifyEvidenceBindings([recovery.previous_failure, recovery.material_tasks, recovery.case_input]); }
  catch { throw new Error('retrieval_recovery_evidence_changed'); }
  const failure = await readJson(recovery.previous_failure.path);
  if (failure.episode_id !== job.episode_id || failure.stage !== recovery.expected_stage || failure.error !== recovery.expected_error
    || path.resolve(failure.input?.path ?? '') !== path.resolve(input.path) || failure.input?.sha256 !== input.sha256)
    throw new Error('retrieval_recovery_original_failure_mismatch');
  job.retrieval_recovery_history ??= [];
  job.retrieval_recovery_history.push({ ...recovery, operation_identity: identity, started_at: new Date().toISOString() });
  job.retrieval_recovery = { recovery_id: recovery.recovery_id, material_tasks: recovery.material_tasks };
  job.status = 'retrieval_recovery_pending';
  return true;
}

export async function watchEpisodeMaterialPlans(config, runtime = {}) {
  const local = path.resolve(config.state_directory), stateFile = path.join(local, 'state.json');
  await mkdir(local, { recursive: true });
  const releaseLock = await acquireBatchLock(path.join(local, 'planner.lock'));
  const state = await optional(stateFile) ?? { schema_version: 1, jobs: {}, formal_adoption_allowed: false };
  const save = async () => { await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2)); await rename(stateFile + '.tmp', stateFile); };
  const command = runtime.execute ?? execute, existingPlans = new Map(), verifiedArchives = new Set();
  try {
    state.pid = process.pid; state.status = 'running'; await save();
    do {
      if (config.stop_request_file && await optional(config.stop_request_file)) { state.status = 'drained'; await save(); return state; }
      const batch = await readJson(config.batch_state), planned = await plannedCaseIds(batch, state, existingPlans);
      const entries = Object.entries(batch.episodes).toSorted((a, b) => Number(config.priority_episode_ids?.includes(b[0])) - Number(config.priority_episode_ids?.includes(a[0])));
      for (const [episode_id, item] of entries) {
        if (config.stop_request_file && await optional(config.stop_request_file)) { state.status = 'drained'; await save(); return state; }
        if (!item.case_import || item.split !== 'research' || item.status !== 'research_processed') continue;
        const inputKey = shaBytes(JSON.stringify([episode_id, item.case_import.sha256]));
        let job = state.jobs[inputKey];
        const document = await readJson(item.case_import.path), episode = { ...item, episode_id };
        if (!eligibleEpisodeMaterialInput(episode, document)) continue;
        if (job?.status && ['candidates_ready', 'planning_gap'].includes(job.status)) {
          if (job.coverage_revision === 'case-bound-decisions-v1') continue;
          const records = job.material_plan_records ?? [job.material_tasks];
          await verifyEvidenceBindings(records);
          const values = await Promise.all(records.map(row => readJson(row.path)));
          job.case_coverage = materialPlanCoverage({ tasks: values.flatMap(row => row.tasks), case_gaps: values.flatMap(row => row.case_gaps ?? []) },
            document.cases.filter(row => job.case_ids.includes(row.case_id)));
          if (!job.case_coverage.missing_case_ids.length) { job.coverage_revision = 'case-bound-decisions-v1'; await save(); continue; }
          job.material_plan_records = records;
          job.coverage_recovery = { missing_case_ids: job.case_coverage.missing_case_ids, prior_candidates: job.candidates ?? null,
            namespace: shaBytes(JSON.stringify([records, job.case_coverage.missing_case_ids])).slice(0, 12) };
          job.status = 'planning_coverage_gap'; await save();
        }
        const recoveries = (config.recovery_operations ?? []).filter(row => row.key === inputKey);
        if (recoveries.length > 1) throw new Error('one_retrieval_recovery_per_job_required');
        if (job?.status === 'gap' && recoveries.length) {
          if (await recoverEpisodeRetrieval(job, recoveries[0], item.case_import)) await save();
        }
        if (job?.status === 'gap') continue;
        const cases = document.cases.filter(row => !planned.get(row.case_id)?.has(casePlanIdentity(row, document)));
        if (!job && !cases.length) continue;
        job ??= state.jobs[inputKey] = { episode_id, source_sha256: item.source_sha256, input: item.case_import,
          case_ids: cases.map(row => row.case_id), created_at: new Date().toISOString() };
        const selectedCases = document.cases.filter(row => (job.coverage_recovery?.missing_case_ids ?? job.case_ids).includes(row.case_id));
        if (job.status !== 'awaiting_trial_archive') {
          job.status = 'awaiting_trial_archive'; state.status = 'awaiting_trial_archive'; await save();
        }
        if (!await trialsArchived(config, verifiedArchives)) continue;
        const out = path.join(config.discovery_root, 'work-results', shaBytes(item.work_id).slice(0, 20), 'episode-' + inputKey.slice(0, 20)
          + (job.coverage_recovery ? '-coverage-' + job.coverage_recovery.namespace : ''));
        const cache = path.join(local, inputKey), tasksFile = job.retrieval_recovery?.material_tasks.path ?? path.join(out, 'material-tasks.json');
        const candidateDir = path.join(out, 'corpus', 'material-candidates', inputKey.slice(0, 20));
        await mkdir(out, { recursive: true }); await mkdir(cache, { recursive: true }); await mkdir(candidateDir, { recursive: true });
        try {
          await verifyEvidenceBindings([item.case_import, item.result, ...document.episodes.map(row => row.source_video), ...document.cases.flatMap(row => row.evidence?.files ?? [])]);
          let tasks = await optional(tasksFile);
          if (job.retrieval_recovery) {
            if (!tasks) throw new Error('retrieval_recovery_material_tasks_missing');
            await verifyEvidenceBindings(job.retrieval_recovery.material_tasks);
          }
          if (!tasks) {
            job.status = 'planning'; state.status = 'planning'; await save();
            const cli = await (runtime.makeRuntime ?? makeRuntime)(config.runtime_config,
              { stateDirectory: path.join(cache, 'cli'), archiveDirectory: path.join(out, 'cli'), mediaBindings: document.episodes.map(row => row.source_video) }, {});
            const response = await planEpisodeCaseBatches(cli, selectedCases, item.case_import, item.source_sha256, out);
            tasks = response.value; validateMaterialPlan(tasks, selectedCases);
            await verifyEvidenceBindings(item.case_import);
            await writeNew(tasksFile, { ...tasks, tasks: tasks.tasks.map(task => ({ ...task, query: { ...task.query, limit: 20, usage_scope: 'research_noncommercial' } })) });
            job.cli_receipts = response.cli_receipts; job.raw_responses = response.raw_responses; job.case_batch_sizes = response.case_batch_sizes;
          }
          const modelTasks = { ...tasks, tasks: tasks.tasks.map(task => { const query = { ...task.query }; delete query.limit; delete query.usage_scope; return { ...task, query }; }) };
          validateMaterialPlan(modelTasks, selectedCases);
          job.material_tasks = await bound(tasksFile); job.planned_tasks = tasks.tasks.length;
          const records = [...(job.material_plan_records ?? []), job.material_tasks];
          job.material_plan_records = [...new Map(records.map(row => [row.sha256, row])).values()];
          const values = await Promise.all(job.material_plan_records.map(row => readJson(row.path)));
          job.case_coverage = materialPlanCoverage({ tasks: values.flatMap(row => row.tasks), case_gaps: values.flatMap(row => row.case_gaps ?? []) },
            document.cases.filter(row => job.case_ids.includes(row.case_id)));
          if (job.case_coverage.missing_case_ids.length) throw new Error('material_plan_case_coverage_incomplete');
          job.coverage_revision = 'case-bound-decisions-v1';
          if (!tasks.tasks.length) { job.status = 'planning_gap'; job.gaps = tasks.gaps; await save(); continue; }
          job.status = 'retrieving_candidates'; await save();
          const rawFile = path.join(candidateDir, 'candidate-bindings-raw.json'), file = path.join(candidateDir, 'candidate-bindings.json');
          const priorRaw = await optional(rawFile);
          let retrievalTasks = tasks, retrievalFile = tasksFile, library = config.library_db, semantic = null;
          if (job.semantic_recall || !priorRaw && config.semantic_recall && tasks.tasks.some(row => row.query.asset_kind === 'music')) {
            if (config.stop_request_file && await optional(config.stop_request_file)) { state.status = 'drained'; await save(); return state; }
            const settings = config.semantic_recall;
            if (!settings?.python || !settings.index || !settings.weights
              || [settings.index_manifest, settings.index_vectors, settings.library].some(row => !row?.path || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
              || path.resolve(settings.library.path) !== path.resolve(config.library_db)
              || path.resolve(settings.index_manifest.path) !== path.join(path.resolve(settings.index), 'index.json')
              || path.resolve(settings.index_vectors.path) !== path.join(path.resolve(settings.index), 'audio.npy'))
              throw new Error('explicit_semantic_recall_freeze_required');
            await verifyEvidenceBindings([settings.index_manifest, settings.index_vectors, settings.library]);
            const localDirectory = await realpath(local);
            if (localDirectory.startsWith('\\\\') || localDirectory.startsWith('//')) throw new Error('semantic_local_state_storage_required');
            const storageKind = job.semantic_recall ? (job.semantic_storage?.kind ?? 'single_database')
              : (settings.storage_kind ?? 'single_database');
            if (!['single_database', 'frozen_base_registered_windows'].includes(storageKind)) throw new Error('semantic_explicit_storage_kind_required');
            const storageRevision = storageKind === 'single_database' ? 'local-sqlite-storage-v2' : 'local-sqlite-base-delta-v1';
            const storageIdentity = shaBytes(JSON.stringify([storageRevision, inputKey, job.material_tasks,
              item.case_import, settings.library, settings.index_manifest, settings.index_vectors, settings.weights,
              job.retrieval_recovery?.recovery_id ?? null]));
            const storageDirectory = path.join(localDirectory, 'semantic-library', inputKey.slice(0, 20), storageIdentity.slice(0, 20));
            const database = job.semantic_recall ? (job.semantic_storage?.delta_db?.path ?? job.material_library.path)
              : path.join(storageDirectory, storageKind === 'single_database' ? 'registered-windows.sqlite' : 'registered-windows-delta.sqlite');
            const libraryDescriptor = storageKind === 'single_database' ? null
              : job.semantic_recall ? job.material_library.path : path.join(storageDirectory, 'registered-library.json');
            const semanticOutput = path.join(out, 'semantic-recall-' + storageIdentity.slice(0, 20));
            const semanticFile = job.semantic_recall?.path ?? path.join(semanticOutput, 'semantic-run-receipt.json');
            if (job.semantic_recall) await verifyEvidenceBindings(job.semantic_recall);
            let receipt = await optional(semanticFile);
            if (!receipt) {
              const semanticConfig = path.join(cache, 'semantic-recall-config-' + storageIdentity.slice(0, 20) + '.json');
              if (!await optional(semanticConfig)) await writeNew(semanticConfig, { task_file: tasksFile, case_input: item.case_import.path,
                library_db: config.library_db, index: settings.index, weights: settings.weights, device: 'cpu', expansion_limit: 50,
                invalid_query_handling: 'task_gap', storage_identity: storageIdentity,
                database, output_dir: semanticOutput, ...(libraryDescriptor ? { storage_kind: storageKind, library_descriptor: libraryDescriptor } : {}),
                semantic_queries: tasks.tasks.flatMap((task, task_index) => task.query.asset_kind === 'music'
                  ? [{ task_index, text: task.query.text }] : []) });
              try {
                await command(settings.python, [path.join(scripts, 'semantic_material_recall.py'), '--config', semanticConfig],
                  { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' } });
              } catch (error) {
                const failedFile = path.join(semanticOutput, 'semantic-run-failure.json'), failed = await optional(failedFile);
                if (failed?.status === 'semantic_recall_failed') {
                  error.receipt_file = await bound(failedFile);
                  error.subprocess_failure = { error_type: failed.error_type, error: failed.error,
                    sqlite_errorcode: failed.sqlite_errorcode ?? null, sqlite_errorname: failed.sqlite_errorname ?? null };
                }
                throw error;
              }
              receipt = await readJson(semanticFile);
            }
            if (receipt.status !== 'semantic_recall_complete_not_listened' || receipt.backend !== 'local_clap_text_audio_retrieval'
              || receipt.device !== 'cpu' || receipt.expansion_limit !== 50
              || !(receipt.text_embedding_forward_calls > 0 || receipt.text_embedding_forward_calls === 0 && receipt.invalid_query_handling === 'task_gap')
              || receipt.artistic_approval !== false || receipt.production_approval !== false
              || [receipt.library, receipt.expanded_tasks].some(row => !row?.path || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
              || !Array.isArray(receipt.query_evidence) || !receipt.query_evidence.length
              || receipt.source_inputs?.task_file?.sha256 !== job.material_tasks.sha256
              || receipt.source_inputs?.case_input?.sha256 !== item.case_import.sha256
              || receipt.source_inputs?.library_db?.sha256 !== settings.library.sha256
              || receipt.index_manifest?.sha256 !== settings.index_manifest.sha256 || receipt.index_vectors?.sha256 !== settings.index_vectors.sha256
              || path.resolve(receipt.library?.path ?? '') !== path.resolve(libraryDescriptor ?? database))
              throw new Error('semantic_recall_receipt_freeze_mismatch');
            const semanticBinding = job.semantic_recall ?? await bound(semanticFile);
            const historicalProofs = await verifySemanticSourceInputs(semanticBinding, receipt, config.semantic_execution_history);
            await verifyEvidenceBindings([receipt.expanded_tasks, receipt.library, receipt.query_evidence,
              receipt.index_manifest, receipt.index_vectors]);
            if (receipt.text_embedding_forward_calls === 0 && (await Promise.all(receipt.query_evidence.map(row => readJson(row.path))))
              .some(row => !['empty_music_text_requires_explicit_positive_description', 'negated_music_text_requires_explicit_structured_filters'].includes(row.semantic_gap)
                || row.actual_text_embedding_processed !== false || row.text_embedding_forward_calls !== 0 || row.attempts?.length !== 0))
              throw new Error('semantic_zero_forward_requires_explicit_query_gaps');
            semantic = semanticBinding; job.semantic_recall = semantic; job.material_library = receipt.library;
            if (historicalProofs.length) job.historical_semantic_execution_proofs = historicalProofs;
            job.semantic_storage = { revision: storageRevision, kind: storageKind, identity: storageIdentity, database: receipt.library,
              ...(receipt.library_storage ? { delta_db: receipt.library_storage.delta_db } : {}),
              scope: 'persistent task-local registered library; not a disposable rolling cache' }; await save();
            const expanded = await readJson(receipt.expanded_tasks.path);
            retrievalTasks = { ...expanded, tasks: expanded.tasks.filter(task => !task.semantic_gap) };
            retrievalFile = path.join(cache, 'material-tasks-registered.json'); library = receipt.library.path;
            if (!await optional(retrievalFile)) await writeNew(retrievalFile, retrievalTasks);
          }
          if (config.stop_request_file && await optional(config.stop_request_file)) { state.status = 'drained'; await save(); return state; }
          if (!priorRaw) {
            if (retrievalTasks.tasks.length) await command(config.python, [path.join(scripts, 'corpus_materials.py'), '--input', item.case_import.path,
              '--candidate-tasks', retrievalFile, '--library-db', library,
              ...(path.extname(library).toLowerCase() === '.json' ? ['--library-sha256', job.material_library.sha256] : []), '--candidate-report', path.join(candidateDir, 'retrieval-report.json'), '--output', rawFile],
              { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
            else await writeNew(rawFile, { schema_version: 1, tasks: [], retrieval_report: { gap: 'no_eligible_semantic_candidate_after_one_expansion', lexical_fallback_performed: false } });
          }
          let candidates = await readJson(rawFile);
          if (semantic) {
            const receipt = await readJson(semantic.path), expanded = await readJson(receipt.expanded_tasks.path);
            const active = expanded.tasks.filter(task => !task.semantic_gap);
            if (candidates.tasks.length !== active.length || candidates.tasks.some((row, i) =>
              row.case_id !== active[i].case_id || row.step_id !== active[i].step_id || row.source_event_id !== active[i].source_event_id))
              throw new Error('semantic_candidate_task_count_mismatch');
            let index = 0;
            candidates = { ...candidates, tasks: expanded.tasks.map(task => task.semantic_gap ? { ...task, candidates: [], attempts: [],
              gaps: [{ gap: task.semantic_gap, evidence: task.semantic_recall }] } : candidates.tasks[index++]),
              material_library: receipt.library, semantic_recall_receipt: semantic };
          }
          await verifyEvidenceBindings(item.case_import);
          if (!await optional(file)) await writeNew(file, { ...candidates, case_input: item.case_import,
            episode_planning_lineage: { episode_id, source_sha256: item.source_sha256, planning_input: item.case_import, planner_receipts: job.cli_receipts,
              original_candidate: await bound(rawFile), scope: 'single-episode research planning; not original music identification or listening approval' } });
          job.candidates = await bound(file); job.candidate_count = candidates.tasks.reduce((sum, row) => sum + row.candidates.length, 0);
          job.status = 'candidates_ready'; job.completed_at = new Date().toISOString(); state.status = 'running'; await save();
        } catch (error) {
          const accountWait = /authorization|quota|account_.*attention/.test(String(error.code ?? error.message));
          const failure = path.join(out, `failure-${Date.now()}-${randomUUID()}.json`);
          await writeNew(failure, { episode_id, input: item.case_import, stage: job.status, error: error.code ?? error.message,
            original_receipt: error.receipt_file ?? null, ...(error.subprocess_failure ? { subprocess_failure: error.subprocess_failure } : {}),
            stack_locations: String(error.stack ?? '').split('\n').filter(row => /^\s*at /.test(row)), research_only: true });
          job.failure = await bound(failure); job.status = accountWait ? 'account_wait' : 'gap'; await save();
          if (accountWait) { state.status = 'account_wait'; await save(); return state; }
        }
      }
      state.status = await trialsArchived(config, verifiedArchives) ? 'waiting_for_new_completed_episode' : 'awaiting_trial_archive';
      state.last_scan_at = new Date().toISOString(); await save();
      if (config.continuous === false) return state;
      await sleep(config.poll_ms ?? 30000);
    } while (true);
  } finally { await releaseLock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--config');
  if (at < 0) throw new Error('config_required');
  await watchEpisodeMaterialPlans(await readJson(process.argv[at + 1]));
}
