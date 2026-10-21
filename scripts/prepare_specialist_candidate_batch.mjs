import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { selectInspectionCandidates } from './material_selection.mjs';
import { verifyObservationContexts, scopedHumanContextFacts } from './material_observation_context.mjs';
import {validSpecialistDevice} from './specialist_cache_identity.mjs';

const execute = promisify(execFile);
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });

export async function prepareSpecialistCandidateWindow(job, directory, { ffmpeg = 'ffmpeg', command = execute } = {}) {
  const range = job.source_window_seconds;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
    || range[0] < 0 || range[1] <= range[0]) throw new Error('candidate_source_range_invalid');
  if (await hashFile(job.source_file) !== job.source_sha256) throw new Error('candidate_source_changed');
  await mkdir(directory, { recursive: true });
  const input = path.join(directory, job.id + '.wav');
  const startSample = Math.round(range[0] * 16000), lengthSamples = Math.round((range[1] - range[0]) * 16000);
  // Library source windows are relative to the first decoded audio sample. Input seeking
  // uses container PTS and can discard Opus pre-roll even for -ss 0. Trim decoded samples.
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', job.source_file,
    '-vn', '-ac', '1', '-ar', '16000', '-af',
    `aresample=16000,atrim=start_sample=${startSample}:end_sample=${startSample + lengthSamples},asetpts=PTS-STARTPTS`,
    '-c:a', 'pcm_s16le', input]);
  const bytes = await readFile(input);
  if (await hashFile(job.source_file) !== job.source_sha256) throw new Error('candidate_changed_during_decode');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('prepared_wav_required');
  let format, dataBytes;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), id = bytes.toString('ascii', at, at + 4);
    if (id === 'fmt ') format = { encoding: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10),
      rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    if (id === 'data' && at + 8 + size <= bytes.length) dataBytes = size;
    at += 8 + size + (size % 2);
  }
  if (format?.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16
    || dataBytes === undefined || dataBytes % 2) throw new Error('prepared_pcm_format_required');
  const actualSamples = dataBytes / 2, expectedSamples = (range[1] - range[0]) * 16000;
  if (Math.abs(actualSamples - expectedSamples) > 1 + 16000e-8) {
    const error = new Error('prepared_samples_do_not_cover_candidate_range');
    error.coverage = { status: actualSamples < expectedSamples ? 'invalid_window' : 'range_mismatch', error: error.message,
      source_file: job.source_file, source_sha256: job.source_sha256, source_window_seconds: range,
      segment_id: job.segment_id, actual_samples: actualSamples, expected_samples: expectedSamples,
      sample_rate_hz: 16000, input_audio: await bound(input) };
    throw error;
  }
  return { ...job, input_file: input, input_sha256: await hashFile(input) };
}

