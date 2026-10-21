import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execOwnedFile } from './owned_process_runner.mjs';
import {resolveGpuSingleSlotBinding,readGpuSingleSlotBinding} from './gpu_single_slot.mjs';

const runFile = execOwnedFile;
const scripts = path.dirname(fileURLToPath(import.meta.url));
const workerName = 'music_flamingo_research_screen.py';
const observerName = 'music_flamingo_runtime.py';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const save = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function hash(file) {
  const result = createHash('sha256');
  for await (const chunk of createReadStream(file)) result.update(chunk);
  return result.digest('hex');
}
async function binding(ref, label) {
  if (!ref?.path || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) throw Error(`${label}_binding_required`);
  const value = { path: path.resolve(ref.path), sha256: await hash(ref.path) };
  if (value.sha256 !== ref.sha256) throw Error(`${label}_identity_changed`);
  return value;
}

async function dependencyIdentity(python, deps) {
  const result = {};
  const roots = [path.resolve(deps), path.join(path.dirname(path.dirname(path.resolve(python))), 'Lib', 'site-packages')];
  for (const [index, root] of roots.entries()) {
    if (!await exists(root)) { result[`root-${index}`] = 'missing'; continue; }
    for (const name of (await readdir(root)).sort()) {
      if (/^(transformers|torch|accelerate|bitsandbytes|tokenizers|safetensors)-.*\.dist-info$/.test(name)) {
        const file = path.join(root, name, 'METADATA');
        result[`${index}:${name}`] = await hash(file);
      }
    }
  }
  for (const relative of ['transformers/models/musicflamingo/modeling_musicflamingo.py',
    'transformers/models/musicflamingo/processing_musicflamingo.py', 'transformers/generation/utils.py']) {
    const file = path.join(deps, relative);
    result[relative] = await exists(file) ? await hash(file) : 'missing';
  }
  result.python_binary_sha256 = await exists(python) ? await hash(python) : 'missing';
  return result;
}

export function validateResearchAudioWindows(windows, durationSeconds) {
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 16)
    throw Error('research_audio_requires_1_to_16_windows');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw Error('research_audio_duration_required');
  const ids = new Set();
  return windows.map(window => {
    const range = window.source_range;
    if (typeof window.id !== 'string' || !window.id || ids.has(window.id)) throw Error('research_audio_unique_window_ids_required');
    ids.add(window.id);
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 ||
        range[1] <= range[0] || range[1] - range[0] > 30 || range[1] > durationSeconds + 1 / 16000)
      throw Error('research_audio_window_outside_bounded_source');
    return { id: window.id, source_range: [...range], kind: window.kind ?? 'requested_interval' };
  });
}

// Full-axis audio sampling is distinct from supplemental seam/effect windows.
// Omitted extras are returned explicitly; full-axis windows are never dropped.
export function buildResearchAudioWindows(durationSeconds, extras = []) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw Error('research_audio_duration_required');
  const windows = [];
  for (let start = 0; start < durationSeconds; start += 23) {
    windows.push({ id: `timeline-${windows.length}`, source_range: [start, Math.min(start + 25, durationSeconds)], kind: 'full_timeline' });
    if (start + 25 >= durationSeconds) break;
  }
  if (windows.length > 16) throw Error('research_audio_full_axis_requires_multiple_batches');
  const omittedExtras = [];
  for (const extra of extras) {
    validateResearchAudioWindows([extra], durationSeconds);
    if (windows.some(window => window.source_range[0] <= extra.source_range[0] && window.source_range[1] >= extra.source_range[1])) continue;
    if (windows.length === 16) omittedExtras.push(extra);
    else windows.push(extra);
  }
  return { windows: validateResearchAudioWindows(windows, durationSeconds), omitted_extras: omittedExtras };
}

function unionCoverage(windows, duration) {
  let end = 0;
  for (const range of windows.map(item => item.source_range).sort((a, b) => a[0] - b[0])) {
    if (range[0] > end + 1 / 16000) return false;
    end = Math.max(end, range[1]);
  }
  return end >= duration - 1 / 16000;
}

