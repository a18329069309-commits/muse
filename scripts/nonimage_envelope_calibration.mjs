import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
const verified = new WeakSet();
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export const nonImageEnvelopeCalibrationRevision = 'three-real-nonimage-envelope-residuals-v1';
const baseRevision = value => value?.replace(/:stage-reasoning-[a-z]+$/, '');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export async function sampleBoundEnvelopeReceipt(binding, { nativeFamily = false, nativeTerminalRecovery = null } = {}) {
  await verifyEvidenceBindings(binding); const receipt = await readJson(binding.path);
  let terminal=null;
  if(nativeTerminalRecovery){const{loadCompletedNativeRoute}=await import('./native_route_anchor_recovery.mjs');terminal=await loadCompletedNativeRoute(nativeTerminalRecovery);
    if(terminal.restoration.original_attempt.sha256!==binding.sha256)throw Error('envelope_calibration_native_terminal_receipt_changed');}
  if ((!terminal&&receipt.status !== 'complete') || receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
    || receipt.process_terminated !== true || !terminal&&(receipt.exit_code !== 0&&!(nativeFamily&&receipt.completed_turn_cleanup)||receipt.timed_out !== false)
    || receipt.submitted_image_count !== 0 || receipt.worker_profile !== 'structured_evidence_v2'
    || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false)
    throw Error('envelope_calibration_real_complete_nonimage_receipt_required');
  await verifyEvidenceBindings([receipt.prompt, receipt.schema, receipt.jsonl, receipt.final, receipt.request,
    receipt.worker_instructions, receipt.host_cli_resolution]);
  const request = await readJson(receipt.request.path), resolution = await readJson(receipt.host_cli_resolution.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.submitted_images?.length !== 0
    || resolution.injected === true || !['configured_path', 'verified_application_fallback'].includes(resolution.resolution_kind)
    || receipt.command !== resolution.actual_path || !receipt.model_revision)
    throw Error('envelope_calibration_real_cli_profile_required');
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const turns = events.filter(row => row.type === 'turn.completed');
  if (!turns.length || events.some(row => ['turn.failed', 'error'].includes(row.type))) throw Error('envelope_calibration_completed_usage_required');
  const actual = turns.reduce((sum, row) => {
    if (!Number.isSafeInteger(row.usage?.input_tokens) || row.usage.input_tokens < 0) throw Error('envelope_calibration_input_usage_required');
    return sum + row.usage.input_tokens;
  }, 0);
  if (receipt.usage?.tokens?.input_tokens !== actual || receipt.usage.reported_turns !== turns.length)
    throw Error('envelope_calibration_usage_mismatch');
  const schema = await readJson(receipt.schema.path), final = await readJson(receipt.final.path);
  const last = events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
  if (canonical(JSON.parse(last?.item.text ?? 'null')) !== canonical(final)) throw Error('envelope_calibration_actual_final_mismatch');
  if(nativeFamily){
    if(turns.length!==1||receipt.actual_configured_reasoning_effort!=='low'||!receipt.args.includes('model_reasoning_effort="low"'))throw Error('envelope_calibration_native_low_single_turn_required');
    const{typedStyleProviderSchema,typedStyleExpandedProviderSchema,projectTypedStyleModelInput}=await import('./typed_bounded_style_director.mjs');
    const{baseStructuredEvidencePrompt,validateCompletedTurnCleanup}=await import('./codex_cli_runtime.mjs');
    if(canonical(schema)!==canonical(typedStyleProviderSchema(request.input.schema))
      ||await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt('director',projectTypedStyleModelInput(request.input).input))throw Error('envelope_calibration_native_schema_or_stdin_changed');
    const{validateSchema}=await import('./audio_api.mjs');validateSchema(final,typedStyleExpandedProviderSchema(request.input.schema));
    if(receipt.completed_turn_cleanup)validateCompletedTurnCleanup(receipt.completed_turn_cleanup,{events,finalBytes:await readFile(receipt.final.path),schema:typedStyleExpandedProviderSchema(request.input.schema)});
  }
  const prompt = await readFile(receipt.prompt.path, 'utf8'), instructions = await readFile(receipt.worker_instructions.path);
  const components = { input_text_tokens: Math.ceil(Buffer.byteLength(prompt) / 3),
    output_schema_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(schema)) / 3), worker_instructions_tokens: Math.ceil(instructions.length / 3) };
  const profile = { model_revision: baseRevision(receipt.model_revision), worker_profile: receipt.worker_profile,
    instructions_sha256: receipt.worker_instructions.sha256, transport: receipt.transport,
    cli: { actual_path: resolution.actual_path, current_executable_sha256: await hashFile(resolution.actual_path),
      recorded_executable_sha256: resolution.actual_executable_sha256 ?? null, version: resolution.version,
      resolution_kind: resolution.resolution_kind, fallback_used: resolution.fallback_used },
    wire_schema_sha256: shaBytes(canonical(schema)), cwd: receipt.cwd, submitted_image_count: 0 };
  return { receipt: binding, execution_request_sha256: receipt.request_sha256, execution_jsonl_sha256: receipt.jsonl.sha256,
    ...(nativeFamily?{stage:request.input.stage,reasoning_effort:'low',...(nativeTerminalRecovery?{native_terminal_recovery:nativeTerminalRecovery}:{})}:{}),
    prompt: receipt.prompt, schema: receipt.schema, worker_instructions: receipt.worker_instructions,
    cli_resolution: receipt.host_cli_resolution, profile, actual_input_tokens: actual, estimated_visible_components: components,
    empirical_residual_tokens: Math.max(0, actual - Object.values(components).reduce((sum, value) => sum + value, 0)) };
}
const sample=sampleBoundEnvelopeReceipt;

