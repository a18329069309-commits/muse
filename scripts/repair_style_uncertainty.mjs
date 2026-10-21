import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { createCodexCliRuntime, createAccountAuthAdmission, styleRepairInputBudget } from './codex_cli_runtime.mjs';
import { createAccountCliSchedule } from './account_cli_slots.mjs';
import { validateCodexStyleDirection } from './compose_codex_episode.mjs';
import { assertDirectionRepairFieldsUnchanged } from './direction_semantics.mjs';
import { createStyleUncertaintyRepair, styleUncertaintyRepairPrompt, decodeStyleRepairAnalysis } from './style_uncertainty_repair.mjs';

// Explicitly consume one completed, schema-valid rejected style result. Never
// replay the initial direction/story call or mutate its failure/cache namespace.
export async function repairStyleUncertainty(config) {
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? '')
    || typeof config.execute !== 'boolean' || !path.isAbsolute(config.account_cli_slot_directory ?? '')
    || path.basename(config.account_cli_slot_directory) !== 'account-cli-slots'
    || path.basename(path.dirname(config.account_cli_slot_directory)) !== 'checkpoints')
    throw Error('style_repair_explicit_new_output_and_shared_checkpoint_slots_required');
  await verifyEvidenceBindings(config.failed_receipt);
  const failed = await readJson(config.failed_receipt.path);
  await verifyEvidenceBindings([failed.request, failed.final, failed.schema, failed.jsonl, failed.stderr]);
  const original = await readJson(failed.request.path), first = await readJson(failed.final.path);
  const out = path.resolve(config.output_dir); await mkdir(out, { recursive: false });
  const prepared = await createStyleUncertaintyRepair({ input: original.input, schema: original.input.schema ?? original.input.response_schema,
    firstFinal: failed.final, failedReceipt: config.failed_receipt, directory: path.join(out, 'plan') });
  const budget = styleRepairInputBudget(styleUncertaintyRepairPrompt(prepared.context), prepared.schema, original.submitted_images ?? []);
  const actualAnalysis = prepared.context.repair_input.analysis ? decodeStyleRepairAnalysis(prepared.context.repair_input.analysis) : null;
  const plan = await saveJson(path.join(out, 'repair-plan.json'), { schema_version: 1,
    kind: 'bound_failed_style_uncertainty_repair_plan', failed_receipt: config.failed_receipt,
    original_request: failed.request, original_final: failed.final, context: prepared.file, schema: prepared.schemaFile,
    source_video_sha256: original.source_video_sha256, budget, limit: 32000,
    actual_story_beat_count: actualAnalysis?.story_beats?.length ?? null,
    retained_analysis_uncertainty_count: actualAnalysis?.uncertainties?.length ?? null,
    budget_passed: budget.estimated_tokens <= 32000, original_failure_unchanged: true,
    initial_style_calls: 0, new_cli_calls: 0, new_paid_calls: 0, Ready: false, production_approval: false });
  if (!config.execute || budget.estimated_tokens > 32000) return {
    status: budget.estimated_tokens <= 32000 ? 'thin_style_repair_plan_ready' : 'thin_style_repair_capacity_gap',
    plan, budget, new_cli_calls: 0, original_failure_unchanged: true, Ready: false };
  const accountDirectory = path.resolve(config.account_cli_slot_directory);
  const runtime = createCodexCliRuntime({ stateDirectory: path.join(out, 'cli-state'), archiveDirectory: path.join(out, 'cli-results'),
    cwd: failed.cwd, codexPath: config.codex_path ?? failed.command, model: failed.model_requested,
    mediaBindings: original.input_bindings.filter(row => row.sha256 === original.source_video_sha256),
    timeoutMs: config.timeout_ms ?? 600000, maxRepairs: 0,
    transport: failed.transport.mode, workerProfile: failed.worker_profile,
    schedule: createAccountCliSchedule({ directory: accountDirectory }), authAdmission: createAccountAuthAdmission(accountDirectory) });
  let result;
  try {
    const response = await runtime.repairStyleUncertainties(config.failed_receipt, { validateValue: async value => {
      assertDirectionRepairFieldsUnchanged(first, value);
      return validateCodexStyleDirection(value, original.input, { mode: original.input.data.execution_mode ?? original.input.data.mode });
    } });
    result = { status: 'thin_style_repair_completed', response: response.raw_response,
      semantic_validation_passed: true, only_scopes_dispositions_changed: true,
      source_video_sha256: response.source_video_sha256, host_field_merge: response.host_field_merge };
  } catch (error) {
    result = { status: error.status ?? 'thin_style_repair_failed', error: error.message,
      receipt_file: error.receipt_file ?? null, semantic_validation_passed: false };
  }
  if (await hashFile(config.failed_receipt.path) !== config.failed_receipt.sha256) throw Error('style_repair_original_failure_changed');
  result = { schema_version: 1, ...result, plan, accounting_ledger: runtime.ledger,
    original_failure_unchanged: true, initial_style_calls: 0,
    new_cli_calls: runtime.ledger.reduce((sum, row) => sum + (row.cli_invocations ?? 0), 0),
    audio_uploads: 0, new_paid_calls: 0, actual_audio_listened: false, Ready: false,
    artistic_approval: false, production_approval: false };
  result.artifact = await saveJson(path.join(out, 'repair-execution.json'), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('usage: node repair_style_uncertainty.mjs CONFIG.json');
    const result = await repairStyleUncertainty(await readJson(process.argv[2]));
    console.log(JSON.stringify({ status: result.status, artifact: result.artifact ?? result.plan,
      budget: result.budget, new_cli_calls: result.new_cli_calls, Ready: false }));
    if (!['thin_style_repair_plan_ready', 'thin_style_repair_completed'].includes(result.status)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
