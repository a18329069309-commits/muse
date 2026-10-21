import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, saveJson, verifyEvidenceBindings, validateSchema, objectSchema, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';
import { readAutomaticStageFailure } from './automatic_stage_failure_evidence.mjs';
import { baseStructuredEvidencePrompt, structuredEvidenceRetryPrompt, completedCliEventsValid,
  validateCompletedTurnCleanup, usageOf, estimateCompactBusinessInputBudget } from './codex_cli_runtime.mjs';

export const storyPartEvidenceRepairRevision = 'source-bound-story-part-evidence-only-v1';
export const storyPartEvidenceRepairStage = 'research_story_part_evidence_fields_v1';
// These are two exact failures of the same submitted-citation clock check.
// The original value must still reproduce its recorded error before any patch.
export const isStoryPartCitationFailureDetail = detail => [
  'codex_episode_story_part_evidence_not_submitted',
  'codex_episode_end_boundary_frame_requires_following_event',
].includes(detail);
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('story_part_evidence_repair_' + reason); };
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const overlap = (item, row) => item?.kind === 'frame'
  ? item.timeline_seconds >= row.start_seconds && item.timeline_seconds < row.end_seconds
  : item?.kind === 'audio_observation' && item.start_seconds < row.end_seconds && item.end_seconds > row.start_seconds;
async function immutable(file, value) {
  try { return await saveJson(file, value); } catch (error) {
    if (error.code !== 'EEXIST' || !same(await readJson(file), value)) throw error;
    return bind(file);
  }
}

