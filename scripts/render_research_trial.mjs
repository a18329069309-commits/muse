import { projectTrialPreflight } from './project_trial_gate.mjs';
import {verifyAssemblySfxAdoptionForRender,verifyAssemblySfxRecordForRender} from './assembly_sfx_adoption.mjs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings, validateSchema, verifyLocalAudioExecution } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { verifyHostSoundOmissionRecoveryForRender } from './assembly_host_sound_omissions.mjs';
import { verifyBoundSoundDecisionRecoveryForRender } from './bound_sound_decision_recovery.mjs';
import { compileSoundArcPlan } from './sound_arc_plan.mjs';
import { loadMusicProfile, filterMusicProfileRoutes, musicProfileDirectionGaps, filterReferenceMaterialRoutes,
  loadOfflineHumanReview } from './music_profile.mjs';
import { compileEdit, editSchemaFor } from './compose_episode.mjs';
import { auditMusicActionExecution, verifyMusicActionRenderExecution } from './music_action_execution_audit.mjs';
import { runSoundJob } from './run_sound_job.mjs';
import { runOwnedEpisodeTask } from './owned_process_runner.mjs';
import {preserveExplicitPointSoundPlacement} from './sfx_audibility_repair.mjs';
import { assertAssistedSoundEdits, assertSoundPackageMember } from './assisted_episode.mjs';
import { HostFileSession } from './host_runtime.mjs';
import { enforceEpisodeMusicSourceBudget } from './music_source_delivery_gate.mjs';
import { verifyResearchAudioEvidence } from './research_audio_evidence.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { verifyIndependentWindowRoute } from './independent_route_identity.mjs';
import { verifyDiagnosticSfxAnchor } from './diagnostic_sfx_anchor.mjs';
import { loadOriginalSoundEventReview } from './original_sound_event_review.mjs';
import { exportDiagnosticSample } from './diagnostic_sample.mjs';
import { loadDiagnosticEditingCaveats, allowsDiagnosticEditingCaveats } from './diagnostic_editing_caveats.mjs';
import {observedAssemblySfxPoolEnabled,verifyObservedAssemblySfxCandidate} from './assembly_sfx_candidate_pool.mjs';
import {isObservedAssemblySoundCandidate,validatePreparedSoundFunction} from './sfx_event_function.mjs';
import {applyObservedAssemblySoundSchema} from './assembly_consumer_projection.mjs';

const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const contains = (outer, inner) => range(outer) && range(inner) && outer[0] <= inner[0] && outer[1] >= inner[1];

// This is an audition scope, never an upgrade of unknown source sounds or listener qualification.
export function assertResearchEpisodeScope({ config, director, analysis, edits, sounds, durationSamples }) {
  const scope = config.trial_scope;
  if (!['music_only_episode', 'music_with_optional_sounds_episode'].includes(scope?.kind)) return;
  if (config.mode !== 'research' || config.strategy !== 'current_director_research')
    throw new Error('research_trial_episode_research_scope_required');
  let cursor = 0;
  for (const cue of [...director.cues].sort((a, b) => a.target_range[0] - b.target_range[0])) {
    if (Math.round(cue.target_range[0] * 48000) !== cursor) throw new Error('research_trial_episode_scope_invalid');
    cursor = Math.round(cue.target_range[1] * 48000);
  }
  if (!Number.isSafeInteger(durationSamples) || scope.target_range[0] !== 0
    || scope.target_range[1] !== durationSamples / 48000 || cursor !== durationSamples)
    throw new Error('research_trial_episode_scope_invalid');
  if (scope.kind === 'music_only_episode') return;
  const excluded = new Set(scope.excluded_sound_event_ids ?? []), events = new Map(analysis.sound_events.map(row => [row.id, row]));
  if (excluded.size !== (scope.excluded_sound_event_ids ?? []).length
    || [...excluded].some(id => !events.has(id) || !scope.excluded_sound_event_reasons?.[id]?.trim()))
    throw new Error('research_trial_episode_sound_omission_reason_required');
  const included = analysis.sound_events.filter(row => !excluded.has(row.id));
  if (edits.sounds.length !== included.length || new Set(edits.sounds.map(row => row.event_id)).size !== included.length)
    throw new Error('research_trial_episode_sound_decisions_required');
  for (const edit of edits.sounds) {
    const event = events.get(edit.event_id);
    const supplied = sounds.find(row => row.event_id === event?.id && row.segment_id === edit.selected_segment_id);
    const reviewedAmbient = event?.role === 'ambience' && supplied?.original_sound_review
      && ['verified_missing', 'verified_insufficient'].includes(supplied.original_status)
      && edit.original_status === supplied.original_status;
    if (!event || excluded.has(event.id) || !edit.reason?.trim() || edit.original_status !== 'unknown' && !reviewedAmbient
      || !['new_asset', 'omit'].includes(edit.decision)) throw new Error('research_trial_episode_sound_decision_invalid');
    if (edit.decision === 'new_asset' && (!( ['dramatic', 'transition'].includes(event.role) || reviewedAmbient )
      || !sounds.some(row => row.event_id === event.id && row.segment_id === edit.selected_segment_id)))
      throw new Error('research_trial_episode_optional_sound_source_required');
    if (edit.decision === 'new_asset') {
      const candidate = sounds.find(row => row.event_id === event.id && row.segment_id === edit.selected_segment_id);
      if (candidate.source_anchor_seconds !== undefined
        && (!Number.isFinite(edit.source_anchor_seconds) || edit.source_anchor_seconds !== candidate.source_anchor_seconds))
        throw Error('research_trial_actual_selected_sound_anchor_required');
    }
    if (!['physical', 'foley', 'ambience', 'dramatic', 'transition'].includes(event.role))
      throw new Error('research_trial_episode_sound_role_invalid');
  }
  if (sounds.some(row => !edits.sounds.some(edit => edit.event_id === row.event_id
    && edit.selected_segment_id === row.segment_id && edit.decision === 'new_asset')))
    throw new Error('research_trial_episode_unused_sound_candidate');
}

