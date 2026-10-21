import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { objectSchema, validateSchema, audioBackendMatches } from './audio_api.mjs';

const str = { type: 'string' }, num = { type: 'number' };
const range = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const list = items => ({ type: 'array', items, minItems: 1 });
const connection = objectSchema({ previous_piece_id: str, reason: str });
export const soundArcPlanSchema = objectSchema({
  schema_version: { type: 'integer', enum: [1] }, source_video_sha256: str,
  arcs: list(objectSchema({ arc_id: str, cue_id: str, pieces: list(objectSchema({
    piece_id: str,
    source_window: objectSchema({ segment_id: str, asset_id: str, source_sha256: str,
      candidate_source_range: range, source_range: range }),
    target_range: range, development_role: str,
    connection_from: { ...connection, type: ['object', 'null'] },
  })) })),
});

// Version 1 stays unchanged. Version 2 makes the executed connection an explicit choice.
export const soundArcPlanV2Schema = structuredClone(soundArcPlanSchema);
soundArcPlanV2Schema.properties.schema_version.enum = [2];
const v2Piece = soundArcPlanV2Schema.properties.arcs.items.properties.pieces.items;
v2Piece.properties.source_window.type = ['object', 'null'];
v2Piece.properties.silence_reason = { type: ['string', 'null'] };
v2Piece.required.push('silence_reason');
v2Piece.properties.connection_from = { ...objectSchema({ previous_piece_id: str,
  type: { type: 'string', enum: ['source_continuation', 'cut', 'crossfade', 'silence'] }, reason: str,
  overlap_seconds: num, from_source_handle_range: { ...range, type: ['array', 'null'] },
  to_source_handle_range: { ...range, type: ['array', 'null'] },
  fade_curve: { type: 'string', enum: ['linear', 'raised_cosine', 'equal_power'] },
}), type: ['object', 'null'] };

const RATE = 48000;
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const samples = r => r.map(v => Math.round(v * RATE));
const validRange = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)
  && r[0] >= 0 && r[1] > r[0] && samples(r)[1] > samples(r)[0];
const sameRange = (a, b) => validRange(a) && validRange(b) && a.every((v, i) => v === b[i]);
const sameSampleRange = (a, b) => validRange(a) && validRange(b)
  && samples(a).every((value, index) => value === samples(b)[index]);
const within = (inner, outer) => validRange(inner) && validRange(outer)
  && inner[0] >= outer[0] && inner[1] <= outer[1];
