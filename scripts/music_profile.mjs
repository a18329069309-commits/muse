import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { hashFile } from './render_binding.mjs';
import { assessStyleTrial } from './assess_style_trial.mjs';
import { requestedWords, wordIntervals, wordRequestMode } from './direction_semantics.mjs';
import { publicReferenceIdentityContract, validatePublicReferenceIdentity } from './public_reference_identity.mjs';

const execute = promisify(execFile);
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const forms = new Set(['instrumental', 'wordless_vocal', 'short_lyrics', 'spoken_adlib', 'unknown']);
const words = form => ['short_lyrics', 'spoken_adlib'].includes(form);
export const reviewedRecordingWindowRelation = 'reviewed_same_recording_window';
export const isOriginalRecordingRelation = relation => ['reviewed_reference_match', reviewedRecordingWindowRelation].includes(relation);
const validRange = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const inside = (range, allowed) => validRange(range) && validRange(allowed) && range[0] >= allowed[0] && range[1] <= allowed[1];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const readBound = async (value, base) => {
  if (!nonempty(value?.path) || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) throw new Error('music_profile_binding_required');
  const file = path.resolve(base, value.path);
  if (await hashFile(file) !== value.sha256) throw new Error('music_profile_binding_changed');
  return { path: file, sha256: value.sha256 };
};

async function referenceTimelineRange(evidence, provenance, reference, base, clocks) {
  if (!clocks.has(reference.sha256)) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp,nb_samples:stream=time_base,sample_rate', '-of', 'json', reference.path],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const audio = JSON.parse(stdout), stream = audio.streams?.[0], frames = audio.frames;
    const [numerator, denominator] = (stream?.time_base ?? '').split('/').map(Number);
    const timeBase = numerator / denominator, rate = Number(stream?.sample_rate);
    if (!(timeBase > 0) || !(rate > 0) || !frames?.length) throw new Error('reference_clock_continuous_audio_required');
    let decodedSamples = 0;
    for (const frame of frames) {
      if (!Number.isFinite(frame.best_effort_timestamp) || !Number.isSafeInteger(frame.nb_samples) || frame.nb_samples <= 0
        || Math.abs((frame.best_effort_timestamp - frames[0].best_effort_timestamp) * timeBase - decodedSamples / rate)
          > Math.max(timeBase, 1 / rate) + 1e-12) throw new Error('reference_clock_continuous_audio_required');
      decodedSamples += frame.nb_samples;
    }
    const picture = JSON.parse((await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-read_intervals', '%+#32', '-show_frames', '-show_entries', 'frame=best_effort_timestamp:stream=time_base',
      '-of', 'json', reference.path], { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout);
    const [videoNumerator, videoDenominator] = (picture.streams?.[0]?.time_base ?? '').split('/').map(Number);
    const videoTimeBase = videoNumerator / videoDenominator, firstVideo = picture.frames?.[0]?.best_effort_timestamp;
    if (!(videoTimeBase > 0) || !Number.isFinite(firstVideo)) throw new Error('reference_clock_video_origin_required');
    clocks.set(reference.sha256, { audio: frames[0].best_effort_timestamp * timeBase, video: firstVideo * videoTimeBase });
  }
  const actual = clocks.get(reference.sha256);
  if (!provenance?.range_coordinate && !evidence.reference_clock) {
    if (Math.abs(actual.audio) > 1 / 48000 || Math.abs(actual.video) > 1 / 48000)
      throw new Error('reference_clock_binding_required');
    return evidence.reference_range;
  }
  const clock = evidence.reference_clock;
  if (provenance?.range_coordinate !== 'decoded_audio_zero_start_samples' || clock?.schema_version !== 1
    || clock.from !== 'decoded_audio_zero_start_samples' || clock.to !== 'first_visible_video_frame'
    || !Number.isFinite(clock.offset_seconds) || !validRange(clock.timeline_range)
    || !Number.isSafeInteger(provenance.sample_rate) || provenance.sample_rate <= 0
    || !Array.isArray(provenance.input_sample_range) || provenance.input_sample_range.length !== 2
    || provenance.input_sample_range.some((value, index) => !Number.isSafeInteger(value)
      || value !== Math.round(evidence.reference_range[index] * provenance.sample_rate)))
    throw new Error('reference_clock_binding_required');
  const manifestFile = await readBound(clock.preparation_manifest, base), manifest = await readJson(manifestFile.path);
  if (manifest.source_sha256 !== reference.sha256 || !Number.isFinite(manifest.video?.first_pts_seconds)
    || manifest.timeline?.sample_rate !== 48000) throw new Error('reference_clock_preparation_mismatch');
  if (Math.abs(actual.video - manifest.video.first_pts_seconds) > 1 / 48000)
    throw new Error('reference_clock_preparation_mismatch');
  const offset = actual.audio - actual.video;
  const mapped = evidence.reference_range.map(value => value + offset);
  if (Math.abs(clock.offset_seconds - offset) > 1 / 48000
    || mapped.some((value, index) => Math.abs(value - clock.timeline_range[index]) > 1 / 48000))
    throw new Error('reference_clock_transform_mismatch');
  if (evidence.identification_contract === publicReferenceIdentityContract) {
    if (!inside(evidence.reference_case_use_range, mapped)) throw new Error('reference_case_use_outside_query_support');
    return evidence.reference_case_use_range;
  }
  return mapped;
}