export function assertResearchEpisodeMusicCoverage(cues, durationSamples, arcManifest = null) {
  const windows = cues.filter(row => row.track === 'bgm').map(row => [Math.round(row.start_seconds * 48000),
    Math.round((row.start_seconds + row.source_out_seconds - row.source_in_seconds) * 48000)]);
  // Only the just-compiled v2 null-source pieces can account for deliberate pauses.
  // Caller-provided gap ranges or music pieces relabeled as silence cannot satisfy coverage.
  for (const silence of arcManifest?.silence_ranges ?? []) {
    const arc = arcManifest.schema_version === 2 && arcManifest.arcs?.find(row => row.arc_id === silence.arc_id);
    const piece = arc?.pieces?.find(row => row.piece_id === silence.piece_id);
    if (!piece || piece.source_window !== null || piece.cue_id !== null
      || typeof silence.reason !== 'string' || !silence.reason.trim() || silence.reason !== piece.silence_reason
      || !contains(arc.parent_target_range, silence.target_range)
      || !range(piece.target_range) || silence.target_range.some((value, index) => value !== piece.target_range[index]))
      throw new Error('research_trial_episode_music_coverage_invalid');
    windows.push(silence.target_range.map(value => Math.round(value * 48000)));
  }
  windows.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const window of windows) {
    if (window[0] > cursor || window[0] < 0 || window[1] > durationSamples || window[1] <= window[0])
      throw new Error('research_trial_episode_music_coverage_invalid');
    cursor = Math.max(cursor, window[1]);
  }
  if (cursor !== durationSamples) throw new Error('research_trial_episode_music_coverage_invalid');
}
const readBound = async supplied => {
  const file = typeof supplied === 'string' ? supplied : supplied?.path;
  if (!file) throw new Error('research_trial_bound_input_required');
  const binding = { path: path.resolve(file), sha256: await hashFile(file) };
  if (supplied?.sha256 && supplied.sha256 !== binding.sha256) throw new Error('research_trial_input_changed');
  return { binding, value: await readJson(file) };
};

// Research observations remain unqualified. This verifies their recording/window identity, not their correctness.
async function checkCandidate(candidate, sourceSha, music, assisted = false) {
  if (!candidate.segment_id || !candidate.asset_id || !candidate.local_path || !range(candidate.source_range)
    || await hashFile(candidate.local_path) !== candidate.source_sha256)
    throw new Error('research_trial_candidate_source_changed');
  const observed = await readBound(candidate.observation_record), selected = await readBound(candidate.selection_record);
  await verifyEvidenceBindings(observed.value);
  if (assisted && (observed.value.protocol !== 'offline_human_review'
    || !candidate.human_review_record?.sha256
    || candidate.human_review_record.sha256 !== observed.value.human_review_record?.sha256))
    throw new Error('assisted_actual_human_package_evidence_required');
  if (observed.value.protocol === 'local_audio_model') await verifyLocalAudioExecution(observed.value, observed.value);
  if (observed.value.protocol === 'offline_human_review') {
    const human = await loadOfflineHumanReview(observed.value.human_review_record, {
      sourceSha: candidate.source_sha256, sourceRange: candidate.source_range, caseIds: candidate.case_ids,
      requireWords: candidate.cue_id?.endsWith('/words'),
    });
    if (observed.value.origin !== 'human' || observed.value.actual_model_audio_inference !== false
      || JSON.stringify(observed.value.observation) !== JSON.stringify(human.record.observations)
      || JSON.stringify(observed.value.words) !== JSON.stringify(human.record.words)
      || observed.value.music_form !== human.record.music_form
      || JSON.stringify(observed.value.source_range) !== JSON.stringify(human.record.source_range))
      throw new Error('research_trial_human_observation_changed');
    if (human.record.asset_kind !== (music ? 'music' : candidate.sound_role === 'ambience' ? 'ambience' : 'sfx')
      || !music && candidate.sound_role !== 'ambience' && human.record.source_anchor_seconds !== candidate.source_anchor_seconds)
      throw new Error('research_trial_human_asset_or_anchor_mismatch');
  }
  if (observed.value.actual_audio_processed !== true || observed.value.source_sha256 !== candidate.source_sha256
    || !contains(observed.value.source_range, candidate.source_range))
    throw new Error('research_trial_actual_candidate_observation_required');
  const chosenRanges = candidate.selection_source_ranges ?? [candidate.source_range];
  if (!chosenRanges.length || chosenRanges.some(window => !contains(candidate.source_range, window))
    || selected.value.source_video_sha256 !== sourceSha || !Array.isArray(selected.value.decisions)
    || !chosenRanges.every(window => selected.value.decisions.some(decision => (music ? decision.cue_id === candidate.cue_id
      : decision.event_id === candidate.event_id) && decision.selected_segment_id === candidate.segment_id
      && contains(decision.selected_source_range, window) && typeof decision.reason === 'string' && decision.reason.trim())))
    throw new Error('research_trial_current_selection_binding_required');
  return { observed, selected };
}

// Current unscored targets are diagnostic inputs, never successful reference cases.
export async function checkCurrentMaterial(candidate, materials, selected, sourceSha, music, allowHost = false, config = {}) {
  const current = materials.cases?.find(row => row.case_id === candidate.target_case_id);
  const pack = music ? materials.packs?.find(row => row.pack_id === candidate.music_pack_id)
    : materials.sound_packs?.find(row => row.sound_pack_id === candidate.sound_pack_id);
  const windows = music ? pack?.windows : pack?.members;
  if (current?.source_role !== 'current_unscored_target_not_reference_success_case'
    || current.evidence?.source_video_sha256 !== sourceSha
    || !(music ? current.music_pack_ids?.includes(pack?.pack_id) : current.sound_pack_ids?.includes(pack?.sound_pack_id))
    || !windows?.some(row => row.segment_id === candidate.segment_id && contains(row.source_range, candidate.source_range)
      && (music ? pack.asset_id === candidate.asset_id && pack.source_sha256 === candidate.source_sha256
        : row.asset_id === candidate.asset_id && row.source_sha256 === candidate.source_sha256)))
    throw new Error('research_trial_current_target_material_link_required');
  if(isObservedAssemblySoundCandidate(candidate)){
    if(music||!observedAssemblySfxPoolEnabled(config)||candidate.adoption_pending!==false)
      throw Error('research_trial_observed_sound_actual_assembly_required');
    validatePreparedSoundFunction(candidate);
    await verifyObservedAssemblySfxCandidate({candidate,poolDocument:selected.value,sourceSha});
    return;
  }
  const provenance = selected.value.selection_provenance;
  if (!provenance?.selector_record || !provenance?.raw_response || !provenance?.case_input)
    throw new Error('research_trial_actual_selector_provenance_required');
  await verifyEvidenceBindings(provenance);
  const selector = await readJson(provenance.selector_record.path), raw = await readJson(provenance.raw_response.path);
  const input = await readJson(provenance.case_input.path);
  let actualHost = false;
  if (allowHost && raw.execution_kind === 'codex_host_authored_record') {
    if (raw.actual_runtime_executed === true) throw new Error('research_trial_host_cannot_claim_cli_execution');
    const requestFile = path.join(path.dirname(provenance.raw_response.path), 'request.json');
    const requestBinding = raw.evidence_files?.find(row => path.resolve(row.path) === path.resolve(requestFile));
    if (!requestBinding) throw new Error('research_trial_paired_host_selection_required');
    await verifyEvidenceBindings(requestBinding);
    const request = await readJson(requestFile), payload = request.payload;
    if (!['material_selector', 'research_material_selection'].includes(payload?.role)
      || payload.source_video_sha256 !== sourceSha || raw.source_video_sha256 !== sourceSha
      || payload.input?.input?.sha256 !== selector.input?.sha256
      || path.resolve(payload.input.input.path) !== path.resolve(selector.input.path)
      || !payload.input_bindings?.some(row => row.sha256 === provenance.case_input.sha256
        && path.resolve(row.path) === path.resolve(provenance.case_input.path)))
      throw new Error('research_trial_host_selection_input_mismatch');
    // Re-import the actual paired record through the existing strict host contract; no model or request is submitted.
    const session = new HostFileSession({ directory: path.dirname(path.dirname(requestFile)), backend: raw.backend,
      media: payload.input_bindings });
    const response = await session.request(payload.role, payload.input);
    if (response.raw_response.sha256 !== provenance.raw_response.sha256)
      throw new Error('research_trial_host_selection_response_changed');
    actualHost = true;
  }
  if (selector.raw_response?.sha256 !== provenance.raw_response.sha256
    || selector.case_source?.sha256 !== provenance.case_input.sha256
    || raw.input_sha256 !== selector.input?.sha256 || (!actualHost && raw.actual_runtime_executed !== true)
    || raw.completion_status !== 'complete' || !raw.value?.decisions?.some(row => row.case_id === candidate.target_case_id
      && row.step_id === candidate.target_step_id && (music ? row.kind === 'music' : ['sfx', 'ambience'].includes(row.kind))
      && row.selected_segment_ids?.includes(candidate.segment_id)
      && typeof row.adopt_reason === 'string' && row.adopt_reason.trim())
    || !input.cases?.some(row => row.case_id === candidate.target_case_id
      && row.evidence?.source_video_sha256 === sourceSha))
    throw new Error('research_trial_actual_selector_current_target_required');
}

