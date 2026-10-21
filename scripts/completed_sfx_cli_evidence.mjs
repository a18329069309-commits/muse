import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue } from './compact_business_contract.mjs';
import { projectFlatMaterialObservations } from './material_observation_projection.mjs';
import { baseStructuredEvidencePrompt, boundedRevision, validateCompletedTurnCleanup } from './codex_cli_runtime.mjs';
import { completedBatchEventsValid } from './bound_direction_execution_evidence.mjs';
import {sfxEventFunctionRevision,validateSelectedSoundUsage} from './sfx_event_function.mjs';
import {expandBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';
import {projectSfxMaterialSelectionPartition,sfxMaterialPartitionEvidenceRevision} from './sfx_material_selection_projection.mjs';
import {isActualCodexCliResolution} from './actual_codex_cli_resolution.mjs';

const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('completed_sfx_cli_' + reason); };
const unqualified = row => row.qualified === false && row.artistic_approval === false && row.production_approval === false;
const taskKey = row => [row.case_id, row.step_id, row.kind, row.sound_role ?? null];
const requestRefOf = (raw, binding) => raw.evidence_files?.find(ref => path.resolve(ref.path)
  === path.join(path.dirname(path.resolve(binding.path)), 'request.json'));
const imageBindings = frames => frames.map(frame => ({ path: path.resolve(frame.path), sha256: frame.sha256 }));

// Old v1 encoded own optional context fields even when their value was
// undefined; JSON persisted the reference but omitted the value and full-input
// field. Restore only that exact serialization shape, never infer a fact.
export function restoreLegacySfxContextUndefined(actual,original){
  const output=structuredClone(original);
  if(actual.sfx_material_selection_projection!=='sfx_lossless_shared_observations_v1'
    ||actual.sfx_event_function_revision!==undefined||!actual.shared_sound_evidence_inline)return output;
  const {contexts,contextValues}=expandBoundedInlineRecords(actual.shared_sound_evidence_inline);
  const emptyIds=new Set(contextValues.filter(row=>!Object.hasOwn(row,'value')).map(row=>row.id));
  for(const context of contexts){
    const current=output.case_context?.find(row=>row.case_id===context.context?.case_id);
    if(!current)continue;
    for(const [field,id]of Object.entries(context.field_values??{}))
      if(['conditions','story_sequence','uncertainties'].includes(field)&&emptyIds.has(id)
        &&!Object.hasOwn(current,field)&&!Object.hasOwn(context.context,field))current[field]=undefined;
  }
  if(!same(output,original))fail('legacy_context_business_changed');
  return output;
}

function checkRaw(raw, source, inputSha, frameCount) {
  if (raw.execution_kind !== 'codex_cli_inference' || raw.backend_id !== 'codex-cli-chatgpt'
    || raw.completion_status !== 'complete' || raw.actual_runtime_executed !== true || raw.actual_input_processed !== true
    || raw.actual_audio_processed !== false || raw.actual_video_processed !== false || raw.synchronized_video_sha256 !== null
    || raw.actual_frames_submitted !== frameCount || raw.source_video_sha256 !== source || raw.input_sha256 !== inputSha
    || !unqualified(raw) || !same(raw.scopes, []) || raw.synthetic_protocol_fixture
    || raw.actual_test_inference_performed === false) fail('actual_unqualified_response_required');
}

function checkDecisions(value, tasks, schema) {
  validateSchema(value, schema);
  if (!same(value.decisions.map(taskKey), tasks.map(taskKey))) fail('ordered_task_coverage_changed');
  for (const [index, decision] of value.decisions.entries()) {
    const ids = new Set(tasks[index].candidates.map(row => row.segment_id));
    const selected = decision.selected_segment_ids, rejected = decision.rejections.map(row => row.segment_id);
    if (new Set([...selected, ...rejected]).size !== selected.length + rejected.length
      || selected.length + rejected.length !== ids.size || [...selected, ...rejected].some(id => !ids.has(id)))
      fail('candidate_comparison_changed');
    if(tasks[index].sound_function_intent?.revision===sfxEventFunctionRevision)
      validateSelectedSoundUsage(decision,tasks[index]);
  }
}

