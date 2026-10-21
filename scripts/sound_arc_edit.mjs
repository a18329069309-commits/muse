import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extendGainEnvelope, validateGainEnvelope } from './music_edit_operation_contract.mjs';

const RATE = 48000, sample = value => Math.round(value * RATE), seconds = value => value / RATE;
const span = range => range.map(sample);
const valid = range => Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)
  && range[0] >= 0 && sample(range[1]) > sample(range[0]);
const contains = (outer, inner) => valid(outer) && valid(inner)
  && span(outer)[0] <= span(inner)[0] && span(outer)[1] >= span(inner)[1];
const fail = reason => { throw new Error(`sound_arc_edit_${reason}`); };
const need = (condition, reason) => { if (!condition) fail(reason); };
const cueRange = cue => [sample(cue.start_seconds), sample(cue.start_seconds)
  + sample(cue.source_out_seconds) - sample(cue.source_in_seconds)];
const readBound = binding => {
  need(binding && path.isAbsolute(binding.path ?? '') && /^[a-f0-9]{64}$/i.test(binding.sha256 ?? ''), 'bound_observation_file_required');
  const bytes = readFileSync(binding.path);
  need(createHash('sha256').update(bytes).digest('hex') === binding.sha256, 'evidence_file_hash_mismatch');
  return bytes;
};
function observationFor(selected) {
  const binding = selected.observation_record?.file ?? selected.observation_record;
  const record = JSON.parse(readBound(binding).toString('utf8').replace(/^\uFEFF/, ''));
  need(record.actual_audio_processed === true && record.source_sha256 === selected.source_sha256
    && contains(record.source_range, selected.source_range), 'actual_source_observation_binding_required');
  let vocal = record.observation?.vocal_type ?? 'unknown', words = [];
  if (record.protocol === 'offline_human_review') {
    need(record.origin === 'human' && record.actual_audio_listened === true
      && record.actual_model_audio_inference === false, 'explicit_offline_human_origin_required');
    readBound(record.human_review_record);
    need(record.source_audio?.sha256 === selected.source_sha256, 'offline_source_audio_identity_required');
    readBound(record.source_audio);
    vocal = record.music_form === 'instrumental' ? 'none'
      : ['short_lyrics', 'spoken_adlib'].includes(record.music_form) ? 'sung' : 'unknown';
    if (vocal === 'sung') {
      need(record.words?.complete_phrase === true && record.words.actual_words?.trim()
        && contains(record.source_range, record.words.source_range), 'actual_complete_words_range_required');
      words = [{ source_range: record.words.source_range }];
    }
  } else {
    const start = record.source_range[0], length = record.source_range[1] - start;
    for (const word of record.observation?.words ?? []) {
      need(Number.isFinite(word.start_seconds) && Number.isFinite(word.end_seconds)
        && word.start_seconds >= 0 && word.end_seconds > word.start_seconds && word.end_seconds <= length
        && sample(word.end_seconds) > sample(word.start_seconds), 'positive_actual_word_interval_required');
      if (word.kind === 'sung') words.push({ source_range: [start + word.start_seconds, start + word.end_seconds] });
    }
  }
  return { source_range: record.source_range, vocal, words };
}
function wordBoundaries(observation, range) {
  const bounds = span(range);
  for (const word of observation.words) {
    const actual = span(word.source_range);
    need(!bounds.some(bound => actual[0] < bound && actual[1] > bound), 'edit_cuts_actual_sung_words');
  }
}

const MAX_GAIN_SMOOTH_SIDE = Math.round(.05 * RATE);
function gainJoin(left, right) {
  let before = Math.min(MAX_GAIN_SMOOTH_SIDE, Math.floor((left.end - left.start) / 2));
  const after = Math.min(MAX_GAIN_SMOOTH_SIDE, Math.floor((right.end - right.start) / 2));
  if (before + after === 0) before = 1; // One-sample pieces cannot borrow outside their source.
  return { start: left.end - before, end: right.start + after };
}
function continuousGainEnvelope(segments, baseGain) {
  const points = new Map(), origin = segments[0].start;
  const add = (at, gain) => {
    need(!points.has(at) || points.get(at) === gain, 'technical_gain_smoothing_overlap');
    points.set(at, gain);
  };
  add(origin, segments[0].gain);
  for (let index = 1; index < segments.length; index++) {
    const left = segments[index - 1], right = segments[index];
    need(left.end === right.start && left.end > left.start && right.end > right.start,
      'continuous_authored_gain_ranges_required');
    if (left.gain !== right.gain) {
      const join = gainJoin(left, right);
      add(join.start, left.gain); add(join.end, right.gain);
    }
  }
  add(segments.at(-1).end, segments.at(-1).gain);
  return [...points].sort((a, b) => a[0] - b[0]).map(([at, gain]) => ({
    offset_seconds: seconds(at - origin), gain_db: gain - baseGain }));
}

