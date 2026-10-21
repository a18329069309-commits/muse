import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJson, saveJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { directionSemanticGaps, inspectDirectionUncertainties } from './direction_semantics.mjs';
import { verifyDirectionInputProjection } from './direction_input_projection.mjs';
import { styleUncertaintyRepairRevision, styleUncertaintyRepairFields, styleUncertaintyRepairSchema,
  mergeStyleUncertaintyRepair, styleUncertaintyRepairPrompt, decodeStyleRepairAnalysis } from './style_uncertainty_repair.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue, compactBusinessRevision, compactDirectionRevision } from './compact_business_contract.mjs';
import { directionSemanticFieldRepairRevision, loadDirectionSemanticFieldRecovery } from './direction_semantic_field_repair.mjs';
import {restoreHostExecutionNotesInput} from './typed_bounded_style_director.mjs';
import {reloadDirectionExecutionBasis} from './bound_direction_execution_evidence.mjs';
import {selectedUnknownRecoveryRevision} from './selected_unknown_recovery.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw new Error(`research_direction_${reason}`); };
const captures = new WeakSet();
// A copied evidence file keeps its identity; every clock, SHA and non-path field remains significant.
function identity(value) {
  if (Array.isArray(value)) return value.map(identity);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(key === 'path' && (value.sha256 || value.actual_sha256)))
    .map(([key, item]) => [key, identity(item)]));
}
async function binding(value) {
  if (!value?.path || !path.isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) fail('explicit_binding_required');
  await verifyEvidenceBindings(value); return value;
}

export async function hydrateDirectionIntent(input, upstream) {
  let actual;
  if (input.data?.independent_style_projection) {
    const full = await binding(input.data.independent_style_projection.full_request);
    actual = await readJson(full.path);
    const { projectIndependentStyleEvidence } = await import('./compose_codex_episode.mjs');
    if (!same(projectIndependentStyleEvidence(actual, full).input, input)) fail('independent_style_projection_changed');
  } else actual = await verifyDirectionInputProjection(input);
  actual=restoreHostExecutionNotesInput(actual);
  if (!actual.frames?.length && upstream.input.frames.length) {
    const story = actual.data?.completed_story, mapping = actual.data?.source_frame_mapping;
    await binding(story); await binding(mapping);
    const storyRaw = await readJson(story.path), mapped = await readJson(mapping.path);
    if (!same(storyRaw.value ?? storyRaw, upstream.analysis.value) || mapped.source_video_sha256 !== upstream.source_video_sha256
      || !same(identity(mapped.source_frames), identity(upstream.input.frames))
      || actual.data.frame_policy !== 'Previously analyzed complete frames; this stage consumes the bound analysis, not a fresh image or audio observation.')
      fail('completed_story_projection_changed');
    delete actual.data.completed_story; delete actual.data.source_frame_mapping; delete actual.data.frame_policy;
    actual.frames = upstream.input.frames;
  }
  if (!same(identity(actual), identity(upstream.input))) fail('direction_request_intent_changed');
  return actual;
}

async function compactDirectionCompletion({ raw, receipt, payload }) {
  const contract = projectCompactBusinessContract(payload.input), reconstruction = raw.host_contract_reconstruction;
  await verifyEvidenceBindings([reconstruction.audit, receipt.host_business_contract, receipt.final, receipt.schema, receipt.prompt, receipt.jsonl]);
  if (reconstruction.revision !== compactBusinessRevision || reconstruction.audit.sha256 !== receipt.host_business_contract.sha256
    || reconstruction.host_input_identity_restored !== true || reconstruction.caller_schema_revalidated !== true
    || reconstruction.source_clocks_or_facts_rewritten !== false
    || !same(await readJson(reconstruction.audit.path), contract.audit)) fail('compact_host_contract_changed');
  const wire = await readJson(receipt.final.path);
  if (!same(wire, reconstruction.model_value) || !same(await readJson(receipt.schema.path), contract.wireSchema)
    || !same(restoreCompactBusinessValue(wire, contract), raw.value)) fail('compact_host_reconstruction_changed');
  if (!(await readFile(receipt.prompt.path, 'utf8')).endsWith('\n' + JSON.stringify({ role: payload.role, input: contract.input })))
    fail('actual_direction_stdin_changed');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!events.some(row => row.type === 'turn.completed') || events.some(row => ['turn.failed', 'error'].includes(row.type))
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), wire))
    fail('compact_actual_model_event_changed');
}