async function verifyRawReport(raw, request, directory) {
  if (raw.status !== 'actual_audio_batch_complete_pending_validation' || raw.qualified !== false ||
      raw.jobs?.length !== request.windows.length) throw Error('research_audio_actual_batch_incomplete');
  await binding(raw.jobs_binding, 'research_audio_jobs');
  await binding(raw.runtime_script_binding, 'research_audio_worker');
  if (raw.runtime_script_binding.sha256 !== request.runtime.worker_sha256)
    throw Error('research_audio_worker_snapshot_identity_changed');
  if (raw.observer_binding?.checkpoint_sha256 !== request.model.checkpoint_sha256 ||
      raw.observer_binding?.download_record_sha256 !== request.model.download_record_sha256 ||
      raw.observer_binding?.runtime_source_sha256 !== request.runtime.observer_sha256)
    throw Error('research_audio_actual_model_identity_changed');
  for (const [index, row] of raw.jobs.entries()) {
    const window = request.windows[index];
    if (row.id !== window.id || row.source_binding?.sha256 !== request.source.sha256 ||
        row.source_binding?.path !== request.source.path || JSON.stringify(row.source_range) !== JSON.stringify(window.source_range))
      throw Error('research_audio_actual_window_identity_changed');
    await binding(row.input_audio, 'research_audio_decoded_input');
    if (row.execution?.actual_audio_processed === true && (row.execution.processor_pcm_sha256 !== row.input_audio.pcm_sha256 ||
        !(row.execution.actual_audio_tokens > 0) || !(row.execution.encoder_forward_count > 0)))
      throw Error('research_audio_forward_not_bound_to_decoded_pcm');
    if (row.qualified !== false) throw Error('research_audio_predictor_cannot_grant_qualification');
  }
  await binding({ path: path.join(directory, 'runtime', observerName), sha256: request.runtime.observer_sha256 }, 'research_audio_observer_snapshot');
}

/** Actual local audio forwards, raw text and exact receipts; no artistic approval.
 * Attach the returned function to runtime.researchAudioObserver. Shared film
 * trialBudget is required and only inspectLocal is used: no account requests.
 */
