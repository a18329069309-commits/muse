import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings, validateSchema } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { directorResponseSchema, validateAnalysisResponse } from './analysis_bridge.mjs';
import { validateLocalResearchResults } from './local_research_evidence.mjs';
import { validateResearchDirectionCheckpoint } from './research_direction_resume.mjs';
import { loadDirectionSemanticRepair } from './direction_semantics.mjs';
import { decodeContinuationLiteralParts } from './continuation_literal_parts.mjs';
import {inspectLocalResearchExecution,executeLocalResearch} from './local_research_execution.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw new Error(`research_resume_${reason}`); };
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const frameIdentity = rows => rows.map(({ path: ignored, ...row }) => row);
const here = path.dirname(fileURLToPath(import.meta.url));
const localCaptures = new WeakMap();
const localIdentity = value => canonical({ ...value, implementation: value.implementation.map(({ path: ignored, ...row }) => row) });

function decodeChildTable(value) {
  if (Array.isArray(value) || value == null) return value;
  if (value.encoding === 'literal_parts_v1') {
    if (Object.keys(value).some(key => !['encoding', 'dictionary', 'rows'].includes(key))) fail('child_codec_unknown_field');
    return decodeContinuationLiteralParts(value);
  }
  if (value.encoding === 'ordered_key_groups_v1') {
    if (!Array.isArray(value.groups) || Object.keys(value).some(key => !['encoding', 'groups'].includes(key))) fail('child_codec_invalid');
    return value.groups.flatMap(decodeChildTable);
  }
  const nested = value.encoding === 'nested_path_columns_and_rows_v1';
  if (!nested && value.encoding !== undefined) fail('child_codec_unsupported');
  if (Object.keys(value).some(key => ![...(nested ? ['encoding'] : []), 'columns', 'rows'].includes(key)))
    fail('child_codec_unknown_field');
  if (!Array.isArray(value.columns) || !Array.isArray(value.rows)
    || value.columns.some(key => nested ? !Array.isArray(key) || !key.length || key.some(part => typeof part !== 'string')
      : typeof key !== 'string')
    || new Set(value.columns.map(canonical)).size !== value.columns.length
    || value.rows.some(row => !Array.isArray(row) || row.length !== value.columns.length)) fail('child_codec_invalid');
  return value.rows.map(row => {
    const result = {};
    value.columns.forEach((column, index) => {
      const keys = nested ? column : [column]; let owner = result;
      keys.forEach((key, depth) => {
        if (depth === keys.length - 1) {
          if (Object.hasOwn(owner, key)) fail('child_codec_path_conflict');
          Object.defineProperty(owner, key, { value: structuredClone(row[index]), enumerable: true, writable: true });
        } else {
          if (!Object.hasOwn(owner, key)) Object.defineProperty(owner, key, { value: {}, enumerable: true });
          if (!owner[key] || typeof owner[key] !== 'object' || Array.isArray(owner[key])) fail('child_codec_path_conflict');
          owner = owner[key];
        }
      });
    });
    return result;
  });
}

// Only declared lossless field codecs and exact prompt prefix/suffix wrapping
// can disappear from a cache identity. A rewritten responsibility prompt cannot.
export function decodeResearchStoryChildWire(input, wrapper = { prefix: '', suffix: '' }) {
  if (!input?.partition || !/^research_story_director_part_\d+$/.test(input.stage ?? '')
    || typeof input.prompt !== 'string' || typeof wrapper.prefix !== 'string' || typeof wrapper.suffix !== 'string')
    fail('child_semantic_input_required');
  if (!input.prompt.startsWith(wrapper.prefix) || !input.prompt.endsWith(wrapper.suffix)
    || wrapper.prefix.length + wrapper.suffix.length > input.prompt.length) fail('child_prompt_wrapper_mismatch');
  const decoded = structuredClone(input);
  decoded.prompt = input.prompt.slice(wrapper.prefix.length, input.prompt.length - wrapper.suffix.length || undefined);
  for (const [owner, key] of [[decoded.data, 'source_frames'], [decoded.data, 'evidence_catalog'],
    [decoded.data, 'unqualified_research_observations'], [decoded.partition.previous_context, 'beats'],
    [decoded.partition.previous_context, 'unresolved_uncertainties']]) {
    if (owner && Object.hasOwn(owner, key)) owner[key] = decodeChildTable(owner[key]);
  }
  return decoded;
}

async function researchChildEquivalence({ original_request, current_request, semantic_request,
  prompt_wrappers = { original: { prefix: '', suffix: '' }, current: { prefix: '', suffix: '' } } }) {
  const originalBinding = await suppliedBinding(original_request), currentBinding = await suppliedBinding(current_request),
    semanticBinding = await suppliedBinding(semantic_request);
  const old = await readJson(originalBinding.path), current = await readJson(currentBinding.path), semantic = await readJson(semanticBinding.path);
  await verifyEvidenceBindings([old, current, semantic]);
  const { input: ignoredOldInput, ...oldExecution } = old;
  const { input: ignoredCurrentInput, ...currentExecution } = current;
  if (old.execution_kind !== 'codex_cli_inference' || current.execution_kind !== 'codex_cli_inference'
    || !same(oldExecution, currentExecution)) fail('child_execution_constraints_changed');
  const oldDecoded = decodeResearchStoryChildWire(old.input, prompt_wrappers.original),
    currentDecoded = decodeResearchStoryChildWire(current.input, prompt_wrappers.current);
  if (!same(oldDecoded, semantic) || !same(currentDecoded, semantic)) fail('child_semantic_input_changed');
  const sourceSha = semantic.data?.source_video_sha256, range = semantic.partition.source_range;
  if (!/^[a-f0-9]{64}$/.test(sourceSha ?? '') || old.source_video_sha256 !== sourceSha
    || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0
    || range[1] <= range[0] || range[1] > semantic.partition.whole_episode_duration
    || !semantic.schema || !Array.isArray(semantic.frames) || !semantic.frames.length
    || !same(old.submitted_images, semantic.frames.map(row => ({ path: path.resolve(row.path), sha256: row.sha256 }))))
    fail('child_source_schema_clock_or_frames_invalid');
  return { schema_version: 1, kind: 'host_verified_research_story_child_equivalence',
    original_request: originalBinding, current_request: currentBinding, semantic_request: semanticBinding,
    prompt_wrappers, source_video_sha256: sourceSha, source_range: range,
    semantic_input_sha256: shaBytes(canonical(semantic)), schema_sha256: shaBytes(canonical(semantic.schema)),
    execution_identity_sha256: shaBytes(canonical(oldExecution)),
    implementation: await bind(fileURLToPath(import.meta.url)),
    raw_evidence_schema_clock_context_equal: true, reversible_wire_codecs_only: true,
    new_inference_executed: false, old_usage_preserved: true, production_approval: false };
}

