import path from 'node:path';
import { objectSchema, readJson, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { loadBoundAssemblyRecovery } from './research_assembly_resume.mjs';

const validated = new WeakSet();
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('diagnostic_editing_caveats_' + reason); };
const reference = objectSchema({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
export const diagnosticEditingCaveatsSchema = objectSchema({
  schema_version: { type: 'integer', enum: [1] }, kind: { type: 'string', enum: ['independent_diagnostic_editing_caveats'] },
  source_video_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, edits: reference, actual_raw_response: reference,
  assembly_recovery: reference, reviewer_kind: { type: 'string', enum: ['codex_text_contract_review'] },
  caveats: { type: 'array', minItems: 1, items: objectSchema({ uncertainty_index: { type: 'integer', minimum: 0 },
    text: { type: 'string' }, category: { type: 'string', enum: ['prediction_precision_pending',
      'whole_window_measurement_limit', 'omission_retains_original'] } }) },
  classifies_text_only: { type: 'boolean', enum: [true] }, actual_audio_listened: { type: 'boolean', enum: [false] },
  professional_qualification: { type: 'boolean', enum: [false] }, production_approval: { type: 'boolean', enum: [false] }
});

// Finite text contracts, not an open natural-language waiver. Every original word
// is retained. A new assertion or warning requires its own separately reviewed
// contract; applying an allowed category label cannot conceal an extra problem.
const permitted = {
  prediction_precision_pending: /^对白避让仅作为局部混音参数，不能按未核准VAD自动宣称已完成精确包络；非对白处恢复各片段名义增益。$/u,
  whole_window_measurement_limit: /^整窗实测RMS与[+-]?(?:\d+(?:\.\d+)?|\.\d+) dB (?:rising|falling|stable)不能证明各编辑子区间的电平、密度或情绪发展；峰值余量及实际可懂度未核验。$/u,
  omission_retains_original: /^声音事件的omit仅指不新增素材，不删除或替换原声；空源的0锚值不代表实际瞬态同步。$/u
};
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export async function loadDiagnosticEditingCaveats(binding, { sourceSha, editsBinding, edits, config } = {}) {
  if (!isIndependentMusicPackTrial(config)) fail('independent_trial_required');
  await validateIndependentMusicPackPolicy(config, { outputDirectory: config.output_dir ?? config.output_directory
    ?? (editsBinding?.path ? path.dirname(editsBinding.path) : undefined) });
  await verifyEvidenceBindings(binding); const review = await readJson(binding.path);
  validateSchema(review, diagnosticEditingCaveatsSchema);
  if (review.source_video_sha256 !== sourceSha || review.edits.sha256 !== editsBinding?.sha256) fail('source_or_edits_changed');
  await verifyEvidenceBindings([editsBinding, review.edits, review.actual_raw_response, review.assembly_recovery]);
  const boundEdits = await readJson(review.edits.path);
  if (!same(edits, boundEdits) || !same(await readJson(editsBinding.path), boundEdits)) fail('original_edits_changed');
  if (!Array.isArray(edits.uncertainties) || edits.uncertainties.length !== review.caveats.length) fail('every_original_uncertainty_required');
  for (let index = 0; index < review.caveats.length; index++) {
    const row = review.caveats[index];
    if (row.uncertainty_index !== index || row.text !== edits.uncertainties[index] || !permitted[row.category]?.test(row.text))
      fail('unrecognized_or_changed_caveat');
    if (row.category === 'omission_retains_original' && (!Array.isArray(edits.sounds) || edits.sounds.some(sound =>
      sound.decision !== 'omit' || sound.original_status !== 'unknown' || sound.selected_segment_id !== null || sound.source_range !== null)))
      fail('original_sound_retention_required');
  }
  const recovery = await readJson(review.assembly_recovery.path);
  if (recovery.response?.sha256 !== review.actual_raw_response.sha256 || recovery.source_video_sha256 !== sourceSha)
    fail('original_response_binding_required');
  await verifyEvidenceBindings(recovery.caller); const caller = await readJson(recovery.caller.path);
  await verifyEvidenceBindings(caller.data?.full_input); const complete = await readJson(caller.data.full_input.path);
  const original = await loadBoundAssemblyRecovery(review.assembly_recovery, {
    inputs: caller.data.bound_artifacts, schema: caller.schema, source: complete.data.source
  });
  if (original.raw_response.sha256 !== review.actual_raw_response.sha256 || !same(original.value.edits, edits))
    fail('actual_original_edit_decisions_required');
  const result = freeze({ ...review, binding: structuredClone(binding), edits_identity: canonical(edits),
    actual_original_stage: original.stage, new_model_calls: 0, formal_adoption_allowed: false,
    review_scope: 'finite_text_contracts_only_original_warnings_retained_actual_mix_listening_pending' });
  validated.add(result); return result;
}

export function allowsDiagnosticEditingCaveats(review, { sourceSha, edits } = {}) {
  return validated.has(review) && review.source_video_sha256 === sourceSha && review.edits_identity === canonical(edits);
}
