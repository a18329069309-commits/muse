import path from 'node:path';
import { readJson, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { verifyCompletedSfxCliSelection } from './completed_sfx_cli_evidence.mjs';
import {sfxEventFunctionRevision,validateSelectedSoundUsage} from './sfx_event_function.mjs';
import {readActualAssemblyMaterialObservation} from './assembly_material_observation.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('completed_sfx_recovery_' + reason); };
const load = async binding => { await verifyEvidenceBindings(binding); return readJson(binding.path); };

// Only byte-verified bindings may ignore a relocated path. All non-binding
// fields, clocks, order, source windows and business text remain exact.
export async function normalizeVerifiedSfxBindings(value, verified = new Map(), contextEquivalence = new Set()) {
  if (Array.isArray(value)) return Promise.all(value.map(item => normalizeVerifiedSfxBindings(item, verified, contextEquivalence)));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  if (typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
    const identity = path.resolve(value.path) + ':' + value.sha256;
    if (!verified.has(identity)) verified.set(identity, verifyEvidenceBindings(value));
    await verified.get(identity);
    for (const [key, item] of Object.entries(value)) if (key !== 'path') result[key] = await normalizeVerifiedSfxBindings(item, verified, contextEquivalence);
    if (contextEquivalence.has(identity)) result.sha256 = '<verified-current-sound-context-equivalence>';
    result.path = '<verified-sha256-bound-path>'; return result;
  }
  for (const [key, item] of Object.entries(value)) result[key] = await normalizeVerifiedSfxBindings(item, verified, contextEquivalence);
  return result;
}

async function currentContextEquivalence(originalDocument, document, currentCaseBinding) {
  const identities = new Set();
  if (!currentCaseBinding) return { identities, proof: null };
  const refs = [...new Map(originalDocument.cases.flatMap(row => row.evidence?.files ?? [])
    .filter(ref => path.basename(ref.path) === 'current-sound-context.json')
    .map(ref => [path.resolve(ref.path) + ':' + ref.sha256, ref])).values()];
  if (refs.length !== 1 || !document.cases.every(row => row.evidence?.files?.some(ref => same(ref, currentCaseBinding))))
    fail('current_context_binding_missing');
  const original = refs[0], previous = await load(original), current = await load(currentCaseBinding);
  // This is the sole permitted outer-SHA equivalence: a current-target context
  // whose entire verified JSON differs only in relocated, same-SHA inner files.
  if (!same(await normalizeVerifiedSfxBindings(previous), await normalizeVerifiedSfxBindings(current)))
    fail('current_context_content_changed');
  for (const ref of [original, currentCaseBinding]) identities.add(path.resolve(ref.path) + ':' + ref.sha256);
  return { identities, proof: { original, current: currentCaseBinding,
    revision: 'verified-current-sound-context-relocation-v1', full_business_content_equal: true,
    leaf_file_hashes_verified: true, nulls_and_array_order_preserved: true } };
}

export async function loadCompletedTargetSfxSelection(binding, { source, libraryBinding, assetKind, document, tasks, currentCaseBinding }) {
  const record = await load(binding);
  if (record.automatic_selection_performed !== true || record.artistic_approval !== false || record.production_approval !== false
    || !['research_materials_selected_pending_independent_review', 'material_selection_gap'].includes(record.status))
    fail('completed_research_selection_required');
  await verifyEvidenceBindings([source, libraryBinding, record]);
  const request = await load(record.input), originalDocument = await load(record.case_source);
  if (!same(request.candidate_source, record.candidate_source) || !same(request.case_source, record.case_source)) fail('request_identity_changed');
  const candidates = expandCandidateEvidence(await load(record.candidate_source));
  await verifyEvidenceBindings(candidates);
  const taskBinding = candidates.evidence_files.find(row => path.basename(row.path) === 'tasks.json');
  if (!taskBinding || !candidates.evidence_files.some(row => row.sha256 === libraryBinding.sha256)
    || !candidates.source_files.some(row => row.sha256 === source.sha256)) fail('frozen_library_or_source_changed');
  const originalTasks = await load(taskBinding);
  const context = await currentContextEquivalence(originalDocument, document, currentCaseBinding);
  if (!same(await normalizeVerifiedSfxBindings(originalDocument, new Map(), context.identities),
      await normalizeVerifiedSfxBindings(document, new Map(), context.identities))
    || !same(await normalizeVerifiedSfxBindings(originalTasks), await normalizeVerifiedSfxBindings({ schema_version: 1, tasks })))
    fail('current_story_or_task_changed');
  if (originalDocument.cases.some(row => row.evidence?.source_video_sha256 !== source.sha256)
    || originalTasks.tasks.some(row => row.query.asset_kind !== assetKind)) fail('source_or_asset_kind_changed');
  const proof = await verifyCompletedSfxCliSelection(record);
  const raw = await load(record.raw_response), decisions = raw.value.decisions;
  const taskKey = row => JSON.stringify([row.case_id, row.step_id, row.kind, row.sound_role ?? null]);
  if (!same(decisions.map(taskKey), request.tasks.map(taskKey))) fail('ordered_decisions_changed');
  const mappings = record.bindings_file ? await load(record.bindings_file) : { bindings: [] };
  if (record.bindings_file && (!same(mappings.input, record.input) || !same(mappings.raw_response, record.raw_response)
    || !same(mappings.source, record.candidate_source) || !same(mappings.case_source, record.case_source)
    || mappings.artistic_approval !== false || mappings.production_approval !== false)) fail('mapping_provenance_changed');
  let selectedCount = 0;
  for (const decision of decisions) {
    const task = request.tasks.find(row => taskKey(row) === taskKey(decision));
    const original = candidates.tasks.find(row => row.case_id === decision.case_id && row.step_id === decision.step_id);
    if (!original || !task) fail('candidate_task_changed');
    if(request.sfx_event_function_revision!==undefined){
      if(request.sfx_event_function_revision!==sfxEventFunctionRevision)fail('event_function_revision_invalid');
      validateSelectedSoundUsage(decision,task);
    }
    const selected = new Set(decision.selected_segment_ids), rejected = new Set(decision.rejections.map(row => row.segment_id));
    if (selected.size !== decision.selected_segment_ids.length || rejected.size !== decision.rejections.length
      || [...selected].some(id => rejected.has(id)) || task.candidates.length !== selected.size + rejected.size
      || task.candidates.some(row => !selected.has(row.segment_id) && !rejected.has(row.segment_id))) fail('candidate_comparison_changed');
    const mapped = mappings.bindings.filter(row => row.case_id === decision.case_id).flatMap(row => row.sounds)
      .filter(row => row.step_id === decision.step_id);
    if (!same(mapped.map(row => row.segment_id), decision.selected_segment_ids)) fail('mapped_selection_changed');
    for (const sound of mapped) {
      const originalSound = original.candidates.find(row => row.candidate.segment_id === sound.segment_id)?.binding.sounds
        .find(row => row.step_id === decision.step_id && row.segment_id === sound.segment_id);
      if (!originalSound) fail('selected_original_window_missing');
      const { listening_evidence: listening, ...actual } = sound;
      if (!same(actual, { ...originalSound, reason: decision.adopt_reason, status: 'research',
        ...(request.sfx_event_function_revision?{sound_function_intent:task.sound_function_intent,
          sound_usage:decision.sound_usage,selection_source_ranges:[decision.sound_usage.usable_source_range]}:{}) })) fail('selected_window_or_reason_changed');
      if (listening?.actual_audio_processed !== true || listening.artistic_approval !== false || listening.production_approval !== false
        || listening.source_sha256 !== sound.source_sha256 || !same(listening.source_range, sound.source_range))
        fail('selected_listening_identity_changed');
      await verifyEvidenceBindings(listening);
      const observation = await load(listening.observation_record);
      let facts = observation.observation;
      if(observation.kind==='frozen_offline_pcm_technical_observation'){
        // The immutable choice/mapping was checked above. Reuse the existing
        // PCM reader to verify its historical clock, levels, transients and
        // optional predictions; this wrapper contributes no new sound facts.
        const candidate={segment_id:sound.segment_id,asset_id:sound.asset_id,
          source_sha256:sound.source_sha256,source_range:sound.source_range,
          observation_record:listening.observation_record};
        facts=await readActualAssemblyMaterialObservation({candidate,observationDocument:observation,
          selectionDocument:{kind:'sound_pool_pending_final_assembly',source_video_sha256:source.sha256,
            prepared_candidate:{...candidate,listening_evidence:listening,current_target_video_sha256:source.sha256},
            selection_provenance:{selector_record:binding,raw_response:record.raw_response,case_input:record.case_source}}});
      }else await verifyLocalAudioExecution(observation, { protocol: observation.protocol, backend_id: observation.backend_id, model_revision: observation.model_revision });
      if (observation.source_sha256 !== sound.source_sha256 || !same(observation.source_range, sound.source_range)
        || !same(facts, listening.observations) || !same(facts,
          task.candidates.find(row => row.segment_id === sound.segment_id).observation)
        || observation.qualified !== false || observation.artistic_approval !== false || observation.production_approval !== false)
        fail('selected_observation_changed');
      selectedCount++;
    }
  }
  for (const mapping of mappings.bindings) {
    const candidate = candidates.tasks.find(row => row.case_id === mapping.case_id)?.candidates
      .find(row => mapping.sounds.some(sound => sound.segment_id === row.candidate.segment_id));
    if (!candidate) fail('mapping_original_missing');
    const { music: _m, sounds: _s, evidence_files: _e, ...actualHeader } = mapping;
    const { music: _om, sounds: _os, evidence_files: originalEvidence, ...originalHeader } = candidate.binding;
    if (!same(actualHeader, originalHeader) || ![record.input, record.raw_response, ...originalEvidence]
      .every(ref => mapping.evidence_files.some(item => same(item, ref)))) fail('mapping_identity_or_evidence_changed');
  }
  if (selectedCount !== record.selected_count || mappings.bindings.some(row => row.music.length
    || !decisions.some(decision => decision.case_id === row.case_id))) fail('mapping_count_changed');
  return { record, selectionRef: binding, caseInput: record.case_source, candidateBinding: record.candidate_source, candidates,
    proof: { revision: 'completed-target-sfx-selection-v1', selection: binding, source, library: libraryBinding,
      current_context_equivalence: context.proof, actual_cli_evidence: proof,
      original_decisions_preserved: true, new_model_calls: 0, qualification_granted: false } };
}