// Human selection and record integrity do not replace current plot, sound or listener qualification.
export async function loadMusicProfile(input, { sourceSha, workId, strategy }) {
  if (!input) return { ready: true, profile: null };
  const result = { ready: false, status: 'music_profile_gap', gaps: [], production_approval: false,
    artistic_acceptance: 'not_assessed', fallback_performed: false };
  try {
    const binding = await readBound(input, process.cwd()), base = path.dirname(binding.path);
    const profile = await readJson(binding.path), scope = profile.scope;
    if (profile.schema_version !== 1 || !nonempty(profile.profile_id) || !scope
      || (!nonempty(scope.work_id) && !scope.source_video_sha256)
      || (scope.source_video_sha256 && !/^[a-f0-9]{64}$/.test(scope.source_video_sha256))
      || !['instrumental_only', 'allow_words', 'require_words'].includes(profile.vocal_policy))
      throw new Error('music_profile_schema_invalid');
    if ((scope.work_id && scope.work_id !== workId) || (scope.source_video_sha256 && scope.source_video_sha256 !== sourceSha))
      throw new Error('music_profile_scope_mismatch');
    result.binding = binding; result.profile_id = profile.profile_id;
    if (!profile.selection_receipt) return { ...result, status: 'awaiting_user_music_profile_selection',
      next_action: 'present_actual_package_audition_and_record_explicit_user_selection' };
    if (strategy !== 'case_presets') throw new Error('music_profile_requires_case_presets');
    const trialFile = await readBound(profile.trial, base), manifestFile = await readBound(profile.pack_manifest, base);
    const trial = await readJson(trialFile.path), assessed = await assessStyleTrial(trialFile.path);
    if (!assessed.candidates_ready) throw new Error('music_profile_actual_audition_not_ready');
    const selected = assessed.candidates.find(candidate => candidate.id === profile.selected_candidate_id);
    if (!selected || (trial.selected_candidate_id && trial.selected_candidate_id !== selected.id))
      throw new Error('music_profile_selected_candidate_mismatch');
    if (trial.policy.require_music_words && (!words(selected.music_form) || !selected.content_record_verified))
      throw new Error('music_profile_selected_words_candidate_missing');
    if (scope.source_video_sha256 && assessed.video.sha256 !== scope.source_video_sha256)
      throw new Error('music_profile_trial_video_mismatch');
    const receiptFile = await readBound(profile.selection_receipt, base), receipt = await readJson(receiptFile.path);
    if (receipt.type !== 'human_user_selection' || receipt.profile_id !== profile.profile_id
      || receipt.trial_sha256 !== trialFile.sha256 || receipt.pack_manifest_sha256 !== manifestFile.sha256
      || receipt.selected_candidate_id !== selected.id || receipt.audition_sha256 !== selected.audition.sha256
      || receipt.scope?.work_id !== scope.work_id || receipt.scope?.source_video_sha256 !== scope.source_video_sha256
      || receipt.vocal_policy !== profile.vocal_policy
      || !nonempty(receipt.selection_text) || !nonempty(receipt.selected_at))
      throw new Error('music_profile_explicit_user_receipt_required');
    const manifest = await readJson(manifestFile.path), packs = [], ids = new Set();
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.music_packs) || !manifest.music_packs.length)
      throw new Error('music_profile_actual_pack_manifest_required');
    for (const pack of manifest.music_packs) {
      if (!nonempty(pack.music_pack_id) || ids.has(pack.music_pack_id) || !Array.isArray(pack.windows) || !pack.windows.length)
        throw new Error('music_profile_pack_identity_invalid');
      if (pack.conditions != null && (typeof pack.conditions !== 'object' || Array.isArray(pack.conditions))
        || pack.exclude_conditions != null && (!Array.isArray(pack.exclude_conditions)
          || pack.exclude_conditions.some(value => !value || typeof value !== 'object' || Array.isArray(value))))
        throw new Error('music_profile_plot_boundaries_invalid');
      ids.add(pack.music_pack_id);
      const source = await readBound(pack.source, path.dirname(manifestFile.path));
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', source.path],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
      const media = JSON.parse(stdout), duration = Number(media.format?.duration);
      if (!media.streams?.length || !Number.isFinite(duration) || duration <= 0) throw new Error('music_profile_audio_required');
      const windows = [];
      for (const window of pack.windows) {
        if (!validRange(window.source_range) || window.source_range[1] > duration + .001 || !forms.has(window.music_form))
          throw new Error('music_profile_source_window_invalid');
        let contentRecordVerified = false;
        if (window.content_review?.status === 'verified') {
          const evidenceFile = await readBound(window.content_review.evidence, path.dirname(manifestFile.path));
          const evidence = await readJson(evidenceFile.path);
          if (evidence.source_sha256 !== source.sha256 || evidence.music_form !== window.music_form
            || !inside(window.source_range, evidence.source_range_seconds) || !nonempty(evidence.observation))
            throw new Error('music_profile_content_evidence_mismatch');
          contentRecordVerified = true;
        } else if (window.content_review?.status !== 'pending') throw new Error('music_profile_content_review_required');
        if (profile.vocal_policy === 'instrumental_only' && window.music_form !== 'instrumental')
          throw new Error('music_profile_instrumental_policy_conflict');
        windows.push({ source_range: window.source_range, music_form: window.music_form, content_record_verified: contentRecordVerified });
      }
      packs.push({ music_pack_id: pack.music_pack_id, source, windows,
        conditions: pack.conditions ?? {}, exclude_conditions: pack.exclude_conditions ?? [] });
    }
    const selectedRange = [selected.source.range.start_seconds, selected.source.range.end_seconds];
    if (!packs.some(pack => pack.source.sha256 === selected.source.sha256
      && pack.windows.some(window => inside(selectedRange, window.source_range) && window.music_form === selected.music_form
        && (!trial.policy.require_music_words || window.content_record_verified))))
      throw new Error('music_profile_audition_not_in_actual_package');
    if (profile.vocal_policy === 'require_words' && !packs.some(pack => pack.windows.some(window =>
      words(window.music_form) && window.content_record_verified))) throw new Error('music_profile_verified_words_window_missing');
    return { ...result, ready: true, status: 'user_music_profile_bound', profile: {
      profile_id: profile.profile_id, scope, vocal_policy: profile.vocal_policy, binding,
      trial: trialFile, selected_candidate_id: selected.id, selected_audition: selected.audition,
      pack_manifest: manifestFile, selection_receipt: receiptFile, music_packs: packs,
      user_selection_scope: 'bound_package_and_audition_only', current_review_required: true, production_approval: false,
    } };
  } catch (error) {
    result.gaps.push(/^[a-z0-9_]+$/.test(error.message) ? error.message : 'music_profile_file_or_tool_error');
    return result;
  }
}

