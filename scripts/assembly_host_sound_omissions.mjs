import path from 'node:path';
import { readJson, saveJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { projectAssemblyCueGroup } from './bounded_assembly_projection.mjs';
import { assemblyEditingPermissionsRevision, assemblySoundOwnershipRevision } from './assembly_consumer_projection.mjs';
import { assemblySessionEnvelope, finitePartSchema, validateBoundedAssemblyPart } from './bounded_research_assembly.mjs';
import { verifyBoundedAssemblyPartExecution } from './bounded_assembly_execution_evidence.mjs';

export const hostSoundOmissionRecoveryKind = 'bound_completed_assembly_host_omission_recovery';
const keys = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates', 'current_materials', 'case_routes', 'music_source_provenance'];
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('assembly_host_omission_' + reason); };
const load = async ref => { await verifyEvidenceBindings(ref); return readJson(ref.path); };
async function stable(file, value) {
  try { return await saveJson(file, value); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!same(await readJson(file), value)) fail('existing_artifact_changed');
    return { path: path.resolve(file), sha256: await hashFile(file) };
  }
}

// This is host compilation of already decided omissions, never sound selection
// or a rewritten model return. No partial sound return or real asset is repaired.
export function deriveBoundHostSoundOmissions(input, original) {
  const data = input.data, events = data?.analysis?.sound_events, owned = data?.assembly_partition?.owned_event_ids;
  if (!Array.isArray(events) || !Array.isArray(owned) || !owned.length || new Set(owned).size !== owned.length
    || !same(events.map(row => row.id), owned) || original.execution_gaps?.length !== 0
    || !Array.isArray(original.edits?.sounds) || original.edits.sounds.length !== 0
    || !Array.isArray(data.candidates?.sounds) || data.candidates.sounds.length !== 0)
    fail('only_empty_sound_return_and_complete_owned_omissions');
  const guidance = data.sound_event_guidance;
  if (!Array.isArray(guidance) || guidance.length !== events.length
    || new Set(guidance.map(row => row.event_id)).size !== events.length) fail('exact_bound_guidance_required');
  const omissions = events.map(event => {
    const row = guidance.find(item => item.event_id === event.id);
    if (!row || row.role !== event.role || row.decision !== 'omit' || row.original_status !== 'unknown'
      || row.preserve_original_track !== true || row.selected_segment_id !== null || row.selected_source_range !== null
      || row.source_anchor_seconds !== null || typeof row.reason !== 'string' || !row.reason.trim()
      || !['physical', 'foley', 'ambience', 'dramatic', 'transition'].includes(event.role)
      || !Number.isFinite(event.start_seconds) || !Number.isFinite(event.end_seconds)
      || event.start_seconds < 0 || event.end_seconds <= event.start_seconds
      || ['dramatic', 'transition'].includes(event.role)
        && data.director.sound_queries?.some(query => query.event_id === event.id)) fail('explicit_unchanged_omission_required');
    return { event_id: event.id, selected_segment_id: null, decision: 'omit', original_status: 'unknown', source_range: null,
      target_seconds: event.start_seconds, source_anchor_seconds: 0, gain_db: 0, fade_in_seconds: 0, fade_out_seconds: 0,
      reason: row.reason, anchor_evidence: (event.evidence_ids ?? []).join(',') || 'Bound host omission; no source or synchronization adopted.' };
  });
  const value = structuredClone(original); value.edits.sounds = omissions;
  const music = structuredClone(value); music.edits.sounds = [];
  if (!same(music, original)) fail('model_music_or_review_changed');
  return { value, omissions, event_bindings: events.map(event => ({ event_id: event.id,
    event_sha256: shaBytes(canonical(event)), guidance_sha256: shaBytes(canonical(guidance.find(row => row.event_id === event.id))) })),
    original_model_value_sha256: shaBytes(canonical(original)), derived_value_sha256: shaBytes(canonical(value)) };
}