export async function createResearchStoryChildEquivalenceReceipt(options) {
  if (!path.isAbsolute(options?.output_file ?? '')) fail('child_equivalence_output_absolute_path_required');
  return saveJson(options.output_file, await researchChildEquivalence(options));
}

/** Reuse requires a host-created, revalidated equality receipt and an actual
 * completed child. This utility never submits a model request or alters usage.
 * Calling code must record this reuse map beside the original child response.
 */
export async function loadEquivalentResearchStoryChild({ equivalence_receipt, completed_response, current_request, output_file }) {
  const receiptBinding = await suppliedBinding(equivalence_receipt), receipt = await readJson(receiptBinding.path),
    currentBinding = await suppliedBinding(current_request);
  if (!same(receipt.current_request, currentBinding) || !same(receipt, await researchChildEquivalence(receipt)))
    fail('child_equivalence_receipt_changed');
  const responseBinding = await suppliedBinding(completed_response), raw = await readJson(responseBinding.path),
    original = await readJson(receipt.original_request.path), semantic = await readJson(receipt.semantic_request.path);
  if (raw.execution_kind !== 'codex_cli_inference' || raw.actual_runtime_executed !== true || raw.actual_input_processed !== true
    || raw.completion_status !== 'complete' || raw.request_sha256 !== shaBytes(canonical(original))
    || raw.source_video_sha256 !== receipt.source_video_sha256 || raw.model !== original.model_requested
    || raw.backend_id !== original.backend_id || raw.model_revision !== original.model_revision
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.qualified !== false
    || raw.artistic_approval !== false || raw.production_approval !== false || !same(raw.scopes, [])
    || raw.actual_frames_submitted !== semantic.frames.length) fail('actual_completed_child_required');
  await verifyEvidenceBindings(raw.evidence_files);
  if (!raw.evidence_files?.some(row => same(row, receipt.original_request))) fail('child_actual_original_request_required');
  let completedActualReceipt = false;
  for (const bound of [...(raw.cli_receipts ?? []), ...(raw.historical_cli_receipts ?? [])]) {
    await suppliedBinding(bound);
    const execution = await readJson(bound.path);
    if (execution.status !== 'complete') continue;
    if (execution.execution_kind !== 'codex_cli_inference' || execution.request_sha256 !== raw.request_sha256
      || execution.source_video_sha256 !== receipt.source_video_sha256 || !same(execution.request, receipt.original_request)
      || execution.model_requested !== original.model_requested || execution.model_revision !== original.model_revision
      || execution.caller_semantic_validator_used !== true || execution.process_terminated !== true || execution.timed_out === true
      || !Number.isInteger(execution.usage?.reported_turns) || execution.usage.reported_turns < 1
      || !execution.final || !execution.jsonl) fail('child_completed_execution_receipt_invalid');
    await verifyEvidenceBindings([execution.final, execution.jsonl, execution.schema]);
    const events = (await readFile(execution.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!events.some(event => event.type === 'turn.completed') || events.some(event => event.type === 'turn.failed'))
      fail('child_completed_turn_evidence_required');
    completedActualReceipt = true;
  }
  if (!completedActualReceipt) fail('child_completed_execution_receipt_required');
  validateSchema(raw.value, semantic.schema);
  if (raw.value.source_video_sha256 !== receipt.source_video_sha256 || raw.value.request_id !== semantic.data.request_id)
    fail('child_response_identity_changed');
  const [start, end] = receipt.source_range, evidence = new Map((semantic.data.evidence_catalog ?? []).map(row => [row.id, row]));
  let covered = start;
  for (const row of [...raw.value.story_beats].sort((a, b) => a.start_seconds - b.start_seconds)) {
    if (row.start_seconds > covered + 1 / 48000) fail('child_response_coverage_gap');
    covered = Math.max(covered, row.end_seconds);
  }
  if (covered < end - 1 / 48000) fail('child_response_coverage_gap');
  const ids = new Set();
  for (const row of [...raw.value.story_beats, ...raw.value.sound_events]) {
    if (row.start_seconds < start || row.end_seconds > end || row.end_seconds <= row.start_seconds
      || ids.has(row.id) || !row.evidence_ids?.length || new Set(row.evidence_ids).size !== row.evidence_ids.length
      || row.evidence_ids.some(id => {
        const item = evidence.get(id);
        return !item || (item.kind === 'frame' ? item.timeline_seconds < row.start_seconds || item.timeline_seconds >= row.end_seconds
          : item.end_seconds <= row.start_seconds || item.start_seconds >= row.end_seconds);
      })) fail('child_response_event_or_evidence_invalid');
    ids.add(row.id);
  }
  const result = { schema_version: 1, kind: 'completed_semantically_equal_research_child_reuse',
    equivalence_receipt: receiptBinding, original_response: responseBinding, original_request: receipt.original_request,
    current_request: currentBinding, source_video_sha256: receipt.source_video_sha256, source_range: receipt.source_range,
    current_wire_inference_executed: false, new_account_calls: 0, original_usage_preserved: true,
    production_approval: false, actual_audio_listened: false };
  if (!path.isAbsolute(output_file ?? '')) fail('child_reuse_output_absolute_path_required');
  const reuse_receipt = await saveJson(output_file, result);
  return { value: raw.value, raw_response: responseBinding, reuse_receipt, reused_completed_child: true,
    new_account_calls: 0, original_usage_preserved: true };
}

// Store only a digest of configuration: it may contain deployment credentials.
export function researchConfigDigest(config) {
  const { output_dir, resume, ...identity } = config;
  return shaBytes(canonical(identity));
}

// Material publication is consumed after direction, so it cannot invalidate a completed story request.
export function researchStoryConfigDigest(config) {
  const { library, cases, consumer_publication, preview, local_audio_checkpoint, direction_checkpoint, direction_contract_version, direction_semantic_repair, ...story } = config;
  return researchConfigDigest(story);
}

async function suppliedBinding(value) {
  if (!value?.path || !path.isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) fail('explicit_binding_required');
  await verifyEvidenceBindings(value);
  return { path: path.resolve(value.path), sha256: value.sha256 };
}

async function reconcileCompletedSchemaFailure(reconciliation, state, request, statePath, prior) {
  const recordBinding = await suppliedBinding(reconciliation), record = await readJson(recordBinding.path);
  if (record.schema_version !== 1 || record.kind !== 'completed_style_schema_failure_reconciliation'
    || record.source_video_sha256 !== prior.source_video_sha256 || state.status !== 'failed'
    || request.input?.stage !== 'research_style_director' || request.source_video_sha256 !== prior.source_video_sha256
    || record.request_state?.path !== path.resolve(statePath)
    || record.request_sha256 !== state.request_sha256 || record.inference_result_replayed !== false)
    fail('style_schema_failure_reconciliation_invalid');
  await suppliedBinding(record.request_state);
  const requestBinding = await suppliedBinding(record.request), failed = await suppliedBinding(record.failed_receipt);
  if (requestBinding.path !== path.resolve(path.join(path.dirname(statePath).replace(`${path.sep}cli-state${path.sep}`, `${path.sep}cli-results${path.sep}`), 'request.json'))
    || !state.attempts?.some(row => same(row, failed))) fail('style_schema_failure_reconciliation_invalid');
  const receipt = await readJson(failed.path);
  if (receipt.execution_kind !== 'codex_cli_inference' || receipt.status !== 'failed'
    || receipt.process_terminated !== true || receipt.exit_code !== 1 || receipt.final !== null
    || receipt.source_video_sha256 !== prior.source_video_sha256 || receipt.request_sha256 !== state.request_sha256
    || !same(receipt.request, requestBinding)) fail('style_schema_failure_reconciliation_invalid');
  await verifyEvidenceBindings([receipt.schema, receipt.jsonl, receipt.stderr]);
  const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!events.some(row => row.type === 'turn.failed' && /invalid_json_schema/.test(JSON.stringify(row.error)))
    || events.some(row => row.type === 'turn.completed' || row.type === 'item.completed' && row.item?.type === 'agent_message'))
    fail('style_schema_failure_was_not_request_rejection');
  const original = await suppliedBinding(record.original_wire_schema), corrected = await suppliedBinding(record.corrected_wire_schema);
  if (!same(original, receipt.schema)) fail('style_schema_failure_reconciliation_invalid');
  const before = await readJson(original.path), after = await readJson(corrected.path);
  if (before.type !== 'object' || !before.properties?.uncertainty_dispositions
    || before.required?.includes('uncertainty_dispositions') || !Array.isArray(before.required)
    || !same(after, { ...before, required: [...before.required, 'uncertainty_dispositions'] }))
    fail('style_schema_repair_must_only_require_existing_dispositions');
  const producer = await suppliedBinding(record.corrected_generation_implementation);
  if (producer.sha256 !== await hashFile(path.join(here, 'direction_semantics.mjs')))
    fail('style_schema_repair_implementation_changed');
  return { reconciliation: recordBinding, failed_receipt: failed, original_wire_schema: original,
    corrected_wire_schema: corrected, old_request_and_usage_preserved: true, inference_result_replayed: false };
}