async function thinStyleCompletion({ raw, receipt, payload, request }) {
  const merge = raw.host_field_merge;
  if (![styleUncertaintyRepairRevision, styleUncertaintyRepairRevision + ':' + compactDirectionRevision].includes(merge.revision)
    || !same(merge.editable_fields, styleUncertaintyRepairFields)
    || merge.business_fields_changed !== false || merge.semantic_validator_rerun_after_merge !== true)
    fail('thin_style_merge_contract_changed');
  await verifyEvidenceBindings([merge.first_schema_valid_final, merge.patch_final, merge.frozen_business, merge.full_schema,
    receipt.style_semantic_repair, receipt.repair_bindings, receipt.final, receipt.schema, receipt.prompt, receipt.jsonl]);
  const context = await readJson(receipt.style_semantic_repair.path);
  if (context.revision !== merge.revision || !same(context.editable_fields, merge.editable_fields)
    || !same(context.first_schema_valid_final, merge.first_schema_valid_final)
    || !same(context.frozen_business, merge.frozen_business) || !same(receipt.final, merge.patch_final)
    || !same(context.output_schema, receipt.schema)) fail('thin_style_evidence_binding_changed');
  await binding(context.failed_receipt);
  const failed = await readJson(context.failed_receipt.path);
  await verifyEvidenceBindings([failed.request, failed.final, failed.schema, failed.prompt, failed.jsonl]);
  if (failed.status !== 'semantic_invalid' || failed.exit_code !== 0 || failed.process_terminated !== true
    || failed.request_sha256 !== raw.request_sha256 || failed.request.sha256 !== request.sha256
    || failed.source_video_sha256 !== raw.source_video_sha256 || failed.execution_kind !== 'codex_cli_inference'
    || failed.model_requested !== raw.model || failed.model_revision !== raw.model_revision
    || failed.cli_invocations !== 1 || failed.timed_out !== false
    || !same(failed.final, merge.first_schema_valid_final) || context.semantic_error !== failed.detail)
    fail('thin_style_original_failure_changed');
  const firstWire = await readJson(merge.first_schema_valid_final.path), patchWire = await readJson(merge.patch_final.path);
  const firstContract = typeof firstWire.business_json === 'string' ? projectCompactBusinessContract(payload.input) : null;
  const first = firstContract ? restoreCompactBusinessValue(firstWire, firstContract) : firstWire;
  const fullSchema = await readJson(merge.full_schema.path), expected = structuredClone(payload.input.schema);
  if (!same(fullSchema, expected)) {
    if (!expected.properties.source_video_sha256) fail('actual_direction_output_schema_changed');
    expected.properties.source_video_sha256 = { ...expected.properties.source_video_sha256, enum: [raw.source_video_sha256] };
    if (!same(fullSchema, expected)) fail('actual_direction_output_schema_changed');
  }
  validateSchema(first, fullSchema);
  if (firstContract) {
    await verifyEvidenceBindings([failed.host_business_contract, context.host_restored_first]);
    if (!same(await readJson(failed.host_business_contract.path), firstContract.audit)
      || !same(await readJson(context.host_restored_first.path), first)) fail('thin_style_original_compact_contract_changed');
  }
  let firstSubmitted = payload.input;
  if (failed.prompt_projection === 'director-schema-once-v1') {
    const reduced = structuredClone(payload.input); for (const key of ['schema', 'response_schema']) delete reduced[key];
    const projection = failed.prompt_projection_audit;
    if (!projection || projection.full_request?.sha256 !== request.sha256
      || projection.revision !== 'director-schema-once-v1'
      || projection.full_input_sha256 !== shaBytes(canonical(payload.input))
      || projection.prompt_input_sha256 !== shaBytes(canonical(reduced))
      || !same(projection.omitted_fields, ['schema', 'response_schema'].filter(key => Object.hasOwn(payload.input, key))))
      fail('thin_style_original_projection_changed');
    firstSubmitted = reduced;
  } else if (failed.prompt_projection !== 'full_input') fail('thin_style_original_projection_changed');
  if (firstContract) firstSubmitted = firstContract.input;
  if (!(await readFile(failed.prompt.path, 'utf8')).endsWith('\n' + JSON.stringify({ role: payload.role, input: firstSubmitted })))
    fail('thin_style_original_stdin_changed');
  const firstEvents = (await readFile(failed.jsonl.path, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!firstEvents.some(row => row.type === 'turn.completed') || firstEvents.some(row => ['turn.failed', 'error'].includes(row.type))
    || !same(JSON.parse(firstEvents.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), firstWire))
    fail('thin_style_original_event_changed');
  if (!same(await readJson(failed.schema.path), firstContract?.wireSchema ?? fullSchema)) fail('thin_style_schema_changed');
  const frozen = Object.fromEntries(Object.entries(first).filter(([key]) => !styleUncertaintyRepairFields.includes(key)));
  if (!same(await readJson(merge.frozen_business.path), frozen)
    || context.frozen_business_value_sha256 !== shaBytes(canonical(frozen))) fail('thin_style_frozen_business_changed');
  const actual = await verifyDirectionInputProjection(payload.input);
  let analysis = actual.data.analysis;
  if (actual.data.completed_story) {
    await binding(actual.data.completed_story); const story = await readJson(actual.data.completed_story.path); analysis = story.value ?? story;
  }
  const repairData = context.compact_repair_contract ? context.repair_input.data : context.repair_input;
  if (repairData.source_video_sha256 !== raw.source_video_sha256
    || !same(decodeStyleRepairAnalysis(repairData.analysis), analysis)
    || repairData.complete_actual_analysis_sha256 !== shaBytes(canonical(analysis))
    || !same(repairData.direction_uncertainties, first.uncertainties ?? [])) fail('thin_style_actual_story_changed');
  const fields = ['cue_id', 'target_range', 'case_conditions', 'words_candidate_request', 'words_target_range', 'words_opportunity'];
  const cues = (first.cues ?? []).map(cue => Object.fromEntries(fields.filter(key => Object.hasOwn(cue, key)).map(key => [key, cue[key]])));
  if (!same(repairData.cue_context, cues) || !same(repairData.cue_projection_fields, fields)
    || !(await readFile(receipt.prompt.path, 'utf8') === styleUncertaintyRepairPrompt(context))) fail('thin_style_actual_stdin_changed');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!events.some(row => row.type === 'turn.completed') || events.some(row => ['turn.failed', 'error'].includes(row.type))
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), patchWire))
    fail('thin_style_patch_event_changed');
  let patch = patchWire;
  if (context.compact_repair_contract) {
    const data = { source_video_sha256: payload.input.data.source_video_sha256,
      execution_mode: actual.data?.execution_mode ?? actual.data?.mode,
      analysis, analysis_encoding: 'lossless_story_and_sound_event_tables_v1', complete_actual_analysis_sha256: shaBytes(canonical(analysis)),
      cue_context: cues, direction_uncertainties: first.uncertainties ?? [], sound_queries_frozen_in_business_file: true,
      cue_projection_fields: fields, full_business_is_bound_and_host_preserved: true,
      rejected_editable_fields_in_bound_final: { binding: context.first_schema_valid_final, fields: styleUncertaintyRepairFields },
      compact_direction_revision: compactDirectionRevision };
    const repairContract = projectCompactBusinessContract({ stage: 'research_style_uncertainty_repair', schema: styleUncertaintyRepairSchema(fullSchema), data });
    await verifyEvidenceBindings(context.compact_repair_contract);
    if (!same(await readJson(context.compact_repair_contract.path), repairContract.audit)
      || !same(context.repair_input, repairContract.input)
      || !same(await readJson(receipt.schema.path), repairContract.wireSchema)) fail('thin_style_compact_repair_changed');
    patch = restoreCompactBusinessValue(patchWire, repairContract);
  } else if (!same(await readJson(receipt.schema.path), styleUncertaintyRepairSchema(fullSchema))) fail('thin_style_schema_changed');
  if (!same(mergeStyleUncertaintyRepair(first, patch, fullSchema), raw.value)) fail('thin_style_merged_value_changed');
}

