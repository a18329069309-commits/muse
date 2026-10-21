import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, shaBytes, validateSchema, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';
import { baseStructuredEvidencePrompt, boundedRevision, validateCompletedTurnCleanup } from './codex_cli_runtime.mjs';
import { completedBatchEventsValid } from './bound_direction_execution_evidence.mjs';
import {projectIndependentMusicSelectionInput,projectIndependentMusicSelectionPartition} from './independent_music_selection_projection.mjs';
import {expandBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';
import {isActualCodexCliResolution} from './actual_codex_cli_resolution.mjs';

const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('completed_material_selection_' + reason); };
const unqualified = row => row.qualified === false && row.artistic_approval === false && row.production_approval === false;
function checkRaw(raw, source, inputSha) {
  if (raw.execution_kind !== 'codex_cli_inference' || raw.backend_id !== 'codex-cli-chatgpt'
    || raw.completion_status !== 'complete' || raw.actual_runtime_executed !== true || raw.actual_input_processed !== true
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.actual_frames_submitted !== 0
    || raw.source_video_sha256 !== source || raw.input_sha256 !== inputSha || !unqualified(raw) || !same(raw.scopes, [])
    || raw.synthetic_protocol_fixture || raw.actual_test_inference_performed === false) fail('actual_unqualified_response_required');
}
function checkDecisions(value, tasks, schema) {
  validateSchema(value, schema);
  if (!same(value.decisions.map(row => row.task_id), tasks.map(row => row.task_id))) fail('ordered_task_coverage_changed');
  for (const [index, decision] of value.decisions.entries()) {
    const task = tasks[index], ids = new Set(task.candidates.map(row => row.segment_id));
    if (decision.cue_id !== task.cue_id || decision.kind !== task.kind
      || decision.selected_segment_ids.some(id => !ids.has(id))
      || decision.rejections.some(row => !ids.has(row.segment_id))) fail('decision_candidate_or_task_changed');
  }
}
async function actualPart(binding, expectedInput, source, inputSha) {
  await verifyEvidenceBindings(binding); const raw = await readJson(binding.path); checkRaw(raw, source, inputSha);
  if (raw.partition_revision || raw.cli_receipts?.length !== 1 || (raw.historical_cli_receipts ?? []).length)
    fail('single_actual_part_required');
  await verifyEvidenceBindings([raw.evidence_files, raw.cli_receipts]);
  const requestRef = raw.evidence_files.find(ref => path.resolve(ref.path) === path.join(path.dirname(binding.path), 'request.json'));
  if (!requestRef) fail('original_part_request_required');
  const request = await readJson(requestRef.path), receiptRef = raw.cli_receipts[0], receipt = await readJson(receiptRef.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.role !== 'material_candidate_selection'
    || request.source_video_sha256 !== source || request.input_sha256 !== inputSha
    || shaBytes(canonical(request)) !== raw.request_sha256 || request.model_requested !== raw.model
    || request.model_revision !== raw.model_revision || request.backend_id !== raw.backend_id
    || !same(request.input, expectedInput) || !same(request.submitted_images, [])
    || !request.input_bindings?.some(ref => ref.sha256 === source)
    || !request.input_bindings.some(ref => ref.sha256 === inputSha)) fail('part_request_changed');
  await verifyEvidenceBindings(request.input_bindings);
  if (receipt.status !== 'complete' || receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
    || (receipt.exit_code !== 0 && !receipt.completed_turn_cleanup) || receipt.process_terminated !== true || receipt.timed_out !== false
    || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false
    || !same(receipt.request, requestRef) || receipt.request_sha256 !== raw.request_sha256
    || receipt.input_sha256 !== inputSha || receipt.source_video_sha256 !== source
    || receipt.model_requested !== raw.model || receipt.model_revision !== raw.model_revision
    || !unqualified(receipt) || receipt.new_api_key_used !== false) fail('actual_part_receipt_changed');
  await verifyEvidenceBindings([receipt.final, receipt.schema, receipt.prompt, receipt.jsonl, receipt.host_business_contract,
    receipt.host_cli_resolution, receipt.worker_instructions]);
  const resolution = await readJson(receipt.host_cli_resolution.path);
  if (resolution.injected === true || !await isActualCodexCliResolution(resolution)
    || receipt.command !== resolution.actual_path || !same(receipt.transport, request.transport)
    || !same(raw.transport, request.transport) || receipt.worker_profile !== request.worker_profile
    || receipt.worker_instructions.sha256 !== request.worker_instructions?.sha256 || receipt.submitted_image_count !== 0)
    fail('actual_cli_profile_changed');
  const contract = projectCompactBusinessContract(request.input), wire = await readJson(receipt.final.path);
  const reconstruction = raw.host_contract_reconstruction;
  if (!reconstruction || reconstruction.audit?.sha256 !== receipt.host_business_contract.sha256
    || reconstruction.caller_schema_revalidated !== true || reconstruction.host_input_identity_restored !== true
    || reconstruction.source_clocks_or_facts_rewritten !== false
    || !same(await readJson(receipt.host_business_contract.path), contract.audit)
    || !same(await readJson(receipt.schema.path), contract.wireSchema) || !same(wire, reconstruction.model_value)
    || !same(restoreCompactBusinessValue(wire, contract), raw.value)) fail('actual_compact_reconstruction_changed');
  if (await readFile(receipt.prompt.path, 'utf8') !== baseStructuredEvidencePrompt(request.role, contract.input))
    fail('actual_prompt_changed');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const turns = events.filter(row => row.type === 'turn.completed');
  if (receipt.completed_turn_cleanup) validateCompletedTurnCleanup(receipt.completed_turn_cleanup,
    { events, finalBytes: await readFile(receipt.final.path), schema: contract.wireSchema });
  if (!completedBatchEventsValid(events, receipt,{finalBytes:await readFile(receipt.final.path),schema:contract.wireSchema})
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), wire)
    || !same(receipt.usage, raw.usage) || receipt.usage?.reported_turns !== 1
    || receipt.usage?.source !== 'cli_turn_completed_events') fail('actual_event_or_usage_changed');
  for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'])
    if ((receipt.usage.tokens[key] ?? 0) !== (turns[0].usage?.[key] ?? 0)) fail('actual_token_usage_changed');
  checkDecisions(raw.value, expectedInput.independent_music_selection_projection===undefined?expectedInput.tasks
    :expandBoundedInlineRecords(expectedInput.music_task_evidence_inline).tasks, expectedInput.response_schema);
  return { raw, request, receipt, receiptRef, binding };
}