// Rebuild the exact producer projection from the immutable full request. Sheet
// images are retained from their bound manifests, never regenerated here.
async function validateProjectedInput(actual, original, inputBinding) {
  const producerInput = restoreLegacySfxContextUndefined(actual,original), shared = new Map();
  // Historical material_selection reuses the same plain-window observations
  // object from its cache. JSON storage loses that reference identity. Restore
  // it exactly before replaying the old projection; do not rewrite its prompt.
  for (const task of producerInput.tasks) for (const candidate of task.candidates) {
    if (candidate.observation_contexts || candidate.human_context_review) continue;
    const key = canonical([candidate.source_sha256, candidate.source_range, null, null]);
    if (shared.has(key)) {
      if (!same(shared.get(key), candidate.observation)) fail('shared_observation_changed');
      candidate.observation = shared.get(key);
    } else shared.set(key, candidate.observation);
  }
  const projected = projectFlatMaterialObservations({ ...producerInput, input: inputBinding });
  if (!projected.frames?.length) {
    if (!same(actual, projected)) fail('original_projection_changed');
    return projected;
  }
  const originals = projected.frames.map((frame, index) => ({ ...frame, id: `case-frame-${index + 1}` }));
  const ids = [...new Set(originals.flatMap(frame => frame.case_ids ?? []))];
  if (!same(actual.source_frames, originals) || actual.frame_sheet_manifests?.length !== ids.length)
    fail('source_frame_mapping_changed');
  const frames = [], manifests = [];
  for (const [index, id] of ids.entries()) {
    const binding = actual.frame_sheet_manifests[index];
    await verifyEvidenceBindings(binding);
    const manifest = await readJson(binding.path), group = originals.filter(frame => frame.case_ids.includes(id));
    if (!same(binding.case_ids, [id]) || binding.layout !== manifest.layout || manifest.schema_version !== 1
      || !same(manifest.source_frames, group) || manifest.source_frame_count !== group.length
      || manifest.actual_video_processed !== false || manifest.actual_audio_processed !== false
      || !same(manifest.frames.flatMap(row => row.source_frame_ids), group.map(row => row.id)))
      fail('contact_sheet_manifest_changed');
    await verifyEvidenceBindings([manifest.frames, group]);
    const placements = manifest.frames.flatMap(frame => frame.placements ?? []);
    if (placements.length !== group.length || placements.some((row, i) => row.source_frame_id !== group[i].id
      || row.source_frame_sha256 !== group[i].sha256 || row.timeline_seconds !== group[i].timeline_seconds))
      fail('contact_sheet_placement_changed');
    frames.push(...manifest.frames.map(frame => ({ ...frame, case_ids: [id] })));
    manifests.push({ path: binding.path, sha256: binding.sha256, case_ids: [id], layout: manifest.layout });
  }
  const expected = { ...projected, frames, source_frames: originals, frame_sheet_manifests: manifests };
  if (!same(actual, expected)) fail('original_projection_changed');
  return expected;
}

async function actualPart(binding, expected, source, inputSha) {
  await verifyEvidenceBindings(binding);
  const raw = await readJson(binding.path), frames = imageBindings(expected.frames ?? []);
  checkRaw(raw, source, inputSha, frames.length);
  if (raw.partition_revision || raw.cli_receipts?.length !== 1 || (raw.historical_cli_receipts ?? []).length)
    fail('single_actual_part_required');
  await verifyEvidenceBindings([raw.evidence_files, raw.cli_receipts]);
  const requestRef = requestRefOf(raw, binding);
  if (!requestRef) fail('original_part_request_required');
  const request = await readJson(requestRef.path), receiptRef = raw.cli_receipts[0], receipt = await readJson(receiptRef.path);
  if (request.execution_kind !== 'codex_cli_inference' || request.role !== 'material_candidate_selection'
    || request.source_video_sha256 !== source || request.input_sha256 !== inputSha
    || shaBytes(canonical(request)) !== raw.request_sha256 || request.model_requested !== raw.model
    || request.model_revision !== raw.model_revision || request.backend_id !== raw.backend_id
    || !same(request.input, expected) || !same(request.submitted_images, frames)
    || !request.input_bindings?.some(ref => ref.sha256 === inputSha)) fail('part_request_changed');
  await verifyEvidenceBindings(request.input_bindings);
  for (const frame of frames) if (!request.input_bindings.some(ref => path.resolve(ref.path) === frame.path
    && ref.sha256 === frame.sha256)) fail('submitted_image_not_bound');
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
    || receipt.worker_instructions.sha256 !== request.worker_instructions?.sha256
    || receipt.submitted_image_count !== frames.length) fail('actual_cli_profile_changed');
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
  if (!completedBatchEventsValid(events, receipt,{finalBytes:await readFile(receipt.final.path),schema:contract.wireSchema}) || turns.length !== 1
    || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), wire)
    || !same(receipt.usage, raw.usage) || receipt.usage?.reported_turns !== 1
    || receipt.usage?.source !== 'cli_turn_completed_events') fail('actual_event_or_usage_changed');
  for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'])
    if ((receipt.usage.tokens[key] ?? 0) !== (turns[0].usage?.[key] ?? 0)) fail('actual_token_usage_changed');
  checkDecisions(raw.value, expected.tasks, expected.response_schema);
  return { raw, receiptRef, binding };
}

