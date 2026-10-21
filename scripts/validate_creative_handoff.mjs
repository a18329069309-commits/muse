import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';
import { validateStoryMusicResponses } from './validate_story_music_responses.mjs';
import { validateWordsHandoff } from './validate_words_handoff.mjs';
import { audioBackendMatches } from './audio_api.mjs';

const execute = promisify(execFile);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const read = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const requireFact = (condition, reason) => { if (!condition) throw new Error(`fine_handoff_${reason}`); };
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const sameRange = (a, b) => range(a) && range(b) && a.every((value, i) => value === b[i]);
const within = (inner, outer) => range(inner) && range(outer)
  && inner[0] >= outer[0] - 1 / 48000 && inner[1] <= outer[1] + 1 / 48000;

// Hash the original parsed plan, before the runner resolves paths or replaces its manifest.
export const hashCreativePlan = plan => createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');

async function boundFile(binding, base, label) {
  requireFact(binding && text(binding.path) && sha(binding.sha256), `${label}_binding_required`);
  const file = path.resolve(base, binding.path);
  requireFact(await hashFile(file) === binding.sha256.toLowerCase(), `${label}_sha256_mismatch`);
  return file;
}

async function audioDuration(file) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
  const media = JSON.parse(stdout), audio = media.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audio?.duration ?? media.format?.duration);
  requireFact(audio && Number.isFinite(duration) && duration > 0, 'actual_listening_audio_required');
  return duration;
}