// Verify the actual rejected/complete turn, including every reported token field.
// Reconnection validation is shared with the live runner; no fatal error is hidden.
async function actualTurn(requestBinding, receiptBinding, { status, detail, priorReceipts = [] } = {}) {
  await verifyEvidenceBindings([requestBinding, receiptBinding]);
  const request = await readJson(requestBinding.path), receipt = await readJson(receiptBinding.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.role !== 'director'
    || request.model_requested !== 'gpt-6.1-sol' || request.backend_id !== 'codex-cli-chatgpt'
    || request.business_contract !== 'compact_business_v1'
    || !same(receipt.request, requestBinding) || receipt.request_sha256 !== shaBytes(canonical(request))
    || receipt.status !== status || detail && receipt.detail !== detail
    || receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
    || receipt.caller_semantic_validator_used !== true || receipt.timed_out !== false || receipt.process_terminated !== true
    || receipt.exit_code !== 0 && !receipt.completed_turn_cleanup || receipt.model_revision !== request.model_revision
    || receipt.source_video_sha256 !== request.source_video_sha256
    || request.input?.data?.source_video_sha256 !== request.source_video_sha256
    || receipt.qualified !== false || receipt.artistic_approval !== false || receipt.production_approval !== false
    || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false)
    fail('actual_bound_schema_valid_turn_required');
  await verifyEvidenceBindings([receipt.final, receipt.schema, receipt.prompt, receipt.jsonl,
    receipt.host_business_contract, receipt.worker_instructions, receipt.host_cli_resolution, ...request.input_bindings]);
  const resolution = await readJson(receipt.host_cli_resolution.path);
  if (resolution.injected || receipt.command !== resolution.actual_path) fail('actual_cli_execution_required');
  if (!same(request.submitted_images, (request.input.frames ?? []).map(frame => ({ path: path.resolve(frame.path), sha256: frame.sha256 })))
    || receipt.submitted_image_count !== request.submitted_images.length) fail('submitted_image_identity_changed');
  await verifyEvidenceBindings(request.submitted_images);
  const contract = projectCompactBusinessContract(request.input), wire = await readJson(receipt.final.path);
  if (!same(await readJson(receipt.schema.path), contract.wireSchema)
    || !same(await readJson(receipt.host_business_contract.path), contract.audit)) fail('actual_business_contract_changed');
  validateSchema(wire, contract.wireSchema);
  const value = restoreCompactBusinessValue(wire, contract);
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (!completedCliEventsValid(events) || !same(usageOf(events), receipt.usage)
    || !same(JSON.parse(events.findLast(event => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text ?? 'null'), wire))
    fail('actual_terminal_result_or_usage_changed');
  if (receipt.completed_turn_cleanup) validateCompletedTurnCleanup(receipt.completed_turn_cleanup,
    { events, finalBytes: await readFile(receipt.final.path), schema: contract.wireSchema });
  let expectedPrompt;
  if (receipt.repair_of) {
    // Only directly bound earlier attempts of this same request may explain an
    // archived retry prompt. Never discover or infer an earlier attempt on disk.
    const candidates = [];
    for (const binding of priorReceipts) {
      await verifyEvidenceBindings(binding); const prior = await readJson(binding.path);
      if (prior.request_sha256 === receipt.request_sha256 && same(prior.request, requestBinding)
        && prior.status === receipt.repair_of && prior.status === 'semantic_invalid'
        && isStoryPartCitationFailureDetail(prior.detail)) candidates.push({ prior, binding });
    }
    if (candidates.length !== 1) fail('direct_prior_retry_receipt_required');
    await actualTurn(requestBinding, candidates[0].binding, { status: 'semantic_invalid',
      detail: candidates[0].prior.detail });
    expectedPrompt = structuredEvidenceRetryPrompt('director', contract.input,
      { reason: candidates[0].prior.status, detail: candidates[0].prior.detail });
  } else expectedPrompt = baseStructuredEvidencePrompt('director', contract.input);
  if (await readFile(receipt.prompt.path, 'utf8') !== expectedPrompt) fail('actual_stdin_changed');
  return { requestBinding, receiptBinding, request, receipt, value, contract };
}

export async function inspectStoryPartEvidence(value, input) {
  const { validateStoryPart, decodeContinuationEvidenceCatalog } = await import('./compose_codex_episode.mjs');
  const range = input.partition?.source_range;
  if (!/^research_story_director_part_\d+$/.test(input.stage ?? '') || !Array.isArray(range)) fail('actual_partition_required');
  validateSchema(value, input.schema);
  const catalogue = decodeContinuationEvidenceCatalog(input.data.evidence_catalog);
  if (new Set(catalogue.map(row => row.id)).size !== catalogue.length) fail('duplicate_submitted_evidence_identity');
  const evidence = new Map(catalogue.map(row => [row.id, row])), affected = [];
  const structuralProbe = structuredClone(value);
  for (const [collection, rows] of [['story_beats', value.story_beats], ['sound_events', value.sound_events]]) {
    for (const row of rows) {
      if (!row.evidence_ids.length || new Set(row.evidence_ids).size !== row.evidence_ids.length) fail('malformed_original_citations_require_other_recovery');
      const invalid = row.evidence_ids.filter(id => !overlap(evidence.get(id), row));
      if (!invalid.length) continue;
      // The thin repair fixes a real submitted citation at the wrong clock.
      // Invented IDs and malformed/duplicate IDs require a different failure task.
      if (invalid.some(id => !evidence.has(id))) fail('unsubmitted_id_requires_other_recovery');
      const eligible = catalogue.filter(item => overlap(item, row));
      if (!eligible.length) fail('no_submitted_positive_overlap_evidence');
      const preserved = row.evidence_ids.filter(id => !invalid.includes(id));
      affected.push({ collection, event_id: row.id, frozen_event: structuredClone(row), invalid_evidence_ids: invalid,
        preserved_evidence_ids: preserved, eligible_evidence: eligible });
      // This temporary value diagnoses all OTHER schema/clock/coverage fields.
      // It is never returned as a model judgment or an adopted story response.
      structuralProbe[collection].find(item => item.id === row.id).evidence_ids = eligible.map(item => item.id);
    }
  }
  if (!affected.length) fail('actual_citation_gap_required');
  validateStoryPart(structuralProbe, input, range);
  return affected;
}

export async function prepareStoryPartEvidenceRepair(binding) {
  await verifyEvidenceBindings(binding); const spec = await readJson(binding.path);
  if (spec.kind !== 'actual_failed_story_part_evidence_repair_input') fail('explicit_source_bound_input_required');
  await verifyEvidenceBindings(spec.receipt);
  const rejectedReceipt = await readJson(spec.receipt.path);
  if (!isStoryPartCitationFailureDetail(rejectedReceipt.detail)) fail('actual_supported_citation_failure_required');
  const original = await actualTurn(spec.request, spec.receipt, { status: 'semantic_invalid',
    detail: rejectedReceipt.detail, priorReceipts: spec.prior_receipts ?? [] });
  const { validateStoryPart } = await import('./compose_codex_episode.mjs');
  let originalRejected = false;
  try { validateStoryPart(original.value, original.request.input, original.request.input.partition?.source_range); }
  catch (error) {
    if (error.message !== rejectedReceipt.detail) fail('actual_original_semantic_detail_changed');
    originalRejected = true;
  }
  if (!originalRejected) fail('actual_original_semantic_failure_required');
  const affected = await inspectStoryPartEvidence(original.value, original.request.input);
  const { decodeContinuationObservationTable } = await import('./compose_codex_episode.mjs');
  const observations = decodeContinuationObservationTable(original.request.input.data.unqualified_research_observations ?? []);
  const schema = objectSchema({ patches: { type: 'array', minItems: affected.length, maxItems: affected.length,
    items: objectSchema({ event_id: { type: 'string', enum: affected.map(row => row.event_id) },
      decision: { type: 'string', enum: ['supported', 'insufficient_evidence'] },
      evidence_ids: { type: 'array', items: { type: 'string', enum: [...new Set(affected.flatMap(row => row.eligible_evidence.map(item => item.id)))] } },
      reason: { type: 'string', minLength: 1 } }) } });
  const input = { stage: storyPartEvidenceRepairStage, schema, frames: original.request.input.frames,
    source_video: original.request.input.source_video,
    prompt: 'Repair ONLY evidence_ids for the listed frozen events in an actual schema-valid story part. '
      + 'Return each event once. Cite only the listed originally submitted evidence with strictly positive overlap: frames use [start,end), audio ranges must overlap with positive length. '
      + 'Keep every already-valid citation, and use the actual submitted images/predictions to judge support for the unchanged text. '
      + 'If that unchanged text is not sufficiently supported, return insufficient_evidence; do not invent, rewrite, summarize, or alter clocks, text, audio facts, story decisions or other events. '
      + 'ASR/VAD remain unqualified predictions; still frames do not authorize direct listening, verified dialogue, sound facts, or artistic/production approval.',
    data: { source_video_sha256: original.request.source_video_sha256, original_request: spec.request, original_rejected_receipt: spec.receipt,
      original_source_range: original.request.input.partition.source_range, source_frames: original.request.input.data.source_frames,
      frame_sheet_manifest: original.request.input.data.frame_sheet_manifest,
      affected_events: affected, submitted_research_predictions: observations.filter(row => affected.some(event => {
        const range = row.value?.source_range ?? row.source_range;
        return range && range[0] < event.frozen_event.end_seconds && range[1] > event.frozen_event.start_seconds;
      })), actual_audio_listened: false, sound_facts_qualified: false, production_approval: false } };
  return { binding, spec, original, affected, input };
}

export function mergeStoryPartEvidenceRepair(prepared, patch) {
  validateSchema(patch, prepared.input.schema);
  if (new Set(patch.patches.map(row => row.event_id)).size !== prepared.affected.length) fail('each_affected_event_once_required');
  const value = structuredClone(prepared.original.value), gaps = [];
  for (const event of prepared.affected) {
    const row = patch.patches.find(item => item.event_id === event.event_id);
    if (new Set(row.evidence_ids).size !== row.evidence_ids.length) fail('duplicate_patch_evidence');
    if (row.evidence_ids.some(id => !event.eligible_evidence.some(item => item.id === id))) fail('patch_evidence_not_submitted_or_positive_overlap');
    if (row.decision === 'insufficient_evidence') { gaps.push({ event_id: row.event_id, reason: row.reason }); continue; }
    if (!row.evidence_ids.length || event.preserved_evidence_ids.some(id => !row.evidence_ids.includes(id))) fail('valid_evidence_must_be_preserved');
    value[event.collection].find(item => item.id === event.event_id).evidence_ids = [...row.evidence_ids];
  }
  if (gaps.length) return { status: 'story_part_evidence_support_gap', gaps, value: null };
  const frozen = structuredClone(value);
  for (const event of prepared.affected) frozen[event.collection].find(item => item.id === event.event_id).evidence_ids = event.frozen_event.evidence_ids;
  if (!same(frozen, prepared.original.value)) fail('frozen_business_or_clock_changed');
  validateSchema(value, prepared.original.request.input.schema);
  return { status: 'story_part_evidence_fields_merged', value };
}

export async function validateStoryPartRepairIntent(prepared, input, expectedModelRevision) {
  if (!same(prepared.original.request.input, input)
    || expectedModelRevision && prepared.original.request.model_revision !== expectedModelRevision)
    fail('current_source_clock_evidence_schema_model_or_partition_changed');
}

export async function executeStoryPartEvidenceRepair(prepared, { cli, input, directory, trialBudget, expectedModelRevision,
  futureRequestReserve = 0 } = {}) {
  await validateStoryPartRepairIntent(prepared, input, expectedModelRevision);
  if (!path.isAbsolute(directory ?? '')) fail('explicit_repair_directory_required');
  let patch;
  const options = { repairLimit: 0, validateValue: value => mergeStoryPartEvidenceRepair(prepared, value) };
  try {
    patch = await cli.request('director', prepared.input, { ...options, cacheOnly: 'completed_or_new' });
    if (!patch) {
      const budget = estimateCompactBusinessInputBudget(prepared.input, { zeroRepairEnvelope: true });
      const available = await trialBudget?.inspect({ budget: { ...budget, submitted_input_tokens: budget.estimated_tokens } });
      if (available && (available.remaining_requests < 1 + futureRequestReserve || available.remaining_ms <= 0))
        fail('insufficient_existing_budget_for_one_patch_and_followup');
      patch = await cli.request('director', prepared.input, options);
    }
  }
  catch (error) { error.cli_receipts = [...(prepared.spec.prior_receipts ?? []), prepared.spec.receipt, ...(error.cli_receipts ?? [])]; throw error; }
  try { await verifyActualStoryPartPatch(prepared, patch); }
  catch (error) { error.receipt_file ??= [...(patch.cli_receipts ?? []), ...(patch.historical_cli_receipts ?? [])].at(-1)?.path;
    error.cli_receipts = [...(prepared.spec.prior_receipts ?? []), prepared.spec.receipt,
      ...(patch.historical_cli_receipts ?? []), ...(patch.cli_receipts ?? [])]; throw error; }
  const merged = mergeStoryPartEvidenceRepair(prepared, patch.value);
  const { validateStoryPart } = await import('./compose_codex_episode.mjs');
  if (merged.value) validateStoryPart(merged.value, input, input.partition.source_range);
  const proof = { revision: storyPartEvidenceRepairRevision, original_failed_part: prepared.binding,
    actual_patch_response: patch.raw_response, edited_fields: prepared.affected.map(event => `${event.collection}/${event.event_id}/evidence_ids`),
    frozen_original_business_sha256: shaBytes(canonical(prepared.original.value)),
    all_other_fields_clocks_source_facts_and_qualifications_changed: false, original_failure_and_usage_unchanged: true,
    actual_model_returned_full_part: false, qualification_granted: false };
  const stablePatch = await readJson(patch.raw_response.path);
  const raw = { ...stablePatch, value: merged.value, execution_kind: 'deterministic_story_part_evidence_merge_of_actual_patch',
    model: prepared.original.request.model_requested, model_revision: prepared.original.request.model_revision,
    request_sha256: prepared.original.receipt.request_sha256, input_sha256: prepared.original.request.input_sha256,
    evidence_files: [...patch.evidence_files, prepared.binding, prepared.spec.request, prepared.spec.receipt,
      ...(prepared.spec.prior_receipts ?? []), ...prepared.original.request.input_bindings],
    actual_frames_submitted: input.frames.length, host_story_part_evidence_merge: proof,
    completion_status: merged.value ? 'complete' : 'evidence_support_gap', gaps: merged.gaps ?? [],
    historical_cli_receipts: [...(prepared.spec.prior_receipts ?? []), prepared.spec.receipt, ...(stablePatch.historical_cli_receipts ?? [])],
    qualified: false, artistic_approval: false, production_approval: false };
  delete raw.raw_response;
  const saved = await immutable(path.join(directory, `${shaBytes(canonical(proof))}.json`), raw);
  if (!merged.value) { const error = Error('story_part_evidence_repair_actual_support_gap');
    error.receipt_file = patch.cli_receipts?.at(-1)?.path; error.cli_receipts = [...raw.historical_cli_receipts, ...(patch.cli_receipts ?? [])];
    error.evidence_support_gap = saved; throw error; }
  return { ...raw, raw_response: saved, cli_receipts: patch.cli_receipts ?? [],
    historical_cli_receipts: [...(prepared.spec.prior_receipts ?? []), prepared.spec.receipt, ...(patch.historical_cli_receipts ?? [])],
    reused: patch.reused === true };
}

async function verifyActualStoryPartPatch(prepared, patch) {
  if (patch?.execution_kind !== 'codex_cli_inference' || patch.actual_runtime_executed !== true
    || patch.actual_input_processed !== true || patch.actual_audio_processed !== false || patch.actual_video_processed !== false
    || patch.completion_status !== 'complete' || patch.qualified !== false || patch.artistic_approval !== false
    || patch.production_approval !== false || !same(patch.scopes, [])) fail('actual_patch_inference_required');
  await verifyEvidenceBindings(patch.raw_response);
  const raw = await readJson(patch.raw_response.path);
  if (!same(raw.value, patch.value) || ['execution_kind', 'actual_runtime_executed', 'actual_input_processed',
    'actual_audio_processed', 'actual_video_processed', 'completion_status', 'qualified', 'artistic_approval', 'production_approval',
    'source_video_sha256', 'request_sha256', 'model_revision', 'backend_id'].some(key => raw[key] !== patch[key]))
    fail('actual_patch_value_binding_changed');
  const receipts = [...(patch.cli_receipts ?? []), ...(patch.historical_cli_receipts ?? [])];
  if (receipts.length !== 1) fail('exactly_one_actual_patch_attempt_required');
  await verifyEvidenceBindings(receipts[0]); const receipt = await readJson(receipts[0].path);
  const actual = await actualTurn(receipt.request, receipts[0], { status: 'complete' });
  if (!same(actual.request.input, prepared.input) || !same(actual.value, patch.value)
    || actual.request.model_revision !== patch.model_revision || actual.request.backend_id !== patch.backend_id
    || actual.request.model_revision.replace(/:stage-reasoning-[a-z]+$/, '')
      !== prepared.original.request.model_revision.replace(/:stage-reasoning-[a-z]+$/, '')
    || actual.receipt.request_sha256 !== patch.request_sha256 || !same(actual.receipt.usage, patch.usage)
    || actual.request.source_video_sha256 !== prepared.original.request.source_video_sha256
    || actual.receipt.stage_repair_limit !== undefined && actual.receipt.stage_repair_limit !== 0)
    fail('actual_patch_intent_identity_or_usage_changed');
}

export async function loadStoryPartEvidenceRecovery(binding, { input = null, expectedModelRevision = null } = {}) {
  await verifyEvidenceBindings(binding); const raw = await readJson(binding.path), proof = raw.host_story_part_evidence_merge;
  if (raw.execution_kind !== 'deterministic_story_part_evidence_merge_of_actual_patch'
    || proof?.revision !== storyPartEvidenceRepairRevision || proof.actual_model_returned_full_part !== false
    || proof.all_other_fields_clocks_source_facts_and_qualifications_changed !== false
    || proof.original_failure_and_usage_unchanged !== true || proof.qualification_granted !== false
    || raw.qualified !== false || raw.artistic_approval !== false || raw.production_approval !== false
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.completion_status !== 'complete')
    fail('explicit_nonapproving_evidence_merge_required');
  const prepared = await prepareStoryPartEvidenceRepair(proof.original_failed_part);
  await verifyEvidenceBindings(proof.actual_patch_response);
  const patch = { ...await readJson(proof.actual_patch_response.path), raw_response: proof.actual_patch_response };
  await verifyActualStoryPartPatch(prepared, patch);
  const expectedProof = { revision: storyPartEvidenceRepairRevision, original_failed_part: prepared.binding,
    actual_patch_response: patch.raw_response, edited_fields: prepared.affected.map(event => `${event.collection}/${event.event_id}/evidence_ids`),
    frozen_original_business_sha256: shaBytes(canonical(prepared.original.value)),
    all_other_fields_clocks_source_facts_and_qualifications_changed: false, original_failure_and_usage_unchanged: true,
    actual_model_returned_full_part: false, qualification_granted: false };
  const merged = mergeStoryPartEvidenceRepair(prepared, patch.value);
  const { validateStoryPart } = await import('./compose_codex_episode.mjs');
  if (!merged.value || !same(raw.value, merged.value) || !same(proof, expectedProof)
    || raw.model_revision !== prepared.original.request.model_revision || raw.backend_id !== patch.backend_id
    || raw.request_sha256 !== prepared.original.receipt.request_sha256
    || raw.input_sha256 !== prepared.original.request.input_sha256
    || !same(raw.usage, patch.usage) || raw.source_video_sha256 !== prepared.original.request.source_video_sha256
    || !same(raw.historical_cli_receipts, [...(prepared.spec.prior_receipts ?? []), prepared.spec.receipt, ...(patch.historical_cli_receipts ?? [])]))
    fail('reconstructed_story_or_accounting_changed');
  await verifyEvidenceBindings(raw.evidence_files);
  await validateStoryPartRepairIntent(prepared, input ?? prepared.original.request.input, expectedModelRevision);
  validateStoryPart(raw.value, prepared.original.request.input, prepared.original.request.input.partition.source_range);
  return { ...raw, raw_response: binding, original_input: prepared.original.request.input };
}

export async function resolvePersistedFailedStoryPart(binding, { source, episodeRoot, outputDirectory } = {}) {
  if (!path.isAbsolute(outputDirectory ?? '')) fail('explicit_recovery_directory_required');
  const document = await readAutomaticStageFailure(binding, { stage: 'analysis', source, episodeRoot });
  if (document.capture_errors.length || !document.primary_receipt) fail('verified_terminal_failure_required');
  const receipt = await readJson(document.primary_receipt.path);
  if (receipt.request && (await readJson(receipt.request.path)).input?.stage === storyPartEvidenceRepairStage)
    return { status: 'story_part_evidence_repair_already_attempted', receipt: document.primary_receipt,
      new_model_calls: 0, next_action: 'supply_specific_new_evidence_or_reconcile_this_patch; do_not_repeat_story_or_patch',
      old_outcomes_and_usage_unchanged: true, qualified: false, artistic_approval: false, production_approval: false };
  if (receipt.status !== 'semantic_invalid' || !isStoryPartCitationFailureDetail(receipt.detail)
    || !/^research_story_director_part_\d+$/.test((await readJson(receipt.request.path)).input?.stage ?? ''))
    return { status: 'recorded_analysis_failure_requires_other_recovery', new_model_calls: 0 };
  const spec = { kind: 'actual_failed_story_part_evidence_repair_input', request: receipt.request,
    receipt: document.primary_receipt, prior_receipts: document.receipt_entries.map(row => row.binding)
      .filter(row => !same(row, document.primary_receipt)) };
  const sourceSpec = await immutable(path.join(outputDirectory, 'story-part-evidence-source-spec.json'), spec);
  const prepared = await prepareStoryPartEvidenceRepair(sourceSpec);
  if (prepared.original.request.source_video_sha256 !== source.sha256) fail('terminal_failure_source_changed');
  return { status: 'bound_failed_story_part_evidence_recovery_prepared', binding: sourceSpec,
    stage: prepared.original.request.input.stage, affected_event_ids: prepared.affected.map(row => row.event_id),
    failure_evidence: binding, new_model_calls: 0, old_outcomes_and_usage_unchanged: true,
    qualified: false, artistic_approval: false, production_approval: false };
}

export async function selectStoryPartFailureBinding(explicit, persisted) {
  const preferred = explicit ?? persisted;
  if (!preferred) return null;
  const prepared = await prepareStoryPartEvidenceRepair(preferred);
  if (explicit && persisted) {
    const other = await prepareStoryPartEvidenceRepair(persisted);
    const identity = row => ({ request: row.spec.request.sha256, receipt: row.spec.receipt.sha256,
      source: row.original.request.source_video_sha256, request_sha256: row.original.receipt.request_sha256,
      prior_receipts: (row.spec.prior_receipts ?? []).map(binding => binding.sha256) });
    if (!same(identity(prepared), identity(other))) fail('conflicting_failed_story_part_recovery_bindings');
  }
  return prepared;
}

export async function resolveFailedStoryPartFromCheckpoint(state, { source, episodeRoot, outputDirectory } = {}) {
  let stage = state.stages?.analysis;
  if (stage?.status !== 'failed' || !stage.failure_evidence || !stage.directory)
    return { status: 'recorded_analysis_failure_requires_other_recovery', new_model_calls: 0 };
  let hostFailure = null;
  if (stage.error === 'codex_episode_conflicting_failed_story_part_recovery_bindings') {
    const document = await readAutomaticStageFailure(stage.failure_evidence, { stage: 'analysis', source, episodeRoot });
    if (document.capture_errors.length || document.primary_receipt || document.receipt_entries.length
      || stage.receipt_file || (stage.cli_receipts ?? []).length) fail('host_conflict_has_unreconciled_execution');
    hostFailure = stage;
    // Only bound controller history is eligible. Stop at the latest real
    // attempt; an already attempted patch must never reveal an older retry.
    stage = [...(state.stage_attempt_history ?? [])].reverse().find(row => row.stage === 'analysis'
      && row.status === 'failed' && row.failure_evidence && row.directory
      && (row.receipt_file || (row.cli_receipts ?? []).length));
    if (!stage) fail('host_conflict_original_terminal_failure_missing');
  }
  const recovery = await resolvePersistedFailedStoryPart(stage.failure_evidence, { source, episodeRoot, outputDirectory });
  return { ...recovery, resume_directory: stage.directory, analysis_failure_attempt: stage.attempt,
    ...(hostFailure ? { zero_call_host_failure: { attempt: hostFailure.attempt, failure_evidence: hostFailure.failure_evidence,
      error: hostFailure.error, preserved: true } } : {}) };
}
