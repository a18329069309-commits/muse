import path from 'node:path';
import { objectSchema, readJson, saveJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { directionSemanticGaps, inspectDirectionUncertainties } from './direction_semantics.mjs';
import { validateCaseEventAnchors } from './compose_episode.mjs';
import { createDirectionSchemaRepair, mergeDirectionSchemaRepair } from './direction_schema_repair.mjs';
import { decodeStyleRepairAnalysis } from './style_uncertainty_repair.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';

export const directionSemanticFieldRepairRevision = 'direction-words-and-disposition-typed-fields-v1';
export const directionSemanticFieldRepairStage = 'research_style_targeted_semantic_fields_repair';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const pairs = ['evidence_gap/before_specific_edit', 'narrative_constraint/persistent_narrative_constraint',
  'deferred_review/after_trial_render', 'deferred_review/persistent_provenance_limit',
  'pending_work/material_selection', 'pending_work/words_selection'];
function table(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const columns = Object.keys(rows[0]);
  if (rows.some(row => canonical(Object.keys(row).sort()) !== canonical([...columns].sort()))) return rows;
  return { columns, rows: rows.map(row => columns.map(key => row[key])) };
}

// Validate every independent cue/anchor and each disposition before spending a
// call. Only errors covered by this exact bounded repair may remain.
export function preflightDirectionSemanticFields(value, analysis, fullSchema) {
  validateSchema(value, fullSchema);
  const duration = Math.max(...analysis.story_beats.map(row => row.end_seconds));
  validateCaseEventAnchors({ ...value, source_video_sha256: analysis.source_video_sha256 }, analysis, duration);
  const words = [], dispositions = [], known = directionSemanticGaps(value, analysis);
  for (const gap of known) {
    if (!gap.startsWith('words_opportunity_outside_story:')) throw Error('targeted_direction_repair_unrelated_story_gap');
    const cueId = gap.slice('words_opportunity_outside_story:'.length), cueIndex = value.cues.findIndex(cue => cue.cue_id === cueId);
    const cue = value.cues[cueIndex];
    if (!cue?.words_opportunity || !['explore', 'require'].includes(cue.words_candidate_request))
      throw Error('targeted_direction_repair_words_task_identity_required');
    words.push({ field_id: `words_${String(words.length + 1).padStart(3, '0')}`, cue_id: cueId, cue_index: cueIndex });
  }
  for (const [index, disposition] of value.uncertainty_dispositions.entries()) {
    let error = null;
    try { inspectDirectionUncertainties({ ...value, uncertainty_dispositions: [disposition] }, analysis, { mode: 'assisted_trial' }); }
    catch (cause) { error = cause.message; }
    if (!error) continue;
    if (error !== 'direction_evidence_gap_cannot_be_deferred')
      throw Object.assign(Error('targeted_direction_repair_unrelated_uncertainty_gap'), { semantic_error: error });
    for (const [componentIndex, part] of disposition.components.entries()) if (part.kind === 'evidence_gap' && part.required_stage !== 'before_specific_edit') {
      const scope = value.uncertainty_scopes.find(row => row.origin === disposition.origin && row.uncertainty_index === disposition.uncertainty_index);
      const candidates = pairs.filter(pair => pair.startsWith('evidence_gap/')
        || pair.startsWith('narrative_constraint/') && ['story', 'mixed'].includes(scope.impact)
        || pair.startsWith('deferred_review/') && ['music', 'mixed'].includes(scope.impact)
        || pair.startsWith('pending_work/') && ['music', 'words', 'mixed'].includes(scope.impact)
          && (!pair.endsWith('/words_selection') || scope.cue_ids.every(id => {
            const cue = value.cues.find(row => row.cue_id === id); return ['explore', 'require'].includes(cue.words_candidate_request); })));
      // Diagnose basis/condition/identity independently. A legal non-gap kind is
      // a temporary structural probe, never returned as a model decision.
      const probe = structuredClone(disposition), candidate = candidates.find(pair => pair.startsWith('narrative_constraint/'))
        ?? candidates.find(pair => pair.startsWith('deferred_review/'));
      if (candidate) {
        [probe.components[componentIndex].kind, probe.components[componentIndex].required_stage] = candidate.split('/');
        // Other illegal components of this same item are isolated, not masked.
        probe.components = [probe.components[componentIndex]];
        if (probe.components[0].text !== disposition.original_text)
          throw Error('targeted_direction_repair_split_component_needs_distinct_plan');
        inspectDirectionUncertainties({ ...value, uncertainty_dispositions: [probe] }, analysis, { mode: 'assisted_trial' });
      }
      dispositions.push({ field_id: `disposition_${String(dispositions.length + 1).padStart(3, '0')}`,
        disposition_index: index, component_index: componentIndex, origin: disposition.origin,
        uncertainty_index: disposition.uncertainty_index, allowed_pairs: candidates });
    }
  }
  if (!words.length && !dispositions.length) throw Error('targeted_direction_repair_no_supported_gap');
  return { words, dispositions, known_gaps: known, duration };
}

export function directionSemanticFieldPatchSchema(plan, analysis) {
  const beatIds = analysis.story_beats.map(row => row.id);
  const wordSchema = objectSchema({ allowed_target_intervals: { type: 'array', minItems: 1,
    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    anchor_event_ids: { type: 'array', minItems: 1, items: { type: 'string', enum: beatIds } } });
  return objectSchema(Object.fromEntries([...plan.words.map(row => [row.field_id, structuredClone(wordSchema)]),
    ...plan.dispositions.map(row => [row.field_id, { type: 'string', enum: row.allowed_pairs }])]));
}

export function mergeDirectionSemanticFieldPatch(first, patch, plan, analysis, fullSchema) {
  validateSchema(patch, directionSemanticFieldPatchSchema(plan, analysis));
  const merged = structuredClone(first);
  for (const row of plan.words) {
    const cue = merged.cues[row.cue_index], opportunity = patch[row.field_id];
    if (cue.cue_id !== row.cue_id || !opportunity.allowed_target_intervals.every(range => range.every(Number.isFinite)
      && range[0] >= cue.target_range[0] && range[1] <= cue.target_range[1] && range[1] > range[0])
      || new Set(opportunity.anchor_event_ids).size !== opportunity.anchor_event_ids.length
      || opportunity.anchor_event_ids.some(id => !analysis.story_beats.some(beat => beat.id === id
        && opportunity.allowed_target_intervals.some(range => beat.start_seconds < range[1] && beat.end_seconds > range[0]))))
      throw Error('targeted_direction_repair_words_range_or_real_anchor_invalid');
    cue.words_opportunity = structuredClone(opportunity);
  }
  for (const row of plan.dispositions) {
    const disposition = merged.uncertainty_dispositions[row.disposition_index], component = disposition.components[row.component_index];
    if (disposition.origin !== row.origin || disposition.uncertainty_index !== row.uncertainty_index)
      throw Error('targeted_direction_repair_uncertainty_identity_changed');
    [component.kind, component.required_stage] = patch[row.field_id].split('/');
  }
  const frozenCheck = structuredClone(merged);
  for (const row of plan.words) frozenCheck.cues[row.cue_index].words_opportunity = structuredClone(first.cues[row.cue_index].words_opportunity);
  for (const row of plan.dispositions) {
    const part = frozenCheck.uncertainty_dispositions[row.disposition_index].components[row.component_index];
    const before = first.uncertainty_dispositions[row.disposition_index].components[row.component_index];
    part.kind = before.kind; part.required_stage = before.required_stage;
  }
  if (canonical(frozenCheck) !== canonical(first)) throw Error('targeted_direction_repair_frozen_field_changed');
  validateSchema(merged, fullSchema);
  if (directionSemanticGaps(merged, analysis).length) throw Error('targeted_direction_repair_story_semantics_invalid');
  inspectDirectionUncertainties(merged, analysis, { mode: 'assisted_trial' });
  return merged;
}

export async function createDirectionSemanticFieldRepair({ frozenDirection, directory }) {
  await verifyEvidenceBindings(frozenDirection);
  let frozen = await readJson(frozenDirection.path), proofBindings = [], baseKind = 'bound_condition_reconstructed_direction';
  if (frozen.status === 'semantic_invalid' && frozen.request && frozen.final) {
    const failed = frozen;
    await verifyEvidenceBindings([failed.request, failed.final, failed.host_business_contract]);
    const original = await readJson(failed.request.path), contract = projectCompactBusinessContract(original.input);
    if (original.input.stage !== 'research_style_director' || failed.exit_code !== 0 || failed.process_terminated !== true
      || failed.source_video_sha256 !== original.input.data.source_video_sha256
      || canonical(await readJson(failed.host_business_contract.path)) !== canonical(contract.audit))
      throw Error('targeted_direction_repair_completed_model_failure_required');
    const value = restoreCompactBusinessValue(await readJson(failed.final.path), contract);
    frozen = { kind: 'derived_actual_direction_validation', status: 'schema_valid_semantic_invalid',
      value, source_video_sha256: failed.source_video_sha256, original_request: failed.request,
      original_failure: frozenDirection, render_admissible: false, qualified: false, production_approval: false };
    baseKind = 'completed_model_direction_semantic_failure';
    proofBindings = [failed.request, failed.final, failed.host_business_contract];
  }
  if (frozen.kind !== 'derived_actual_direction_validation' || frozen.status !== 'schema_valid_semantic_invalid'
    || frozen.render_admissible !== false || frozen.qualified !== false || frozen.production_approval !== false)
    throw Error('targeted_direction_repair_bound_invalid_reconstruction_required');
  await verifyEvidenceBindings([frozen.original_request, frozen.original_failure]);
  const request = await readJson(frozen.original_request.path), input = request.input;
  if (input.stage !== 'research_style_director' || input.data.source_video_sha256 !== frozen.source_video_sha256)
    throw Error('targeted_direction_repair_original_outcome_mismatch');
  let proven = frozen.value;
  if (baseKind === 'bound_condition_reconstructed_direction') {
    await verifyEvidenceBindings([frozen.actual_typed_patch_receipt, frozen.actual_typed_patch_final]);
    const oldPatch = await readJson(frozen.actual_typed_patch_receipt.path);
    if (oldPatch.status !== 'semantic_invalid' || oldPatch.process_terminated !== true || oldPatch.exit_code !== 0
      || oldPatch.source_video_sha256 !== frozen.source_video_sha256 || oldPatch.final.sha256 !== frozen.actual_typed_patch_final.sha256)
      throw Error('targeted_direction_repair_original_outcome_mismatch');
    await verifyEvidenceBindings(oldPatch.request);
    const conditionRequest = await readJson(oldPatch.request.path);
    await verifyEvidenceBindings(conditionRequest.input?.data?.direction_schema_repair);
    const conditionContext = await readJson(conditionRequest.input.data.direction_schema_repair.path);
    if (conditionRequest.input.stage !== 'research_style_schema_missing_fields_repair'
      || conditionRequest.input.data.source_video_sha256 !== frozen.source_video_sha256
      || conditionContext.failed_receipt?.sha256 !== frozen.original_failure.sha256
      || conditionContext.original_request?.sha256 !== frozen.original_request.sha256)
      throw Error('targeted_direction_repair_condition_patch_source_changed');
    const originalCondition = await createDirectionSchemaRepair({ failedReceipt: frozen.original_failure,
      directory: path.join(directory, 'condition-reconstruction-proof') });
    proven = mergeDirectionSchemaRepair(originalCondition.first, await readJson(frozen.actual_typed_patch_final.path),
      originalCondition.contract, originalCondition.fields);
    if (canonical(proven) !== canonical(frozen.value)) throw Error('targeted_direction_repair_reconstruction_changed');
    proofBindings = [...originalCondition.bindings, oldPatch.request, conditionRequest.input.data.direction_schema_repair,
      frozen.actual_typed_patch_receipt, frozen.actual_typed_patch_final];
  }
  await verifyEvidenceBindings(input.data.completed_story);
  const rawStory = await readJson(input.data.completed_story.path), analysis = decodeStyleRepairAnalysis(rawStory.value ?? rawStory);
  if (analysis.source_video_sha256 !== frozen.source_video_sha256) throw Error('targeted_direction_repair_story_identity_changed');
  const fullSchema = input.schema ?? input.response_schema, plan = preflightDirectionSemanticFields(proven, analysis, fullSchema);
  const context = { revision: directionSemanticFieldRepairRevision, frozen_direction: frozenDirection, base_kind: baseKind,
    original_request: frozen.original_request, complete_story: input.data.completed_story,
    original_failure: frozen.original_failure, condition_patch_receipt: frozen.actual_typed_patch_receipt ?? null,
    editable_words: plan.words, editable_dispositions: plan.dispositions, all_other_fields_frozen: true,
    full_schema_revalidated: true, professional_audio_qualification_granted: false, production_approval: false };
  const contextFile = path.join(directory, 'semantic-field-context.json');
  let contextBinding;
  try { contextBinding = await saveJson(contextFile, context); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (canonical(await readJson(contextFile)) !== canonical(context)) throw Error('targeted_direction_repair_context_changed');
    contextBinding = { path: path.resolve(contextFile), sha256: await hashFile(contextFile) };
  }
  const repairInput = { stage: directionSemanticFieldRepairStage, frames: [], schema: directionSemanticFieldPatchSchema(plan, analysis),
    prompt: 'One targeted semantic repair. Return only typed field IDs in the schema. All existing storyline, cue ranges, music actions, unknown texts/reasons/basis, source identities and other values are immutable. '
      + 'For words fields, choose real supplied story beat IDs and plot-permitted intervals for an eventual complete lyric phrase; do not merely copy VAD gaps, assign a phrase length, cut lyrics or remove the exploration task. '
      + 'For disposition fields select exactly one allowed kind/stage pair based on the unchanged actual uncertainty, impact, basis and retained constraints. '
      + 'A genuine missing fact needed for its specific edit stays evidence_gap/before_specific_edit. A narrative restriction can persist without treating predictions as facts. Listening after rendering only applies to actual postmix review; pending_work only identifies unexecuted selection. '
      + 'Do not resolve genuine evidence gaps just to allow rendering. No original audio listening, confirmed lyrics, selected songs, verified sound facts or professional approval is granted.',
    data: { source_video_sha256: frozen.source_video_sha256, execution_mode: input.data.execution_mode ?? input.data.mode,
      semantic_field_repair: contextBinding, completed_story: input.data.completed_story,
      analysis: { source_video_sha256: analysis.source_video_sha256, story_beats: table(analysis.story_beats),
        sound_events: table(analysis.sound_events), uncertainties: analysis.uncertainties, original_audio: analysis.original_audio },
      analysis_encoding: 'lossless_story_and_sound_event_tables_v1',
      context_reference_policy: 'Decode columns/rows by position. Every story/unknown original value is retained. Uncertainty reference binds the exact origin/index original string; basis references bind the actual beat field in analysis; cue references bind unchanged cue conditions. All frozen source literals remain attached, not re-generated.',
      cue_context: plan.words.map(row => {
        const cue = proven.cues[row.cue_index], fields = ['cue_id', 'target_range', 'case_conditions', 'exclude_case_conditions',
          'story_sequence', 'words_candidate_request', 'words_target_range', 'words_mode', 'words_function',
          'words_audio_retrieval_query', 'words_opportunity', 'vocal_language'];
        return Object.fromEntries(fields.filter(key => Object.hasOwn(cue, key)).map(key => [key, cue[key]]));
      }),
      uncertainty_context: plan.dispositions.map(row => ({ field_id: row.field_id,
        original_text_reference: { origin: row.origin, uncertainty_index: row.uncertainty_index },
        component: (() => {
          const component = proven.uncertainty_dispositions[row.disposition_index].components[row.component_index];
          return { kind: component.kind, required_stage: component.required_stage, reason: component.reason,
            basis: component.basis.map(({ quote, ...ref }) => ref),
            condition_refs: component.condition_refs.map(ref => ({ cue_id: ref.cue_id })),
            retained_constraints: component.retained_constraints };
        })(),
        scope: proven.uncertainty_scopes.find(scope => scope.origin === row.origin && scope.uncertainty_index === row.uncertainty_index) })),
      direction_uncertainties: proven.uncertainties,
      words_fields: plan.words, disposition_fields: plan.dispositions } };
  return { input: repairInput, context, contextBinding, originalInput: input, fullSchema, plan, analysis, first: proven,
    bindings: [frozenDirection, contextBinding, ...proofBindings, frozen.original_request, input.data.completed_story] };
}

// A recovered response is accepted only for the same original direction
// evidence. Rebinding a host file path is allowed only after verifying its
// exact SHA/content; new observations, clocks, prompt/schema or supply differ.
export async function loadDirectionSemanticFieldRecovery(binding, { input, validateValue, expectedModelRevision } = {}) {
  if (typeof validateValue !== 'function' || input?.stage !== 'research_style_director')
    throw Error('direction_recovery_exact_stage_and_semantic_validator_required');
  await verifyEvidenceBindings(binding);
  const raw = await readJson(binding.path), merge = raw.host_field_merge;
  if(raw.host_selected_unknown_merge){const{loadSelectedUnknownRecovery}=await import('./selected_unknown_recovery.mjs');
    return loadSelectedUnknownRecovery(binding,{input,validateValue,expectedModelRevision});}
  if (merge?.revision !== directionSemanticFieldRepairRevision || merge.all_other_fields_changed !== false
    || merge.source_literals_changed !== false || merge.caller_schema_revalidated !== true
    || merge.complete_original_semantic_validator_used !== true || merge.semantic_validator_rerun_after_merge !== true
    || raw.execution_kind !== 'codex_cli_inference' || raw.actual_runtime_executed !== true
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.completion_status !== 'complete'
    || raw.qualified !== false || raw.artistic_approval !== false || raw.production_approval !== false
    || raw.source_video_sha256 !== input.data?.source_video_sha256
    || expectedModelRevision && raw.model_revision !== expectedModelRevision)
    throw Error('direction_recovery_approved_bound_actual_response_required');
  await verifyEvidenceBindings([merge.context, merge.frozen_direction, merge.actual_patch_response, ...raw.evidence_files]);
  const context = await readJson(merge.context.path), original = await readJson(context.original_request.path);
  const prepared = await createDirectionSemanticFieldRepair({ frozenDirection: merge.frozen_direction,
    directory: path.dirname(merge.context.path) });
  if (prepared.contextBinding.sha256 !== merge.context.sha256) throw Error('direction_recovery_context_changed');
  const patch = await readJson(merge.actual_patch_response.path);
  if (patch.execution_kind !== 'codex_cli_inference' || patch.actual_runtime_executed !== true
    || patch.source_video_sha256 !== raw.source_video_sha256 || patch.model_revision !== raw.model_revision
    || !patch.cli_receipts?.length) throw Error('direction_recovery_real_typed_patch_required');
  await verifyEvidenceBindings([...patch.evidence_files, ...patch.cli_receipts]);
  const receipt = await readJson(patch.cli_receipts.at(-1).path);
  await verifyEvidenceBindings([receipt.final, receipt.request, receipt.jsonl]);
  if (receipt.status !== 'complete' || receipt.exit_code !== 0 || receipt.process_terminated !== true
    || receipt.execution_kind !== 'codex_cli_inference' || receipt.request_sha256 !== patch.request_sha256
    || canonical(await readJson(receipt.final.path)) !== canonical(patch.value))
    throw Error('direction_recovery_actual_model_patch_mismatch');
  const reconstructed = mergeDirectionSemanticFieldPatch(prepared.first, patch.value, prepared.plan, prepared.analysis, prepared.fullSchema);
  if (canonical(reconstructed) !== canonical(raw.value)) throw Error('direction_recovery_merged_value_changed');
  async function actualFullRequest(requestInput) {
    const full = requestInput.data?.independent_style_projection?.full_request;
    if (!full) return structuredClone(requestInput);
    await verifyEvidenceBindings(full);
    const value = await readJson(full.path);
    const { projectIndependentStyleEvidence } = await import('./compose_codex_episode.mjs');
    if (canonical(projectIndependentStyleEvidence(value, full).input) !== canonical(requestInput))
      throw Error('direction_recovery_projected_input_or_binding_changed');
    return value;
  }
  async function boundInputIdentity(requestInput) {
    const full = await actualFullRequest(requestInput);
    const mapping = full.data?.source_frame_mapping;
    if (mapping?.path && mapping.sha256) {
      await verifyEvidenceBindings(mapping); const mapped = await readJson(mapping.path);
      if (mapped.source_video_sha256 !== input.data.source_video_sha256 || !Array.isArray(mapped.source_frames))
        throw Error('direction_recovery_frame_mapping_identity_invalid');
      await verifyEvidenceBindings(mapped.source_frames);
      full.data.source_frame_mapping = { verified_source_frames: mapped.source_frames };
    }
    function normalized(value) {
      if (Array.isArray(value)) return value.map(normalized);
      if (!value || typeof value !== 'object') return value;
      const keys = Object.keys(value).filter(key => !(key === 'path' && typeof value.sha256 === 'string'));
      return Object.fromEntries(keys.map(key => [key, normalized(value[key])]));
    }
    await verifyEvidenceBindings(full);
    return canonical(normalized(full));
  }
  if (await boundInputIdentity(input) !== await boundInputIdentity(original.input))
    throw Error('direction_recovery_original_input_or_evidence_changed');
  validateSchema(raw.value, input.schema ?? input.response_schema);
  await validateValue(raw.value);
  return { ...raw, raw_response: binding, reused: true, cli_receipts: [],
    historical_cli_receipts: [...(raw.historical_cli_receipts ?? []), ...(raw.cli_receipts ?? [])] };
}
