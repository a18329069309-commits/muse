// Source-window capacity is a technical prerequisite, not song selection or
// permission to loop, stretch, extend a window, or declare a phrase usable.
import { diagnosticWindowReady } from './offline_material_readiness.mjs';

export const independentMusicSupplyRevision = 'ready-source-window-capacity-v1';
const rate = 48000;
const samples = value => Math.round(value * rate);
const fail = code => { throw Error(code); };
const validRange = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && value[0] >= 0 && value[1] > value[0];

export function independentMusicSupplyRequirement(targetRange) {
  if (!validRange(targetRange)) fail('independent_music_supply_target_clock_invalid');
  const target = targetRange.map(samples);
  if (!target.every(Number.isSafeInteger) || target[1] <= target[0])
    fail('independent_music_supply_target_clock_invalid');
  return { revision: independentMusicSupplyRevision, sample_rate: rate,
    target_range_samples: target, required_target_samples: target[1] - target[0],
    scope: 'nonrepeated_ready_source_capacity; actual edits_and_connections_still_required',
    implicit_loop_allowed: false, sound_or_artistic_qualification_granted: false };
}

function union(ranges) {
  const merged = [];
  for (const row of ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && row[0] <= last[1]) last[1] = Math.max(last[1], row[1]);
    else merged.push([...row]);
  }
  return merged;
}

export function assessIndependentMusicSupply(windows, targetRange) {
  const requirement = independentMusicSupplyRequirement(targetRange), byRecording = new Map(), omitted = [];
  for (const window of windows) {
    if (!diagnosticWindowReady(window)) { omitted.push(window.segment_id); continue; }
    if (!/^[a-f0-9]{64}$/.test(window.source_sha256 ?? '') || !validRange(window.source_range))
      fail('independent_music_supply_window_identity_invalid');
    const source = window.source_range.map(samples);
    if (!source.every(Number.isSafeInteger) || source[1] <= source[0])
      fail('independent_music_supply_window_clock_invalid');
    const rows = byRecording.get(window.source_sha256) ?? [];
    rows.push({ segment_id: window.segment_id, source }); byRecording.set(window.source_sha256, rows);
  }
  const recordings = [...byRecording].map(([source_sha256, rows]) => {
    const ranges = union(rows.map(row => row.source));
    return { source_sha256, segment_ids: rows.map(row => row.segment_id), source_ranges_samples: ranges,
      unique_source_samples: ranges.reduce((sum, row) => sum + row[1] - row[0], 0),
      max_contiguous_source_samples: Math.max(...ranges.map(row => row[1] - row[0])),
      sound_or_artistic_qualification_granted: false };
  });
  const available = recordings.reduce((sum, row) => sum + row.unique_source_samples, 0);
  return { ...requirement, recordings, ignored_not_edit_ready_segment_ids: omitted,
    unique_ready_source_samples: available,
    max_contiguous_recording_samples: Math.max(0, ...recordings.map(row => row.max_contiguous_source_samples)),
    sufficient_without_source_repetition: available >= requirement.required_target_samples,
    single_contiguous_recording_available: recordings.some(row => row.max_contiguous_source_samples >= requirement.required_target_samples),
    shortfall_samples: Math.max(0, requirement.required_target_samples - available),
    source_positions_or_cross_recording_connections_not_planned: true };
}

// At most three exact windows per inspected recording. Contiguous ranges may
// be merged, but disjoint ranges and different versions never become one source.
function bestWindows(windows, targetRange) {
  let best = null;
  const precedes = (left, right) => {
    for (let index = 0; index < Math.min(left.length, right.length); index++)
      if (left[index] !== right[index]) return left[index] < right[index];
    return left.length < right.length;
  };
  const evaluate = chosen => {
    const supply = assessIndependentMusicSupply(chosen, targetRange);
    const score = [supply.single_contiguous_recording_available ? 0
      : supply.sufficient_without_source_repetition ? 1 : 2,
      supply.sufficient_without_source_repetition ? chosen.length : -supply.unique_ready_source_samples,
      ...chosen.map(row => windows.indexOf(row))];
    if (!best || precedes(score, best.score))
      best = { windows: chosen, supply, score };
  };
  for (let i = 0; i < windows.length; i++) evaluate([windows[i]]);
  // A single window already covers the cue: keep its original retrieval rank.
  if (best?.supply.single_contiguous_recording_available) return best;
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    evaluate([windows[i], windows[j]]);
    for (let k = j + 1; k < windows.length; k++) evaluate([windows[i], windows[j], windows[k]]);
  }
  return best;
}

export function planIndependentMusicInspection(candidates, targetRange,
  { recordingLimit = 2, inspected = new Set() } = {}) {
  if (!Number.isInteger(recordingLimit)||recordingLimit<2||recordingLimit>5||inspected.size > 5)
    fail('independent_music_supply_inspection_cap_invalid');
  const byRecording = new Map();
  for (const candidate of candidates) if (diagnosticWindowReady(candidate)) {
    const rows = byRecording.get(candidate.source_sha256) ?? [];
    rows.push(candidate); byRecording.set(candidate.source_sha256, rows);
  }
  const plans = [...byRecording].map(([sha, windows]) => ({ sha,
    diversity_key: windows[0].diversity_key ?? `recording:${sha}`,
    rank: candidates.indexOf(windows[0]), ...bestWindows(windows, targetRange) }));
  const priority = plan => plan.supply.single_contiguous_recording_available ? 0
    : plan.supply.sufficient_without_source_repetition ? 1 : 2;
  plans.sort((a, b) => priority(a) - priority(b) || a.rank - b.rank);
  const families = new Set(), nextInspected = new Set(inspected), selected = [];
  for (const plan of plans) {
    if (families.has(plan.diversity_key) || !nextInspected.has(plan.sha) && nextInspected.size >= 5) continue;
    selected.push(plan); families.add(plan.diversity_key); nextInspected.add(plan.sha);
    if (selected.length === recordingLimit) break;
  }
  const windows = selected.flatMap(plan => plan.windows);
  return { revision: independentMusicSupplyRevision, windows,
    supply: assessIndependentMusicSupply(windows, targetRange),
    recording_choices: selected.map(({ sha, diversity_key, rank, supply }) => ({ source_sha256: sha,
      diversity_key, original_recall_rank: rank + 1, supply })),
    original_recall_preserved: true, required_source_repetition: false,
    sound_or_artistic_qualification_granted: false };
}
