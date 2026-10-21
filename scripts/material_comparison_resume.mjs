import path from 'node:path';
import { access } from 'node:fs/promises';
import { readJson, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw Error('material_comparison_resume_' + reason); };

// Resume a pending comparison in its original immutable namespace. This loads
// already executed local observations, never inferred or user-entered decisions.
export async function loadPendingMaterialComparison(binding, { source, caseSource, outputDir, runtime }) {
  await verifyEvidenceBindings(binding);
  if (path.resolve(binding.path) !== path.join(path.resolve(outputDir), 'selection-request.json')) fail('original_directory_required');
  try { await access(path.join(outputDir, 'selection-record.json')); fail('completed_record_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const request = await readJson(binding.path);
  if (!same(request.candidate_source, source) || !same(request.case_source, caseSource)) fail('source_binding_changed');
  if (request.backend_id !== runtime.materialSelector_backend_id
    || request.observation_backend_id !== runtime.materialObserver_backend_id
    || request.observation_model_revision !== runtime.materialObserver_model_revision) fail('backend_changed');
  await verifyEvidenceBindings([request.candidate_source, request.case_source, request.observation_files,
    request.visual_files, request.frames, request.invalid_window_registry]);
  const records = new Map();
  for (const reference of request.observation_files ?? []) {
    if (path.basename(reference.path) !== 'material-observation-record.json') continue;
    const value = await readJson(reference.path);
    if (value.protocol !== 'local_audio_model' || value.backend_id !== request.observation_backend_id
      || value.model_revision !== request.observation_model_revision || value.qualified !== false
      || value.artistic_approval !== false || value.production_approval !== false
      || value.observation?.sound_semantics_verified !== false || value.observation?.lyrics_verified !== false)
      fail('unqualified_local_record_required');
    await verifyLocalAudioExecution(value, { protocol: value.protocol, backend_id: value.backend_id, model_revision: value.model_revision });
    const key = JSON.stringify([value.source_sha256, value.source_range, null, null]);
    if (records.has(key) && !same(records.get(key).observations, value.observation)) fail('ambiguous_window');
    records.set(key, { source_sha256: value.source_sha256, source_range: value.source_range,
      actual_audio_processed: true, model_revision: value.model_revision, observations: value.observation,
      observation_record: reference, local_evidence: value.local_evidence,
      // This is the same bound shared table used by the original comparison.
      files: request.observation_files, evidence_status: 'unqualified_research_prediction',
      artistic_approval: false, production_approval: false });
  }
  for (const task of request.tasks ?? []) for (const candidate of task.candidates) {
    if (candidate.observation_contexts || candidate.human_context_review) fail('plain_windows_only');
    const key = JSON.stringify([candidate.source_sha256, candidate.source_range, null, null]);
    if (!records.has(key) || !same(records.get(key).observations, candidate.observation)) fail('observed_window_changed');
  }
  if (!request.tasks?.length || !records.size) fail('observed_tasks_required');
  // saveJson originally used path.resolve; preserving that exact spelling is
  // part of the historical CLI input identity on Windows.
  return { binding: { ...binding, path: path.resolve(binding.path) }, request, observations: records };
}

export function verifyRebuiltMaterialComparison(recovery, request) {
  if (!same(recovery.request, request)) fail('rebuilt_request_changed');
  return recovery.binding;
}
