import { projectTrialPreflight } from './project_trial_gate.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, saveJson, verifyEvidenceBindings, objectSchema, validateSchema } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { soundArcPlanSchema, compileSoundArcPlan } from './sound_arc_plan.mjs';
import { editSchema } from './compose_episode.mjs';
import { renderResearchTrial } from './render_research_trial.mjs';
import { projectMaterialObservations } from './material_observation_projection.mjs';
import { recentMusicContext } from './recent_music_context.mjs';
import { loadMusicProfile } from './music_profile.mjs';

const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const readBound = async ref => {
  const item = typeof ref === 'string' ? await bound(ref) : ref;
  await verifyEvidenceBindings(item); return { binding: item, value: await readJson(item.path) };
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function saveStable(file, value) {
  try {
    const prior = await readBound(file);
    if (JSON.stringify(prior.value) !== JSON.stringify(value)) throw new Error('current_trial_stage_identity_changed');
    return prior.binding;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return saveJson(file, value); }
}
const editorSchema = objectSchema({ plan: soundArcPlanSchema, edits: editSchema,
  gaps: { type: 'array', items: { type: 'string' } } });
const editorSchemaV2 = objectSchema({ plan: soundArcPlanSchema, edits: editSchema,
  execution_gaps: { type: 'array', items: { type: 'string' } },
  review_pending: { type: 'array', items: { type: 'string' } } });
const samples = range => range.map(value => Math.round(value * 48000));
const inside = (inner, outer) => Array.isArray(inner) && inner.length === 2 && inner.every(Number.isFinite)
  && inner[0] >= outer[0] && inner[1] <= outer[1] && samples(inner)[1] > samples(inner)[0];
const researchPredictions = rows => (rows ?? []).map(row => ({ backend_id: row.backend_id, source_range: row.source_range,
  parsed: row.parsed, top_labels: row.top_labels?.slice(0, 5), scope: row.scope,
  lyrics_verified: false, sound_semantics_verified: false }));
const compactAcousticFeatures = value => value?.rms_envelope_half_second ? {
  ...value, rms_envelope_half_second: undefined, rms_envelope_table: {
    columns: ['relative_start_seconds', 'relative_end_seconds', 'rms_dbfs'],
    rows: value.rms_envelope_half_second.map(row => [row.relative_start_seconds, row.relative_end_seconds, row.rms_dbfs]) },
} : value;

// Each real cue editor has a local arc namespace. Only colliding IDs are qualified during episode aggregation.
export function qualifyEpisodeArcIds(arcs, edits) {
  const counts = new Map(), taskIds = new Map(), mapping = [];
  for (const arc of arcs) counts.set(arc.arc_id, (counts.get(arc.arc_id) ?? 0) + 1);
  const normalized = structuredClone(arcs);
  for (const arc of normalized) {
    if (counts.get(arc.arc_id) < 2) continue;
    const oldId = arc.arc_id, nextId = `${arc.cue_id}::${oldId}`;
    for (const piece of arc.pieces) taskIds.set(`${arc.cue_id}/arc/${oldId}/${piece.piece_id}`,
      `${arc.cue_id}/arc/${nextId}/${piece.piece_id}`);
    mapping.push({ cue_id: arc.cue_id, original_arc_id: oldId, episode_arc_id: nextId });
    arc.arc_id = nextId;
  }
  if (new Set(normalized.map(arc => arc.arc_id)).size !== normalized.length)
    throw new Error('current_episode_arc_namespacing_collision');
  const normalizedEdits = structuredClone(edits);
  for (const row of [...normalizedEdits.music_edits, ...normalizedEdits.action_responses])
    row.music_task_cue_id = taskIds.get(row.music_task_cue_id) ?? row.music_task_cue_id;
  return { arcs: normalized, edits: normalizedEdits, identity_mapping: mapping };
}

// Local arc compilation has no predecessor; retain a real adjacent-arc link separately without altering it.
export function localizeExternalArcConnection(plan, previousActualEdit) {
  const local = structuredClone(plan), arc = local.arcs?.[0], first = arc?.pieces?.[0];
  if (!first?.connection_from) return { plan: local, external_connection: null };
  const priorArc = previousActualEdit?.arcs?.at(-1), prior = priorArc?.pieces?.at(-1);
  if (local.arcs.length !== 1 || !prior || priorArc.cue_id === arc.cue_id
    || first.connection_from.previous_piece_id !== prior.piece_id || !first.connection_from.reason?.trim()
    || !inside(first.target_range, first.target_range) || !inside(prior.target_range, prior.target_range)
    || samples(prior.target_range)[1] !== samples(first.target_range)[0])
    throw new Error('current_external_arc_actual_adjacent_connection_required');
  const external = { from_cue_id: priorArc.cue_id, from_arc_id: priorArc.arc_id, from_piece_id: prior.piece_id,
    to_cue_id: arc.cue_id, to_arc_id: arc.arc_id, to_piece_id: first.piece_id,
    from_target_range: [...prior.target_range], to_target_range: [...first.target_range],
    original_connection: structuredClone(first.connection_from), source_editor: previousActualEdit.actual_editor_response,
    listening_verified: false, production_approval: false };
  first.connection_from = null;
  return { plan: local, external_connection: external };
}

// Explicitly selected ordinary music-development actions may span mother cues. Preserve their original interval.
export function partitionMusicActionsByCue(director, actionIds) {
  if (!Array.isArray(actionIds) || new Set(actionIds).size !== actionIds.length)
    throw new Error('current_action_partition_ids_required');
  const result = structuredClone(director), mapping = [];
  for (const id of actionIds) {
    const action = director.music_actions?.find(row => row.id === id);
    if (!action || !['hold', 'response'].includes(action.requirement) || !inside(action.target_range, action.target_range))
      throw new Error('current_ordinary_music_development_action_required');
    const owners = director.cues.filter(cue => cue.required_action_ids.includes(id));
    if (owners.length < 2 || owners.some(cue => !inside(cue.target_range, cue.target_range)))
      throw new Error('current_action_partition_known_mother_bounds_required');
    if (owners.some(cue => cue.words_candidate_request === 'require' && cue.words_target_range
      && cue.words_target_range[0] < action.target_range[1] && action.target_range[0] < cue.words_target_range[1]))
      throw new Error('current_action_partition_cannot_split_required_words');
    const parts = owners.map(cue => ({ cue_id: cue.cue_id, local_action_id: `${id}@${cue.cue_id}`,
      target_range: [Math.max(action.target_range[0], cue.target_range[0]), Math.min(action.target_range[1], cue.target_range[1])] }))
      .sort((a, b) => a.target_range[0] - b.target_range[0]);
    let end = samples(action.target_range)[0];
    for (const part of parts) {
      const target = samples(part.target_range);
      if (!inside(part.target_range, action.target_range) || target[0] !== end)
        throw new Error('current_action_partition_exact_union_required');
      end = target[1];
    }
    if (end !== samples(action.target_range)[1]) throw new Error('current_action_partition_exact_union_required');
    if (parts.some(part => result.music_actions.some(row => row.id === part.local_action_id)))
      throw new Error('current_action_partition_identity_collision');
    result.music_actions.splice(result.music_actions.findIndex(row => row.id === id), 1,
      ...parts.map(part => ({ ...action, id: part.local_action_id, target_range: part.target_range })));
    for (const part of parts) {
      const cue = result.cues.find(row => row.cue_id === part.cue_id);
      cue.required_action_ids = cue.required_action_ids.map(old => old === id ? part.local_action_id : old);
    }
    mapping.push({ original_action: structuredClone(action), parts, scope: 'ordinary_music_development_only',
      precise_event_anchors_verified: false });
  }
  return { director: result, mapping };
}

// Called by the material worker once real whole-arc handoffs exist. It does not fabricate or silently fill a missing arc.
export async function renderCurrentDirectorTrial(config, runtime = {}) {
  const projectGate = await projectTrialPreflight(config, { operation: 'render_current_director_trial' });
  if (projectGate) return projectGate;

  if (!config.output_dir || !Array.isArray(config.arc_handoffs)) throw new Error('current_trial_configuration_required');
  const output = path.resolve(config.output_dir), inputs = {};
  for (const key of ['manifest', 'analysis', 'director']) inputs[key] = await readBound(config[key]);
  const manifest = inputs.manifest.value, analysis = inputs.analysis.value, director = structuredClone(inputs.director.value);
  const sourceSha = manifest.source_sha256, duration = manifest.timeline?.duration_samples / 48000;
  if (!(duration > 0) || [analysis.source_video_sha256, director.source_video_sha256].some(sha => sha !== sourceSha))
    throw new Error('current_trial_source_binding_required');
  if (config.music_profile) {
    const profile = await loadMusicProfile(config.music_profile, { sourceSha, workId: config.work_id,
      strategy: 'current_director_research' });
    if (!profile.ready) return { status: profile.status, music_profile: profile,
      next_action: profile.next_action ?? 'use_case_presets_for_confirmed_reference_package',
      fallback_performed: false, production_approval: false };
  }
  let actionPartitionRecord;
  if (config.action_partition_record) {
    const record = await readBound(config.action_partition_record), original = await readBound(record.value.original_director);
    const expected = partitionMusicActionsByCue(original.value, record.value.action_ids);
    if (original.value.source_video_sha256 !== sourceSha || JSON.stringify(expected.director) !== JSON.stringify(director)
      || JSON.stringify(expected.mapping) !== JSON.stringify(record.value.mapping))
      throw new Error('current_action_partition_input_identity_changed');
    actionPartitionRecord = record.binding;
  }
  const handoffs = await Promise.all(config.arc_handoffs.map(readBound)), byCue = new Map(), materialGaps = [];
  for (const entry of handoffs) {
    const id = entry.value.original_cue_id ?? entry.value.cue_id;
    const cue = director.cues.find(cue => cue.cue_id === id);
    if (!cue) throw new Error('current_trial_known_arc_required');
    const target = entry.value.target_range ?? cue.target_range;
    if (!inside(target, cue.target_range)) throw new Error('current_trial_handoff_target_outside_arc');
    if (entry.value.selected_count === 0 || entry.value.bound_materials === null) {
      materialGaps.push({ cue_id: id, target_range: target, handoff: entry.binding,
        reason: 'actual_candidate_comparison_returned_no_bound_music', selected_count: entry.value.selected_count ?? 0 });
      continue;
    }
    entry.targetRange = target;
    byCue.set(id, [...(byCue.get(id) ?? []), entry]);
  }
  const missing = director.cues.filter(cue => !byCue.has(cue.cue_id)).map(cue => cue.cue_id);
  const missingRanges = [];
  for (const cue of director.cues) {
    let end = samples(cue.target_range)[0];
    const entries = (byCue.get(cue.cue_id) ?? []).sort((a, b) => a.targetRange[0] - b.targetRange[0]);
    for (const entry of entries) {
      const target = samples(entry.targetRange);
      if (target[0] < end) throw new Error('current_trial_handoff_target_overlap');
      if (target[0] > end) missingRanges.push({ cue_id: cue.cue_id, target_range: [end / 48000, target[0] / 48000] });
      end = target[1];
    }
    if (end < samples(cue.target_range)[1]) missingRanges.push({ cue_id: cue.cue_id,
      target_range: [end / 48000, cue.target_range[1]] });
  }
  if ((missing.length || missingRanges.length) && config.prepare_available_arcs !== true) return { status: 'awaiting_actual_arc_bindings',
    missing_cue_ids: missing, missing_target_ranges: missingRanges, material_binding_gaps: materialGaps, production_approval: false };
  if (!runtime.session?.request) throw new Error('current_trial_actual_editor_runtime_required');
  const recentMusic = await recentMusicContext(config.recent_other_film_music, { sourceSha, workId: config.work_id });
  const materials = { schema_version: 2, cases: [], packs: [], sound_packs: [], source_bindings: [] };
  const candidates = [], routes = [], arcs = [], edits = { music_edits: [], action_responses: [], sounds: [],
    dialogue_ducking_db: config.dialogue_ducking_db ?? 3, uncertainties: [] }, deferredWords = [], editorRecords = [],
    editingGaps = [], reviewPending = [], nominalAlignmentGaps = [], acceptedArcSources = [], externalConnections = [];
  const catalog = { source_video_sha256: sourceSha, evidence: await Promise.all(manifest.frames.map(async (frame, index) => ({
    ...await bound(path.resolve(path.dirname(inputs.manifest.binding.path), frame.path)), kind: 'frame',
    id: `frame_${String(index + 1).padStart(5, '0')}`, start_seconds: frame.timeline_seconds,
    end_seconds: Math.min(duration, frame.timeline_seconds + (manifest.frame_step_seconds ?? 3)) }))) };
  for (const cue of director.cues) {
    if (missingRanges.some(row => row.cue_id === cue.cue_id)) continue;
    if (cue.words_candidate_request) {
      if (cue.words_candidate_request !== 'explore' || config.defer_unverified_words_exploration !== true)
        return { status: 'awaiting_actual_words_candidate', cue_id: cue.cue_id, production_approval: false };
      deferredWords.push({ cue_id: cue.cue_id, request: cue.words_candidate_request,
        target_range: cue.words_target_range, language: cue.vocal_language,
        reason: 'Explicit research-only deferral; lyrics and complete phrase remain unverified.' });
      cue.words_candidate_request = null; cue.words_target_range = null;
    }
    const cueHandoffs = byCue.get(cue.cue_id), cueCandidates = [], cueMaterials = [];
    const cueOutput = path.join(output, 'inputs', cue.cue_id, digest(cueHandoffs.map(row => row.binding)));
    for (const [handoffIndex, handoff] of cueHandoffs.entries()) {
      const data = handoff.value, allowedTarget = handoff.targetRange;
      const material = await readBound(data.bound_materials), selection = await readBound(data.selection);
      await verifyEvidenceBindings(selection.value);
      const raw = await readBound(selection.value.raw_response);
      if (raw.value.actual_runtime_executed !== true || raw.value.completion_status !== 'complete')
        throw new Error('current_trial_actual_selector_required');
      const normalizedDecisions = [], handoffCandidates = [];
      for (const alternative of data.alternatives ?? []) {
        const pack = material.value.packs.find(row => row.pack_id === (alternative.pack_id ?? alternative.music_pack_id));
        const decision = raw.value.value.decisions.find(row => row.kind === 'music'
          && row.selected_segment_ids.includes(alternative.segment_id));
        const current = material.value.cases.find(row => row.case_id === decision?.case_id);
        if (!pack || !current || current.source_role !== 'current_unscored_target_not_reference_success_case'
          || current.evidence.source_video_sha256 !== sourceSha
          || !inside(allowedTarget, current.source_range)
          || samples(alternative.source_range)[1] - samples(alternative.source_range)[0]
            < samples(allowedTarget)[1] - samples(allowedTarget)[0])
          throw new Error('current_trial_whole_arc_actual_material_required');
        normalizedDecisions.push({ cue_id: cue.cue_id, selected_segment_id: alternative.segment_id,
          selected_source_range: alternative.source_range, reason: decision.adopt_reason });
        handoffCandidates.push({ cue_id: cue.cue_id, asset_id: alternative.asset_id, segment_id: alternative.segment_id,
          source_sha256: alternative.source_sha256, source_range: alternative.source_range,
          allowed_target_range: allowedTarget,
          local_path: material.value.material_binding_evidence.source_files.find(row => row.sha256 === alternative.source_sha256)?.path,
          observation_record: alternative.observation_record, case_ids: [], music_pack_id: pack.pack_id,
          target_case_id: current.case_id, target_step_id: decision.step_id,
          case_route_id: `current-director/${cue.cue_id}/${handoffIndex}/${alternative.segment_id}` });
      }
      if (!handoffCandidates.length) throw new Error('current_trial_actual_arc_candidates_missing');
      const normalized = await saveStable(path.join(cueOutput, String(handoffIndex), 'selection-mapping.json'), {
        source_video_sha256: sourceSha, decisions: normalizedDecisions,
        selection_provenance: { selector_record: selection.binding, raw_response: selection.value.raw_response,
          case_input: selection.value.case_source, input: selection.value.input, cli_receipts: selection.value.cli_receipts } });
      for (const candidate of handoffCandidates) {
        candidate.selection_record = normalized; candidates.push(candidate); cueCandidates.push(candidate);
        routes.push({ route_id: candidate.case_route_id, cue_id: cue.cue_id, strategy: 'current_director_research',
          target_case_id: candidate.target_case_id, case_ids: [], music_pack_id: candidate.music_pack_id,
          source_candidates: [{ ...candidate, local_path: undefined, observation_record: undefined, selection_record: undefined }] });
      }
      materials.cases.push(...material.value.cases.filter(row => !materials.cases.some(old => old.case_id === row.case_id)));
      materials.packs.push(...material.value.packs.filter(row => !materials.packs.some(old => old.pack_id === row.pack_id)));
      materials.source_bindings.push(material.binding);
      cueMaterials.push(material.binding);
    }
    const frames = catalog.evidence.filter(frame => frame.start_seconds >= cue.target_range[0] && frame.start_seconds < cue.target_range[1]);
    const frameIndices = new Set(Array.from({ length: 8 }, (_, n) => Math.round(n * (frames.length - 1) / 7)));
    const limitedFrames = frames.filter((_, index) => frames.length <= 8 || frameIndices.has(index));
    const localDirector = { ...director, cues: [cue], music_actions: director.music_actions.filter(action => cue.required_action_ids.includes(action.id)) };
    const fullCandidateObservations = [];
    const candidateObservations = await Promise.all(cueCandidates.map(async candidate => {
      const observed = await readBound(candidate.observation_record), value = observed.value.observation;
      fullCandidateObservations.push({ segment_id: candidate.segment_id, source_sha256: candidate.source_sha256,
        source_range: observed.value.source_range, actual_observation: observed.binding,
        actual_audio_processed: observed.value.actual_audio_processed, qualified: false, observation: value });
      return { segment_id: candidate.segment_id, actual_observation: observed.binding,
        actual_audio_processed: observed.value.actual_audio_processed, source_range: observed.value.source_range,
        description: value.description ?? null, qualified: false,
        predictions: researchPredictions(value.predictions),
        window_predictions: (value.window_predictions ?? []).map(window => ({ source_range: window.source_range,
          observation_record: window.observation_record, predictions: researchPredictions(window.predictions) })),
        acoustic_features: compactAcousticFeatures(value.auxiliary_acoustic_features) ?? null,
        limitations: value.limitations ?? ['These are unqualified research predictions, not verified perception.'] };
    }));
    const editorInput = {
      schema: config.editor_contract === 'research_unknowns_v2' ? editorSchemaV2 : editorSchema, frames: limitedFrames,
      instruction: 'Make one research music arc for the supplied mother cue. Prefer one actually observed continuous recording; administrative observation windows do not mean song changes. Each candidate is permitted only inside its allowed_target_range, not other portions of this cue. Use only the bounded selected source windows, no implicit loop or unobserved extension. Respond with one-arc soundArcPlan and editSchema. music_task_cue_id must equal cue_id + /arc/ + arc_id + / + piece_id, with one music edit per piece. action_responses must contain exactly one response for each required_action_id and preserve its current target_range; that whole action must fit one actual piece. sounds is empty because physical sound work remains separately pending. Do not claim audio hearing, complete phrase, lyrics, production or aesthetic qualification. Unknown prediction semantics remain research limitations; unresolved source duration or timing must be a gap.',
      data: { source_video_sha256: sourceSha, source: { path: path.resolve(path.dirname(inputs.manifest.binding.path), manifest.source_video), sha256: sourceSha },
        director: localDirector, story_beats: analysis.story_beats.filter(beat => cue.story_beat_ids.includes(beat.id)),
        current_arc_handoffs: cueHandoffs.map(handoff => handoff.binding), actual_materials: cueMaterials,
        candidates: cueCandidates.map(candidate => ({ ...candidate, actual_sound_semantics: 'unqualified_predictions_only' })),
        actual_candidate_observations: candidateObservations,
        recent_other_film_music: recentMusic.deliveries, cross_film_reuse_check: recentMusic,
        deferred_words: deferredWords.filter(item => item.cue_id === cue.cue_id) } };
    if (config.editor_contract === 'research_unknowns_v2') editorInput.instruction +=
      ' The v2 diagnostic contract separates execution_gaps from review_pending in this same response. execution_gaps contain only missing actual source identity, bounds, duration or coverage that prevents mechanical execution. All uncertain listening, lyrics, artistic fit, phrases, seams, original sound and masking stay in review_pending. When nominal event anchors are explicitly enabled, uncertain actual event onsets also stay in review_pending: map the existing director target times without claiming precise actual event sync. Do not request a second classifier. Preserve unresolved items, and keep edits.uncertainties empty when those items are already in review_pending.';
    if (recentMusic.deliveries.length) editorInput.instruction +=
      ' Compare supplied actual other-film selections; avoid crisis recording repetition across unrelated films when a suitable observed alternative exists, without choosing an unsuitable alternative just to differ.';
    editorInput.instruction += ' A continuation must refer to the actual preceding selected recording and source window, never an unused preceding alternative. Independent fade-out and fade-in with zero target overlap are a butt join, not a crossfade. Do not describe unobserved phrases or unknown expressive content as confirmed.';
    editorInput.data.allow_nominal_event_anchors = config.allow_nominal_event_anchors === true;
    if (config.adjacent_arc_context === true) {
      const nextCue = director.cues[director.cues.findIndex(row => row.cue_id === cue.cue_id) + 1];
      editorInput.data.adjacent_arc_context = {
        previous_actual_edit: acceptedArcSources.at(-1) ?? null,
        next_observed_alternatives: (byCue.get(nextCue?.cue_id) ?? []).map(row => ({
          actual_handoff: row.binding, target_range: row.targetRange, alternatives: row.value.alternatives })),
        scope: 'Bound adjacent research alternatives and the actual prior edit; not proof of phrase or artistic continuity.' };
      editorInput.instruction += ' Coordinate the current whole cue with the actual previous edit and next observed alternatives. When the director requests continuation, compare genuinely contiguous windows of the same recording. Do not assume an alternative has already been chosen or revise a completed previous edit.';
    }
    if (config.material_observation_projection === 'window_tables_v4') {
      fullCandidateObservations.sort((a, b) => cueCandidates.findIndex(row => row.segment_id === a.segment_id)
        - cueCandidates.findIndex(row => row.segment_id === b.segment_id));
      const full = { source_video_sha256: sourceSha, tasks: [{ candidates: fullCandidateObservations }] };
      const fullBinding = await saveStable(path.join(cueOutput, 'actual-observations-full-v4.json'), full);
      const projected = projectMaterialObservations({ input: fullBinding, tasks: full.tasks });
      editorInput.data.actual_candidate_observations = projected.tasks[0].candidates;
      editorInput.data.observation_projection = projected.observation_projection;
      editorInput.data.metadata_text_table = projected.metadata_text_table;
    }
    const savedEditor = config.editor_responses?.find(row => row.cue_id === cue.cue_id);
    let response;
    if (savedEditor) {
      const saved = await readBound(savedEditor.raw_response), request = await readBound(savedEditor.request);
      await verifyEvidenceBindings(saved.value.evidence_files);
      if (request.value.role !== 'current_research_music_editor'
        || request.value.source_video_sha256 !== sourceSha || request.value.input_sha256 !== saved.value.input_sha256
        || JSON.stringify(request.value.input.data.director) !== JSON.stringify(localDirector)
        || JSON.stringify(request.value.input.data.candidates) !== JSON.stringify(editorInput.data.candidates))
        throw new Error('current_trial_saved_editor_input_identity_changed');
      response = { ...saved.value, raw_response: saved.binding, reused: true, cli_receipts: [] };
    } else response = await runtime.session.request('current_research_music_editor', editorInput);
    const v2 = Object.hasOwn(response.value, 'execution_gaps');
    validateSchema(response.value, v2 ? editorSchemaV2 : editorSchema);
    if (response.actual_runtime_executed !== true || !response.raw_response?.sha256)
      throw new Error('current_trial_actual_editor_execution_required');
    const editorRaw = await readBound(response.raw_response);
    if (editorRaw.value.actual_runtime_executed !== true || editorRaw.value.completion_status !== 'complete'
      || editorRaw.value.source_video_sha256 !== sourceSha || editorRaw.value.qualified !== false
      || JSON.stringify(editorRaw.value.value) !== JSON.stringify(response.value))
      throw new Error('current_trial_editor_response_identity_required');
    editorRecords.push(response.raw_response);
    const localized = config.adjacent_arc_context === true
      ? localizeExternalArcConnection(response.value.plan, acceptedArcSources.at(-1))
      : { plan: response.value.plan, external_connection: null };
    if (localized.external_connection) externalConnections.push({ ...localized.external_connection,
      target_editor: response.raw_response });
    const compiled = compileSoundArcPlan({ plan: localized.plan, director: localDirector, candidates: cueCandidates });
    const musicIds = new Set(response.value.edits.music_edits.map(row => row.music_task_cue_id));
    const actions = response.value.edits.action_responses;
    if (musicIds.size !== response.value.edits.music_edits.length || musicIds.size !== compiled.splitCues.length
      || !compiled.splitCues.every(row => musicIds.has(row.cue_id))) throw new Error('current_trial_exact_piece_edits_required');
    if (actions.length !== localDirector.music_actions.length || new Set(actions.map(row => row.action_id)).size !== actions.length
      || !localDirector.music_actions.every(action => actions.some(row => row.action_id === action.id
        && JSON.stringify(row.target_range) === JSON.stringify(action.target_range) && musicIds.has(row.music_task_cue_id))))
      throw new Error('current_trial_exact_action_responses_required');
    if (response.value.edits.sounds.length) throw new Error('current_trial_music_editor_cannot_invent_sounds');
    if (v2) {
      reviewPending.push(...[...response.value.review_pending, ...response.value.edits.uncertainties]
        .map((text, index) => ({ cue_id: cue.cue_id, item_id: `review:${index}`, text,
          actual_editor_response: response.raw_response, review_contract: 'research_unknowns_v2' })));
      if (response.value.execution_gaps.length) {
        editingGaps.push({ cue_id: cue.cue_id, execution_gaps: response.value.execution_gaps,
          actual_editor_response: response.raw_response, review_contract: 'research_unknowns_v2' });
        continue;
      }
    }
    const unresolved = v2 ? [] : [...response.value.gaps.map((text, index) => ({ item_id: `gap:${index}`, text })),
      ...response.value.edits.uncertainties.map((text, index) => ({ item_id: `uncertainty:${index}`, text }))];
    if (unresolved.length) {
      const category = objectSchema({ item_id: { type: 'string', enum: unresolved.map(row => row.item_id) },
        reason: { type: 'string' } });
      const schema = objectSchema({ source_response_sha256: { type: 'string', enum: [response.raw_response.sha256] },
        execution_gaps: { type: 'array', items: category }, review_pending: { type: 'array', items: category } });
      const classificationInput = { schema, frames: [],
        instruction: 'Classify every existing unknown once, without changing the supplied plan, selecting music or pretending to hear audio. execution_gaps are missing source identity/window/coverage or an event placement that cannot be executed. review_pending are unresolved narrative fit, musical phrase, masking, seams, sound audit and aesthetic/listening qualification, which remain unapproved in this explicitly music-only research diagnostic. Technical source bounds and exact mother coverage have been mechanically compiled, not artistically approved. Every item_id must appear exactly once in execution_gaps or review_pending; never discard an unknown. This is one sourced contract classification of the existing response, not a new audition.',
        data: { source_video_sha256: sourceSha, source: { path: path.resolve(path.dirname(inputs.manifest.binding.path), manifest.source_video), sha256: sourceSha },
          director: localDirector, original_editor_response: response.raw_response,
          original_plan: response.value.plan, original_edits: response.value.edits, unresolved,
          research_scope: 'music_only_diagnostic', mechanical_arc_status: compiled.status,
          qualification: { audio_listening: false, artistic_approval: false, production_approval: false } } };
      const savedClassification = config.classification_responses?.find(row => row.cue_id === cue.cue_id
        && row.original_editor_response_sha256 === response.raw_response.sha256);
      let classified;
      if (savedClassification) {
        const saved = await readBound(savedClassification.raw_response), request = await readBound(savedClassification.request);
        await verifyEvidenceBindings(saved.value.evidence_files);
        if (request.value.role !== 'current_research_edit_gap_classification'
          || request.value.source_video_sha256 !== sourceSha || request.value.input_sha256 !== saved.value.input_sha256
          || JSON.stringify(request.value.input.data) !== JSON.stringify(classificationInput.data))
          throw new Error('current_trial_saved_classification_input_identity_changed');
        classified = { ...saved.value, raw_response: saved.binding, reused: true, cli_receipts: [] };
      } else classified = await runtime.session.request('current_research_edit_gap_classification', classificationInput);
      validateSchema(classified.value, schema);
      const classificationRaw = await readBound(classified.raw_response);
      if (classified.actual_runtime_executed !== true || classificationRaw.value.actual_runtime_executed !== true
        || classificationRaw.value.completion_status !== 'complete' || classificationRaw.value.source_video_sha256 !== sourceSha
        || classificationRaw.value.qualified !== false || JSON.stringify(classificationRaw.value.value) !== JSON.stringify(classified.value))
        throw new Error('current_trial_actual_gap_classification_required');
      const mapped = [...classified.value.execution_gaps, ...classified.value.review_pending];
      if (mapped.length !== unresolved.length || new Set(mapped.map(row => row.item_id)).size !== unresolved.length
        || mapped.some(row => !row.reason.trim())) throw new Error('current_trial_every_unknown_must_be_preserved');
      const classificationRecord = await saveStable(path.join(cueOutput, 'unknown-classification.json'), {
        original_editor_response: response.raw_response, actual_classification_response: classified.raw_response,
        original_unknowns: unresolved, ...classified.value, production_approval: false });
      editorRecords.push(classified.raw_response);
      reviewPending.push(...classified.value.review_pending.map(row => ({ cue_id: cue.cue_id,
        text: unresolved.find(item => item.item_id === row.item_id).text, ...row, classification: classificationRecord })));
      if (classified.value.execution_gaps.length) {
        const gapRecord = { cue_id: cue.cue_id, execution_gaps: classified.value.execution_gaps,
          original_unknowns: unresolved, actual_editor_response: response.raw_response, classification: classificationRecord };
        if (config.allow_nominal_event_anchors !== true) { editingGaps.push(gapRecord); continue; }
        nominalAlignmentGaps.push({ ...gapRecord, diagnostic_scope: 'nominal_director_timestamps_actual_event_alignment_unverified' });
      }
    }
    arcs.push(...localized.plan.arcs); edits.music_edits.push(...response.value.edits.music_edits);
    acceptedArcSources.push({ actual_editor_response: response.raw_response, arcs: localized.plan.arcs,
      music_edits: response.value.edits.music_edits });
    edits.action_responses.push(...response.value.edits.action_responses);
  }
  if (editingGaps.length) {
    const pending = { status: 'current_director_editing_gap', editing_gaps: editingGaps, prepared_arc_ids: arcs.map(arc => arc.cue_id),
      actual_editor_responses: editorRecords, review_pending: reviewPending, nominal_alignment_gaps: nominalAlignmentGaps,
      missing_cue_ids: missing, missing_target_ranges: missingRanges, production_approval: false };
    await saveStable(path.join(output, `editing-gaps-${digest(handoffs.map(row => row.binding))}.json`), pending);
    return pending;
  }
  if (missing.length || missingRanges.length) {
    const pending = { status: 'awaiting_actual_arc_bindings', missing_cue_ids: missing, missing_target_ranges: missingRanges,
      prepared_arc_ids: arcs.map(arc => arc.cue_id), actual_editor_responses: editorRecords,
      review_pending: reviewPending, nominal_alignment_gaps: nominalAlignmentGaps,
      material_binding_gaps: materialGaps, production_approval: false };
    await saveStable(path.join(output, `partial-${digest(handoffs.map(row => row.binding))}.json`), pending);
    return pending;
  }
  const episodeArcs = qualifyEpisodeArcIds(arcs, edits);
  const configOut = { schema_version: 1, strategy: 'current_director_research', output_dir: path.join(output, 'render'),
    // Keep source proofs and explicit trial scope intact across this wrapper. The downstream
    // gate validates them again; dropping either silently converts real origin to unknown.
    ...Object.fromEntries(['cases', 'music_source_scope', 'music_source_provenance', 'python',
      'mode', 'automatic_trial', 'material_strategy', 'music_packs', 'library', 'source_policy',
      'trial_review_policy', 'production_approval', 'purpose']
      .filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]])),
    ...(config.work_identity_evidence ? { work_identity_evidence: config.work_identity_evidence } : {}),
    manifest: inputs.manifest.binding, analysis: inputs.analysis.binding,
    director: await saveJson(path.join(output, 'inputs', 'research-director.json'), { ...director, deferred_words_exploration: deferredWords }),
    current_materials: await saveJson(path.join(output, 'inputs', 'current-materials.json'), materials),
    arc_plan: await saveJson(path.join(output, 'inputs', 'arc-plan.json'), { schema_version: 1, source_video_sha256: sourceSha, arcs: episodeArcs.arcs }),
    edits: await saveJson(path.join(output, 'inputs', 'edits.json'), episodeArcs.edits),
    candidates: await saveJson(path.join(output, 'inputs', 'candidates.json'), { music: candidates, sounds: [], words: [] }),
    case_routes: await saveJson(path.join(output, 'inputs', 'current-routes.json'), { source_video_sha256: sourceSha, routes }),
    evidence_catalog: await saveJson(path.join(output, 'inputs', 'evidence-catalog.json'), catalog),
    craft_mode: 'fine', audience: config.audience, execution: 'host', original_gain_db: config.original_gain_db ?? 0,
    dialogue_intervals: config.dialogue_intervals, research_review_pending: reviewPending,
    allow_nominal_event_anchors: config.allow_nominal_event_anchors === true,
    research_execution_gaps: nominalAlignmentGaps, arc_identity_mapping: episodeArcs.identity_mapping,
    research_action_partition_record: actionPartitionRecord,
    external_arc_connections: externalConnections,
    cross_film_reuse_check: recentMusic,
    trial_scope: { kind: 'music_only_window', target_range: [0, duration],
      reason: 'Whole-episode music-only director diagnostic. Required physical sounds, original source audit and independent listening remain pending.' } };
  const configFile = await saveJson(path.join(output, 'render-config.json'), configOut);
  const record = await renderResearchTrial(configOut, runtime);
  await saveJson(path.join(output, 'consumer-record.json'), { render_config: configFile, actual_editor_responses: editorRecords,
    deferred_words: deferredWords, review_pending: reviewPending, nominal_alignment_gaps: nominalAlignmentGaps,
    arc_handoffs: handoffs.map(row => row.binding), external_arc_connections: externalConnections, record, production_approval: false });
  return record;
}