// Only upstream direction inputs are captured. Retrieval libraries and publication pointers are downstream.
export async function captureResearchDirectionDependencies({ sourceSha, config, analysis, observations,
  dialogueIntervals, backend, prompt, schema, frames, input }) {
  const captured_at_ms = Date.now();
  if (!/^[a-f0-9]{64}$/.test(sourceSha ?? '') || !config.video || await hashFile(config.video) !== sourceSha) fail('source_changed');
  await binding(analysis?.binding);
  if (!same(await readJson(analysis.binding.path), analysis.value)) fail('analysis_binding_value_mismatch');
  if (analysis.value.source_video_sha256 !== sourceSha) fail('analysis_source_changed');
  if (!Array.isArray(observations) || !Array.isArray(frames)) fail('explicit_direction_evidence_required');
  for (const row of observations) {
    await binding(row.binding);
    if (!same(await readJson(row.binding.path), row.value) || row.value.source_video_sha256 !== sourceSha) fail('observation_binding_value_mismatch');
  }
  await verifyEvidenceBindings([observations, frames, input]);
  if (!['codex_cli', 'codex_host_file'].includes(backend?.protocol) || !backend.backend_id || !backend.model_revision
    || input?.stage !== 'research_style_director' || input.data?.source_video_sha256 !== sourceSha
    || !same(input.data.analysis, analysis.value) || !same(input.data.unqualified_research_observations, observations)
    || !same(input.data.dialogue_intervals, dialogueIntervals) || input.data.music_words_policy !== config.music_words_policy
    || input.prompt !== prompt || !same(input.schema, schema) || !same(input.frames, frames)
    || !same(schema.properties?.direction_version?.enum, [2])) fail('exact_v2_direction_intent_required');
  if (dialogueIntervals !== null && (!Array.isArray(dialogueIntervals) || dialogueIntervals.some(row =>
    !Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds) || row.start_seconds < 0 || row.end_seconds <= row.start_seconds)))
    fail('dialogue_intervals_invalid');
  const upstream = { source_video_sha256: sourceSha, backend, analysis, observations, dialogue_intervals: dialogueIntervals,
    controls: { craft_mode: config.craft_mode ?? null, music_words_policy: config.music_words_policy,
      brief: config.brief ?? null, director_brief: config.director_brief ?? null }, input };
  const value = { schema_version: 1, kind: 'direction_dependencies_v1', captured_at_ms,
    identity_sha256: shaBytes(canonical(identity(upstream))), upstream };
  captures.add(value); return value;
}