async function reconcileCompletedSemanticFailure(repair, state, request, root, prior) {
  if (state.status !== 'complete' || !repair?.previous_direction || !repair?.error_evidence)
    fail('style_semantic_failure_reconciliation_required');
  const recordBinding = await suppliedBinding(repair.error_evidence), record = await readJson(recordBinding.path);
  if (path.resolve(record.original_failure_record?.path ?? '') !== path.join(root, 'compose-record.json')
    || record.source_video_sha256 !== prior.source_video_sha256 || prior.status !== 'failed'
    || prior.error !== record.error || request.input?.stage !== 'research_style_director'
    || request.source_video_sha256 !== prior.source_video_sha256
    || record.response?.sha256 !== state.response?.sha256 || shaBytes(canonical(request)) !== state.request_sha256)
    fail('style_semantic_failure_not_original_outcome');
  const requestPath = path.join(root, 'host/cli-results', state.request_sha256, 'request.json');
  if (path.resolve(record.request?.path ?? '') !== requestPath || await hashFile(requestPath) !== record.request.sha256)
    fail('style_semantic_failure_not_original_request');
  const receipt = await readJson((await suppliedBinding(record.receipt)).path);
  if (receipt.request_sha256 !== state.request_sha256 || !state.attempts?.some(row => same(row, record.receipt)))
    fail('style_semantic_failure_not_original_receipt');
  const analysis = await readJson((await suppliedBinding(record.analysis)).path);
  await loadDirectionSemanticRepair(repair, { sourceSha: prior.source_video_sha256, analysis });
  // Reuse the completed story only. The rejected direction and its usage remain immutable.
  return { error_evidence: recordBinding, rejected_direction: repair.previous_direction, direction_replayed: false };
}