// Concatenate actual piecewise dB operands, not source-artistic descriptions.
// The renderer rounds point positions to this same sample clock. A matching
// absolute endpoint is required: smoothing an authored boundary would change
// its actual curve, unlike the legacy constant-gain join below.
function mergeAuthoredGainEnvelopes(left, right) {
  const leftLength = cueRange(left)[1] - cueRange(left)[0];
  const rightLength = cueRange(right)[1] - cueRange(right)[0];
  const leftBase = left.gain_db ?? 0, rightBase = right.gain_db ?? 0;
  need(Number.isFinite(leftBase) && Number.isFinite(rightBase), 'finite_authored_gain_required');
  const pointsFor = (cue, length, base) => cue.gain_envelope === undefined
    ? [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: seconds(length), gain_db: 0 }]
    : validateGainEnvelope(cue.gain_envelope, seconds(length), base);
  const leftPoints = pointsFor(left, leftLength, leftBase);
  const rightPoints = pointsFor(right, rightLength, rightBase);
  const terminalGain = leftBase + leftPoints.at(-1).gain_db;
  need(terminalGain === rightBase + rightPoints[0].gain_db,
    'source_continuation_authored_gain_boundary_mismatch');
  const points = leftPoints.map(point => ({ offset_seconds: seconds(sample(point.offset_seconds)), gain_db: point.gain_db }));
  for (const point of rightPoints.slice(1)) points.push({
    offset_seconds: seconds(leftLength + sample(point.offset_seconds)),
    gain_db: rightBase - leftBase + point.gain_db,
  });
  return { points: validateGainEnvelope(points, seconds(leftLength + rightLength), leftBase),
    evidence: { kind: 'piecewise_linear_db_preserved', boundary_gain_db: terminalGain,
      right_offset_shift_samples: leftLength, output_base_gain_db: leftBase,
      left_base_gain_db: leftBase, right_base_gain_db: rightBase,
      left_gain_envelope: left.gain_envelope === undefined ? null : structuredClone(left.gain_envelope),
      right_gain_envelope: right.gain_envelope === undefined ? null : structuredClone(right.gain_envelope),
      source_and_video_clock_changed: false, artistic_approval: false } };
}