export function createLocalResearchAudioObserver({ python, weights, deps, ffmpeg = 'ffmpeg', gpu_slot } = {}) {
  if (![python, weights, deps].every(value => typeof value === 'string' && value)) throw Error('research_audio_local_runtime_paths_required');
  async function getIdentity() {
    const slot=resolveGpuSingleSlotBinding(gpu_slot);
    await readGpuSingleSlotBinding(slot);
    const modelManifest = path.join(path.dirname(path.resolve(weights)), 'download-record.json');
    const checkpoint = path.join(weights, 'model.safetensors');
    const worker = path.join(scripts, workerName), observer = path.join(scripts, observerName);
    return { model: { download_record_sha256: await hash(modelManifest), checkpoint_sha256: await hash(checkpoint) },
      runtime: { worker_sha256: await hash(worker), observer_sha256: await hash(observer),
        gpu_slot:slot,gpu_slot_helper_sha256:await hash(path.join(scripts,'gpu_single_slot.py')),
        python: path.resolve(python), deps: path.resolve(deps), ffmpeg,
        dependency_identity: await dependencyIdentity(python, deps) },
      implementation: { path: fileURLToPath(import.meta.url), sha256: await hash(fileURLToPath(import.meta.url)) } };
  }
  async function observe({ source, source_video = null, original_source_video_sha256 = null,
    windows, duration_seconds, directory, trialBudget } = {}) {
    if (!directory) throw Error('research_audio_evidence_directory_required');
    const selected = validateResearchAudioWindows(windows, duration_seconds);
    const sourceBinding = await binding(source, 'research_audio_source');
    const videoBinding = source_video ? await binding(source_video, 'research_audio_source_video') : null;
    if (trialBudget?.identity?.wall_clock_policy)
      await trialBudget.inspectLocal({ stage: 'local_research_audio_model_identity_io' });
    if (original_source_video_sha256 !== null && !/^[a-f0-9]{64}$/.test(original_source_video_sha256))
      throw Error('research_audio_original_video_sha256_invalid');
    const worker = path.join(scripts, workerName), observer = path.join(scripts, observerName);
    const request = { schema_version: 1, source: sourceBinding, source_video: videoBinding,
      original_source_video_sha256, duration_seconds, windows: selected, ...await getIdentity() };
    const key = digest(request), dir = path.resolve(directory), stateFile = path.join(dir, 'request.json');
    const reportFile = path.join(dir, 'actual-output', 'report.json');
    let raw;
    if (await exists(stateFile)) {
      const saved = await json(stateFile);
      if (saved.request_key !== key) throw Error('research_audio_resume_identity_changed_use_new_directory');
      if (await exists(reportFile)) {
        raw = await json(reportFile);
        await verifyRawReport(raw, request, dir);
      } else if (saved.state !== 'prepared_not_submitted') {
        throw Error('research_audio_existing_submission_requires_reconciliation');
      }
    }
    if (!raw) {
      if (typeof trialBudget?.inspectLocal !== 'function') throw Error('research_audio_shared_episode_budget_required');
      let budget = await trialBudget.inspectLocal({ stage: 'local_research_audio_screen_preparation' });
      if (!Number.isFinite(budget?.remaining_ms) || budget.remaining_ms <= 0) throw Error('research_audio_no_remaining_episode_time');
      await mkdir(path.join(dir, 'runtime'), { recursive: true });
      await copyFile(worker, path.join(dir, 'runtime', workerName));
      await copyFile(observer, path.join(dir, 'runtime', observerName));
      await copyFile(path.join(scripts,'gpu_single_slot.py'),path.join(dir,'runtime','gpu_single_slot.py'));
      await binding({path:path.join(dir,'runtime','gpu_single_slot.py'),sha256:request.runtime.gpu_slot_helper_sha256},'research_audio_gpu_slot_snapshot');
      await binding({ path: path.join(dir, 'runtime', workerName), sha256: request.runtime.worker_sha256 }, 'research_audio_worker_snapshot');
      await binding({ path: path.join(dir, 'runtime', observerName), sha256: request.runtime.observer_sha256 }, 'research_audio_observer_snapshot');
      await save(stateFile, { request_key: key, request, state: 'prepared_not_submitted' });
      const jobsFile = path.join(dir, 'jobs.json');
      await save(jobsFile, { jobs: selected.map(window => ({ id: window.id, path: sourceBinding.path,
        sha256: sourceBinding.sha256, source_range: window.source_range })) });
      budget = await trialBudget.inspectLocal({ stage: 'local_research_audio_screen_submission' });
      if (!Number.isFinite(budget?.remaining_ms) || budget.remaining_ms <= 0) throw Error('research_audio_no_remaining_episode_time');
      await save(stateFile, { request_key: key, request, state: 'submitted_local_outcome_pending',
        submitted_at: new Date().toISOString(), account_model_calls: 0 });
      try {
        const execution = await runFile(python, [path.join(dir, 'runtime', workerName), '--jobs', jobsFile,
          '--output', path.join(dir, 'actual-output'), '--weights', path.resolve(weights), '--deps', path.resolve(deps),
          '--ffmpeg', ffmpeg,'--gpu-slot-config',request.runtime.gpu_slot.path,
          '--gpu-slot-sha256',request.runtime.gpu_slot.sha256], { python, windowsHide: true,
          deadlineAtMs: budget.deadline_at_ms == null ? null : budget.deadline_at_ms - (budget.reserved_render_ms ?? 0),
          timeout: Math.max(1, Math.floor(budget.remaining_ms)), maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' } });
        await save(path.join(dir, 'process.json'), { exited: true, code: 0, stdout: execution.stdout, stderr: execution.stderr });
      } catch (error) {
        await save(path.join(dir, 'process.json'), { exited: true, code: error.code ?? null, signal: error.signal ?? null,
          killed: error.killed ?? false, error: error.message, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
          status: 'failed_or_timed_out_no_automatic_resubmission' });
        throw Error('research_audio_local_batch_failed_preserved_for_reconciliation', { cause: error });
      }
      raw = await json(reportFile);
      await verifyRawReport(raw, request, dir);
      await save(stateFile, { request_key: key, request, state: 'actual_batch_complete_pending_validation' });
    }
    const reportBinding = { path: reportFile, sha256: await hash(reportFile) };
    const complete = raw.jobs.every(row => row.execution?.actual_audio_processed === true);
    const result = { schema_version: 1, status: complete ? 'actual_audio_research_screen_complete' : 'actual_audio_research_screen_partial', qualified: false,
      sound_facts_qualified: false, artistic_approval: false, production_approval: false, audio_review_accepted: false,
      actual_picture_processed: false, source: sourceBinding, source_video: videoBinding, original_source_video_sha256,
      request_key: key, raw_report: reportBinding, actual_observation_count: raw.actual_observation_count,
      full_timeline_audio_windows_processed: unionCoverage(selected, duration_seconds) && raw.jobs.every(row => row.execution?.actual_audio_processed === true),
      account_model_calls: 0, paid_calls: 0, cloud_uploads: 0,
      limitations: ['unqualified model predictions', 'audio downmixed to mono; no spatial judgment',
        'no actual picture input; not a synchronized audiovisual review', 'research-only model license'],
      windows: raw.jobs.map((row, index) => ({ id: row.id, kind: selected[index].kind, source_range: row.source_range,
        source_sha256: sourceBinding.sha256, source_video_sha256: videoBinding?.sha256 ?? null,
        input_audio: row.input_audio, status: row.status, actual_audio_processed: row.execution?.actual_audio_processed === true,
        raw_observation: row.raw_observation ?? null, generation_termination: row.generation_termination ?? null,
        qualified: false, evidence: { report_sha256: reportBinding.sha256, job_index: index } })) };
    await save(path.join(dir, 'screen.json'), result);
    if (trialBudget?.identity?.wall_clock_policy)
      await trialBudget.inspectLocal({ stage: 'local_research_audio_result_io_complete' });
    return result;
  }
  Object.defineProperty(observe, 'getIdentity', { value: getIdentity, writable: false, configurable: false });
  return observe;
}