const overlap = (a, b) => a[0] < b[1] && a[1] > b[0];
const requireFact = (condition, reason) => { if (!condition) throw new Error(`sound_arc_${reason}`); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wordsFields = ['words_candidate_request', 'words_target_range', 'words_mode', 'words_function',
  'words_audio_retrieval_query', 'words_complete_phrase_required'];

function validateV2Connection(before, after) {
  const link = after.connection_from;
  requireFact(before ? link?.previous_piece_id === before.piece_id && text(link.reason) : link === null,
    'explicit_previous_piece_connection_required');
  if (!before) return;
  const left = before.source_window, right = after.source_window;
  if (link.type !== 'crossfade') {
    requireFact(link.overlap_seconds === 0 && link.from_source_handle_range === null
      && link.to_source_handle_range === null, 'non_crossfade_must_not_claim_overlap_or_handles');
    if (link.type === 'silence') requireFact(left === null || right === null, 'silence_connection_requires_narrative_silence_piece');
    else requireFact(left !== null && right !== null, 'silence_piece_requires_silence_connection');
    if (link.type === 'source_continuation') requireFact(left.source_sha256 === right.source_sha256
      && samples(left.source_range)[1] === samples(right.source_range)[0],
    'source_continuation_requires_same_recording_and_exact_source_position');
    return;
  }
  requireFact(left !== null && right !== null, 'crossfade_requires_two_real_sources');
  const outgoing = link.from_source_handle_range, incoming = link.to_source_handle_range;
  requireFact(validRange(outgoing) && validRange(incoming)
    && samples(outgoing)[0] === samples(left.source_range)[1]
    && samples(incoming)[1] === samples(right.source_range)[0], 'adjacent_source_handles_required');
  const tail = samples(outgoing)[1] - samples(outgoing)[0], lead = samples(incoming)[1] - samples(incoming)[0];
  requireFact(link.overlap_seconds > 0 && Math.round(link.overlap_seconds * RATE) === tail + lead,
    'positive_exact_crossfade_overlap_required');
  requireFact(lead <= samples(before.target_range)[1] - samples(before.target_range)[0]
    && tail <= samples(after.target_range)[1] - samples(after.target_range)[0], 'crossfade_overlap_outside_neighbor_core');
  for (const [piece, handle] of [[before, outgoing], [after, incoming]]) requireFact(
    within(handle, piece.candidate_observed_source_range)
    && within(handle, piece.source_window.candidate_source_range)
    && (!piece.library_allowed_source_range || within(handle, piece.library_allowed_source_range)),
  'crossfade_handle_outside_observed_source');
}

// Compile explicit director choices. Source/audio truth is checked by the existing formal route.
export function compileSoundArcPlan({ plan, director, candidates, wordsCandidates, seamObservations = [] }) {
  const v2 = plan?.schema_version === 2;
  validateSchema(plan, v2 ? soundArcPlanV2Schema : soundArcPlanSchema, 'sound_arc_plan');
  requireFact(sha(plan.source_video_sha256) && plan.source_video_sha256 === director?.source_video_sha256,
    'current_video_binding_required');
  requireFact(Array.isArray(director.cues) && director.cues.length && Array.isArray(candidates), 'current_cues_and_candidates_required');
  requireFact(wordsCandidates === undefined || Array.isArray(wordsCandidates), 'explicit_words_candidates_required');
  const mothers = new Map(director.cues.map(c => [c.cue_id, c]));
  requireFact(mothers.size === director.cues.length && director.cues.every(c => text(c.cue_id)
    && validRange(c.target_range) && c.music_role !== 'words_candidate'), 'unique_original_mother_cues_required');
  requireFact(plan.arcs.length === mothers.size && new Set(plan.arcs.map(a => a.cue_id)).size === mothers.size
    && plan.arcs.every(a => mothers.has(a.cue_id)), 'exact_mother_cue_coverage_required');
  requireFact(new Set(plan.arcs.map(a => a.arc_id)).size === plan.arcs.length, 'unique_arc_ids_required');
  const splitCues = [], arcs = [], seams = [], silenceRanges = [], pendingWordsExplorations = [], globalPieceIds = new Set(), cueIds = new Set(mothers.keys());
  for (const arc of plan.arcs) {
    requireFact(text(arc.arc_id), 'arc_id_required');
    const mother = mothers.get(arc.cue_id), pieces = [], ids = new Set();
    let end = samples(mother.target_range)[0];
    // Explicit admitted words supply distinguishes an exploration placement from
    // a selected phrase. Missing context retains the historical compiler contract.
    const noSelectedExplore = v2 && director.direction_version === 2 && mother.words_candidate_request === 'explore'
      && Array.isArray(wordsCandidates) && !wordsCandidates.some(row => row.parent_cue_id === mother.cue_id
        || row.cue_id === `${mother.cue_id}/words`);
    if (noSelectedExplore && mother.words_target_range != null)
      requireFact(within(mother.words_target_range, mother.target_range), 'valid_original_words_task_required');
    const wordsTarget = noSelectedExplore ? null : mother.words_target_range;
    const boundedExploration = v2 && director.direction_version === 2 && mother.words_candidate_request === 'explore'
      && wordsTarget === null && !!mother.words_opportunity;
    requireFact(wordsTarget != null || boundedExploration || !['require', 'explore'].includes(mother.words_candidate_request),
      'words_request_requires_explicit_target_window');
    if (boundedExploration) {
      const opportunity = mother.words_opportunity;
      requireFact(Array.isArray(opportunity.allowed_target_intervals) && opportunity.allowed_target_intervals.length > 0
        && opportunity.allowed_target_intervals.every(interval => within(interval, mother.target_range))
        && Array.isArray(opportunity.anchor_event_ids) && opportunity.anchor_event_ids.length > 0
        && opportunity.anchor_event_ids.every(id => text(id) && mother.story_beat_ids?.includes(id)),
      'valid_words_exploration_opportunity_required');
      // A permitted exploration interval is not a selected phrase placement.
      // Keep the unresolved parent task distinct from compiled music pieces.
      pendingWordsExplorations.push({ cue_id: mother.cue_id, request: 'explore',
        ...(noSelectedExplore && mother.words_target_range != null
          ? { proposed_target_range: [...mother.words_target_range], selected_words_candidate: false } : {}),
        allowed_target_intervals: structuredClone(opportunity.allowed_target_intervals),
        anchor_event_ids: [...opportunity.anchor_event_ids], status: 'exploration_pending_no_selected_phrase',
        lyric_content_approved: false, production_approval: false });
    }
    if (wordsTarget != null) requireFact(within(wordsTarget, mother.target_range)
      && ['require', 'explore'].includes(mother.words_candidate_request), 'valid_original_words_task_required');
    const wordsOwners = wordsTarget == null ? [] : arc.pieces.filter(p => within(wordsTarget, p.target_range));
    if (wordsTarget != null) requireFact(wordsOwners.length === 1, 'whole_words_window_requires_one_piece');
    for (const piece of arc.pieces) {
      requireFact(text(piece.piece_id) && !ids.has(piece.piece_id) && text(piece.development_role), 'unique_piece_and_development_required');
      ids.add(piece.piece_id);
      if (v2) {
        requireFact(!globalPieceIds.has(piece.piece_id), 'globally_unique_v2_piece_ids_required');
        globalPieceIds.add(piece.piece_id);
      }
      requireFact(within(piece.target_range, mother.target_range), 'piece_target_outside_mother');
      const target = samples(piece.target_range);
      requireFact(target[0] === end, 'mother_music_coverage_gap_or_overlap');
      end = target[1];
      const wanted = piece.source_window;
      if (v2 && wanted === null) {
        requireFact(text(piece.silence_reason), 'narrative_silence_reason_required');
        requireFact(wordsTarget == null || !overlap(wordsTarget, piece.target_range), 'words_task_cannot_be_silenced');
        const compiled = { ...structuredClone(piece), cue_id: null, parent_cue_id: mother.cue_id };
        pieces.push(compiled); silenceRanges.push({ arc_id: arc.arc_id, piece_id: piece.piece_id,
          target_range: [...piece.target_range], reason: piece.silence_reason });
        continue;
      }
      if (v2) requireFact(piece.silence_reason === null, 'music_piece_must_not_claim_narrative_silence');
      requireFact(text(wanted.segment_id) && text(wanted.asset_id) && sha(wanted.source_sha256)
        && within(wanted.source_range, wanted.candidate_source_range), 'valid_frozen_source_window_required');
      const matches = candidates.filter(c => c.cue_id === mother.cue_id && c.segment_id === wanted.segment_id
        && c.asset_id === wanted.asset_id && c.source_sha256 === wanted.source_sha256
        && sameSampleRange(c.case_source_range ?? c.source_range, wanted.candidate_source_range));
      requireFact(matches.length > 0, 'stale_or_unknown_candidate_source');
      const candidate = matches.find(item => !item.allowed_target_range || within(piece.target_range, item.allowed_target_range));
      requireFact(candidate, 'piece_target_outside_actual_candidate_task');
      requireFact(within(wanted.source_range, candidate.source_range)
        && (!candidate.library_allowed_source_range || within(wanted.source_range, candidate.library_allowed_source_range)),
      'source_outside_current_candidate_window');
      const source = samples(wanted.source_range);
      requireFact(source[1] - source[0] >= target[1] - target[0], 'source_window_too_short_no_implicit_loop');
      requireFact(source[1] - source[0] === target[1] - target[0], 'source_and_target_sample_lengths_must_match');
      const previous = pieces.at(-1);
      if (!v2) requireFact(previous ? piece.connection_from?.previous_piece_id === previous.piece_id && text(piece.connection_from.reason)
        : piece.connection_from === null, 'explicit_previous_piece_connection_required');
      const cueId = `${mother.cue_id}/arc/${arc.arc_id}/${piece.piece_id}`;
      requireFact(!cueIds.has(cueId), 'compiled_cue_id_conflict'); cueIds.add(cueId);
      const cue = structuredClone(mother);
      for (const key of wordsFields) delete cue[key];
      if (boundedExploration) delete cue.words_opportunity;
      if (wordsOwners[0] === piece) for (const key of wordsFields) if (key in mother) cue[key] = structuredClone(mother[key]);
      Object.assign(cue, { cue_id: cueId, arc_parent_cue_id: mother.cue_id, arc_id: arc.arc_id,
        piece_id: piece.piece_id, target_range: [...piece.target_range], development_role: piece.development_role,
        requested_candidates: [{ segment_id: wanted.segment_id, asset_id: wanted.asset_id,
          source_sha256: wanted.source_sha256, source_range: [...wanted.source_range] }] });
      if (candidate.route_kind) Object.assign(cue, { material_route_kind: candidate.route_kind,
        material_preset_id: candidate.preset_id, material_condition_binding: candidate.condition_binding });
      if (cue.query) Object.assign(cue.query, { min_duration: piece.target_range[1] - piece.target_range[0],
        candidate_segment_ids: [wanted.segment_id] });
      if (Array.isArray(director.music_actions) && Array.isArray(cue.required_action_ids)) {
        requireFact(cue.required_action_ids.every(id => director.music_actions.some(a => a.id === id && validRange(a.target_range))),
          'current_parent_music_actions_required');
        cue.required_action_ids = cue.required_action_ids.filter(id => director.music_actions.some(a => a.id === id
          && validRange(a.target_range) && overlap(a.target_range, piece.target_range)));
      }
      splitCues.push(cue);
      const compiled = { ...structuredClone(piece), cue_id: cueId, parent_cue_id: mother.cue_id };
      if (candidate.route_kind) compiled.material_route = { route_kind: candidate.route_kind,
        preset_id: candidate.preset_id, condition_binding: candidate.condition_binding };
      if (v2) Object.assign(compiled, { candidate_observed_source_range: [...candidate.source_range],
        library_allowed_source_range: candidate.library_allowed_source_range ? [...candidate.library_allowed_source_range] : null });
      pieces.push(compiled);
      if (previous && !v2) {
        const pair = { source_video_sha256: plan.source_video_sha256, arc_id: arc.arc_id,
          from_cue_id: previous.cue_id, to_cue_id: cueId,
          from_source_window: previous.source_window, to_source_window: compiled.source_window,
          from_target_range: previous.target_range, to_target_range: compiled.target_range,
          connection_reason: piece.connection_from.reason };
        seams.push({ seam_id: `${arc.arc_id}/${previous.piece_id}->${piece.piece_id}`, ...pair,
          target_seconds: piece.target_range[0], pair_binding_sha256: digest(pair) });
      }
    }
    requireFact(end === samples(mother.target_range)[1], 'mother_music_coverage_incomplete');
    arcs.push({ arc_id: arc.arc_id, parent_cue_id: mother.cue_id,
      parent_target_range: [...mother.target_range], original_cue: structuredClone(mother), pieces });
  }
  // A parent-cue boundary is still a real music join. It must not disappear from paired mix review.
  const episodePieces = arcs.flatMap(arc => arc.pieces.map(piece => ({ arc_id: arc.arc_id, piece })))
    .sort((a, b) => a.piece.target_range[0] - b.piece.target_range[0]);
  if (v2) for (let index = 0; index < episodePieces.length; index++) {
    const before = episodePieces[index - 1], after = episodePieces[index];
    if (before) requireFact(samples(before.piece.target_range)[1] === samples(after.piece.target_range)[0],
      'v2_episode_core_coverage_gap_or_overlap');
    validateV2Connection(before?.piece, after.piece);
    if (!before) continue;
    const pair = { source_video_sha256: plan.source_video_sha256, arc_id: after.arc_id,
      seam_type: before.arc_id === after.arc_id ? 'within_arc' : 'between_arcs',
      from_cue_id: before.piece.cue_id, to_cue_id: after.piece.cue_id,
      from_piece_id: before.piece.piece_id, to_piece_id: after.piece.piece_id,
      from_source_window: before.piece.source_window, to_source_window: after.piece.source_window,
      from_target_range: before.piece.target_range, to_target_range: after.piece.target_range,
      connection_reason: after.piece.connection_from.reason,
      connection: structuredClone(after.piece.connection_from) };
    seams.push({ seam_id: `${before.arc_id}->${after.arc_id}/${before.piece.piece_id}->${after.piece.piece_id}`,
      ...pair, target_seconds: after.piece.target_range[0], pair_binding_sha256: digest(pair) });
  }
  for (let index = 1; index < episodePieces.length; index++) {
    if (v2) break;
    const left = episodePieces[index - 1], right = episodePieces[index];
    if (left.arc_id === right.arc_id || samples(left.piece.target_range)[1] !== samples(right.piece.target_range)[0]) continue;
    const pair = { source_video_sha256: plan.source_video_sha256, arc_id: `${left.arc_id}->${right.arc_id}`,
      seam_type: 'between_arcs', from_cue_id: left.piece.cue_id, to_cue_id: right.piece.cue_id,
      from_source_window: left.piece.source_window, to_source_window: right.piece.source_window,
      from_target_range: left.piece.target_range, to_target_range: right.piece.target_range,
      connection_reason: 'Adjacent parent arcs require actual paired transition review.' };
    seams.push({ seam_id: `${pair.arc_id}/${left.piece.piece_id}->${right.piece.piece_id}`, ...pair,
      target_seconds: right.piece.target_range[0], pair_binding_sha256: digest(pair) });
  }
  const arcManifest = { schema_version: v2 ? 2 : 1, source_video_sha256: plan.source_video_sha256, arcs, seams,
    production_approval: false, artistic_acceptance: 'not_assessed', evidence_scope: 'explicit_planning_records_only' };
  if (v2) {
    arcManifest.silence_ranges = silenceRanges;
    arcManifest.pending_words_explorations = pendingWordsExplorations;
  }
  const checked = validateSoundArcSeams({ arcManifest, seamObservations });
  return { splitCues, arcManifest, seams, ...checked };
}

function boundFile(binding) {
  requireFact(binding && path.isAbsolute(binding.path ?? '') && sha(binding.sha256), 'absolute_evidence_file_binding_required');
  const bytes = readFileSync(binding.path);
  requireFact(createHash('sha256').update(bytes).digest('hex') === binding.sha256, 'evidence_file_hash_mismatch');
  return bytes;
}
const boundJson = binding => JSON.parse(boundFile(binding).toString('utf8').replace(/^\uFEFF/, ''));

// These are receipt checks; even a valid receipt does not independently prove musical fit.
export function validateSoundArcSeams({ arcManifest, seamObservations = [] }) {
  requireFact(sha(arcManifest?.source_video_sha256) && Array.isArray(arcManifest.seams)
    && Array.isArray(seamObservations), 'seam_records_required');
  const pending = [], observations = [];
  for (const supplied of seamObservations) requireFact(arcManifest.seams.some(s => s.seam_id === supplied?.seam_id), 'unknown_seam_observation');
  for (const seam of arcManifest.seams) {
    const matches = seamObservations.filter(r => r.seam_id === seam.seam_id);
    if (!matches.length) { pending.push({ seam_id: seam.seam_id, reason: 'actual_paired_seam_observation_required' }); continue; }
    requireFact(matches.length === 1, 'duplicate_seam_observation');
    const supplied = matches[0];
    try {
      requireFact(supplied.pair_binding_sha256 === seam.pair_binding_sha256, 'stale_seam_pair_binding');
      const record = boundJson(supplied.observation_record), qualification = boundJson(supplied.qualification_record);
      requireFact(record.actual_audio_processed === true && record.completion_status === 'complete'
        && record.finish_reason === 'complete' && record.purpose === 'mix' && text(record.request_id), 'complete_actual_mix_observation_required');
      requireFact(record.source_video_sha256 === arcManifest.source_video_sha256
        && validRange(record.source_range) && record.source_range[0] < seam.target_seconds
        && record.source_range[1] > seam.target_seconds, 'current_mix_window_must_cover_both_seam_sides');
      requireFact(qualification.status === 'qualified' && audioBackendMatches(record, qualification)
        && ['audio_observation', 'music_candidate_judgment'].every(s => qualification.scopes?.includes(s)), 'qualified_mix_listener_required');
      boundFile(record.input_audio);
      boundFile(record.synchronized_video);
      requireFact(record.synchronized_video.source_video_sha256 === arcManifest.source_video_sha256
        && record.synchronized_video.source_audio_sha256 === record.source_sha256
        && sameRange(record.synchronized_video.source_range, record.source_range), 'actual_synchronized_mix_binding_required');
      const receipt = boundJson(record.api_evidence);
      const response = boundJson(receipt.raw_response);
      requireFact(receipt.audio_sha256 === record.input_audio.sha256 && receipt.source_sha256 === record.source_sha256
        && sameRange(receipt.source_window, record.source_range) && receipt.request_id === record.request_id
        && receipt.model === record.model && audioBackendMatches(receipt, qualification)
        && audioBackendMatches(record.execution, qualification) && record.execution?.actual_audio_processed === true
        && record.execution.audio_sha256 === record.input_audio.sha256
        && record.execution.request_id === record.request_id && receipt.finish_reason === 'complete'
        && response.id === record.request_id && response.status === 'completed'
        && !(response.steps ?? []).some(item => item.status && item.status !== 'completed'), 'actual_submission_receipt_binding_required');
      const outputs = response.steps?.filter(step => step.type === 'model_output').flatMap(step => step.content ?? []) ?? response.outputs;
      requireFact(Array.isArray(outputs) && outputs.length > 0 && !outputs.some(item => item.type === 'refusal'),
        'actual_mix_response_output_required');
      const responseText = outputs.filter(item => ['text', 'output_text'].includes(item.type)).map(item => item.text).join('');
      requireFact(responseText.trim() && JSON.stringify(JSON.parse(responseText)) === JSON.stringify(record.observation),
        'actual_mix_response_observation_mismatch');
      requireFact(text(record.observation?.description) && Array.isArray(record.observation.issues)
        && Array.isArray(record.observation.uncertainties) && !record.observation.uncertainties.length, 'resolved_actual_seam_description_required');
      const boundary = seam.target_seconds - record.source_range[0];
      requireFact(!record.observation.issues.some(issue => !Number.isFinite(issue.start_seconds) || !Number.isFinite(issue.end_seconds)
        || issue.start_seconds <= boundary && issue.end_seconds >= boundary), 'observed_seam_needs_revision');
      observations.push({ seam_id: seam.seam_id, pair_binding_sha256: seam.pair_binding_sha256,
        observation_record: supplied.observation_record, qualification_record: supplied.qualification_record,
        status: 'verified_records_only' });
    } catch (error) { pending.push({ seam_id: seam.seam_id, reason: error.code ?? error.message }); }
  }
  return { status: pending.length ? 'awaiting_arc_observations' : 'compiled_records_only', pending,
    seamObservations: observations, production_approval: false, artistic_acceptance: 'not_assessed' };
}