async function originalResponse(saved) {
  const upstream = saved.dependencies.upstream, backend = upstream.backend;
  const expectedRevision = backend.direction_model_revision ?? backend.model_revision;
  await verifyEvidenceBindings([upstream, saved.response]);
  if (shaBytes(canonical(identity(upstream))) !== saved.dependencies.identity_sha256) fail('dependency_identity_changed');
  const raw = await readJson(saved.response.path);
  if (raw.actual_input_processed !== true || raw.completion_status !== 'complete'
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.qualified !== false
    || raw.artistic_approval !== false || raw.production_approval !== false || !same(raw.scopes, [])
    || raw.backend_id !== backend.backend_id || raw.model_revision !== expectedRevision
    || raw.source_video_sha256 !== upstream.source_video_sha256 || !Array.isArray(raw.evidence_files))
    fail('complete_unqualified_direction_response_required');
  await verifyEvidenceBindings(raw.evidence_files);
  if (saved.kind === 'research_direction_checkpoint_v2') {
    if ((raw.host_field_merge?.revision !== directionSemanticFieldRepairRevision
      &&raw.host_selected_unknown_merge?.revision !== selectedUnknownRecoveryRevision) || backend.protocol !== 'codex_cli')
      fail('typed_recovery_checkpoint_response_required');
    await binding(saved.recovery?.projected_input);
    const input = await readJson(saved.recovery.projected_input.path);
    await hydrateDirectionIntent(input, upstream);
    const { createCodexStyleSemanticValidator } = await import('./compose_codex_episode.mjs');
    const executionBasis=await reloadDirectionExecutionBasis(raw.direction_execution_basis,{sourceSha:upstream.source_video_sha256,
      analysis:upstream.analysis.value,mode:'assisted_trial'});
    const checked = await loadDirectionSemanticFieldRecovery(saved.response, { input,
      validateValue: createCodexStyleSemanticValidator(input, { mode: input.data.execution_mode ?? 'assisted_trial',executionBasis }),
      expectedModelRevision: expectedRevision });
    if (checked.request_sha256 !== saved.request_sha256) fail('direction_request_identity_changed');
    return { value: checked.value, raw_response: saved.response, request_sha256: checked.request_sha256,
      source_video_sha256: checked.source_video_sha256,
      semantic_gaps: directionSemanticGaps(checked.value, upstream.analysis.value),
      unresolved: inspectDirectionUncertainties(checked.value, upstream.analysis.value,{mode:'assisted_trial',executionBasis}) };
  }
  const request = raw.evidence_files.find(row => path.resolve(row.path) === path.join(path.dirname(saved.response.path), 'request.json'));
  if (!request) fail('actual_direction_request_required');
  const document = await readJson(request.path), cli = backend.protocol === 'codex_cli', payload = cli ? document : document.payload;
  if (!payload || shaBytes(canonical(payload)) !== raw.request_sha256 || raw.request_sha256 !== saved.request_sha256
    || payload.source_video_sha256 !== upstream.source_video_sha256
    || !raw.evidence_files.some(row => row.sha256 === upstream.source_video_sha256)) fail('direction_request_identity_changed');
  const actual = await hydrateDirectionIntent(payload.input, upstream);
  if (cli) {
    if (raw.execution_kind !== 'codex_cli_inference' || raw.actual_runtime_executed !== true
      || payload.execution_kind !== 'codex_cli_inference' || payload.role !== 'director'
      || payload.backend_id !== backend.backend_id || payload.model_requested !== raw.model
      || raw.model !== expectedRevision.split(':')[0]
      || payload.model_revision && payload.model_revision !== expectedRevision) fail('actual_cli_direction_required');
    // CodexEpisodeSession transparently uses the already completed story and its complete frame mapping.
    if (!actual.frames?.length && upstream.input.frames.length) {
      const story = actual.data?.completed_story, mapping = actual.data?.source_frame_mapping;
      await binding(story); await binding(mapping);
      const storyRaw = await readJson(story.path), mapped = await readJson(mapping.path);
      if (!same(storyRaw.value, upstream.analysis.value) || mapped.source_video_sha256 !== upstream.source_video_sha256
        || !same(identity(mapped.source_frames), identity(upstream.input.frames))
        || actual.data.frame_policy !== 'Previously analyzed complete frames; this stage consumes the bound analysis, not a fresh image or audio observation.')
        fail('completed_story_projection_changed');
      delete actual.data.completed_story; delete actual.data.source_frame_mapping; delete actual.data.frame_policy;
      actual.frames = upstream.input.frames;
    }
    const typedStyle = raw.typed_style_merge?.revision === 'typed-bounded-style-v1';
    if (typedStyle) {
      const { verifyTypedStyleCompletion } = await import('./typed_bounded_style_director.mjs');
      await verifyTypedStyleCompletion({ raw, payload, request });
    }
    const receipts = typedStyle ? [] : [...(raw.cli_receipts ?? []), ...(raw.historical_cli_receipts ?? [])];
    await verifyEvidenceBindings(receipts);
    let completed = typedStyle;
    for (const ref of receipts) {
      const receipt = await readJson(ref.path);
      if (receipt.status !== 'complete') continue;
      if (receipt.request_sha256 !== raw.request_sha256 || receipt.execution_kind !== 'codex_cli_inference'
        || receipt.request?.sha256 !== request.sha256 || receipt.model_requested !== raw.model
        || receipt.model_revision !== expectedRevision || receipt.cli_invocations !== 1
        || receipt.timed_out !== false || receipt.exit_code !== 0) fail('actual_cli_completion_receipt_required');
      await verifyEvidenceBindings([receipt.final, receipt.schema, receipt.prompt]);
      if (raw.host_field_merge) {
        await thinStyleCompletion({ raw, receipt, payload, request }); completed = true; continue;
      }
      if (raw.host_contract_reconstruction) {
        await compactDirectionCompletion({ raw, receipt, payload }); completed = true; continue;
      }
      if (!same(await readJson(receipt.final.path), raw.value)) fail('cli_final_value_changed');
      // The stored full request is authoritative; schema-once may remove only its duplicate schema from stdin.
      let submitted = payload.input;
      if (receipt.prompt_projection === 'director-schema-once-v1') {
        const projection = receipt.prompt_projection_audit;
        const reduced = structuredClone(payload.input);
        for (const key of ['schema', 'response_schema']) delete reduced[key];
        if (!projection || projection.full_request?.sha256 !== request.sha256
          || projection.revision !== 'director-schema-once-v1'
          || !same(projection.omitted_fields, ['schema', 'response_schema'].filter(key => Object.hasOwn(payload.input, key)))
          || projection.full_input_sha256 !== shaBytes(canonical(payload.input))
          || projection.prompt_input_sha256 !== shaBytes(canonical(reduced))) fail('schema_projection_changed');
        submitted = reduced;
      } else if (receipt.prompt_projection !== 'full_input') fail('unsupported_direction_projection');
      if (!(await readFile(receipt.prompt.path, 'utf8')).endsWith('\n' + JSON.stringify({ role: payload.role, input: submitted })))
        fail('actual_direction_stdin_changed');
      const outputSchema = await readJson(receipt.schema.path), expectedSchema = structuredClone(payload.input.schema);
      if (!same(outputSchema, expectedSchema)) {
        if (!expectedSchema.properties.source_video_sha256) fail('actual_direction_output_schema_changed');
        expectedSchema.properties.source_video_sha256 = { ...expectedSchema.properties.source_video_sha256, enum: [upstream.source_video_sha256] };
        if (!same(outputSchema, expectedSchema)) fail('actual_direction_output_schema_changed');
      }
      completed = true;
    }
    if (!completed) fail('actual_cli_completion_receipt_required');
  } else if (raw.execution_kind !== 'codex_host_authored_record' || raw.inference_claim !== 'host_record_import_not_api_inference'
    || !same(raw.backend, backend) || !same(document.backend, backend) || !same(payload.backend, backend)
    || document.request_sha256 !== raw.request_sha256 || payload.role !== 'research_style_director') fail('host_direction_record_required');
  if (!same(identity(actual), identity(upstream.input))) fail('direction_request_intent_changed');
  validateSchema(raw.value, upstream.input.schema);
  if (raw.value.direction_version !== 2) fail('v2_direction_response_required');
  const semantic_gaps = directionSemanticGaps(raw.value, upstream.analysis.value);
  const executionBasis=await reloadDirectionExecutionBasis(raw.direction_execution_basis,{sourceSha:upstream.source_video_sha256,
    analysis:upstream.analysis.value,mode:'assisted_trial'});
  const unresolved = inspectDirectionUncertainties(raw.value, upstream.analysis.value,{...(executionBasis?{mode:'assisted_trial',executionBasis}:{})});
  return { value: raw.value, raw_response: saved.response, request_sha256: raw.request_sha256,
    source_video_sha256: raw.source_video_sha256, semantic_gaps, unresolved };
}