export async function createNonImageEnvelopeCalibration({ receipts, outputFile, allowedStages = ['current_research_episode_assembly'], marginTokens = 1024 }) {
  if (!Array.isArray(receipts) || receipts.length < 3 || new Set(receipts.map(row => row.sha256)).size !== receipts.length
    || !Array.isArray(allowedStages) || !allowedStages.length || allowedStages.some(stage => !/^[a-z0-9_-]{1,100}$/.test(stage))
    || marginTokens !== 1024) throw Error('envelope_calibration_three_distinct_receipts_and_fixed_margin_required');
  const samples = []; for (const receipt of receipts) samples.push(await sample(receipt));
  if (new Set(samples.map(row => row.execution_request_sha256)).size !== samples.length
    || new Set(samples.map(row => row.execution_jsonl_sha256)).size !== samples.length)
    throw Error('envelope_calibration_distinct_actual_executions_required');
  if (samples.some(row => canonical(row.profile) !== canonical(samples[0].profile))) throw Error('envelope_calibration_profile_mismatch');
  const value = { schema_version: 1, kind: 'bound_nonimage_envelope_calibration', revision: nonImageEnvelopeCalibrationRevision,
    allowed_stages: allowedStages, profile: samples[0].profile, samples, margin_tokens: marginTokens,
    residual_cli_allowance_tokens: Math.max(...samples.map(row => row.empirical_residual_tokens)) + marginTokens,
    experiment_scope: 'same_lean_text_envelope_profile_across_declared_stages_no_images',
    exact_tokenizer_or_sdk_context_decomposition_claimed: false, guaranteed_provider_token_ceiling: false,
    professional_qualification_granted: false, production_approval: false };
  const binding = await saveJson(outputFile, value);
  return loadNonImageEnvelopeCalibration(binding);
}

export async function loadNonImageEnvelopeCalibration(binding) {
  await verifyEvidenceBindings(binding); const value = await readJson(binding.path);
  if(value.kind==='bound_native_schema_family_envelope_calibration')return(await import('./native_envelope_calibration.mjs')).loadNativeEnvelopeCalibration(binding);
  if (value.kind !== 'bound_nonimage_envelope_calibration' || value.schema_version !== 1
    || value.revision !== nonImageEnvelopeCalibrationRevision || value.margin_tokens !== 1024
    || value.exact_tokenizer_or_sdk_context_decomposition_claimed !== false || value.guaranteed_provider_token_ceiling !== false
    || value.professional_qualification_granted !== false || value.production_approval !== false
    || !Array.isArray(value.allowed_stages) || !value.allowed_stages.length
    || value.allowed_stages.some(stage => !/^[a-z0-9_-]{1,100}$/.test(stage))
    || !value.samples?.length || value.samples.length < 3 || new Set(value.samples.map(row => row.receipt.sha256)).size !== value.samples.length)
    throw Error('envelope_calibration_bound_profile_required');
  const samples = []; for (const row of value.samples) samples.push(await sample(row.receipt));
  if (new Set(samples.map(row => row.execution_request_sha256)).size !== samples.length
    || new Set(samples.map(row => row.execution_jsonl_sha256)).size !== samples.length)
    throw Error('envelope_calibration_distinct_actual_executions_required');
  if (canonical(samples) !== canonical(value.samples) || samples.some(row => canonical(row.profile) !== canonical(value.profile))
    || value.residual_cli_allowance_tokens !== Math.max(...samples.map(row => row.empirical_residual_tokens)) + 1024)
    throw Error('envelope_calibration_evidence_or_residual_changed');
  const result = freeze({ ...value, binding: structuredClone(binding) }); verified.add(result); return result;
}

export function calibratedNonImageAllowance(calibration, { stage, frames = [], schema, modelRevision, workerProfile,
  instructionsSha256, transport, cli, cwd } = {}) {
  if (!calibration || frames.length || !calibration.allowed_stages.includes(stage)) return null;
  if(calibration.kind==='bound_native_schema_family_envelope_calibration')return calibration.nativeAllowance({stage,frames,schema,modelRevision,workerProfile,instructionsSha256,transport,cli,cwd});
  if (!verified.has(calibration)) throw Error('envelope_calibration_verified_runtime_object_required');
  const profile = calibration.profile;
  // Contact layout is a cache identity for image preparation. These receipts
  // and this estimator branch explicitly contain no submitted image; keep
  // cache/request revisions intact while comparing the actual core envelope.
  const nonimageCore=value=>baseRevision(value)?.replace(/:continuous-4x4-v1$/,'');
  if (modelRevision && nonimageCore(modelRevision) !== nonimageCore(profile.model_revision) || workerProfile && workerProfile !== profile.worker_profile
    || instructionsSha256 && instructionsSha256 !== profile.instructions_sha256
    || transport && canonical(transport) !== canonical(profile.transport)
    || cli && canonical(cli) !== canonical(profile.cli) || cwd && path.resolve(cwd) !== path.resolve(profile.cwd)
    || schema && shaBytes(canonical(schema)) !== profile.wire_schema_sha256)
    throw Error('envelope_calibration_profile_mismatch');
  return { allowance: calibration.residual_cli_allowance_tokens, calibration: calibration.binding,
    revision: calibration.revision, experiment_only_not_provider_token_ceiling: true };
}