// This is source/placement arithmetic. It never grants listening or artistic qualification.
export function applySoundArcEdits({ arcManifest, cues, selections, routes, duration, researchSeamReview }) {
  if (arcManifest?.schema_version !== 2) return { cues, selections, transitions: [], edit_receipt: null };
  need(Number.isFinite(duration) && duration > 0 && Array.isArray(cues) && Array.isArray(selections)
    && Array.isArray(routes?.cues), 'current_edit_inputs_required');
  const output = structuredClone(cues), selectedRows = structuredClone(selections), routeMap = new Map(routes.cues.map(row => [row.cue_id, row.selected]));
  const pieces = arcManifest.arcs.flatMap(arc => arc.pieces).sort((a, b) => a.target_range[0] - b.target_range[0]);
  const pieceRows = new Map(), aliases = new Map(output.map(cue => [cue.id, cue.id])), removed = new Set(), connections = [];
  const observations = new Map();
  // Legacy constant-gain joins may rebuild only their own generated automation.
  // Caller-authored curves use exact piecewise concatenation instead.
  const gainModels = new Map(), generatedEnvelopes = new Set();
  const gainSegments = cue => {
    if (!gainModels.has(cue.id)) {
      const [start, end] = cueRange(cue), gain = cue.gain_db ?? 0;
      need(Number.isFinite(gain), 'finite_authored_gain_required');
      gainModels.set(cue.id, [{ start, end, gain, original_plan_cue_id: cue.id }]);
    }
    return gainModels.get(cue.id);
  };
  const rebuildGain = cue => {
    const model = gainModels.get(cue.id);
    if (model.some(part => part.gain !== model[0].gain)) {
      cue.gain_envelope = continuousGainEnvelope(model, cue.gain_db ?? 0);
      generatedEnvelopes.add(cue.id);
    }
  };
  const actualObservation = selected => {
    if (!observations.has(selected)) observations.set(selected, observationFor(selected));
    return observations.get(selected);
  };
  const rowTask = new Map(selections.map(row => [row.plan_cue_id, row.music_task_cue_id]));
  need(rowTask.size === selections.length && new Set(output.map(row => row.id)).size === output.length, 'unique_music_edit_bindings_required');
  let total = 0, previousEnd = null;
  for (const piece of pieces) {
    need(valid(piece.target_range) && piece.target_range[1] <= duration, 'core_target_outside_timeline');
    const target = span(piece.target_range);
    need(previousEnd === null || previousEnd === target[0], 'core_coverage_gap_or_overlap');
    previousEnd = target[1]; total += target[1] - target[0];
    if (piece.source_window === null) {
      need(typeof piece.silence_reason === 'string' && piece.silence_reason.trim(), 'narrative_silence_reason_required');
      need(!output.some(cue => cue.track === 'bgm' && cueRange(cue)[0] < target[1] && cueRange(cue)[1] > target[0]), 'narrative_silence_must_not_contain_music');
      pieceRows.set(piece.piece_id, []); continue;
    }
    const source = piece.source_window, selected = routeMap.get(piece.cue_id);
    need(selected && selected.source_sha256 === source.source_sha256
      && selected.asset_id === source.asset_id && contains(selected.source_range, source.source_range), 'current_selected_piece_identity_required');
    const rows = output.filter(cue => cue.track === 'bgm' && [piece.cue_id, `${piece.cue_id}/words`].includes(rowTask.get(cue.id)))
      .sort((a, b) => a.start_seconds - b.start_seconds);
    let end = target[0];
    for (const cue of rows) {
      const actual = cueRange(cue);
      need(actual[0] === end && actual[1] <= target[1], 'actual_piece_core_coverage_gap_or_overlap');
      end = actual[1];
      const candidate = routeMap.get(rowTask.get(cue.id));
      need(candidate && cue.asset_id === candidate.asset_id
        && contains(candidate.source_range, [cue.source_in_seconds, cue.source_out_seconds]), 'actual_edit_outside_selected_piece');
      if (rowTask.get(cue.id) === piece.cue_id) need(sample(cue.source_in_seconds) === sample(source.source_range[0]) + actual[0] - target[0],
        'actual_source_position_does_not_match_core');
    }
    need(end === target[1], 'actual_piece_core_coverage_incomplete');
    pieceRows.set(piece.piece_id, rows);
  }
  const resolveCue = cue => output.find(item => item.id === aliases.get(cue.id));
  for (let index = 1; index < pieces.length; index++) {
    const before = pieces[index - 1], after = pieces[index], link = after.connection_from;
    need(link?.previous_piece_id === before.piece_id && typeof link.reason === 'string' && link.reason.trim(), 'explicit_current_connection_required');
    const leftRaw = pieceRows.get(before.piece_id).at(-1), rightRaw = pieceRows.get(after.piece_id)[0];
    if (link.type === 'silence') {
      need(before.source_window === null || after.source_window === null, 'silence_connection_requires_silent_piece');
      connections.push({ type: 'silence', from_piece_id: before.piece_id, to_piece_id: after.piece_id,
        reason: link.reason, target_seconds: after.target_range[0] }); continue;
    }
    need(leftRaw && rightRaw, 'real_music_connection_required');
    const left = resolveCue(leftRaw), right = resolveCue(rightRaw), boundary = sample(after.target_range[0]);
    const leftSelected = routeMap.get(rowTask.get(leftRaw.id)), rightSelected = routeMap.get(rowTask.get(rightRaw.id));
    need(['source_continuation', 'cut', 'crossfade'].includes(link.type), 'explicit_connection_type_required');
    const item = { type: link.type, from_piece_id: before.piece_id, to_piece_id: after.piece_id,
      from_original_plan_cue_id: leftRaw.id, to_original_plan_cue_id: rightRaw.id,
      target_seconds: seconds(boundary), reason: link.reason };
    if (link.type === 'source_continuation') {
      need(leftSelected.source_sha256 === rightSelected.source_sha256
        && cueRange(left)[1] === cueRange(right)[0]
        && sample(left.source_out_seconds) === sample(right.source_in_seconds),
      'source_continuation_requires_same_recording_and_exact_source_position');
      const authored = left.gain_envelope !== undefined && !generatedEnvelopes.has(left.id)
        || right.gain_envelope !== undefined && !generatedEnvelopes.has(right.id);
      if (authored) {
        const merged = mergeAuthoredGainEnvelopes(left, right);
        left.gain_envelope = merged.points;
        item.authored_gain_envelope_merge = merged.evidence;
        gainModels.delete(left.id); gainModels.delete(right.id);
        generatedEnvelopes.delete(left.id); generatedEnvelopes.delete(right.id);
      } else {
        const leftModel = gainSegments(left), rightModel = gainSegments(right);
        const previousGain = leftModel.at(-1), nextGain = rightModel[0];
        if (previousGain.gain !== nextGain.gain) {
          const smoothing = gainJoin(previousGain, nextGain);
          item.technical_gain_smoothing = { kind: 'linear_db_on_continuous_source',
            target_range: [seconds(smoothing.start), seconds(smoothing.end)],
            from_gain_db: previousGain.gain, to_gain_db: nextGain.gain,
            maximum_each_side_seconds: .05, source_and_video_clock_changed: false,
            artistic_approval: false };
        }
        leftModel.push(...rightModel); gainModels.delete(right.id);
      }
      left.source_out_seconds = right.source_out_seconds; left.fade_out_seconds = right.fade_out_seconds;
      if (!authored) rebuildGain(left);
      removed.add(right.id);
      for (const [id, current] of aliases) if (current === right.id) aliases.set(id, left.id);
      item.merged_plan_cue_id = left.id; item.internal_fades_removed = true;
    } else {
      const leftObservation = actualObservation(leftSelected), rightObservation = actualObservation(rightSelected);
      if (link.type === 'crossfade') {
        const from = link.from_source_handle_range, to = link.to_source_handle_range;
        need(valid(from) && valid(to) && sample(from[0]) === sample(left.source_out_seconds)
          && sample(to[1]) === sample(right.source_in_seconds), 'adjacent_source_handles_required');
        const tail = span(from)[1] - span(from)[0], lead = span(to)[1] - span(to)[0], overlap = tail + lead;
        need(link.overlap_seconds > 0 && sample(link.overlap_seconds) === overlap, 'positive_exact_crossfade_overlap_required');
        need(contains(leftObservation.source_range, from) && contains(rightObservation.source_range, to)
          && contains(before.candidate_observed_source_range, from) && contains(after.candidate_observed_source_range, to)
          && contains(before.source_window.candidate_source_range, from) && contains(after.source_window.candidate_source_range, to)
          && (!before.library_allowed_source_range || contains(before.library_allowed_source_range, from))
          && (!after.library_allowed_source_range || contains(after.library_allowed_source_range, to)),
        'crossfade_handle_outside_actual_observation');
        if (leftObservation.vocal !== 'none' && rightObservation.vocal !== 'none') {
          let authorized = false;
          if (researchSeamReview?.mode === 'research' && researchSeamReview.pending === true
            && researchSeamReview.source_video_sha256 === arcManifest.source_video_sha256
            && link.overlap_seconds <= .6
            && !(leftObservation.vocal === 'sung' && rightObservation.vocal === 'sung')) {
            const authorization = JSON.parse(readBound(researchSeamReview.authorization).toString('utf8'));
            authorized = authorization.kind === 'direct_human_single_episode_trial_request'
              && authorization.source?.sha256 === arcManifest.source_video_sha256
              && authorization.material_or_listening_approval === false;
          }
          need(authorized, 'two_vocal_sources_must_not_overlap');
          item.potential_vocal_overlap_pending = true;
          item.research_authorization = researchSeamReview.authorization;
          item.vocal_facts_approved = false;
        }
        need(['linear', 'raised_cosine', 'equal_power'].includes(link.fade_curve), 'explicit_crossfade_curve_required');
        // Generated continuous-gain models are extended/rebuilt below. An
        // authored curve has no such model: extend only the verified handles,
        // preserving its core source-clock values instead of truncating it.
        if (left.gain_envelope && !gainModels.has(left.id)) left.gain_envelope = extendGainEnvelope(left.gain_envelope,
          left.source_out_seconds - left.source_in_seconds, left.gain_db ?? 0, 0, seconds(tail));
        if (right.gain_envelope && !gainModels.has(right.id)) right.gain_envelope = extendGainEnvelope(right.gain_envelope,
          right.source_out_seconds - right.source_in_seconds, right.gain_db ?? 0, seconds(lead), 0);
        left.source_out_seconds = seconds(sample(left.source_out_seconds) + tail);
        right.source_in_seconds = seconds(sample(right.source_in_seconds) - lead);
        right.start_seconds = seconds(sample(right.start_seconds) - lead);
        if (gainModels.has(left.id)) { gainModels.get(left.id).at(-1).end += tail; rebuildGain(left); }
        if (gainModels.has(right.id)) { gainModels.get(right.id)[0].start -= lead; rebuildGain(right); }
        left.fade_out_seconds = seconds(overlap); right.fade_in_seconds = seconds(overlap);
        left.fade_curve = link.fade_curve; right.fade_curve = link.fade_curve;
        item.target_overlap_range = [seconds(boundary - lead), seconds(boundary + tail)];
        need(item.target_overlap_range[0] >= before.target_range[0] && item.target_overlap_range[1] <= after.target_range[1],
          'crossfade_overlap_outside_neighbor_core');
      } else need(link.overlap_seconds === 0 && link.from_source_handle_range === null && link.to_source_handle_range === null,
        'cut_must_not_claim_crossfade_handles');
      wordBoundaries(leftObservation, [left.source_in_seconds, left.source_out_seconds]);
      wordBoundaries(rightObservation, [right.source_in_seconds, right.source_out_seconds]);
    }
    connections.push(item);
  }
  const kept = output.filter(cue => !removed.has(cue.id));
  for (const cue of kept) if (cue.track === 'bgm') {
    const range = cueRange(cue), length = range[1] - range[0];
    need(range[0] >= 0 && range[1] <= sample(duration), 'rendered_connection_outside_timeline');
    need(sample(cue.fade_in_seconds) + sample(cue.fade_out_seconds) <= length, 'connection_fades_overlap_inside_piece');
    const actual = selections.filter(row => aliases.get(row.plan_cue_id) === cue.id)
      .map(row => actualObservation(routeMap.get(row.music_task_cue_id)));
    const sourceBounds = span([cue.source_in_seconds, cue.source_out_seconds]);
    let observedEnd = sourceBounds[0];
    for (const window of actual.map(row => span(row.source_range)).sort((a, b) => a[0] - b[0])) {
      if (window[0] <= observedEnd) observedEnd = Math.max(observedEnd, window[1]);
    }
    need(observedEnd >= sourceBounds[1], 'rendered_source_outside_actual_observation');
    for (const observation of actual) wordBoundaries(observation, [cue.source_in_seconds, cue.source_out_seconds]);
    if (cue.parent_plan_cue_id && aliases.has(cue.parent_plan_cue_id)) cue.parent_plan_cue_id = aliases.get(cue.parent_plan_cue_id);
  }
  for (const row of selectedRows) row.plan_cue_id = aliases.get(row.plan_cue_id) ?? row.plan_cue_id;
  const transitions = connections.filter(item => item.type !== 'source_continuation' && item.type !== 'silence').map(item => ({
    from_cue_id: aliases.get(item.from_original_plan_cue_id), to_cue_id: aliases.get(item.to_original_plan_cue_id),
    transition_type: item.type, reason: item.reason, ...(item.target_overlap_range ? { target_overlap_range: item.target_overlap_range } : {}) }));
  return { cues: kept, selections: selectedRows, transitions, edit_receipt: {
    schema_version: 2, core_target_ranges: pieces.map(piece => [...piece.target_range]), core_coverage_samples: total,
    connections, original_selections: structuredClone(selections), production_approval: false,
    authored_gain_segments: [...gainModels].map(([merged_plan_cue_id, segments]) => ({ merged_plan_cue_id,
      segments: segments.map(part => ({ original_plan_cue_id: part.original_plan_cue_id,
        target_range: [seconds(part.start), seconds(part.end)], gain_db: part.gain })) })),
    artistic_acceptance: 'not_assessed', actual_listening_review: 'not_performed',
    evidence_scope: 'source_identity_and_sample_arithmetic_only',
  } };
}
