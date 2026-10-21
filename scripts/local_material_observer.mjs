import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const identity = (sha, range) => JSON.stringify([sha, range]);
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });

// Reuse one actual batched local inference run. This is evidence ingestion, not
// a filename classifier, a new model call or a listening qualification.
export async function createLocalMaterialObserver({ receipts, model_revision,
  backend_id = 'qwen2_5_omni_3b_author' }) {
  if (!receipts?.length || !model_revision) throw new Error('local_material_runs_required');
  const windows = new Map();
  for (const file of receipts) {
    await verifyEvidenceBindings([file]);
    const run = await readJson(file.path);
    if (run.backend !== backend_id || run.model_revision !== model_revision || run.qualified !== false
      || !run.research_only || !['research_probe_complete', 'stopped_failed_probe'].includes(run.status))
      throw new Error('local_material_research_run_required');
    for (const job of run.jobs ?? []) {
      if (job.status !== 'research_prediction') continue;
      const rawFile = job.files?.[0];
      if (!rawFile) throw new Error('local_material_raw_result_required');
      await verifyEvidenceBindings([rawFile]);
      const raw = await readJson(rawFile.path);
      if (raw.status !== 'research_prediction' || raw.actual_audio_processed !== true
        || raw.model_revision !== model_revision || !Number.isSafeInteger(raw.forward_calls) || raw.forward_calls <= 0
        || !Number.isSafeInteger(raw.audio_encoder_forward_calls) || raw.audio_encoder_forward_calls <= 0
        || !Array.isArray(raw.source_range) || raw.source_range.length !== 2
        || raw.source_range.some(value => !Number.isFinite(value)) || raw.source_range[0] < 0
        || raw.source_range[1] <= raw.source_range[0] || !Number.isFinite(raw.duration_seconds)
        || Math.abs(raw.duration_seconds - (raw.source_range[1] - raw.source_range[0])) > 1 / 16000 + 1e-8
        || !raw.prediction || !raw.input_file || !raw.input_sha256 || !raw.source_file || !raw.source_sha256
        || JSON.stringify(raw.source_range) !== JSON.stringify(job.source_range)
        || raw.source_sha256 !== job.source_sha256 || raw.input_sha256 !== job.input_sha256)
        throw new Error('local_material_actual_forward_binding_required');
      const input = { path: raw.input_file, sha256: raw.input_sha256 };
      await verifyEvidenceBindings([input, { path: raw.source_file, sha256: raw.source_sha256 }]);
      const key = identity(raw.source_sha256, raw.source_range);
      const prior = windows.get(key);
      if (prior && prior.rawFile.sha256 !== rawFile.sha256) throw new Error('local_material_window_ambiguous');
      windows.set(key, { raw, rawFile, input, runFile: file, calibration: run.calibration ?? null });
    }
  }
  return { materialObserver_backend_id: 'local_audio_model/' + backend_id,
    materialObserver_model_revision: model_revision,
    materialObserver: async (job, directory) => {
      const row = windows.get(identity(job.source_sha256, job.source_range));
      if (!row) throw new Error('local_material_window_not_observed');
      const source = { path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
        sha256: job.source_sha256 };
      await verifyEvidenceBindings([source, row.runFile, row.rawFile, row.input]);
      await mkdir(directory, { recursive: true });
      const evidence = await saveJson(path.join(directory, 'local-audio-evidence.json'), {
        schema_version: 1, protocol: 'local_audio_model', backend_id, model_revision,
        source_sha256: job.source_sha256, source_range: job.source_range, input_audio: row.input,
        execution: { actual_audio_processed: true, forward_count: row.raw.forward_calls,
          audio_encoder_forward_count: row.raw.audio_encoder_forward_calls,
          input_audio_sha256: row.input.sha256, model_revision }, raw_result: row.rawFile,
        run: row.runFile, qualified: false, artistic_approval: false, production_approval: false });
      return { source_sha256: job.source_sha256, source_range: job.source_range,
        actual_audio_processed: true, model_revision,
        observations: { ...row.raw.prediction, lyrics_verified: false,
          sound_semantics_verified: false, calibration: row.calibration, time_resolution: 'input_window',
          limitation: 'Unqualified local prediction; no phrase boundaries or artistic approval are inferred.' },
        files: [row.runFile, row.rawFile, row.input, evidence], local_evidence: evidence,
        evidence_status: 'unqualified_research_prediction', artistic_approval: false, production_approval: false };
    } };
}

export { bound as bindLocalMaterialReceipt };