// Verify supplied records and their current files. This function never hears or approves music.
export async function validateCreativeHandoff({ binding, base, sourceSha256, designSha256, durationSeconds, design, plan, assets }) {
  const computedPlanSha256 = hashCreativePlan(plan);
  requireFact(design.director_contract_version === 2, 'director_v2_required');
  const handoffFile = await boundFile(binding, base, 'creative');
  const handoff = await read(handoffFile), handoffBase = path.dirname(handoffFile);
  requireFact([1, 2].includes(handoff.schema_version), 'version_invalid');
  requireFact(handoff.source_video_sha256 === sourceSha256, 'source_video_mismatch');
  requireFact(handoff.sound_decisions_sha256 === designSha256, 'sound_decisions_mismatch');
  requireFact(handoff.plan_sha256 === computedPlanSha256, 'plan_mismatch');
  const inputs = {}, documents = {};
  for (const label of ['director_brief', 'music_tasks', 'music_reviews', 'reviewed_route']) {
    const file = await boundFile(handoff[label], handoffBase, label);
    inputs[label] = { path: file, sha256: handoff[label].sha256 };
    documents[label] = await read(file);
  }
  const { director_brief: brief, music_tasks: tasks, music_reviews: reviews, reviewed_route: routed } = documents;
  requireFact(brief.source_video_sha256 === sourceSha256 && Array.isArray(brief.story_beats)
    && brief.story_beats.length > 0, 'bound_director_brief_required');
  for (const document of [tasks, reviews]) {
    requireFact(document.schema_version === 1 && document.source_video_sha256 === sourceSha256
      && document.director_brief_sha256 === inputs.director_brief.sha256, 'music_context_mismatch');
  }
  requireFact(reviews.music_tasks_sha256 === inputs.music_tasks.sha256, 'music_task_review_context_mismatch');
  requireFact(Array.isArray(tasks.cues) && Array.isArray(reviews.reviews)
    && routed.schema_version === 1 && Array.isArray(routed.cues), 'music_records_invalid');
  requireFact(Array.isArray(handoff.selections), 'selections_required');
  const music = plan.cues.filter(cue => cue.track === 'bgm');
  requireFact(handoff.selections.length === music.length, 'music_mapping_incomplete');
  const checked = [];
  for (const cue of music) {
    const mappings = handoff.selections.filter(item => item.plan_cue_id === cue.id);
    requireFact(mappings.length === 1 && text(mappings[0].music_task_cue_id), 'music_mapping_not_unique');
    const taskMatches = tasks.cues.filter(item => item.cue_id === mappings[0].music_task_cue_id);
    const routeMatches = routed.cues.filter(item => item.cue_id === mappings[0].music_task_cue_id);
    requireFact(taskMatches.length === 1 && routeMatches.length === 1, 'current_task_or_route_missing');
    const task = taskMatches[0], route = routeMatches[0], selected = route.selected;
    requireFact(task.mode === 'fine' && range(task.target_range)
      && task.target_range[1] <= durationSeconds + 1 / 48000, 'fine_music_task_required');
    requireFact(route.status === 'ready_for_edit' && !route.review_issues?.length && selected
      && text(selected.segment_id) && selected.listening_record_checked === true, 'actual_selected_review_required');
    const asset = assets[cue.asset_id];
    requireFact(asset && selected.source_sha256 === asset.sha256, 'selected_source_mismatch');
    requireFact(within([cue.source_in_seconds, cue.source_out_seconds], selected.source_range), 'selected_source_window_mismatch');
    const start = cue.start_seconds ?? cue.sync?.target_seconds
      - (cue.sync?.source_anchor_seconds - cue.source_in_seconds);
    requireFact(within([Math.max(0, start), start + cue.source_out_seconds - cue.source_in_seconds], task.target_range),
      'target_window_mismatch');
    const reviewMatches = reviews.reviews.filter(item => item.cue_id === task.cue_id
      && item.segment_id === selected.segment_id);
    requireFact(reviewMatches.length === 1, 'raw_review_not_unique');
    const review = reviewMatches[0], evidence = review.listening_evidence;
    requireFact(review.verdict === 'selected' && review.cue_sha256 === route.cue_sha256
      && review.query_sha256 === route.query_sha256 && sha(route.cue_sha256) && sha(route.query_sha256)
      && review.source_sha256 === asset.sha256 && sameRange(review.source_range, selected.source_range)
      && text(review.reason), 'raw_selected_review_mismatch');
    const candidates = route.retrieval?.candidates?.filter(item => item.segment_id === selected.segment_id) ?? [];
    requireFact(candidates.length === 1 && candidates[0].source_sha256 === asset.sha256
      && sameRange(review.candidate_source_range, candidates[0].source_range)
      && within(selected.source_range, candidates[0].source_range), 'retrieved_candidate_mismatch');
    requireFact(evidence?.actual_audio_processed === true && text(evidence.backend_id)
      && text(evidence.observations), 'actual_audio_observations_required');
    const reviewBase = path.dirname(inputs.music_reviews.path);
    const qualificationFile = await boundFile(evidence.qualification_record, reviewBase, 'listener_qualification');
    const qualification = await read(qualificationFile);
    requireFact(qualification.status === 'qualified' && audioBackendMatches(evidence, qualification)
      && ['audio_observation', 'music_candidate_judgment'].every(scope => qualification.scopes?.includes(scope)),
      'listener_qualification_invalid');
    const inputAudio = await boundFile(evidence.input_audio, reviewBase, 'listening_audio');
    const inputDuration = await audioDuration(inputAudio);
    let derivation = 'same_original_recording';
    if (evidence.input_audio.sha256 !== asset.sha256) {
      requireFact(evidence.input_audio.source_sha256 === asset.sha256
        && sameRange(evidence.input_audio.source_range, selected.source_range)
        && Math.abs(inputDuration - (selected.source_range[1] - selected.source_range[0])) <= 0.05,
        'listening_excerpt_mismatch');
      derivation = 'declared_excerpt_not_independently_proven';
    } else requireFact(selected.source_range[1] <= inputDuration + 0.001, 'listening_source_range_outside_audio');
    requireFact(selected.listening_input_binding?.sha256 === evidence.input_audio.sha256
      && selected.qualification_record?.sha256 === evidence.qualification_record.sha256,
      'routed_listening_binding_mismatch');
    checked.push({ plan_cue_id: cue.id, music_task_cue_id: task.cue_id, segment_id: selected.segment_id,
      source_sha256: asset.sha256, used_source_range: [cue.source_in_seconds, cue.source_out_seconds],
      reviewed_source_range: selected.source_range, listening_input_sha256: evidence.input_audio.sha256,
      listening_derivation_status: derivation,
      ...(task.music_role === 'words_candidate' ? { words_evidence: selected.words_evidence } : {}) });
  }
  requireFact(handoff.selections.every(item => music.some(cue => cue.id === item.plan_cue_id)), 'unmapped_selection');
  const wordsHandoff = validateWordsHandoff({ tasks, plan, handoff, reviews, checkedMusic: checked });
  const storyMusicResponses = validateStoryMusicResponses({ handoff, brief, tasks, plan,
    checkedMusic: checked, durationSeconds });
  return { status: 'verified_records_only', computed_plan_sha256: computedPlanSha256,
    creative_handoff: { path: handoffFile, sha256: binding.sha256 }, inputs, music_cues: checked,
    story_music_responses: storyMusicResponses, words_handoff: wordsHandoff,
    semantic_assessment: 'not_performed', artistic_acceptance: 'not_assessed', production_approval: false,
    limitations: ['Supplied observations and qualification records are not independently heard or authenticated.',
      'Excerpt ancestry is declared; no waveform derivation is verified.',
      'This gate checks current identity and ranges, not narrative truth or artistic quality.'] };
}