async function context({ caller: callerRef, part_input: inputRef, response: responseRef }, { inputs, schema, source } = {}) {
  const caller = await load(callerRef), input = await load(inputRef), raw = await load(responseRef);
  const originalInputs = caller.data?.bound_artifacts;
  if (caller.stage !== 'current_research_episode_assembly' || !same(Object.keys(originalInputs ?? {}).sort(), [...keys].sort())
    || source && caller.data.source_video_sha256 !== source.sha256 || schema && !same(caller.schema, schema)) fail('caller_source_or_schema_changed');
  if (inputs && (!same(Object.keys(inputs).sort(), [...keys].sort())
    || keys.some(key => !same(inputs[key], originalInputs[key])))) fail('exact_eight_current_inputs_required');
  const values = {};
  for (const key of keys) values[key] = await load(originalInputs[key]);
  const full = await load(caller.data.full_input), actualSource = full.data?.source;
  if (full.stage !== caller.stage || !same(full.schema, caller.schema) || !same(full.data.bound_artifacts, originalInputs)
    || full.data.source_video_sha256 !== caller.data.source_video_sha256
    || keys.some(key => !same(full.data[key], values[key])) || actualSource?.sha256 !== caller.data.source_video_sha256
    || values.manifest.source_sha256 !== actualSource.sha256 || !same(values.manifest.timeline, caller.data.timeline)) fail('full_host_or_stage_facts_changed');
  await verifyEvidenceBindings(actualSource);
  if (source?.path && path.resolve(source.path) !== path.resolve(actualSource.path)) fail('source_path_changed');
  if (!same(input.data?.assembly_partition?.owned_cue_ids, caller.data.director.cues.map(row => row.cue_id))
    || input.data.actual_previous_assembly_tail || ![assemblyEditingPermissionsRevision, assemblySoundOwnershipRevision]
      .includes(input.data.assembly_consumer_projection_revision)) fail('whole_single_part_required');
  const part = projectAssemblyCueGroup({ ...caller, schema: finitePartSchema(caller.schema) }, input.data.assembly_partition.owned_cue_ids);
  part.input.data.assembly_consumer_projection_revision = input.data.assembly_consumer_projection_revision;
  if (input.data.assembly_consumer_projection_revision === assemblySoundOwnershipRevision) {
    const soundSchema = part.input.schema.properties.edits.properties.sounds;
    soundSchema.minItems = soundSchema.maxItems = part.event_ids.length;
    if (part.event_ids.length) soundSchema.items.properties.event_id = {
      ...soundSchema.items.properties.event_id, enum: [...part.event_ids] };
  }
  if (!same(part.input, input)) fail('actual_part_projection_changed');
  const requestRef = raw.evidence_files?.find(row => path.resolve(row.path) === path.join(path.dirname(responseRef.path), 'request.json'));
  if (!requestRef) fail('actual_cli_request_required');
  const request = await load(requestRef);
  const story = request.input.data.completed_story ? { analysis: request.input.data.completed_story,
    frame_mapping: request.input.data.source_frame_mapping } : null;
  const session = { story, backend: { protocol: 'codex_cli', backend_id: raw.backend_id, model_revision: raw.model_revision } };
  if (!same(request.input, assemblySessionEnvelope(input, session))) fail('actual_session_envelope_changed');
  const execution = await verifyBoundedAssemblyPartExecution({ ...raw, raw_response: responseRef, reused: true,
    cli_receipts: [], historical_cli_receipts: raw.cli_receipts }, { input, session });
  const derived = deriveBoundHostSoundOmissions(input, raw.value);
  validateSchema(derived.value, caller.schema);
  validateBoundedAssemblyPart(derived.value, part, [], caller);
  const { validateResearchEpisodeAssembly } = await import('./assemble_research_episode.mjs');
  validateResearchEpisodeAssembly({ ...values, arc_plan: derived.value.plan, edits: derived.value.edits,
    trial_scope: { kind: 'music_with_optional_sounds_episode', target_range: [0, values.manifest.timeline.duration_samples / 48000],
      excluded_sound_event_ids: [], reason: 'Bound host omissions preserve original; original music planning and audition remain unqualified.' } },
  { musicActionContractVersion: derived.value.edits.schema_version === 2 ? 2 : 1 });
  return { caller, input, raw, originalInputs, execution, derived };
}

