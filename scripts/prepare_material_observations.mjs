import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { selectInspectionCandidates } from './material_selection.mjs';

// One model load for all distinct requested source windows. Multiple cases and
// theme-window references share the actual observation, not guessed metadata.
export async function prepareMaterialObservations({ candidate_files, model_config, output_dir }) {
  if (!candidate_files?.length || !model_config) throw new Error('candidate_files_and_model_config_required');
  const output = path.resolve(output_dir); await mkdir(output, { recursive: true });
  const jobs = new Map(), sources = new Map(), inputs = [], config = await readJson(model_config);
  let tasks = 0, inspected = 0;
  for (const file of candidate_files) {
    const document = expandCandidateEvidence(await readJson(file));
    inputs.push({ path: path.resolve(file), sha256: await hashFile(file) });
    for (const task of document.tasks) {
      tasks++;
      for (const candidate of selectInspectionCandidates(task.candidates)) {
        inspected++;
        const pointer = candidate.candidate, source = path.resolve(typeof candidate.source_file === 'string'
          ? candidate.source_file : candidate.source_file.path);
        if (!sources.has(source)) sources.set(source, await hashFile(source));
        if (sources.get(source) !== pointer.source_sha256) throw new Error('candidate_observation_source_changed');
        const key = JSON.stringify([pointer.source_sha256, pointer.source_range]);
        if (!jobs.has(key)) jobs.set(key, { id: 'candidate-' + shaBytes(key).slice(0, 24), source_file: source,
          source_sha256: pointer.source_sha256, source_window_seconds: pointer.source_range,
          segment_id: pointer.segment_id });
      }
    }
  }
  if (!jobs.size) throw new Error('no_actual_candidate_windows');
  const batch = { ...config, output_dir: path.join(output, 'actual-inference'), jobs: [...jobs.values()],
    gpu_queue_reservation: config.gpu_queue_reservation ?? 'single-local-gpu-queue/material-candidate-batch' };
  delete batch.labels_file;
  const configFile = await saveJson(path.join(output, 'model-jobs.json'), batch);
  return await saveJson(path.join(output, 'preparation-record.json'), { schema_version: 1,
    candidate_inputs: inputs, model_configuration: { path: path.resolve(model_config), sha256: await hashFile(model_config) },
    tasks, requested_windows: inspected, unique_windows: jobs.size, config: configFile,
    model_calls: 0, production_approval: false, artistic_approval: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareMaterialObservations(await readJson(process.argv[2]));
  const record = await readJson(result.path);
  process.stdout.write(JSON.stringify({ preparation: result, unique_windows: record.unique_windows }) + '\n');
}
