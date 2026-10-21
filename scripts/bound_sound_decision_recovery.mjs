import path from 'node:path';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { canonicalizeBoundPhysicalSoundRetains } from './sound_edit_decision_contract.mjs';
import { assemblySessionEnvelope, actualAssemblyTail, mergeBoundedAssemblyValues, validateBoundedAssemblyPart } from './bounded_research_assembly.mjs';
import { withActualPreviousAssemblyTail } from './bounded_assembly_projection.mjs';
import { verifyBoundedAssemblyPartExecution } from './bounded_assembly_execution_evidence.mjs';

export const boundSoundDecisionRecoveryKind = 'bound_completed_sound_decision_recovery';
const keys = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates', 'current_materials', 'case_routes', 'music_source_provenance'];
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('bound_sound_decision_recovery_' + reason); };
const load = async ref => { await verifyEvidenceBindings(ref); return readJson(ref.path); };
async function stable(file, value) {
  try { return await saveJson(file, value); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!same(await readJson(file), value)) fail('existing_record_changed');
    return { path: path.resolve(file), sha256: await hashFile(file) };
  }
}

// Verify original callers, every saved part and its real CLI receipts before
// reconstructing the unsaved merge. No model return, plan or selection is edited.
async function context(refs, { inputs, schema, source } = {}) {
  const caller = await load(refs.caller), preflight = await load(refs.preflight);
  const bound = caller.data?.bound_artifacts;
  if (caller.stage !== 'current_research_episode_assembly' || !same(Object.keys(bound ?? {}).sort(), [...keys].sort())
    || schema && !same(schema, caller.schema) || source && source.sha256 !== caller.data.source_video_sha256
    || !same(preflight.original_request, refs.caller) || !Array.isArray(preflight.parts) || preflight.parts.length < 1
    || !Array.isArray(refs.parts) || refs.parts.length !== preflight.parts.length) fail('complete_original_partition_required');
  if (inputs && (!same(Object.keys(inputs).sort(), [...keys].sort()) || keys.some(key => !same(inputs[key], bound[key]))))
    fail('exact_eight_current_inputs_required');
  const values = {};
  for (const key of keys) values[key] = await load(bound[key]);
  const full = await load(caller.data.full_input), actualSource = full.data?.source;
  if (full.stage !== caller.stage || !same(full.schema, caller.schema) || !same(full.data.bound_artifacts, bound)
    || full.data.source_video_sha256 !== caller.data.source_video_sha256
    || keys.some(key => !same(full.data[key], values[key])) || actualSource?.sha256 !== caller.data.source_video_sha256
    || values.manifest.source_sha256 !== actualSource.sha256 || !same(values.manifest.timeline, caller.data.timeline))
    fail('full_host_source_or_facts_changed');
  await verifyEvidenceBindings(actualSource);
  if (source?.path && path.resolve(source.path) !== path.resolve(actualSource.path)) fail('source_path_changed');
  const responses = [], executions = [];
  for (const [index, ref] of refs.parts.entries()) {
    const completed = await load(ref), part = preflight.parts[index], input = await load(completed.input), raw = await load(completed.raw_response);
    let expected = structuredClone(part.input);
    if (responses.length) {
      expected = withActualPreviousAssemblyTail(expected, actualAssemblyTail(responses.at(-1).value, responses.at(-1).raw_response, caller));
      expected.schema.properties.edits.properties.dialogue_ducking_db.enum = [responses[0].value.edits.dialogue_ducking_db];
    }
    if (!same(expected, input) || !same(completed.cue_ids, part.cue_ids) || !same(completed.action_ids, part.action_ids)
      || !same(completed.event_ids, part.event_ids) || !same(completed.target_range, part.target_range)
      || !same(completed.mother_action_partition ?? null, part.mother_action_partition ?? null)
      || !same(completed.previous_response, responses.at(-1)?.raw_response ?? null)
      || completed.execution_gap !== false || completed.actual_audio_hearing_approved !== false || completed.production_approval !== false)
      fail('part_identity_scope_or_previous_tail_changed');
    const requestRef = raw.evidence_files?.find(row => path.resolve(row.path) === path.join(path.dirname(completed.raw_response.path), 'request.json'));
    if (!requestRef) fail('actual_cli_request_required');
    const request = await load(requestRef), story = request.input.data.completed_story ? {
      analysis: request.input.data.completed_story, frame_mapping: request.input.data.source_frame_mapping } : null;
    const session = { story, backend: { protocol: 'codex_cli', backend_id: raw.backend_id, model_revision: raw.model_revision } };
    if (!same(request.input, assemblySessionEnvelope(input, session))) fail('actual_cli_envelope_changed');
    const response = { ...raw, raw_response: completed.raw_response, reused: true, cli_receipts: [], historical_cli_receipts: raw.cli_receipts,
      ...(part.mother_action_partition ? { mother_action_partition: part.mother_action_partition } : {}) };
    const execution = await verifyBoundedAssemblyPartExecution(response, { input, session });
    const originalExecution = { ...execution, reused: false, new_cli_invocations: 1 };
    if (!same(originalExecution, completed.execution)) fail('original_execution_proof_changed');
    const validation = validateBoundedAssemblyPart(raw.value, { ...part, input }, responses, caller);
    if (validation.execution_gap) fail('actual_part_has_execution_gap');
    responses.push(response); executions.push(execution);
  }
  const original = mergeBoundedAssemblyValues(responses, caller);
  const derived = canonicalizeBoundPhysicalSoundRetains(caller, original);
  const { validateResearchEpisodeAssembly } = await import('./assemble_research_episode.mjs');
  validateResearchEpisodeAssembly({ ...values, arc_plan: derived.value.plan, edits: derived.value.edits,
    trial_scope: { kind: 'music_with_optional_sounds_episode', target_range: [0, values.manifest.timeline.duration_samples / 48000],
      excluded_sound_event_ids: [], reason: 'Exact physical no-op alias; original track, actual selection and audition qualifications remain unchanged.' } },
  { musicActionContractVersion: derived.value.edits.schema_version === 2 ? 2 : 1 });
  return { caller, original, derived, responses, executions };
}
function adapterRecord(refs, row) {
  return { schema_version: 1, kind: 'bound_physical_noop_edit_adapter_v1', ...refs,
    source_video_sha256: row.caller.data.source_video_sha256, changes: row.derived.changes,
    original_model_value_sha256: row.derived.original_model_value_sha256, derived_value_sha256: row.derived.derived_value_sha256,
    original_responses_unchanged: true, original_music_reviews_and_source_clocks_unchanged: true,
    actual_sound_selection_performed: false, actual_original_sound_review_performed: false, new_model_calls: 0,
    qualified: false, artistic_approval: false, production_approval: false };
}
function wrapper(refs, row, adapter) {
  return { schema_version: 1, kind: 'host_canonical_sound_decision_assembly_result_v1', execution_kind: 'host_bounded_assembly_merge',
    source_video_sha256: row.caller.data.source_video_sha256, original_request: refs.caller, preflight: refs.preflight,
    parts: refs.parts, constituent_responses: row.responses.map(r => r.raw_response), sound_decision_adapter: adapter,
    value: row.derived.value, completion_status: 'complete', actual_model_parts_executed: true, actual_runtime_executed: false,
    actual_input_processed: true, actual_audio_processed: false, actual_video_processed: false, usage: null,
    usage_is_in_constituent_receipts: true, new_account_call_not_created_by_merge: true,
    qualified: false, artistic_approval: false, production_approval: false };
}
export async function createBoundSoundDecisionRecovery({ caller, preflight, parts, outputDir }) {
  const refs = { caller, preflight, parts }, row = await context(refs);
  const adapter = await stable(path.join(outputDir, 'physical-noop-adapter.json'), adapterRecord(refs, row));
  const derived_response = await stable(path.join(outputDir, 'host-derived-assembly-response.json'), wrapper(refs, row, adapter));
  return stable(path.join(outputDir, 'recovery.json'), { schema_version: 1, kind: boundSoundDecisionRecoveryKind,
    ...refs, adapter, derived_response, source_video_sha256: row.caller.data.source_video_sha256,
    qualified: false, production_approval: false });
}
export async function loadBoundSoundDecisionRecovery(binding, options = {}) {
  if (!options.inputs || !options.source?.sha256) fail('exact_current_context_required');
  const record = await load(binding);
  if (record.kind !== boundSoundDecisionRecoveryKind || record.schema_version !== 1 || record.qualified !== false
    || record.production_approval !== false) fail('typed_unqualified_recovery_required');
  const refs = { caller: record.caller, preflight: record.preflight, parts: record.parts }, row = await context(refs, options);
  if (record.source_video_sha256 !== row.caller.data.source_video_sha256
    || !same(await load(record.adapter), adapterRecord(refs, row))
    || !same(await load(record.derived_response), wrapper(refs, row, record.adapter))) fail('adapter_or_derived_response_changed');
  const historical = row.responses.flatMap(r => r.historical_cli_receipts ?? []);
  const stage = { request: record.caller, raw_response: record.derived_response, sound_decision_recovery: binding,
    sound_decision_adapter: record.adapter, original_model_responses: row.responses.map(r => r.raw_response),
    execution_kind: 'bound_completed_sound_decision_recovery', reused: true, new_model_calls: 0, usage: null,
    cli_receipts: [], historical_cli_receipts: historical, actual_audio_processed: false,
    independent_audio_hearing_approved: false, formal_adoption_allowed: false, production_approval: false };
  return { value: row.derived.value, raw_response: record.derived_response, stage, reused: true, new_model_calls: 0,
    usage: null, cli_receipts: [], historical_cli_receipts: historical, actual_audio_processed: false, production_approval: false };
}