function adapterRecord(refs, row) {
  return { schema_version: 1, kind: 'bound_host_sound_omission_adapter_v1', ...refs,
    source_video_sha256: row.caller.data.source_video_sha256, owned_event_ids: row.input.data.assembly_partition.owned_event_ids,
    original_model_value_sha256: row.derived.original_model_value_sha256, derived_value_sha256: row.derived.derived_value_sha256,
    omission_edits: row.derived.omissions, event_bindings: row.derived.event_bindings, modified_fields: ['/edits/sounds'],
    original_model_response_unchanged: true, original_music_actions_reviews_and_gaps_unchanged: true,
    actual_sound_selection_performed: false, actual_original_sound_review_performed: false, new_model_calls: 0,
    qualified: false, artistic_approval: false, production_approval: false };
}
function derivedWrapper(refs, row, adapter) {
  return { schema_version: 1, kind: 'host_sound_omission_assembly_result_v1', execution_kind: 'host_bounded_assembly_merge',
    source_video_sha256: row.caller.data.source_video_sha256, original_request: refs.caller,
    constituent_responses: [refs.response], host_sound_omission_adapters: [adapter], value: row.derived.value,
    completion_status: 'complete', actual_model_parts_executed: true, actual_runtime_executed: false,
    actual_input_processed: true, actual_audio_processed: false, actual_video_processed: false,
    usage: null, usage_is_in_constituent_receipts: true, new_account_call_not_created_by_merge: true,
    actual_sound_selection_performed: false, qualified: false, artistic_approval: false, production_approval: false };
}

export async function createBoundHostSoundOmissionRecovery({ caller, part_input, response, outputDir }) {
  const refs = { caller, part_input, response }, row = await context(refs);
  const adapter = await stable(path.join(outputDir, 'host-sound-omission-adapter.json'), adapterRecord(refs, row));
  const derived_response = await stable(path.join(outputDir, 'host-derived-assembly-response.json'), derivedWrapper(refs, row, adapter));
  return stable(path.join(outputDir, 'recovery.json'), { schema_version: 1, kind: hostSoundOmissionRecoveryKind,
    ...refs, adapter, derived_response, source_video_sha256: row.caller.data.source_video_sha256,
    qualified: false, production_approval: false });
}

export async function loadBoundHostSoundOmissionRecovery(binding, options = {}) {
  if (!options.inputs || !options.source?.sha256) fail('exact_current_recovery_context_required');
  const record = await load(binding);
  if (record.kind !== hostSoundOmissionRecoveryKind || record.schema_version !== 1 || record.qualified !== false
    || record.production_approval !== false) fail('typed_recovery_required');
  const refs = { caller: record.caller, part_input: record.part_input, response: record.response }, row = await context(refs, options);
  if (record.source_video_sha256 !== row.caller.data.source_video_sha256
    || !same(await load(record.adapter), adapterRecord(refs, row))
    || !same(await load(record.derived_response), derivedWrapper(refs, row, record.adapter))) fail('adapter_or_derived_value_changed');
  const stage = { request: record.caller, raw_response: record.derived_response, original_model_response: record.response,
    host_sound_omission_adapter: record.adapter, host_sound_omission_recovery: binding,
    execution_kind: 'bound_completed_bounded_assembly_host_omission_recovery', reused: true, new_model_calls: 0,
    usage: row.raw.usage, cli_receipts: [], historical_cli_receipts: row.raw.cli_receipts,
    actual_audio_processed: false, independent_audio_hearing_approved: false, formal_adoption_allowed: false, production_approval: false };
  return { value: row.derived.value, raw_response: record.derived_response, stage, reused: true, new_model_calls: 0,
    usage: row.raw.usage, cli_receipts: [], historical_cli_receipts: row.raw.cli_receipts,
    actual_audio_processed: false, production_approval: false };
}

export async function verifyHostSoundOmissionRecoveryForRender({ config, sourceSha, edits, rawResponse }) {
  if (!config.assembly_host_sound_omission_recovery) {
    if (rawResponse && (await load(rawResponse)).kind === 'host_sound_omission_assembly_result_v1') fail('render_recovery_binding_required');
    return null;
  }
  const inputs = Object.fromEntries(keys.map(key => [key, config[key]]));
  if (config.sfx_adoption_record) {
    const adoption = await load(config.sfx_adoption_record);
    inputs.candidates = adoption.original_candidates;
  }
  const recovered = await loadBoundHostSoundOmissionRecovery(config.assembly_host_sound_omission_recovery,
    { inputs, source: { sha256: sourceSha } });
  if (!same(recovered.value.edits, edits) || rawResponse && !same(rawResponse, recovered.raw_response)) fail('render_edits_or_response_changed');
  return recovered;
}