// Limit a real recall result without changing any candidate's source window.
// Both existing specialists receive the same once-decoded PCM file.
export async function prepareSpecialistCandidateBatch(config) {
  const original = await bound(config.candidate_file), caseInput = await bound(config.case_input);
  const encoded = await readJson(original.path), expanded = expandCandidateEvidence(encoded);
  const indices = config.task_indices;
  if (!indices?.length || new Set(indices).size !== indices.length
    || indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= expanded.tasks.length))
    throw new Error('explicit_existing_task_indices_required');
  const jobs = new Map(), sourceHashes = new Map(), inspections = new Map();
  for (const i of indices) {
    const selected = selectInspectionCandidates(expanded.tasks[i].candidates);
    inspections.set(i, selected.map(candidate => expanded.tasks[i].candidates.indexOf(candidate)));
    for (const candidate of selected) {
      const pointer = candidate.candidate, source = path.resolve(typeof candidate.source_file === 'string'
        ? candidate.source_file : candidate.source_file.path);
      if (!sourceHashes.has(source)) sourceHashes.set(source, await hashFile(source));
      if (sourceHashes.get(source) !== pointer.source_sha256) throw new Error('candidate_source_changed');
      const range = pointer.source_range, key = JSON.stringify([pointer.source_sha256, range]);
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
        || range[0] < 0 || range[1] <= range[0]) throw new Error('candidate_source_range_invalid');
      if (!jobs.has(key)) jobs.set(key, { id: 'candidate-' + shaBytes(key).slice(0, 24), source_file: source,
        source_sha256: pointer.source_sha256, source_window_seconds: range, segment_id: pointer.segment_id });
      const contexts = await verifyObservationContexts(candidate);
      await scopedHumanContextFacts(candidate.human_context_review, pointer.source_sha256,
        [range, ...contexts.map(context => context.source_range)]);
      for (const context of contexts) {
        const contextKey = JSON.stringify([pointer.source_sha256, context.source_range]);
        if (!jobs.has(contextKey)) jobs.set(contextKey, { id: 'candidate-' + shaBytes(contextKey).slice(0, 24),
          source_file: source, source_sha256: pointer.source_sha256, source_window_seconds: context.source_range,
          segment_id: pointer.segment_id, context_only: true, purpose: context.purpose });
      }
    }
  }
  if (!jobs.size || jobs.size > 10) throw new Error('initial_batch_requires_one_to_ten_distinct_windows');
  const output = path.resolve(config.output_dir), configs = path.resolve(config.config_dir);
  await mkdir(path.join(output, 'inputs'), { recursive: true });
  const prepared = [], invalidWindows = [], ready = new Set();
  const reuse = new Map(), reusedReceipts = [], reusedAcousticReceipts = [], acousticReady = new Set();
  if (config.reuse_preparation_record) {
    await verifyEvidenceBindings(config.reuse_preparation_record);
    const previous = await readJson(config.reuse_preparation_record.path);
    await verifyEvidenceBindings([previous.case_input, previous.candidate_file, previous.configs]);
    const previousCandidates = expandCandidateEvidence(await readJson(previous.candidate_file.path));
    if (previous.case_input.sha256 !== caseInput.sha256 || previous.qualified !== false
      || indices.some(i => !previousCandidates.tasks.some(task => task.case_id === expanded.tasks[i].case_id
        && task.step_id === expanded.tasks[i].step_id && task.source_event_id === expanded.tasks[i].source_event_id)))
      throw new Error('context_reuse_actual_case_preparation_mismatch');
    for (const job of previous.jobs) {
      await verifyEvidenceBindings({ path: job.input_file, sha256: job.input_sha256 });
      reuse.set(JSON.stringify([job.source_sha256, job.source_window_seconds]), job);
    }
    for (const reference of previous.configs) {
      const model = await readJson(reference.path), receiptFile = path.join(model.output_dir, 'receipt.json');
      const receipt = await readJson(receiptFile);
      if (!validSpecialistDevice(model.device)||receipt.status !== 'completed_unqualified'
        ||receipt.device !== model.device || receipt.qualified !== false
        || receipt.backend !== model.backend || receipt.model_sha256 !== model.model_sha256
        || receipt.jobs.length !== model.jobs.length || receipt.jobs.some(job => job.status !== 'predicted' || !(job.forward_calls > 0)))
        throw new Error('context_reuse_actual_specialist_receipt_required');
      await verifyEvidenceBindings(receipt.jobs.map(job => ({ path: job.raw_receipt, sha256: job.raw_sha256 })));
      reusedReceipts.push(await bound(receiptFile));
    }
  }
  for (const reference of config.reuse_acoustic_receipts ?? []) {
    await verifyEvidenceBindings(reference);
    const receipt = await readJson(reference.path);
    if (receipt.backend !== 'beat_this_librosa_cpu' || receipt.status !== 'completed_unqualified'
      || receipt.device !== 'cpu' || receipt.qualified !== false
      || receipt.jobs.some(job => job.status !== 'measured' || !(job.forward_calls > 0)))
      throw new Error('context_reuse_actual_acoustic_receipt_required');
    for (const job of receipt.jobs) {
      const raw = { path: job.raw_receipt, sha256: job.raw_sha256 }; await verifyEvidenceBindings(raw);
      const value = await readJson(raw.path);
      acousticReady.add(JSON.stringify([value.source_sha256, value.source_window_seconds]));
    }
    reusedAcousticReceipts.push(reference);
  }
  for (const job of jobs.values()) {
    try {
      const prior = reuse.get(JSON.stringify([job.source_sha256, job.source_window_seconds]));
      prepared.push(prior ? { ...job, input_file: prior.input_file, input_sha256: prior.input_sha256, reused_actual_input: true }
        : await prepareSpecialistCandidateWindow(job, path.join(output, 'inputs'), { ffmpeg: config.ffmpeg }));
      ready.add(JSON.stringify([job.source_sha256, job.source_window_seconds]));
    } catch (error) {
      if (error.message !== 'prepared_samples_do_not_cover_candidate_range' || error.coverage?.status !== 'invalid_window') throw error;
      invalidWindows.push(error.coverage);
    }
  }
  const gapEvidence = invalidWindows.length ? await saveJson(path.join(output, 'invalid-windows.json'), { schema_version: 1,
    original_candidate: original, case_input: caseInput, invalid_windows: invalidWindows, model_calls: 0,
    source_windows_changed: false, silence_padding_applied: false, qualified: false }) : null;
  if (!prepared.length) throw new Error('no_prepared_candidate_windows');
  const filters = [], tasks = encoded.tasks.flatMap((task, i) => {
    if (!inspections.has(i)) return [];
    const retained = inspections.get(i).filter(index => {
      const pointer = expanded.tasks[i].candidates[index].candidate;
      return ready.has(JSON.stringify([pointer.source_sha256, pointer.source_range]));
    });
    filters.push({ original_task_index: i, original_recall_count: task.candidates.length,
      selected_inspection_count: inspections.get(i).length, retained_candidate_indices: retained,
      invalid_inspection_count: inspections.get(i).length - retained.length,
      uninspected_count: task.candidates.length - inspections.get(i).length });
    return [{ ...task, candidates: task.candidates.filter((_, index) => retained.includes(index)) }];
  });
  const candidateFile = await saveJson(path.join(output, 'candidate-bindings.json'), { ...encoded, tasks,
    batch_scope: { original_candidate: original, case_input: caseInput, original_task_count: expanded.tasks.length,
      selected_task_indices: indices, remaining_tasks_pending: expanded.tasks.length - tasks.length,
      inspection_filters: filters, ...(gapEvidence ? { invalid_window_evidence: gapEvidence } : {}),
      scope: 'limited_actual_observation_batch_not_full_work_completion' } });
  const modelConfigs = [];
  const newJobs = prepared.filter(job => !job.reused_actual_input);
  for (const template of newJobs.length ? config.model_configs : []) {
    const model = await readJson(template), backend = model.backend;
    if (!['qwen3_asr', 'panns_sed'].includes(backend)) throw new Error('existing_specialist_backend_required');
    modelConfigs.push(await saveJson(path.join(configs, backend + '-config.json'), { ...model,
      output_dir: path.join(output, backend), ...(backend === 'panns_sed' ? { array_dir: path.join(output, 'event-scores') } : {}),
      jobs: newJobs }));
  }
  return await saveJson(path.join(output, 'preparation-record.json'), { schema_version: 1, original_candidate: original,
    case_input: caseInput, candidate_file: candidateFile, selected_task_indices: indices,
    selected_tasks: tasks.length, unique_windows: prepared.length, jobs: prepared, configs: modelConfigs,
    new_jobs: newJobs, acoustic_jobs: prepared.filter(job => !acousticReady.has(JSON.stringify([job.source_sha256, job.source_window_seconds]))),
    reused_receipts: reusedReceipts, reused_acoustic_receipts: reusedAcousticReceipts,
    ...(config.reuse_preparation_record ? { reuse_preparation_record: config.reuse_preparation_record } : {}),
    invalid_windows: invalidWindows, ...(gapEvidence ? { invalid_window_evidence: gapEvidence } : {}),
    model_calls: 0, qualified: false, artistic_approval: false, production_approval: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareSpecialistCandidateBatch(await readJson(process.argv[2]));
  process.stdout.write(JSON.stringify(result) + '\n');
}