const relationshipClass = value => ({ family: 'family', mother_daughter: 'family', romance: 'romance', romantic: 'romance' })[value];
const conflict = (current, prior) => typeof current?.threat_resolved === 'boolean'
  && typeof prior?.threat_resolved === 'boolean' && current.threat_resolved !== prior.threat_resolved
  || relationshipClass(current?.relationship) && relationshipClass(prior?.relationship)
  && relationshipClass(current.relationship) !== relationshipClass(prior.relationship);

function missingMaterialRoutes(director, routes, reason) {
  const tasks = director.cues.flatMap(cue => [{ id: cue.cue_id, required: true },
    ...(requestedWords(cue) ? [{ id: cue.cue_id + '/words', required: wordRequestMode(cue) === 'require' }] : [])]);
  const missing = tasks.filter(task => !routes.some(route => route.cue_id === task.id));
  return { ready: !missing.some(task => task.required), gaps: missing.map(task => ({ cue_id: task.id,
    gap: reason, required: task.required, comparison_status: 'material_missing_not_rejected' })) };
}

export function filterMusicProfileRoutes(caseRoutes, director, profile) {
  if (!profile) return { ready: true, caseRoutes, gaps: [] };
  const routes = [], gaps = [];
  for (const route of caseRoutes.routes) {
    const pack = profile.music_packs.find(item => item.music_pack_id === route.music_pack_id);
    if (!pack) continue;
    const cue = director.cues.find(item => item.cue_id === route.cue_id || `${item.cue_id}/words` === route.cue_id);
    const steps = route.structure_match?.steps ?? [];
    const forbidden = JSON.stringify(route).includes('current_unscored_target_not_reference_success_case');
    const plotConflict = !cue || conflict(cue.case_conditions, pack.conditions)
      || conflict(cue.case_conditions, route.applicability?.matched_conditions)
      || pack.exclude_conditions.some(exclusion => Object.entries(exclusion).length && Object.entries(exclusion)
        .every(([key, value]) => cue.case_conditions?.[key] === value))
      || route.structure_match?.critical_conflicts_excluded === false || steps.some(step =>
        step.critical_conflicts?.length || relationshipClass(step.target_relationship) && relationshipClass(step.reference_relationship)
        && relationshipClass(step.target_relationship) !== relationshipClass(step.reference_relationship)
        || step.target_threat === 'unresolved' && step.reference_threat === 'resolved');
    if (forbidden || plotConflict) {
      gaps.push({ cue_id: route.cue_id, route_id: route.route_id,
        gap: forbidden ? 'music_profile_reference_fallback_rejected' : 'music_profile_plot_conflict' });
      continue;
    }
    const candidates = (route.source_candidates ?? []).filter(candidate => candidate.source_sha256 === pack.source.sha256
      && pack.windows.some(window => inside(candidate.source_range, window.source_range)
        && (!route.cue_id.endsWith('/words') || words(window.music_form) && window.content_record_verified)));
    if (candidates.length) routes.push({ ...route, source_candidates: candidates });
    else gaps.push({ cue_id: route.cue_id, route_id: route.route_id, gap: 'music_profile_pack_window_not_bound' });
  }
  const coverage = missingMaterialRoutes(director, routes, 'music_profile_no_applicable_pack');
  gaps.push(...coverage.gaps);
  return { ready: coverage.ready, gaps, caseRoutes: { ...caseRoutes, routes,
    music_profile: { profile_id: profile.profile_id, pack_manifest: profile.pack_manifest,
      current_review_required: true, formal_adoption_allowed: false } } };
}