async function requireUnsubmittedStyle(root, prior, directionCheckpoint, schemaFailureReconciliation, semanticFailureReconciliation) {
  if (prior.pending_host_request) fail('pending_host_request_requires_original_consumer');
  if (prior.stages.some(row => row.name === 'research_style_director' && row.status === 'completed') && !directionCheckpoint)
    fail('completed_direction_resume_not_implemented');
  if (directionCheckpoint) {
    const checkpoint = await validateResearchDirectionCheckpoint(directionCheckpoint);
    if (checkpoint.source_video_sha256 !== prior.source_video_sha256
      || prior.research_direction_checkpoint && prior.research_direction_checkpoint.sha256 !== checkpoint.checkpoint.sha256)
      fail('direction_checkpoint_not_original_request');
  }
  let directories;
  try { directories = await readdir(path.join(root, 'host/cli-state')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const directory of directories) {
    const state = await readJson(path.join(root, 'host/cli-state', directory, 'state.json'));
    const request = await readJson(path.join(root, 'host/cli-results', directory, 'request.json'));
    if (request.input?.stage === 'research_style_director') {
      // A new directory must not bypass the existing CLI's outcome/retry reconciliation.
      if (state.status !== 'complete') {
        if (!schemaFailureReconciliation) fail('style_request_requires_original_reconciliation');
        await reconcileCompletedSchemaFailure(schemaFailureReconciliation, state, request,
          path.join(root, 'host/cli-state', directory, 'state.json'), prior);
        continue;
      }
      if (!directionCheckpoint && semanticFailureReconciliation) {
        await reconcileCompletedSemanticFailure(semanticFailureReconciliation, state, request, root, prior);
        continue;
      }
      if (!directionCheckpoint) fail('strict_direction_checkpoint_required');
      const restored = await validateResearchDirectionCheckpoint(directionCheckpoint);
      if (restored.request_sha256 !== state.request_sha256 || restored.source_video_sha256 !== prior.source_video_sha256
        || state.response?.sha256 !== restored.raw_response.sha256)
        fail('direction_checkpoint_not_original_request');
    }
  }
}

// Legacy runs have no configuration checkpoint, so callers must explicitly bind their original configuration.
// Recovery imports completed research only. It never replays an unknown request or imports isolated style proposals.
export async function loadResearchStoryResume({ config, sourceSha, knowledgeFiles, promptFile }) {
  if (!config.resume) return null;
  if (!['research', 'assisted_trial'].includes(config.mode) || config.resume.kind !== 'bound_story_v1') fail('research_or_assisted_bound_story_required');
  if (config.resume.direction) fail('strict_direction_checkpoint_required');
  if (config.local_audio_analysis && !(config.local_audio_checkpoint ?? config.resume.local_audio_checkpoint))
    fail('strict_local_checkpoint_required');
  const composeRecord = await suppliedBinding(config.resume.compose_record), configFile = await suppliedBinding(config.resume.config_file);
  const root = path.dirname(composeRecord.path), prior = await readJson(composeRecord.path), oldConfig = await readJson(configFile.path);
  if (path.basename(composeRecord.path) !== 'compose-record.json' || path.resolve(oldConfig.output_dir) !== root
    || root === path.resolve(config.output_dir)) fail('new_directory_and_original_config_required');
  const configSha = researchConfigDigest(config), oldConfigSha = researchConfigDigest(oldConfig);
  if (researchStoryConfigDigest(config) !== researchStoryConfigDigest(oldConfig)
    || prior.config_identity_sha256 && prior.config_identity_sha256 !== oldConfigSha)
    fail('configuration_changed');
  if (prior.source_video_sha256 !== sourceSha || !prior.stages?.some(row => row.name === 'research_story_director' && row.status === 'completed')
    || !['research', 'assisted_trial'].includes(prior.mode) || prior.mode !== config.mode) fail('completed_same_source_story_required');
  await requireUnsubmittedStyle(root, prior, config.resume.direction_checkpoint, config.resume.style_schema_failure_reconciliation,
    config.resume.style_semantic_failure_reconciliation);
  const requestBinding = await bind(path.join(root, 'analysis/request.json')), request = await readJson(requestBinding.path);
  if (request.source_video_sha256 !== sourceSha || request.schema_version !== 1 || request.input_mode !== 'frames_only') fail('original_full_research_request_required');
  await verifyEvidenceBindings(request.bindings);
  const manifestBinding = request.bindings.find(row => row.kind === 'manifest');
  if (!manifestBinding) fail('manifest_binding_required');
  const manifest = await readJson(manifestBinding.path);
  if (manifest.analysis_window || manifest.source_sha256 !== sourceSha || !same(request.controls, {
    craft_mode: config.craft_mode, music_words_policy: config.music_words_policy })) fail('manifest_or_controls_changed');
  const oldKnowledge = request.bindings.filter(row => row.kind === 'knowledge');
  if (oldKnowledge.length !== knowledgeFiles.length) fail('knowledge_changed');
  for (const [i, file] of knowledgeFiles.entries()) {
    if (await hashFile(file) !== oldKnowledge[i].sha256 || path.basename(file) !== oldKnowledge[i].source_label) fail('knowledge_changed');
  }
  if (await hashFile(promptFile) !== request.bindings.find(row => row.kind === 'prompt')?.sha256) fail('prompt_changed');
  const originalRequest = prior.research_story?.original_request
    ? await suppliedBinding(prior.research_story.original_request) : await bind(path.join(root, 'host/story-original-request.json'));
  const response = prior.research_story?.response
    ? await suppliedBinding(prior.research_story.response) : await bind(path.join(root, 'host/story-merged-response.json'));
  const analysisResult = await bind(path.join(root, 'analysis/result.json'));
  if (prior.research_story && (!same(prior.research_story.original_request, originalRequest)
    || !same(prior.research_story.response, response) || !same(prior.research_story.analysis_result, analysisResult)
    || !same(prior.research_story.request, requestBinding))) fail('checkpoint_changed');
  let rejectedDirection = null;
  if (config.resume.rejected_direction_receipt) {
    rejectedDirection = await suppliedBinding(config.resume.rejected_direction_receipt);
    const rejected = await readJson(rejectedDirection.path);
    if (rejected.style_semantic_passed !== false || rejected.source_video?.sha256 !== sourceSha) fail('rejected_direction_receipt_invalid');
  }
  const invalidatedStages = configSha === oldConfigSha ? [] : ['case_package_recall', 'material_selection', 'music_and_sound_editing', 'render'];
  return { composeRecord, configFile, configSha, oldConfigSha, invalidatedStages, prior, requestBinding, request, manifestBinding, manifest,
    originalRequest, response, analysisResult, rejectedDirection };
}

async function directoryBindings(directory) {
  const rows = [];
  async function visit(root) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['__pycache__', '.cache', '.git'].includes(entry.name) || entry.name.endsWith('.pyc')) continue;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push(await bind(file));
    }
  }
  await visit(path.resolve(directory));
  return rows;
}