// This proves completed CLI choices, not current-story suitability or audio
// approval. The SFX recovery bridge separately verifies those current bindings.
export async function verifyCompletedSfxCliSelection(record) {
  if (record.schema_version !== 1 || record.automatic_selection_performed !== true
    || record.artistic_approval !== false || record.production_approval !== false) fail('completed_record_required');
  await verifyEvidenceBindings([record.input, record.raw_response, record.cli_receipts]);
  const original = await readJson(record.input.path), raw = await readJson(record.raw_response.path);
  if (!Array.isArray(original.tasks) || !original.tasks.length
    || original.tasks.some(row => !row.case_id || !['sfx', 'ambience'].includes(row.kind))
    || new Set(original.tasks.map(row => canonical(taskKey(row)))).size !== original.tasks.length)
    fail('original_sfx_request_required');
  await verifyEvidenceBindings([original.frames, original.candidate_source, original.case_source, original.observation_files]);
  await verifyEvidenceBindings([raw.evidence_files, raw.constituent_responses, raw.cli_receipts]);
  const parentRef = requestRefOf(raw, record.raw_response);
  if (!parentRef) fail('original_request_required');
  const parent = await readJson(parentRef.path), full = await validateProjectedInput(parent.input, original, record.input);
  const source = full.data?.source_video_sha256 ?? full.source_video_sha256 ?? null;
  const parts = [];
  if (raw.partition_revision) {
    if (raw.partition_revision !== boundedRevision || raw.partition_count !== raw.constituent_responses?.length
      || raw.partition_count < 1 || raw.usage !== null || raw.usage_is_in_constituent_receipts !== true
      || (raw.historical_cli_receipts ?? []).length || raw.reused !== false || parentRef.sha256 !== raw.request_sha256
      || !same(parent, { role: 'material_candidate_selection', input: full, revision: boundedRevision }))
      fail('bounded_accounting_or_request_changed');
    let start = 0;
    for (const ref of raw.constituent_responses) {
      await verifyEvidenceBindings(ref);
      const child = await readJson(ref.path), childRef = requestRefOf(child, ref);
      if (!childRef) fail('part_request_missing');
      await verifyEvidenceBindings(childRef);
      const childRequest = await readJson(childRef.path), count = childRequest.input?.tasks?.length;
      if (!Number.isSafeInteger(count) || count < 1 || count > 20 || start + count > full.tasks.length)
        fail('contiguous_partition_invalid');
      let expected = structuredClone(full); expected.tasks = full.tasks.slice(start, start + count);
      expected.partition = { revision: boundedRevision, item_start: start, total_items: full.tasks.length, source_order_preserved: true };
      if (Array.isArray(expected.case_context)) {
        const ids = new Set(expected.tasks.map(row => row.case_id));
        expected.case_context = expected.case_context.filter(row => ids.has(row.case_id));
        for (const field of ['frames', 'source_frames', 'frame_sheet_manifests']) if (Array.isArray(expected[field]))
          expected[field] = expected[field].filter(row => row.case_ids?.some(id => ids.has(id)));
      }
      if(childRequest.input.sfx_partition_evidence!==undefined){
        if(childRequest.input.sfx_partition_evidence?.revision!==sfxMaterialPartitionEvidenceRevision)
          fail('partition_evidence_revision_invalid');
        expected=projectSfxMaterialSelectionPartition(expected,{fullInput:full});
      }
      parts.push(await actualPart(ref, expected, source, record.input.sha256)); start += count;
    }
    if (start !== full.tasks.length || !same(raw.value, { decisions: parts.flatMap(row => row.raw.value.decisions) })
      || !same(raw.cli_receipts, parts.map(row => row.receiptRef))) fail('bounded_exact_merge_changed');
  } else parts.push(await actualPart(record.raw_response, full, source, record.input.sha256));
  checkRaw(raw, source, record.input.sha256, parts.reduce((sum, row) => sum + row.raw.actual_frames_submitted, 0));
  if (parts.some(row => row.raw.model !== raw.model || row.raw.model_revision !== raw.model_revision
    || row.raw.backend_id !== raw.backend_id || !same(row.raw.transport, raw.transport))) fail('model_identity_changed');
  checkDecisions(raw.value, original.tasks, original.response_schema);
  // A resumed merge reports only newly executed receipts in the record, while
  // its immutable merged raw retains all constituent receipts. Do not recount.
  let last = -1;
  for (const ref of record.cli_receipts ?? []) {
    const index = raw.cli_receipts.findIndex(row => same(row, ref));
    if (index <= last) fail('record_receipt_accounting_changed'); last = index;
  }
  if (record.selected_count !== raw.value.decisions.reduce((sum, row) => sum + row.selected_segment_ids.length, 0)
    || record.submitted_frame_count !== (original.sfx_material_selection_projection?0:(original.frames ?? []).length)
    || original.sfx_material_selection_projection && record.source_frame_binding_count !== (original.frames??[]).length
    || !same(record.candidate_source, original.candidate_source) || !same(record.case_source, original.case_source))
    fail('record_decision_or_identity_changed');
  return { revision: 'completed-sfx-cli-evidence-v1', original_request: record.input, original_response: record.raw_response,
    source_video_sha256: source, constituent_count: parts.length, submitted_image_count: raw.actual_frames_submitted,
    original_decisions_preserved: true, original_projection_and_images_verified: true,
    actual_usage: parts.map(row => ({ receipt: row.receiptRef, usage: row.raw.usage })),
    original_all_cli_receipts: raw.cli_receipts, recorded_new_cli_receipts: record.cli_receipts ?? [],
    reused: true, new_model_calls: 0, qualification_granted: false, professional_qualification: false, production_approval: false };
}