// Replays immutable, completed model choices only. It grants neither audio
// qualification nor permission to replace current story/material identities.
// The caller separately verifies these old facts against its current inputs.
export async function verifyCompletedMaterialSelection(binding) {
  await verifyEvidenceBindings(binding); const record = await readJson(binding.path);
  if (record.kind !== 'independent_pack_material_selection' || record.schema_version !== 1
    || record.actual_asset_selection_performed !== true || record.artistic_approval !== false || record.production_approval !== false)
    fail('completed_record_required');
  await verifyEvidenceBindings([record.input, record.raw_response]);
  const request = await readJson(record.input.path), raw = await readJson(record.raw_response.path);
  const source = record.source_video_sha256, originalFullInput = { ...request, input: record.input };
  const fullInput=request.independent_music_selection_projection===undefined?originalFullInput
    :projectIndependentMusicSelectionInput(originalFullInput);
  if (request.stage !== 'independent_music_pack_material_selection' || request.material_strategy !== 'independent_music_packs'
    || request.source_video_sha256 !== source || !Array.isArray(request.tasks) || !request.tasks.length
    || new Set(request.tasks.map(row => row.task_id)).size !== request.tasks.length || request.frames?.length)
    fail('original_selection_request_required');
  await verifyEvidenceBindings([request.publication, request.target_context, request.source_frames, request.observation_files]);
  checkRaw(raw, source, record.input.sha256);
  await verifyEvidenceBindings([raw.evidence_files, raw.constituent_responses, raw.cli_receipts]);
  const parts = [];
  if (raw.partition_revision) {
    if (raw.partition_revision !== boundedRevision || raw.partition_count !== raw.constituent_responses?.length
      || raw.partition_count < 1 || raw.usage !== null || raw.usage_is_in_constituent_receipts !== true
      || (raw.historical_cli_receipts ?? []).length || raw.reused !== false) fail('bounded_accounting_changed');
    const parentRef = raw.evidence_files.find(ref => path.resolve(ref.path) === path.join(path.dirname(record.raw_response.path), 'request.json'));
    if (!parentRef || parentRef.sha256 !== raw.request_sha256) fail('bounded_request_identity_changed');
    const parent = await readJson(parentRef.path);
    if (!same(parent, { role: 'material_candidate_selection', input: fullInput, revision: boundedRevision }))
      fail('bounded_original_request_changed');
    let start = 0;
    for (const ref of raw.constituent_responses) {
      const child = await readJson(ref.path);
      const childRef = child.evidence_files?.find(row => path.resolve(row.path) === path.join(path.dirname(ref.path), 'request.json'));
      if (!childRef) fail('part_request_missing');
      await verifyEvidenceBindings(childRef); const childRequest = await readJson(childRef.path);
      const count = childRequest.input?.tasks?.length;
      if (!Number.isSafeInteger(count) || count < 1 || count > 20 || start + count > request.tasks.length)
        fail('contiguous_partition_invalid');
      let expected = { ...fullInput, tasks: fullInput.tasks.slice(start, start + count),
        partition: { revision: boundedRevision, item_start: start, total_items: request.tasks.length, source_order_preserved: true } };
      if(request.independent_music_selection_projection!==undefined)
        expected=projectIndependentMusicSelectionPartition(expected,{fullInput:originalFullInput});
      parts.push(await actualPart(ref, expected, source, record.input.sha256)); start += count;
    }
    if (start !== request.tasks.length || !same(raw.value, { decisions: parts.flatMap(row => row.raw.value.decisions) })
      || !same(raw.cli_receipts, parts.map(row => row.receiptRef))) fail('bounded_exact_merge_changed');
  } else parts.push(await actualPart(record.raw_response, fullInput, source, record.input.sha256));
  if (parts.some(row => row.raw.model !== raw.model || row.raw.model_revision !== raw.model_revision
    || row.raw.backend_id !== raw.backend_id || !same(row.raw.transport, raw.transport))) fail('model_identity_changed');
  checkDecisions(raw.value, request.tasks, request.response_schema);
  if (!same(record.value, raw.value) || !same(record.cli_receipts, raw.cli_receipts)
    || record.selected_count !== raw.value.decisions.reduce((sum, row) => sum + row.selected_segment_ids.length, 0))
    fail('record_decision_or_accounting_changed');
  const observations = [];
  for (const observationBinding of request.observation_files ?? []) {
    await verifyEvidenceBindings(observationBinding); const value = await readJson(observationBinding.path);
    if (!unqualified(value) || value.observation?.lyrics_verified !== false || value.observation?.sound_semantics_verified !== false
      || value.observation?.artistic_approval !== false) fail('original_observation_qualification_changed');
    await verifyLocalAudioExecution(value, { protocol: value.protocol, backend_id: value.backend_id, model_revision: value.model_revision });
    await verifyEvidenceBindings(value.observation);
    observations.push({ binding: observationBinding, value });
  }
  const historical = [...(raw.historical_cli_receipts ?? []), ...raw.cli_receipts];
  const proof = { revision: 'completed-material-selection-evidence-v1', record: binding, original_request: record.input,
    original_response: record.raw_response, source_video_sha256: source, constituent_count: parts.length,
    actual_usage: parts.map(row => ({ receipt: row.receiptRef, usage: row.raw.usage })),
    original_decisions_preserved: true, new_model_calls: 0, reused: true,
    qualification_granted: false, professional_qualification: false, production_approval: false };
  const response = { ...raw, raw_response: record.raw_response, cli_receipts: [], historical_cli_receipts: historical,
    reused: true, new_model_calls: 0, recovery_proof: proof };
  return { record, request, raw, response, observations, proof };
}