// Metadata and file hashing only: this probe never imports or invokes an audio model.
export async function captureLocalResearchDependencies({ options, python, manifestPath },executionContext={}) {
  await inspectLocalResearchExecution(executionContext,'local_research_dependencies_preflight');
  if (!options?.model_dir || options.device && options.device !== 'cpu') fail('existing_cpu_model_required');
  const manifest = await readJson(manifestPath), base = path.dirname(manifestPath);
  if (await hashFile(path.resolve(base, manifest.source_video)) !== manifest.source_sha256) fail('local_media_source_changed');
  await inspectLocalResearchExecution(executionContext,'local_research_dependencies_source_io');
  const code = "import importlib.metadata as m, importlib.util as u, json, sys; print(json.dumps({'python':sys.executable,'versions':{k:m.version(k) for k in ['funasr','silero-vad','torch','soundfile','numpy']},'directories':[str(next(iter(u.find_spec(k).submodule_search_locations))) for k in ['funasr','silero_vad']]}))";
  const result = await executeLocalResearch(options.python ?? python ?? 'python', ['-B', '-c', code], { windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(options.module_directory ? { PYTHONPATH: path.resolve(options.module_directory) } : {}) } },
  executionContext,'local_research_dependencies_metadata');
  const metadata = JSON.parse(result.stdout);
  const dependencies = { schema_version: 1, model_directory: path.resolve(options.model_dir), language: options.language ?? 'auto',
    options_sha256: shaBytes(canonical({ model_dir: path.resolve(options.model_dir), device: 'cpu',
    language: options.language ?? 'auto', module_directory: options.module_directory ? path.resolve(options.module_directory) : null })),
  media: { source_video_sha256: manifest.source_sha256, timeline: manifest.timeline, first_pts_seconds: manifest.video.first_pts_seconds,
    original_audio_sha256: await hashFile(path.resolve(base, manifest.original_audio)),
    analysis_audio_sha256: await hashFile(path.resolve(base, manifest.analysis_audio)) },
  implementation: await Promise.all(['analyze_local_audio.py', 'local_research_evidence.mjs',
    'local_research_execution.mjs','owned_process_runner.mjs','owned_process_tree.py'].map(name => bind(path.join(here, name)))),
  python: await bind(metadata.python), package_versions: metadata.versions,
  model_files: await directoryBindings(options.model_dir), package_files: (await Promise.all(metadata.directories.map(directoryBindings))).flat() };
  await inspectLocalResearchExecution(executionContext,'local_research_dependencies_complete_io');
  localCaptures.set(dependencies, { capturedAt: Date.now(), digest: shaBytes(canonical(dependencies)) });
  return dependencies;
}

async function validateLocalCheckpointOutputs(checkpoint, dependencies) {
  await verifyEvidenceBindings([checkpoint.manifest, checkpoint.receipt, checkpoint.report, checkpoint.observations]);
  const receipt = await readJson(checkpoint.receipt.path), manifest = await readJson(checkpoint.manifest.path);
  if (receipt.cpu_only !== true || receipt.local_network_requests !== false || receipt.sound_facts_qualified !== false
    || receipt.artistic_approval !== false || receipt.actual_analysis_status !== 'local_machine_analysis_complete_not_listening_approved'
    || receipt.audio_seconds_processed !== manifest.timeline.duration_samples / 48000 || receipt.raw_references?.length !== 2)
    fail('complete_unqualified_local_evidence_required');
  await verifyEvidenceBindings(receipt.raw_references);
  const transcript = await readJson(receipt.raw_references[0].path), activity = await readJson(receipt.raw_references[1].path);
  const report = await readJson(checkpoint.report.path), identity = { ...dependencies.media, manifest_sha256: checkpoint.manifest.sha256 };
  delete identity.timeline; delete identity.first_pts_seconds;
  if (Object.entries(identity).some(([key, value]) => receipt[key] !== value)
    || manifest.source_sha256 !== dependencies.media.source_video_sha256 || !same(manifest.timeline, dependencies.media.timeline)
    || manifest.video.first_pts_seconds !== dependencies.media.first_pts_seconds) fail('local_receipt_media_identity_changed');
  validateLocalResearchResults({ transcript, activity, report, identity, duration: receipt.audio_seconds_processed });
  const model = dependencies.model_files.find(row => path.resolve(row.path) === path.join(dependencies.model_directory, 'model.pt'));
  if (!model || model.sha256 !== receipt.model_sha256 || model.sha256 !== transcript.model_sha256 || model.sha256 !== report.model_sha256
    || !same(receipt.package_versions, dependencies.package_versions) || !same(transcript.package_versions, dependencies.package_versions)
    || transcript.offline !== true || transcript.trust_remote_code !== false || report.network_submission !== false
    || transcript.language_setting !== dependencies.language || report.language_setting !== dependencies.language
    || activity.package_version !== dependencies.package_versions['silero-vad']
    || !same(receipt.dialogue_intervals, activity.dialogue_intervals) || receipt.actual_asr_chunks !== transcript.segments.length
    || !same(receipt.observation_files, checkpoint.observations.map(row => row.path))) fail('local_model_or_result_identity_changed');
  for (const [index, reference] of checkpoint.observations.entries()) {
    const observation = await readJson(reference.path), segment = transcript.segments[index];
    if (!segment || observation.source_video_sha256 !== identity.source_video_sha256 || observation.manifest_sha256 !== identity.manifest_sha256
      || observation.original_audio_sha256 !== identity.original_audio_sha256 || observation.analysis_audio_sha256 !== identity.analysis_audio_sha256
      || observation.model_sha256 !== model.sha256 || !same(observation.package_versions, dependencies.package_versions)
      || observation.sound_facts_qualified !== false || observation.transcription_verified !== false || observation.dialogue_activity_verified !== false
      || observation.artistic_approval !== false || observation.original_audio_kind !== 'unknown'
      || !same(observation.raw_references, receipt.raw_references) || !same(observation.source_range, [segment.chunk_start_seconds, segment.chunk_end_seconds])
      || observation.transcription_prediction !== segment.text || !same(observation.dialogue_activity_prediction,
        activity.dialogue_intervals.filter(row => row.end_seconds > segment.chunk_start_seconds && row.start_seconds < segment.chunk_end_seconds)))
      fail('local_observation_identity_changed');
  }
  if (checkpoint.observations.length !== transcript.segments.length) fail('local_observation_coverage_incomplete');
  return { observationFiles: receipt.observation_files, dialogueIntervals: receipt.dialogue_intervals, receipt: checkpoint.receipt };
}

export async function createLocalResearchCheckpoint({ before, local, options, python, manifestPath, outputDirectory },executionContext={}) {
  await inspectLocalResearchExecution(executionContext,'local_research_checkpoint_preflight');
  const capture = localCaptures.get(before);
  if (!capture || capture.digest !== shaBytes(canonical(before))) fail('local_before_execution_capture_required');
  const receipt = await readJson(local.receipt.path);
  const reportFile = path.join(path.dirname(local.receipt.path), 'raw/analysis-report.json');
  for (const file of [local.receipt.path, reportFile, ...receipt.raw_references.map(row => row.path), ...receipt.observation_files])
    if ((await stat(file)).mtimeMs < capture.capturedAt) fail('local_evidence_not_new_after_capture');
  const after = await captureLocalResearchDependencies({ options, python, manifestPath },executionContext);
  if (localIdentity(before) !== localIdentity(after)) fail('local_dependencies_changed_during_analysis');
  const checkpoint = { schema_version: 1, kind: 'local_research_audio_checkpoint_v1', dependencies: before,
    dependencies_captured_before_analysis: true, dependencies_verified_after_analysis: true,
    captured_before_analysis_at: new Date(capture.capturedAt).toISOString(),
    manifest: await bind(manifestPath), receipt: local.receipt,
    report: await bind(reportFile),
    observations: await Promise.all(receipt.observation_files.map(bind)), sound_facts_qualified: false, production_approval: false };
  await validateLocalCheckpointOutputs(checkpoint, before);
  await inspectLocalResearchExecution(executionContext,'local_research_checkpoint_complete_io');
  localCaptures.delete(before);
  return saveJson(path.join(outputDirectory, 'dependency-checkpoint.json'), checkpoint);
}

