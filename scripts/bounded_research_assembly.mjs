import path from 'node:path';
import { readJson, saveJson, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { compileSoundArcPlan } from './sound_arc_plan.mjs';
import { prepareBoundedAssemblyInputs, withActualPreviousAssemblyTail } from './bounded_assembly_projection.mjs';
import { verifyBoundedAssemblyPartExecution } from './bounded_assembly_execution_evidence.mjs';
import { actionTasksCover } from './music_edit_operation_contract.mjs';
import { motherActionPartitionRevision, projectMotherActionGroup, mergeMotherActionValues, restoreMotherActionValue } from './bounded_mother_action_projection.mjs';
import { assemblyMotherActionEditingRevision,assemblyOwnedPartClockBoundsRevision,assertOwnedPartClockBounds,boundedPartScopeRevision } from './assembly_consumer_projection.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw Error('bounded_assembly_' + reason); };
const unique = (rows, key) => new Set(rows.map(row => row[key])).size === rows.length;
const nonempty = value => typeof value === 'string' && value.trim();
const idsEqual = (rows, key, ids) => unique(rows, key) && rows.length === ids.length
  && rows.every(row => ids.includes(row[key]));
async function stable(file, value) {
  try { return await saveJson(file, value); }
  catch (error) { if (error.code !== 'EEXIST') throw error;
    if (!same(await readJson(file), value)) fail('existing_evidence_changed');
    return { path: path.resolve(file), sha256: await hashFile(file) }; }
}

// Match the real CodexEpisodeSession envelope before any request is submitted.
export function assemblySessionEnvelope(input, session) {
  if (!session.story) return input;
  return { ...input, frames: [], data: { ...input.data,
    completed_story: session.story.analysis, source_frame_mapping: session.story.frame_mapping,
    frame_policy: 'Previously analyzed complete frames; this stage consumes the bound analysis, not a fresh image or audio observation.' } };
}
export function finitePartSchema(schema) {
  const next = structuredClone(schema), arc = next.properties.plan.properties.arcs.items;
  // The legacy schema intentionally shares string-node objects. Replace each
  // node rather than mutating an alias and accidentally narrowing other fields.
  const limit = (properties, key, maxLength) => properties[key] = { ...properties[key], maxLength };
  limit(arc.properties, 'arc_id', 96);
  const piece = arc.properties.pieces.items;
  limit(piece.properties, 'piece_id', 96);
  limit(piece.properties, 'development_role', 384);
  limit(piece.properties, 'silence_reason', 384);
  limit(piece.properties.connection_from.properties, 'previous_piece_id', 96);
  limit(piece.properties.connection_from.properties, 'reason', 384);
  limit(next.properties.edits.properties.music_edits.items.properties, 'transition_reason', 512);
  return next;
}

export function validateBoundedAssemblyPart(value, part, previous, fullInput) {
  if(part.input.data.assembly_consumer_projection_revision===assemblyOwnedPartClockBoundsRevision){
    if(fullInput.data.bounded_part_scope_revision!==boundedPartScopeRevision)fail('part_scope_revision_changed');
    assertOwnedPartClockBounds(part.input);
  }
  validateSchema(value, part.input.schema);
  if (value.plan.source_video_sha256 !== fullInput.data.source_video_sha256) fail('part_source_changed');
  if (value.execution_gaps.length) return { execution_gap: true };
  if (!idsEqual(value.plan.arcs, 'cue_id', part.cue_ids)
    || !same(value.plan.arcs.map(arc => arc.cue_id), part.cue_ids)
    || !idsEqual(value.edits.action_responses, 'action_id', part.action_ids)
    || !idsEqual(value.edits.sounds, 'event_id', part.event_ids)) fail('part_ownership_changed');
  const motherPartition=part.mother_action_partition;
  if(motherPartition){
    let expected=projectMotherActionGroup({...fullInput,schema:finitePartSchema(fullInput.schema)},motherPartition.action_start,motherPartition.action_end).input;
    if(part.input.data.assembly_consumer_projection_revision!==undefined){
      if(![assemblyMotherActionEditingRevision,assemblyOwnedPartClockBoundsRevision].includes(part.input.data.assembly_consumer_projection_revision))fail('part_projection_revision_changed');
      if(part.input.data.assembly_consumer_projection_revision===assemblyOwnedPartClockBoundsRevision
        &&expected.data.assembly_consumer_projection_revision!==assemblyOwnedPartClockBoundsRevision)fail('part_scope_revision_changed');
      expected.data.assembly_consumer_projection_revision=part.input.data.assembly_consumer_projection_revision;
      if(previous.length)expected=withActualPreviousAssemblyTail(expected,actualAssemblyTail(previous.at(-1).value,previous.at(-1).raw_response,fullInput));
    }
    if(!same(expected.data,part.input.data)||expected.prompt!==part.input.prompt)fail('part_host_projection_changed');
  }
  const normalized=motherPartition?mergeMotherActionValues([...previous,{value,mother_action_partition:motherPartition}],
    {...fullInput,schema:finitePartSchema(fullInput.schema)},{complete:false}):null;
  const currentValue=motherPartition?restoreMotherActionValue(value,motherPartition).value:value;
  const prior = previous.map(row => row.value), arcs = normalized?.value.plan.arcs??[...prior.flatMap(row => row.plan.arcs), ...value.plan.arcs];
  const cueIds = arcs.map(arc => arc.cue_id);
  const director = normalized?.director??{ ...fullInput.data.director,
    cues: fullInput.data.director.cues.filter(cue => cueIds.includes(cue.cue_id)) };
  const compiled = compileSoundArcPlan({ plan: { ...value.plan, arcs }, director,
    candidates: fullInput.data.candidates.music, wordsCandidates: fullInput.data.candidates.words });
  const currentIds = new Set(part.cue_ids);
  const pieceIds=new Set(value.plan.arcs.flatMap(arc=>arc.pieces.map(piece=>piece.piece_id)));
  const currentCues = compiled.splitCues.filter(cue => motherPartition?pieceIds.has(cue.piece_id):currentIds.has(cue.arc_parent_cue_id));
  const editIds = currentCues.flatMap(cue => [cue.cue_id, ...(cue.words_target_range ? [cue.cue_id + '/words'] : [])]);
  if (!idsEqual(currentValue.edits.music_edits, 'music_task_cue_id', editIds)
    || value.edits.music_edits.some(edit => !nonempty(edit.transition_reason))
    || value.edits.uncertainties.length) fail('part_exact_piece_edits_required');
  for (const response of currentValue.edits.action_responses) {
    const action = fullInput.data.director.music_actions.find(row => row.id === response.action_id);
    const cue = currentCues.find(row => row.cue_id === response.music_task_cue_id);
    const covered = value.edits.schema_version === 2
      ? actionTasksCover(response, action, currentCues.flatMap(row => [row,
        ...(row.words_target_range ? [{ cue_id: row.cue_id + '/words', target_range: row.words_target_range }] : [])]), 2)
      : cue && action?.target_range[0] >= cue.target_range[0] && action?.target_range[1] <= cue.target_range[1];
    if (!action || !same(action.target_range, response.target_range) || !nonempty(response.reason) || !covered)
      fail('part_full_action_changed');
  }
  if (previous.length && value.edits.dialogue_ducking_db !== previous[0].value.edits.dialogue_ducking_db)
    fail('part_global_ducking_changed');
  return { compiled };
}

export function actualAssemblyTail(value, rawResponse, fullInput) {
  const arc = value.plan.arcs.at(-1), piece = arc?.pieces.at(-1);
  if (!piece) fail('actual_tail_required');
  const cueId = `${arc.cue_id}/arc/${arc.arc_id}/${piece.piece_id}`;
  const edit = value.edits.music_edits.find(row => row.music_task_cue_id === cueId);
  const original = piece.source_window && fullInput.data.candidates.music.find(row =>
    row.segment_id === piece.source_window.segment_id && row.source_sha256 === piece.source_window.source_sha256
    && same(row.source_range, piece.source_window.candidate_source_range));
  if (piece.source_window && (!edit || !original)) fail('actual_tail_selection_or_edit_required');
  return { source_video_sha256: fullInput.data.source_video_sha256, previous_part_response: rawResponse,
    arc_id: arc.arc_id, cue_id: arc.cue_id, piece: structuredClone(piece), music_edit: edit ?? null,
    selected_candidate: original ? Object.fromEntries(['segment_id', 'asset_id', 'source_sha256', 'source_range',
      'library_allowed_source_range', 'allowed_target_range'].filter(key => original[key] !== undefined).map(key => [key, original[key]])) : null,
    dialogue_ducking_db: value.edits.dialogue_ducking_db,
    basis: 'actual_previous_selected_piece_and_edit; not an unused alternative', actual_audio_hearing_approved: false };
}

export function mergeBoundedAssemblyValues(responses, fullInput) {
  if (!responses.length || responses.some(row => row.value.execution_gaps.length)) fail('all_parts_complete_required');
  const first = responses[0].value;
  const motherPartition=fullInput.data?.bounded_assembly_projection_revision===motherActionPartitionRevision;
  const value = motherPartition?mergeMotherActionValues(responses,{...fullInput,schema:finitePartSchema(fullInput.schema)}).value:{ plan: { schema_version: 2, source_video_sha256: fullInput.data.source_video_sha256,
    arcs: responses.flatMap(row => row.value.plan.arcs) },
    edits: { ...(first.edits.schema_version === 2 ? { schema_version: 2 } : {}),
      music_edits: responses.flatMap(row => row.value.edits.music_edits),
      action_responses: responses.flatMap(row => row.value.edits.action_responses),
      sounds: responses.flatMap(row => row.value.edits.sounds), dialogue_ducking_db: first.edits.dialogue_ducking_db,
      uncertainties: responses.flatMap(row => row.value.edits.uncertainties) },
    execution_gaps: responses.flatMap(row => row.value.execution_gaps),
    review_pending: responses.flatMap(row => row.value.review_pending) };
  validateSchema(value, fullInput.schema);
  if (!idsEqual(value.plan.arcs, 'cue_id', fullInput.data.director.cues.map(row => row.cue_id))
    || !idsEqual(value.edits.action_responses, 'action_id', fullInput.data.director.music_actions.map(row => row.id))
    || !idsEqual(value.edits.sounds, 'event_id', fullInput.data.analysis.sound_events.map(row => row.id))
    || responses.some(row => row.value.edits.dialogue_ducking_db !== first.edits.dialogue_ducking_db))
    fail('full_unique_ownership_required');
  return value;
}

/** Returns null for an unchanged small request. Never starts one part before
 * every part and its continuation allowance fit the whole remaining budget. */
export function preflightBoundedResearchAssembly(request, session, { maxParts, remainingRequests = Infinity,
  previousTailAllowanceTokens = 1600 } = {}) {
  maxParts ??= request.data?.bounded_assembly_projection_revision===motherActionPartitionRevision?4:3;
  if (typeof session.inputBudget !== 'function') return null;
  const estimate = input => session.inputBudget(assemblySessionEnvelope(input, session));
  const maximum = session.maxSubmittedInputTokens ?? 16000;
  const full = estimate(request);
  if ((full.submitted_input_tokens ?? full.estimated_tokens) <= maximum) return null;
  if (request.data?.diagnostic_sample) fail('diagnostic_sample_partition_not_supported');
  const repairCap = session.runtime?.stageRepairCap?.(request.stage);
  if (repairCap !== 0) fail('zero_implicit_repairs_required');
  const finite = { ...request, schema: finitePartSchema(request.schema) };
  const prepared = prepareBoundedAssemblyInputs(finite, { estimateInputBudget: estimate,
    maxInputTokens: maximum, maxParts, previousTailAllowanceTokens });
  if (!prepared.parts?.length || prepared.parts.length > maxParts || prepared.parts.length > remainingRequests)
    fail('whole_remaining_request_budget_insufficient');
  return { ...prepared, full_input_budget: full, max_input_tokens: maximum,
    reserved_previous_tail_tokens: previousTailAllowanceTokens, maximum_new_calls: prepared.parts.length,
    implicit_repair_calls: 0, new_model_calls: 0 };
}

export async function executeBoundedResearchAssembly({ request, requestBinding, session, directory,
  validateFinal, maxParts, gapClassificationRecovery }) {
  let recovery=null;
  if(gapClassificationRecovery){
    const {preflightBoundAssemblyGapClassificationRecovery}=await import('./bounded_assembly_gap_classification.mjs');
    recovery=await preflightBoundAssemblyGapClassificationRecovery(gapClassificationRecovery,{request});
    if(!same(requestBinding,gapClassificationRecovery.caller))fail('gap_recovery_original_caller_binding_required');
  }
  maxParts ??= request.data?.bounded_assembly_projection_revision===motherActionPartitionRevision?4:3;
  const initial = preflightBoundedResearchAssembly(request, session, { maxParts });
  if (!initial) {if(recovery)fail('gap_recovery_original_bounded_scope_required');return null;}
  const available = session.trialBudget ? await session.trialBudget.inspect({ budget: { submitted_input_tokens: 0,
    scope: 'bounded_whole_assembly_preflight_only' } }) : { remaining_requests: maxParts };
  const prepared = preflightBoundedResearchAssembly(request, session,
    { maxParts, remainingRequests: available.remaining_requests });
  if(recovery&&(!same(prepared.parts.map(p=>p.input),recovery.old.parts.map(p=>p.input))
    ||!same(prepared.parts[0].input,recovery.input)))fail('gap_recovery_original_partition_changed');
  if(available.remaining_ms!==undefined&&(!Number.isFinite(available.remaining_ms)||available.remaining_ms<=0))
    fail('whole_remaining_activity_budget_insufficient');
  const preflight = await stable(path.join(directory, 'preflight.json'), { ...prepared,
    original_request: requestBinding, available_requests_before_submission: available.remaining_requests,
    ...(recovery?{gap_classification_recovery:gapClassificationRecovery,maximum_new_calls:1+prepared.parts.length-1,
      original_part_reused_without_replanning:true}:{}),
    remaining_ms_before_submission: available.remaining_ms ?? null });
  const responses = [], parts = [];
  for (const [index, part] of prepared.parts.entries()) {
    let input = structuredClone(part.input);
    if (responses.length) {
      const previous = responses.at(-1);
      input = withActualPreviousAssemblyTail(input, actualAssemblyTail(previous.value, previous.raw_response, request));
      input.schema.properties.edits.properties.dialogue_ducking_db.enum = [responses[0].value.edits.dialogue_ducking_db];
    }
    const budget = session.inputBudget(assemblySessionEnvelope(input, session));
    if ((budget.submitted_input_tokens ?? budget.estimated_tokens) > prepared.max_input_tokens)
      fail('actual_continuation_exceeds_preflight_allowance');
    const requestRef = await stable(path.join(directory, `part-${index + 1}`, 'input.json'), input);
    let response;
    if(index===0&&recovery){
      const {executeBoundAssemblyGapClassification}=await import('./bounded_assembly_gap_classification.mjs');
      response=await executeBoundAssemblyGapClassification({row:recovery,session,directory:path.join(directory,'gap-classification')});
    }else response = typeof session.director === 'function' ? await session.director(input) : await session.request(input.stage, input);
    const execution = await verifyBoundedAssemblyPartExecution(response, { input, session });
    await verifyEvidenceBindings(response.raw_response);
    const raw = await readJson(response.raw_response.path);
    if (!same(raw.value, response.value) || raw.source_video_sha256 !== request.data.source_video_sha256
      || raw.qualified !== false || raw.production_approval !== false) fail('actual_part_response_changed');
    const validation = validateBoundedAssemblyPart(response.value, { ...part, input }, responses, request);
    const receipt = await stable(path.join(directory, `part-${index + 1}`, 'completed.json'), {
      input: requestRef, raw_response: response.raw_response, budget, cue_ids: part.cue_ids,
      action_ids: part.action_ids, event_ids: part.event_ids, target_range: part.target_range,
      previous_response: responses.at(-1)?.raw_response ?? null,
      execution,
      ...(part.mother_action_partition?{mother_action_partition:part.mother_action_partition}:{}),
      execution_gap: validation.execution_gap === true, actual_audio_hearing_approved: false, production_approval: false });
    parts.push(receipt);
    if (validation.execution_gap) return { ...response, bounded_assembly: { preflight, parts,
      completed_parts: responses.length, halted_on_actual_execution_gap: true } };
    responses.push({...response,...(part.mother_action_partition?{mother_action_partition:part.mother_action_partition}:{})});
  }
  const value = mergeBoundedAssemblyValues(responses, request);
  await validateFinal(value);
  const raw = { schema_version: 1, kind: 'bounded_research_assembly_result', execution_kind: 'host_bounded_assembly_merge',
    source_video_sha256: request.data.source_video_sha256, input_sha256: requestBinding.sha256,
    original_request: requestBinding, preflight, parts, constituent_responses: responses.map(row => row.raw_response),
    value, completion_status: 'complete', actual_model_parts_executed: true, actual_runtime_executed: false,
    actual_input_processed: true, actual_audio_processed: false, actual_video_processed: false,
    usage: null, usage_is_in_constituent_receipts: true, new_account_call_not_created_by_merge: true,
    qualified: false, artistic_approval: false, production_approval: false };
  if(recovery)raw.gap_classification_recovery=gapClassificationRecovery;
  if(request.data.bounded_assembly_projection_revision===motherActionPartitionRevision){
    raw.partition_revision=motherActionPartitionRevision;
    raw.arc_identity_mapping=mergeMotherActionValues(responses,{...request,schema:finitePartSchema(request.schema)}).mapping;
  }
  const rawResponse = await stable(path.join(directory, 'merged-response.json'), raw);
  return { ...raw, raw_response: rawResponse, bounded_assembly: { preflight, parts },
    cli_receipts: responses.flatMap(row => row.cli_receipts ?? []),
    historical_cli_receipts: responses.flatMap(row => row.historical_cli_receipts ?? []) };
}
