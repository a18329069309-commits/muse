import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { verifyRenderBinding, hashFile } from './render_binding.mjs';
import { verifyResearchAudioEvidence } from './research_audio_evidence.mjs';
import { verifyDiagnosticBedPlacement } from './diagnostic_bed_placement.mjs';
import { collectSoundAudibility } from './sound_audibility_measurement.mjs';

// Check actual sound coverage; this does not approve aesthetics or source semantics.
const { values: args } = parseArgs({ options: {
  design: { type: 'string' }, plan: { type: 'string' }, render: { type: 'string' },
} });
if (!args.design || !args.plan) throw new Error('Required: --design decisions.json --plan plan.json [--render directory]');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const design = read(args.design), plan = read(args.plan), issues = [], soundResults = [], directorIssues = [], warnings = [];
const add = (id, problem) => issues.push({ id, problem });
const addDirector = (id, problem) => { directorIssues.push({ id, problem }); add(id, problem); };
const text = value => typeof value === 'string' && value.trim().length > 0;
if (!['fine', 'fast'].includes(design.craft_mode)) add('design', 'craft_mode_required');
if (!['pre_paywall', 'post_paywall', 'crosses_paywall', 'unknown'].includes(design.business_phase)) add('design', 'business_phase_required');
if (!design.first_paywall || !('episode' in design.first_paywall) || !('time_seconds' in design.first_paywall)) add('design', 'first_paywall_record_required_null_is_allowed');
if (design.business_phase === 'crosses_paywall' && !design.phase_segments?.length) add('design', 'crossing_requires_phase_segments');
const beats = design.story_beats ?? [], events = design.sound_events ?? [], transitions = design.transitions ?? [];
const directorV2 = design.director_contract_version === 2;
if (design.craft_mode === 'fine' && !beats.length) (directorV2 ? addDirector : add)('design', 'fine_requires_story_beats');
if (design.craft_mode === 'fine' && !events.length && !text(design.sound_event_none_reason)) add('design', 'fine_requires_explicit_sound_decisions');
if (directorV2) {
  const manifestFile = text(plan.manifest) ? path.resolve(path.dirname(args.plan), plan.manifest) : null;
  const manifest = manifestFile && fs.existsSync(manifestFile) ? read(manifestFile) : null;
  const duration = manifest?.timeline?.duration_samples / manifest?.timeline?.sample_rate;
  if (!(Number.isFinite(duration) && duration > 0)) addDirector('design', 'director_manifest_duration_required');
  const inRange = item => Number.isFinite(item.start_seconds) && Number.isFinite(item.end_seconds)
    && item.start_seconds >= 0 && item.end_seconds > item.start_seconds && item.end_seconds <= duration;
  const ids = new Set(), expectations = new Set();
  for (const beat of beats) {
    if (![beat.id, beat.perspective, beat.expectation_before, beat.new_information,
      beat.expectation_after, beat.control_change, beat.sound_decision].every(text)) addDirector(beat.id, 'director_change_fields_required');
    if (ids.has(beat.id)) addDirector(beat.id, 'director_beat_id_not_unique');
    ids.add(beat.id);
    if (!inRange(beat)) addDirector(beat.id, 'director_beat_range_invalid');
    if (!Array.isArray(beat.cue_ids) || beat.cue_ids.some(id => !text(id) || !plan.cues.some(cue => cue.id === id))) addDirector(beat.id, 'director_cue_mapping_invalid');
    if (!Array.isArray(beat.evidence_refs) || !beat.evidence_refs.length) addDirector(beat.id, 'director_evidence_refs_required');
    else for (const ref of beat.evidence_refs) {
      if (!ref || !['frame', 'transcript', 'audio_observation'].includes(ref.kind) || !text(ref.path)) { addDirector(beat.id, 'director_evidence_reference_invalid'); continue; }
      const evidenceFile = path.resolve(path.dirname(args.design), ref.path);
      if (!fs.existsSync(evidenceFile) || !fs.statSync(evidenceFile).isFile()) addDirector(beat.id, 'director_evidence_file_missing');
      if (ref.kind === 'audio_observation') {
        try { await verifyResearchAudioEvidence({ ...ref, path: evidenceFile }, { manifest,
          manifestBinding: { path: manifestFile, sha256: await hashFile(manifestFile) } }); }
        catch { addDirector(beat.id, 'director_audio_observation_binding_or_range_invalid'); }
      }
      const pointFrame = ref.kind === 'frame' && Number.isFinite(ref.start_seconds)
        && ref.start_seconds === ref.end_seconds;
      const validEvidenceRange = pointFrame
        ? ref.start_seconds >= 0 && ref.start_seconds < duration
          && ref.start_seconds >= beat.start_seconds && ref.start_seconds < beat.end_seconds
        : inRange(ref) && ref.end_seconds > beat.start_seconds && ref.start_seconds < beat.end_seconds;
      if (!validEvidenceRange) addDirector(beat.id, 'director_evidence_range_invalid');
    }
    if (text(beat.expectation_after)) {
      const expectation = beat.expectation_after.trim();
      if (expectations.has(expectation)) warnings.push({ id: beat.id, problem: 'director_expectation_repeated_review_context' });
      expectations.add(expectation);
    }
  }
} else for (const beat of beats) {
  if (![beat.evidence, beat.perspective, beat.audience_expectation, beat.sound_decision].every(text)) add(beat.id, 'story_evidence_and_sound_reason_required');
}
const music = plan.cues.filter(cue => cue.track === 'bgm' && cue.music_role !== 'words_candidate');
const wordCues = plan.cues.filter(cue => cue.track === 'bgm' && cue.music_role === 'words_candidate');
for (const cue of wordCues) {
  const relation = transitions.find(t => t.to_cue_id === cue.id && t.from_cue_id === cue.parent_plan_cue_id);
  if (!relation || !text(relation.reason) || !['song_replace', 'same_source_development', 'vocal_overlay'].includes(relation.transition_type)
    || relation.transition_type !== cue.words_mode) add(cue.id, 'words_entry_exit_and_mix_decision_required');
}
for (let i = 1; i < music.length; i++) {
  const transition = transitions.find(t => t.from_cue_id === music[i - 1].id && t.to_cue_id === music[i].id);
  const previous = music[i - 1], next = music[i];
  const wordBridge = wordCues.some(cue => {
    if (cue.parent_plan_cue_id !== previous.id || !['song_replace', 'same_source_development'].includes(cue.words_mode)) return false;
    const entry = transitions.find(t => t.from_cue_id === previous.id && t.to_cue_id === cue.id);
    const exit = transitions.find(t => t.from_cue_id === cue.id && t.to_cue_id === next.id);
    if (![entry, exit].every(t => t?.transition_type === cue.words_mode && text(t.reason))) return false;
    if (![previous, cue, next].every(c => Number.isFinite(c.start_seconds) && c.start_seconds >= 0
      && Number.isFinite(c.source_in_seconds ?? 0) && (c.source_in_seconds ?? 0) >= 0
      && Number.isFinite(c.source_out_seconds) && c.source_out_seconds > (c.source_in_seconds ?? 0))) return false;
    // Match the renderer's 48 kHz clock: the actual sung cue must fill the primary gap.
    const start = c => Math.round(c.start_seconds * 48000);
    const end = c => start(c) + Math.round(c.source_out_seconds * 48000) - Math.round((c.source_in_seconds ?? 0) * 48000);
    return end(previous) < start(next) && start(cue) === end(previous) && end(cue) === start(next);
  });
  if ((!transition || !text(transition.transition_type) || !text(transition.reason)) && !wordBridge) add(music[i].id, 'music_transition_decision_missing');
  if (transition?.transition_type === 'accent_bridge' && !events.some(e => e.id === transition.sound_event_id && e.decision === 'new_asset')) add(music[i].id, 'accent_bridge_requires_real_sound_event');
}
function peakOf(file, cue) {
  const start = cue?.source_in_seconds ?? 0;
  const command = ['-v', 'error', '-ss', String(start), '-i', file];
  if (cue?.source_out_seconds !== undefined) command.push('-t', String(cue.source_out_seconds - start));
  command.push('-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1');
  const result = spawnSync('ffmpeg', command, { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not decode audio for coverage check');
  let peak = 0;
  for (let i = 0; i < result.stdout.length; i += 4) {
    const value = result.stdout.readFloatLE(i);
    if (!Number.isFinite(value)) throw new Error('Non-finite audio sample');
    peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}
for (const event of events) {
  if (!['physical', 'foley', 'dramatic', 'transition', 'ambience'].includes(event.sound_role) || !text(event.evidence) || !text(event.reason)) add(event.id, 'sound_role_evidence_and_reason_required');
  if (event.decision === 'new_asset') {
    const cue = plan.cues.find(c => c.id === event.cue_id);
    const expectedTrack = event.sound_role === 'ambience' ? 'ambience' : 'sfx';
    const asset = plan.assets.find(a => a.id === cue?.asset_id);
    if (!cue || cue.track !== expectedTrack || !asset) { add(event.id, 'selected_sound_not_in_actual_plan'); continue; }
    const file = path.resolve(path.dirname(args.plan), asset.path);
    if (!fs.existsSync(file)) { add(event.id, 'selected_asset_missing'); continue; }
    const peak = peakOf(file, cue);
    if (!(peak > 0)) add(event.id, 'selected_source_segment_is_silent');
    if (cue.gain_db === undefined || !Number.isFinite(cue.gain_db)) add(event.id, 'sound_gain_required');
    if (event.duration_role === 'bed') {
      try {
        const placement = event.source_placement, target = event.current_event_target_range;
        const manifestFile = path.resolve(path.dirname(args.plan), plan.manifest), manifest = read(manifestFile);
        const exact = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 48000) === Math.round(b * 48000);
        if (!['dramatic', 'transition'].includes(event.sound_role) || cue.sync || !text(event.anchor_evidence)
          || !placement || !Array.isArray(target) || target.length !== 2 || target[1] <= target[0]
          || placement.event_id !== event.id || placement.current_target_video_sha256 !== manifest.source_sha256
          || placement.source_sha256 !== asset.sha256 || path.resolve(placement.local_path ?? '') !== file
          || !exact(cue.start_seconds, target[0]) || target[0] < 0 || target[1] > manifest.timeline.duration_samples / 48000
          || !exact(cue.source_in_seconds, placement.source_range?.[0]) || !exact(cue.source_out_seconds, placement.source_range?.[1])
          || !exact(cue.source_out_seconds - cue.source_in_seconds, target[1] - target[0])
          || !exact(placement.current_event_target_range?.[0], target[0]) || !exact(placement.current_event_target_range?.[1], target[1]))
          throw Error('bed_clock_or_identity_changed');
        await verifyDiagnosticBedPlacement(placement);
      } catch { add(event.id, 'sustained_sound_requires_bound_event_window_placement'); }
    } else if (event.sound_role !== 'ambience' && (!cue.sync || !text(event.anchor_evidence))) add(event.id, 'point_sound_requires_sync_and_anchor_evidence');
    if (['physical', 'foley'].includes(event.sound_role) && !['verified_missing', 'verified_insufficient'].includes(event.original_status)) add(event.id, 'physical_original_content_unverified');
    soundResults.push({ id: event.id, cue_id: cue.id, track: cue.track, source_segment_peak: peak, audible_quality: 'unknown' });
  } else if (event.decision === 'retain_original') {
    if (event.original_status !== 'verified_present') add(event.id, 'retained_original_not_verified');
  } else if (event.decision === 'omit') {
    if (event.required) add(event.id, 'required_event_omitted');
  } else {
    add(event.id, event.decision === 'missing_asset' ? 'sound_asset_gap' : 'sound_decision_requires_review');
  }
}
const renderedTracks = {};
let soundAudibility;
let renderReport;
if (args.render) {
  const reportFile = path.join(args.render, 'report.json');
  if (!fs.existsSync(reportFile)) add('render', 'render_report_missing');
  else {
    renderReport = read(reportFile);
    for (const problem of await verifyRenderBinding(args.plan, args.render, renderReport)) add('render', problem);
  }
  for (const track of new Set(soundResults.map(event => event.track))) {
    const file = path.join(args.render, track + '.wav');
    if (!fs.existsSync(file)) { add(track, 'rendered_track_missing'); continue; }
    const peak = peakOf(file);
    renderedTracks[track] = { peak, nonzero: peak > 0 };
    if (!(peak > 0)) add(track, 'rendered_sound_track_is_silent');
  }
  for (const event of soundResults) {
    const cue = plan.cues.find(c => c.id === event.cue_id);
    const actual = renderReport?.cues?.find(c => c.id === cue.id && c.track === cue.track && c.asset_id === cue.asset_id);
    event.rendered_contribution_peak_pcm24 = actual?.contribution_peak_pcm24 ?? null;
    if (!actual) add(event.id, 'selected_cue_missing_from_render_report');
    else if (!(actual.contribution_peak_pcm24 > 0)) add(event.id, 'selected_cue_contributes_no_pcm_signal');
    const file = path.join(args.render, event.track + '.wav');
    if (!fs.existsSync(file)) continue;
    const start = cue.start_seconds ?? cue.sync.target_seconds - (cue.sync.source_anchor_seconds - (cue.source_in_seconds ?? 0));
    const stop = start + cue.source_out_seconds - (cue.source_in_seconds ?? 0);
    event.rendered_window_peak = stop > Math.max(0, start) ? peakOf(file, { source_in_seconds: Math.max(0, start), source_out_seconds: stop }) : 0;
    if (!(event.rendered_window_peak > 0)) add(event.id, 'rendered_event_window_is_silent');
  }
  if (soundResults.some(event => event.track === 'sfx') && !issues.some(row => row.id === 'render')) {
    try {
      const manifestFile = path.resolve(path.dirname(args.plan), plan.manifest);
      soundAudibility = await collectSoundAudibility({
        manifestBinding: { path: manifestFile, sha256: await hashFile(manifestFile) },
        planBinding: { path: path.resolve(args.plan), sha256: await hashFile(args.plan) },
        renderDirectory: path.resolve(args.render), soundEvents: events });
      for (const row of soundAudibility.events) {
        const event = soundResults.find(event => event.cue_id === row.cue_id);
        if (event) event.competing_mix_measurement = row;
        for (const risk of row.technical_risks) warnings.push({ id: event?.id ?? row.cue_id, problem: risk,
          scope: 'actual_sound_contribution_against_local_mix', perceptual_approval: false });
      }
    } catch (error) { add('render', 'actual_sound_competing_mix_measurement_failed');
      warnings.push({ id: 'render', problem: String(error.message), scope: 'sound_measurement_execution' }); }
  }
} else if (soundResults.length) add('render', 'selected_sounds_not_checked_in_render');
const actualSoundEventIds = new Set(soundResults.map(event => event.id));
const selectedEvents = events.filter(event => event.decision === 'new_asset' && actualSoundEventIds.has(event.id));
const soundTreatmentCounts = {
  new_point_sound_cues: selectedEvents.filter(event => event.sound_role !== 'ambience' && event.duration_role !== 'bed').length,
  new_sustained_beds: selectedEvents.filter(event => event.sound_role !== 'ambience' && event.duration_role === 'bed').length,
  new_ambience_beds: selectedEvents.filter(event => event.sound_role === 'ambience').length,
  required_events_omitted: events.filter(event => event.required && event.decision === 'omit').length,
};
const soundTaskGaps = events.filter(event => ['missing_asset', 'requires_review'].includes(event.decision)
  || event.required && event.decision === 'omit').map(event => ({ event_id: event.id,
    required: event.required === true, decision: event.decision, reason: event.reason,
    gap: event.required && event.decision === 'omit' ? 'required_sound_event_has_no_actual_adoption' : 'sound_event_material_or_review_gap' }));
console.log(JSON.stringify({
  status: issues.length ? 'incomplete_sound_coverage' : 'coverage_ready_for_audition',
  craft_mode: design.craft_mode, business_phase: design.business_phase,
  sound_event_none_reason: !events.length && text(design.sound_event_none_reason) ? design.sound_event_none_reason.trim() : null,
  music_cues: music.length, new_sound_cues_with_nonzero_source: soundResults.length,
  events: soundResults, rendered_tracks: renderedTracks, issues,
  sound_treatment_counts: soundTreatmentCounts, sound_task_gaps: soundTaskGaps,
  sound_adoption_status: soundTreatmentCounts.new_point_sound_cues > 0 ? 'actual_point_sound_selected_hearing_pending'
    : soundTreatmentCounts.new_sustained_beds > 0 ? 'sustained_bed_only_no_point_sound_selected'
    : 'no_new_point_or_sustained_sound_selected',
  actual_sound_mix_measurement: soundAudibility ?? null,
  upstream_mix_status: renderReport?.status ?? 'not_checked', upstream_mix_issues: renderReport?.issues ?? [],
  director_structure_status: directorV2 ? (directorIssues.length ? 'incomplete' : 'verified_structure_only') : 'legacy_contract_checked',
  semantic_assessment: 'not_performed', warnings,
  original_audio_kind: plan.original_audio_kind, artistic_acceptance: 'not_assessed',
  production_approval: false, note: 'Coverage check only; retain upstream source and mix review gates. Audition the complete mix.',
}, null, 2));
process.exitCode = issues.length ? 2 : 0;