export async function verifyDeadlinePreparationCheckpointCompatibility({checkpoint,saved,current,executionContext={}}){
  if(!executionContext.analysisPreparationRecovery||typeof executionContext.trialBudget?.snapshot!=='function')
    fail('deadline_preparation_recovery_proof_required');
  const proofBinding=await suppliedBinding(executionContext.analysisPreparationRecovery),proof=await readJson(proofBinding.path),
    stopBinding=await suppliedBinding(proof.stop),stop=await readJson(stopBinding.path),state=await executionContext.trialBudget.snapshot();
  const allowedSources=['7238bd609f164059cdeea52fb919fb5587aeb3418fc7f50be066c323529dc207',
    '771c0a451fab50e897c9fcef17ecad6cc30ba128176cb825d712cb206427d8ed'];
  if(proof.revision!=='zero-call-story-capacity-preparation-reuse-v1'||!allowedSources.includes(proof.source_video_sha256)
    ||proof.source_video_sha256!==saved.dependencies.media?.source_video_sha256
    ||path.resolve(checkpoint.path)!==path.join(path.resolve(proof.original_analysis_directory??''),'local-audio','dependency-checkpoint.json')
    ||proof.historical_error_preserved!=='independent_trial_budget_exhausted'
    ||proof.gap_classification!=='story_call_plan_shape_capacity_gap_before_any_account_invocation'
    ||proof.request_and_preparation_only!==true||proof.deadline_or_request_allowance_extended!==false||proof.production_approval!==false
    ||['charged_request_slots','actual_new_cli_invocations','unknown_or_reserved_invocations'].some(k=>proof[k]!==0||stop[k]!==0)
    ||stop.status!=='independent_trial_budget_exhausted'||stop.reason!=='call_plan_phase_capacity_exceeded'||stop.input?.phase!=='story'
    ||stop.identity?.source_video_sha256!==proof.source_video_sha256
    ||path.resolve(stop.identity.output_root??'')!==path.resolve(proof.output_root??'')
    ||!same(stop.identity,state.identity)||state.charged_request_slots!==0||state.requests.some(r=>r.confirmed_invocations!==0)
    ||!state.stops.some(r=>same(r,stopBinding)))fail('deadline_preparation_recovery_proof_invalid');
  const old=saved.dependencies.implementation,now=current.implementation;
  const predecessor={'analyze_local_audio.py':'85806b690a1ec033c5f72eb395955ead977b9d897e837173a84b8ccd81596d7e',
    'local_research_evidence.mjs':'d69fafdd199ded181b6a5ff50808500b12692c5e42eeef278091471e93275c97'};
  if(!Array.isArray(old)||old.length!==2||old.some(r=>predecessor[path.basename(r.path)]!==r.sha256)
    ||new Set(old.map(r=>path.basename(r.path))).size!==2
    ||!Array.isArray(now)||now.length!==5||new Set(now.map(r=>path.basename(r.path))).size!==5
    ||now.find(r=>path.basename(r.path)==='analyze_local_audio.py')?.sha256!==predecessor['analyze_local_audio.py']
    ||now.find(r=>path.basename(r.path)==='local_research_evidence.mjs')?.sha256!=='ac0c8fe912691a94987b6a46e694f01b8677c800ce4409d4d692cbdc0fc0cb60'
    ||!['local_research_execution.mjs','owned_process_runner.mjs','owned_process_tree.py'].every(n=>now.some(r=>path.basename(r.path)===n)))
    fail('deadline_preparation_predecessor_implementation_changed');
  const {implementation:oldImplementation,...oldIdentity}=saved.dependencies,{implementation:currentImplementation,...currentIdentity}=current;
  if(!same(oldIdentity,currentIdentity))fail('local_stage_dependencies_changed');
  const baseline=await bind(path.resolve(path.dirname(old.find(r=>path.basename(r.path)==='local_research_evidence.mjs').path),
    '../../execution/closed-loop-20261020/baseline.json'));
  if(baseline.sha256!=='52716cf01981bbd3b80b2c238d8dfd6c4b3240c55cad70a8f6ee90fdb41d4ad9')fail('deadline_preparation_baseline_changed');
  const baselineValue=await readJson(baseline.path);
  if(!Object.entries(predecessor).every(([name,sha])=>baselineValue.source.some(r=>path.basename(r.path)===name&&r.sha256===sha)))
    fail('deadline_preparation_baseline_predecessor_mismatch');
  return {schema_version:1,kind:'zero_call_deadline_wrapper_checkpoint_compatibility',revision:'deadline-wrapper-predecessor-v1',
    checkpoint,proof:proofBinding,baseline,historical_implementation_identity:old.map(r=>({name:path.basename(r.path),sha256:r.sha256})),
    current_implementation:currentImplementation,model_package_python_media_identity_equal:true,asr_python_unchanged:true,
    new_asr_calls:0,new_account_calls:0,historical_evidence_modified:false,deadline_or_request_allowance_extended:false,production_approval:false};
}

export async function restoreLocalResearchCheckpoint({ checkpoint, options, python, manifestPath },executionContext={}) {
  await inspectLocalResearchExecution(executionContext,'local_research_checkpoint_restore_preflight');
  const reference = await suppliedBinding(checkpoint), saved = await readJson(reference.path);
  if (saved.kind !== 'local_research_audio_checkpoint_v1' || saved.dependencies_captured_before_analysis !== true
    || saved.dependencies_verified_after_analysis !== true || saved.sound_facts_qualified !== false || saved.production_approval !== false)
    fail('strict_local_checkpoint_required');
  const current = await captureLocalResearchDependencies({ options, python, manifestPath },executionContext);
  let compatibilityReceipt=null;
  if (localIdentity(saved.dependencies) !== localIdentity(current)) {
    if(!executionContext.analysisPreparationRecovery)fail('local_stage_dependencies_changed');
    const compatibility=await verifyDeadlinePreparationCheckpointCompatibility({checkpoint:reference,saved,current,executionContext});
    const file=path.join(path.dirname(executionContext.analysisPreparationRecovery.path),`local-asr-deadline-compatibility-${reference.sha256}.json`);
    try{compatibilityReceipt=await saveJson(file,compatibility);}
    catch(error){if(error.code!=='EEXIST'||!same(await readJson(file),compatibility))throw error;compatibilityReceipt=await bind(file);}
  }
  const result = await validateLocalCheckpointOutputs(saved, current);
  await inspectLocalResearchExecution(executionContext,'local_research_checkpoint_restore_complete_io');
  return { ...result, checkpoint: reference, ...(compatibilityReceipt?{compatibility_receipt:compatibilityReceipt}:{}),
    reused: true, new_inference_calls: 0, sound_facts_qualified: false };
}

