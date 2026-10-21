import { execFile } from 'node:child_process';
import { copyFile, chmod, mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { hashFile } from './render_binding.mjs';
import { synthesizeRules } from './distill_rules.mjs';
import { selectMaterials } from './material_selection.mjs';
import { referenceMusicInputs, resolveReferenceMusic, referenceMusicRevision, validateReferenceMusicResult } from './resolve_reference_music.mjs';
import { verifyEvidenceBindings } from './audio_api.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
export const RULE_EVIDENCE_COMPILER_REVISION = 'windows-long-path-20261003-v1';
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const shaBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = async (file, value, atomic = true) => {
  if (!atomic) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); return; }
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
};

async function storeCommand(python, args) {
  try {
    const result = await execute(python, ['-X', 'utf8', path.join(here, 'case_preset_store.py'), ...args],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`case_store_${args[0]}_failed`, { cause: { code: error.code ?? 'invalid_response' } });
  }
}

async function materialCommand(python, args) {
  try {
    const result = await execute(python, ['-X', 'utf8', path.join(here, 'corpus_materials.py'), ...args],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error('corpus_material_binding_or_rule_compilation_failed', { cause: { code: error.code ?? 'invalid_response' } });
  }
}

async function ensureRuleIndex(python, sourceFile, indexFile, state) {
  const source = { path: sourceFile, sha256: await hashFile(sourceFile) };
  state.rule_indexes ??= {};
  const prior = state.rule_indexes[indexFile];
  if (prior?.source.sha256 === source.sha256 && await exists(indexFile)
    && await hashFile(indexFile) === prior.artifact.sha256) return prior.artifact;
  // Only rebuild the owned derived index, never replay model reasoning.
  const temporary = `${indexFile}.rebuild-${Date.now()}.sqlite`;
  const code = 'import sys,json,pathlib\n'
    + 'sys.path.insert(0,sys.argv[1]);import corpus_materials as m\n'
    + 'm.write_rule_index(sys.argv[3],json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8-sig")))\n';
  await execute(python, ['-X', 'utf8', '-c', code, here, sourceFile, temporary], { windowsHide: true });
  if (await hashFile(sourceFile) !== source.sha256) throw new Error('rule_index_source_changed_during_compile');
  await rename(temporary, indexFile);
  const artifact = { path: indexFile, sha256: await hashFile(indexFile) };
  state.rule_indexes[indexFile] = { source, artifact };
  return artifact;
}

export async function verifyMediaManifest(filename) {
  const document = await readJson(filename), base = path.dirname(path.resolve(filename));
  const rows = [];
  for (const entry of document.entries ?? []) {
    const mediaPath = entry.video ?? entry.path;
    const sourceHash = entry.source_video_sha256 ?? entry.sha256;
    const file = mediaPath ? path.resolve(base, mediaPath) : null;
    let valid = false, gap = null;
    try {
      valid = file !== null && /^[a-f0-9]{64}$/.test(sourceHash ?? '') && await hashFile(file) === sourceHash;
      if (!valid) gap = 'source_file_missing_or_hash_changed';
    } catch { gap = 'source_file_missing_or_hash_changed'; }
    let officialSeriesId = entry.official_series_id ?? null;
    if (!officialSeriesId && entry.official_url) {
      try {
        const url = new URL(entry.official_url);
        if (url.hostname === 'hongguoduanju.com') officialSeriesId = url.pathname.match(/^\/player\/(\d+)/)?.[1] ?? null;
      } catch { /* Unknown sources stay unknown. */ }
    }
    rows.push({ media_id: entry.media_id ?? null, work_id: entry.work_id ?? null, title: entry.title ?? null,
      episode_id: entry.episode_id ?? (entry.work_id && Number.isInteger(entry.episode_number) ? `${entry.work_id}/episode-${entry.episode_number}` : null),
      official_series_id: officialSeriesId,
      source_video: { path: file, sha256: sourceHash ?? null },
      episode_number: entry.episode_number ?? null, official_episode_count: entry.official_episode_count ?? null,
      split: entry.split ?? 'research', source_range: entry.source_range ?? null,
      source_version: entry.source_version ?? entry.version_type ?? 'unknown', official_source: entry.official_source ?? null,
      version_type: entry.version_type ?? 'unknown', duration_seconds: entry.duration_seconds ?? null,
      file_integrity_verified: valid, sound_observation_status: 'not_inferred_from_acquisition',
      full_series_complete: false, gap });
  }
  return rows;
}

export async function scheduleEpisodeInputs(config) {
  const inputs = [...(config.episode_inputs ?? [])], pending = [];
  const media = config.episode_manifest_file ? await verifyMediaManifest(config.episode_manifest_file) : [];
  const byId = new Map(inputs.map(input => [input.episode_id, input]));
  if (byId.size !== inputs.length) throw new Error('duplicate_corpus_episode_input');
  for (const row of media) {
    if (!row.work_id || !row.episode_id || !row.file_integrity_verified) {
      pending.push({ work_id: row.work_id, episode_id: row.episode_id, episode_number: row.episode_number,
        stage: 'episode_media_acquisition', status: 'pending', gap: row.gap ?? 'bound_episode_identity_required' });
      continue;
    }
    const input = { work_id: row.work_id, episode_id: row.episode_id, title: row.title, video: row.source_video.path,
      source_video_sha256: row.source_video.sha256, official_series_id: row.official_series_id,
      episode_number: row.episode_number, official_episode_count: row.official_episode_count,
      source_version: row.source_version, split: row.split, official_source: row.official_source,
      ...(row.source_range ? { source_range: row.source_range } : {}) };
    const previous = byId.get(input.episode_id);
    if (previous) {
      if (previous.work_id !== input.work_id || previous.video && path.resolve(previous.video) !== input.video
        || previous.source_video_sha256 && previous.source_video_sha256 !== input.source_video_sha256)
        throw new Error('ambiguous_scheduled_episode_identity');
      continue;
    }
    byId.set(input.episode_id, input); inputs.push(input);
  }
  return { inputs, media, pending };
}

async function evidenceBindingsValid(result) {
  const bindings = [], seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && typeof value.sha256 === 'string') bindings.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(result.artifact);
  visit(result.import_document);
  if (result.case_import_file) {
    if (!result.artifact || path.resolve(result.case_import_file) !== path.resolve(result.artifact.path)) return false;
    try { visit(await readJson(result.case_import_file)); } catch { return false; }
  }
  for (const binding of bindings) {
    const identity = `${binding.path}:${binding.sha256}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    try { if (await hashFile(binding.path) !== binding.sha256) return false; } catch { return false; }
  }
  return true;
}

// Imports explicit evidence through the store's gates and runs configured episode observations.
export async function distillCorpus(config, runtime = {}) {
  if (config.schema_version !== 1 || !config.output_dir) throw new Error('schema_version_1_and_output_dir_required');
  const storage = path.resolve(config.output_dir), output = path.resolve(config.artifact_dir ?? storage), python = config.python ?? 'python';
  const save = (file, value) => {
    const relative = path.relative(output, file);
    const outside = path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
    return writeJson(file, value, !config.artifact_dir || outside);
  };
  await mkdir(storage, { recursive: true });
  await mkdir(output, { recursive: true });
  const stateFile = path.join(storage, 'distill-state.json');
  const state = await exists(stateFile) ? await readJson(stateFile) : { schema_version: 1, imported: {} };
  if (state.artifact_dir && state.artifact_dir !== output) throw new Error('resume_research_storage_identity_changed');
  state.artifact_dir = output;
  let stateWrites = Promise.resolve();
  const saveState = () => { stateWrites = stateWrites.then(() => save(stateFile, state)); return stateWrites; };
  const database = path.resolve(config.cases_db ?? path.join(storage, 'cases.sqlite'));
  const relativeDatabase = path.relative(storage, database);
  if (relativeDatabase.startsWith('..') || path.isAbsolute(relativeDatabase)) throw new Error('case_snapshot_must_be_inside_new_output_directory');
  if (config.seed_cases_db && path.resolve(config.seed_cases_db) === database) throw new Error('new_case_snapshot_required');
  if (state.cases_db && state.cases_db !== database) throw new Error('resume_database_identity_changed');
  state.cases_db = database;
  const episodeOutput = path.resolve(config.episode_output_dir ?? path.join(output, 'episodes'));
  if (state.episode_output_dir && state.episode_output_dir !== episodeOutput) throw new Error('resume_research_storage_identity_changed');
  state.episode_output_dir = episodeOutput;
  await mkdir(path.dirname(database), { recursive: true });
  if (!await exists(database) && config.seed_cases_db) {
    state.seed_case_store = { path: path.resolve(config.seed_cases_db), sha256: await hashFile(config.seed_cases_db) };
    await copyFile(config.seed_cases_db, database);
    // Published snapshots may be readonly; change only the new owned copy.
    await chmod(database, 0o600);
  }
  await storeCommand(python, ['init', '--db', database]);
  const storedSources = await execute(python, ['-X', 'utf8', '-c',
    'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(list(c.execute("SELECT episode_id,source_sha256 FROM episodes")))); c.close()', database],
  { windowsHide: true, encoding: 'utf8' });
  const episodeSources = new Map(JSON.parse(storedSources.stdout));
  const importFiles = [config.case_import_file, ...(config.case_import_files ?? [])].filter(Boolean);
  const scheduled = await scheduleEpisodeInputs(config);
  const episodeResults = [];
  if (typeof runtime.observer === 'function' && !runtime.observer_backend_id?.trim()
    || typeof runtime.director === 'function' && !runtime.director_backend_id?.trim())
    throw new Error('research_runtime_backend_identity_required');
  state.episodes ??= {};
  const processEpisode = async input => {
    if (!input.work_id || !input.episode_id || (!input.video && !input.manifest)) throw new Error('bound_episode_identity_and_media_required');
    const identity = { work_id: input.work_id, episode_id: input.episode_id, split: input.split ?? config.split ?? 'research',
      official_series_id: input.official_series_id ?? config.official_series_id ?? null,
      identity_aliases: [...(input.identity_aliases ?? config.identity_aliases ?? [])].sort() };
    const identityHash = shaBytes(JSON.stringify(identity));
    for (const saved of Object.values(state.episodes)) {
      if (saved.episode_id === input.episode_id && saved.identity_hash && saved.identity_hash !== identityHash)
        throw new Error('corpus_episode_identity_changed');
    }
    const mediaHash = input.video ? await hashFile(input.video) : await hashFile(input.manifest);
    let expectedSourceHash = input.video ? mediaHash : null;
    if (input.manifest) {
      const prepared = await readJson(input.manifest), source = path.resolve(path.dirname(path.resolve(input.manifest)), prepared.source_video);
      const actual = await hashFile(source);
      if (actual !== prepared.source_sha256 || (expectedSourceHash && expectedSourceHash !== actual)) throw new Error('episode_manifest_source_binding_mismatch');
      expectedSourceHash = actual;
    }
    if (episodeSources.get(input.episode_id) && episodeSources.get(input.episode_id) !== expectedSourceHash
      || Object.values(state.episodes).some(saved => saved.episode_id === input.episode_id
        && saved.source_video_sha256 && saved.source_video_sha256 !== expectedSourceHash))
      throw new Error('corpus_episode_source_changed_requires_new_episode_version');
    const declaredSourceHash = input.source_video_sha256 ?? config.source_video_sha256;
    if (declaredSourceHash && declaredSourceHash !== expectedSourceHash) throw new Error('episode_declared_source_hash_mismatch');
    const qualification = input.qualification_file ?? input.qualification ?? config.qualification_file ?? config.qualification;
    const qualificationPath = typeof qualification === 'string' ? qualification : qualification?.path;
    const signature = shaBytes(JSON.stringify({ identity,
      video: input.video ?? null, manifest: input.manifest ?? null, media_hash: mediaHash, source_video_sha256: expectedSourceHash,
      source_range: input.source_range ?? null, source_version: input.source_version ?? null,
      official_source: input.official_source ?? config.official_source ?? null, title: input.title ?? config.title ?? null,
      mode: input.mode ?? config.mode ?? 'verified',
      audio_backend: input.audio_backend ?? config.audio_backend ?? null,
      runtime_backend: { observer: runtime.observer_backend_id ?? null, director: runtime.director_backend_id ?? null,
        observer_model_revision: runtime.observer_model_revision ?? null, director_model_revision: runtime.director_model_revision ?? null,
        observer_present: typeof runtime.observer === 'function', director_present: typeof runtime.director === 'function',
        model_bindings: input.model_bindings ?? config.model_bindings ?? null },
      budget: input.budget ?? config.budget ?? null,
      provider_presence: { openai: Boolean((runtime.environment ?? process.env).OPENAI_API_KEY),
        gemini: Boolean((runtime.environment ?? process.env).GEMINI_API_KEY) },
      qualification_hash: qualificationPath ? await hashFile(qualificationPath) : null,
      qualification_expected_hash: qualification?.sha256 ?? null }));
    let result, executed = false, stageBindingValid = true, cachedCoverageGap = false;
    // A changed budget or backend must not replay an unresolved external outcome.
    const unknownPrior = Object.values(state.episodes).find(saved => saved.episode_id === input.episode_id
      && saved.status === 'api_outcome_unknown'
      && (!saved.source_video_sha256 || saved.source_video_sha256 === expectedSourceHash));
    const prior = unknownPrior ?? state.episodes[signature];
    if (prior?.artifact && await exists(prior.artifact.path) && await hashFile(prior.artifact.path) === prior.artifact.sha256) {
      result = await readJson(prior.artifact.path);
      const coverage = result.coverage;
      cachedCoverageGap = ['research_processed', 'observed'].includes(result.status)
        && (coverage?.complete_processed === false || coverage?.missing_ranges?.length > 0 || coverage?.unclassified_ranges?.length > 0);
      if (cachedCoverageGap) result = { ...result, status: 'distillation_needs_review',
        error: 'cached_episode_coverage_incomplete', case_import_file: null, import_document: null,
        coverage: { ...coverage, sound_semantics_verified: false },
        gaps: [...new Set([...(result.gaps ?? []), 'cached_episode_coverage_incomplete'])] };
    } else if (prior) {
      stageBindingValid = false;
      result = { work_id: input.work_id, episode_id: input.episode_id, status: 'needs_media_evidence_repair',
        source_video_sha256: expectedSourceHash, actual_audio_processed: false, actual_video_processed: false,
        gaps: ['corpus_stage_artifact_missing_or_hash_changed'], counts: {} };
    }
    const resumable = result?.resume_supported === true && !unknownPrior && !cachedCoverageGap
      && ['prepared', 'needs_audio_backend', 'director_response_pending', 'distillation_needs_review'].includes(result.status)
      && !result.error?.includes('evidence_changed') && await evidenceBindingsValid(result);
    if (!prior || resumable) {
      const ownedPrior = Object.values(state.episodes).find(saved => saved.episode_id === input.episode_id
        && saved.source_video_sha256 === expectedSourceHash && saved.stage_dir && saved.resume_supported);
      const stageDir = ownedPrior?.stage_dir ?? path.join(episodeOutput, shaBytes(input.work_id).slice(0, 12),
        `${shaBytes(input.episode_id).slice(0, 12)}-${shaBytes(JSON.stringify([identity, expectedSourceHash])).slice(0, 12)}`);
      await mkdir(path.dirname(stageDir), { recursive: true });
      let distillEpisode = runtime.distillEpisode;
      if (!distillEpisode) {
        try { ({ distillEpisode } = await import('./distill_episode.mjs')); }
        catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
      }
      if (!distillEpisode) {
        result = { work_id: input.work_id, episode_id: input.episode_id, status: 'needs_audio_backend',
          actual_audio_processed: false, actual_video_processed: false, gaps: ['episode_distillation_module_unavailable'], counts: {} };
      } else {
        executed = true;
        result = await distillEpisode({ ...config, ...input, output_dir: stageDir,
          ...(config.artifact_dir ? { checkpoint_dir: path.join(storage, 'episode-checkpoints', shaBytes(input.episode_id).slice(0, 20)) } : {}),
          qualification_file: qualification }, runtime);
      }
      await mkdir(stageDir, { recursive: true });
      const resultDirectory = path.join(output, 'episode-results');
      await mkdir(resultDirectory, { recursive: true });
      const resultFile = path.join(resultDirectory, `${shaBytes(input.episode_id).slice(0, 12)}-${signature.slice(0, 12)}.json`);
      await save(resultFile, result);
      state.episodes[signature] = { work_id: input.work_id, episode_id: input.episode_id,
        identity_hash: identityHash, source_video_sha256: expectedSourceHash,
        stage_dir: stageDir, resume_supported: result.resume_supported === true,
        artifact: { path: resultFile, sha256: await hashFile(resultFile) }, status: result.status };
      await saveState();
    }
    if (result.source_video_sha256 && result.source_video_sha256 !== expectedSourceHash) throw new Error('episode_distillation_source_hash_mismatch');
    const currentlyValid = stageBindingValid && await evidenceBindingsValid(result);
    if (!currentlyValid) result = { ...result, status: 'needs_media_evidence_repair', case_import_file: null, import_document: null,
      actual_audio_processed: false, actual_video_processed: false,
      gaps: [...(result.gaps ?? []), 'cached_episode_evidence_missing_or_hash_changed'] };
    if (result.case_import_file) importFiles.push(result.case_import_file);
    else if (result.import_document) {
      const file = path.join(output, `episode-import-${signature.slice(0, 16)}.json`);
      await save(file, result.import_document);
      importFiles.push(file);
    }
    episodeResults.push({ work_id: input.work_id, episode_id: input.episode_id, status: result.status,
      source_video_sha256: result.source_video_sha256 ?? null, artifact: result.artifact ?? null,
      actual_audio_processed: result.actual_audio_processed === true,
      actual_video_processed: result.actual_video_processed === true, counts: result.counts ?? {}, gaps: result.gaps ?? [],
      coverage: result.coverage ?? null, runtime_calls: result.runtime_calls ?? 0,
      observation_calls_this_run: executed ? result.observation_calls_this_run ?? null : 0,
      director_calls_this_run: executed ? result.director_calls_this_run ?? null : 0,
      model_calls: result.model_calls ?? 0, cloud_uploads: result.cloud_uploads ?? 0,
      cli_model_calls: executed ? result.cli_model_calls ?? 0 : 0, cli_receipts: result.cli_receipts ?? [],
      executed_this_run: executed, evidence_binding_currently_valid: currentlyValid });
  };
  const concurrency = config.work_concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('work_concurrency_must_be_1_to_8');
  const workQueues = [...Map.groupBy(scheduled.inputs, input => input.work_id).values()];
  let nextWork = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, workQueues.length) }, async () => {
    for (;;) {
      const queue = workQueues[nextWork++];
      if (!queue) break;
      for (const input of queue) await processEpisode(input);
    }
  }));
  const inputOrder = new Map(scheduled.inputs.map((input, index) => [input.episode_id, index]));
  episodeResults.sort((a, b) => inputOrder.get(a.episode_id) - inputOrder.get(b.episode_id));
  const referenceMusicResults = [];
  state.reference_music ??= {};
  for (const input of config.reference_music_inputs ?? []) {
    let signature, attempt;
    try {
      const custom = typeof runtime.originalMusicResolver === 'function';
      if (custom && !(typeof runtime.originalMusicResolver_revision === 'string' && runtime.originalMusicResolver_revision.trim()))
        throw new Error('reference_music_custom_resolver_revision_required');
      const prepared = await referenceMusicInputs(input.input);
      signature = shaBytes(JSON.stringify({ inputs: prepared.signature, revision: referenceMusicRevision,
        resolver: custom ? runtime.originalMusicResolver_revision : 'local-explicit-recording-comparison', custom, python }));
      const prior = state.reference_music[signature];
      let result;
      if (prior?.status === 'failed' || prior?.status === 'running') {
        if (!input.recovery) {
          referenceMusicResults.push({ status: 'reference_music_lookup_gap', input: input.input,
            gap: prior.status === 'running' ? 'reference_music_interrupted_execution_needs_review' : prior.gap,
            failure: prior.failure, reused: true, production_approval: false, original_recording_identified: false,
            fallback_performed: false });
          continue;
        }
        if (prior.status !== 'failed' || prior.attempt !== 1 || !input.recovery.reason?.trim()
          || input.recovery.failure?.path !== prior.failure.path || input.recovery.failure?.sha256 !== prior.failure.sha256)
          throw new Error('reference_music_targeted_recovery_required');
        await verifyEvidenceBindings([prior.failure]);
      }
      if (prior?.artifact) {
        await verifyEvidenceBindings([prior.artifact, ...prepared.inputs]);
        result = await readJson(prior.artifact.path);
        await validateReferenceMusicResult(result, prepared, { custom });
        result = { ...result, artifact: prior.artifact, reused: true };
      } else {
        attempt = prior ? 2 : 1;
        const directory = path.join(output, 'reference-music', signature.slice(0, 20), `attempt-${attempt}`);
        state.reference_music[signature] = { status: 'running', attempt, directory,
          ...(prior ? { previous_failure: prior.failure, recovery_reason: input.recovery.reason } : {}) };
        await save(stateFile, state);
        const resolver = runtime.originalMusicResolver ?? resolveReferenceMusic;
        const returned = await resolver({ input_file: prepared.inputs[0].path, output_dir: directory, python });
        await verifyEvidenceBindings([returned.artifact, ...prepared.inputs]);
        result = await readJson(returned.artifact.path);
        await validateReferenceMusicResult(result, prepared, { custom });
        result = { ...result, artifact: returned.artifact };
        state.reference_music[signature] = { status: 'completed', attempt, artifact: result.artifact,
          ...(prior ? { previous_failure: prior.failure, recovery_reason: input.recovery.reason } : {}) };
        await save(stateFile, state);
      }
      referenceMusicResults.push(result);
    } catch (error) {
      const gap = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'reference_music_execution_or_evidence_error';
      let failure;
      if (signature && attempt) {
        const previous = state.reference_music[signature];
        const file = path.join(output, 'reference-music', signature.slice(0, 20), `attempt-${attempt}-failure.json`);
        await mkdir(path.dirname(file), { recursive: true });
        await save(file, { signature, attempt, gap, input: input.input,
          ...(previous.previous_failure ? { previous_failure: previous.previous_failure, recovery_reason: previous.recovery_reason } : {}) });
        failure = { path: file, sha256: await hashFile(file) };
        state.reference_music[signature] = { ...previous, status: 'failed', gap, failure };
        await save(stateFile, state);
      }
      referenceMusicResults.push({ status: 'reference_music_lookup_gap', input: input.input,
        gap, ...(failure ? { failure } : {}),
        production_approval: false, original_recording_identified: false, fallback_performed: false });
    }
  }
  const candidateResults = [], selectionResults = [], selectedBindingInputs = [];
  state.material_candidates ??= {};
  state.material_selections ??= {};
  for (const input of config.material_candidate_inputs ?? []) {
    if (!input.input || !input.tasks || !config.library_db) throw new Error('candidate_input_tasks_and_library_required');
    const signature = shaBytes(JSON.stringify({ input: await hashFile(input.input), tasks: await hashFile(input.tasks),
      library: await hashFile(config.library_db) }));
    const prior = state.material_candidates[signature], directory = path.join(output, 'material-candidates', signature.slice(0, 20));
    const artifact = path.join(directory, 'candidate-bindings.json');
    await mkdir(directory, { recursive: true });
    let result;
    if (prior) {
      const valid = await evidenceBindingsValid({ artifact: prior.artifact, case_import_file: prior.artifact.path });
      result = { ...prior, evidence_binding_currently_valid: valid,
        status: valid ? 'research_candidates_pending_comparison' : 'needs_material_evidence_repair' };
    } else {
      try {
        await materialCommand(python, ['--input', path.resolve(input.input), '--candidate-tasks', path.resolve(input.tasks),
          '--library-db', path.resolve(config.library_db), '--candidate-report', path.join(directory, 'retrieval-report.json'), '--output', artifact]);
        const candidates = await readJson(artifact);
        result = { status: candidates.status, artifact: { path: artifact, sha256: await hashFile(artifact) },
          task_count: candidates.tasks.length, candidate_count: candidates.tasks.reduce((sum, task) => sum + task.candidates.length, 0),
          gaps: [...candidates.gaps, ...candidates.tasks.flatMap(task => task.gaps.map(gap => ({ case_id: task.case_id, step_id: task.step_id, ...gap })))],
          evidence_binding_currently_valid: true, automatic_selection_performed: false };
        state.material_candidates[signature] = result;
        await save(stateFile, state);
      } catch {
        result = { status: 'material_candidate_retrieval_gap', task_count: 0, candidate_count: 0,
          evidence_binding_currently_valid: false, automatic_selection_performed: false,
          gaps: ['explicit_task_source_or_library_evidence_invalid'] };
      }
    }
    candidateResults.push(result);
    if (result.evidence_binding_currently_valid && (typeof runtime.materialSelector === 'function'
      || typeof runtime.materialObserver === 'function')) {
      const selectionSignature = shaBytes(JSON.stringify({ candidates: result.artifact.sha256,
        input: await hashFile(input.input), selector: runtime.materialSelector_backend_id ?? null,
        selector_revision: runtime.materialSelector_model_revision ?? null,
        observer: runtime.materialObserver_backend_id ?? null, observer_revision: runtime.materialObserver_model_revision ?? null,
        selector_present: typeof runtime.materialSelector === 'function', observer_present: typeof runtime.materialObserver === 'function' }));
      let selection = state.material_selections[selectionSignature];
      if (selection) {
        const valid = await evidenceBindingsValid({ artifact: selection.artifact, case_import_file: selection.artifact.path });
        selection = valid ? await readJson(selection.artifact.path) : {
          status: 'needs_material_selection_evidence_repair', selected_count: 0, gaps: ['selection_input_or_result_changed'] };
      } else {
        const selectionDirectory = path.join(directory, 'selection', selectionSignature.slice(0, 20));
        try {
          selection = await selectMaterials({ candidate_file: result.artifact.path, input_file: input.input,
            output_dir: selectionDirectory }, runtime);
          const selectionFile = path.join(selectionDirectory, 'selection-record.json');
          state.material_selections[selectionSignature] = { artifact: { path: selectionFile, sha256: await hashFile(selectionFile) } };
          await save(stateFile, state);
        } catch (error) {
          selection = { status: error.code === 'account_quota_wait' ? 'account_quota_wait' : 'material_selection_evidence_gap',
            selected_count: 0, gaps: ['candidate_audio_or_runtime_result_not_bound'], cli_receipts: error.cli_receipts ?? [] };
        }
      }
      selectionResults.push(selection);
      if (selection.bindings_file) selectedBindingInputs.push({ input: input.input, bindings: selection.bindings_file.path });
    }
  }
  const materialResults = [];
  state.materials ??= {};
  for (const input of [...(config.material_binding_inputs ?? []), ...selectedBindingInputs]) {
    if (!input.input || !input.bindings || !config.library_db) throw new Error('material_input_bindings_and_library_required');
    const signature = shaBytes(JSON.stringify({ input: await hashFile(input.input), bindings: await hashFile(input.bindings),
      library: await hashFile(config.library_db) }));
    const prior = state.materials[signature], directory = path.join(output, 'materials', signature.slice(0, 20));
    const artifact = path.join(directory, 'bound-case-import.json');
    await mkdir(directory, { recursive: true });
    let result;
    if (prior) {
      const valid = await evidenceBindingsValid({ artifact: prior.artifact, case_import_file: prior.artifact.path });
      result = { ...prior, status: valid ? 'research_materials_bound' : 'needs_material_evidence_repair',
        evidence_binding_currently_valid: valid };
    } else {
      try {
        await materialCommand(python, ['--input', path.resolve(input.input), '--bindings', path.resolve(input.bindings),
          '--library-db', path.resolve(config.library_db), '--output', artifact]);
        result = { status: 'research_materials_bound', artifact: { path: artifact, sha256: await hashFile(artifact) },
          evidence_binding_currently_valid: true };
        state.materials[signature] = result;
        await save(stateFile, state);
      } catch {
        result = { status: 'material_binding_gap', evidence_binding_currently_valid: false,
          gaps: ['actual_source_window_or_listening_evidence_not_bound'] };
      }
    }
    if (result.evidence_binding_currently_valid) importFiles.push(result.artifact.path);
    materialResults.push(result);
  }
  for (const filename of importFiles) {
    const file = path.resolve(filename), sourceHash = shaBytes(await readFile(file));
    if (state.imported[file]?.sha256 === sourceHash) continue;
    await storeCommand(python, ['import', '--db', database, '--input', file]);
    state.imported[file] = { path: file, sha256: sourceHash, imported_at: new Date().toISOString() };
    await save(stateFile, state);
  }
  const storeReport = await storeCommand(python, ['report', '--db', database]);
  const reportFile = path.join(output, 'case-store-report.json');
  await save(reportFile, storeReport);
  // Rule candidates are separate from Nuwa's actual reasoning and from musical approval.
  const storeHash = await hashFile(database);
  const baseRuleDirectory = path.join(output, 'rules', storeHash.slice(0, 20));
  let ruleDirectory = baseRuleDirectory, priorCandidates = null;
  const existingCandidates = path.join(ruleDirectory, 'case-rule-candidates.json');
  state.rule_compilations ??= {};
  if (await exists(existingCandidates)) {
    const previous = await readJson(existingCandidates), previousHash = await hashFile(existingCandidates);
    if (!await evidenceBindingsValid({ import_document: previous })) ruleDirectory += `-repair-${Date.now()}`;
    else if (previous.rule_gaps?.some(row => row.gap === 'evidence_file_missing_or_hash_changed')
      && !(state.rule_compilations[existingCandidates]?.revision === RULE_EVIDENCE_COMPILER_REVISION
        && state.rule_compilations[existingCandidates].candidate.sha256 === previousHash)) {
      priorCandidates = { path: existingCandidates, sha256: previousHash };
      ruleDirectory += `-io-${shaBytes(JSON.stringify([RULE_EVIDENCE_COMPILER_REVISION, previousHash])).slice(0, 16)}`;
    }
  }
  await mkdir(ruleDirectory, { recursive: true });
  let ruleCandidates = path.join(ruleDirectory, 'case-rule-candidates.json');
  let indexDirectory = config.artifact_dir ? path.join(storage, 'rule-indexes', path.basename(ruleDirectory)) : ruleDirectory;
  await mkdir(indexDirectory, { recursive: true });
  let ruleIndex = path.join(indexDirectory, 'case-rules.sqlite');
  if (!await exists(ruleCandidates)) {
    await materialCommand(python, ['--case-db', database, '--output', ruleCandidates, '--rules-db', ruleIndex]);
    state.rule_compilations[ruleCandidates] = { revision: RULE_EVIDENCE_COMPILER_REVISION, store_sha256: storeHash,
      candidate: { path: ruleCandidates, sha256: await hashFile(ruleCandidates) }, prior_candidates: priorCandidates,
      completed_at: new Date().toISOString(), model_calls: 0 };
    await save(stateFile, state);
  }
  if (priorCandidates) {
    const attempt = { path: ruleCandidates, sha256: await hashFile(ruleCandidates) };
    if (state.rule_compilations[ruleCandidates]?.candidate.sha256 !== attempt.sha256
      || !await evidenceBindingsValid({ import_document: await readJson(ruleCandidates) }))
      throw new Error('rule_compilation_repair_evidence_changed');
    // Identical content must retain source.path for an existing pending Nuwa request.
    if (attempt.sha256 === priorCandidates.sha256) {
      const compilation = state.rule_compilations[ruleCandidates];
      ruleCandidates = existingCandidates; ruleDirectory = baseRuleDirectory;
      indexDirectory = config.artifact_dir ? path.join(storage, 'rule-indexes', path.basename(ruleDirectory)) : ruleDirectory;
      ruleIndex = path.join(indexDirectory, 'case-rules.sqlite');
      state.rule_compilations[ruleCandidates] = { ...compilation, candidate: priorCandidates, attempted_candidate: attempt };
    }
  }
  await ensureRuleIndex(python, ruleCandidates, ruleIndex, state);
  const rules = await readJson(ruleCandidates), synthesisSignature = shaBytes(JSON.stringify({
    candidates: await hashFile(ruleCandidates), backend: runtime.synthesizer_backend_id ?? null,
    revision: runtime.synthesizer_model_revision ?? null, model_bindings: config.model_bindings ?? null,
    present: typeof runtime.synthesizer === 'function' }));
  state.syntheses ??= {};
  const priorSynthesis = state.syntheses[synthesisSignature];
  let synthesisDirectory = priorSynthesis?.directory ?? path.join(ruleDirectory, synthesisSignature.slice(0, 16));
  const synthesisRecord = path.join(synthesisDirectory, 'rule-synthesis-record.json');
  let synthesis;
  if (await exists(synthesisRecord)) {
    synthesis = await readJson(synthesisRecord);
    if (priorSynthesis?.artifact && await hashFile(synthesisRecord) !== priorSynthesis.artifact.sha256
      || !await evidenceBindingsValid({ import_document: synthesis }))
      synthesis = { status: 'needs_rule_evidence_repair', nuwa_synthesis_completed: false, runtime_calls: 0 };
  }
  if (!synthesis || ['nuwa_synthesis_pending', 'account_quota_wait'].includes(synthesis.status)
    && typeof runtime.synthesizer === 'function' && rules.rules.length) {
    const pendingInput = ['nuwa_synthesis_pending', 'account_quota_wait'].includes(synthesis?.status) ? synthesis.input : null;
    if (await exists(synthesisRecord) || await exists(path.join(synthesisDirectory, 'nuwa-request.json')))
      synthesisDirectory = path.join(ruleDirectory, synthesisSignature.slice(0, 16), 'attempts', String(Date.now()));
    await mkdir(synthesisDirectory, { recursive: true });
    try { synthesis = await synthesizeRules({ candidates_file: ruleCandidates, output_dir: synthesisDirectory,
      pending_input: pendingInput }, runtime); }
    catch (error) { synthesis = { status: error.code === 'account_quota_wait' ? 'account_quota_wait'
      : error.code === 'host_response_pending' || error.name === 'HostResponsePendingError'
        ? 'nuwa_synthesis_pending' : 'rule_synthesis_gap', nuwa_synthesis_completed: false,
      runtime_calls: Number(typeof runtime.synthesizer === 'function' && rules.rules.length > 0),
      ...(error.code === 'account_quota_wait' ? { error: 'account_quota_wait', cli_receipts: error.cli_receipts ?? [] } : {}),
      ...(error.request_file ? { request_file: error.request_file, response_file: error.response_file } : {}),
      gaps: ['source_or_runtime_response_evidence_not_bound'] }; }
    const requestInput = path.join(synthesisDirectory, 'nuwa-request.json');
    if (!synthesis.input && (pendingInput || await exists(requestInput))) synthesis.input = pendingInput
      ?? { path: requestInput, sha256: await hashFile(requestInput) };
    const filename = path.join(synthesisDirectory, 'rule-synthesis-record.json');
    if (!await exists(filename)) await save(filename, synthesis);
    state.syntheses[synthesisSignature] = { directory: synthesisDirectory,
      artifact: { path: filename, sha256: await hashFile(filename) } };
  }
  let activeRuleIndex = ruleIndex;
  if (synthesis.nuwa_synthesis_completed) {
    activeRuleIndex = path.join(config.artifact_dir ? indexDirectory : synthesisDirectory, 'director-rules.sqlite');
    await ensureRuleIndex(python, synthesis.rules.path, activeRuleIndex, state);
  }
  await save(stateFile, state);
  const media = [...(config.media_manifest_file ? await verifyMediaManifest(config.media_manifest_file) : []), ...scheduled.media];
  await save(path.join(output, 'media-integrity.json'), { schema_version: 1, entries: media, actual_observation_performed: false });
  const collector = config.catalog_manifest ? await readJson(config.catalog_manifest) : null;
  const scopeCoverage = [];
  if (collector?.files?.members || Array.isArray(collector?.works)) {
    const members = collector.works ?? (await readFile(collector.files.members, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    for (const work of members) {
      const rows = media.filter(row => row.file_integrity_verified && (row.work_id === work.work_id
        || work.series_id != null && row.official_series_id === work.series_id));
      const numbers = [...new Set(rows.map(row => row.episode_number).filter(Number.isInteger))].sort((a, b) => a - b);
      const total = Number.isInteger(work.episode_count) && work.episode_count > 0 ? work.episode_count : null;
      const missing = total === null ? null : Array.from({ length: total }, (_, index) => index + 1).filter(number => !numbers.includes(number));
      scopeCoverage.push({ work_id: work.work_id, official_series_id: work.series_id, title: work.title,
        favorite_count: work.favorite_count ?? null, favorite_evidence_date: work.retrieved_at,
        expected_episode_count: total, acquired_episode_numbers: numbers, missing_episode_numbers: missing,
        complete_series_media: missing !== null && missing.length === 0,
        complete_series_sound_observation: missing !== null && missing.length === 0 && rows.every(row => episodeResults.some(result =>
          result.source_video_sha256 === row.source_video.sha256 && result.coverage?.complete_processed === true
          && result.coverage?.sound_semantics_verified === true)),
        material_binding_status: 'requires_case_and_window_level_check' });
    }
  }
  await save(path.join(output, 'scope-episode-coverage.json'), { schema_version: 1, works: scopeCoverage,
    scope_basis: collector?.scope_basis ?? 'frozen_official_favorite_members_only_tinghuadao_union_identity_pending',
    all_favorite_candidates_checked: collector?.all_favorite_cards_filtered ?? false });
  const queryResults = [];
  for (const [index, filename] of (config.query_files ?? []).entries()) {
    const args = ['query', '--db', database, '--input', path.resolve(filename)];
    if (config.library_db) args.push('--library-db', path.resolve(config.library_db));
    const result = await storeCommand(python, args);
    const destination = path.join(output, `case-query-${index + 1}.json`);
    await save(destination, result);
    queryResults.push({ source: path.resolve(filename), source_sha256: await hashFile(filename), result: destination,
      status: result.status, coverage: result.coverage, formal_adoption_allowed: false });
  }
  const queryUsable = queryResults.length ? queryResults.reduce((sum, item) => sum
    + (item.coverage?.items ?? []).reduce((total, cue) => total + (cue.eligible_for_current_review_count ?? 0), 0), 0) : null;
  const pending = media.filter(item => !episodeResults.some(result => result.source_video_sha256 === item.source_video.sha256
    && result.coverage?.complete_processed === true && result.coverage?.sound_semantics_verified === true)).map(item => ({
    media_id: item.media_id, work_id: item.work_id, source_video: item.source_video,
    stage: item.file_integrity_verified ? 'actual_sound_and_picture_observation' : 'media_reacquisition',
    status: 'pending', reason: item.gap ?? 'explicit_bound_observation_required',
  }));
  pending.push(...scheduled.pending);
  for (const result of referenceMusicResults) pending.push({ stage: 'reference_music_identification', ...result });
  for (const result of candidateResults) pending.push({ stage: 'material_candidate_comparison', ...result });
  for (const result of selectionResults) if (result.status !== 'research_materials_selected_pending_independent_review')
    pending.push({ stage: 'material_selection', ...result });
  for (const result of episodeResults) {
    if (!result.coverage?.complete_processed || !result.coverage?.sound_semantics_verified || result.gaps.length) pending.push({
      work_id: result.work_id, episode_id: result.episode_id, stage: 'episode_distillation', status: result.status,
      source_video_sha256: result.source_video_sha256, gaps: result.gaps,
    });
  }
  for (const result of materialResults) if (!result.evidence_binding_currently_valid)
    pending.push({ stage: 'material_binding', ...result });
  for (const gap of rules.rule_gaps ?? []) pending.push({ stage: 'case_rule_candidate', ...gap, status: 'needs_evidence_repair' });
  for (const work of scopeCoverage) if (!work.complete_series_media) pending.push({ stage: 'complete_series_media_acquisition',
    work_id: work.work_id, official_series_id: work.official_series_id, missing_episode_count: work.missing_episode_numbers?.length ?? null,
    status: 'pending', source: path.join(output, 'scope-episode-coverage.json') });
  if (!synthesis.nuwa_synthesis_completed) pending.push({ stage: 'nuwa_rule_synthesis', status: synthesis.status,
    candidate_count: rules.rules.length, request: path.join(synthesisDirectory, 'nuwa-request.json') });
  if (collector?.files?.pending && !collector.all_favorite_cards_filtered) pending.push({ stage: 'official_favorite_verification', status: 'pending',
    queue_file: collector.files.pending, count: collector.counts.favorite_cards_not_checked + collector.counts.current_favorite_unknown });
  await save(path.join(output, 'distill-pending.json'), { schema_version: 1, tasks: pending });
  const episodeCoverage = [];
  for (const workId of new Set(media.filter(row => row.episode_number !== null).map(row => row.work_id))) {
    const rows = media.filter(row => row.work_id === workId && row.episode_number !== null);
    const numbers = [...new Set(rows.filter(row => row.file_integrity_verified).map(row => row.episode_number))].sort((a, b) => a - b);
    const expected = [...new Set(rows.map(row => row.official_episode_count).filter(Number.isInteger))];
    episodeCoverage.push({ work_id: workId, expected_episode_count: expected.length === 1 ? expected[0] : null,
      actual_episode_numbers: numbers, actual_episode_file_count: numbers.length,
      complete_series_media: expected.length === 1 && numbers.length === expected[0]
        && numbers.every((number, index) => number === index + 1) });
  }
  const counts = {
    catalog: collector?.counts ?? null, registered: storeReport.counts,
    media_file_integrity_verified: media.filter(row => row.file_integrity_verified).length,
    media_files_missing_or_changed: media.filter(row => !row.file_integrity_verified).length,
    declared_case_statuses: storeReport.case_statuses,
    sequence_case_count: storeReport.sequence_case_count ?? null,
    development_preset_count: storeReport.development_preset_count ?? null,
    theme_bundle_count: storeReport.theme_bundle_count ?? null,
    sound_pack_count: storeReport.sound_pack_count ?? null,
    material_binding_inputs: materialResults.length,
    reference_music_lookup_tasks: referenceMusicResults.length,
    reference_music_lookup_executed: referenceMusicResults.filter(result => result.actual_runtime_executed).length,
    material_candidate_tasks: candidateResults.reduce((sum, result) => sum + result.task_count, 0),
    material_candidate_count: candidateResults.reduce((sum, result) => sum + result.candidate_count, 0),
    material_binding_outputs: materialResults.filter(result => result.evidence_binding_currently_valid).length,
    material_selected_windows: selectionResults.reduce((sum, result) => sum + result.selected_count, 0),
    rule_candidate_count: rules.rules.length,
    synthesized_rule_count: synthesis.nuwa_synthesis_completed ? synthesis.rule_count : 0,
    bound_historical_evidence_counts: storeReport.bound_historical_evidence_counts ?? null,
    episode_media_file_count: episodeCoverage.reduce((sum, work) => sum + work.actual_episode_file_count, 0),
    complete_series_media_count: episodeCoverage.filter(work => work.complete_series_media).length,
    admitted_favorite_work_count: scopeCoverage.length,
    admitted_favorite_episode_positions: scopeCoverage.reduce((sum, work) => sum + (work.expected_episode_count ?? 0), 0),
    admitted_favorite_missing_episode_positions: scopeCoverage.reduce((sum, work) => sum + (work.missing_episode_numbers?.length ?? 0), 0),
    admitted_favorite_complete_media_count: scopeCoverage.filter(work => work.complete_series_media).length,
    admitted_favorite_complete_sound_observation_count: scopeCoverage.filter(work => work.complete_series_sound_observation).length,
    episode_distillation_inputs: episodeResults.length,
    scheduled_acquired_episodes: new Set(scheduled.media.filter(row => row.file_integrity_verified && row.work_id && row.episode_id)
      .map(row => row.episode_id)).size,
    scheduled_media_gaps: scheduled.pending.length,
    model_calls_this_run: episodeResults.filter(result => result.executed_this_run).reduce((sum, result) => sum + result.model_calls, 0),
    cli_model_calls_this_run: episodeResults.reduce((sum, result) => sum + result.cli_model_calls, 0),
    cloud_uploads_this_run: episodeResults.filter(result => result.executed_this_run).reduce((sum, result) => sum + result.cloud_uploads, 0),
    runtime_calls_this_run: episodeResults.filter(result => result.executed_this_run).reduce((sum, result) => sum + result.runtime_calls, 0),
    episodes_with_complete_window_coverage: episodeResults.filter(result => result.coverage?.complete_processed === true).length,
    episodes_with_verified_sound_semantics: episodeResults.filter(result => result.coverage?.sound_semantics_verified === true).length,
    episodes_with_actual_audio_and_video_processed: new Set(episodeResults.filter(result => result.actual_audio_processed
      && result.actual_video_processed && result.source_video_sha256).map(result => result.source_video_sha256)).size,
    query_usable_candidates: queryUsable, query_runs: queryResults.length,
    pending_media_observations: pending.filter(row => row.stage === 'actual_sound_and_picture_observation').length,
  };
  const manifest = { schema_version: 1, generated_at: new Date().toISOString(), status: 'research_pending',
    counts, episode_coverage: episodeCoverage, episode_results: episodeResults,
    cases_db: database, episode_output_dir: episodeOutput, manifest_path: path.join(output, 'distill-manifest.json'),
    reference_music_results: referenceMusicResults,
    material_results: materialResults, material_candidate_results: candidateResults, material_selection_results: selectionResults,
    rule_candidates: { path: ruleCandidates, sha256: await hashFile(ruleCandidates) },
    rule_compilation: state.rule_compilations[ruleCandidates] ?? null,
    rule_index: { path: activeRuleIndex, sha256: await hashFile(activeRuleIndex) }, rule_synthesis: synthesis,
    input_bindings: Object.values(state.imported), seed_case_store: state.seed_case_store ?? null,
    catalog_manifest: config.catalog_manifest ? { path: path.resolve(config.catalog_manifest), sha256: await hashFile(config.catalog_manifest) } : null,
    media_manifest: config.media_manifest_file ? { path: path.resolve(config.media_manifest_file), sha256: await hashFile(config.media_manifest_file) } : null,
    episode_manifest: config.episode_manifest_file ? { path: path.resolve(config.episode_manifest_file), sha256: await hashFile(config.episode_manifest_file) } : null,
    store_report: reportFile, queries: queryResults,
    scope_episode_coverage: path.join(output, 'scope-episode-coverage.json'),
    pending: path.join(output, 'distill-pending.json'), complete_corpus_claimed: false,
    download_is_not_observation: true, actual_observation_performed_by_this_run: episodeResults.some(result => result.executed_this_run
      && result.actual_audio_processed && result.actual_video_processed && result.observation_calls_this_run !== 0),
    formal_adoption_allowed: false, artistic_approval: false };
  await save(path.join(output, 'distill-manifest.json'), manifest);
  await save(stateFile, state);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('usage_node_distill_corpus_CONFIG_json');
    const result = await distillCorpus(await readJson(file));
    console.log(JSON.stringify({ status: result.status, counts: result.counts, manifest: result.manifest_path }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