async function checkIndependentMaterial(candidate, materials, selected, sourceSha, config) {
  const publicationBinding = materials.publication ?? materials.music_packs ?? config.music_packs?.publication;
  const publication = await readBound(publicationBinding);
  const windows = publication.value.windows ?? publication.value.packs?.flatMap(pack => pack.windows.map(window => ({ ...window, pack_id: pack.pack_id }))) ?? [];
  const window = windows.find(row => row.window_id === candidate.window_id && row.pack_id === (candidate.pack_id ?? candidate.music_pack_id));
  if (materials.source_video_sha256 !== sourceSha || !window || window.asset_id !== candidate.asset_id
    || (window.source_sha256 ?? window.sha256) !== candidate.source_sha256
    || !contains(window.source_range, candidate.source_range))
    throw Error('research_trial_independent_window_binding_required');
  await verifyIndependentWindowRoute(candidate, window, { sourceSha });
  const provenance = selected.value.selection_provenance;
  if (!provenance?.selector_record || !provenance?.raw_response || !(provenance.input ?? provenance.selection_input ?? provenance.case_input))
    throw Error('research_trial_actual_independent_selector_required');
  await verifyEvidenceBindings(provenance);
  const raw = await readJson(provenance.raw_response.path), selector = await readJson(provenance.selector_record.path);
  const input = provenance.input ?? provenance.selection_input ?? provenance.case_input;
  let actualHost = false;
  if (raw.execution_kind === 'codex_host_authored_record') {
    if (raw.actual_runtime_executed === true) throw Error('research_trial_host_cannot_claim_cli_execution');
    const requestFile = path.join(path.dirname(provenance.raw_response.path), 'request.json');
    const requestBinding = raw.evidence_files?.find(row => path.resolve(row.path) === path.resolve(requestFile));
    if (!requestBinding) throw Error('research_trial_paired_host_independent_selection_required');
    await verifyEvidenceBindings(requestBinding);
    const request = await readJson(requestFile), payload = request.payload;
    if (!['material_selector', 'research_material_selection', 'independent_music_pack_material_selection'].includes(payload?.role)
      || payload.source_video_sha256 !== sourceSha || payload.input?.input?.sha256 !== input.sha256
      || path.resolve(payload.input?.input?.path ?? '') !== path.resolve(input.path)
      || !payload.input_bindings?.some(row => row.sha256 === input.sha256 && path.resolve(row.path) === path.resolve(input.path)))
      throw Error('research_trial_paired_host_independent_selection_required');
    const session = new HostFileSession({ directory: path.dirname(path.dirname(requestFile)), backend: raw.backend,
      media: payload.input_bindings });
    const response = await session.request(payload.role, payload.input);
    if (response.raw_response.sha256 !== provenance.raw_response.sha256)
      throw Error('research_trial_host_selection_response_changed');
    actualHost = true;
  }
  if ((!actualHost && raw.actual_runtime_executed !== true) || raw.completion_status !== 'complete'
    || raw.source_video_sha256 !== sourceSha || raw.input_sha256 !== input.sha256
    || selector.raw_response?.sha256 !== provenance.raw_response.sha256
    || !raw.value?.decisions?.some(row => row.cue_id === candidate.cue_id
      && (row.route_kind ?? 'preset') === (candidate.route_kind ?? 'preset')
      && row.preset_id === candidate.preset_id
      && row.selected_segment_ids?.includes(candidate.segment_id) && (row.adopt_reason ?? row.reason)?.trim()))
    throw Error('research_trial_independent_selection_identity_mismatch');
  if (candidate.case_ids?.length || candidate.target_case_id) throw Error('research_trial_independent_cannot_fabricate_case');
}

export async function renderResearchTrial(config, runtime = {}) {
  if (runtime.trialBudget?.identity?.wall_clock_policy && !runtime.runSoundJob)
    return runOwnedEpisodeTask('render_research_trial', [config], { outputDirectory: path.resolve(config.output_dir),
      trialBudget: runtime.trialBudget, python: config.python ?? process.env.SDR_PYTHON });
  return processResearchTrial(config, runtime, false);
}

export async function prepareResearchTrial(config, runtime = {}) {
  if (config?.mode !== 'assisted_trial') throw new Error('reviewed_material_preparation_requires_assisted_mode');
  return processResearchTrial(config, runtime, true);
}