export function musicProfileDirectionGaps(direction, profile) {
  const rangeGaps = direction.cues.filter(cue => cue.words_target_range != null
    && !inside(cue.words_target_range, cue.target_range))
    .map(cue => `words_target_range_not_within_parent:${cue.cue_id}`);
  if (rangeGaps.length) return rangeGaps;
  const opportunityGaps = direction.cues.filter(cue => cue.words_opportunity
    && (!requestedWords(cue) || !wordIntervals(cue).length || wordIntervals(cue).some(r => !inside(r, cue.target_range))))
    .map(cue => `words_opportunity_not_within_parent:${cue.cue_id}`);
  if (opportunityGaps.length) return opportunityGaps;
  if (!profile) return [];
  const wordCues = direction.cues.filter(requestedWords);
  if (profile.vocal_policy === 'instrumental_only' && wordCues.length) return ['music_profile_instrumental_direction_conflict'];
  if (profile.vocal_policy === 'require_words' && !wordCues.some(cue => wordRequestMode(cue) === 'require'))
    return ['music_profile_required_words_task_missing'];
  return [];
}

// An original-use claim needs an actual reference-to-recording match, not a substitute or fingerprint lead.
export async function filterOriginalReferenceRoutes(caseRoutes, director) {
  const routes = [], gaps = [], clocks = new Map();
  for (const route of caseRoutes.routes) {
    const candidates = [];
    if (JSON.stringify(route).includes('current_unscored_target_not_reference_success_case')
      || route.structure_match?.mode === 'current_director_research') {
      gaps.push({ cue_id: route.cue_id, route_id: route.route_id, gap: 'reference_preset_is_current_target' });
      continue;
    }
    for (const candidate of route.source_candidates ?? []) {
      try {
        if (!isOriginalRecordingRelation(candidate.source_relation)) throw new Error('reference_original_recording_unresolved');
        const reviewedRecordingWindow = candidate.source_relation === reviewedRecordingWindowRelation;
        const evidenceFile = await readBound(candidate.original_recording_evidence, process.cwd());
        const evidence = await readJson(evidenceFile.path), base = path.dirname(evidenceFile.path);
        if (evidence.schema_version !== 1 || evidence.status !== 'verified_same_recording'
          || !nonempty(evidence.reviewer) || !nonempty(evidence.reason)
          || evidence.actual_reference_audio_processed !== true || evidence.actual_source_audio_processed !== true
          || !Array.isArray(evidence.case_ids) || !(route.case_ids ?? []).some(id => evidence.case_ids.includes(id))
          || !validRange(evidence.reference_range) || !validRange(evidence.reference_audio_source_range)
          || !validRange(evidence.source_range) || !validRange(candidate.source_range)
          || !reviewedRecordingWindow && !inside(candidate.source_range, evidence.source_range))
          throw new Error('reference_original_identification_record_required');
        const reference = await readBound(evidence.reference_video, base), source = await readBound(evidence.source_audio, base);
        const query = await readBound(evidence.reference_audio, base), rawFile = await readBound(evidence.identification_result, base);
        if (reference.sha256 !== route.reference_source?.sha256 || source.sha256 !== candidate.source_sha256)
          throw new Error('reference_original_case_or_source_mismatch');
        let provenanceFile, provenance;
        if (query.sha256 !== reference.sha256
          || JSON.stringify(evidence.reference_audio_source_range) !== JSON.stringify(evidence.reference_range)) {
          provenanceFile = await readBound(evidence.reference_audio_provenance, base);
          provenance = await readJson(provenanceFile.path);
          const provenanceBase = path.dirname(provenanceFile.path);
          if (provenance.schema_version !== 1 || !['extract', 'separate'].includes(provenance.operation)
            || provenance.actual_runtime_executed !== true || provenance.process?.exit_code !== 0
            || !nonempty(provenance.tool?.name) || !nonempty(provenance.tool?.version)
            || JSON.stringify(provenance.input_range) !== JSON.stringify(evidence.reference_range)
            || JSON.stringify(provenance.output_source_range) !== JSON.stringify(evidence.reference_audio_source_range))
            throw new Error('reference_query_actual_derivation_required');
          const input = await readBound(provenance.input_video, provenanceBase), output = await readBound(provenance.output_audio, provenanceBase);
          if (input.sha256 !== reference.sha256 || output.sha256 !== query.sha256)
            throw new Error('reference_query_derivation_identity_mismatch');
        }
        const timelineRange = await referenceTimelineRange(evidence, provenance, reference, base, clocks);
        if (!inside(timelineRange, route.reference_case_range)) throw new Error('reference_original_case_or_source_mismatch');
        const raw = await readJson(rawFile.path), length = evidence.reference_audio_source_range[1] - evidence.reference_audio_source_range[0];
        let publicIdentity;
        if (evidence.identification_contract === publicReferenceIdentityContract) {
          publicIdentity = await validatePublicReferenceIdentity({ raw, evidence, base: path.dirname(rawFile.path),
            reference, source, query, timelineRange });
        } else if (raw.operation !== 'match' || raw.query_sha256 !== query.sha256
          || JSON.stringify(raw.query_source_range) !== JSON.stringify(evidence.reference_audio_source_range)
          || Math.abs(evidence.reference_range[1] - evidence.reference_range[0] - length) > 1 / 48000
          || !Array.isArray(raw.matches) || !raw.matches.some(match => match.sha256 === source.sha256
            && Number.isFinite(match.query_start_maps_to_source_seconds)
            && match.consistent_hash_count > 0 && validRange(match.matched_query_support_seconds)
            && inside(evidence.source_range, [match.query_start_maps_to_source_seconds + match.matched_query_support_seconds[0],
              match.query_start_maps_to_source_seconds + match.matched_query_support_seconds[1]])))
          throw new Error('reference_original_actual_match_missing');
        let human;
        if (reviewedRecordingWindow) {
          if (!publicIdentity) throw new Error('reviewed_recording_window_full_source_identity_required');
          if (candidate.recording_identity_source
            && (await readBound(candidate.recording_identity_source, process.cwd())).sha256 !== source.sha256)
            throw new Error('reviewed_recording_window_source_identity_mismatch');
          if (candidate.reference_use_source_range !== undefined
            && JSON.stringify(candidate.reference_use_source_range) !== JSON.stringify(evidence.source_range)
            || candidate.ready_source_range !== undefined
            && JSON.stringify(candidate.ready_source_range) !== JSON.stringify(candidate.source_range))
            throw new Error('reviewed_recording_window_range_roles_mismatch');
          if (candidate.applicability?.source_integrity_verified !== true
            || candidate.applicability?.pack_status !== 'approved'
            || candidate.applicability?.pack_listening_record_checked !== true
            || candidate.applicability?.eligible_for_current_review !== true
            || !inside(candidate.source_range, candidate.library_allowed_source_range)
            || candidate.unresolved_gaps?.includes('music_source_content_contaminated'))
            throw new Error('reviewed_recording_window_package_not_approved');
          const cue = director.cues.find(row => row.cue_id === route.cue_id || `${row.cue_id}/words` === route.cue_id);
          if (!cue) throw new Error('reviewed_recording_window_current_cue_required');
          human = await loadOfflineHumanReview(candidate.human_review_record, { sourceSha: source.sha256,
            sourceRange: candidate.source_range, caseIds: route.case_ids, conditions: cue.case_conditions ?? {},
            requireWords: route.cue_id.endsWith('/words') });
          if (human.record.asset_kind !== 'music') throw new Error('reviewed_recording_window_music_required');
        }
        candidates.push({ ...candidate, case_source_range: candidate.source_range, original_recording_evidence: evidenceFile,
          ...(publicIdentity ? { public_recording_identity: publicIdentity } : {}),
          ...(human ? { human_review_record: human.binding, offline_human_observation: human,
            recording_identity_source: source, reference_use_source_range: evidence.source_range,
            ready_source_range: candidate.source_range, source_window_basis: 'human_reviewed_same_recording' } : {}),
          ...(provenanceFile ? { reference_audio_provenance: provenanceFile } : {}), original_identification_result: rawFile,
          reference_timeline_range: timelineRange, reference_clock_checked: !!evidence.reference_clock,
          original_reference_identity_record_checked: true, current_review_required: true, formal_adoption_allowed: false });
      } catch (error) {
        gaps.push({ cue_id: route.cue_id, route_id: route.route_id, segment_id: candidate.segment_id,
          gap: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'reference_original_evidence_file_error' });
      }
    }
    if (candidates.length) routes.push({ ...route, source_candidates: candidates });
  }
  const coverage = missingMaterialRoutes(director, routes, 'reference_original_music_missing');
  gaps.push(...coverage.gaps);
  return { ready: coverage.ready, status: coverage.ready ? 'original_reference_routes_bound' : 'reference_original_music_gap', gaps,
    caseRoutes: { ...caseRoutes, routes, reference_originals_only: true, formal_adoption_allowed: false },
    formal_adoption_allowed: false, fallback_performed: false };
}

