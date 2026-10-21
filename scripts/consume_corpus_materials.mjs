import path from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir, open, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { prepareSpecialistCandidateBatch } from './prepare_specialist_candidate_batch.mjs';
import { selectMaterials } from './material_selection.mjs';
import { makeRuntime } from './run_corpus_batch.mjs';
import { verifySemanticSourceInputs } from './semantic_recall_evidence.mjs';
import {validSpecialistDevice,specialistModelEnvironment} from './specialist_cache_identity.mjs';

const execute = promisify(execFile), scripts = path.dirname(fileURLToPath(import.meta.url));
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireRecoveredCaseScope(document, task, source) {
  const sourceCase = source.cases?.find(row => row.case_id === task.case_id);
  const episode = source.episodes?.find(row => row.episode_id === sourceCase?.episode_id);
  const work = source.works?.find(row => row.work_id === episode?.work_id);
  const step = sourceCase?.development_preset?.steps?.find(row => row.step_id === task.step_id);
  const event = sourceCase?.source_events?.find(row => row.event_id === task.source_event_id);
  const videoSha = episode?.source_video?.sha256;
  if (!work || work.split !== 'research' || source.works.some(row => row.split !== 'research')
    || !/^[a-f0-9]{64}$/.test(videoSha ?? '') || sourceCase.evidence?.source_video_sha256 !== videoSha
    || !document.source_files?.some(row => row.sha256 === videoSha)
    || !step || step.source_event_id !== task.source_event_id || !event
    || !isDeepStrictEqual(event, task.reference_event))
    throw new Error('material_candidate_case_input_scope_mismatch');
}

export function requireSuccessfulSpecialistReceipt(receipt, expectedJobs, expectedModel='cpu') {
  const expectedDevice=typeof expectedModel==='string'?expectedModel:expectedModel.device;
  if (!Number.isSafeInteger(expectedJobs) || expectedJobs < 1 || expectedJobs > 10
    || !validSpecialistDevice(expectedDevice)||receipt.status !== 'completed_unqualified'
    ||receipt.device !== expectedDevice
    || receipt.jobs?.length !== expectedJobs || receipt.completed_jobs !== expectedJobs
    || receipt.jobs.some(job => job.status !== 'predicted' || !(job.forward_calls > 0)))
    throw new Error('actual_complete_cpu_specialist_forward_required');
  if(typeof expectedModel==='object'&&(receipt.backend!==expectedModel.backend
    ||receipt.model_revision!==expectedModel.model_revision||receipt.model_sha256!==expectedModel.model_sha256))
    throw Error('actual_specialist_model_identity_changed');
  if (receipt.qualified !== false || receipt.artistic_approval !== false)
    throw new Error('research_receipt_required');
}

export function materialFailureStatus(error) {
  const value = String(error.code ?? error.message);
  return /codex_cli_authorization|authorization_paused|quota/.test(value) ? 'account_wait' : 'gap';
}