async function processResearchTrial(config, runtime, preparationOnly) {
  const independent = isIndependentMusicPackTrial(config);
  if (independent) await validateIndependentMusicPackPolicy(config, { outputDirectory: config.output_dir, operation: 'render_research_trial' });
  const projectGate = await projectTrialPreflight(config, { operation: preparationOnly ? 'target_material_preparation' : 'render_research_trial' });
  if (projectGate) return projectGate;

  if (config?.schema_version !== 1 || !['fine', 'fast'].includes(config.craft_mode)
    || !['auto', 'male', 'female'].includes(config.audience) || !config.output_dir
    || (config.original_gain_db !== undefined && (!Number.isFinite(config.original_gain_db)
      || config.original_gain_db < -12 || config.original_gain_db > 0))
    || (config.preview_master_gain_db !== undefined && (!Number.isFinite(config.preview_master_gain_db)
      || config.preview_master_gain_db < -12 || config.preview_master_gain_db > 0)))
    throw new Error('research_trial_config_invalid');
  const previewMaster = config.preview_master_gain_db !== undefined;
  if (previewMaster && (config.mode !== 'research' || config.strategy !== 'current_director_research'
    || !['music_only_episode', 'music_with_optional_sounds_episode'].includes(config.trial_scope?.kind))) throw new Error('research_trial_preview_master_scope_required');
  const out = path.resolve(config.output_dir);
  try { if ((await readdir(out)).length) throw new Error('output_directory_must_be_empty'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(out, { recursive: true });
  const started = performance.now(), record = { schema_version: 1, status: 'running', purpose: 'technical_diagnostic',
    formal_adoption_allowed: false, listener_qualified: false, production_approval: false,
    artistic_acceptance: 'awaiting_user_audition', actual_listening_review: 'not_performed', inputs: {}, unresolved: [] };
  if (config.research_review_pending?.length) {
    await verifyEvidenceBindings(config.research_review_pending);
    record.research_review_pending = config.research_review_pending;
    record.unresolved.push('actual_editor_review_pending_not_resolved_by_diagnostic_render');
  }
  if (config.research_execution_gaps?.length) {
    if (config.allow_nominal_event_anchors !== true
      || !['music_only_window', 'music_with_optional_sounds_window', 'music_with_optional_sounds_episode'].includes(config.trial_scope?.kind))
      throw new Error('research_trial_nominal_alignment_scope_required');
    await verifyEvidenceBindings(config.research_execution_gaps);
    record.nominal_alignment_gaps = config.research_execution_gaps;
    record.actual_event_alignment = 'unverified_nominal_director_timestamps_only';
    record.unresolved.push('original_execution_gaps_retained_nominal_music_diagnostic_only');
  }
  try {
    const strategy = config.strategy ?? 'case_presets';
    if (!['case_presets', 'current_director_research'].includes(strategy)) throw new Error('research_trial_strategy_invalid');
    record.strategy = strategy;
    const episodeMusicTrial = ['music_only_episode', 'music_with_optional_sounds_episode'].includes(config.trial_scope?.kind);
    if (episodeMusicTrial && (config.mode !== 'research' || strategy !== 'current_director_research'))
      throw new Error('research_trial_episode_research_scope_required');
    record.cross_film_reuse_check = config.cross_film_reuse_check ?? {
      status: 'not_performed_no_recent_delivery_evidence', artistic_reuse_approval: false };
    await verifyEvidenceBindings(record.cross_film_reuse_check);
    const values = {};
    for (const key of ['manifest', 'analysis', 'director', 'arc_plan', 'candidates', 'edits', 'evidence_catalog', 'case_routes']) {
      const bound = await readBound(config[key]); record.inputs[key] = bound.binding; values[key] = bound.value;
    }
    const { manifest, analysis, director, arc_plan: arcPlan, candidates, edits, evidence_catalog: catalog } = values;
    let cases = values.case_routes;
    if (config.music_profile) {
      const profile = await loadMusicProfile(config.music_profile, { sourceSha: manifest.source_sha256,
        workId: config.work_id, strategy });
      record.music_profile = profile;
      if (!profile.ready) return Object.assign(record, { status: profile.status,
        next_action: profile.next_action ?? 'resolve_bound_reference_package', fallback_performed: false });
      const directionGaps = musicProfileDirectionGaps(director, profile.profile);
      const filtered = filterMusicProfileRoutes(cases, director, profile.profile);
      if (directionGaps.length || !filtered.ready) return Object.assign(record, { status: 'music_profile_gap',
        music_profile_gaps: [...directionGaps, ...filtered.gaps], fallback_performed: false });
      cases = filtered.caseRoutes;
      record.profile_case_routes = await saveJson(path.join(out, 'profile-case-routes.json'), cases);
    }
    if (strategy === 'case_presets') {
      const originals = await filterReferenceMaterialRoutes(cases, director, config.cases?.material_policy);
      record.reference_originals = { status: originals.status, gaps: originals.gaps, formal_adoption_allowed: false };
      if (!originals.ready) return Object.assign(record, { status: originals.status,
        next_action: 'identify_and_bind_actual_reference_recordings', fallback_performed: false });
      cases = originals.caseRoutes;
      record.original_case_routes = await saveJson(path.join(out, 'original-case-routes.json'), cases);
    }
    if (config.arc_identity_mapping?.length) record.arc_identity_mapping = config.arc_identity_mapping;
    if (config.external_arc_connections?.length) {
      await verifyEvidenceBindings(config.external_arc_connections);
      record.external_arc_connections = config.external_arc_connections;
      record.unresolved.push('actual_external_arc_connection_listening_pending');
    }
    if (config.research_action_partition_record) {
      await verifyEvidenceBindings(config.research_action_partition_record);
      record.research_action_partition_record = config.research_action_partition_record;
    }
    let currentMaterials;
    if (strategy === 'current_director_research') {
      const bound = await readBound(config.current_materials); record.inputs.current_materials = bound.binding;
      currentMaterials = bound.value; record.unresolved.push(independent ? 'independent_candidates_await_actual_audition'
        : 'successful_reference_music_pack_not_established_for_current_target');
    }
    const duration = manifest.timeline?.duration_samples / 48000, base = path.dirname(record.inputs.manifest.path);
    if (manifest.schema_version !== 1 || manifest.analysis_window || manifest.timeline.sample_rate !== 48000
      || !Number.isSafeInteger(manifest.timeline.duration_samples) || !(duration > 0))
      throw new Error('research_trial_full_episode_manifest_required');
    const video = path.resolve(base, manifest.source_video);
    if (await hashFile(video) !== manifest.source_sha256 || director.source_video_sha256 !== manifest.source_sha256
      || analysis.source_video_sha256 !== manifest.source_sha256 || cases.source_video_sha256 !== manifest.source_sha256
      || catalog.source_video_sha256 !== manifest.source_sha256)
      throw new Error('research_trial_current_video_binding_required');
    record.source_video_sha256 = manifest.source_sha256; record.duration_samples = manifest.timeline.duration_samples;
    const music = candidates.music ?? [], sounds = candidates.sounds ?? [], words = candidates.words ?? [];
    await verifyHostSoundOmissionRecoveryForRender({config,sourceSha:manifest.source_sha256,edits});
    await verifyBoundSoundDecisionRecoveryForRender({config,sourceSha:manifest.source_sha256,edits});
    let gapResponse=config.assembly_gap_classification_response;
    if(config.sfx_adoption_record){
      const adopted=(await readBound(config.sfx_adoption_record)).value;
      const finalRaw=(await readBound(adopted.raw_response)).value;
      if(finalRaw.gap_classification_recovery&&(!gapResponse||gapResponse.sha256!==adopted.raw_response.sha256))
        throw Error('research_trial_gap_classification_response_binding_required');
    }
    if(gapResponse){
      const {verifyBoundAssemblyGapClassificationMerge}=await import('./bounded_assembly_gap_classification.mjs');
      record.gap_classification_execution=await verifyBoundAssemblyGapClassificationMerge(gapResponse,
        {sourceSha:manifest.source_sha256,edits});
      if(!record.gap_classification_execution)throw Error('research_trial_typed_gap_classification_merge_required');
    }
    await verifyAssemblySfxRecordForRender({config,sourceSha:manifest.source_sha256,edits,candidates});
    const observationBindings = [];
    for (const candidate of [...music, ...words, ...sounds]) {
      if (config.mode === 'assisted_trial' && sounds.includes(candidate)) {
        const event = analysis.sound_events.find(row => row.id === candidate.event_id);
        if (!event) throw new Error('research_trial_unknown_current_sound_event');
        assertSoundPackageMember(candidate, event, cases);
      }
      const proof = await checkCandidate(candidate, manifest.source_sha256, !sounds.includes(candidate), config.mode === 'assisted_trial');
      if(sounds.includes(candidate))await verifyAssemblySfxAdoptionForRender({config,sourceSha:manifest.source_sha256,
        candidate,selection:proof.selected.value,edit:edits.sounds.find(row=>row.event_id===candidate.event_id),allSoundEdits:edits.sounds});
      if (candidate.anchor_review_status === 'measured_diagnostic_pending_audition') {
        if (!independent || !sounds.includes(candidate)) throw Error('diagnostic_sfx_explicit_independent_trial_required');
        await verifyDiagnosticSfxAnchor(candidate);
      }
      if (sounds.includes(candidate) && candidate.sound_role === 'ambience') {
        const event = analysis.sound_events.find(row => row.id === candidate.event_id);
        const original = { path: path.resolve(base, manifest.original_audio),
          sha256: await hashFile(path.resolve(base, manifest.original_audio)) };
        const reviewed = await loadOriginalSoundEventReview(candidate.original_sound_review, {
          source: { path: video, sha256: manifest.source_sha256 }, original, manifest: record.inputs.manifest, event });
        if (reviewed.record.original_status !== candidate.original_status
          || !config.original_sound_reviews?.some(row => row.sha256 === candidate.original_sound_review.sha256
            && path.resolve(row.path) === path.resolve(candidate.original_sound_review.path)))
          throw Error('research_trial_exact_original_ambient_review_required');
      }
      if (independent && !sounds.includes(candidate)) await checkIndependentMaterial(candidate, currentMaterials, proof.selected, manifest.source_sha256, config);
      else if (currentMaterials) await checkCurrentMaterial(candidate, currentMaterials, proof.selected, manifest.source_sha256,
        !sounds.includes(candidate), config.mode === 'research' && strategy === 'current_director_research',config);
      observationBindings.push(proof.observed.binding, proof.selected.binding);
    }
    const compiledArcs = compileSoundArcPlan({ plan: arcPlan, director, candidates: music, wordsCandidates: candidates.words });
    record.arc_manifest = await saveJson(path.join(out, 'sound-arcs.json'), compiledArcs.arcManifest);
    record.unresolved.push(...compiledArcs.pending.map(item => item.reason));
    const tasks = { cues: compiledArcs.splitCues }, routes = { cues: [] };
    for (const task of [...tasks.cues]) {
      const piece = compiledArcs.arcManifest.arcs.flatMap(arc => arc.pieces).find(item => item.cue_id === task.cue_id);
      const matching = music.filter(row => row.cue_id === task.arc_parent_cue_id && row.segment_id === piece.source_window.segment_id
        && row.asset_id === piece.source_window.asset_id
        && (compiledArcs.arcManifest.schema_version !== 2
          || JSON.stringify(row.source_range) === JSON.stringify(piece.source_window.candidate_source_range))
        && row.source_sha256 === piece.source_window.source_sha256 && contains(row.source_range, piece.source_window.source_range)
        && (!row.allowed_target_range || contains(row.allowed_target_range, piece.target_range)));
      if (matching.length !== 1) throw new Error('research_trial_unique_music_source_window_required');
      const candidate = matching[0];
      const route = cases.routes?.find(row => row.route_id === candidate?.case_route_id && row.cue_id === task.arc_parent_cue_id);
      if (independent) {
        if (!route || (route.material_strategy ?? route.strategy) !== 'independent_music_packs' || route.pack_id !== candidate.pack_id
          || (route.route_kind ?? 'preset') !== (candidate.route_kind ?? 'preset') || route.preset_id !== candidate.preset_id
          || !route.source_candidates?.some(row => row.window_id === candidate.window_id && row.segment_id === candidate.segment_id
            && row.source_sha256 === candidate.source_sha256 && contains(row.source_range, piece.source_window.source_range)))
          throw Error('research_trial_independent_route_material_link_required');
      } else if (!candidate || !route || (strategy === 'case_presets' && !candidate.case_ids?.length) || !candidate.music_pack_id
        || !((candidate.selection_source_ranges ?? [candidate.source_range]).some(window => contains(window, piece.source_window.source_range)))
        || (strategy === 'current_director_research' && (route.strategy !== strategy || route.target_case_id !== candidate.target_case_id))
        || !(candidate.case_ids ?? []).every(id => route.case_ids?.includes(id)) || route.music_pack_id !== candidate.music_pack_id
        || !route.source_candidates?.some(row => row.cue_id === task.arc_parent_cue_id
          && row.segment_id === candidate.segment_id && row.asset_id === candidate.asset_id
          && row.source_sha256 === candidate.source_sha256
          && contains(row.case_source_range ?? row.source_range, piece.source_window.source_range)))
        throw new Error('research_trial_case_material_link_required');
      routes.cues.push({ cue_id: task.cue_id, status: 'research_selected', selected: { ...candidate,
        source_range: piece.source_window.source_range } });
      if (task.words_target_range) {
        const word = words.find(row => row.parent_cue_id === task.arc_parent_cue_id);
        if (!word || Math.abs(word.source_range[1] - word.source_range[0]
          - (task.words_target_range[1] - task.words_target_range[0])) > 1 / 48000)
          throw new Error('research_trial_complete_words_source_required');
        if (strategy === 'case_presets') {
          const wordRoute = cases.routes.find(row => row.cue_id === `${task.arc_parent_cue_id}/words`
            && row.route_id === word.case_route_id);
          if (!wordRoute || wordRoute.music_pack_id !== word.music_pack_id || !word.case_ids?.length
            || !word.case_ids.every(id => wordRoute.case_ids?.includes(id))
            || !wordRoute.source_candidates?.some(row => row.segment_id === word.segment_id
              && row.asset_id === word.asset_id && row.source_sha256 === word.source_sha256
              && contains(row.case_source_range ?? row.source_range, word.source_range)))
            throw new Error(config.music_profile ? 'research_trial_profile_words_source_not_bound'
              : 'research_trial_original_words_source_not_bound');
        }
        const child = { cue_id: `${task.cue_id}/words`, parent_cue_id: task.cue_id, music_role: 'words_candidate',
          target_range: task.words_target_range, words_mode: task.words_mode, vocal_language: task.vocal_language };
        tasks.cues.push(child); routes.cues.push({ cue_id: child.cue_id, status: 'research_selected', selected: word });
        if (!word.offline_observation?.words?.complete_phrase)
          record.unresolved.push('research_sung_phrase_requires_independent_content_review');
      }
    }
    const originalEditSchema=editSchemaFor(config.music_action_contract_version ?? 1);
    const actualEditSchema=observedAssemblySfxPoolEnabled(config)
      ?applyObservedAssemblySoundSchema({properties:{edits:originalEditSchema}}).properties.edits:originalEditSchema;
    validateSchema(edits,actualEditSchema);
    if (edits.uncertainties.length) {
      const review = config.diagnostic_editing_caveat_review
        ? await loadDiagnosticEditingCaveats(config.diagnostic_editing_caveat_review, { sourceSha: manifest.source_sha256,
          editsBinding: record.inputs.edits, edits, config }) : null;
      if (!allowsDiagnosticEditingCaveats(review, { sourceSha: manifest.source_sha256, edits }))
        throw new Error('research_trial_editing_evidence_pending');
      record.diagnostic_editing_caveats = review;
      record.unresolved.push('original_editing_caveats_retained_for_actual_diagnostic_audition');
    }
    const refs = new Map();
    for (const item of catalog.evidence ?? []) {
      if (!item.id || !['frame', 'transcript', 'audio_observation'].includes(item.kind) || !item.path || !item.sha256)
        throw new Error('research_trial_story_evidence_binding_required');
      await verifyEvidenceBindings(item);
      if (item.kind === 'audio_observation') await verifyResearchAudioEvidence(item, { manifest,
        manifestBinding: record.inputs.manifest, research: config.mode === 'research' && strategy === 'current_director_research' });
      refs.set(item.id, { kind: item.kind, path: path.resolve(item.path),
        start_seconds: item.start_seconds ?? (item.kind === 'frame' ? item.timeline_seconds : undefined),
        end_seconds: item.end_seconds ?? (item.kind === 'frame' ? item.timeline_seconds : undefined),
        ...(item.kind === 'audio_observation' ? { sha256: item.sha256, source_video_sha256: item.source_video_sha256,
          source_sha256: item.source_sha256, verified: false, qualified: false, sound_facts_qualified: false } : {}) });
    }
    let editAnalysis = analysis;
    if (config.trial_scope) {
      const scope = config.trial_scope;
      if (!['music_only_episode', 'music_only_window', 'music_with_optional_dramatic_window', 'music_with_optional_sounds_window', 'music_with_optional_sounds_episode'].includes(scope.kind)
        || !range(scope.target_range) || !scope.reason?.trim()
        || !tasks.cues.every(row => contains(scope.target_range, row.target_range))
        || !analysis.story_beats.every(row => contains(scope.target_range, [row.start_seconds, row.end_seconds]))
        || (['music_only_episode', 'music_only_window'].includes(scope.kind) && (edits.sounds.length || sounds.length))) throw new Error('research_trial_music_only_scope_invalid');
      if (episodeMusicTrial) {
        assertResearchEpisodeScope({ config: { ...config, strategy }, director, analysis, edits, sounds,
          durationSamples: manifest.timeline.duration_samples });
        record.original_unknowns = { analysis: structuredClone(analysis.uncertainties ?? []), direction: structuredClone(director.uncertainties ?? []) };
        record.unresolved.push('whole_episode_music_trial_source_sound_and_artistic_review_pending');
      }
      const excluded = ['music_only_episode', 'music_only_window'].includes(scope.kind) ? analysis.sound_events
        : analysis.sound_events.filter(row => scope.excluded_sound_event_ids?.includes(row.id));
      const included = analysis.sound_events.filter(row => !excluded.includes(row));
      if (scope.kind === 'music_with_optional_dramatic_window'
        && (scope.excluded_sound_event_ids?.length !== excluded.length
          || included.some(row => row.role !== 'dramatic' || row.decision === 'seek_asset')
          || edits.sounds.some(row => row.decision !== 'new_asset' || row.original_status !== 'unknown')))
        throw new Error('research_trial_optional_dramatic_scope_invalid');
      if (scope.kind === 'music_with_optional_sounds_window'
        && (config.allow_nominal_event_anchors !== true
          || scope.excluded_sound_event_ids?.length !== excluded.length
          || included.some(row => !['physical', 'foley', 'dramatic', 'transition'].includes(row.role))
          || edits.sounds.some(row => row.decision !== 'new_asset' || row.original_status !== 'unknown')))
        throw new Error('research_trial_optional_sounds_scope_invalid');
      record.trial_scope = { ...scope, excluded_sound_events: structuredClone(excluded),
        full_episode_completed: false, ...(episodeMusicTrial ? { full_episode_picture_coverage: true }
          : { outside_window_music: 'silence' }), original_sound_audit: 'not_completed' };
      if (scope.kind === 'music_with_optional_sounds_episode') {
        record.actual_event_alignment = 'unverified_nominal_director_timestamps_only';
        record.trial_scope.sound_event_dispositions = analysis.sound_events.map(event => {
          const edit = edits.sounds.find(row => row.event_id === event.id);
          const candidate = sounds.find(row => row.event_id === event.id && row.segment_id === edit?.selected_segment_id);
          return { event_id: event.id, role: event.role, decision: edit?.decision ?? 'omit',
            reason: edit?.reason ?? scope.excluded_sound_event_reasons[event.id], original_status: edit?.original_status ?? 'unknown',
            original_source_audio: 'preserved_unprocessed_content_unverified',
            ...(candidate ? { selected_segment_id: candidate.segment_id, source_sha256: candidate.source_sha256,
              observation_record: candidate.observation_record, selection_record: candidate.selection_record,
              ...(candidate.original_sound_review ? { original_sound_review: candidate.original_sound_review } : {}) } : {}) };
        });
        record.unresolved.push('optional_dramatic_sound_semantics_cleanliness_and_original_duplication_unverified');
      }
      record.unresolved.push(scope.kind === 'music_with_optional_sounds_episode'
        ? 'whole_episode_original_sound_tasks_remain_pending' : 'music_only_window_physical_sound_tasks_remain_pending');
      if (scope.kind === 'music_with_optional_sounds_window') {
        record.actual_event_alignment = 'unverified_nominal_director_timestamps_only';
        record.unresolved.push('optional_sound_onsets_semantics_cleanliness_and_original_duplication_unverified');
      }
      editAnalysis = { ...analysis, sound_events: included, sound_event_none_reason: scope.reason };
    }
    let researchSeamReview;
    if (config.mode === 'research' && episodeMusicTrial && config.research_trial_authorization) {
      await verifyEvidenceBindings(config.research_trial_authorization);
      researchSeamReview = { mode: 'research', source_video_sha256: manifest.source_sha256,
        pending: true, authorization: config.research_trial_authorization };
    }
    const compiled = compileEdit({ edits, tasks, routes, analysis: editAnalysis, manifestPath: record.inputs.manifest.path,
      duration, audience: config.audience, craftMode: config.craft_mode, execution: config.execution ?? 'host',
      evidence: { refs, sounds }, dialogueIntervals: config.dialogue_intervals ?? [], arcManifest: compiledArcs.arcManifest,
      researchSeamReview });
    compiled.design=await preserveExplicitPointSoundPlacement({design:compiled.design,plan:compiled.plan,candidates:sounds,
      analysis:editAnalysis,edits,sourceSha:manifest.source_sha256});
    if (episodeMusicTrial) assertResearchEpisodeMusicCoverage(compiled.plan.cues, manifest.timeline.duration_samples, compiledArcs.arcManifest);
    if (config.mode === 'assisted_trial') assertAssistedSoundEdits(edits, editAnalysis, sounds);
    record.dialogue_ducking_unit_conversion = compiled.dialogue_ducking_unit_conversion;
    if (compiled.arc_edit_receipt) record.arc_edit_receipt = await saveJson(path.join(out, 'arc-edit-receipt.json'), compiled.arc_edit_receipt);
    if (compiled.arc_edit_receipt?.connections.some(row => row.potential_vocal_overlap_pending))
      record.unresolved.push('short_research_seams_have_unverified_vocal_overlap_pending_actual_audition');
    const plan = await saveJson(path.join(out, 'plan.json'), compiled.plan), design = await saveJson(path.join(out, 'sound-decisions.json'), compiled.design);
    if (edits.schema_version === 2) {
      record.music_action_compilation = await saveJson(path.join(out, 'music-action-compilation.json'), {
        schema_version: 2, plan, source_video_sha256: manifest.source_sha256,
        selections: compiled.selections, actionResponses: compiled.actionResponses,
        music_action_bindings: compiled.music_action_bindings,
        inputs: { arc_plan: record.inputs.arc_plan, edits: record.inputs.edits, director: record.inputs.director } });
      record.music_action_execution_audit = await saveJson(path.join(out, 'music-action-execution-audit.json'),
        auditMusicActionExecution({ director, plan: arcPlan, edits, compiled }));
    }
    record.music_source_budget = await enforceEpisodeMusicSourceBudget({ config, plan: compiled.plan,
      caseRoutes: cases, out, durationSamples: manifest.timeline.duration_samples });
    if (!record.music_source_budget.passed) return Object.assign(record, { status: 'reference_music_budget_gap',
      next_action: record.music_source_budget.next_action, preview: null, fallback_performed: false });
    record.selected_music = routes.cues.map(row => ({ cue_id: row.cue_id, status: row.status, segment_id: row.selected.segment_id,
      source_sha256: row.selected.source_sha256, source_range: row.selected.source_range,
      case_route_id: row.selected.case_route_id, music_pack_id: row.selected.music_pack_id,
      ...(row.selected.route_kind ? { route_kind: row.selected.route_kind, preset_id: row.selected.preset_id,
        condition_binding: row.selected.condition_binding } : {}) }));
    await verifyEvidenceBindings([...Object.values(record.inputs), ...observationBindings]);
    if (await hashFile(video) !== manifest.source_sha256) throw new Error('research_trial_source_changed');
    const job = await saveJson(path.join(out, 'job.json'), { schema_version: 1, purpose: 'technical_diagnostic',
      manifest: record.inputs.manifest.path, plan: plan.path, sound_decisions: design.path,
      music_source_provenance: record.music_source_budget.provenance,
      ...(independent ? { mode: 'research', automatic_trial: true, material_strategy: config.material_strategy,
        music_packs: config.music_packs, source_policy: config.source_policy, trial_review_policy: config.trial_review_policy } : {}),
      ...(config.work_identity_evidence ? { work_identity_evidence: config.work_identity_evidence } : {}),
      ...(config.python ? { python: config.python } : {}),
      ...(config.music_source_scope ? { music_source_scope: config.music_source_scope } : {}),
      ...(config.final_mix_master!==undefined?{final_mix_master:config.final_mix_master}:{}),
      ...(config.sfx_audibility_repair!==undefined?{sfx_audibility_repair:config.sfx_audibility_repair}:{}),
      ...(config.render_decode_cache!==undefined?{render_decode_cache:config.render_decode_cache}:{}),
      original_gain_db: config.original_gain_db ?? 0, original_audio_state: 'source_aligned_unprocessed',
      expected_sha256: { manifest: record.inputs.manifest.sha256, plan: plan.sha256, sound_decisions: design.sha256,
        source_video: manifest.source_sha256 }, ...(config.preview === false || previewMaster ? {} : { preview: { review_only: true } }) });
    if (preparationOnly) {
      const reviews = [...music, ...words, ...sounds].map(row => row.human_review_record);
      if (reviews.some(row => !row?.path || !row.sha256)) throw new Error('reviewed_material_evidence_required_for_target_preparation');
      await verifyEvidenceBindings(reviews);
      Object.assign(record, { status: 'target_material_preparation_verified',
        kind: 'host_render_preparation_preflight', prepared_job: job, prepared_plan: plan,
        prepared_design: design, verified_package_evidence: reviews,
        actual_material_consumer_verified: true, required_tasks_unresolved: [],
        render_calls: 0, previews_created: 0, actual_audio_listened: false,
        production_approval: false, artistic_acceptance: 'not_assessed' });
      record.preparation_receipt = await saveJson(path.join(out, 'target-render-preparation.json'), record);
      return record;
    }
    const rendered = await (runtime.runSoundJob ?? runSoundJob)(job.path, path.join(out, 'render-job'));
    if (rendered.cross_work_music?.passed === false) {
      Object.assign(record, { status: rendered.status, render: rendered, cross_work_music: rendered.cross_work_music,
        next_action: rendered.next_action, preview: null, audio_dir: null,
        render_calls: 0, previews_created: 0, fallback_performed: false,
        research_trial_does_not_waive_cross_work_music: true });
      return record;
    }
    record.render = rendered; record.audio_dir = path.join(out, 'render-job/render');
    const effectiveRenderPlan=rendered.sfx_audibility_repair?.applied_plan?.path??path.join(out,'render-job/plan.json');
    if (edits.schema_version === 2) {
      const reported = rendered.outputs['render/report.json'];
      if (!reported?.sha256) throw Error('music_action_bound_render_report_required');
      const renderReport = { path: path.join(out, 'render-job/render/report.json'), sha256: reported.sha256 };
      await verifyEvidenceBindings(renderReport);
      const report = await readJson(renderReport.path);
      const stemBindings = Object.entries(report.output_sha256).map(([track, sha256]) => ({
        path: path.join(record.audio_dir, `${track}.wav`), sha256 }));
      await verifyEvidenceBindings(stemBindings);
      const audit = verifyMusicActionRenderExecution(auditMusicActionExecution({ director, plan: arcPlan, edits, compiled }), compiled, report);
      record.music_action_render_execution_audit = await saveJson(path.join(out, 'music-action-render-execution-audit.json'), {
        ...audit, inputs: { compilation: record.music_action_compilation, render_report: renderReport, stems: stemBindings } });
    }
    record.preview = rendered.outputs['preview.mp4'] ? path.join(out, 'render-job/preview.mp4') : null;
    if (!record.preview && config.preview !== false && previewMaster) {
      const report = await readJson(path.join(record.audio_dir, 'report.json'));
      const safeStems = ['bgm', 'sfx', 'ambience', 'accompaniment'].every(track =>
        report.output_sample_peaks_before_pcm_clamping?.[track]?.clipped === false);
      const onlyReviewableMix = rendered.mix_status === 'technical_ok' || rendered.mix_status === 'needs_mix_review'
        && rendered.mix_issues?.length && rendered.mix_issues.every(issue => ['original_plus_accompaniment_digital_overload',
          'complete_mix_true_peak_at_or_above_0_dbfs', 'original_audio_kind_requires_review'].includes(issue));
      if (safeStems && onlyReviewableMix) {
        const preview = path.join(out, 'render-job/research-master-preview.mp4');
        await promisify(execFile)(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)),
          'export_preview.mjs'), effectiveRenderPlan, '--render', record.audio_dir,
          '--out', preview, '--review-only', '--preview-master-gain-db', String(config.preview_master_gain_db)],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        record.preview = preview;
        record.research_preview = { review_only: true, preview_master_gain_db: config.preview_master_gain_db,
          raw_mix_status: rendered.mix_status, raw_mix_issues: rendered.mix_issues, production_approval: false,
          report: await readBound(`${preview}.json`) };
        record.unresolved.push('untrimmed_mix_risk_retained_preview_mastering_is_not_production_approval');
      }
    }
    if (!record.preview && config.preview !== false && !previewMaster && (config.mode === 'assisted_trial' || episodeMusicTrial)) {
      const onlySourcePending = rendered.mix_status === 'technical_ok' || (rendered.mix_status === 'needs_mix_review'
        && rendered.mix_issues?.length && rendered.mix_issues.every(issue =>
          ['original_audio_kind_requires_review', 'dialogue_intervals_not_provided'].includes(issue)));
      if (onlySourcePending) {
        const preview = path.join(out, episodeMusicTrial ? 'render-job/research-preview.mp4' : 'render-job/assisted-preview.mp4');
        await promisify(execFile)(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)),
          'export_preview.mjs'), effectiveRenderPlan, '--render', record.audio_dir,
          '--out', preview, '--assisted-review-only'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        record.preview = preview;
        record.unresolved.push(episodeMusicTrial ? 'research_preview_original_sound_facts_and_scene_fit_pending' : 'assisted_preview_original_sound_facts_and_scene_fit_pending');
        record[episodeMusicTrial ? 'research_preview' : 'assisted_preview'] = { review_only: true, production_approval: false,
          report: await readBound(`${preview}.json`), preserved_coverage: await readBound(path.join(out, 'render-job/sound-coverage.json')) };
      }
    }
    if (!record.preview && config.preview !== false && config.trial_scope?.kind === 'music_with_optional_sounds_window'
      && rendered.coverage_status === 'incomplete_sound_coverage') {
      const coverage = await readJson(path.join(out, 'render-job/sound-coverage.json'));
      const safeMix = rendered.mix_status === 'technical_ok' || (rendered.mix_status === 'needs_mix_review'
        && rendered.mix_issues?.length === 1 && rendered.mix_issues[0] === 'original_audio_kind_requires_review');
      if (safeMix && coverage.issues?.length && coverage.issues.every(issue => issue.problem === 'physical_original_content_unverified'
        && edits.sounds.some(row => row.event_id === issue.id && row.original_status === 'unknown'))) {
        const preview = path.join(out, 'render-job/research-optional-preview.mp4');
        await promisify(execFile)(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)),
          'export_preview.mjs'), effectiveRenderPlan, '--render', record.audio_dir,
          '--out', preview, '--review-only'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        record.preview = preview;
        record.optional_preview = { status: 'research_only_original_sound_coverage_pending',
          actual_preview: await readBound(`${preview}.json`), preserved_coverage: await readBound(path.join(out, 'render-job/sound-coverage.json')),
          production_approval: false };
      }
    }
    // An explicitly mastered bus already includes original once. Export it
    // without the older preview-gain recovery, which would apply gain twice.
    if(!record.preview&&config.preview!==false&&config.final_mix_master!==undefined&&rendered.final_mix_master){
      const preview=path.join(out,'render-job/final-bus-review-preview.mp4');
      await promisify(execFile)(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'export_preview.mjs'),
        effectiveRenderPlan,'--render',record.audio_dir,'--out',preview,'--review-only'],
        {windowsHide:true,maxBuffer:4*1024*1024});
      record.preview=preview;record.final_mix_master=rendered.final_mix_master;
      record.research_preview={review_only:true,production_approval:false,final_mix_master:rendered.final_mix_master,
        report:await readBound(`${preview}.json`)};
      record.unresolved.push('technical_final_bus_safe_original_facts_sound_coverage_and_creative_review_still_pending');
    }
    if (!record.preview && config.preview !== false && independent && episodeMusicTrial) {
      const report = await readJson(path.join(record.audio_dir, 'report.json'));
      const repairable = ['technical_ok', 'needs_mix_review'].includes(report.status)
        && report.issues?.every(issue => ['original_plus_accompaniment_digital_overload',
          'complete_mix_true_peak_at_or_above_0_dbfs', 'original_audio_kind_requires_review'].includes(issue));
      if (repairable) {
        const rawTrial = await saveJson(path.join(out, 'pre-preview-recovery-record.json'), record);
        try {
          const { recoverDiagnosticPreview } = await import('./recover_diagnostic_preview.mjs');
          const recovered = await recoverDiagnosticPreview({ trial_binding: rawTrial, config,
            output_dir: path.join(out, 'automatic-preview-recovery') });
          record.preview = recovered.preview.path;
          record.automatic_preview_recovery = recovered.receipt;
          record.research_preview = { review_only: true, production_approval: false,
            preview_master_gain_db: recovered.preview_master_gain_db,
            raw_mix_status: report.status, raw_mix_issues: report.issues,
            report: await readBound(`${record.preview}.json`) };
          record.unresolved.push('bounded_preview_headroom_only_raw_mix_and_artistic_review_still_pending');
        } catch (error) {
          record.automatic_preview_recovery_gap = { reason: error.message, raw_outputs_preserved: true, production_approval: false };
        }
      }
    }
    const safeResearchPreview = episodeMusicTrial && record.preview
      && record.research_preview?.report?.value?.encoded_technical_status === 'technical_ok';
    record.status = safeResearchPreview || rendered.diagnostic_result === 'ready_for_audition' ? 'director_trial_pending_audition'
      : 'director_trial_needs_technical_review';
    await exportDiagnosticSample(config, record, out);
    await verifyEvidenceBindings([...Object.values(record.inputs), ...observationBindings]);
    return record;
  } catch (error) { record.status = 'failed'; record.failure = error.code ?? error.message; throw error; }
  finally { record.elapsed_seconds = (performance.now() - started) / 1000; await saveJson(path.join(out, 'trial-record.json'), record); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) { console.error('Usage: node render_research_trial.mjs CONFIG.json'); process.exitCode = 1; }
  else renderResearchTrial(await readJson(file)).then(record => console.log(JSON.stringify({ status: record.status,
    preview: record.preview, production_approval: false }))).catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