export function validateMaterialPolicy(policy = 'reference_original_only') {
  if (!['reference_original_only', 'reference_or_reviewed_equivalent'].includes(policy))
    throw new Error('case_material_policy_invalid');
  return policy;
}

// This consumes a supplied human record. It never creates a review or grants a model qualification.
export async function loadOfflineHumanReview(input, { sourceSha, sourceRange, caseIds, conditions, requireWords = false } = {}) {
  const binding = await readBound(input, process.cwd()), base = path.dirname(binding.path);
  const record = await readJson(binding.path);
  const cleanFields = ['unwanted_speech_absent', 'unwanted_music_absent', 'unwanted_scene_sounds_absent', 'audible_noise_absent'];
  if (record.schema_version !== 1 || record.type !== 'offline_human_window_review' || record.origin !== 'human'
    || record.status !== 'approved' || record.actual_audio_listened !== true
    || !nonempty(record.reviewer) || !nonempty(record.reviewed_at) || !Number.isFinite(Date.parse(record.reviewed_at))
    || !nonempty(record.reason) || !validRange(record.source_range)
    || !Array.isArray(record.case_ids) || !record.case_ids.length || record.case_ids.some(id => !nonempty(id))
    || !record.conditions || typeof record.conditions !== 'object' || Array.isArray(record.conditions) || !Object.keys(record.conditions).length
    || Object.values(record.conditions).some(value => value === null || value === undefined)
    || !Array.isArray(record.exclude_conditions) || record.exclude_conditions.some(row => !row || Array.isArray(row)
      || typeof row !== 'object' || !Object.keys(row).length)
    || !record.observations || Array.isArray(record.observations) || typeof record.observations !== 'object'
    || !Object.keys(record.observations).length || cleanFields.some(field => record.cleanliness?.[field] !== true))
    throw new Error('offline_human_actual_window_review_required');
  const source = await readBound(record.source_audio, base);
  if (sourceSha && source.sha256 !== sourceSha || sourceRange && !inside(sourceRange, record.source_range)
    || caseIds && !caseIds.some(id => record.case_ids.includes(id))) throw new Error('offline_human_review_scope_mismatch');
  if (conditions && (conflict(conditions, record.conditions)
    || Object.entries(record.conditions).some(([key, value]) => key === 'relationship' && relationshipClass(value)
      ? relationshipClass(conditions[key]) !== relationshipClass(value) : JSON.stringify(conditions[key]) !== JSON.stringify(value))
    || record.exclude_conditions.some(row => Object.entries(row).every(([key, value]) =>
      JSON.stringify(conditions[key]) === JSON.stringify(value))))) throw new Error('offline_human_review_plot_conflict');
  if (record.asset_kind === 'music' && (!forms.has(record.music_form) || record.music_form === 'unknown'))
    throw new Error('offline_human_music_form_required');
  if (!['music', 'sfx', 'ambience'].includes(record.asset_kind)) throw new Error('offline_human_asset_kind_required');
  if (words(record.music_form) || requireWords) {
    if (!words(record.music_form) || requireWords && record.music_form !== 'short_lyrics'
      || !record.words?.actual_words?.trim() || !record.words.vocal_language?.trim()
      || record.words.vocal_language === 'unknown' || record.words.complete_phrase !== true
      || !inside(record.words.source_range, record.source_range)
      || sourceRange && (!inside(record.words.source_range, sourceRange)
        || requireWords && JSON.stringify(record.words.source_range) !== JSON.stringify(sourceRange)))
      throw new Error('offline_human_complete_words_required');
  }
  return { binding, source, record, scope: 'supplied_human_window_record_only', qualification_granted: false };
}