function compactText(text) {
  try { JSON.parse(text); } catch { return text; }
  let result = '', quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else {
      if (character === '"') quoted = true;
      if (!/[ \n\r\t]/.test(character)) result += character;
    }
  }
  return result;
}

const partitionInstruction = '\nOnly analyze partition.source_range on the unchanged full-video clock. Cover it completely. '
  + 'Use only submitted evidence IDs. Previous context is continuity evidence, not permission to invent this segment. '
  + 'Every event uses [start,end): a frame exactly at end belongs to the following event, never this event. '
  + 'Keep unheard audio unknown; return the exact request_id and source_video_sha256 constrained by the schema.';

function mergeStory(original, responses, ranges) {
  const last = responses.at(-1), kinds = new Set(responses.map(row => row.value.original_audio.kind));
  return { ...last.value, source_video_sha256: original.data.source_video_sha256, request_id: original.data.request_id,
    status: responses.every(row => row.value.status === 'complete') ? 'complete' : 'needs_review',
    original_audio: { kind: kinds.size === 1 ? last.value.original_audio.kind : 'unknown',
      observation: responses.map((row, i) => `[${ranges[i].join('–')}s] ${row.value.original_audio.observation}`).join('\n') },
    style_direction: Object.fromEntries(Object.keys(last.value.style_direction).map(key => [key,
      responses.map((row, i) => `[${ranges[i].join('–')}s] ${row.value.style_direction[key]}`).join('\n')])),
    story_beats: responses.flatMap((row, i) => row.value.story_beats.map(beat => ({ ...beat, id: `part-${i + 1}/${beat.id}` }))),
    sound_events: responses.flatMap((row, i) => row.value.sound_events.map(event => ({ ...event, id: `part-${i + 1}/${event.id}` }))),
    sound_event_none_reason: responses.some(row => row.value.sound_events.length) ? null : responses.map(row => row.value.sound_event_none_reason).join('\n'),
    uncertainties: [...new Set(responses.flatMap(row => row.value.uncertainties).concat(kinds.size > 1
      ? ['Original audio observations differ across source segments; retain unknown.'] : []))] };
}

