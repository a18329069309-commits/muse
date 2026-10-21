// Connect real, frozen specialist runs to distillEpisode's research observer.
// This adapter does not infer scene meaning or grant listening qualification.
import path from 'node:path';
import { readJson, saveJson, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import {validSpecialistDevice} from './specialist_cache_identity.mjs';

const supported = new Set(['qwen3_asr', 'qwen3_forced_aligner', 'panns_sed']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
async function checked(file) {
  if (!file?.path || !file.sha256 || await hashFile(file.path) !== file.sha256)
    throw new Error('specialist_evidence_changed');
  const value = await readJson(file.path);
  if (await hashFile(file.path) !== file.sha256) throw new Error('specialist_evidence_changed');
  return value;
}

export async function createSpecialistResearchObserver({ receipts, requiredBackends }) {
  if (!receipts?.length || !requiredBackends?.length
    || new Set(requiredBackends).size !== requiredBackends.length
    || requiredBackends.some(name => !supported.has(name)))
    throw new Error('explicit_specialist_runs_required');
  const runs = [];
  for (const file of receipts) {
    const run = await checked(file);
    if (!supported.has(run.backend) || !run.model_revision || !run.model_sha256
      || run.qualified !== false || run.status !== 'completed_unqualified'
      ||run.device!==undefined&&!validSpecialistDevice(run.device))
      throw new Error('specialist_research_run_required');
    const windows = new Map();
    for (const job of run.jobs ?? []) {
      if (job.status !== 'predicted') continue;
      const rawFile = { path: job.raw_receipt, sha256: job.raw_sha256 };
      const raw = await checked(rawFile);
      const key = JSON.stringify([raw.source_sha256, raw.source_window_seconds]);
      windows.set(key, [...(windows.get(key) ?? []), { job, rawFile }]);
    }
    runs.push({ file, run, windows });
  }
  if (requiredBackends.some(backend => !runs.some(({ run }) => run.backend === backend)))
    throw new Error('required_specialist_backend_missing');
  const modelRevision = shaBytes(JSON.stringify(runs.map(({ file, run }) => ({
    receipt: file.sha256, backend: run.backend, revision: run.model_revision, weights: run.model_sha256,device:run.device,
  }))));
  const observer = async (input, outputDir) => {
    if (!input.source_video_sha256 || !input.input_audio?.path || !input.source_range
      || await hashFile(input.input_audio.path) !== input.input_audio.sha256)
      throw new Error('specialist_input_binding_required');
    const predictions = [], evidence = [], evidenceFiles = [];
    for (const { file, run, windows } of runs) {
      await checked(file);
      const selected = windows.get(JSON.stringify([input.source_video_sha256, input.source_range])) ?? [];
      for (const { job, rawFile } of selected) {
        const raw = await checked(rawFile);
        if (raw.source_sha256 !== input.source_video_sha256 || !same(raw.source_window_seconds, input.source_range)) continue;
        if (raw.input_sha256 !== input.input_audio.sha256 || !Number.isSafeInteger(raw.forward_calls) || raw.forward_calls <= 0
          || job.forward_calls !== raw.forward_calls || raw.qualified !== false
          || raw.status !== 'predicted' || !Number.isFinite(raw.duration_seconds)
          || Math.abs(raw.duration_seconds - (input.source_range[1] - input.source_range[0])) > 1 / 16000)
          throw new Error('specialist_actual_input_or_forward_evidence_mismatch');
        let payload;
        if (run.backend === 'qwen3_asr') {
          payload = { raw_output: raw.raw_output, parsed: raw.parsed,
            transcription_is_unverified_prediction: true, lyrics_verified: false };
        } else if (run.backend === 'qwen3_forced_aligner') {
          const valid = Array.isArray(raw.units) && raw.units.length > 0 && raw.units.every(unit =>
            Number.isFinite(unit.start_time) && Number.isFinite(unit.end_time)
            && unit.start_time >= 0 && unit.start_time < unit.end_time && unit.end_time <= raw.duration_seconds);
          payload = { provided_transcript: raw.provided_transcript, units: raw.units,
            positive_duration_units_in_bounds: valid, audible_text_verified: false, lyrics_verified: false };
        } else {
          if (!raw.scores_file || await hashFile(raw.scores_file) !== raw.scores_sha256)
            throw new Error('specialist_event_scores_changed');
          payload = { top_labels: raw.top_labels, human_activity_scores: raw.human_activity_scores,
            time_resolution: run.time_resolution, scores: { path: raw.scores_file, sha256: raw.scores_sha256 },
            exact_event_onsets_verified: false };
          evidenceFiles.push(payload.scores);
        }
        predictions.push({ backend_id: run.backend, model_revision: run.model_revision,
          ...(run.device!==undefined?{device:run.device}:{}),
          model_sha256: run.model_sha256, source_range: input.source_range,
          scope: run.time_resolution, ...payload, qualified: false });
        evidence.push({ run: file, raw: rawFile });
        evidenceFiles.push(file, rawFile);
      }
    }
    for (const backend of requiredBackends) {
      if (predictions.filter(item => item.backend_id === backend).length !== 1)
        throw new Error('specialist_window_missing_or_ambiguous:' + backend);
    }
    const response = { model: 'local-specialists/research', backend_id: 'local_specialist_receipts',
      model_revision: modelRevision, source_video_sha256: input.source_video_sha256,
      source_range: input.source_range, completion_status: 'complete', actual_input_processed: true,
      actual_video_processed: false,
      evidence_files: [...new Map(evidenceFiles.map(file => [path.resolve(file.path), file])).values()],
      value: { predictions, evidence, sound_semantics_verified: false, lyrics_verified: false,
        artistic_approval: false, limitations: ['Audio-only specialist predictions; director must inspect actual picture and sound.',
          'Class probabilities and provided-text alignment do not verify words, scene suitability or precise event onsets.'] } };
    const result = await saveJson(path.join(outputDir, 'specialist-runtime-response.json'), response);
    return { ...response, raw_response: result };
  };
  observer.version = 'specialist-research-v1/' + modelRevision;
  observer.backend_id = 'local_specialist_receipts';
  observer.model_revision = modelRevision;
  return observer;
}

export { binding as bindSpecialistReceipt };
