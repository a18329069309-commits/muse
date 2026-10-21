import { projectTrialPreflight } from './project_trial_gate.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings, validateSchema, objectSchema } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { compileSoundArcPlan, soundArcPlanV2Schema } from './sound_arc_plan.mjs';
import { editSchema, editSchemaFor, compileEdit } from './compose_episode.mjs';
import { actionTasksCover } from './music_edit_operation_contract.mjs';
import { assertResearchEpisodeScope, renderResearchTrial } from './render_research_trial.mjs';
import { verifyResearchAudioEvidence } from './research_audio_evidence.mjs';
import { loadDiagnosticEditingCaveats, allowsDiagnosticEditingCaveats } from './diagnostic_editing_caveats.mjs';
import {assemblySfxAdoptionEnabled,finalizeAssemblySfxAdoption} from './assembly_sfx_adoption.mjs';
import {validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {executeBoundedResearchAssembly,assemblySessionEnvelope} from './bounded_research_assembly.mjs';
import {executeRoleSplitResearchAssembly} from './role_split_research_assembly.mjs';
import {constraintEditorEnabled,executeConstraintEpisodeEditor,verifyConstraintEditorExecution} from './constraint_episode_editor.mjs';
import {measureEditorSourceWindows,compactEditorSourceMeasurements} from './editor_source_window_measurements.mjs';
import {measureEditorOriginalMixWindows,compactEditorOriginalMixMeasurements} from './editor_original_mix_measurements.mjs';
import {motherActionPartitionRevision} from './bounded_mother_action_projection.mjs';
import {boundedPartScopeRevision,withDiagnosticAssemblySoundPolicy,withAssemblySoundFunctionContext,applyObservedAssemblySoundSchema} from './assembly_consumer_projection.mjs';
import {readActualAssemblyMaterialObservation} from './assembly_material_observation.mjs';
import { applyStrictSoundEditDecisionSchema } from './sound_edit_decision_contract.mjs';
import {applyAssemblyGapSchema,withAssemblyGapContract,assemblyGapContext,readAssemblyWordExplorations,
  preflightAssemblyMaterials,auditAssemblyGapDisposition} from './object_scoped_assembly_gaps.mjs';
import {auditMusicActionExecution} from './music_action_execution_audit.mjs';

const text = value => typeof value === 'string' && Boolean(value.trim());
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && Math.round(value[1] * 48000) > Math.round(value[0] * 48000);
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
const within = (a, b) => range(a) && range(b) && a[0] >= b[0] && a[1] <= b[1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strings = { type: 'array', items: { type: 'string' } };
export const researchEpisodeAssemblySchema = objectSchema({ plan: soundArcPlanV2Schema, edits: editSchema,
  execution_gaps: strings, review_pending: strings });
export function researchAssemblySchema(config) {
  let schema = config.assembly_contract_version === 2 || config.music_action_contract_version === 2
    ? structuredClone(researchEpisodeAssemblySchema) : researchEpisodeAssemblySchema;
  if (config.music_action_contract_version === 2) schema.properties.edits = structuredClone(editSchemaFor(2));
  if (config.assembly_contract_version === 2) {
    schema.properties.edits.properties.uncertainties.maxItems = 0;
    schema.properties.edits.properties.dialogue_ducking_db = { type: 'number', minimum: 0, maximum: 18,
      description: 'A positive attenuation amount in dB applied locally to music beneath dialogue; not a signed gain, and never a change to the dialogue track.' };
  }
  schema = applyStrictSoundEditDecisionSchema(schema, config.sound_edit_decision_contract_revision);
  schema = applyAssemblyGapSchema(schema, config);
  if (!config.diagnostic_sample) return schema;
  return objectSchema({ ...schema.properties,
    diagnostic_target_range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    diagnostic_reason: { type: 'string' } });
}

export function validateDiagnosticSample(value, duration, config) {
  if (!config.diagnostic_sample) return null;
  const options = config.diagnostic_sample, window = value.diagnostic_target_range;
  if (config.material_strategy !== 'independent_music_packs' || options.minimum_seconds !== 20
    || options.maximum_seconds !== 30 || !within(window, [0, duration])
    || window[1] - window[0] < Math.min(20, duration) || window[1] - window[0] > 30
    || !text(value.diagnostic_reason)) throw Error('independent_diagnostic_sample_invalid');
  return { target_range: window, reason: value.diagnostic_reason,
    selected_by: 'actual_episode_assembly_director', ready_for_audition: false, production_approval: false };
}
const requiredInputs = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates',
  'current_materials', 'case_routes', 'music_source_provenance'];

async function readBound(binding) {
  if (!path.isAbsolute(binding?.path ?? '') || !/^[a-f0-9]{64}$/i.test(binding?.sha256 ?? ''))
    throw new Error('research_assembly_bound_artifact_required');
  await verifyEvidenceBindings(binding);
  return { binding: { path: path.resolve(binding.path), sha256: binding.sha256 }, value: await readJson(binding.path) };
}
async function saveStable(file, value) {
  try { return await saveJson(file, value); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJson(file);
    if (!same(prior, value)) throw new Error('research_assembly_frozen_input_changed');
    return { path: path.resolve(file), sha256: await hashFile(file) };
  }
}
export const projectResearchAssemblyCandidate = row => Object.fromEntries(Object.entries(row).filter(([key]) => [
  'cue_id', 'parent_cue_id', 'event_id', 'sound_role', 'segment_id', 'asset_id', 'source_sha256', 'source_range',
  'allowed_target_range', 'selection_source_ranges', 'pack_id', 'window_id', 'preset_id', 'route_kind', 'condition_binding', 'music_pack_id',
  'offline_observation', 'observation_record', 'selection_record', 'source_anchor_seconds',
  'assembly_sfx_pool_contract_revision','sound_query_projection',
  'source_anchor_evidence', 'anchor_review_status', 'source_facts_scope', 'original_sound_review', 'original_status',
  'duration_role', 'required_duration_seconds', 'current_event_target_range',
  ...(row.assembly_sfx_pool_contract_revision?['adoption_pending','assembly_adopt_reason','function_decision_response']:[]),
  ...(row.sound_function_intent?['sound_function_intent','sound_usage','selector_adopt_reason']:[])].includes(key)));

// Checks authored decisions and their links. It measures neither dramatic quality nor audible source facts.
function validateEpisodeStory({ manifest, analysis, director, evidence_catalog: catalog, case_routes: routes }) {
  const N = manifest.timeline?.duration_samples, duration = N / 48000, sourceSha = manifest.source_sha256;
  if (manifest.analysis_window || manifest.timeline?.sample_rate !== 48000 || !Number.isSafeInteger(N) || N <= 0
    || !/^[a-f0-9]{64}$/i.test(sourceSha ?? '')
    || [analysis.source_video_sha256, director.source_video_sha256, catalog.source_video_sha256, routes?.source_video_sha256]
      .some(value => value !== sourceSha)) throw new Error('research_assembly_full_current_episode_required');
  const evidenceIds = new Set((catalog.evidence ?? []).map(row => row.id));
  if (!evidenceIds.size || evidenceIds.size !== catalog.evidence.length
    || catalog.evidence.some(row => !text(row.id) || !['frame', 'transcript', 'audio_observation'].includes(row.kind)
      || row.kind === 'audio_observation' && (row.verified !== false || row.qualified !== false
        || row.sound_facts_qualified !== false || row.source_video_sha256 !== sourceSha
        || !within([row.start_seconds, row.end_seconds], [0, duration]))))
    throw new Error('research_assembly_story_evidence_required');
  const beats = analysis.story_beats ?? [], beatIds = new Set(beats.map(row => row.id));
  if (!beats.length || beatIds.size !== beats.length || Math.round(beats[0].start_seconds * 48000) !== 0
    || Math.round(Math.max(...beats.map(row => row.end_seconds)) * 48000) !== N
    || beats.some((row, index) => !text(row.id) || !within([row.start_seconds, row.end_seconds], [0, duration])
      || index && row.start_seconds < beats[index - 1].start_seconds
      || !['perspective', 'expectation_before', 'new_information', 'expectation_after', 'control_change', 'sound_decision']
        .every(key => text(row[key]))
      || !row.evidence_ids?.length || row.evidence_ids.some(id => !evidenceIds.has(id))))
    throw new Error('research_assembly_whole_story_decisions_required');
  const referenced = new Set();
  for (const cue of director.cues ?? []) {
    if (!text(cue.function) || !text(cue.sound_goal) || !cue.story_beat_ids?.length
      || cue.story_beat_ids.some(id => !beatIds.has(id))) throw new Error('research_assembly_cue_story_function_required');
    for (const id of cue.story_beat_ids) referenced.add(id);
  }
  if (referenced.size !== beatIds.size) throw new Error('research_assembly_whole_story_not_consumed');
  assertResearchEpisodeScope({ config: { mode: 'research', strategy: 'current_director_research',
    trial_scope: { kind: 'music_only_episode', target_range: [0, duration] } },
    director, analysis, edits: { sounds: [] }, sounds: [], durationSamples: N });
  return { N, duration, sourceSha, beats, beatIds };
}

export function validateResearchEpisodeAssembly(values, { editingCaveatReview = null, musicActionContractVersion = 1,
  assemblySfxPoolContractRevision = null } = {}) {
  const { manifest, analysis, director, candidates, arc_plan: plan, edits, trial_scope: scope } = values;
  const { N, sourceSha, beats, beatIds } = validateEpisodeStory(values);
  if (plan.source_video_sha256 !== sourceSha) throw new Error('research_assembly_full_current_episode_required');
  if (plan.schema_version !== 2) throw new Error('research_assembly_explicit_arc_v2_required');
  const compiled = compileSoundArcPlan({ plan, director, candidates: candidates.music ?? [], wordsCandidates: candidates.words });
  if(assemblySfxPoolContractRevision!==null&&assemblySfxPoolContractRevision!=='observed-candidates-final-assembly-v1')
    throw Error('research_assembly_sfx_pool_contract_invalid');
  const effectiveEditSchema=assemblySfxPoolContractRevision===null?editSchemaFor(musicActionContractVersion)
    :applyObservedAssemblySoundSchema(objectSchema({edits:editSchemaFor(musicActionContractVersion)})).properties.edits;
  validateSchema(edits,effectiveEditSchema);
  const taskIds = new Set(compiled.splitCues.flatMap(cue => [cue.cue_id, ...(cue.words_target_range ? [`${cue.cue_id}/words`] : [])]));
  if ((edits.uncertainties.length && !allowsDiagnosticEditingCaveats(editingCaveatReview, { sourceSha, edits }))
    || edits.music_edits.length !== taskIds.size
    || new Set(edits.music_edits.map(row => row.music_task_cue_id)).size !== taskIds.size
    || edits.music_edits.some(row => !taskIds.has(row.music_task_cue_id) || !text(row.transition_reason)))
    throw new Error('research_assembly_exact_piece_edits_required');
  const actions = director.music_actions ?? [];
  if (new Set(actions.map(row => row.id)).size !== actions.length || edits.action_responses.length !== actions.length
    || new Set(edits.action_responses.map(row => row.action_id)).size !== actions.length
    || actions.some(action => !beatIds.has(action.story_beat_id) || !text(action.intent)
      || !edits.action_responses.some(row => row.action_id === action.id && same(row.target_range, action.target_range)
        && text(row.reason) && (musicActionContractVersion === 2
          ? actionTasksCover(row, action, compiled.splitCues.flatMap(cue => [cue,
            ...(cue.words_target_range ? [{ cue_id: cue.cue_id + '/words', target_range: cue.words_target_range }] : [])]), 2)
          : compiled.splitCues.some(cue => cue.cue_id === row.music_task_cue_id && within(row.target_range, cue.target_range))))))
    throw new Error('research_assembly_current_action_responses_required');
  assertResearchEpisodeScope({ config: { mode: 'research', strategy: 'current_director_research', trial_scope: scope },
    director, analysis, edits, sounds: candidates.sounds ?? [], durationSamples: N });
  if (!['music_only_episode', 'music_with_optional_sounds_episode'].includes(scope?.kind))
    throw new Error('research_assembly_episode_scope_required');
  const pieces = plan.arcs.flatMap(arc => arc.pieces.map(piece => {
    const mother = director.cues.find(cue => cue.cue_id === arc.cue_id);
    const story = beats.filter(beat => mother.story_beat_ids.includes(beat.id)
      && overlaps(piece.target_range, [beat.start_seconds, beat.end_seconds]));
    if (!story.length || !text(piece.development_role)) throw new Error('research_assembly_piece_story_function_required');
    return { cue_id: arc.cue_id, arc_id: arc.arc_id, piece_id: piece.piece_id,
      story_beat_ids: story.map(beat => beat.id), narrative_function: piece.development_role,
      target_range: piece.target_range, source_window: piece.source_window,
      connection: piece.connection_from, independent_hearing_approved: false };
  }));
  return { source_video_sha256: sourceSha, duration_samples: N, story_beat_ids: beats.map(row => row.id),
    music_piece_decisions: pieces, sound_event_decisions: analysis.sound_events.map(event => {
      const edit = edits.sounds.find(row => row.event_id === event.id);
      return { event_id: event.id, role: event.role, decision: edit?.decision ?? 'omit',
        reason: edit?.reason ?? scope.excluded_sound_event_reasons?.[event.id] ?? scope.reason,
        original_status: edit?.original_status ?? 'unknown' };
    }), seams_pending: compiled.pending, qualification_granted: false, production_approval: false };
}

// Typed non-blocking caveats never bypass the real compiler or actual-operation
// audit. This is a technical proof only; listening remains outstanding.
export function auditResearchAssemblyTechnicalOperands(values,value,{manifestPath,musicActionContractVersion=1,
  assemblySfxPoolContractRevision=null}={}){
  const scope={kind:'music_with_optional_sounds_episode',target_range:[0,values.manifest.timeline.duration_samples/48000],
    excluded_sound_event_ids:[],reason:'Exact unchanged technical assembly verification; independent hearing pending.'};
  const sounds=(values.candidates.sounds??[]).filter(candidate=>value.edits.sounds.some(edit=>edit.decision==='new_asset'
    &&edit.event_id===candidate.event_id&&edit.selected_segment_id===candidate.segment_id));
  validateResearchEpisodeAssembly({...values,candidates:{...values.candidates,sounds},arc_plan:value.plan,edits:value.edits,trial_scope:scope},
    {musicActionContractVersion,assemblySfxPoolContractRevision});
  const arcs=compileSoundArcPlan({plan:value.plan,director:values.director,candidates:values.candidates.music??[],wordsCandidates:values.candidates.words??[]});
  const tasks={cues:[...arcs.splitCues]},routes={cues:[]};
  for(const task of arcs.splitCues){
    const piece=arcs.arcManifest.arcs.flatMap(arc=>arc.pieces).find(row=>row.cue_id===task.cue_id);
    if(piece.source_window){
      const candidates=(values.candidates.music??[]).filter(candidate=>candidate.segment_id===piece.source_window.segment_id
        &&candidate.asset_id===piece.source_window.asset_id&&candidate.source_sha256===piece.source_window.source_sha256
        &&same(candidate.source_range,piece.source_window.candidate_source_range));
      if(candidates.length!==1)throw Error('research_assembly_unique_actual_source_for_compiler_required');
      routes.cues.push({cue_id:task.cue_id,status:'research_selected',selected:{...candidates[0],source_range:piece.source_window.source_range}});
    }
    if(task.words_target_range){
      const words=(values.candidates.words??[]).filter(word=>word.parent_cue_id===task.arc_parent_cue_id||word.cue_id===task.arc_parent_cue_id+'/words');
      if(words.length!==1)throw Error('research_assembly_required_actual_words_source_for_compiler_required');
      const word=words[0],child={cue_id:task.cue_id+'/words',parent_cue_id:task.cue_id,music_role:'words_candidate',
        target_range:task.words_target_range,words_mode:task.words_mode};
      if(Math.round((word.source_range[1]-word.source_range[0])*48000)!==Math.round((task.words_target_range[1]-task.words_target_range[0])*48000))
        throw Error('research_assembly_complete_required_words_phrase_required');
      tasks.cues.push(child);routes.cues.push({cue_id:child.cue_id,status:'research_selected',selected:word});
    }
  }
  const compiled=compileEdit({edits:value.edits,tasks,routes,analysis:values.analysis,manifestPath,
    duration:values.manifest.timeline.duration_samples/48000,execution:'host',arcManifest:arcs.arcManifest,
    evidence:{refs:new Map(values.evidence_catalog.evidence.map(row=>[row.id,row])),sounds},dialogueIntervals:[]});
  const audit=auditMusicActionExecution({director:values.director,plan:value.plan,edits:value.edits,compiled});
  if(audit.actions.some(action=>action.status==='unresolved'&&action.execution_evidence?.operation?.kind!=='source_development'))
    throw Error('research_assembly_actual_technical_edit_or_hold_still_unresolved');
  return {actual_compiler_executed:true,actual_operation_audit:audit,qualification_granted:false,production_approval:false};
}

// A shared host/API assembly seam. Upstream analysis, recall, selection and actual observations remain real inputs.
export async function assembleResearchEpisode(config, runtime = {}) {
  if(config.bounded_assembly_part_scope_revision!==undefined&&(config.bounded_assembly_part_scope_revision!==boundedPartScopeRevision
    ||config.assembly_contract_version!==2||config.music_action_contract_version!==2))
    throw Error('research_assembly_explicit_owned_part_scope_config_required');
  if(config.bounded_assembly_projection_revision!==undefined&&(config.bounded_assembly_projection_revision!==motherActionPartitionRevision
    ||config.assembly_contract_version!==2||config.music_action_contract_version!==2))
    throw Error('research_assembly_explicit_complete_action_partition_config_required');
  const combinedSfx=assemblySfxAdoptionEnabled(config);
  const projectGate = await projectTrialPreflight(config, { operation: 'assemble_research_episode' });
  if (projectGate) return projectGate;

  if (config.schema_version !== 1 || config.mode !== 'research' || config.strategy !== 'current_director_research'
    || !path.isAbsolute(config.output_dir ?? '') || !['fine', 'fast'].includes(config.craft_mode)
    || !['auto', 'male', 'female'].includes(config.audience)) throw new Error('research_assembly_config_invalid');
  const out = path.resolve(config.output_dir), inputs = {}, values = {};
  const diagnosticSoundPolicy=combinedSfx?await validateIndependentMusicPackPolicy(config,
    {outputDirectory:out,operation:'prepare_independent_music_materials'}):null;
  for (const key of requiredInputs) {
    const bound = await readBound(config[key]); inputs[key] = bound.binding; values[key] = bound.value;
  }
  const manifest = values.manifest, video = path.resolve(path.dirname(inputs.manifest.path), manifest.source_video);
  const source = { path: video, sha256: manifest.source_sha256 }; await verifyEvidenceBindings(source);
  for (const row of values.evidence_catalog.evidence ?? []) await verifyEvidenceBindings(row);
  const sourceAudioObservations = [];
  for (const row of values.evidence_catalog.evidence ?? []) if (row.kind === 'audio_observation')
    sourceAudioObservations.push(await verifyResearchAudioEvidence(row, { manifest, manifestBinding: inputs.manifest }));
  validateEpisodeStory(values);
  const materialObservations = [], inlineMaterialObservations = [];
  for (const candidate of [...(values.candidates.music ?? []), ...(values.candidates.words ?? []), ...(values.candidates.sounds ?? [])]) {
    if (!candidate.observation_record || !candidate.selection_record || !candidate.local_path || !candidate.source_sha256)
      throw new Error('research_assembly_actual_material_evidence_required');
    await verifyEvidenceBindings([candidate.observation_record, candidate.selection_record,
      { path: candidate.local_path, sha256: candidate.source_sha256 }]);
    materialObservations.push({ segment_id: candidate.segment_id, source_sha256: candidate.source_sha256,
      source_range: candidate.source_range, observation_record: candidate.observation_record,
      actual_observation_document: await readJson(candidate.observation_record.path),
      selection_record: candidate.selection_record, current_selection_document: await readJson(candidate.selection_record.path) });
    const actual=materialObservations.at(-1);
    inlineMaterialObservations.push(await readActualAssemblyMaterialObservation({candidate,
      observationDocument:actual.actual_observation_document,selectionDocument:actual.current_selection_document}));
  }
  let scopedGapContext=null,scopedGapAudit=null;
  if(config.assembly_gap_contract_revision!==undefined){
    // Validate the explicit revision even when mandatory material is absent.
    researchAssemblySchema(config);
    scopedGapContext=assemblyGapContext(values,await readAssemblyWordExplorations(values));
    const materialPreflight=preflightAssemblyMaterials(values);
    const binding=await saveStable(path.join(out,'assembly-material-preflight.json'),materialPreflight);
    if(materialPreflight.execution_blockers.length){
      const record={status:'research_assembly_execution_gap',inputs,stage:{material_preflight:binding,new_model_calls:0},
        execution_gaps:materialPreflight.execution_blockers.map(row=>row.reason_code+':'+row.object_id),
        gap_records:materialPreflight.execution_blockers,review_pending:[],production_approval:false};
      await saveStable(path.join(out,'assembly-record.json'),record);return record;
    }
  }
  let stage = null, review = [], diagnosticSample = null, constraintDirectorBinding = null, editorSourceMeasurements = null,
    editorOriginalMixMeasurements = null;
  if (Boolean(config.arc_plan) !== Boolean(config.edits)) throw new Error('research_assembly_paired_plan_and_edits_required');
  const recovery = runtime.assemblyRecoveries?.[manifest.source_sha256];
  const constraintEditor = constraintEditorEnabled(config);
  if (constraintEditor && (recovery || config.arc_plan)) throw Error('constraint_editor_one_actual_execution_source_required');
  if(combinedSfx&&config.arc_plan)throw Error('assembly_sfx_actual_final_response_required');
  if (constraintEditor) {
    const response = await executeConstraintEpisodeEditor({ config, inputs, directory: path.join(out, 'constraint-editor') });
    stage = { raw_response: response.raw_response, execution_kind: response.execution_kind,
      constraint_editor_execution: response.constraint_editor_execution, new_model_calls: 0,
      independent_audio_hearing_approved: false };
    if (response.value.execution_gaps.length) {
      const record = { status: 'research_assembly_execution_gap', inputs, stage,
        execution_gaps: response.value.execution_gaps, review_pending: response.value.review_pending, production_approval: false };
      await saveStable(path.join(out, 'assembly-record.json'), record); return record;
    }
    await verifyConstraintEditorExecution(response.raw_response, { sourceSha: manifest.source_sha256, edits: response.value.edits });
    validateSchema(response.value, researchAssemblySchema(config));
    constraintDirectorBinding = await saveStable(path.join(out, 'constraint-editor', 'effective-director.json'), response.effective_director);
    values.director = response.effective_director;
    stage.effective_director = constraintDirectorBinding;
    values.arc_plan = response.value.plan; values.edits = response.value.edits;
    inputs.arc_plan = await saveStable(path.join(out, 'arc-plan.json'), values.arc_plan);
    inputs.edits = await saveStable(path.join(out, 'edits.json'), values.edits);
    review = response.value.review_pending.map(item => ({ text: item, actual_constraint_editor_execution: response.raw_response }));
  } else if (recovery) {
    if (config.arc_plan || config.edits) throw new Error('research_assembly_one_decision_source_required');
    const { loadBoundAssemblyRecovery } = await import('./research_assembly_resume.mjs');
    const restored = await loadBoundAssemblyRecovery(recovery, { inputs, schema: researchAssemblySchema(config), source });
    diagnosticSample = validateDiagnosticSample(restored.value, manifest.timeline.duration_samples / 48000, config);
    stage = restored.stage;
    if (restored.value.execution_gaps.length) {
      const record = { status: 'research_assembly_execution_gap', inputs, stage,
        execution_gaps: restored.value.execution_gaps, review_pending: restored.value.review_pending, production_approval: false };
      await saveStable(path.join(out, 'assembly-record.json'), record); return record;
    }
    values.arc_plan = restored.value.plan; values.edits = restored.value.edits;
    inputs.arc_plan = await saveStable(path.join(out, 'arc-plan.json'), values.arc_plan);
    inputs.edits = await saveStable(path.join(out, 'edits.json'), values.edits);
    review = restored.value.review_pending.map(item => ({ text: item, actual_assembly_response: restored.stage.raw_response }));
  } else if (config.arc_plan) {
    for (const key of ['arc_plan', 'edits']) {
      const bound = await readBound(config[key]); inputs[key] = bound.binding; values[key] = bound.value;
    }
  } else {
    const session = runtime.session;
    if (typeof session?.director !== 'function' && typeof session?.request !== 'function')
      throw new Error('research_assembly_actual_director_runtime_required');
    const gapClassificationRecovery=runtime.boundedAssemblyGapClassifications?.[manifest.source_sha256];
    let request,requestBinding;
    if(gapClassificationRecovery){
      if(config.mode!=='research'||config.automatic_trial!==true||config.material_strategy!=='independent_music_packs'
        ||config.trial_review_policy!=='diagnostic_candidates'||config.arc_plan||config.edits)
        throw Error('research_assembly_gap_classification_diagnostic_policy_required');
      const {preflightBoundAssemblyGapClassificationRecovery}=await import('./bounded_assembly_gap_classification.mjs');
      const restored=await preflightBoundAssemblyGapClassificationRecovery(gapClassificationRecovery,
        {inputs,schema:researchAssemblySchema(config),source});
      if(config.bounded_assembly_part_scope_revision!==undefined
        &&restored.caller.data.bounded_part_scope_revision!==config.bounded_assembly_part_scope_revision)
        throw Error('research_assembly_gap_recovery_part_scope_revision_changed');
      request=restored.caller;requestBinding=restored.requestBinding;
    }else{
    request = { stage: 'current_research_episode_assembly', schema: researchAssemblySchema(config),
      prompt: 'Read the complete ordered episode story and current director decisions before arranging. Return one explicit v2 music arc per mother cue and exact edits for the supplied real candidates. Each piece must serve its current story perspective, expectation and control change; use development_role to explain its musical function. Keep recording source ranges distinct from episode target ranges, preserve current actions, and use explicit actual connections. Give every sound event one addition or omission decision. Unknown physical, Foley and ambience retain the original track through omission; optional dramatic or transition additions need supplied candidates and anchors. An ambient bed may be added only from a supplied candidate carrying an exact human original-event review and verified_missing/verified_insufficient status; preserve that status, use target_seconds as its start and source_anchor_seconds:0 (no transient sync). Do not create observations, selections, sources, implicit loops, hearing approval or production approval. Preserve listening, phrases, seams and source duplication uncertainties in review_pending; unexecutable bounds or coverage go in execution_gaps.',
      data: { source_video_sha256: manifest.source_sha256, source, bound_artifacts: inputs, ...values,
        ...(config.assembly_decision_contract_revision?{assembly_decision_contract_revision:config.assembly_decision_contract_revision}:{}),
        ...(config.assembly_sfx_pool_contract_revision?{assembly_sfx_pool_contract_revision:config.assembly_sfx_pool_contract_revision}:{}),
        ...(config.assembly_source_capacity_revision?{assembly_source_capacity_revision:config.assembly_source_capacity_revision}:{}),
        ...(config.bounded_assembly_projection_revision?{bounded_assembly_projection_revision:config.bounded_assembly_projection_revision}:{}),
        ...(config.bounded_assembly_part_scope_revision!==undefined?{bounded_part_scope_revision:config.bounded_assembly_part_scope_revision}:{}),
        ...(config.sound_edit_decision_contract_revision!==undefined?{sound_edit_decision_contract_revision:config.sound_edit_decision_contract_revision}:{}),
        ...(config.diagnostic_sample ? { diagnostic_sample: { ...config.diagnostic_sample,
          instruction: 'Choose a 20–30 second diagnostic scene from this actual episode where the emotional or control change tests the music. Return diagnostic_target_range and diagnostic_reason on this unchanged video clock; caller supplied no timestamps.' } } : {}),
        actual_material_observations: materialObservations, unqualified_source_audio_observations: sourceAudioObservations },
      frames: values.evidence_catalog.evidence.filter(row => row.kind === 'frame') };
    request.prompt += ' Every compiled music_task_cue_id is exactly <mother cue_id>/arc/<arc_id>/<piece_id>; use this ID in music_edits and action_responses. '
      + 'Each piece source_range length must equal its target_range length at 48kHz, remain inside the supplied selected candidate and use no implicit loop. '
      + (config.music_action_contract_version === 2
        ? 'Use edits.schema_version:2. Each current action has one response with its unchanged full target_range, primary music_task_cue_id and music_task_cue_ids jointly covering it; multiple real pieces are allowed. Declare actual_edit_operation.kind and its actual target anchor. Use response_kind:hold with kind:hold only for requested holds; use edit_operation for actual source_switch, gain_change, gain_envelope, accent or lyric_entry. Source_switch must occur at the real recording/source-position change. Gain/envelope changes must exist in music_edits; accent needs an actual bounded gain peak, and neither proves instrumentation or artistic response. Lyric entry requires a supplied real words-input task; no words source may be invented. Source_development without exact independently verified local source facts remains unresolved in review_pending. For no authored automation set gain_envelope:null; otherwise provide relative dB points with exact zero and task-duration endpoints. Do not use source_continuation to discard an authored envelope; use actual piece gains for the compiler\'s continuous gain smoothing. '
        : 'Each current music action must have one response covering its unchanged full action target_range inside one compiled piece. ')
      + 'If supplied words candidates are empty, do not invent a vocal source or a verified phrase; retain the recorded explored-word gap in review_pending.';
    if(values.candidates.sounds?.some(row=>row.duration_role==='bed'&&!row.sound_function_intent))request.prompt +=
      (values.candidates.sounds.some(row=>row.sound_function_intent)
        ?' A legacy dramatic bed without sound_function_intent uses its technical source-window start, not an interior peak: preserve its source_range start, '
        :' A supplied dramatic bed uses its technical source-window start, not an interior peak: preserve its source_range start, ')
      + 'set source_anchor_seconds to that start and target_seconds to the current event start, and use real source duration '
      + 'equal to the full current event duration at 48kHz, without extending its end. Its placement receipt approves no sound type, heard transient or scene fit.';
    if(combinedSfx)request.prompt+=' The supplied sound pool has been actually observed and selected for comparison, but final adoption has NOT executed. '
      +'Use this same final assembly return to decide adopt or omit for every current sound event. Choose at most one supplied candidate per event; '
      +'keep the original unknown physical/Foley/environment track, do not invent candidates or widen their selected source windows, '
      +'and preserve unchanged measured anchors. Mark audition pending. Do not treat a prepared pool as an adopted cue.';
    if (config.assembly_contract_version === 2) request.prompt += ' Assembly contract v2 requires edits.uncertainties to be empty. '
      + 'Report every unexecutable source, identity, coverage, phrase or editing problem in execution_gaps; never conceal a genuine execution gap. '
      + 'Keep all pending audition, prediction-precision and measurement-limit remarks in review_pending, without claiming hearing or production approval. '
      + 'dialogue_ducking_db is a positive music attenuation amount from 0 to 18 dB, applied locally beneath dialogue; it is not a signed gain and does not change the dialogue track.';
    if (config.sound_edit_decision_contract_revision) request.prompt += ' Sound edit decisions are strictly new_asset or omit. '
      + 'The analysis retain_original policy compiles to omit with null selected_segment_id/source_range and no added sound; '
      + 'this preserves the original track without confirming that a physical sound exists. Never return retain_original in edits.sounds.';
    if(diagnosticSoundPolicy)request=withDiagnosticAssemblySoundPolicy(request,diagnosticSoundPolicy);
    request=withAssemblySoundFunctionContext(request);
    if (config.material_strategy === 'independent_music_packs') {
      editorSourceMeasurements = await measureEditorSourceWindows({ music: values.candidates.music,
        sounds: values.candidates.sounds ?? [], outputDir: path.join(out, 'editor-source-measurements') });
      request.data.editor_source_measurements = compactEditorSourceMeasurements(editorSourceMeasurements);
      let originalContext={status:'not_measured',reason:manifest.original_audio?'shared_episode_budget_not_available':'prepared_original_audio_not_available',
        actual_audio_hearing:false,qualification_granted:false};
      if(manifest.original_audio&&typeof runtime.trialBudget?.inspectLocal==='function'){
        // prepareEpisode normalizes original.wav onto this manifest's zero
        // clock. Bind exactly the same prepared original used by rendering,
        // never measure raw video PTS as though it were the target clock.
        const originalPath=path.resolve(path.dirname(inputs.manifest.path),manifest.original_audio);
        const originalSource={path:originalPath,sha256:await hashFile(originalPath)};
        const selectedEvents=new Set((values.candidates.sounds??[]).map(row=>row.event_id));
        const points=values.analysis.sound_events.filter(event=>selectedEvents.has(event.id))
          .map(event=>({event_id:event.id,target_anchor_seconds:event.start_seconds}));
        editorOriginalMixMeasurements=await measureEditorOriginalMixWindows({source:originalSource,parentSource:source,
          music:values.director.cues.map(cue=>({cue_id:cue.cue_id,target_range:cue.target_range})),sounds:points,
          durationSeconds:manifest.timeline.duration_samples/48000,
          sourceClock:{sample_rate:manifest.timeline.sample_rate,target_offset_seconds:0},
          outputDir:path.join(out,'editor-original-mix-measurements'),trialBudget:runtime.trialBudget});
        originalContext={...compactEditorOriginalMixMeasurements(editorOriginalMixMeasurements),
          prepared_original_manifest:inputs.manifest,
          point_probe_clock:'Existing analysis event start; coarse/unverified until the actual adopted edit anchor is validated. Not the recording asset anchor.',
          derivation_scope:'The prepared original.wav is the same zero-clock input used by rendering; level measurement does not independently certify extraction or sound identity.'};
      }
      request.data.editor_original_mix_measurements=originalContext;
      const full = await saveStable(path.join(out, 'assembly-input-full.json'), request);
      const candidate = projectResearchAssemblyCandidate;
      request.frames = [];
      request.data = { source_video_sha256: source.sha256, full_input: full, bound_artifacts: inputs,
        ...(config.assembly_decision_contract_revision?{assembly_decision_contract_revision:config.assembly_decision_contract_revision}:{}),
        ...(config.assembly_sfx_pool_contract_revision?{assembly_sfx_pool_contract_revision:config.assembly_sfx_pool_contract_revision}:{}),
        ...(config.assembly_source_capacity_revision?{assembly_source_capacity_revision:config.assembly_source_capacity_revision}:{}),
        ...(request.data.diagnostic_sound_adoption_policy?{diagnostic_sound_adoption_policy:request.data.diagnostic_sound_adoption_policy}:{}),
        ...(request.data.sfx_event_function_revision?{sfx_event_function_revision:request.data.sfx_event_function_revision}:{}),
        ...(config.bounded_assembly_projection_revision?{bounded_assembly_projection_revision:config.bounded_assembly_projection_revision}:{}),
        ...(config.bounded_assembly_part_scope_revision!==undefined?{bounded_part_scope_revision:config.bounded_assembly_part_scope_revision}:{}),
        ...(config.sound_edit_decision_contract_revision!==undefined?{sound_edit_decision_contract_revision:config.sound_edit_decision_contract_revision}:{}),
        timeline: manifest.timeline, analysis: values.analysis, director: values.director,
        candidates: { music: values.candidates.music.map(candidate), words: (values.candidates.words ?? []).map(candidate),
          sounds: (values.candidates.sounds ?? []).map(candidate) },
        measured_source_levels: values.candidates.music.map(row=>({segment_id:row.segment_id,source_range:row.source_range,
          rms_dbfs:row.technical_rms_dbfs??null,change_db:row.technical_energy_change_db??null,
          direction:row.technical_energy_direction??'unknown',
          scope:'whole_supplied_source_window_actual_pcm_measurement; not exact edited subrange or hearing approval'})),
        editor_source_measurements: compactEditorSourceMeasurements(editorSourceMeasurements),
        editor_original_mix_measurements: originalContext,
        sound_event_guidance: values.candidates.sound_event_guidance ?? [],
        diagnostic_sample: request.data.diagnostic_sample,
        material_observations: materialObservations.map((row,index) => ({ segment_id: row.segment_id,
          source_sha256: row.source_sha256, source_range: row.source_range, observation_record: row.observation_record,
          observation: inlineMaterialObservations[index],
          sound_facts_qualified: false })),
        projection_scope: 'same_complete_story_and_chosen_windows_without_duplicate_materials_or_metadata',
        actual_audio_hearing_approved: false };
      request.prompt += ' Use measured_source_levels as technical gain context: applying the same negative gain to every already quiet recording can make music unintentionally inaudible. Preserve local dialogue ducking, headroom and intentional dynamic differences; leave actual mix listening pending.';
      request.prompt += ' This is short-drama scoring: preserve audible emotional continuity and respond to changes of control, relationship and unresolved danger. '
        + 'Read exact editor_source_measurements before choosing each source start and gain. A candidate window is search coverage, not an instruction to begin at its first sample. '
        + 'Select an interior development passage when its measured level route better supports the ordered story, while preserving supplied source bounds and full target duration. '
        + 'Do not fabricate musical phrase boundaries or orchestration from energy. Give genuine source_development claims the exact adopted source interval and keep hearing pending when only measurements support them. '
        + 'Do not respond to every observation window by changing songs; use continuous same-source development where suitable and actual source_continuation without repeated fades. '
        + 'Use different gains for differently mastered sources and foreground accents versus sustained beds. An unverified dramatic effect is not a reason to make all additions inaudible. '
        + 'For a supplied dramatic accent choose its intended emphasis and sufficient gain using the actual sound peak/RMS, while retaining its exact already measured anchor; a bass bed alone does not fulfill a transient emphasis task. '
        + 'When editor_original_mix_measurements is measured, compare its actual original-mix RMS/peak with each adopted asset and intended foreground/bed role before choosing gain. Original-mix measurements do not separate dialogue or prove an exact event attack. The 100ms point probe uses the existing coarse analysis event start; do not silently treat that as an approved physical synchronization or copy the asset source anchor to target time. If context is not measured retain that limit. '
        + 'Never turn source-local energy, a gain change or a technical peak into approval of musical meaning, lyric boundaries or scene fit. Preserve those unresolved judgments in review_pending.';
    }
    if(scopedGapContext)request=withAssemblyGapContract(request,config,scopedGapContext);
    requestBinding = await saveStable(path.join(out, 'assembly-input.json'), request);
    }
    const validateFinal = value => {
        // The model decides adoption; this only gives the original full validator
        // its exact chosen pool. Final sound-adoption evidence is still checked below.
        const sounds = (values.candidates.sounds ?? []).filter(candidate => value.edits.sounds.some(edit =>
          edit.decision === 'new_asset' && edit.event_id === candidate.event_id
          && edit.selected_segment_id === candidate.segment_id));
        const scope = config.trial_scope ?? { kind: 'music_with_optional_sounds_episode',
          target_range: [0, manifest.timeline.duration_samples / 48000], excluded_sound_event_ids: [],
          reason: 'Current episode research music and optional sounds; source and independent listening pending.' };
        return validateResearchEpisodeAssembly({ ...values, candidates: { ...values.candidates, sounds },
          arc_plan: value.plan, edits: value.edits, trial_scope: scope },
        { musicActionContractVersion: config.music_action_contract_version ?? 1,
          assemblySfxPoolContractRevision:config.assembly_sfx_pool_contract_revision??null });
      };
    // Oversized independent diagnostic work may divide music editing and sound
    // adoption. This consumes the already bound choices, never new retrieval,
    // and preflights all real child envelopes before starting either model.
    let roleSplit;
    try { roleSplit = !gapClassificationRecovery && config.material_strategy === 'independent_music_packs'
      && config.automatic_trial === true && config.trial_review_policy === 'diagnostic_candidates'
      && ['diagnostic_only','composite_research'].includes(config.quality_review_policy) && config.music_action_contract_version === 2
      ? await executeRoleSplitResearchAssembly({request,requestBinding,session,
        directory:path.join(out,'role-split-assembly'),validateFinal}) : null;
    } catch(error) {
      if(error.message!=='role_split_assembly_capacity_gap')throw error;
      const capacity=await saveStable(path.join(out,'assembly-capacity-gap.json'),{
        status:'role_split_assembly_capacity_gap',request:requestBinding,capacity_report:error.capacity_report??null,
        new_model_calls:0,production_approval:false});
      const record={status:'research_assembly_execution_gap',inputs,stage:{request:requestBinding,capacity_gap:capacity,new_model_calls:0},
        execution_gaps:['role_split_assembly_capacity_gap'],review_pending:[],production_approval:false};
      await saveStable(path.join(out,'assembly-record.json'),record);return record;
    }
    // Legacy bounded/mother merges do not preserve object-scoped gap records.
    // Refuse this unsupported opt-in combination before the first child call;
    // preserve legacy requests and the supported complete/role-split paths.
    if(scopedGapContext&&!roleSplit&&typeof session.inputBudget==='function'){
      const inputBudget=session.inputBudget(assemblySessionEnvelope(request,session));
      const submitted=inputBudget.submitted_input_tokens??inputBudget.estimated_tokens;
      const maximum=session.maxSubmittedInputTokens??16000;
      if(submitted>maximum){
        const gap={kind:'execution_blocker',object_kind:'episode',object_id:manifest.source_sha256,
          evidence_ids:[requestBinding.sha256],reason_code:'typed_gap_bounded_projection_unsupported',
          next_action:'Prepare a supported complete or role-split envelope within the input budget; preserve the typed-gap contract and all existing evidence.'};
        const binding=await saveStable(path.join(out,'assembly-projection-preflight.json'),{
          status:'unsupported_typed_gap_bounded_projection',request:requestBinding,input_budget:inputBudget,
          max_input_tokens:maximum,execution_blockers:[gap],new_model_calls:0,production_approval:false});
        const record={status:'research_assembly_execution_gap',inputs,
          stage:{request:requestBinding,projection_preflight:binding,new_model_calls:0},
          execution_gaps:[gap.reason_code],gap_records:[gap],review_pending:[],production_approval:false};
        await saveStable(path.join(out,'assembly-record.json'),record);return record;
      }
    }
    const bounded = roleSplit ?? await executeBoundedResearchAssembly({ request, requestBinding, session,
      ...(gapClassificationRecovery?{gapClassificationRecovery}:{}),
      directory:path.join(out,'bounded-assembly'),validateFinal });
    const response = bounded ?? (typeof session.director === 'function'
      ? await session.director(request) : await session.request(request.stage, request));
    const raw = (await readBound(response.raw_response)).value;
    let recorded = raw.value;
    if (recorded === undefined && raw.id && raw.status === 'completed') {
      const outputs = raw.output?.flatMap(item => item.content ?? [])
        ?? raw.steps?.filter(item => item.type === 'model_output').flatMap(item => item.content ?? []) ?? raw.outputs;
      const responseText = outputs?.filter(item => ['text', 'output_text'].includes(item.type)).map(item => item.text).join('');
      if (responseText) recorded = JSON.parse(responseText);
    }
    if (!same(recorded, response.value) || raw.source_video_sha256 && raw.source_video_sha256 !== manifest.source_sha256)
      throw new Error('research_assembly_response_identity_required');
    validateSchema(response.value, request.schema);
    diagnosticSample = validateDiagnosticSample(response.value, manifest.timeline.duration_samples / 48000, config);
    stage = { request: requestBinding, raw_response: response.raw_response,
      execution_kind: response.execution_kind ?? 'supplied_session_structured_response',
      ...(editorSourceMeasurements ? { editor_source_measurements: editorSourceMeasurements.binding,
        source_measurement_reused: editorSourceMeasurements.reused } : {}),
      ...(editorOriginalMixMeasurements ? { editor_original_mix_measurements: editorOriginalMixMeasurements.binding,
        original_mix_measurement_reused: editorOriginalMixMeasurements.reused } : {}),
      ...(response.bounded_assembly ? { bounded_assembly: response.bounded_assembly } : {}),
      ...(response.role_split_assembly ? { role_split_assembly: response.role_split_assembly } : {}),
      ledger: session.accountingLedger ?? session.ledger ?? null, independent_audio_hearing_approved: false };
    if(raw.gap_classification_recovery)stage.gap_classification_recovery=raw.gap_classification_recovery;
    if(scopedGapContext){
      scopedGapAudit=auditAssemblyGapDisposition(response.value,scopedGapContext);
      const materialAudit=preflightAssemblyMaterials(values,{edits:response.value.edits});
      scopedGapAudit.execution_blockers.push(...materialAudit.execution_blockers);
      if(!scopedGapAudit.execution_blockers.length&&scopedGapAudit.technical_validation_required)
        scopedGapAudit.technical_verification=auditResearchAssemblyTechnicalOperands(values,response.value,
          {manifestPath:inputs.manifest.path,musicActionContractVersion:config.music_action_contract_version??1,
            assemblySfxPoolContractRevision:config.assembly_sfx_pool_contract_revision??null});
      stage.object_scoped_gap_audit=await saveStable(path.join(out,'object-scoped-gap-audit.json'),scopedGapAudit);
    }
    if (scopedGapAudit?scopedGapAudit.execution_blockers.length:response.value.execution_gaps.length) {
      const record = { status: 'research_assembly_execution_gap', inputs, stage,
        execution_gaps: response.value.execution_gaps,
        ...(scopedGapAudit?{gap_records:scopedGapAudit.execution_blockers}:{}),
        review_pending: response.value.review_pending, production_approval: false };
      await saveStable(path.join(out, 'assembly-record.json'), record); return record;
    }
    values.arc_plan = response.value.plan; values.edits = response.value.edits;
    inputs.arc_plan = await saveStable(path.join(out, 'arc-plan.json'), values.arc_plan);
    inputs.edits = await saveStable(path.join(out, 'edits.json'), values.edits);
    review = response.value.review_pending.map(item => ({ text: item, actual_assembly_response: response.raw_response }));
    if(scopedGapAudit)review.push(...[...scopedGapAudit.exploration_records,...scopedGapAudit.post_render_checks,...scopedGapAudit.qualification_gaps]
      .map(item=>({...item,actual_assembly_response:response.raw_response,object_scoped_gap_audit:stage.object_scoped_gap_audit})));
  }
  return finalizeResearchAssembly({config,runtime,source,manifest,inputs,values,stage,review,
    diagnosticSample,constraintDirectorBinding,out});
}

// The first assembly and a real scoped repair share adoption, validators and the
// renderer handoff. Callers cannot substitute a render configuration for these gates.
export async function finalizeResearchAssembly({config,runtime={},source,manifest,inputs,values,stage,review=[],
  diagnosticSample=null,constraintDirectorBinding=null,out}) {
  const combinedSfx=assemblySfxAdoptionEnabled(config);
  let soundAdoption=null,soundAdoptionBinding=null;
  if(combinedSfx){
    soundAdoption=await finalizeAssemblySfxAdoption({config,source,analysis:values.analysis,direction:values.director,
      manifest:values.manifest,candidates:values.candidates,currentMaterials:values.current_materials,
      originalInputs:{...inputs},edits:values.edits,stage,outputDir:path.join(out,'final-sound-adoption')});
    inputs.candidates=await saveStable(path.join(out,'assembly-adopted-candidates.json'),soundAdoption.candidates);
    values.candidates=soundAdoption.candidates;
    soundAdoption.record.candidates=inputs.candidates;
    soundAdoptionBinding=await saveStable(path.join(out,'final-sound-adoption-record.json'),soundAdoption.record);
  }
  if (constraintDirectorBinding) inputs.director = constraintDirectorBinding;
  const duration = manifest.timeline.duration_samples / 48000;
  const scope = config.trial_scope ?? { kind: 'music_with_optional_sounds_episode', target_range: [0, duration],
    excluded_sound_event_ids: [], reason: 'Current episode research music and optional sounds; source and independent listening pending.' };
  const caveatBinding = runtime.editingCaveatReviews?.[manifest.source_sha256];
  const editingCaveatReview = caveatBinding && values.edits.uncertainties.length
    ? await loadDiagnosticEditingCaveats(caveatBinding, { sourceSha: manifest.source_sha256,
      editsBinding: inputs.edits, edits: values.edits, config }) : null;
  const decisions = validateResearchEpisodeAssembly({ ...values, trial_scope: scope }, { editingCaveatReview,
    musicActionContractVersion: config.music_action_contract_version ?? 1,
    assemblySfxPoolContractRevision:config.assembly_sfx_pool_contract_revision??null });
  const frozen = { schema_version: 1, mode: 'research', strategy: 'current_director_research', ...inputs,
    craft_mode: config.craft_mode, audience: config.audience, execution: config.execution ?? 'host',
    output_dir: path.resolve(config.render_output_dir ?? path.join(out, 'render')), trial_scope: scope,
    research_review_pending: [...(config.research_review_pending ?? []), ...review] };
  if(soundAdoptionBinding)frozen.sfx_adoption_record=soundAdoptionBinding;
  if(stage?.host_sound_omission_recovery)frozen.assembly_host_sound_omission_recovery=stage.host_sound_omission_recovery;
  if(stage?.sound_decision_recovery)frozen.assembly_sound_decision_recovery=stage.sound_decision_recovery;
  if(stage?.gap_classification_recovery)frozen.assembly_gap_classification_response=stage.raw_response;
  if (editingCaveatReview) {
    frozen.diagnostic_editing_caveat_review = caveatBinding;
    frozen.research_review_pending.push(...values.edits.uncertainties.map(text => ({ text, caveat_review: caveatBinding })));
  }
  if (diagnosticSample) frozen.diagnostic_sample_selection = diagnosticSample;
  for (const key of ['python', 'preview', 'preview_master_gain_db', 'original_gain_db', 'dialogue_intervals',
    'automatic_trial', 'material_strategy', 'music_packs', 'source_policy', 'trial_review_policy', 'assembly_contract_version',
    'sfx_adoption_mode', 'assembly_sfx_pool_contract_revision', 'editor_strategy', 'music_action_contract_version', 'sound_edit_decision_contract_revision', 'final_mix_master','render_decode_cache',
    'assembly_gap_contract_revision','assembly_source_capacity_revision',
    'sfx_library', 'ambient_library', 'original_sound_reviews',
    'research_trial_authorization', 'diagnostic_sample',
    'music_source_scope', 'cross_film_reuse_check', 'allow_nominal_event_anchors', 'research_execution_gaps',
    'external_arc_connections', 'research_action_partition_record', 'arc_identity_mapping', 'music_profile', 'work_id', 'work_identity_evidence'])
    if (config[key] !== undefined) frozen[key] = config[key];
  await verifyEvidenceBindings(inputs);
  const renderConfig = await saveStable(path.join(out, 'render-config.json'), frozen);
  const record = { schema_version: 1, status: 'research_episode_config_frozen', inputs, render_config: renderConfig, stage,
    decisions, automation_scope: 'bound_whole_story_and_selected_materials_to_frozen_research_config_and_existing_renderer',
    source_identity_and_music_budget: 'not_run_render_gates_pending', independent_audio_hearing: 'not_performed_by_assembler',
    production_approval: false, listener_qualified: false };
  if(soundAdoption)record.sound_adoption=soundAdoption.record;
  await saveStable(path.join(out, 'assembly-record.json'), record);
  if (config.render !== false) {
    record.render = await (runtime.renderResearchTrial ?? renderResearchTrial)(frozen, runtime);
    record.status = record.render.status; record.preview = record.render.preview;
    record.source_identity_and_music_budget = record.render.music_source_budget ?? 'existing_renderer_did_not_report_budget';
    await saveStable(path.join(out, 'render-execution-record.json'), record);
  }
  await verifyEvidenceBindings(inputs); await verifyEvidenceBindings(renderConfig);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) { console.error('Usage: node assemble_research_episode.mjs CONFIG.json'); process.exitCode = 1; }
  else assembleResearchEpisode(await readJson(file)).then(record => console.log(JSON.stringify({ status: record.status,
    render_config: record.render_config, preview: record.preview ?? null, production_approval: false })))
    .catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