export async function candidateMaterialLibrary(document, baseDatabase, executionHistory = []) {
  if (document.frozen_library_binding) {
    if (document.material_library || document.semantic_recall_receipt || !document.recording_role_manifest
      || !baseDatabase || path.resolve(document.frozen_library_binding.path ?? '') !== path.resolve(baseDatabase))
      throw new Error('bridge_frozen_library_runtime_scope_mismatch');
    await verifyEvidenceBindings(document.frozen_library_binding);
    return document.frozen_library_binding;
  }
  if (!document.material_library && !document.semantic_recall_receipt) return { path: baseDatabase };
  if (!document.material_library?.path || !/^[a-f0-9]{64}$/.test(document.material_library.sha256 ?? '')
    || !document.semantic_recall_receipt?.path || !/^[a-f0-9]{64}$/.test(document.semantic_recall_receipt.sha256 ?? ''))
    throw new Error('semantic_candidate_library_binding_required');
  await verifyEvidenceBindings([document.material_library, document.semantic_recall_receipt]);
  const receipt = await readJson(document.semantic_recall_receipt.path);
  if (receipt.status !== 'semantic_recall_complete_not_listened' || receipt.backend !== 'local_clap_text_audio_retrieval'
    || receipt.device !== 'cpu' || receipt.expansion_limit !== 50
    || !(receipt.text_embedding_forward_calls > 0 || receipt.text_embedding_forward_calls === 0 && receipt.invalid_query_handling === 'task_gap')
    || receipt.artistic_approval !== false || receipt.production_approval !== false
    || !baseDatabase || path.resolve(document.material_library.path) === path.resolve(baseDatabase)
    || receipt.library?.sha256 !== document.material_library.sha256
    || path.resolve(receipt.library?.path ?? '') !== path.resolve(document.material_library.path)
    || [receipt.expanded_tasks, receipt.index_manifest, receipt.index_vectors,
      ...['task_file', 'case_input', 'library_db', 'execution_script'].map(key => receipt.source_inputs?.[key])]
      .some(row => !row?.path || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
    || !Array.isArray(receipt.query_evidence) || !receipt.query_evidence.length
    || !document.case_input?.sha256 || receipt.source_inputs?.case_input?.sha256 !== document.case_input.sha256)
    throw new Error('semantic_candidate_library_receipt_mismatch');
  const historicalProofs = await verifySemanticSourceInputs(document.semantic_recall_receipt, receipt, executionHistory);
  await verifyEvidenceBindings([receipt.expanded_tasks, receipt.query_evidence, receipt.index_manifest, receipt.index_vectors]);
  if (receipt.text_embedding_forward_calls === 0 && (await Promise.all(receipt.query_evidence.map(row => readJson(row.path))))
    .some(row => !['empty_music_text_requires_explicit_positive_description', 'negated_music_text_requires_explicit_structured_filters'].includes(row.semantic_gap)
      || row.actual_text_embedding_processed !== false || row.text_embedding_forward_calls !== 0 || row.attempts?.length !== 0))
    throw new Error('semantic_zero_forward_requires_explicit_query_gaps');
  return historicalProofs.length ? { ...document.material_library, historical_execution_proofs: historicalProofs } : document.material_library;
}

// New bridge sidecars are identity provenance, never a listening/selection shortcut.
// Ordinary historical candidates keep their existing behavior without this sidecar.
export async function recordingRoleProvenance(encoded, index) {
  const document = expandCandidateEvidence(encoded), task = document.tasks?.[index];
  const bridged = task?.candidates?.some(row => row.bridge_recording_role);
  if (!document.recording_role_manifest && !bridged) return null;
  if (!document.recording_role_manifest || !task) throw new Error('bridge_recording_role_manifest_required');
  await verifyEvidenceBindings(document.recording_role_manifest);
  const manifest = await readJson(document.recording_role_manifest.path);
  if (manifest.schema_version !== 1 || manifest.status !== 'research_pending' || manifest.qualification_granted !== false)
    throw new Error('bridge_recording_role_research_scope_required');
  const windows = [];
  for (const candidate of task.candidates ?? []) {
    const pointer = candidate.candidate, role = manifest.segment_roles?.[pointer.segment_id];
    const declared = candidate.bridge_recording_role;
    const music = candidate.binding?.music?.find(row => row.segment_id === pointer.segment_id);
    if (!role || !declared || !isDeepStrictEqual(role, declared) || role.case_id !== task.case_id
      || role.source_event_id !== task.source_event_id || role.source_sha256 !== pointer.source_sha256
      || role.asset_id !== pointer.asset_id || role.Ready !== false || role.listening_verified !== false
      || candidate.listening_verified !== false || !music || music.recording_origin_role !== role.recording_origin_role
      || !['reference_original', 'reviewed_auxiliary', 'research_auxiliary'].includes(role.recording_origin_role)
      || !(role.source_start_seconds <= pointer.source_range?.[0] && pointer.source_range[0] < pointer.source_range[1]
        && pointer.source_range[1] <= role.source_end_seconds)
      || role.recording_origin_role === 'reference_original' && music.source_relation !== 'fingerprint_candidate')
      throw new Error('bridge_recording_role_candidate_scope_mismatch');
    await verifyEvidenceBindings([role.recording_identity_evidence, role.decode_receipt, role.extent_evidence].filter(Boolean));
    windows.push({ segment_id: pointer.segment_id, source_sha256: pointer.source_sha256,
      actual_observation_source_range: pointer.source_range, recording_origin_role: role.recording_origin_role,
      reference_occurrence_range: role.reference_occurrence_range, recording_extent: role.recording_extent,
      full_song_acquired: role.full_song_acquired, identity_evidence: role.recording_identity_evidence,
      source_relation: music.source_relation, listening_verified: false });
  }
  return { schema_version: 1, manifest: document.recording_role_manifest, case_id: task.case_id,
    step_id: task.step_id, source_event_id: task.source_event_id, windows,
    status: 'research_identity_provenance_preserved', qualification_granted: false,
    original_recording_identity_is_not_listening_approval: true, Ready: false };
}

export async function recoverMaterialTask(item, recovery, archive, local) {
  if (item?.recovery_history?.some(row => row.recovery_id === recovery.recovery_id)) return false;
  const kind = recovery.kind ?? 'acoustics';
  const sourceInputRecovery = kind === 'source_case_input_preparation';
  const preparationRecovery = ['empty_recall_preparation', 'invalid_source_window_preparation', 'source_case_input_preparation'].includes(kind);
  const expectedStage = preparationRecovery ? 'preparation' : kind === 'acoustics' ? 'acoustics' : 'selection';
  const expectedGap = sourceInputRecovery ? 'actual_source_case_input_missing'
    : kind === 'empty_recall_preparation' ? 'initial_batch_requires_one_to_ten_distinct_windows'
    : kind === 'invalid_source_window_preparation' ? 'prepared_samples_do_not_cover_candidate_range'
      : kind === 'selection_capacity' ? 'codex_cli_single_item_exceeds_input_budget'
        : kind === 'selection_runtime_executable' ? 'codex_cli_failed' : 1;
  if (!['acoustics', 'selection_capacity', 'selection_windows_path', 'selection_runtime_executable', 'empty_recall_preparation', 'invalid_source_window_preparation', 'source_case_input_preparation'].includes(kind) || !item || item.status !== 'gap'
    || item.stage !== expectedStage || item.gap !== expectedGap
    || item.failure_receipt?.path !== recovery.previous_failure.path
    || item.failure_receipt.sha256 !== recovery.previous_failure.sha256
    || await hashFile(recovery.previous_failure.path) !== recovery.previous_failure.sha256
    || !recovery.reason?.trim() || !/^[a-z0-9_-]+$/.test(recovery.recovery_id))
    throw new Error('explicit_material_recovery_binding_required');
  const failure = await readJson(recovery.previous_failure.path);
  if (failure.stage !== expectedStage || failure.error_code !== expectedGap)
    throw new Error('material_recovery_failure_evidence_mismatch');
  if (kind === 'selection_windows_path' && (!failure.subprocess_traceback?.some(line => line.includes('WinError 206'))
    || !failure.subprocess_traceback.some(line => line.includes('prepare_director_contact_sheets.py'))))
    throw new Error('actual_contact_sheet_windows_path_failure_required');
  if (kind === 'selection_runtime_executable') {
    if (path.resolve(failure.original_execution_receipt ?? '') !== path.resolve(recovery.previous_cli_receipt?.path ?? '')
      || !recovery.executable_binding?.path) throw new Error('actual_missing_selector_executable_proof_required');
    await verifyEvidenceBindings([recovery.previous_cli_receipt, recovery.executable_binding]);
    const execution = await readJson(recovery.previous_cli_receipt.path);
    if (execution.status !== 'failed' || execution.exit_code !== -4058 || !path.isAbsolute(execution.command ?? '')
      || path.resolve(execution.command) === path.resolve(recovery.executable_binding.path))
      throw new Error('actual_missing_selector_executable_proof_required');
    try { await stat(execution.command); throw new Error('prior_selector_executable_still_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (preparationRecovery) {
    if (recovery.expected_stage !== expectedStage || recovery.expected_gap !== expectedGap
      || !recovery.candidate?.path || !recovery.case_input?.path
      || !/^[a-f0-9]{64}$/.test(recovery.candidate.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(recovery.case_input.sha256 ?? '')
      || item.candidate?.sha256 !== recovery.candidate.sha256 || failure.candidate?.sha256 !== recovery.candidate.sha256
      || path.resolve(item.candidate.path) !== path.resolve(recovery.candidate.path)
      || path.resolve(failure.candidate.path) !== path.resolve(recovery.candidate.path)
      || (sourceInputRecovery ? failure.case_input != null
        : path.resolve(failure.case_input) !== path.resolve(recovery.case_input.path)))
      throw new Error('explicit_preparation_recovery_identity_required');
    await verifyEvidenceBindings([recovery.candidate, recovery.case_input]);
    const candidates = await readJson(recovery.candidate.path), cases = await readJson(recovery.case_input.path);
    const task = candidates.tasks?.[item.task_index];
    if (!task || task.case_id !== item.case_id || !cases.cases?.some(row => row.case_id === item.case_id)
      || kind === 'empty_recall_preparation' && (!Array.isArray(task.candidates) || task.candidates.length !== 0))
      throw new Error('preparation_recovery_task_scope_mismatch');
    if (sourceInputRecovery) {
      if (shaBytes(JSON.stringify([recovery.candidate.sha256, item.task_index, task.case_id, task.step_id])) !== recovery.key)
        throw new Error('preparation_recovery_task_scope_mismatch');
      const references = Object.entries(candidates.evidence_table ?? {}).filter(([id, reference]) =>
        candidates.evidence_refs?.includes(id) && path.basename(reference?.path ?? '') === 'case-import.json').map(([, reference]) => reference);
      if (!references.some(reference => reference.sha256 === recovery.case_input.sha256
        && path.resolve(reference.path) === path.resolve(recovery.case_input.path)))
        throw new Error('candidate_bound_actual_case_input_required');
      const matching = [];
      for (const reference of references) {
        await verifyEvidenceBindings(reference);
        if ((await readJson(reference.path)).cases?.some(row => row.case_id === task.case_id)) matching.push(reference.sha256);
      }
      if (new Set(matching).size > 1) throw new Error('material_candidate_case_input_ambiguous');
      requireRecoveredCaseScope(candidates, task, cases);
    }
    if (kind === 'invalid_source_window_preparation') {
      if (!recovery.preparation_record?.path || !recovery.preparation_record.sha256)
        throw new Error('new_bound_preparation_record_required');
      await verifyEvidenceBindings(recovery.preparation_record);
      const preparation = await readJson(recovery.preparation_record.path), namespace = path.dirname(path.resolve(recovery.preparation_record.path));
      const within = file => { const relative = path.relative(namespace, path.resolve(file)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
      if (path.resolve(recovery.preparation_record.path) === path.join(archive, recovery.key, 'observation', 'preparation-record.json')
        || path.resolve(preparation.original_candidate?.path ?? '') !== path.join(archive, recovery.key, 'derived-candidates.json')
        || preparation.case_input?.sha256 !== recovery.case_input.sha256
        || path.resolve(preparation.case_input?.path ?? '') !== path.resolve(recovery.case_input.path)
        || !preparation.jobs?.length || preparation.jobs.length > 10 || preparation.jobs.some(job => !within(job.input_file))
        || !preparation.configs?.length || preparation.qualified !== false || preparation.artistic_approval !== false)
        throw new Error('new_preparation_namespace_and_source_identity_required');
      await verifyEvidenceBindings([preparation.original_candidate, preparation.case_input, preparation.candidate_file, preparation.configs]);
      const derived = await readJson(preparation.original_candidate.path);
      if (derived.observation_scope?.original_candidate?.sha256 !== recovery.candidate.sha256
        || path.resolve(derived.observation_scope?.original_candidate?.path ?? '') !== path.resolve(recovery.candidate.path)
        || derived.observation_scope?.original_task_index !== item.task_index || derived.tasks?.[0]?.case_id !== item.case_id)
        throw new Error('prepared_original_candidate_lineage_mismatch');
      for (const reference of preparation.configs) {
        const model = await readJson(reference.path);
        if (!within(model.output_dir) || JSON.stringify(model.jobs) !== JSON.stringify(preparation.jobs))
          throw new Error('new_preparation_model_namespace_required');
      }
    }
  }
  item.recovery_history ??= [];
  item.recovery_history.push({ recovery_id: recovery.recovery_id, kind, previous_failure: recovery.previous_failure,
    previous_status: item.status, previous_stage: item.stage, previous_gap: item.gap,
    ...(preparationRecovery ? { candidate: recovery.candidate, case_input: recovery.case_input,
      ...(recovery.preparation_record ? { preparation_record: recovery.preparation_record } : {}) } : {}),
    ...(kind === 'selection_runtime_executable' ? { previous_cli_receipt: recovery.previous_cli_receipt,
      executable_binding: recovery.executable_binding } : {}),
    reason: recovery.reason, started_at: new Date().toISOString() });
  if (kind === 'acoustics') {
    item.acoustic_directory = path.join(archive, recovery.key, 'acoustics-' + recovery.recovery_id);
    item.acoustic_config = path.join(local, recovery.key, 'acoustics-' + recovery.recovery_id + '.json');
  } else if (preparationRecovery) {
    if (recovery.preparation_record) item.preparation_record = recovery.preparation_record;
  } else {
    item.selection_history ??= [];
    item.selection_history.push({ directory: item.selection_directory ?? path.join(archive, recovery.key, 'selection'),
      failure_receipt: recovery.previous_failure, recovery: recovery.recovery_id });
    item.selection_directory = path.join(archive, 'select', recovery.key, recovery.recovery_id);
  }
  item.status = 'running'; item.gap = null;
  return true;
}

export function boundedTaskDocument(document, index, parent) {
  const result = expandCandidateEvidence(document), task = result.tasks[index];
  result.tasks = [task];
  for (const item of task.candidates ?? []) {
    const previous = structuredClone(item.candidate);
    const range = [previous.source_range[0], Math.min(previous.source_range[1], previous.source_range[0] + 25)];
    const candidate_window_id = 'actual-audition-' + shaBytes(JSON.stringify([previous.source_sha256, range])).slice(0, 24);
    item.candidate = { ...previous, source_range: range, phase: 'unknown', candidate_window_id };
    for (const kind of ['music', 'sounds']) for (const member of item.binding[kind] ?? [])
      Object.assign(member, { source_range: range, phase: 'unknown', candidate_window_id });
    item.derived_source_window_lineage = { parent_candidate: parent, parent_pointer: previous,
      candidate_window_id, source_window: range, parent_library_segment_id: previous.segment_id,
      source_identity_changed: false, scope: 'bounded actual audition; no whole-recording or phrase verification' };
  }
  result.observation_scope = { original_candidate: parent, original_task_index: index,
    actual_window_limit_seconds: 25, no_silence_padding: true, qualified: false };
  return result;
}

async function directories(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => path.join(root, row.name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}

export async function discoverMaterialTasks(config, cache = new Map()) {
  const cached = async file => {
    const details = await stat(file), stamp = `${details.size}:${details.mtimeMs}`;
    const prior = cache.get(file);
    if (prior?.stamp === stamp) return prior;
    const value = { stamp, document: await readJson(file), binding: await bound(file) };
    cache.set(file, value); return value;
  };
  const cases = new Map(), result = [];
  for (const work of await directories(path.join(config.discovery_root, 'research'))) {
    for (const episode of await directories(work)) {
      const file = path.join(episode, 'distillation', 'case-import.json');
      try { for (const item of (await cached(file)).document.cases ?? []) cases.set(item.case_id, file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const work of await directories(path.join(config.discovery_root, 'work-results'))) {
    for (const version of await directories(work)) {
      for (const report of await directories(path.join(version, 'corpus', 'material-candidates'))) {
        const file = path.join(report, 'candidate-bindings.json');
        let entry;
        try { entry = await cached(file); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
        const { binding, document } = entry;
        let explicitCaseInput;
        const boundCaseInputs = [];
        if (document.case_input) {
          const source = await cached(document.case_input.path);
          if (source.binding.sha256 !== document.case_input.sha256)
            throw new Error('material_candidate_case_input_changed');
          if (source.document.works?.some(row => row.split !== 'research')
            || (document.tasks ?? []).some(task => !source.document.cases?.some(row => row.case_id === task.case_id)))
            throw new Error('material_candidate_case_input_scope_mismatch');
          explicitCaseInput = document.case_input.path;
        } else {
          for (const [id, reference] of Object.entries(document.evidence_table ?? {})) {
            if (!document.evidence_refs?.includes(id) || path.basename(reference?.path ?? '') !== 'case-import.json') continue;
            await verifyEvidenceBindings(reference);
            const source = await cached(reference.path);
            if (source.binding.sha256 !== reference.sha256)
              throw new Error('material_candidate_case_input_changed');
            boundCaseInputs.push({ reference, source });
          }
        }
        for (const [index, task] of (document.tasks ?? []).entries()) {
          const matches = boundCaseInputs.filter(row => row.source.document.cases?.some(item => item.case_id === task.case_id));
          if (boundCaseInputs.length && !matches.length)
            throw new Error('material_candidate_case_input_scope_mismatch');
          if (new Set(matches.map(row => row.reference.sha256)).size > 1)
            throw new Error('material_candidate_case_input_ambiguous');
          const recovered = matches[0];
          const caseInput = explicitCaseInput ?? recovered?.reference.path ?? cases.get(task.case_id);
          const source = caseInput ? (await cached(caseInput)).document : null;
          const sourceCase = source?.cases?.find(row => row.case_id === task.case_id);
          const sourceEpisode = source?.episodes?.find(row => row.episode_id === sourceCase?.episode_id);
          if (recovered) requireRecoveredCaseScope(document, task, source);
          const key = shaBytes(JSON.stringify([binding.sha256, index, task.case_id, task.step_id]));
          result.push({ key, file, binding, document, index, caseInput,
            ...(recovered ? { caseInputBinding: recovered.reference, caseInputOrigin: 'candidate_evidence_table' } : {}),
            episodeId: sourceCase?.episode_id ?? null, workId: sourceEpisode?.work_id ?? null });
        }
      }
    }
  }
  return result;
}

export function nextMaterialTask(discovered, state, prepared = []) {
  const pending = discovered.filter(row => !state.tasks[row.key]?.status
    || ['running', 'account_wait'].includes(state.tasks[row.key].status));
  if (!pending.length) return null;
  state.scheduler ??= { revision: 'task-boundary-work-episode-v1', last_work_id: null, last_episode_ids: {} };
  const next = (values, previous) => values.sort().find(value => value > (previous ?? '')) ?? values[0];
  const workKey = row => row.workId ?? row.file, episodeKey = row => row.episodeId ?? row.caseInput ?? row.file;
  const work = next([...new Set(pending.map(workKey))], state.scheduler.last_work_id);
  const workTasks = pending.filter(row => workKey(row) === work);
  const episode = next([...new Set(workTasks.map(episodeKey))], state.scheduler.last_episode_ids[work]);
  const episodeTasks = workTasks.filter(row => episodeKey(row) === episode);
  const selected = episodeTasks.find(row => prepared.some(item => item.key === row.key)) ?? episodeTasks[0];
  state.scheduler.last_work_id = work; state.scheduler.last_episode_ids[work] = episode;
  return selected;
}

export async function consumeCorpusMaterials(config, runtime = {}) {
  const root = path.resolve(config.state_directory), archive = path.resolve(config.archive_directory);
  await mkdir(root, { recursive: true }); await mkdir(archive, { recursive: true });
  const lockFile = path.join(root, 'consumer.lock'), lock = await open(lockFile, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const stateFile = path.join(root, 'consumer-state.json');
  let state;
  try { state = await readJson(stateFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { schema_version: 1, tasks: {}, qualified_packs: 0, formal_adoption_allowed: false };
  const save = async () => { await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2)); await rename(stateFile + '.tmp', stateFile); };
  const command = runtime.execute ?? execute;
  const python = async (script, args, specialist = false, model={device:'cpu'}) => command(specialist ? config.specialist_python
    : script === 'candidate_acoustic_features.py' ? config.acoustic_python : config.python,
    [path.join(scripts, script), ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env:specialistModelEnvironment(model,config.specialist_environment) });
  try {
    for (const recovery of config.recovery_operations ?? []) {
      if (recovery.kind === 'selection_runtime_executable'
        && path.resolve(config.runtime_config?.cli?.codexPath ?? '') !== path.resolve(recovery.executable_binding?.path ?? ''))
        throw new Error('selector_recovery_config_executable_mismatch');
      await recoverMaterialTask(state.tasks[recovery.key], recovery, archive, root);
    }
    state.status = 'running'; state.pid = process.pid; await save();
    const discoveryCache = new Map();
    do {
      if (config.stop_request_file) {
        try { await readFile(config.stop_request_file); state.status = 'drained'; await save(); return state; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const discovered = await (runtime.discoverMaterialTasks ?? discoverMaterialTasks)(config, discoveryCache);
      state.discovered_tasks = discovered.length; state.last_scan_at = new Date().toISOString(); await save();
      const selected = nextMaterialTask(discovered, state, config.prepared_tasks);
      // Rediscover after one actual task closes; a long old snapshot cannot starve new episodes.
      for (const entry of selected ? [selected] : []) {
        if (config.stop_request_file) {
          try { await readFile(config.stop_request_file); state.status = 'drained'; await save(); return state; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const item = state.tasks[entry.key] ??= { candidate: entry.binding, task_index: entry.index,
          case_id: entry.document.tasks[entry.index].case_id, started_at: new Date().toISOString() };
        item.scheduling_group = { work_id: entry.workId ?? null, episode_id: entry.episodeId ?? null };
        item.status = 'running'; item.stage = 'preparation'; await save();
        const out = path.join(archive, entry.key), local = path.join(root, entry.key);
        const defaultSelectionDirectory = path.join(archive, 'select', entry.key, 'base');
        await mkdir(out, { recursive: true }); await mkdir(local, { recursive: true });
        try {
          if (!entry.caseInput) throw new Error('actual_source_case_input_missing');
          const materialLibrary = await candidateMaterialLibrary(entry.document, config.library_db, config.semantic_execution_history);
          item.material_library = materialLibrary;
          const recordingRoles = await recordingRoleProvenance(entry.document, entry.index);
          if (recordingRoles) {
            const roleFile = path.join(out, 'recording-role-provenance.json');
            try { await readFile(roleFile); } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await json(roleFile, { ...recordingRoles, candidate_source: entry.binding, material_library: materialLibrary });
            }
            item.recording_role_manifest = recordingRoles.manifest;
            item.recording_role_provenance = await bound(roleFile);
            item.recording_roles_grant_listening_approval = false;
            await save();
          }
          const derived = path.join(out, 'derived-candidates.json');
          try { await readFile(derived); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await json(derived, boundedTaskDocument(entry.document, entry.index, entry.binding));
          }
          const recalledDocument = await readJson(derived), recalled = recalledDocument.tasks?.[0];
          if (Array.isArray(recalled?.candidates) && recalled.candidates.length === 0) {
            await verifyEvidenceBindings([entry.binding]);
            const gapFile = path.join(out, `retrieval-gap-${randomUUID()}.json`);
            await json(gapFile, { schema_version: 1, status: 'selection_gap', gap: 'no_retrieved_material_candidates',
              candidate: entry.binding, derived_candidate: await bound(derived), case_input: await bound(entry.caseInput),
              original_task_index: entry.index, case_id: recalled.case_id, step_id: recalled.step_id,
              retrieval_attempts: recalled.attempts ?? [], retrieval_gaps: recalled.gaps ?? [],
              retrieval_report: recalledDocument.retrieval_report ?? null,
              selected_count: 0, automatic_selection_performed: false, actual_audio_processed: false,
              model_calls: 0, render_calls: 0, formal_adoption_allowed: false });
            item.retrieval_gap_record = await bound(gapFile); item.selected_count = 0;
            item.status = 'selection_gap'; item.stage = 'selection'; item.gap = 'no_retrieved_material_candidates';
            item.formal_adoption_allowed = false; item.finished_at = new Date().toISOString(); await save(); continue;
          }
          const prepared = config.prepared_tasks?.find(row => row.key === entry.key);
          if (item.preparation_record && prepared && path.resolve(prepared.preparation_record) !== path.resolve(item.preparation_record.path))
            throw new Error('prepared_recovery_record_conflict');
          const prepFile = item.preparation_record?.path ?? prepared?.preparation_record ?? path.join(out, 'observation', 'preparation-record.json');
          let preparation;
          try { preparation = await readJson(prepFile); } catch (error) {
            if (error.code !== 'ENOENT' || item.preparation_record) throw error;
            preparation = await prepareSpecialistCandidateBatch({ candidate_file: derived, case_input: entry.caseInput,
              task_indices: [0], output_dir: path.join(out, 'observation'), config_dir: path.join(local, 'configs'),
              model_configs: config.cpu_model_configs,
              ...(config.reuse_preparation_record ? { reuse_preparation_record: config.reuse_preparation_record } : {}),
              ...(config.reuse_acoustic_receipts ? { reuse_acoustic_receipts: config.reuse_acoustic_receipts } : {}) });
            preparation = await readJson(preparation.path);
          }
          if (item.preparation_record) await verifyEvidenceBindings([item.preparation_record, preparation.original_candidate,
            preparation.case_input, preparation.candidate_file, preparation.configs]);
          if (preparation.case_input.sha256 !== await hashFile(entry.caseInput)) throw new Error('prepared_case_input_changed');
          if (prepared && prepared.original_candidate_sha256 !== entry.binding.sha256) throw new Error('prepared_candidate_input_changed');
          if (recordingRoles) {
            const retained = await recordingRoleProvenance(await readJson(preparation.candidate_file.path), 0);
            if (retained?.manifest.sha256 !== recordingRoles.manifest.sha256)
              throw new Error('bridge_recording_role_lost_during_preparation');
            item.recording_roles_preserved_through_observation = true;
            await save();
          }
          const receipts = [...(preparation.reused_receipts ?? [])];
          await verifyEvidenceBindings(receipts);
          for (const reference of preparation.configs) {
            const model = await readJson(reference.path);
            if (!validSpecialistDevice(model.device)) throw new Error('specialist_model_config_required');
            item.stage = model.backend; await save();
            const file = path.join(model.output_dir, 'receipt.json');
            try { await readFile(file); } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await python('specialist_audio_observer.py', ['--config', reference.path], true,model);
            }
            requireSuccessfulSpecialistReceipt(await readJson(file), model.jobs.length,model);
            receipts.push(await bound(file));
          }
          const acousticDirectory = item.acoustic_directory ?? path.join(out, 'acoustics'), acousticReceipt = path.join(acousticDirectory, 'receipt.json');
          const acousticConfig = item.acoustic_config ?? path.join(local, 'acoustics-config.json');
          item.stage = 'acoustics'; await save();
          try { await readFile(acousticReceipt); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            try { await readFile(acousticConfig); } catch (configError) {
              if (configError.code !== 'ENOENT') throw configError;
              await json(acousticConfig, { ...config.acoustic_model, output_dir: acousticDirectory,
                jobs: preparation.acoustic_jobs ?? preparation.jobs });
            }
            await python('candidate_acoustic_features.py', ['--config', acousticConfig]);
          }
          const acoustic = await readJson(acousticReceipt);
          if (acoustic.status !== 'completed_unqualified' || acoustic.jobs.length !== (preparation.acoustic_jobs ?? preparation.jobs).length
            || acoustic.jobs.some(job => job.status !== 'measured' || !(job.forward_calls > 0)))
            throw new Error('actual_complete_cpu_acoustic_forward_required');
          item.actual_observation_receipts = receipts; item.stage = 'selection'; await save();
          const caseInput = await readJson(entry.caseInput);
          const session = await makeRuntime({ ...config.runtime_config, material_observer_kind: 'specialist_receipts',
            material_observation_receipts: receipts, material_acoustic_receipts: [
              ...(preparation.reused_acoustic_receipts ?? []), await bound(acousticReceipt)] }, { stateDirectory: path.join(local, 'cli'),
            archiveDirectory: path.join(out, 'cli'), mediaBindings: caseInput.episodes.map(row => row.source_video) }, {});
          if (item.account_wait_at) {
            item.selection_history ??= [];
            item.selection_history.push({ directory: item.selection_directory ?? defaultSelectionDirectory,
              stopped_at: item.account_wait_at, failure_receipt: item.failure_receipt,
              recovery: 'new actual authentication probe; preserve known authorization failure and start explicit new selection namespace' });
            delete item.account_wait_at;
            item.selection_directory = path.join(archive, 'select', entry.key, 'auth-' + item.selection_history.length);
            await save();
          }
          const selectionDir = item.selection_directory ?? defaultSelectionDirectory;
          const selectionFile = path.join(selectionDir, 'selection-record.json');
          let selection;
          try {
            selection = await readJson(selectionFile);
            if (selection.automatic_selection_performed !== true) throw new Error('partial_selection_requires_explicit_recovery');
            await verifyEvidenceBindings([selection.input, selection.candidate_source, selection.case_source,
              selection.raw_response, selection.observation_files, selection.visual_files, selection.cli_receipts]);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            selection = await selectMaterials({ candidate_file: preparation.candidate_file.path,
              input_file: entry.caseInput, output_dir: selectionDir }, session);
          }
          item.selection_record = await bound(selectionFile); item.selected_count = selection.selected_count;
          if (recordingRoles) {
            const selectedFile = path.join(selectionDir, 'selected-bindings.json');
            let selectedBindings = null;
            try { selectedBindings = await readJson(selectedFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const selectedMusic = (selectedBindings?.bindings ?? []).flatMap(row => row.music ?? []);
            for (const music of selectedMusic) {
              const role = recordingRoles.windows.find(row => row.segment_id === music.segment_id);
              if (!role || role.source_sha256 !== music.source_sha256 || role.recording_origin_role !== music.recording_origin_role
                || role.source_relation !== music.source_relation || music.status !== 'research')
                throw new Error('bridge_recording_role_lost_during_selection');
            }
            const traceFile = path.join(out, 'selection-recording-role-provenance.json');
            try { await readFile(traceFile); } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await json(traceFile, { schema_version: 1, status: 'research_selection_provenance_preserved',
                recording_role_provenance: item.recording_role_provenance, recording_role_manifest: recordingRoles.manifest,
                derived_candidate: await bound(derived), observation_candidates: preparation.candidate_file,
                specialist_receipts: receipts, acoustic_receipt: await bound(acousticReceipt),
                reused_acoustic_receipts: preparation.reused_acoustic_receipts ?? [],
                selection_record: item.selection_record, selected_bindings: selectedBindings ? await bound(selectedFile) : null,
                selected_music: selectedMusic.map(row => ({ segment_id: row.segment_id, source_sha256: row.source_sha256,
                  recording_origin_role: row.recording_origin_role, source_relation: row.source_relation, status: row.status })),
                selected_count: selection.selected_count, qualification_granted: false, Ready: false });
            }
            item.selection_recording_role_provenance = await bound(traceFile);
            item.recording_roles_preserved_through_selection = true;
          }
          item.stage = 'binding'; await save();
          const selected = path.join(selectionDir, 'selected-bindings.json');
          try { await readFile(selected); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            item.status = 'selection_gap'; item.gap = 'no_selected_material'; item.finished_at = new Date().toISOString(); await save(); continue;
          }
          const boundCase = path.join(out, 'bound-case-import.json');
          if (materialLibrary.sha256) await verifyEvidenceBindings(materialLibrary);
          try { await readFile(boundCase); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await python('corpus_materials.py', ['--input', entry.caseInput, '--bindings', selected,
              '--library-db', materialLibrary.path,
              ...(path.extname(materialLibrary.path).toLowerCase() === '.json' ? ['--library-sha256', materialLibrary.sha256] : []), '--output', boundCase]);
          }
          const db = path.join(local, 'cases.sqlite');
          await python('case_preset_store.py', ['init', '--db', db]);
          await python('case_preset_store.py', ['import', '--db', db, '--input', boundCase,
            '--out', path.join(local, 'import-report.json')]);
          item.status = 'research_bound'; item.bound_case = await bound(boundCase); item.case_db = db;
          item.formal_adoption_allowed = false; item.finished_at = new Date().toISOString(); await save();
          if (config.material_publication_config) {
            try {
              const result = await python('publish_material_bindings.py', ['--config', config.material_publication_config]);
              item.material_publication = JSON.parse(result.stdout);
            } catch (error) {
              item.material_publication_gap = error.code ?? error.message;
            }
            await save();
          }
        } catch (error) {
          const accountWait = materialFailureStatus(error) === 'account_wait';
          item.status = accountWait ? 'account_wait' : 'gap'; item.gap = error.code ?? error.message; item.finished_at = new Date().toISOString();
          const file = path.join(out, `failure-${Date.now()}-${randomUUID()}.json`);
          await json(file, { schema_version: 1, candidate: entry.binding, case_input: entry.caseInput,
            stage: item.stage, error_code: item.gap, original_execution_receipt: error.receipt_file ?? null,
            syscall: error.syscall ?? null, file_path: error.path && path.isAbsolute(error.path) ? error.path : null,
            stack_locations: String(error.stack ?? '').split('\n').filter(line => /^\s*at /.test(line)),
            subprocess_traceback: String(error.stderr ?? '').split('\n').filter(line => /^Traceback|^\s*File "|^[A-Za-z.]+Error:/.test(line)),
            formal_adoption_allowed: false, previous_evidence_preserved: true });
          item.failure_receipt = await bound(file); await save();
          if (accountWait) {
            item.account_wait_at = item.finished_at; state.status = 'account_wait'; await save(); return state;
          }
        }
      }
      if (selected) continue;
      state.status = config.continuous === false ? 'current_scan_finished_scope_incomplete' : 'waiting_for_new_material_tasks'; await save();
      if (config.continuous === false) break;
      await sleep(config.poll_ms ?? 30000);
    } while (true);
    return state;
  } finally { await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--config');
  if (at < 0) throw new Error('config_required');
  await consumeCorpusMaterials(await readJson(process.argv[at + 1]));
}