// Validate the original full request and every actual partition request/response before adopting the merge.
export async function restoreBoundResearchStory(resume, input, backend) {
  if (!same(backend, resume.prior.director_backend) || backend?.protocol !== 'codex_cli') fail('backend_changed_or_unsupported');
  await verifyEvidenceBindings([resume.composeRecord, resume.configFile, resume.requestBinding, resume.originalRequest, resume.response, resume.analysisResult]);
  await verifyEvidenceBindings(input.frames);
  const original = await readJson(resume.originalRequest.path), merged = await readJson(resume.response.path);
  if (!same({ ...original, frames: frameIdentity(original.frames ?? []) }, { ...input, frames: frameIdentity(input.frames ?? []) })) fail('complete_story_input_changed');
  if (original.data.request_id !== resume.request.request_id || !same(original.data.timeline, resume.request.timeline)
    || !same(original.data.controls, resume.request.controls) || !same(original.data.instructions, resume.request.instructions)
    || !same(original.data.evidence_catalog, resume.request.evidence_catalog)) fail('original_request_identity_changed');
  if (merged.execution_kind !== 'deterministic_merge_of_bound_story_responses' || merged.facts_rewritten !== false
    || merged.actual_audio_processed !== false || merged.qualified !== false || merged.production_approval !== false
    || merged.request_id !== input.data.request_id || merged.source_video_sha256 !== input.data.source_video_sha256
    || !merged.constituent_responses?.length || merged.constituent_responses.length !== merged.source_ranges?.length) fail('bound_story_merge_required');
  await verifyEvidenceBindings([merged.frame_mapping, merged.knowledge_projection, ...merged.constituent_responses]);
  const mapping = await readJson(merged.frame_mapping.path), projection = await readJson(merged.knowledge_projection.path);
  if (!same(mapping.source_frames, original.frames) || mapping.source_video_sha256 !== input.data.source_video_sha256
    || !same(projection.original_request, resume.originalRequest) || projection.video_evidence_removed !== false
    || projection.string_or_numeric_literal_changed !== false) fail('complete_source_mapping_changed');
  await verifyEvidenceBindings(mapping.contact_sheet_manifest);
  const sheets = await readJson(mapping.contact_sheet_manifest.path);
  if (!same(sheets.source_frames, original.frames)
    || !same(sheets.frames.flatMap(row => row.source_frame_ids), original.frames.map(row => row.id))) fail('complete_frame_mapping_required');
  await verifyEvidenceBindings([...original.frames, ...sheets.frames]);
  const responses = [], allFrameIds = [], duration = input.data.timeline.duration_samples / 48000;
  let end = 0;
  for (const [i, responseBinding] of merged.constituent_responses.entries()) {
    const raw = await readJson(responseBinding.path), range = merged.source_ranges[i];
    if (raw.execution_kind !== 'codex_cli_inference' || raw.backend_id !== backend.backend_id || raw.model_revision !== backend.model_revision
      || raw.actual_runtime_executed !== true || raw.actual_input_processed !== true || raw.completion_status !== 'complete'
      || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.qualified !== false
      || raw.artistic_approval !== false || raw.production_approval !== false || !same(raw.scopes, [])
      || raw.source_video_sha256 !== input.data.source_video_sha256) fail('actual_partition_response_required');
    await verifyEvidenceBindings(raw.evidence_files);
    const boundRequest = raw.evidence_files.find(row => path.resolve(row.path) === path.join(path.dirname(responseBinding.path), 'request.json'));
    if (!boundRequest) fail('actual_partition_request_required');
    const payload = await readJson(boundRequest.path), part = payload.input;
    if (shaBytes(canonical(payload)) !== raw.request_sha256 || payload.execution_kind !== 'codex_cli_inference'
      || payload.model_requested !== raw.model || raw.model !== backend.model_revision.split(':')[0]
      || payload.model_revision && payload.model_revision !== backend.model_revision
      || payload.backend_id !== backend.backend_id || payload.source_video_sha256 !== input.data.source_video_sha256
      || part?.stage !== `research_story_director_part_${i + 1}` || !same(part.partition.source_range, range)
      || part.partition.index !== i || part.partition.whole_episode_duration !== duration
      || range[0] !== end || !(range[1] > range[0]) || range[1] > duration
      || !['director', part.stage].includes(payload.role) || part.prompt !== original.prompt + partitionInstruction) fail('partition_request_identity_changed');
    if (!resume.prior.research_story) {
      const consumed = resume.prior.account_usage?.find(row => row.request_sha256 === raw.request_sha256)?.receipt;
      if (!consumed) fail('original_consumption_receipt_required');
      await verifyEvidenceBindings(consumed);
      const receipt = await readJson(consumed.path);
      if (receipt.execution_kind !== 'codex_cli_host_consumption' || !same(receipt.response, responseBinding)
        || !same(receipt.backend, backend) || receipt.stage !== payload.role) fail('original_consumption_identity_changed');
    }
    const ids = new Set(part.frames.flatMap(row => row.source_frame_ids)), sourceFrames = original.frames.filter(row => ids.has(row.id));
    const expectedData = { ...original.data, knowledge: original.data.knowledge.map(row => ({ ...row, text: compactText(row.text) })),
      knowledge_projection: merged.knowledge_projection, evidence_catalog: original.data.evidence_catalog.filter(row => row.kind === 'frame'
        ? ids.has(row.id) : row.start_seconds < range[1] && row.end_seconds > range[0]), source_frames: sourceFrames,
      frame_sheet_manifest: mapping.contact_sheet_manifest, frame_sheet_layout: sheets.layout,
      unqualified_research_observations: (original.data.unqualified_research_observations ?? []).filter(row => {
        const r = row.value?.source_range; return !r || r[0] < range[1] && r[1] > range[0];
      }) };
    const schema = structuredClone(original.schema);
    schema.properties.source_video_sha256 = { ...schema.properties.source_video_sha256, enum: [input.data.source_video_sha256] };
    schema.properties.request_id = { ...schema.properties.request_id, enum: [input.data.request_id] };
    if (!same(part.data, expectedData) || !same(part.schema, schema)
      || !same(part.frames, sheets.frames.filter(row => row.source_frame_ids.some(id => ids.has(id))))
      || !same(payload.submitted_images, part.frames.map(row => ({ path: path.resolve(row.path), sha256: row.sha256 })))
      || raw.actual_frames_submitted !== part.frames.length
      || !same(part.partition.previous_context, i ? { beats: responses.at(-1).value.story_beats.slice(-2),
        response: merged.constituent_responses[i - 1] } : null)) fail('partition_input_changed');
    validateSchema(raw.value, schema);
    if (raw.value.source_video_sha256 !== input.data.source_video_sha256 || raw.value.request_id !== input.data.request_id) fail('partition_response_identity_changed');
    const evidence = new Map(expectedData.evidence_catalog.map(row => [row.id, row])), nodeIds = new Set();
    for (const row of [...raw.value.story_beats, ...raw.value.sound_events]) {
      if (nodeIds.has(row.id) || row.start_seconds < range[0] || row.end_seconds > range[1] || row.end_seconds <= row.start_seconds
        || !row.evidence_ids.length || new Set(row.evidence_ids).size !== row.evidence_ids.length) fail('partition_event_invalid');
      nodeIds.add(row.id);
      if (row.evidence_ids.some(id => {
        const item = evidence.get(id);
        return !item || (item.kind === 'frame' ? item.timeline_seconds < row.start_seconds || item.timeline_seconds >= row.end_seconds
          : item.end_seconds <= row.start_seconds || item.start_seconds >= row.end_seconds);
      })) fail('partition_evidence_not_submitted');
    }
    let covered = range[0];
    for (const beat of [...raw.value.story_beats].sort((a, b) => a.start_seconds - b.start_seconds)) {
      if (beat.start_seconds > covered + 1 / 48000) fail('partition_coverage_gap');
      covered = Math.max(covered, beat.end_seconds);
    }
    if (covered < range[1] - 1 / 48000) fail('partition_coverage_gap');
    allFrameIds.push(...sourceFrames.map(row => row.id)); responses.push(raw); end = range[1];
  }
  if (end !== duration || !same(allFrameIds, original.frames.map(row => row.id)) || !same(merged.value, mergeStory(original, responses, merged.source_ranges))
    || !same(merged.value, await readJson(resume.analysisResult.path))) fail('complete_merged_story_changed');
  validateSchema(merged.value, directorResponseSchema(1));
  const check = await validateAnalysisResponse(resume.requestBinding.path, resume.analysisResult.path);
  if (!check.structure_valid || check.coverage_gaps.length) fail('analysis_coverage_invalid');
  if ((!(input.data.unqualified_research_observations ?? []).length
    || input.data.unqualified_research_observations.every(row => row.value?.sound_facts_qualified === false))
    && merged.value.original_audio.kind !== 'unknown') fail('unheard_audio_must_remain_unknown');
  return { value: merged.value, raw_response: resume.response, resumed: true,
    story_state: { source_video_sha256: input.data.source_video_sha256, source_frames: input.frames,
      analysis: resume.response, frame_mapping: merged.frame_mapping } };
}

export async function recordResearchStoryResume(resume, out) {
  return saveJson(path.join(out, 'resume/story-reuse-receipt.json'), {
    schema_version: 1, scope: 'completed_bound_story_only', original_compose_record: resume.composeRecord,
    original_config: resume.configFile, config_identity_sha256: resume.configSha, original_request: resume.originalRequest,
    original_config_identity_sha256: resume.oldConfigSha, invalidated_stages: resume.invalidatedStages,
    original_bridge_request: resume.requestBinding, original_response: resume.response, original_analysis: resume.analysisResult,
    director_backend: resume.prior.director_backend,
    historical_model_calls: resume.prior.model_calls, new_model_calls: 0, new_cloud_uploads: 0,
    actual_audio_processed: false, formal_adoption_allowed: false, production_approval: false,
    direction_reused: false, ...(resume.rejectedDirection ? { rejected_direction_receipt: resume.rejectedDirection } : {}),
  });
}