export async function createResearchDirectionCheckpoint({ before, after, result, outputDirectory, recovery = null }) {
  if (!captures.has(before) || !captures.has(after) || after.captured_at_ms < before.captured_at_ms)
    fail('in_process_before_and_after_capture_required');
  if (before.identity_sha256 !== after.identity_sha256) fail('direction_dependencies_changed_during_execution');
  if (!result?.raw_response || result.completion_status !== 'complete') fail('complete_direction_response_required');
  await binding(result.raw_response);
  if (!recovery && (result.reused === true || (await stat(result.raw_response.path)).mtimeMs < before.captured_at_ms)) fail('fresh_direction_execution_required');
  if (recovery) await binding(recovery.projected_input);
  const saved = { schema_version: recovery ? 2 : 1, kind: recovery ? 'research_direction_checkpoint_v2' : 'research_direction_checkpoint_v1', dependencies: before,
    ...(recovery ? { dependencies_captured_before_consumption: true, dependencies_verified_after_consumption: true,
      inference_previously_completed: true, new_model_calls_for_checkpoint: 0,
      recovery: { revision: result.host_selected_unknown_merge?.revision??directionSemanticFieldRepairRevision,
        projected_input: recovery.projected_input } }
      : { dependencies_captured_before_execution: true, dependencies_verified_after_execution: true }),
    response: result.raw_response, request_sha256: result.request_sha256,
    formal_adoption_allowed: false, production_approval: false };
  const checked = await originalResponse(saved);
  if (!same(checked.value, result.value)) fail('direction_return_value_changed');
  return saveJson(path.join(outputDirectory, 'dependency-checkpoint.json'), saved);
}