// Controller admission reuses a completed old material execution only for its
// exact saved no-op spelling failure. It grants no new library/policy execution.
export async function preflightBoundSoundDecisionControllerRecovery(binding, { config, source, state } = {}) {
  if (config?.mode !== 'research' || config.automatic_trial !== true
    || config.material_strategy !== 'independent_music_packs' || config.source_policy?.kind !== 'independent_pack_trial'
    || config.trial_review_policy !== 'diagnostic_candidates' || config.quality_review_policy !== 'diagnostic_only')
    fail('explicit_diagnostic_controller_scope_required');
  const record = await load(binding), materials = state?.stages?.materials, assembly = state?.stages?.assembly;
  const originalDirectory=path.resolve(path.dirname(record.caller?.path??'')),
    continuation=assembly?.error==='assembly_sfx_prepared_candidate_changed';
  if (record.kind !== boundSoundDecisionRecoveryKind || !source?.sha256 || !same(state?.source, source)
    || record.source_video_sha256 !== source.sha256 || materials?.status !== 'completed'
    || assembly?.status !== 'failed' || !continuation&&assembly.error !== 'research_trial_episode_sound_decision_invalid'
    || !path.isAbsolute(assembly.directory ?? '') || !continuation&&originalDirectory !== path.resolve(assembly.directory)
    || path.resolve(record.preflight.path) !== path.join(originalDirectory, 'bounded-assembly', 'preflight.json')
    || !Array.isArray(record.parts) || record.parts.some((ref, index) => path.resolve(ref.path)
      !== path.join(originalDirectory, 'bounded-assembly', `part-${index + 1}`, 'completed.json')))
    fail('exact_failed_assembly_and_completed_materials_required');
  await verifyEvidenceBindings([source, materials.result_binding, assembly.failure_evidence]);
  if (!same(await readJson(materials.result_binding.path), materials.result)) fail('completed_material_checkpoint_changed');
  const { readAutomaticStageFailure } = await import('./automatic_stage_failure_evidence.mjs');
  const failure = await readAutomaticStageFailure(assembly.failure_evidence, { stage: 'assembly', source,
    episodeRoot: path.resolve(assembly.directory, '../..') });
  if (failure.original_error?.message !== assembly.error || path.resolve(failure.stage_directory) !== path.resolve(assembly.directory)
    || failure.capture_errors.length) fail('original_failed_stage_changed');
  const prepared = materials.result.prepared_assembly_config;
  const inputs = Object.fromEntries(keys.map(key => [key, prepared?.[key]]));
  if (keys.some(key => !inputs[key]) || materials.result.status !== 'target_research_materials_selected'
    || materials.result.source_video_sha256 !== source.sha256
    || !same(materials.result.source_policy, config.source_policy)
    || materials.result.trial_review_policy !== config.trial_review_policy
    || prepared?.material_strategy !== config.material_strategy) fail('original_frozen_material_scope_changed');
  const caller = await load(record.caller);
  const proof = await loadBoundSoundDecisionRecovery(binding, { inputs, source, schema: caller.schema });
  let continuationProof=null;
  if(continuation){
    const originalAttempt=Number(path.basename(originalDirectory).match(/^attempt-(\d+)$/)?.[1]);
    if(!Number.isSafeInteger(originalAttempt)||assembly.attempt!==originalAttempt+1
      ||path.resolve(assembly.directory)!==path.join(path.dirname(originalDirectory),`attempt-${originalAttempt+1}`)
      ||!state.stage_attempt_history?.some(row=>row.stage==='assembly'&&row.attempt===originalAttempt
        &&row.status==='invalidated_editor_strategy')
      ||!state.bound_assembly_material_reuse?.some(row=>same(row.recovery,binding)
        &&same(row.materials_result,materials.result_binding)&&row.completed_material_execution_reused===true
        &&row.new_material_policy_executed===false&&row.qualification_granted===false&&row.production_approval===false)
      ||failure.reported_cli_receipts.length||failure.primary_receipt||assembly.cli_receipts?.length)
      fail('exact_zero_call_adoption_continuation_required');
    const oldFailurePath=path.join(originalDirectory,'failure-evidence.json'),oldFailureBinding={
      path:oldFailurePath,sha256:await hashFile(oldFailurePath)};
    const oldFailure=await readAutomaticStageFailure(oldFailureBinding,{stage:'assembly',source,
      episodeRoot:path.resolve(originalDirectory,'../..')});
    if(oldFailure.original_error?.message!=='research_trial_episode_sound_decision_invalid'
      ||path.resolve(oldFailure.stage_directory)!==originalDirectory||oldFailure.capture_errors.length)
      fail('original_noop_failure_not_preserved');
    const planBinding={path:path.join(assembly.directory,'arc-plan.json')},editsBinding={path:path.join(assembly.directory,'edits.json')};
    planBinding.sha256=await hashFile(planBinding.path);editsBinding.sha256=await hashFile(editsBinding.path);
    if(!same(await load(planBinding),proof.value.plan)||!same(await load(editsBinding),proof.value.edits))
      fail('continued_plan_or_edits_changed');
    const candidates=await load(inputs.candidates),directionChains=[];
    const{verifyAssemblySoundDirectionChain}=await import('./bound_sfx_direction_provenance.mjs');
    for(const edit of proof.value.edits.sounds.filter(row=>row.decision==='new_asset')){
      const candidate=candidates.sounds?.find(row=>row.event_id===edit.event_id&&row.segment_id===edit.selected_segment_id);
      if(!candidate)fail('continued_exact_selected_pool_required');
      const pool=await load(candidate.selection_record),original={...candidate};
      delete original.selection_record;delete original.sfx_adoption_mode;delete original.adoption_pending;
      if(!same(original,pool.prepared_candidate)||pool.source?.sha256!==source.sha256
        ||!same(pool.analysis,inputs.analysis)||!same(pool.manifest,inputs.manifest))fail('continued_prepared_candidate_changed');
      const chain=await verifyAssemblySoundDirectionChain({source,analysisBinding:inputs.analysis,directorBinding:inputs.director,
        manifestBinding:inputs.manifest,poolBinding:candidate.selection_record,currentMaterialsBinding:inputs.current_materials});
      if(chain)directionChains.push(chain);
    }
    if(!directionChains.length)fail('continued_bound_retrieval_derivative_required');
    continuationProof={revision:'bound-retrieval-direction-adoption-continuation-v1',original_failure:oldFailureBinding,
      continuation_failure:assembly.failure_evidence,continued_plan:planBinding,continued_edits:editsBinding,
      recovery:binding,materials_result:materials.result_binding,direction_chains:directionChains,
      original_parts_and_eight_inputs_unchanged:true,new_model_calls:0,qualification_granted:false,production_approval:false};
  }
  return { binding, proof, inputs, materials_result: materials.result_binding, source_sha256: source.sha256,
    ...(continuationProof?{adoption_continuation:continuationProof}:{}),
    completed_material_execution_reused: true, new_material_policy_executed: false, qualification_granted: false, production_approval: false };
}
export async function verifyBoundSoundDecisionRecoveryForRender({ config, sourceSha, edits, rawResponse }) {
  if (!config.assembly_sound_decision_recovery) {
    if (rawResponse && (await load(rawResponse)).kind === 'host_canonical_sound_decision_assembly_result_v1') fail('render_recovery_binding_required');
    return null;
  }
  const inputs = Object.fromEntries(keys.map(key => [key, config[key]]));
  if (config.sfx_adoption_record) inputs.candidates = (await load(config.sfx_adoption_record)).original_candidates;
  const recovered = await loadBoundSoundDecisionRecovery(config.assembly_sound_decision_recovery, { inputs, source: { sha256: sourceSha } });
  if (!same(recovered.value.edits, edits) || rawResponse && !same(rawResponse, recovered.raw_response)) fail('render_edits_or_response_changed');
  return recovered;
}
