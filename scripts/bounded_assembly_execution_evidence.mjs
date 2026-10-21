import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';
import { baseStructuredEvidencePrompt, validateCompletedTurnCleanup } from './codex_cli_runtime.mjs';
import { completedBatchEventsValid } from './bound_direction_execution_evidence.mjs';
import { isActualCodexCliResolution } from './actual_codex_cli_resolution.mjs';

const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('bounded_assembly_evidence_' + reason); };
const unqualified = value => value.qualified === false && value.artistic_approval === false && value.production_approval === false;

// Only the actual supported CLI protocol is accepted here. A future API
// implementation needs its own bound submission proof, not a fabricated CLI receipt.
export async function verifyBoundedAssemblyPartExecution(response, { input, session }) {
  if(response?.raw_response?.path){
    await verifyEvidenceBindings(response.raw_response);
    if((await readJson(response.raw_response.path)).kind==='bound_diagnostic_gap_classified_assembly_part_v1'){
      const {verifyBoundAssemblyGapClassifiedPart}=await import('./bounded_assembly_gap_classification.mjs');
      return verifyBoundAssemblyGapClassifiedPart(response,{input,session});
    }
  }
  const classification=input?.stage==='diagnostic_assembly_gap_fields_v1'
    && input.data?.gap_classification_revision==='diagnostic-only-gap-classification-v1';
  if ((input?.stage !== 'current_research_episode_assembly' && !classification) || !input.data?.assembly_partition
    || session?.backend?.protocol !== 'codex_cli' || session.backend.backend_id !== 'codex-cli-chatgpt')
    fail('supported_actual_session_required');
  const source = input.data.source_video_sha256;
  const expectedRevision = session.runtime?.expectedStageModelRevision?.(input.stage) ?? session.backend.model_revision;
  const envelope = session.story ? { ...input, frames: [], data: { ...input.data,
    completed_story: session.story.analysis, source_frame_mapping: session.story.frame_mapping,
    frame_policy: 'Previously analyzed complete frames; this stage consumes the bound analysis, not a fresh image or audio observation.' } } : input;
  await verifyEvidenceBindings(response?.raw_response);
  if (!response?.raw_response?.path) fail('raw_response_required');
  const raw = await readJson(response.raw_response.path);
  for (const row of [raw, response]) if (row.execution_kind !== 'codex_cli_inference'
    || row.backend_id !== session.backend.backend_id || row.model_revision !== expectedRevision
    || row.model !== expectedRevision.split(':')[0] || row.source_video_sha256 !== source
    || row.completion_status !== 'complete' || row.actual_runtime_executed !== true || row.actual_input_processed !== true
    || row.actual_audio_processed !== false || row.actual_video_processed !== false || row.actual_frames_submitted !== 0
    || !unqualified(row) || !same(row.scopes, []) || row.synthetic_protocol_fixture || row.actual_test_inference_performed === false)
    fail('actual_unqualified_response_required');
  if (!same(raw.value, response.value) || raw.request_sha256 !== response.request_sha256
    || !same(raw.usage, response.usage) || raw.partition_revision || raw.cli_receipts?.length !== 1
    || (raw.historical_cli_receipts ?? []).length) fail('single_actual_completion_required');
  await verifyEvidenceBindings([raw.evidence_files, raw.cli_receipts, response.cli_receipts, response.historical_cli_receipts]);
  const requestRef = raw.evidence_files?.find(ref => path.resolve(ref.path) === path.join(path.dirname(response.raw_response.path), 'request.json'));
  if (!requestRef) fail('actual_request_required');
  const request = await readJson(requestRef.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.role !== 'director'
    || request.model_requested !== raw.model || request.model_revision !== expectedRevision || request.backend_id !== raw.backend_id
    || request.source_video_sha256 !== source || shaBytes(canonical(request)) !== raw.request_sha256
    || !same(request.input, envelope) || !same(request.submitted_images, [])
    || request.input_sha256 !== raw.input_sha256 || !request.input_bindings?.some(ref => ref.sha256 === source))
    fail('actual_request_or_envelope_changed');
  await verifyEvidenceBindings(request.input_bindings);
  const receiptRef = raw.cli_receipts[0], receipt = await readJson(receiptRef.path);
  if (receipt.status !== 'complete' || receipt.execution_kind !== 'codex_cli_inference' || receipt.stage !== 'director'
    || receipt.cli_invocations !== 1 || receipt.account_turn_started !== true || receipt.repair_of
    || receipt.process_terminated !== true || receipt.timed_out !== false || (receipt.exit_code !== 0 && !receipt.completed_turn_cleanup)
    || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false
    || !same(receipt.request, requestRef) || receipt.request_sha256 !== raw.request_sha256
    || receipt.source_video_sha256 !== source || receipt.input_sha256 !== raw.input_sha256
    || receipt.model_requested !== raw.model || receipt.model_revision !== expectedRevision
    || !unqualified(receipt) || receipt.new_api_key_used !== false || !same(receipt.usage, raw.usage))
    fail('actual_receipt_changed');
  const actualReceipts = response.reused === true ? response.historical_cli_receipts : response.cli_receipts;
  if (!same(actualReceipts, raw.cli_receipts)
    || (response.reused === true ? response.cli_receipts?.length : (response.historical_cli_receipts ?? []).length))
    fail('invocation_accounting_changed');
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
    || !same(restoreCompactBusinessValue(wire, contract), raw.value)) fail('compact_reconstruction_changed');
  if (await readFile(receipt.prompt.path, 'utf8') !== baseStructuredEvidencePrompt('director', contract.input))
    fail('actual_prompt_changed');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const turns = events.filter(row => row.type === 'turn.completed');
  if (!completedBatchEventsValid(events, receipt,{finalBytes:await readFile(receipt.final.path),schema:contract.wireSchema})
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), wire)
    || receipt.usage?.reported_turns !== 1 || receipt.usage?.source !== 'cli_turn_completed_events') fail('actual_model_event_changed');
  for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'])
    if ((receipt.usage.tokens[key] ?? 0) !== (turns[0].usage?.[key] ?? 0)) fail('actual_usage_changed');
  if (receipt.completed_turn_cleanup) validateCompletedTurnCleanup(receipt.completed_turn_cleanup,
    { events, finalBytes: await readFile(receipt.final.path), schema: contract.wireSchema });
  validateSchema(raw.value, input.schema);
  return { original_request: requestRef, raw_response: response.raw_response, receipt: receiptRef,
    request_sha256: raw.request_sha256, source_video_sha256: source, backend_id: raw.backend_id,
    model_revision: raw.model_revision, actual_usage: receipt.usage, reused: response.reused === true,
    new_cli_invocations: response.reused === true ? 0 : 1, actual_model_execution_verified: true,
    actual_audio_hearing_approved: false, production_approval: false };
}