export async function validateResearchDirectionCheckpoint(checkpoint) {
  const reference = await binding(checkpoint), saved = await readJson(reference.path);
  const legacy = saved.kind === 'research_direction_checkpoint_v1' && saved.schema_version === 1
    && saved.dependencies_captured_before_execution === true && saved.dependencies_verified_after_execution === true;
  const recovery = saved.kind === 'research_direction_checkpoint_v2' && saved.schema_version === 2
    && saved.dependencies_captured_before_consumption === true && saved.dependencies_verified_after_consumption === true
    && saved.inference_previously_completed === true && saved.new_model_calls_for_checkpoint === 0
    && [directionSemanticFieldRepairRevision,selectedUnknownRecoveryRevision].includes(saved.recovery?.revision);
  if ((!legacy && !recovery) || saved.dependencies?.kind !== 'direction_dependencies_v1'
    || saved.formal_adoption_allowed !== false || saved.production_approval !== false) fail('strict_direction_checkpoint_required');
  return { ...await originalResponse(saved), checkpoint: reference, dependencies: saved.dependencies };
}

export async function restoreResearchDirectionCheckpoint({ checkpoint, dependencies }) {
  const saved = await validateResearchDirectionCheckpoint(checkpoint);
  await verifyEvidenceBindings(dependencies.upstream);
  if (shaBytes(canonical(identity(dependencies.upstream))) !== dependencies.identity_sha256
    || saved.dependencies.identity_sha256 !== dependencies.identity_sha256) fail('direction_stage_dependencies_changed');
  const { dependencies: original, ...result } = saved;
  return { ...result, reused: true, new_model_calls: 0, actual_audio_processed: false,
    formal_adoption_allowed: false, production_approval: false };
}
