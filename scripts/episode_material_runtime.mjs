// API transport for the existing research-material contract. Construction sends no requests.
import path from 'node:path';
import { ApiSession, readJson, saveJson, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { caseImageEvidence, createApiMaterialObserver, materialSelectionSchema } from './material_selection.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const isBinding = value => path.isAbsolute(value?.path ?? '') && /^[a-f0-9]{64}$/.test(value?.sha256 ?? '');
const taskKey = task => JSON.stringify([task.case_id, task.step_id,
  task.kind ?? task.attempts?.[0]?.query.asset_kind,
  task.sound_role ?? task.candidates?.[0]?.binding?.sounds?.[0]?.sound_role ?? null]);

async function verifySelectionRequest(request) {
  const input = request.input ?? request.input_file;
  if (!isBinding(input)) throw Error('material_selector_bound_input_required');
  await verifyEvidenceBindings(input);
  const frozen = await readJson(input.path), { input: _input, input_file: _file, ...submitted } = request;
  if (!same(frozen, submitted)) throw Error('material_selector_request_input_mismatch');
  if (!isBinding(frozen.candidate_source) || !isBinding(frozen.case_source)
    || !Array.isArray(frozen.tasks) || !frozen.tasks.length || !Array.isArray(frozen.observation_files)
    || !frozen.observation_files.length || !Array.isArray(frozen.frames) || !Array.isArray(frozen.visual_files))
    throw Error('material_selector_actual_evidence_required');
  await verifyEvidenceBindings(frozen);
  const encoded = await readJson(frozen.candidate_source.path);
  await verifyEvidenceBindings(encoded);
  const candidates = expandCandidateEvidence(encoded), cases = await readJson(frozen.case_source.path);
  const byCase = new Map(cases.cases.map(item => [item.case_id, item]));
  const observed = [];
  for (const file of frozen.observation_files) {
    if (!isBinding(file)) throw Error('material_selector_bound_observation_required');
    if (path.extname(file.path).toLowerCase() !== '.json') continue;
    const record = await readJson(file.path);
    if (record.actual_audio_processed === true && record.source_sha256 && record.source_range
      && record.model_revision && (record.observation || record.observations)) {
      await verifyEvidenceBindings(record); observed.push(record);
    }
  }
  const seen = new Set();
  for (const task of frozen.tasks) {
    const identity = taskKey(task), original = candidates.tasks.find(row => taskKey(row) === identity
      && row.attempts[0]?.query.asset_kind === task.kind);
    if (seen.has(identity) || !original || !byCase.has(task.case_id) || !task.candidates?.length)
      throw Error('material_selector_source_task_mismatch');
    seen.add(identity);
    for (const candidate of task.candidates) {
      const source = original.candidates.find(row => row.candidate.segment_id === candidate.segment_id);
      if (!source || source.candidate.source_sha256 !== candidate.source_sha256
        || source.candidate.asset_id !== candidate.asset_id || !same(source.candidate.source_range, candidate.source_range))
        throw Error('material_selector_source_candidate_mismatch');
      const file = typeof source.source_file === 'string' ? source.source_file : source.source_file?.path;
      if (!path.isAbsolute(file ?? '') || await hashFile(file) !== candidate.source_sha256)
        throw Error('material_selector_candidate_source_changed');
      if (!observed.some(record => record.source_sha256 === candidate.source_sha256
        && same(record.source_range, candidate.source_range) && record.model_revision === candidate.model_revision
        && same(record.observation ?? record.observations, candidate.observation)))
        throw Error('material_selector_actual_window_observation_required');
    }
  }
  const caseItems = [...new Set(frozen.tasks.map(task => task.case_id))].map(id => byCase.get(id));
  const context = caseItems.map(item => ({ case_id: item.case_id, description: item.description, conditions: item.conditions,
    story_sequence: item.story_sequence, development_preset: item.development_preset, uncertainties: item.uncertainties }));
  if (!same(context, frozen.case_context)) throw Error('material_selector_case_context_mismatch');
  const visual = await caseImageEvidence(caseItems);
  if (!same(visual.frames, frozen.frames) || !same(visual.files, frozen.visual_files))
    throw Error('material_selector_case_frames_mismatch');
  return { input, frozen };
}

export function createApiMaterialSelector(session, { execution_kind } = {}) {
  if (!(session instanceof ApiSession)) throw Error('material_selector_api_session_required');
  return async (request, directory) => {
    const { input, frozen } = await verifySelectionRequest(request);
    const { prompt, response_schema: _schema, frames, ...data } = frozen;
    const response = await session.director({ stage: 'auto_candidate_selection', schema: materialSelectionSchema,
      prompt: prompt + '\nYou receive bound audio observations and images. You did not hear their PCM. '
        + 'Keep predictions, unknowns and source windows unchanged; this is research selection without listening or artistic approval.',
      data: { ...data, selection_input: input }, frames });
    await verifySelectionRequest(request);
    await verifyEvidenceBindings(response.raw_response);
    if (!response.model?.trim() || !response.request_id || response.finish_reason !== 'complete'
      || !isBinding(response.raw_response)) throw Error('material_selector_actual_api_response_required');
    const value = validateSchema(response.value, materialSelectionSchema);
    const raw = await saveJson(path.join(directory, 'api-material-selection-response.json'), {
      input_sha256: input.sha256, model: response.model, value, provider_raw_response: response.raw_response,
      request_id: response.request_id, actual_input_processed: true,
      actual_runtime_executed: response.finish_reason === 'complete', completion_status: response.finish_reason,
      ...(execution_kind ? { execution_kind } : {}), audio_submitted_to_director: false,
      qualified: false, qualification_granted: false, artistic_approval: false, production_approval: false });
    return { input_sha256: input.sha256, model: response.model, value, raw_response: raw,
      request_id: response.request_id, actual_input_processed: true,
      actual_runtime_executed: response.finish_reason === 'complete', completion_status: response.finish_reason,
      ...(execution_kind ? { execution_kind } : {}) };
  };
}

// A caller supplies the session/factory; this adapter never reads credentials or enables a budget.
export async function createEpisodeMaterialRuntime(runtime = {}, sessionContext = {}) {
  const result = { ...runtime };
  if (typeof runtime.materialObserver === 'function' && typeof runtime.materialSelector === 'function') return result;
  const session = runtime.session ?? (typeof runtime.createSession === 'function' ? await runtime.createSession(sessionContext) : null);
  if (!(session instanceof ApiSession)) return result;
  result.session = session;
  if (typeof runtime.materialObserver !== 'function') Object.assign(result, createApiMaterialObserver(session));
  if (typeof runtime.materialSelector !== 'function') {
    result.materialSelector = createApiMaterialSelector(session, runtime);
    result.materialSelector_backend_id = 'openai_responses';
    result.materialSelector_model_revision = 'gpt-6.1-sol';
  }
  return result;
}
