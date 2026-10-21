import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { objectSchema, readJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';
import { baseStructuredEvidencePrompt } from './codex_cli_runtime.mjs';
import {isActualCodexCliResolution} from './actual_codex_cli_resolution.mjs';

export const researchAssemblyRecoveryInputKeys = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates',
  'current_materials', 'case_routes', 'music_source_provenance'];
const refSchema = objectSchema({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
export const researchAssemblyRecoverySchema = objectSchema({ schema_version: { type: 'integer', enum: [1] },
  kind: { type: 'string', enum: ['bound_completed_research_assembly_recovery'] }, caller: refSchema, response: refSchema,
  host_consumption: refSchema, source_video_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  qualified: { type: 'boolean', enum: [false] }, production_approval: { type: 'boolean', enum: [false] } });
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('research_assembly_recovery_' + reason); };

export async function loadBoundAssemblyRecovery(binding, { inputs, schema, source } = {}) {
  await verifyEvidenceBindings(binding); const recovery = await readJson(binding.path);
  if (recovery.kind === 'bound_completed_sound_decision_recovery') {
    const { loadBoundSoundDecisionRecovery } = await import('./bound_sound_decision_recovery.mjs');
    return loadBoundSoundDecisionRecovery(binding, { inputs, schema, source });
  }
  if (recovery.kind === 'bound_completed_assembly_host_omission_recovery') {
    if (!inputs || !schema || !source?.sha256) fail('exact_current_recovery_context_required');
    const { loadBoundHostSoundOmissionRecovery } = await import('./assembly_host_sound_omissions.mjs');
    return loadBoundHostSoundOmissionRecovery(binding, { inputs, schema, source });
  }
  validateSchema(recovery, researchAssemblyRecoverySchema);
  if (!inputs || !same(Object.keys(inputs).sort(), [...researchAssemblyRecoveryInputKeys].sort())) fail('exact_inputs_required');
  await verifyEvidenceBindings([recovery.caller, recovery.response, recovery.host_consumption, source, ...Object.values(inputs)]);
  const caller = await readJson(recovery.caller.path), raw = await readJson(recovery.response.path), host = await readJson(recovery.host_consumption.path);
  if (caller.stage !== 'current_research_episode_assembly' || caller.data?.source_video_sha256 !== source.sha256
    || recovery.source_video_sha256 !== source.sha256 || !same(caller.schema ?? caller.response_schema, schema)) fail('source_or_schema_changed');
  const originalInputs = caller.data.bound_artifacts;
  if (!originalInputs || !same(Object.keys(originalInputs).sort(), [...researchAssemblyRecoveryInputKeys].sort())) fail('original_inputs_required');
  await verifyEvidenceBindings(Object.values(originalInputs));
  for (const key of researchAssemblyRecoveryInputKeys) if (inputs[key].sha256 !== originalInputs[key].sha256) fail('stage_input_changed_' + key);
  const manifest = await readJson(inputs.manifest.path);
  if (manifest.source_sha256 !== source.sha256 || !same(manifest.timeline, caller.data.timeline)) fail('manifest_or_clock_changed');
  // This is the original complete host record, before the finite editing view.
  await verifyEvidenceBindings(caller.data.full_input);
  const completeCaller = await readJson(caller.data.full_input.path);
  if (completeCaller.stage !== caller.stage || completeCaller.data?.source_video_sha256 !== source.sha256
    || !same(completeCaller.schema, schema) || !same(completeCaller.data.bound_artifacts, originalInputs)) fail('full_host_input_changed');
  for (const key of researchAssemblyRecoveryInputKeys) if (!same(completeCaller.data[key], await readJson(inputs[key].path)))
    fail('original_stage_value_changed_' + key);
  if (!same(caller.data.analysis, await readJson(inputs.analysis.path)) || !same(caller.data.director, await readJson(inputs.director.path)))
    fail('current_story_or_direction_changed');
  if (raw.execution_kind !== 'codex_cli_inference' || raw.actual_runtime_executed !== true || raw.actual_input_processed !== true
    || raw.completion_status !== 'complete' || raw.actual_audio_processed !== false || raw.actual_video_processed !== false
    || raw.qualified !== false || raw.artistic_approval !== false || raw.production_approval !== false
    || raw.backend_id !== 'codex-cli-chatgpt' || raw.source_video_sha256 !== source.sha256
    || !same(raw.scopes, []) || raw.synthetic_protocol_fixture || raw.actual_test_inference_performed === false)
    fail('real_unqualified_completed_response_required');
  if (host.execution_kind !== 'codex_cli_host_consumption' || host.stage !== 'director' || host.response?.sha256 !== recovery.response.sha256
    || host.backend?.protocol !== 'codex_cli' || host.backend.backend_id !== raw.backend_id || host.backend.model_revision !== raw.model_revision
    || host.actual_audio_processed !== false || host.formal_adoption_allowed !== false || host.production_approval !== false
    || host.reused !== false || !same(host.usage, raw.usage)
    || !same(host.historical_cli_receipts, raw.historical_cli_receipts ?? [])) fail('actual_host_consumption_required');
  await verifyEvidenceBindings([...raw.evidence_files, ...(raw.cli_receipts ?? []), ...(raw.historical_cli_receipts ?? [])]);
  const requestRef = raw.evidence_files.find(row => path.resolve(row.path) === path.join(path.dirname(recovery.response.path), 'request.json'));
  if (!requestRef) fail('original_cli_request_required');
  const request = await readJson(requestRef.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.role !== 'director' || request.input?.stage !== caller.stage
    || request.source_video_sha256 !== source.sha256 || shaBytes(canonical(request)) !== raw.request_sha256
    || request.backend_id !== raw.backend_id || request.model_requested !== raw.model
    || request.model_revision !== raw.model_revision) fail('actual_cli_request_changed');
  // Exact caller fields are retained when CodexEpisodeSession only appends its
  // completed-story/frame-map provenance. Creative and factual values cannot differ.
  for (const [key, value] of Object.entries(caller)) if (key !== 'data' && !same(request.input[key], value)) fail('caller_request_changed');
  for (const [key, value] of Object.entries(caller.data)) if (!same(request.input.data[key], value)) fail('caller_data_changed_' + key);
  if (!Array.isArray(raw.cli_receipts) || raw.cli_receipts.length !== 1 || !same(host.cli_receipts, raw.cli_receipts)) fail('single_actual_completion_required');
  const receipt = await readJson(raw.cli_receipts[0].path);
  if (receipt.status !== 'complete' || receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
    || receipt.exit_code !== 0 || receipt.process_terminated !== true || receipt.timed_out !== false
    || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false
    || receipt.request?.sha256 !== requestRef.sha256 || receipt.request_sha256 !== raw.request_sha256
    || receipt.model_revision !== raw.model_revision || receipt.model_requested !== raw.model
    || receipt.source_video_sha256 !== source.sha256 || receipt.qualified !== false
    || receipt.artistic_approval !== false || receipt.production_approval !== false || receipt.new_api_key_used !== false)
    fail('real_cli_completion_required');
  await verifyEvidenceBindings([receipt.request, receipt.final, receipt.schema, receipt.prompt, receipt.jsonl, receipt.host_business_contract,
    receipt.host_cli_resolution, receipt.worker_instructions]);
  const resolution = await readJson(receipt.host_cli_resolution.path);
  if (resolution.injected === true || !await isActualCodexCliResolution(resolution)
    || receipt.command !== resolution.actual_path || !same(receipt.transport, request.transport)
    || receipt.worker_profile !== request.worker_profile || receipt.worker_instructions.sha256 !== request.worker_instructions?.sha256
    || receipt.submitted_image_count !== request.submitted_images?.length) fail('real_cli_profile_required');
  const contract = projectCompactBusinessContract(request.input), wire = await readJson(receipt.final.path), reconstruction = raw.host_contract_reconstruction;
  if (!reconstruction || reconstruction.audit?.sha256 !== receipt.host_business_contract.sha256
    || reconstruction.caller_schema_revalidated !== true || reconstruction.host_input_identity_restored !== true
    || reconstruction.source_clocks_or_facts_rewritten !== false
    || !same(await readJson(receipt.host_business_contract.path), contract.audit)
    || !same(await readJson(receipt.schema.path), contract.wireSchema) || !same(wire, reconstruction.model_value)
    || !same(restoreCompactBusinessValue(wire, contract), raw.value)) fail('strict_host_reconstruction_changed');
  if (await readFile(receipt.prompt.path, 'utf8') !== baseStructuredEvidencePrompt(request.role, contract.input)) fail('actual_stdin_changed');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const turns = events.filter(row => row.type === 'turn.completed');
  if (turns.length !== 1 || events.some(row => ['turn.failed', 'error'].includes(row.type))
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), wire)
    || receipt.usage?.tokens?.input_tokens !== turns[0].usage?.input_tokens || !same(receipt.usage, raw.usage)) fail('actual_model_event_or_usage_changed');
  validateSchema(raw.value, schema);
  const historicalReceipts = [...(raw.historical_cli_receipts ?? []), ...raw.cli_receipts];
  const stage = { request: recovery.caller, original_cli_request: requestRef, raw_response: recovery.response,
    host_consumption: recovery.host_consumption, recovery_binding: binding,
    execution_kind: 'bound_completed_research_assembly_recovery', original_execution_kind: 'codex_cli_inference',
    request_sha256: raw.request_sha256, backend_id: raw.backend_id, model_revision: raw.model_revision,
    usage: raw.usage, cli_receipts: [], historical_cli_receipts: historicalReceipts,
    reused: true, new_model_calls: 0, independent_audio_hearing_approved: false,
    actual_audio_processed: false, formal_adoption_allowed: false, production_approval: false };
  return { ...raw.value, value: raw.value, reused: true, new_model_calls: 0, actual_audio_processed: false,
    actual_video_processed: false, professional_qualification: false, production_approval: false,
    original_request: requestRef, raw_response: recovery.response, host_consumption: recovery.host_consumption,
    original_caller: recovery.caller, recovery_binding: binding, usage: raw.usage,
    cli_receipts: [], historical_cli_receipts: historicalReceipts,
    stage, original_execution_kind: 'codex_cli_inference' };
}