// Explicitly opted-in equivalents are source-bound human-reviewed packages, never generic fallback.
export async function filterReferenceMaterialRoutes(caseRoutes, director, materialPolicy = 'reference_original_only') {
  validateMaterialPolicy(materialPolicy);
  if (materialPolicy === 'reference_original_only') return filterOriginalReferenceRoutes(caseRoutes, director);
  const original = await filterOriginalReferenceRoutes(caseRoutes, director), routes = [], gaps = [];
  const accepted = new Map(original.caseRoutes.routes.map(route => [route.route_id, route]));
  for (const route of caseRoutes.routes) {
    const originals = accepted.get(route.route_id)?.source_candidates ?? [], equivalents = [];
    const cue = director.cues.find(row => row.cue_id === route.cue_id || `${row.cue_id}/words` === route.cue_id);
    if (!cue || JSON.stringify(route).includes('current_unscored_target_not_reference_success_case')
      || route.structure_match?.mode === 'current_director_research'
      || route.structure_match?.critical_conflicts_excluded === false) {
      gaps.push({ route_id: route.route_id, cue_id: route.cue_id, gap: 'reviewed_material_reference_or_plot_invalid' });
      continue;
    }
    for (const candidate of route.source_candidates ?? []) {
      if (candidate.source_relation !== 'reviewed_substitute') continue;
      try {
        if (candidate.applicability?.source_integrity_verified !== true
          || candidate.applicability?.pack_status !== 'approved'
          || candidate.applicability?.eligible_for_current_review !== true
          || candidate.unresolved_gaps?.includes('music_source_content_contaminated'))
          throw new Error('reviewed_equivalent_package_not_approved');
        const human = await loadOfflineHumanReview(candidate.human_review_record, { sourceSha: candidate.source_sha256,
          sourceRange: candidate.source_range, caseIds: route.case_ids, conditions: cue.case_conditions ?? {},
          requireWords: route.cue_id.endsWith('/words') });
        if (human.record.asset_kind !== 'music') throw new Error('reviewed_equivalent_music_required');
        equivalents.push({ ...candidate, human_review_record: human.binding, offline_human_observation: human,
          case_source_range: candidate.source_range, current_review_required: true, formal_adoption_allowed: false,
          material_source_kind: 'reviewed_equivalent', material_priority: 1 });
      } catch (error) {
        gaps.push({ cue_id: route.cue_id, route_id: route.route_id, segment_id: candidate.segment_id,
          gap: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'offline_human_review_file_error' });
      }
    }
    const candidates = [...originals.map(candidate => ({ ...candidate, material_source_kind: 'reference_original', material_priority: 0 })), ...equivalents];
    if (candidates.length) routes.push({ ...route, source_candidates: candidates });
  }
  routes.sort((left, right) => Math.min(...left.source_candidates.map(row => row.material_priority))
    - Math.min(...right.source_candidates.map(row => row.material_priority)));
  const coverage = missingMaterialRoutes(director, routes, 'reference_or_reviewed_package_missing');
  gaps.push(...coverage.gaps);
  return { ready: coverage.ready, status: coverage.ready ? 'reference_material_routes_bound' : 'reference_material_gap', gaps,
    material_policy: materialPolicy, caseRoutes: { ...caseRoutes, routes, material_policy: materialPolicy,
      reference_originals_only: false, approved_packages_only: true, formal_adoption_allowed: false },
    formal_adoption_allowed: false, fallback_performed: false, qualification_granted: false };
}
