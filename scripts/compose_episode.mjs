import { projectTrialPreflight } from './project_trial_gate.mjs';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { prepareEpisode } from './prepare_episode.mjs';
import { prepareAnalysisRequest, validateAnalysisResponse, directorResponseSchema } from './analysis_bridge.mjs';
import { ApiSession, readJson, saveJson, objectSchema, providerReadiness,
  resolveAudioBackend, validateAudioQualification, audioBackendMatches, verifyEvidenceBindings } from './audio_api.mjs';
import { HostFileSession, HostResponsePendingError } from './host_runtime.mjs';
import { hashFile } from './render_binding.mjs';
import { hashCreativePlan } from './validate_creative_handoff.mjs';
import { runSoundJob } from './run_sound_job.mjs';
import { enforceEpisodeMusicSourceBudget, inspectEpisodeReferenceMusicSupply } from './music_source_delivery_gate.mjs';
import { prepareReviewWindow } from './prepare_review_window.mjs';
import { createVerifiedGap } from './local_gap_creation.mjs';
import { soundArcPlanSchema, compileSoundArcPlan, validateSoundArcSeams } from './sound_arc_plan.mjs';
import { applySoundArcEdits } from './sound_arc_edit.mjs';
import { musicEditSchema, sliceGainEnvelope, compileActionPieceMappings } from './music_edit_operation_contract.mjs';
import { soundQueryInstruction, checkSoundQueryCoverage, withSoundQueryCoverageSchema,
  writeSoundQueryCompletionRequests } from './sound_query_contract.mjs';
import { recentMusicContext } from './recent_music_context.mjs';
import { loadMusicProfile, filterMusicProfileRoutes, musicProfileDirectionGaps, filterReferenceMaterialRoutes } from './music_profile.mjs';
import { createCaseMatcher } from './case_host_adapter.mjs';
import { prepareLocalResearchEvidence } from './local_research_evidence.mjs';
import { loadResearchStoryResume, restoreBoundResearchStory, recordResearchStoryResume, researchConfigDigest,
  captureLocalResearchDependencies, createLocalResearchCheckpoint, restoreLocalResearchCheckpoint } from './research_story_resume.mjs';
import { withDirectionSemanticsV2, directionSemanticsInstruction, vocalLanguageMatches, loadDirectionSemanticRepair } from './direction_semantics.mjs';
import { captureResearchDirectionDependencies, createResearchDirectionCheckpoint, restoreResearchDirectionCheckpoint } from './research_direction_resume.mjs';
import {withDirectionEditCapabilities,directionEditCapabilityGaps} from './typed_bounded_style_director.mjs';
import {withDirectionSoundPropulsion} from './direction_sound_propulsion.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const refs = path.resolve(here, '../references');
const str = { type: 'string' }, num = { type: 'number' }, strings = { type: 'array', items: str };
const range = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const nullableRange = { ...range, type: ['array', 'null'] };
const list = items => ({ type: 'array', items });
const exists = async file => { try { await readFile(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const overlap = (a, b) => a[1] > b[0] && a[0] < b[1];
const validRange = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] >= 0 && r[1] > r[0];
const languageCode = value => {
  const name = value.trim().toLowerCase();
  if (/^(zh(?:-.*)?|中文|普通话|chinese(?: mandarin)?|mandarin)$/.test(name)) return 'zh';
  if (/^(en(?:-.*)?|英语|english)$/.test(name)) return 'en';
  return /^[a-z]{2,3}$/.test(name) ? name : 'unknown';
};
const normalizedWords = value => (value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const actualWordsMatch = (task, decision, observation) => {
  const heard = observation.words.filter(row => row.kind === 'sung').map(row => row.text).join('');
  return observation.vocal_type === 'sung' && normalizedWords(decision.actual_words)
    && normalizedWords(heard).includes(normalizedWords(decision.actual_words))
    && languageCode(observation.language) === decision.verified_language
    && vocalLanguageMatches(task.vocal_language, decision.verified_language);
};
export function hasCompleteSungPhrase(observation, decision, duration) {
  const phrase = observation.sung_phrase;
  return Array.isArray(observation.uncertainties) && observation.uncertainties.length === 0
    && phrase?.complete_phrase === true && typeof phrase.reason === 'string' && phrase.reason.trim().length > 0
    && normalizedWords(phrase.actual_words).length > 0 && normalizedWords(phrase.actual_words) === normalizedWords(decision.actual_words)
    && Number.isFinite(phrase.start_seconds) && Number.isFinite(phrase.end_seconds)
    && phrase.start_seconds >= 0 && phrase.end_seconds > phrase.start_seconds && phrase.end_seconds <= duration;
}

export const directionSchema = objectSchema({
  audience: { type: 'string', enum: ['auto', 'male', 'female'] },
  music_actions: list(objectSchema({ id: str, story_beat_id: str, target_range: range, intent: str,
    requirement: { type: 'string', enum: ['response', 'hold'] } })),
  cues: list(objectSchema({ cue_id: str, target_range: range, function: str, sound_goal: str,
    expert_ids: strings, source_tag_queries: strings, audio_retrieval_query: str,
    story_beat_ids: strings, required_action_ids: strings,
    words_candidate_request: { type: ['string', 'null'], enum: ['explore', 'require', null] },
    words_target_range: nullableRange, words_mode: { type: 'string', enum: ['song_replace', 'same_source_development'] },
    words_function: str, words_audio_retrieval_query: str,
    vocal_language: { type: 'string', pattern: '^(?:[a-z]{2,3}|unknown)$' } })),
  sound_queries: list(objectSchema({ event_id: str, text: str,
    asset_kind: { type: 'string', enum: ['sfx', 'ambience'] } })),
  uncertainties: strings,
});

const nullableString = { type: ['string', 'null'] };
const caseConditionsSchema = objectSchema(Object.fromEntries([
  'perspective', 'relationship', 'control_state', 'control_change', 'expectation_state',
  'era', 'dialogue_density', 'knowledge_state', 'narrative_function',
].map(key => [key, nullableString]).concat([['threat_resolved', { type: ['boolean', 'null'] }]])));
const caseDirectionSchema = structuredClone(directionSchema);
Object.assign(caseDirectionSchema.properties.cues.items.properties, {
  case_conditions: caseConditionsSchema, exclude_case_conditions: list(caseConditionsSchema),
});
caseDirectionSchema.properties.cues.items.required.push('case_conditions', 'exclude_case_conditions');
const storyStateSchema = structuredClone(caseConditionsSchema);
export const caseSequenceDirectionSchema = structuredClone(caseDirectionSchema);
caseSequenceDirectionSchema.properties.cues.items.properties.story_sequence = { ...list(objectSchema({
  step_id: str, narrative_function: str, before: storyStateSchema, after: storyStateSchema,
  event_anchor: { ...objectSchema({ story_beat_id: str, target_seconds: num, evidence_ids: strings }), type: ['object', 'null'] },
})), minItems: 1 };
caseSequenceDirectionSchema.properties.cues.items.required.push('story_sequence');

export function candidateWindowKey(cueId, candidate, window) {
  return `${cueId}:${candidate.source_sha256}:${JSON.stringify(window)}`;
}

export function candidateAuditionWindow(candidate, length) {
  const allowed = candidate.case_source_range ?? candidate.source_range;
  if (!validRange(allowed) || length > 180 || allowed[1] - allowed[0] + 1 / 48000 < length) return null;
  const encoded = candidate.encoded_window?.source_range ?? allowed;
  const auditionLength = Math.min(allowed[1] - allowed[0], length + 8, 180);
  const start = Math.max(allowed[0], Math.min(allowed[1] - auditionLength, encoded[0] - 4));
  return [start, start + auditionLength];
}

const comparisonSchema = objectSchema({ decisions: list(objectSchema({ cue_id: str,
  selected_segment_id: { type: ['string', 'null'] }, selected_source_range: nullableRange, reason: str,
  alternatives: list(objectSchema({ segment_id: str, reason: str })),
  lyric_fit: str, verified_language: str, actual_words: str,
  stock_gap: { type: 'boolean' }, missing_sound_description: str })), uncertainties: strings });
const arcPlanningSchema = objectSchema({ plan: { ...soundArcPlanSchema, type: ['object', 'null'] }, unresolved_gaps: strings });

export const editSchema = objectSchema({
  music_edits: list(objectSchema({ music_task_cue_id: str, gain_db: num,
    fade_in_seconds: num, fade_out_seconds: num, transition_reason: str })),
  action_responses: list(objectSchema({ action_id: str, music_task_cue_id: str, target_range: range,
    response_kind: { type: 'string', enum: ['replace', 'source_development', 'hold'] }, reason: str })),
  sounds: list(objectSchema({ event_id: str, selected_segment_id: { type: ['string', 'null'] },
    decision: { type: 'string', enum: ['new_asset', 'retain_original', 'omit', 'missing_asset', 'needs_review'] },
    original_status: { type: 'string', enum: ['verified_present', 'verified_missing', 'verified_insufficient', 'unknown'] },
    source_range: nullableRange, target_seconds: num, source_anchor_seconds: num,
    gain_db: num, fade_in_seconds: num, fade_out_seconds: num, reason: str, anchor_evidence: str })),
  dialogue_ducking_db: num, uncertainties: strings,
});
export const editSchemaV2 = musicEditSchema(editSchema, 2);
export const editSchemaFor = version => version === 2 ? editSchemaV2 : editSchema;

// Models supply IDs and artistic decisions. Only this compiler resolves local paths.
export function compileEdit({ edits, tasks, routes, analysis, manifestPath, duration, audience, craftMode, evidence, dialogueIntervals, execution = 'api', arcManifest, researchSeamReview }) {
  if (!['api', 'host', 'local'].includes(execution)) throw new Error('explicit_execution_origin_required');
  const authoredDucking = edits.dialogue_ducking_db;
  if (!Number.isFinite(authoredDucking) || Math.abs(authoredDucking) > 18)
    throw new Error('editor_dialogue_ducking_must_be_finite_and_within_18db');
  // Legacy editors use either a positive attenuation amount or a negative
  // music-gain delta. Both mean lowering music; the renderer accepts amounts.
  const rendererDucking = Math.abs(authoredDucking);
  const assets = new Map(), cues = [], selections = [], transitions = [];
  const routeMap = new Map(routes.cues.map(row => [row.cue_id, row]));
  const addAsset = selected => {
    const id = selected.asset_id;
    if (assets.has(id) && assets.get(id).sha256 !== selected.source_sha256) throw new Error('asset_identity_conflict');
    assets.set(id, { id, path: selected.local_path, sha256: selected.source_sha256 }); return id;
  };
  const musicEdit = new Map(edits.music_edits.map(row => [row.music_task_cue_id, row]));
  if (musicEdit.size !== edits.music_edits.length || musicEdit.size !== tasks.cues.length) throw new Error('exact_music_edit_tasks_required');
  for (const task of tasks.cues) {
    const selected = routeMap.get(task.cue_id)?.selected, edit = musicEdit.get(task.cue_id);
    if (!selected || !edit || !Number.isFinite(edit.gain_db) || edit.gain_db < -40 || edit.gain_db > 12) throw new Error('selected_music_and_sensible_gain_required');
    const words = tasks.cues.filter(row => row.parent_cue_id === task.cue_id);
    let targets = [task.target_range];
    if (task.music_role !== 'words_candidate') {
      for (const child of words) targets = targets.flatMap(r => overlap(r, child.target_range)
        ? [[r[0], child.target_range[0]], [child.target_range[1], r[1]]].filter(p => p[1] > p[0]) : [r]);
    }
    for (const [index, target] of targets.entries()) {
      const sourceIn = selected.source_range[0] + target[0] - task.target_range[0];
      const sourceOut = sourceIn + target[1] - target[0];
      if (!validRange(target) || target[1] > duration + 1 / 48000 || sourceOut > selected.source_range[1] + 1 / 48000) throw new Error('music_edit_outside_heard_source');
      const id = `${task.cue_id}#${index + 1}`;
      const cue = { id, track: 'bgm', asset_id: addAsset(selected), source_in_seconds: sourceIn,
        source_out_seconds: sourceOut, start_seconds: target[0], gain_db: edit.gain_db,
        fade_in_seconds: edit.fade_in_seconds, fade_out_seconds: edit.fade_out_seconds,
        fade_curve: 'raised_cosine', music_role: task.music_role === 'words_candidate' ? 'words_candidate' : 'primary' };
      if (edits.schema_version === 2 && edit.gain_envelope !== null)
        cue.gain_envelope = sliceGainEnvelope(edit.gain_envelope, task.target_range[1] - task.target_range[0],
          target.map(t => t - task.target_range[0]), edit.gain_db);
      if (task.music_role === 'words_candidate') {
        cue.parent_plan_cue_id = `${task.parent_cue_id}#1`; cue.words_mode = task.words_mode;
        transitions.push({ from_cue_id: cue.parent_plan_cue_id, to_cue_id: id, transition_type: task.words_mode, reason: edit.transition_reason });
      }
      cues.push(cue); selections.push({ plan_cue_id: id, music_task_cue_id: task.cue_id });
    }
  }
  cues.sort((a, b) => a.start_seconds - b.start_seconds);
  for (const sung of cues.filter(cue => cue.music_role === 'words_candidate')) {
    const child = tasks.cues.find(task => task.cue_id === selections.find(row => row.plan_cue_id === sung.id)?.music_task_cue_id);
    const end = sung.start_seconds + sung.source_out_seconds - sung.source_in_seconds;
    const returned = cues.find(cue => cue.music_role === 'primary' && Math.abs(cue.start_seconds - end) <= 1 / 48000
      && selections.some(row => row.plan_cue_id === cue.id && row.music_task_cue_id === child?.parent_cue_id));
    if (returned) transitions.push({ from_cue_id: sung.id, to_cue_id: returned.id,
      transition_type: child.words_mode, reason: musicEdit.get(child.cue_id).transition_reason });
  }
  const primaries = cues.filter(cue => cue.music_role === 'primary');
  for (let i = 1; arcManifest?.schema_version !== 2 && i < primaries.length; i++) {
    const before = primaries[i - 1], after = primaries[i];
    const end = before.start_seconds + before.source_out_seconds - before.source_in_seconds;
    const contiguous = Math.abs(end - after.start_seconds) <= 1 / 48000;
    const sameSource = before.asset_id === after.asset_id && Math.abs(before.source_out_seconds - after.source_in_seconds) <= 1 / 48000;
    transitions.push({ from_cue_id: before.id, to_cue_id: after.id,
      transition_type: contiguous && sameSource ? 'source_continuation' : after.start_seconds < end
        ? 'overlapping_edit' : contiguous ? 'butt_join' : 'separated_edit',
      reason: musicEdit.get(selections.find(row => row.plan_cue_id === after.id).music_task_cue_id).transition_reason });
  }
  const arcEdits = applySoundArcEdits({ arcManifest, cues, selections, routes, duration, researchSeamReview });
  if (arcEdits.edit_receipt) {
    const alias = new Map(arcEdits.edit_receipt.original_selections.map((row, i) => [row.plan_cue_id, arcEdits.selections[i].plan_cue_id]));
    const wordsTransitions = transitions.map(row => ({ ...row, from_cue_id: alias.get(row.from_cue_id) ?? row.from_cue_id,
      to_cue_id: alias.get(row.to_cue_id) ?? row.to_cue_id })).filter(row => row.from_cue_id !== row.to_cue_id);
    cues.splice(0, cues.length, ...arcEdits.cues); selections.splice(0, selections.length, ...arcEdits.selections);
    transitions.splice(0, transitions.length, ...wordsTransitions, ...arcEdits.transitions);
  }
  const actionResponses = edits.action_responses.map(row => {
    if (edits.schema_version === 2) {
      const mappings = compileActionPieceMappings(row, tasks, cues, selections);
      return { ...row, plan_cue_id: mappings[0].plan_cue_id,
        source_range: mappings.length === 1 ? mappings[0].source_range : null, plan_piece_mappings: mappings };
    }
    const pieces = cues.filter(cue => selections.some(s => s.plan_cue_id === cue.id && s.music_task_cue_id === row.music_task_cue_id)
      && row.target_range[0] >= cue.start_seconds - 1 / 48000
      && row.target_range[1] <= cue.start_seconds + cue.source_out_seconds - cue.source_in_seconds + 1 / 48000);
    if (pieces.length !== 1) throw new Error('action_response_requires_one_actual_music_piece');
    const cue = pieces[0];
    return { ...row, plan_cue_id: cue.id, source_range: row.target_range.map(t => cue.source_in_seconds + t - cue.start_seconds) };
  });
  const eventMap = new Map(analysis.sound_events.map(row => [row.id, row]));
  if (edits.sounds.length !== eventMap.size || new Set(edits.sounds.map(row => row.event_id)).size !== eventMap.size) throw new Error('exact_sound_event_decisions_required');
  const events = edits.sounds.map(row => {
    const event = eventMap.get(row.event_id); if (!event) throw new Error('unknown_sound_event');
    const soundRole = event.role === 'transition' ? 'dramatic' : event.role;
    const result = { id: event.id, sound_role: soundRole, evidence: event.reason, reason: row.reason,
      required: event.decision === 'seek_asset', original_status: row.original_status, decision: row.decision };
    if (row.decision === 'new_asset') {
      const pointer = evidence.sounds.find(p => p.event_id === event.id && p.segment_id === row.selected_segment_id);
      if (!pointer || !validRange(row.source_range) || row.source_range[0] < pointer.source_range[0]
        || row.source_range[1] > pointer.source_range[1]) throw new Error('sound_edit_outside_heard_source');
      const bed=pointer.duration_role==='bed'&&soundRole!=='ambience';
      if(bed&&(!Number.isFinite(row.target_seconds)||Math.abs(row.target_seconds-event.start_seconds)>1/48000
        ||row.source_range[0]!==pointer.source_range[0]||row.source_anchor_seconds!==row.source_range[0]
        ||pointer.source_anchor_seconds!==row.source_range[0]
        ||Math.abs(row.source_range[1]-row.source_range[0]-(event.end_seconds-event.start_seconds))>1/48000))
        throw new Error('sound_bed_requires_actual_window_start_and_full_event_coverage');
      const id = `sound/${event.id}`, cue = { id, track: soundRole === 'ambience' ? 'ambience' : 'sfx',
        asset_id: addAsset(pointer), source_in_seconds: row.source_range[0], source_out_seconds: row.source_range[1],
        gain_db: row.gain_db, fade_in_seconds: row.fade_in_seconds, fade_out_seconds: row.fade_out_seconds, fade_curve: 'raised_cosine' };
      if (soundRole === 'ambience'||bed) cue.start_seconds = row.target_seconds;
      else cue.sync = { target_seconds: row.target_seconds, source_anchor_seconds: row.source_anchor_seconds };
      cues.push(cue); result.cue_id = id; result.anchor_evidence = row.anchor_evidence;
      if (bed) {
        // Preserve the already bound sustained-window proof. A bed starts at
        // the current event boundary; it is not a point transient with sync.
        result.duration_role = 'bed';
        result.current_event_target_range = [event.start_seconds, event.end_seconds];
        result.source_placement = Object.fromEntries(['duration_role', 'local_path', 'source_sha256',
          'source_anchor_seconds', 'event_id', 'current_event_target_range', 'current_target_video_sha256',
          'source_anchor_evidence', 'anchor_review_status'].map(key => [key, pointer[key]]));
        result.source_placement.source_range = [...row.source_range];
      }
    }
    return result;
  });
  const beats = analysis.story_beats.map(beat => ({ ...beat,
    cue_ids: cues.filter(cue => {
      const start = cue.start_seconds ?? cue.sync.target_seconds - cue.sync.source_anchor_seconds + cue.source_in_seconds;
      return overlap([start, start + cue.source_out_seconds - cue.source_in_seconds], [beat.start_seconds, beat.end_seconds]);
    }).map(cue => cue.id),
    evidence_refs: beat.evidence_ids.map(id => evidence.refs.get(id)).filter(Boolean),
  }));
  const design = { director_contract_version: 2, craft_mode: craftMode, business_phase: 'unknown',
    first_paywall: { episode: null, time_seconds: null }, story_beats: beats, transitions,
    sound_events: events, sound_event_none_reason: analysis.sound_event_none_reason };
  const plan = { schema_version: 1, manifest: manifestPath, audience, mode: 'materials', execution,
    original_audio_kind: analysis.original_audio.kind, dialogue_intervals: dialogueIntervals,
    dialogue_ducking_db: rendererDucking, assets: [...assets.values()], cues };
  return { plan, design, selections, actionResponses,
    ...(edits.schema_version === 2 ? { music_action_bindings: { schema_version: 2,
      tasks: tasks.cues.map(row => ({ cue_id: row.cue_id, target_range: row.target_range,
        music_role: row.music_role ?? 'primary' })),
      sources: routes.cues.map(row => ({ cue_id: row.cue_id, asset_id: row.selected.asset_id,
        source_sha256: row.selected.source_sha256, source_range: row.selected.source_range })) } } : {}),
    dialogue_ducking_unit_conversion: { authored_value: authoredDucking,
      authored_interpretation: authoredDucking < 0 ? 'legacy_signed_music_gain_reduction_db' : 'positive_music_attenuation_db',
      renderer_attenuation_db: rendererDucking, original_editor_value_changed: false, original_dialogue_gain_changed: false },
    ...(arcEdits.edit_receipt ? { arc_edit_receipt: arcEdits.edit_receipt } : {}) };
}

async function python(config, script, args) {
  const result = await execute(config.python || 'python', [path.join(here, script), ...args],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return result.stdout;
}

async function freezeSelection({ config, directorFile, styleFile, out, task, selected, decision, qualification }) {
  await mkdir(out, { recursive: true });
  const wordsEvidence = task.music_role === 'words_candidate' ? { content_status: 'verified', source_sha256: selected.source_sha256,
    source_range: selected.source_range, vocal_presence: 'sung', vocal_language: decision.verified_language,
    actual_words: decision.actual_words, complete_phrase: true } : null;
  const listeningEvidence = { backend_id: selected.observation_record.backend_id,
    model_revision: selected.observation_record.model_revision, protocol: selected.observation_record.protocol, actual_audio_processed: true,
    observations: JSON.stringify(selected.observation_record.observation), qualification_record: qualification,
    input_audio: selected.observation_record.input_audio, observation_record: selected.observation_record.file };
  const requestFile = path.join(out, 'request.json');
  await saveJson(requestFile, { schema_version: 1, cue_id: task.cue_id,
    candidates: [{ segment_id: selected.segment_id, source_range: selected.source_range }] });
  const args = [directorFile, '--style-result', styleFile, '--request', requestFile, '--db', config.library.db];
  const prepDir = path.join(out, 'prepare');
  await python(config, 'materialize_music_task.py', [...args, '--out', prepDir]);
  const preparation = await readJson(path.join(prepDir, 'preparation.json')), functionFile = path.join(out, 'function.json');
  await saveJson(functionFile, { schema_version: 1, preparation_sha256: preparation.preparation_sha256,
    observations: [{ segment_id: selected.segment_id, source_sha256: selected.source_sha256,
      source_range: selected.source_range, function: task.query.function, reason: decision.reason,
      listening_evidence: listeningEvidence, ...(wordsEvidence ? { words_evidence: wordsEvidence } : {}) }] });
  const formalDir = path.join(out, 'formal');
  await python(config, 'materialize_music_task.py', [...args, '--function-observations', functionFile, '--out', formalDir]);
  const formal = await readJson(path.join(formalDir, 'preparation.json'));
  if (!formal.frozen_task) return null;
  const route = formal.route.cues[0], review = { cue_id: task.cue_id, segment_id: selected.segment_id,
    cue_sha256: route.cue_sha256, query_sha256: route.query_sha256, source_sha256: selected.source_sha256,
    candidate_source_range: route.retrieval.candidates[0].source_range, source_range: selected.source_range,
    verdict: 'selected', reason: decision.reason, listening_evidence: listeningEvidence,
    ...(wordsEvidence ? { words_evidence: wordsEvidence } : {}) };
  const reviewFile = path.join(formalDir, 'reviews.json'), routeFile = path.join(formalDir, 'reviewed-route.json');
  await saveJson(reviewFile, { schema_version: 1, reviews: [review] });
  await python(config, 'route_music_cues.py', [path.join(formalDir, 'music-tasks.json'), '--db', config.library.db,
    '--reviews', reviewFile, '--out', routeFile]);
  const reviewed = await readJson(routeFile);
  return reviewed.cues[0].status === 'ready_for_edit' ? { task: formal.frozen_task.cues[0], review, route: reviewed.cues[0] } : null;
}

async function startResidentRetriever(config) {
  const child = spawn(config.python || 'python', [path.join(here, 'resident_music_retriever.py'),
    '--index', config.library.index, '--weights', config.library.weights, '--device', config.library.device || 'cpu'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    let timer;
    try {
      const row = await Promise.race([lines.next(), new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error('resident_retriever_timeout')); }, 120000);
        child.once('error', () => reject(new Error('resident_retriever_start_failed')));
      })]);
      if (row.done) throw new Error('resident_retriever_exited'); return JSON.parse(row.value);
    } finally { clearTimeout(timer); }
  };
  const ready = await next(); if (ready.status !== 'ready') { child.kill(); throw new Error('resident_retriever_not_ready'); }
  return { async search(text, limit, allowed_asset_ids) {
    child.stdin.write(JSON.stringify({ text, limit, allowed_asset_ids }) + '\n');
    const result = await next(); if (result.status === 'query_failed') throw new Error('resident_retriever_query_failed'); return result;
  }, close() { child.stdin.end(); child.kill(); } };
}

export async function rankResidentCandidates(style, retriever, limit) {
  const cues = [];
  for (const cue of style.cues) {
    const branches = style.branches.filter(row => row.parent_cue_id === cue.cue_id);
    const allowed = branches.flatMap(b => b.route.cues[0].retrieval?.candidates ?? []);
    const text = branches[0].frozen_task.cues[0].audio_retrieval_query;
    const result = await retriever.search(text, Math.min(200, Math.max(limit, allowed.length)), [...new Set(allowed.map(c => c.asset_id))]);
    const pool = [];
    for (const hit of result.candidates) {
      const candidate = allowed.find(c => c.asset_id === hit.asset_id && c.source_sha256 === hit.source_sha256
        && c.source_range[0] <= hit.source_range[0] && c.source_range[1] >= hit.source_range[1]);
      if (!candidate || pool.some(c => c.source_sha256 === hit.source_sha256
        && JSON.stringify(c.encoded_window.source_range) === JSON.stringify(hit.source_range))) continue;
      pool.push({ ...candidate, encoded_window: hit, similarity: hit.similarity, selected: false });
      if (pool.length === limit) break;
    }
    cues.push({ cue_id: cue.cue_id, audio_retrieval_query: text, candidate_pool: pool, status: pool.length ? 'awaiting_audition' : 'no_encoded_allowed_candidates' });
  }
  return { schema_version: 1, score_type: 'audio_text_cosine_not_artistic_quality', cues };
}

// Case records propose windows; the existing library/router still resolves and binds the files.
export async function prepareCaseStyle(config, directorFile, caseFile, { allowShortWindows = false } = {}) {
  const code = `import sys,json,pathlib\n`
    + `sys.path.insert(0,sys.argv[1]);import route_music_cues as r\n`
    + `director=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'));cases=json.loads(pathlib.Path(sys.argv[3]).read_text(encoding='utf-8-sig'));db=sys.argv[4]\n`
    + `result={'schema_version':1,'director_sha256':r.json_hash(director),'database_sha256':r.library.digest_file(db),'branches':[],'cues':[],'strategy':'case_presets','gaps':[]}\n`
    + `for cue in r.expand_music_cues(director):\n`
    + ` parent=cue.get('arc_parent_cue_id',cue['cue_id']);proposed=[{**c,'case_route_id':route['route_id'],'case_ids':route['case_ids'],'music_pack_id':route['music_pack_id'],'case_applicability':route['applicability']} for route in cases.get('routes',[]) for c in route.get('source_candidates',[]) if c.get('cue_id')==parent and c.get('applicability',{}).get('eligible_for_current_review') is True]\n`
    + ` requested=cue.get('requested_candidates',[]);proposed=[c for c in proposed if not requested or any(p['segment_id']==c['segment_id'] and p['source_sha256']==c['source_sha256'] and p['source_range'][0]>=c['source_range'][0] and p['source_range'][1]<=c['source_range'][1] for p in requested)]\n`
    + ` ids=list(dict.fromkeys(c['segment_id'] for c in proposed));query={'text':'','function':cue['function'],'asset_kind':'music','candidate_segment_ids':ids,'min_duration':${allowShortWindows ? '0.02' : "cue['target_range'][1]-cue['target_range'][0]"},'limit':max(1,len(ids)),'discover_unknown_functions':True,'usage_scope':director.get('usage_scope','research_noncommercial')}\n`
    + ` if cue.get('music_role')=='words_candidate':query.update(vocals='sung',discover_unknown_vocals=True)\n`
    + ` frozen={k:v for k,v in cue.items() if k not in ('function','expert_ids','filters')};frozen['query']=query\n`
    + ` task={'schema_version':1,'source_video_sha256':director['source_video_sha256'],'director_brief_sha256':director['director_brief_sha256'],'usage_scope':director.get('usage_scope','research_noncommercial'),'cues':[frozen]}\n`
    + ` routed=r.route_music_cues(task,db) if ids else {'schema_version':1,'database_sha256':result['database_sha256'],'task_sha256':r.json_hash(task),'cues':[{'cue_id':cue['cue_id'],'status':'case_preset_gap','retrieval':{'candidates':[]}}]}\n`
    + ` branch={'branch_id':cue['cue_id']+'/case_presets','parent_cue_id':cue['cue_id'],'frozen_task':task,'route':routed};result['branches'].append(branch);pool=[]\n`
    + ` for proposed_window in proposed:\n`
    + `  actual=next((c for c in routed['cues'][0].get('retrieval',{}).get('candidates',[]) if c['segment_id']==proposed_window['segment_id']),None)\n`
    + `  window=proposed_window.get('case_source_range',proposed_window.get('source_range'))\n`
    + `  if requested:window=next(p['source_range'] for p in requested if p['segment_id']==proposed_window['segment_id'] and p['source_sha256']==proposed_window['source_sha256'])\n`
    + `  if actual is None:result['gaps'].append({'cue_id':cue['cue_id'],'segment_id':proposed_window['segment_id'],'reason':'case_source_not_eligible_in_current_library'});continue\n`
    + `  if actual['asset_id']!=proposed_window.get('asset_id') or actual['source_sha256']!=proposed_window.get('source_sha256') or not r.valid_range(window) or window[0]<actual['source_range'][0] or window[1]>actual['source_range'][1]:raise ValueError('case_source_identity_or_window_mismatch')\n`
    + `  if window[1]-window[0]+.001<query['min_duration']:result['gaps'].append({'cue_id':cue['cue_id'],'segment_id':actual['segment_id'],'reason':'case_source_window_too_short'});continue\n`
    + `  if any(c['source_sha256']==actual['source_sha256'] and c['case_source_range']==window for c in pool):continue\n`
    + `  pool.append({**actual,'branch_id':branch['branch_id'],'case_source_range':window,'encoded_window':{'source_range':window},'case_route_id':proposed_window['case_route_id'],'case_ids':proposed_window['case_ids'],'music_pack_id':proposed_window['music_pack_id'],'case_applicability':proposed_window['case_applicability'],'selected':False})\n`
    + ` result['cues'].append({'cue_id':cue['cue_id'],'target_range':cue['target_range'],'function':cue['function'],'candidate_pool':pool,'status':'awaiting_audition' if pool else 'case_preset_gap'})\n`
    + `print(json.dumps(result,ensure_ascii=False,allow_nan=False))\n`;
  const result = await execute(config.python || 'python', ['-X', 'utf8', '-c', code, here, directorFile, caseFile, config.library.db],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

export function validateCaseEventAnchors(director, analysis, duration) {
  if (director.source_video_sha256 !== analysis.source_video_sha256 || !Number.isFinite(duration) || duration <= 0)
    throw new Error('current_case_event_source_mismatch');
  const beats = new Map(analysis.story_beats.map(beat => [beat.id, beat]));
  if (beats.size !== analysis.story_beats.length) throw new Error('current_case_event_beat_ids_must_be_unique');
  const locations = [], pending = [];
  for (const cue of director.cues) {
    const stepIds = new Set(); let previous = -1;
    for (const step of cue.story_sequence ?? []) {
      if (stepIds.has(step.step_id)) throw new Error('current_case_event_step_ids_must_be_unique');
      stepIds.add(step.step_id);
      const anchor = step.event_anchor;
      if (anchor == null) {
        pending.push({ cue_id: cue.cue_id, story_step_id: step.step_id, reason: 'requires_current_event_location' });
        continue;
      }
      const beat = beats.get(anchor.story_beat_id), seconds = anchor.target_seconds;
      if (!beat || !cue.story_beat_ids?.includes(beat.id)) throw new Error('current_case_event_beat_id_invalid');
      if (!Number.isFinite(seconds) || seconds < 0 || seconds >= duration
        || seconds < beat.start_seconds || seconds >= beat.end_seconds
        || seconds < cue.target_range[0] || seconds >= cue.target_range[1])
        throw new Error('current_case_event_anchor_outside_current_beat_or_cue');
      if (!Array.isArray(anchor.evidence_ids) || !anchor.evidence_ids.length
        || new Set(anchor.evidence_ids).size !== anchor.evidence_ids.length
        || anchor.evidence_ids.some(id => !beat.evidence_ids.includes(id)))
        throw new Error('current_case_event_evidence_ids_invalid');
      if (seconds < previous) throw new Error('current_case_event_anchor_order_invalid');
      previous = seconds;
      locations.push({ cue_id: cue.cue_id, story_step_id: step.step_id,
        event_anchor: structuredClone(anchor), target_beat_range: [beat.start_seconds, beat.end_seconds] });
    }
  }
  return { source_video_sha256: director.source_video_sha256, locations, pending,
    location_assessment: pending.length ? 'requires_current_event_location' : 'bound_to_current_analysis',
    semantic_assessment: 'not_performed', formal_adoption_allowed: false };
}

// A retrieved reference may contain events absent from the current story.
export function adaptCaseDevelopment(document, current) {
  const located = current && validateCaseEventAnchors(current.director, current.analysis, current.duration);
  return { ...document, routes: document.routes.map(route => {
    const match = route.structure_match;
    if (!match?.steps?.length) return current && route.development_preset?.steps?.length ? {
      ...route, adaptation: { source_route_id: route.route_id, reference_seconds_are_not_target_seconds: true,
        pending_current_event_locations: [{ cue_id: route.cue_id, reason: 'reference_story_mapping_missing' }] },
    } : route;
    const mapping = new Map(match.steps.map(step => [step.reference_story_step_id, step.target_story_step_id]));
    if (mapping.size !== match.steps.length || new Set(mapping.values()).size !== mapping.size)
      throw new Error('case_story_mapping_must_be_unique');
    const receipts = [], pending = [];
    const steps = (route.development_preset?.steps ?? []).filter(step => mapping.has(step.story_step_id)).map(step => {
      const target = mapping.get(step.story_step_id);
      const location = located?.locations.find(row => row.cue_id === route.cue_id && row.story_step_id === target);
      if (current && !location) pending.push({ cue_id: route.cue_id, development_step_id: step.step_id,
        story_step_id: target, reason: 'requires_current_event_location' });
      if (location) receipts.push({ ...location, development_step_id: step.step_id,
        reference_story_step_id: step.story_step_id, source_event_id: step.source_event_id ?? null,
        source_video_sha256: current.director.source_video_sha256 });
      const adapted = { ...step, reference_story_step_id: step.story_step_id, story_step_id: target,
        target_anchor_status: location ? 'bound_to_current_analysis' : 'requires_current_event_location' };
      delete adapted.event_anchor;
      if (location) adapted.event_anchor = structuredClone(location.event_anchor);
      return adapted;
    });
    const permittedAnchors = new Set(steps.map(step => step.anchor));
    const actions = route.beat_action_map ?? [];
    const unmapped = actions.filter(action => !permittedAnchors.has(action.anchor));
    return { ...route, development_preset: { ...route.development_preset, steps },
      beat_action_map: actions.filter(action => permittedAnchors.has(action.anchor)),
      adaptation: { source_route_id: route.route_id, source_step_count: route.development_preset?.steps?.length ?? 0,
        mapped_step_count: steps.length, unmapped_reference_actions: unmapped,
        reference_seconds_are_not_target_seconds: true,
        ...(current ? { current_event_locations: receipts, pending_current_event_locations: pending } : {}) } };
  }) };
}

export async function retrieveCaseRules(config, routes) {
  if (!config.cases?.rules_db) return [];
  const caseIds = [...new Set(routes.routes.flatMap(route => route.case_ids ?? []))];
  if (!caseIds.length) return [];
  const database = { path: path.resolve(config.cases.rules_db), sha256: await hashFile(config.cases.rules_db) };
  // Preserve full records in the readonly index; the director receives criteria and exact evidence references.
  const code = 'import sys,json,sqlite3,pathlib,hashlib\n'
    + 'db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True);ids=json.loads(sys.argv[2])\n'
    + 'database=json.loads(sys.argv[3]);digest=lambda v:hashlib.sha256(json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()\n'
    + 'def project(value,rule_id,record_sha256,field_path):\n'
    + ' if isinstance(value,list): return [project(v,rule_id,record_sha256,field_path+[i]) for i,v in enumerate(value)]\n'
    + ' if not isinstance(value,dict): return value\n'
    + ' result={}\n'
    + ' for key,child in value.items():\n'
    + '  if key=="evidence_files" and isinstance(child,list) and child:\n'
    + '   if "evidence_files_reference" in value: raise ValueError("case_rule_reference_collision")\n'
    + '   result["evidence_files_reference"]={"kind":"readonly_rule_evidence_files","database":database,"rule_id":rule_id,"record_sha256":record_sha256,"field_path":field_path+[key],"count":len(child),"sha256":digest(child)}\n'
    + '  else: result[key]=project(child,rule_id,record_sha256,field_path+[key])\n'
    + ' return result\n'
    + 'sql="SELECT DISTINCT r.record_json FROM rules r JOIN rule_cases c USING(rule_id) WHERE c.case_id IN ("+",".join("?" for _ in ids)+") ORDER BY r.rule_id LIMIT 20"\n'
    + 'records=[(row[0],json.loads(row[0])) for row in db.execute(sql,ids)];db.close()\n'
    + 'print(json.dumps([project(v,v["rule_id"],hashlib.sha256(raw.encode()).hexdigest(),[]) for raw,v in records],ensure_ascii=False))\n';
  const result = await execute(config.python || 'python', ['-X', 'utf8', '-c', code, database.path, JSON.stringify(caseIds), JSON.stringify(database)],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (await hashFile(database.path) !== database.sha256) throw new Error('case_rules_db_changed_during_read');
  return JSON.parse(result.stdout);
}

// The director chooses real phrases; the compiler never fills a long arc by looping a short window.
export async function prepareCaseSoundArcs({ director, style, caseRoutes, session, observe, frames, out, musicProfile }) {
  const candidates = [], actualAudio = [];
  for (const pool of style.cues.filter(cue => !cue.cue_id.endsWith('/words'))) {
    const recordings = new Set(), windows = new Set();
    for (const candidate of pool.candidate_pool) {
      if (!recordings.has(candidate.source_sha256) && recordings.size >= 5) continue;
      const window = candidate.case_source_range ?? candidate.source_range;
      if (!validRange(window) || window[1] - window[0] > 180) continue;
      const key = candidateWindowKey(pool.cue_id, candidate, window);
      if (windows.has(key)) continue;
      windows.add(key); recordings.add(candidate.source_sha256);
      const observation = await observe({ path: candidate.local_path, source_sha256: candidate.source_sha256,
        source_range: window, segment_id: candidate.segment_id, asset_id: candidate.asset_id },
      path.join(out, 'source-observations', String(actualAudio.length)), { purpose: 'candidate',
        context: { task: pool.cue_id, phrase_boundaries_are_not_beat_predictions: true } });
      candidates.push({ ...candidate, cue_id: pool.cue_id });
      actualAudio.push({ cue_id: pool.cue_id, segment_id: candidate.segment_id, asset_id: candidate.asset_id,
        source_sha256: candidate.source_sha256, candidate_source_range: window,
        observation: observation.observation, observation_record: observation.file });
    }
  }
  await saveJson(path.join(out, 'actual-source-observations.json'), actualAudio);
  const decision = (await session.director({
    prompt: '你是短剧音乐编辑。依据真实声音观察和声音发展预设，把每个母cue规划为有因果发展的一条音乐弧线。'
      + '每个arc对应一个原cue；pieces按视频目标时间连续覆盖整个母cue，不留空洞或重叠。'
      + '只使用提供的真实segment、asset、SHA和candidate_source_range。source_range须在该已听窗内，时长等于piece目标时长。'
      + '用实际完整乐句、同主题发展或不同曲转向，不机械循环短窗，不因切镜换曲，gain变化不能冒充配器变化。'
      + '发展步骤的event_anchor才是本片当前事件定位；reference_source_events和素材source_range保留参考源时钟，不能直接当piece目标秒点。'
      + '相邻piece说明完整出句、入句和剧情连接；connection_from引用前piece。所有母cue必须保留。'
      + '母cue有words_target_range时必须完整位于一个piece中，不能拆开歌句或删掉词任务。'
      + (musicProfile ? 'music_profile是用户已选真实包的边界；仅使用包内绑定源窗，按本片剧情发展，不能因选包推定本片已经通过听审。' : '')
      + '无法用现有素材覆盖时不编造窗或实际唱词，返回plan=null和unresolved_gaps，由程序记录素材/编排缺口。',
    data: { director, case_routes: caseRoutes, actual_audio: actualAudio, ...(musicProfile ? { music_profile: musicProfile } : {}) },
    frames, schema: arcPlanningSchema, stage: 'sound_arc_planning' })).value;
  await saveJson(path.join(out, 'sound-arc-plan.json'), decision);
  const compiled = decision.plan && !decision.unresolved_gaps.length
    ? compileSoundArcPlan({ plan: decision.plan, director, candidates })
    : { splitCues: [], status: 'sound_arc_gap', pending: decision.unresolved_gaps, artistic_acceptance: 'not_assessed' };
  await saveJson(path.join(out, 'sound-arc-compiled.json'), compiled);
  return compiled;
}

export async function frozenDirectionMaterialSupply(config, sourceSupply) {
  if (!config.consumer_publication) return null;
  await verifyEvidenceBindings(config.consumer_publication);
  const publication = await readJson(config.consumer_publication.path);
  if (publication.kind !== 'frozen_offline_human_reviewed_materials') return null;
  if (path.resolve(publication.cases_db?.path ?? '') !== path.resolve(config.cases?.db ?? '')
    || path.resolve(publication.library_db?.path ?? '') !== path.resolve(config.library?.db ?? ''))
    throw new Error('direction_supply_frozen_database_mismatch');
  await verifyEvidenceBindings([publication.cases_db, publication.library_db]);
  const reviews = (publication.reviews ?? []).filter(row => row.kind === 'music');
  let completeWords = null;
  if (reviews.length <= 50 && reviews.length === publication.published_counts?.music_windows) {
    completeWords = 0;
    for (const row of reviews) {
      await verifyEvidenceBindings(row.review_record);
      const review = await readJson(row.review_record.path);
      if (review.music_form === 'short_lyrics' && review.words?.complete_phrase === true) completeWords++;
    }
  }
  return { publication: config.consumer_publication, cases_db: publication.cases_db, library_db: publication.library_db,
    offline_human_reviewed_music_packs: publication.published_counts?.music_packs ?? null,
    offline_human_reviewed_music_windows: publication.published_counts?.music_windows ?? null,
    reference_identity_window_declarations: sourceSupply?.reference_identity_window_count ?? null,
    complete_words_windows_in_this_release: completeWords, current_target_retrieval_performed: false,
    current_selection_performed: false, summary_scope: 'frozen_release_declarations_not_target_adoption',
    formal_adoption_allowed: false, production_approval: false };
}

export async function researchDirection({ config, session, record, out, manifestPath, manifest, frames, bridgeConfig, stage, musicProfile, resume, analyzedTarget }) {
  const globalDirection = config.mode === 'assisted_trial' || config.direction_contract_version === 2;
  const file = path.join(out, 'analysis-config.json'); await saveJson(file, bridgeConfig(1));
  const request = await stage('analysis_request', async () => {
    if (analyzedTarget) {
      await saveJson(path.join(out, 'analysis/request.json'), analyzedTarget.request);
      return analyzedTarget.request;
    }
    if (!resume) return prepareAnalysisRequest(file, path.join(out, 'analysis'));
    await saveJson(path.join(out, 'analysis/request.json'), resume.request);
    return resume.request;
  });
  const pcmIdentity = { original_audio_sha256: await hashFile(path.resolve(path.dirname(manifestPath), manifest.original_audio)),
    analysis_audio_sha256: await hashFile(path.resolve(path.dirname(manifestPath), manifest.analysis_audio)) };
  const evidence = await Promise.all((config.research_observation_files ?? []).map(async file => {
    const value = await readJson(file), binding = { path: path.resolve(file), sha256: await hashFile(file) };
    if (value.source_video_sha256 !== manifest.source_sha256) throw new Error('research_observation_source_mismatch');
    if (Object.entries(pcmIdentity).some(([key, sha]) => value[key] && value[key] !== sha)) throw new Error('research_observation_audio_changed');
    await verifyEvidenceBindings(value); return { binding, value };
  }));
  const prompt = await readFile(request.bindings.find(row => row.kind === 'prompt').path, 'utf8');
  const knowledge = await Promise.all(request.bindings.filter(row => row.kind === 'knowledge').map(async row => ({
    source_label: row.source_label, text: await readFile(row.path, 'utf8') })));
  const storyInput = {
    prompt: prompt
      + '\n研究候选：画面可支持剧情推理，专项观察只是未资格化证据。未实际听到的声音必须标明未知；'
      + '不得声称已经完成专业听审或选曲验收。无听辨证据时original_audio.kind必须unknown。'
      + '完整跨窗台词、字幕和连续画面共同建模虚构剧情，区分角色谎言、叙述事实与推断即可；不要求现实外部或医学证明剧情陈述，不因单帧短句碎裂制造全局剧情未知。'
      + (musicProfile ? 'music_profile是用户已选包的边界；本片剧情事实仍须独立分析，不能按包反写人物关系或威胁状态。' : ''),
    data: { schema_version: 1, request_id: request.request_id, source_video_sha256: manifest.source_sha256,
      timeline: request.timeline, controls: request.controls, instructions: request.instructions,
      evidence_catalog: request.evidence_catalog, knowledge, unqualified_research_observations: evidence,
      ...(musicProfile ? { music_profile: musicProfile } : {}) },
    frames, schema: directorResponseSchema(1), stage: 'research_story_director' };
  const analyzed = await stage('research_story_director', async () => {
    if (analyzedTarget) {
      await verifyEvidenceBindings([analyzedTarget.analysis, analyzedTarget.analysis_request]);
      record.stages.at(-1).reused = true;
      record.target_analysis = analyzedTarget.binding;
      return { value: analyzedTarget.value, raw_response: analyzedTarget.raw_response };
    }
    if (!resume) return session.director(storyInput);
    const result = typeof session.restoreResearchStory === 'function'
      ? await session.restoreResearchStory(resume, storyInput)
      : await restoreBoundResearchStory(resume, storyInput, session.backend);
    record.research_resume = await recordResearchStoryResume(resume, out);
    record.stages.at(-1).reused = true;
    return result;
  });
  if (!evidence.length && analyzed.value.original_audio.kind !== 'unknown') throw new Error('research_unheard_audio_must_remain_unknown');
  if (evidence.length && evidence.every(row => (row.value?.sound_facts_qualified ?? row.sound_facts_qualified) === false)
    && analyzed.value.original_audio.kind !== 'unknown') throw new Error('research_unqualified_audio_type_must_remain_unknown');
  const analysisFile = path.join(out, 'analysis/result.json'); await saveJson(analysisFile, analyzed.value);
  const check = await validateAnalysisResponse(path.join(out, 'analysis/request.json'), analysisFile);
  await saveJson(path.join(out, 'analysis/check.json'), check);
  if (!check.structure_valid || check.coverage_gaps.length) return Object.assign(record,
    { status: 'research_evidence_pending', analysis_check: check });
  if (session.backend?.protocol === 'codex_cli' && analyzed.raw_response?.sha256
    && (resume || await exists(path.join(session.directory, 'story-original-request.json')))) record.research_story = {
    config_identity_sha256: record.config_identity_sha256, backend: session.backend,
    request: await binding(path.join(out, 'analysis/request.json')),
    original_request: resume?.originalRequest ?? await binding(path.join(session.directory, 'story-original-request.json')),
    response: analyzed.raw_response, analysis_result: await binding(analysisFile),
    manifest: await binding(manifestPath), formal_adoption_allowed: false,
  };
  let directionRepair = null;
  if (config.direction_semantic_repair) {
    directionRepair = await loadDirectionSemanticRepair(config.direction_semantic_repair,
      { sourceSha: manifest.source_sha256, analysis: analyzed.value });
  }
  let directionInput = {
    prompt: '根据有证据的剧情步骤提出声音导演试配候选。使用music_actions和cues结构，保留未知项。'
      + '输出的是待实际听选的配乐意图、检索词和作用范围，不是已听到的配乐事实；不授予任何声音资格。' + soundQueryInstruction
      + (config.independent_retriever?.kind === 'resident_clap'
        ? '本地CLAP为英文训练的声学检索后端：audio_retrieval_query和words_audio_retrieval_query写简短、正向的英文声音描述，描述配器、动态、律动、声部发展和对白空间；不要把长中文剧情、否定词、待办或审批要求塞入向量查询。剧情冲突写入case_conditions/exclude_case_conditions，歌词的具体人物视角与词义仍单独核验。英文查询不限制歌曲语言，中文、英文及其他语言候选同样比较。' : '')
      + '完整跨窗台词、字幕和连续画面共同建模虚构剧情，区分角色谎言、叙述事实与推断即可；不要求现实外部或医学证明剧情陈述，不因单帧短句碎裂制造全局剧情未知。'
      + (globalDirection ? '逐cue填写case_conditions和排除反例。story_sequence按本片事件顺序列before/after，'
        + '亲情不能当爱情，危险未解除不能凯旋，受辱反制不配轻快搞笑。event_anchor必须引用本片beat、已有evidence_id及该beat内秒点。'
        + '不用风格词代替剧情，不为命中曲库改写人物关系；不确定条件填null。适合歌句时创建/words机会任务，按剧情比较任何已核语言的词义和对白空间，指定语言才限制。'
        + directionSemanticsInstruction : '')
      + (musicProfile ? '遵守music_profile的实际源窗、vocal_policy和剧情边界；不把同风格名称当素材，不将需要的歌句悄悄改成器乐。' : '')
      + (directionRepair ? '\n本次是绑定原style回包与错误记录的一次语义定点返修。仅修uncertainty_scopes/uncertainty_dispositions；'
        + '原uncertainties逐字、cue、music_actions、sound_queries、歌句机会和其它字段保持不变，不手选曲目或源窗。'
        + '每索引唯一scope；工序未执行用pending_work并绑定实际阶段，证据限制和带画听核用合法已有处置，不能全部放过。' : ''),
    data: { source_video_sha256: manifest.source_sha256, analysis: analyzed.value, mode: 'research', execution_mode: config.mode,
      ...(config.sfx_library?.semantic_retriever?.kind==='resident_sfx_clap'?{sound_retrieval_mode:'resident_sfx_clap'}:{}),
      audience_preference: config.audience ?? 'auto',
      music_words_policy: config.music_words_policy, unqualified_research_observations: evidence,
      frozen_material_supply: await frozenDirectionMaterialSupply(config, record.music_source_supply),
      ...(directionRepair ? { direction_semantic_repair: directionRepair } : {}),
      timeline: manifest.timeline,
      dialogue_intervals: config.dialogue_intervals ?? null,
      ...(musicProfile ? { music_profile: musicProfile } : {}) },
    frames, schema: withSoundQueryCoverageSchema(globalDirection ? withDirectionSemanticsV2(caseSequenceDirectionSchema) : directionSchema,
      analyzed.value, { retrieval_contract_version: config.sound_query_contract_version ?? 1 }), stage: 'research_style_director' };
  directionInput=withDirectionEditCapabilities(directionInput,config.codex_cli?.direction_edit_capabilities_revision??null);
  directionInput=withDirectionSoundPropulsion(directionInput,config.codex_cli?.direction_sound_propulsion_revision??null);
  const directionModelRevision = session.runtime?.expectedStageModelRevision?.('research_style_director');
  const captureDirection = async () => captureResearchDirectionDependencies({ sourceSha: manifest.source_sha256,
    config: { ...config, video: path.resolve(path.dirname(manifestPath), manifest.source_video) },
    analysis: { binding: await binding(analysisFile), value: analyzed.value },
    observations: evidence, dialogueIntervals: config.dialogue_intervals ?? null, backend: {
      ...session.backend, ...(directionModelRevision && directionModelRevision !== session.backend?.model_revision
        ? { direction_model_revision: directionModelRevision } : {}) },
    prompt: directionInput.prompt, schema: directionInput.schema, frames, input: directionInput });
  const direction = await stage('research_style_director', async () => {
    if (!globalDirection || !['codex_cli', 'codex_host_file'].includes(session.backend?.protocol)) return session.director(directionInput);
    const before = await captureDirection(), checkpoint = config.resume?.direction_checkpoint ?? config.direction_checkpoint;
    if (checkpoint) {
      const restored = await restoreResearchDirectionCheckpoint({ checkpoint, dependencies: before });
      record.research_direction_checkpoint = restored.checkpoint; record.stages.at(-1).reused = true;
      return restored;
    }
    const result = await session.director(directionInput), after = await captureDirection();
    record.research_direction_checkpoint = await createResearchDirectionCheckpoint({ before, after, result,
      ...(result.reused === true && (result.host_field_merge?.revision === 'direction-words-and-disposition-typed-fields-v1'
        ||result.host_selected_unknown_merge?.revision === 'actual-selected-global-unknown-recovery-v1')
        && result.direction_recovery_input ? { recovery: { projected_input: result.direction_recovery_input } } : {}),
      outputDirectory: path.join(out, 'direction') });
    return result;
  });
  const duration = manifest.timeline.duration_samples / 48000;
  for (const cue of direction.value.cues) if (!validRange(cue.target_range) || cue.target_range[1] > duration)
    throw new Error('bounded_director_music_task_required');
  const directionGaps = musicProfileDirectionGaps(direction.value, musicProfile);
  const editCapabilityGaps=directionEditCapabilityGaps(direction.value,directionInput);
  const soundCoverage = checkSoundQueryCoverage(analyzed.value, direction.value);
  if (!soundCoverage.complete) {
    const directionFile = await saveJson(path.join(out, 'research-direction-result.json'), {
      source_video_sha256: manifest.source_sha256, direction: direction.value });
    record.sound_query_completion = await writeSoundQueryCompletionRequests({ analysis: await binding(analysisFile),
      director: directionFile, frames, output_dir: path.join(out, 'sound-query-completion') });
  }
  await verifyEvidenceBindings(evidence.map(row => row.binding));
  record.research_candidate = await saveJson(path.join(out, 'research-director-candidate.json'), {
    schema_version: 1, source_video_sha256: manifest.source_sha256, manifest: await binding(manifestPath),
    analysis: await binding(analysisFile), direction: direction.value,
    direction_raw_response:direction.raw_response,
    ...(musicProfile ? { music_profile: musicProfile } : {}),
    observation_bindings: evidence.map(row => row.binding), formal_adoption_allowed: false,
    listener_qualified: false, audio_observation_qualified: false, music_candidate_judgment_qualified: false,
    selected_music: [], production_approval: false, artistic_acceptance: 'not_assessed',
    sound_query_coverage: soundCoverage,
    unresolved: [...analyzed.value.uncertainties, ...direction.value.uncertainties,
      ...directionGaps,
      ...editCapabilityGaps.map(gap=>`music_edit_capability_gap:${gap.action_id}:${gap.execution_route.kind}`),
      ...soundCoverage.missing_event_ids.map(id => `missing_sound_query:${id}`),
      'qualified_audio_observation_required', 'qualified_music_candidate_judgment_required'],
  });
  if(editCapabilityGaps.length){
    record.direction_capability_candidate=record.research_candidate;delete record.research_candidate;
    return Object.assign(record,{status:'music_edit_capability_gap',execution_capability_gaps:editCapabilityGaps,
      formal_adoption_allowed:false,production_approval:false,fallback_performed:false,
      next_action:'resolve_required_source_facts_or_renderer_capability_before_target_selection'});
  }
  if (directionGaps.some(gap => gap.startsWith('words_target_range_not_within_parent:')))
    return Object.assign(record, { status: 'director_range_gap', director_direction_gaps: directionGaps,
      formal_adoption_allowed: false, fallback_performed: false,
      next_action: 'revise_director_lyric_task_within_parent_without_truncating_words' });
  if (musicProfile) {
    await verifyEvidenceBindings(musicProfile);
    const gaps = directionGaps;
    return Object.assign(record, { status: gaps.length ? 'music_profile_gap' : 'profile_case_pipeline_pending',
      music_profile_gaps: gaps, formal_adoption_allowed: false, fallback_performed: false,
      next_action: 'resolve_profile_bound_case_routes_and_current_music_listening' });
  }
  return Object.assign(record, { status: 'research_director_candidate', formal_adoption_allowed: false,
    next_action: 'audition_bound_music_candidates_with_qualified_listener' });
}

export async function caseSourceFormatOptions(cases = {}) {
  if (cases.prefer_vertical !== undefined && typeof cases.prefer_vertical !== 'boolean') throw new Error('prefer_vertical_boolean_required');
  if (!cases.source_format_manifest) {
    if (cases.prefer_vertical === true) throw new Error('source_format_binding_required');
    return {};
  }
  const file = cases.source_format_manifest;
  if (!file.path || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('source_format_binding_required');
  if (await hashFile(file.path) !== file.sha256) throw new Error('source_format_evidence_changed');
  const document = await readJson(file.path), source = document.source_manifest;
  if (document.schema_version !== 1 || !Array.isArray(document.entries) || !source?.path
    || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || await hashFile(source.path) !== source.sha256)
    throw new Error('source_format_source_manifest_changed');
  return { source_format_manifest: { path: path.resolve(file.path), sha256: file.sha256 }, prefer_vertical: cases.prefer_vertical === true };
}

// A fresh output directory is intentional. Explicit bound-story recovery never replays an interrupted request.
export async function composeEpisode(config, runtime = {}) {
  if (config?.visual_sampling_step !== undefined && (!Number.isFinite(config.visual_sampling_step)
    || config.visual_sampling_step < 0.1 || config.visual_sampling_step > 10)) throw new Error('compose_config_invalid');
  if (config?.automatic_trial === true) {
    if (config.resume?.kind === 'bound_story_v1' || config.music_profile)
      throw new Error('automatic_episode_legacy_bound_contract_requires_explicit_migration');
    const { composeAutomaticEpisode } = await import('./automatic_episode_controller.mjs');
    return composeAutomaticEpisode(config, runtime);
  }
  // These explicitly bound legacy contracts own their old recovery/profile
  // checks. Routing them into a new analysis stage would discard provenance
  // or charge the same plot again instead of validating the saved stage.
  if (config?.resume?.kind === 'bound_story_v1' || config?.music_profile)
    return composeLegacyEpisode(config, runtime);
  if (['research', 'assisted_trial'].includes(config?.mode)) {
    const { composeTargetEpisode } = await import('./target_pipeline.mjs');
    return composeTargetEpisode(config, runtime);
  }
  return composeLegacyEpisode(config, runtime);
}

export async function composeLegacyEpisode(config, runtime = {}) {
  const projectGate = await projectTrialPreflight(config, { operation: 'compose_episode' });
  if (projectGate) return projectGate;

  const backend = resolveAudioBackend(config?.audio_backend);
  const strategy = config?.strategy ?? 'case_presets';
  const mode = config?.mode ?? 'production';
  if (!config || config.schema_version !== 1 || !['fine', 'fast'].includes(config.craft_mode)
    || !['production', 'research', 'assisted_trial'].includes(mode)
    || !['allow', 'avoid', 'prefer'].includes(config.music_words_policy)
    || !['case_presets', 'library_search'].includes(strategy)
    || (config.visual_sampling_step !== undefined && (!Number.isFinite(config.visual_sampling_step)
      || config.visual_sampling_step < 0.1 || config.visual_sampling_step > 10))
    || typeof config.output_dir !== 'string' || (!config.manifest && !config.video)) throw new Error('compose_config_invalid');
  const sourceFormatOptions = strategy === 'case_presets' && config.cases?.db ? await caseSourceFormatOptions(config.cases) : {};
  const out = path.resolve(config.output_dir);
  try { if ((await readdir(out)).length) throw new Error('output_directory_must_be_empty'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(out, { recursive: true });
  const started = performance.now(), record = { schema_version: 1, status: 'preparing', stages: [],
    model_calls: 0, cloud_uploads: 0, generation_calls: 0, human_interventions: 0,
    artistic_acceptance: 'not_assessed', production_approval: false, strategy, mode, audio_backend: backend,
    strategy_defaulted_for_legacy_config: config.strategy === undefined, config_identity_sha256: researchConfigDigest(config),
    ...(sourceFormatOptions.source_format_manifest ? { source_format_policy: sourceFormatOptions } : {}) };
  let session, retriever, musicProfile;
  const generationDirs = [];
  const stage = async (name, work) => {
    const began = performance.now(), row = { name, status: 'running' }; record.stages.push(row);
    try { const result = await work(); row.status = 'completed'; return result; }
    catch (error) { row.status = 'failed'; throw error; }
    finally { row.elapsed_seconds = (performance.now() - began) / 1000; }
  };
  try {
    if (mode === 'production' && strategy === 'case_presets' && !config.cases?.db)
      return Object.assign(record, { status: 'case_preset_configuration_gap',
        next_action: 'bind_frozen_reference_cases_and_actual_music_packages', fallback_performed: false });
    let manifestPath = path.join(out, 'media/manifest.json');
    let sourceVideo = config.video;
    let expectedSourceSha;
    if (config.manifest) {
      const suppliedPath = path.resolve(config.manifest), supplied = await readJson(suppliedPath);
      if (supplied.analysis_window || !supplied.source_video) throw new Error('full_episode_manifest_required');
      sourceVideo = path.resolve(path.dirname(suppliedPath), supplied.source_video);
      expectedSourceSha = await hashFile(sourceVideo);
      if (expectedSourceSha !== supplied.source_sha256) throw new Error('source_video_changed');
      if (config.video && await hashFile(path.resolve(config.video)) !== expectedSourceSha) throw new Error('video_and_manifest_source_mismatch');
      record.supplied_manifest = await binding(suppliedPath);
    }
    expectedSourceSha ??= await hashFile(path.resolve(sourceVideo));
    if (config.music_profile) {
      const profile = await stage('user_music_profile_binding', () => loadMusicProfile(config.music_profile, {
        sourceSha: expectedSourceSha, workId: config.work_id, strategy }));
      record.music_profile = profile;
      if (!profile.ready) return Object.assign(record, { status: profile.status, music_profile_gaps: profile.gaps,
        next_action: profile.next_action ?? 'resolve_bound_user_music_profile', fallback_performed: false });
      musicProfile = profile.profile;
    }
    record.music_source_supply = await stage('reference_music_supply', () => inspectEpisodeReferenceMusicSupply({ config, runtime, out }));
    if (record.music_source_supply.blocked) return Object.assign(record, {
      status: 'reference_music_budget_gap', source_video_sha256: expectedSourceSha,
      unresolved: record.music_source_supply.gaps, next_action: record.music_source_supply.next_action,
      fallback_performed: false, formal_adoption_allowed: false,
    });
    // Private research cards/feedback are not part of the public distribution.
    // Callers may explicitly supply licensed knowledge; an empty default makes
    // no claim that those private research results or approvals are available.
    const knowledgeFiles = config.knowledge_files ?? [];
    const resume = await loadResearchStoryResume({ config, sourceSha: expectedSourceSha,
      knowledgeFiles, promptFile: path.join(refs, 'stages/story-director.md') });
    // Rebuild audio/frames/PTS from the bound video, rather than trusting unrelated external cache pointers.
    await stage('video_preparation', () => prepareEpisode({ video: sourceVideo, out: path.join(out, 'media'),
      step: config.visual_sampling_step ?? 2 }));
    const manifest = await readJson(manifestPath), base = path.dirname(manifestPath);
    if (manifest.source_sha256 !== expectedSourceSha) throw new Error('source_video_changed_during_preparation');
    if (manifest.analysis_window || manifest.timeline?.sample_rate !== 48000 || !manifest.original_audio) throw new Error('full_episode_with_aligned_original_audio_required');
    const duration = manifest.timeline.duration_samples / 48000, source = path.resolve(base, manifest.source_video);
    if (await hashFile(source) !== manifest.source_sha256) throw new Error('source_video_changed');
    record.source_video_sha256 = manifest.source_sha256; record.duration_samples = manifest.timeline.duration_samples;
    if (config.local_audio_analysis && ['research', 'assisted_trial'].includes(mode)) {
      const local = await stage('local_research_audio', async () => {
        const checkpoint = config.local_audio_checkpoint ?? config.resume?.local_audio_checkpoint;
        if (checkpoint) {
          const restored = await restoreLocalResearchCheckpoint({ checkpoint, options: config.local_audio_analysis, python: config.python, manifestPath });
          record.local_research_audio_checkpoint = restored.checkpoint; record.stages.at(-1).reused = true;
          return restored;
        }
        const before = await captureLocalResearchDependencies({ options: config.local_audio_analysis, python: config.python, manifestPath });
        const prepared = await prepareLocalResearchEvidence({ options: config.local_audio_analysis,
          python: config.python, manifestPath, outputDirectory: path.join(out, 'local-audio') });
        record.local_research_audio_checkpoint = await createLocalResearchCheckpoint({ before, local: prepared, options: config.local_audio_analysis,
          python: config.python, manifestPath, outputDirectory: path.join(out, 'local-audio') });
        return prepared;
      });
      config = { ...config, research_observation_files: [...(config.research_observation_files ?? []), ...local.observationFiles],
        dialogue_intervals: config.dialogue_intervals ?? local.dialogueIntervals };
      record.local_research_audio = local.receipt;
    }
    record.cross_film_reuse_check = await recentMusicContext(config.recent_other_film_music, {
      sourceSha: manifest.source_sha256, workId: config.work_id });
    const bridgeConfig = version => ({ schema_version: version, manifest: manifestPath,
      input_mode: version === 1 ? 'frames_only' : 'frames_and_observations', craft_mode: config.craft_mode,
      music_words_policy: config.music_words_policy, knowledge_files: knowledgeFiles });
    if (runtime.session && runtime.createSession) throw new Error('one_runtime_session_injection_required');
    if (runtime.session || runtime.createSession) {
      session = runtime.session ?? await runtime.createSession({ config, directory: path.join(out, 'host'),
        media: [await binding(source)], audioBackend: backend });
      if (!(session instanceof HostFileSession) && !(session instanceof ApiSession)) throw new Error('unsupported_runtime_session');
      record.director_backend = session.backend ?? { protocol: 'openai_responses', model_revision: 'gpt-6.1-sol' };
    }
    const readiness = providerReadiness(config.budget, runtime.environment ?? process.env);
    if (!session && !readiness.ready) {
      const file = path.join(out, 'analysis-config.json'); await saveJson(file, bridgeConfig(1));
      await stage('analysis_request', () => prepareAnalysisRequest(file, path.join(out, 'analysis-prepared')));
      return Object.assign(record, { status: 'blocked_backend', missing: readiness.missing,
        next_action: 'configure_api_credentials_and_budget_then_run_in_a_new_directory' });
    }
    if (mode === 'research' || mode === 'assisted_trial') {
      session ??= new ApiSession({ budget: config.budget, directory: path.join(out, 'api'),
        environment: runtime.environment, transport: runtime.transport, audioBackend: backend });
      record.audio_backend = null; record.listener_qualification = null;
      const frames = await Promise.all(manifest.frames.map(async (frame, i) => ({ ...frame,
        id: `frame_${String(i + 1).padStart(5, '0')}`, ...await binding(path.resolve(base, frame.path)) })));
      const result = await researchDirection({ config, session, record, out, manifestPath, manifest, frames, bridgeConfig, stage, musicProfile, resume });
      if (await hashFile(source) !== manifest.source_sha256) throw new Error('source_video_changed');
      if (mode === 'assisted_trial' && result.research_candidate
        && ['research_director_candidate', 'profile_case_pipeline_pending'].includes(result.status)) {
        const { completeAssistedTrial } = await import('./assisted_episode.mjs');
        return await completeAssistedTrial({ config, runtime, session, record, out, frames, manifestPath, manifest,
          sourceFormatOptions, musicProfile, stage });
      }
      return result;
    }
    const qualified = await validateAudioQualification(config.qualification_file ?? config.qualification, backend,
      ['audio_observation', 'music_candidate_judgment']);
    if (!qualified.ready) return Object.assign(record, { status: 'qualification_pending', missing: qualified.missing,
      next_action: 'complete_real_audio_and_scene_pair_qualification' });
    if (session instanceof HostFileSession && (!session.observer || !audioBackendMatches(session.audioBackend, backend)))
      return Object.assign(record, { status: 'qualification_pending', missing: ['bound_qualified_audio_observer'],
        next_action: 'bind_the_qualified_audio_observer_to_host_session' });
    if (!config.library?.db || (strategy === 'library_search' && (!config.library.index || !config.library.weights))) throw new Error('frozen_library_database_index_and_weights_required');
    record.library_database = await binding(config.library.db);
    record.listener_qualification = qualified.binding;
    session ??= new ApiSession({ budget: config.budget, directory: path.join(out, 'api'),
      environment: runtime.environment, transport: runtime.transport, audioBackend: backend });
    const original = path.resolve(base, manifest.original_audio), originalSha = await hashFile(original);
    const frames = await Promise.all(manifest.frames.map(async (frame, i) => ({ ...frame,
      id: `frame_${String(i + 1).padStart(5, '0')}`, path: path.resolve(base, frame.path), sha256: await hashFile(path.resolve(base, frame.path)) })));
    const localFrames = target => frames.filter(frame => frame.timeline_seconds >= target[0] && frame.timeline_seconds < target[1]);
    const observe = (job, dir, options) => stage('actual_audio_observation', async () => {
      if (await hashFile(qualified.binding.path) !== qualified.binding.sha256) throw new Error('listener_qualification_changed');
      return session.observeAudio(job, dir, options);
    });
    const originalObservations = [];
    for (let start = 0; start < duration; start += 25) {
      const target = [start, Math.min(duration, start + 25)];
      originalObservations.push(await observe({ path: original, source_sha256: originalSha,
        source_video_sha256: manifest.source_sha256, source_range: target, segment_id: `original/${start}`, asset_id: 'original' },
      path.join(out, 'observations/original', String(start)), { frames: localFrames(target), purpose: 'original' }));
    }
    const inputConfig = path.join(out, 'analysis-v2-config.json');
    await saveJson(inputConfig, { ...bridgeConfig(2), observation_files: originalObservations.map(row => row.file.path) });
    const request = await stage('analysis_request_v2', () => prepareAnalysisRequest(inputConfig, path.join(out, 'analysis')));
    const requestFile = path.join(out, 'analysis/request.json');
    const knowledge = await Promise.all(request.bindings.filter(b => b.kind === 'knowledge').map(async b => ({ id: b.id,
      source_label: b.source_label, text: await readFile(b.path, 'utf8') })));
    const prompt = await readFile(request.bindings.find(b => b.kind === 'prompt').path, 'utf8');
    const analyzed = await stage('story_director', () => session.director({ prompt,
      data: { schema_version: 2, request_id: request.request_id, source_video_sha256: request.source_video_sha256,
        timeline: request.timeline, controls: request.controls, instructions: request.instructions,
        evidence_catalog: request.evidence_catalog, knowledge, audio_observations: originalObservations.map((row, i) => ({
          evidence_id: `audio_observation_${String(i + 1).padStart(5, '0')}`, source_range: row.source_range, observation: row.observation })) },
      frames, schema: directorResponseSchema(2), stage: 'story_director' }));
    const analysisFile = path.join(out, 'analysis/result.json'); await saveJson(analysisFile, analyzed.value);
    const analysisCheck = await validateAnalysisResponse(requestFile, analysisFile);
    await saveJson(path.join(out, 'analysis/check.json'), analysisCheck);
    if (!analysisCheck.structure_valid || analysisCheck.coverage_gaps.length || analyzed.value.original_audio.kind === 'unknown'
      || analyzed.value.status !== 'complete' || analyzed.value.uncertainties.length) return Object.assign(record,
      { status: 'needs_local_evidence', analysis_check: analysisCheck, next_action: 'resolve_specific_analysis_uncertainties' });
    const analysis = analyzed.value, registry = config.library.registry || path.join(refs, 'music-style-experts.json');
    const experts = await readJson(registry);
    let caseVocabulary;
    if (strategy === 'case_presets') {
      record.case_store = await binding(config.cases.db);
      caseVocabulary = JSON.parse(await stage('case_condition_catalog', () => python(config, 'case_preset_store.py',
        ['report', '--db', config.cases.db])));
      record.case_condition_catalog = await saveJson(path.join(out, 'case-condition-catalog.json'), caseVocabulary);
    }
    const direction = (await stage('style_directors', () => session.director({
      prompt: '你是短剧声音总导演和风格协调导演。使用实际声画证据、观众期待和主动权变化制定音乐发展，而不是切镜换歌。'
        + '先蓄压再兑现；同一集允许年代、危机、亲情、释放不同发展，温情不能自动等同悲伤钢琴，未脱险不能凯旋。'
        + '为每个实际剧情转向创建music_action（response或hold），每个母cue给出具体剧情function、专家ID、正向音乐声音query。'
        + '连续配乐是本项目偏好；留白必须有证据和目的。cue可跨多个beat，按完整音乐弧线保留同曲发展并避免细碎换曲。'
        + '当前API一次实际音频观察最多180秒；较长弧线需明确分段，不按30秒机械换曲。'
        + '如适合用歌句，母cue内设words_target_range（至少3秒且容纳完整歌句），require/explore，默认song_replace；'
        + '依据剧情比较任何已核语言。请求vocal_language=unknown表示不限定，显式zh/en等必须遵守；真实素材语言unknown仍未核，不得采用。'
        + 'same_source_development仅真实同源连续，不用两个完整伴奏相叠。无词任务words_target_range与request为null。'
        + '不能将引用案例当本片事实。sound_queries仅对现有sound_event检索。' + soundQueryInstruction
        + '返回结构，不输出路径、命令、资产或通过批准。'
        + (musicProfile ? 'music_profile绑定用户已选的实际音乐包；遵守其vocal_policy和剧情边界，不能把风格名称当可用音频或强套同一情绪。' : '')
        + (strategy === 'case_presets' ? '逐cue交case_conditions，来自本片人物关系、主动权、观众期待及知情状态；仅填整个cue各步骤均成立的不变量，不确定填null。'
          + '主动权、知情和期待等发生变化时放在对应story_sequence步骤的before/after，不能把开头状态作为整段硬条件。'
          + 'threat_resolved只能boolean/null。exclude_case_conditions给需要明确排除的反例条件；不能只靠风格或年代召回。'
          + 'case_condition_vocabulary是当前库的实际条件值；只有语义确实符合画面才能沿用，不为命中改写剧情。'
          + 'function按本片实际剧情填写；不得为命中目录改写本片功能或参考案例。自然措辞由实际宿主语义比较，有缺口就保留。'
          + (caseVocabulary?.sequence_case_count > 0 ? 'story_sequence按发生顺序列出真实剧情步骤、每步before/after；未知条件null，不为匹配修改关系或解除威胁状态。'
            + '每步event_anchor绑定analysis中真实story_beat_id、当前视频target_seconds及该beat已有evidence_ids；秒点须在该beat和当前cue范围内。'
            + '参考案例秒点不能充当本片锚点；当前事件无法定位时event_anchor=null，交待办，不编造定位。' : '') : ''),
      data: { analysis, experts, knowledge, craft_mode: config.craft_mode, music_words_policy: config.music_words_policy,
        ...(musicProfile ? { music_profile: musicProfile } : {}),
        ...(caseVocabulary ? { case_condition_vocabulary: caseVocabulary.condition_vocabulary,
          case_story_sequence_catalog: caseVocabulary.story_sequence_catalog ?? [] } : {}) },
      frames, schema: withSoundQueryCoverageSchema(strategy === 'case_presets'
        ? (caseVocabulary?.sequence_case_count > 0 ? caseSequenceDirectionSchema : caseDirectionSchema) : directionSchema,
      analysis, { retrieval_contract_version: config.sound_query_contract_version ?? 1 }), stage: 'style_directors' }))).value;
    const soundCoverage = checkSoundQueryCoverage(analysis, direction);
    if (!soundCoverage.complete) {
      const directionFile = await saveJson(path.join(out, 'direction-result.json'), {
        source_video_sha256: manifest.source_sha256, direction });
      record.sound_query_completion = await writeSoundQueryCompletionRequests({ analysis: await binding(analysisFile),
        director: directionFile, frames, output_dir: path.join(out, 'sound-query-completion') });
      return Object.assign(record, { status: 'sound_query_completion_pending', missing_sound_event_ids: soundCoverage.missing_event_ids,
        next_action: 'complete_only_missing_sound_query_stage_then_review_actual_materials', formal_full_sound_output_allowed: false });
    }
    if (!direction.cues.length || direction.uncertainties.length) return Object.assign(record, { status: 'director_revision_required' });
    const profileDirectionGaps = musicProfileDirectionGaps(direction, musicProfile);
    if (profileDirectionGaps.length) return Object.assign(record, { status: 'music_profile_gap',
      music_profile_gaps: profileDirectionGaps, next_action: 'preserve_confirmed_package_vocal_policy', fallback_performed: false });
    const briefFile = path.join(out, 'director-brief.json');
    await saveJson(briefFile, { schema_version: 1, source_video_sha256: manifest.source_sha256,
      story_beats: analysis.story_beats, music_actions: direction.music_actions, style_direction: analysis.style_direction });
    const director = { schema_version: 1, source_video_sha256: manifest.source_sha256,
      director_brief_sha256: await hashFile(briefFile), usage_scope: config.usage_scope || 'research_noncommercial',
      music_actions: direction.music_actions,
      cues: direction.cues.map(cue => {
        if (!validRange(cue.target_range) || cue.target_range[1] > duration) throw new Error('bounded_director_music_task_required');
        const row = { ...cue, mode: config.craft_mode, allow_generation: config.craft_mode === 'fine' };
        if (row.words_target_range) row.words_complete_phrase_required = true;
        if (row.words_target_range === null) { delete row.words_target_range; delete row.words_candidate_request; }
        return row;
      }) };
    let directorFile = path.join(out, 'music-director.json'); await saveJson(directorFile, director);
    const tooLong = director.cues.filter(c => c.target_range[1] - c.target_range[0] > 180);
    if (tooLong.length && strategy !== 'case_presets') return Object.assign(record, { status: 'audio_window_capability_gap',
      pending_cues: tooLong.map(c => c.cue_id), maximum_observation_seconds: 180,
      next_action: 'split_long_music_arc_into_explicit_continuation_tasks' });
    let caseRoutes, caseStyle, soundArcs;
    if (strategy === 'case_presets') {
      const actualSemanticHost = caseVocabulary?.sequence_case_count > 0 && session.backend_kind === 'codex_cli';
      if (!runtime.caseMatcher && actualSemanticHost && director.usage_scope !== 'research_noncommercial')
        return Object.assign(record, { status: 'case_semantic_integration_gap',
          gap: 'host_semantic_recall_requires_v2_research_query', fallback_performed: false });
      const caseMatcher = runtime.caseMatcher ?? (actualSemanticHost ? createCaseMatcher({ python: config.python }) : null);
      record.case_matching = { mode: caseMatcher ? 'actual_host_semantic_matcher' : 'existing_exact_store_query',
        semantic_integration_gap: caseMatcher ? null : 'api_semantic_response_normalization_not_verified',
        query_functions_rewritten: false };
      if (caseVocabulary?.sequence_case_count > 0) {
        const locations = validateCaseEventAnchors(director, analysis, duration);
        const locationFile = path.join(out, 'current-event-locations.json');
        await saveJson(locationFile, { ...locations, analysis: await binding(analysisFile), director: await binding(directorFile) });
        record.current_event_locations = await binding(locationFile);
        if (locations.pending.length) return Object.assign(record, { status: 'current_event_location_pending',
          pending_events: locations.pending, next_action: 'locate_current_story_events_from_bound_analysis', fallback_performed: false });
      }
      const inputFile = path.join(out, 'case-query.json');
      let caseFile = path.join(out, 'case-routes.json');
      await saveJson(inputFile, { schema_version: caseVocabulary?.sequence_case_count > 0 ? 2 : 1, source_video_sha256: manifest.source_sha256,
        ...(caseMatcher ? { store_sha256: record.case_store.sha256 } : {}),
        ...sourceFormatOptions,
        ...(caseVocabulary?.sequence_case_count > 0 && caseVocabulary?.sequence_match_modes?.includes('ordered_compatible')
          ? { sequence_match: 'ordered_compatible' } : {}),
        usage_scope: director.usage_scope, story_beats: analysis.story_beats, music_actions: direction.music_actions, cues: director.cues });
      await stage('case_route_retrieval', async () => {
        if (caseMatcher) {
          if (typeof caseMatcher !== 'function') throw new Error('case_matcher_callback_required');
          const matched = await caseMatcher({ query: await binding(inputFile),
            database: record.case_store, library_db: config.library.db, output_dir: path.join(out, 'case-comparison') }, session);
          await saveJson(caseFile, matched);
        } else await python(config, 'case_preset_store.py', ['query', '--db', config.cases.db,
          '--input', inputFile, '--library-db', config.library.db, '--output', caseFile]);
      });
      caseRoutes = await readJson(caseFile); record.case_routes = await binding(caseFile);
      if (![1, 2].includes(caseRoutes.schema_version) || caseRoutes.source_video_sha256 !== manifest.source_sha256
        || caseRoutes.store_sha256 !== record.case_store.sha256 || !Array.isArray(caseRoutes.routes)
        || caseRoutes.formal_adoption_allowed !== false) throw new Error('case_route_binding_mismatch');
      if (sourceFormatOptions.source_format_manifest && (caseRoutes.source_format_policy?.prefer_vertical !== sourceFormatOptions.prefer_vertical
        || caseRoutes.source_format_policy?.source_format_manifest?.sha256 !== sourceFormatOptions.source_format_manifest.sha256
        || path.resolve(caseRoutes.source_format_policy?.source_format_manifest?.path ?? '') !== sourceFormatOptions.source_format_manifest.path
        || caseRoutes.source_format_policy?.story_hard_exclusions_preserved !== true)) throw new Error('case_source_format_policy_mismatch');
      const profileRoutes = filterMusicProfileRoutes(caseRoutes, director, musicProfile);
      if (musicProfile) {
        await saveJson(path.join(out, 'music-profile-routes.json'), profileRoutes);
        if (!profileRoutes.ready) return Object.assign(record, { status: 'music_profile_gap',
          music_profile_gaps: profileRoutes.gaps, next_action: 'resolve_applicable_confirmed_package_sources', fallback_performed: false });
        caseRoutes = profileRoutes.caseRoutes;
      }
      caseRoutes = adaptCaseDevelopment(caseRoutes, { director, analysis, duration });
      if (config.cases.rules_db) {
        record.case_rule_index = await binding(config.cases.rules_db);
        caseRoutes.director_rules = await stage('case_rule_retrieval', () => retrieveCaseRules(config, caseRoutes));
      }
      caseFile = path.join(out, 'case-routes-adapted.json');
      await saveJson(caseFile, caseRoutes); record.adapted_case_routes = await binding(caseFile);
      record.case_route_ids = caseRoutes.routes?.map(r => r.route_id) ?? [];
      record.case_gaps = [...(caseRoutes.gaps ?? []), ...caseRoutes.routes.flatMap(route =>
        (route.unresolved_gaps ?? []).map(gap => ({ route_id: route.route_id, cue_id: route.cue_id, gap })))];
      record.case_coverage = caseRoutes.coverage;
      const pendingLocations = caseRoutes.routes.flatMap(route => route.adaptation?.pending_current_event_locations ?? []);
      if (pendingLocations.length) return Object.assign(record, { status: 'current_event_location_pending',
        pending_events: pendingLocations, next_action: 'locate_current_story_events_from_bound_analysis', fallback_performed: false });
      if (!caseRoutes.routes?.length) return Object.assign(record, { status: 'case_preset_gap',
        next_action: 'add_observed_applicable_cases_and_resolved_source_windows', fallback_performed: false });
      const originals = await stage('reference_material_identity', () => filterReferenceMaterialRoutes(caseRoutes, director,
        config.cases?.material_policy));
      record.reference_originals = { status: originals.status, gaps: originals.gaps, formal_adoption_allowed: false };
      if (!originals.ready) return Object.assign(record, { status: originals.status,
        next_action: 'identify_and_bind_actual_reference_recordings', fallback_performed: false });
      caseRoutes = originals.caseRoutes;
      record.case_route_ids = caseRoutes.routes.map(route => route.route_id);
      caseFile = path.join(out, 'case-routes-originals.json');
      await saveJson(caseFile, caseRoutes); record.adapted_case_routes = await binding(caseFile);
      caseStyle = await stage('case_source_binding', () => prepareCaseStyle(config, directorFile, caseFile, { allowShortWindows: true }));
      const missing = caseStyle.cues.filter(c => !c.candidate_pool.length).map(c => c.cue_id);
      record.case_gaps.push(...caseStyle.gaps);
      if (missing.length) return Object.assign(record, { status: 'case_preset_gap', pending_cues: missing,
        next_action: 'resolve_case_source_and_coverage_gaps', fallback_performed: false });
      const needsArc = tooLong.length || caseRoutes.routes.some(route => route.development_preset?.steps?.length)
        || caseStyle.cues.some(cue => !cue.cue_id.endsWith('/words') && cue.candidate_pool.every(candidate =>
          (candidate.case_source_range[1] - candidate.case_source_range[0]) < cue.target_range[1] - cue.target_range[0]));
      if (needsArc) {
        soundArcs = await stage('sound_development_arc', () => prepareCaseSoundArcs({ director, style: caseStyle,
          caseRoutes, session, observe, frames, out: path.join(out, 'sound-arcs'), musicProfile }));
        if (!soundArcs.splitCues.length) return Object.assign(record, { status: 'sound_arc_gap',
          next_action: 'resolve_actual_phrase_and_arc_coverage', fallback_performed: false });
        await saveJson(path.join(out, 'music-director-before-arcs.json'), director);
        director.cues = soundArcs.splitCues;
        directorFile = path.join(out, 'music-director-with-arcs.json');
        await saveJson(directorFile, director);
        record.sound_arcs = await binding(path.join(out, 'sound-arcs/sound-arc-compiled.json'));
        caseStyle = await stage('arc_piece_source_binding', () => prepareCaseStyle(config, directorFile, caseFile));
        if (caseStyle.cues.some(cue => !cue.candidate_pool.length)) return Object.assign(record, {
          status: 'sound_arc_source_gap', next_action: 'resolve_piece_or_words_source_binding', fallback_performed: false });
      }
    } else retriever = runtime.retriever ?? await stage('resident_retriever_start', () => startResidentRetriever(config));
    const allTasks = [], allReviews = [], allRoutes = [], selectedObservations = [], tried = new Set(), gapRounds = new Map();
    const selectionPrompt = await readFile(path.join(refs, 'stages/music-supervisor.md'), 'utf8');
    const addFrozen = (frozen, selected) => {
      allTasks.push(frozen.task); allReviews.push(frozen.review); allRoutes.push(frozen.route);
      selectedObservations.push({ cue_id: frozen.task.cue_id, segment_id: selected.segment_id,
        source_range: selected.source_range, target_range: frozen.task.target_range, source_sha256: selected.source_sha256,
        observation: selected.observation_record.observation, observation_record: selected.observation_record.file,
        ...(selected.case_route_id ? { case_route_id: selected.case_route_id, case_ids: selected.case_ids,
          music_pack_id: selected.music_pack_id, applicability: selected.case_applicability } : {}) });
      if (selected.case_route_id) {
        record.case_selections ??= [];
        record.case_selections.push({ cue_id: frozen.task.cue_id, route_id: selected.case_route_id,
          case_ids: selected.case_ids, music_pack_id: selected.music_pack_id,
          segment_id: selected.segment_id, source_sha256: selected.source_sha256,
          source_range: selected.source_range, applicability: selected.case_applicability,
          observation_record: selected.observation_record.file, current_review_required: true });
      }
    };
    let pending = director.cues.map(cue => cue.cue_id).concat(director.cues.filter(c => c.words_target_range).map(c => `${c.cue_id}/words`));
    for (let attempt = 0; pending.length && attempt < 2; attempt++) {
      const attemptDir = path.join(out, `retrieval-${attempt + 1}`); await mkdir(attemptDir, { recursive: true });
      const styleFile = path.join(attemptDir, 'style.json'), rankedFile = path.join(attemptDir, 'ranked.json');
      if (strategy === 'case_presets') await saveJson(styleFile, caseStyle);
      else await stage('stock_retrieval', () => python(config, 'retrieve_style_candidates.py', [directorFile, '--registry', registry,
        '--db', config.library.db, '--limit', String(attempt ? 50 : 20), '--out', styleFile]));
      const style = await readJson(styleFile);
      const ranked = strategy === 'case_presets' ? { schema_version: 1, score_type: 'case_source_windows_not_artistic_quality',
        cues: style.cues.map(c => ({ ...c, candidate_pool: c.candidate_pool.slice(0, attempt ? 10 : 5) })) }
        : await stage('audio_vector_rerank', () => rankResidentCandidates(style, retriever, attempt ? 10 : 5));
      await saveJson(rankedFile, ranked); const heard = [];
      for (const pool of ranked.cues.filter(row => pending.includes(row.cue_id))) {
        const task = style.branches.find(b => b.parent_cue_id === pool.cue_id).frozen_task.cues[0];
        let count = 0;
        for (const candidate of pool.candidate_pool) {
          const length = task.target_range[1] - task.target_range[0];
          const window = candidateAuditionWindow(candidate, length); if (!window) continue;
          const key = candidateWindowKey(pool.cue_id, candidate, window);
          if (tried.has(key) || count >= 5) continue;
          const observation = await observe({ path: candidate.local_path, source_sha256: candidate.source_sha256,
            source_range: window, segment_id: candidate.segment_id, asset_id: candidate.asset_id },
          path.join(attemptDir, 'heard', String(heard.length)), { purpose: task.music_role === 'words_candidate' ? 'words_candidate' : 'candidate',
            context: { story_task: task.sound_goal, function: task.query.function, target_range: task.target_range } });
          heard.push({ cue_id: pool.cue_id, ...candidate, source_range: window, observation_record: observation }); tried.add(key); count++;
        }
      }
      await saveJson(path.join(attemptDir, 'heard.json'), heard);
      const comparisons = (await stage('actual_candidate_comparison', () => session.director({
        prompt: selectionPrompt + '\n根据实际声音观察、剧情与图片比较候选。只在有可听推进、恰当织体、情绪发展和完整乐句时采用。'
          + 'CLAP相似度、素材标签、文件名不证明好听。必须记录每个淘汰理由；全不合适selected_segment_id=null。'
          + '危机不能怀旧，温情不能机械选钢琴，反制要有主动权兑现。词子任务必须确实sung、实际语言已核且词义与人物视角适配；'
          + '请求unknown表示不限定语言，不能用它把声音事实unknown或未核唱词变为合格。显式语言要求必须保持。'
          + 'selected_source_range取已听source_range内的乐句入出，时长须恰好等于该task的目标时长；无需固定从窗口开头切。'
          + '实际短歌句需有完整起止而非半词。无法核清language/actual_words就不采用。每个待处理cue恰一decision。'
          + 'cross_film_reuse_check提供已交付录音身份时比较跨作品重复；适配优先，不能为区别强用不合适曲目。'
          + '同作品主题复现允许，作品身份未知不自动禁止；not_performed表示复用尚未检查，不能声称已通过。'
          + (musicProfile ? '仅选music_profile中已绑定的实际包与源窗；剧情冲突或词策略无法实现就保留缺口，不换通用曲或默默改成器乐。用户选包不批准本次选段。' : ''),
        data: { analysis, strategy, cross_film_reuse_check: record.cross_film_reuse_check, ...(caseRoutes ? { case_routes: caseRoutes } : {}),
          ...(musicProfile ? { music_profile: musicProfile } : {}),
          tasks: style.branches.filter(b => pending.includes(b.parent_cue_id)).map(b => b.frozen_task.cues[0]),
          actual_audio: heard.map(row => ({ cue_id: row.cue_id, segment_id: row.segment_id, source_range: row.source_range,
            observation: row.observation_record.observation,
            ...(row.case_route_id ? { case_route_id: row.case_route_id, case_ids: row.case_ids,
              music_pack_id: row.music_pack_id, applicability: row.case_applicability } : {}) })) },
        frames, schema: comparisonSchema, stage: 'candidate_comparison' }))).value;
      if (comparisons.uncertainties.length) return Object.assign(record, { status: 'candidate_comparison_needs_review' });
      const comparisonBinding = await saveJson(path.join(attemptDir, 'comparison.json'), comparisons);
      const unresolved = [];
      for (const cueId of pending) {
        const decisions = comparisons.decisions.filter(row => row.cue_id === cueId);
        if (decisions.length !== 1) throw new Error('one_comparison_per_current_cue_required');
        const decision = decisions[0], selected = heard.find(row => row.cue_id === cueId && row.segment_id === decision.selected_segment_id
          && validRange(decision.selected_source_range) && decision.selected_source_range[0] >= row.source_range[0]
          && decision.selected_source_range[1] <= row.source_range[1]);
        if (!selected) {
          if (decision.selected_segment_id !== null) throw new Error('unheard_candidate_selection');
          const task = style.branches.find(b => b.parent_cue_id === cueId).frozen_task.cues[0];
          const rejected = heard.filter(row => row.cue_id === cueId);
          if (rejected.length && rejected.length === decision.alternatives.length) {
            const rounds = gapRounds.get(cueId) ?? [];
            rounds.push({ round: attempt + 1, source_video_sha256: manifest.source_sha256,
              cue_id: cueId, target_range: task.target_range, function: task.query.function,
              retrieval_binding: await binding(rankedFile), comparison_binding: comparisonBinding,
              rejections: rejected.map(row => ({ segment_id: row.segment_id, source_sha256: row.source_sha256,
                source_range: row.source_range, reason: decision.alternatives.find(a => a.segment_id === row.segment_id)?.reason,
                observation_record: row.observation_record.file, qualification_record: qualified.binding })), task });
            gapRounds.set(cueId, rounds);
          }
          unresolved.push(cueId); continue;
        }
        const task = style.branches.find(b => b.parent_cue_id === cueId).frozen_task.cues[0];
        const chosenRange = decision.selected_source_range;
        if (!validRange(chosenRange) || chosenRange[0] < selected.source_range[0] || chosenRange[1] > selected.source_range[1]
          || Math.abs(chosenRange[1] - chosenRange[0] - (task.target_range[1] - task.target_range[0])) > 1 / 48000) throw new Error('selected_phrase_outside_actually_heard_window');
        if (JSON.stringify(chosenRange) !== JSON.stringify(selected.source_range)) {
          selected.observation_record = await observe({ path: selected.local_path, source_sha256: selected.source_sha256,
            source_range: chosenRange, segment_id: selected.segment_id, asset_id: selected.asset_id },
          path.join(attemptDir, 'selected-heard', String(allTasks.length)), { purpose: task.music_role === 'words_candidate' ? 'words_candidate' : 'candidate',
            context: { sound_goal: task.sound_goal, source_range: chosenRange, target_range: task.target_range } });
          selected.source_range = chosenRange;
        }
        const wordsEvidence = task.music_role === 'words_candidate' ? { content_status: 'verified', source_sha256: selected.source_sha256,
          source_range: selected.source_range, vocal_presence: 'sung', vocal_language: decision.verified_language, actual_words: decision.actual_words } : null;
        if (musicProfile?.vocal_policy === 'instrumental_only' && selected.observation_record.observation.vocal_type !== 'none') {
          unresolved.push(cueId); continue;
        }
        if (wordsEvidence && (!actualWordsMatch(task, decision, selected.observation_record.observation)
          || !hasCompleteSungPhrase(selected.observation_record.observation, decision, chosenRange[1] - chosenRange[0]))) { unresolved.push(cueId); continue; }
        const frozen = await freezeSelection({ config, directorFile, styleFile, out: path.join(attemptDir, `selection-${allTasks.length}`),
          task, selected, decision, qualification: qualified.binding });
        if (!frozen) { unresolved.push(cueId); continue; } addFrozen(frozen, selected);
      }
      pending = unresolved;
    }
    if (pending.length && caseRoutes?.reference_originals_only) return Object.assign(record, {
      status: 'reference_original_music_gap', pending_cues: pending,
      next_action: 'resolve_applicable_actual_reference_recordings', fallback_performed: false });
    if (pending.length && musicProfile) return Object.assign(record, { status: 'music_profile_gap',
      pending_cues: pending, next_action: 'replace_or_extend_actual_user_confirmed_package', fallback_performed: false });
    // Creation is a fallback for diagnosed local gaps, never the default source of a score.
    if (pending.length && config.craft_mode === 'fine' && config.local_generation) {
      const unresolved = [];
      for (const cueId of pending) {
        const rounds = gapRounds.get(cueId);
        if (rounds?.length !== 2) { unresolved.push(cueId); continue; }
        const task = rounds[0].task;
        const diagnosis = (await stage('stock_gap_diagnosis', async () => session.director({
          prompt: '区分本片剧情任务错误、过滤过严、未听核、编辑问题和已核本地候选声型缺口。'
            + '两次Top候选拒绝不证明全世界没有素材。只有具体正向声型缺失且当前两轮实际观察与拒因明确才用verified_local_catalog_gap。'
            + 'pending、源未下载、索引没有允许窗、未知语言没有听核不得生成；reason指出现有声音为何不能完成当前task。',
          data: { analysis, task, comparisons: await Promise.all(rounds.map(r => readJson(r.comparison_binding.path))),
            observed_rejections: await Promise.all(rounds.flatMap(r => r.rejections.map(v => readJson(v.observation_record.path)))) },
          schema: objectSchema({ type: { type: 'string', enum: ['verified_local_catalog_gap', 'director', 'filters', 'missing_observation', 'editing', 'pending'] }, reason: str }),
          stage: 'stock_gap_diagnosis' }))).value;
        if (diagnosis.type !== 'verified_local_catalog_gap') { unresolved.push(cueId); continue; }
        const gap = { source_video_sha256: manifest.source_sha256, cue_id: cueId, target_range: task.target_range,
          function: task.query.function, sound_goal: task.sound_goal, music_role: task.music_role,
          vocal_language: task.vocal_language, retrieval_rounds: rounds,
          diagnosis: { ...diagnosis, source_video_sha256: manifest.source_sha256, cue_id: cueId } };
        const gapDir = path.join(out, `generated-gap-${generationDirs.length}`);
        generationDirs.push(gapDir);
        const generated = await stage('verified_local_creation', () => createVerifiedGap({
          config: { ...config, source_video_sha256: manifest.source_sha256 }, session, gap, output_dir: gapDir }));
        record.generation_calls += generated.generation_calls;
        if (!generated.candidate) { record.generation_missing = generated.missing; unresolved.push(cueId); continue; }
        const candidate = generated.candidate;
        const comparison = (await stage('generated_candidate_comparison', () => session.director({
          prompt: '独立听选这一个生成候选。只依据实际声音观察和当前画面任务，生成器成功不代表可用。'
            + '不契合就selected_segment_id=null；否则选实际听窗内恰等于目标长度的完整乐句。'
            + '歌句必须实际唱出、语言已核、词义适配并容纳完整句。保留淘汰依据，不强制填补。',
          data: { analysis, task, actual_audio: [{ cue_id: cueId, segment_id: candidate.segment_id,
            source_range: candidate.source_range, observation: candidate.observation }] }, frames,
          schema: comparisonSchema, stage: 'generated_candidate_comparison' }))).value;
        await saveJson(path.join(gapDir, 'comparison.json'), comparison);
        if (comparison.decisions.length !== 1 || comparison.decisions[0].cue_id !== cueId) throw new Error('generated_comparison_requires_one_current_cue_decision');
        const decision = comparison.decisions[0], window = decision.selected_source_range;
        const length = task.target_range[1] - task.target_range[0];
        if (comparison.uncertainties.length || decision?.selected_segment_id !== candidate.segment_id || !validRange(window)
          || window[0] < 0 || window[1] > candidate.duration_seconds || Math.abs(window[1] - window[0] - length) > 1 / 48000) { unresolved.push(cueId); continue; }
        const actual = await observe({ ...candidate, source_range: window }, path.join(gapDir, 'selected-heard'),
          { purpose: task.music_role === 'words_candidate' ? 'words_candidate' : 'candidate' });
        if (task.music_role === 'words_candidate' && (!actualWordsMatch(task, decision, actual.observation)
          || !hasCompleteSungPhrase(actual.observation, decision, window[1] - window[0]))) { unresolved.push(cueId); continue; }
        const localDb = path.join(gapDir, 'candidate.sqlite'), catalogFile = path.join(gapDir, 'catalog.json'), segmentsFile = path.join(gapDir, 'segments.json');
        const parent = director.cues.find(c => c.cue_id === cueId || `${c.cue_id}/words` === cueId);
        await saveJson(catalogFile, { assets: [{ asset_id: candidate.asset_id, local_path: candidate.path, asset_kind: 'music',
          title: candidate.caption, description: candidate.caption, tags: parent.source_tag_queries,
          tag_status: 'requested_retrieval_terms_not_artistic_approval', source_kind: 'generated_candidate',
          license: 'generated_local_candidate', commercial_allowed: false, source_video_sha256: manifest.source_sha256 }] });
        await saveJson(segmentsFile, { segments: [{ segment_id: candidate.segment_id, asset_id: candidate.asset_id,
          source_sha256: candidate.sha256, source_start_seconds: window[0], source_end_seconds: window[1],
          tags: parent.source_tag_queries, tag_status: 'requested_retrieval_terms_not_auditory_classification',
          narrative_functions: [], phase: 'unknown', listening_status: 'pending',
          vocal_presence: task.music_role === 'words_candidate' ? 'sung' : 'unknown',
          vocal_evidence: { scope: 'actual_selected_window_only', source_range: window, observation_record: actual.file } }] });
        await python(config, 'segment_library.py', ['import', '--db', localDb, '--catalog', catalogFile, '--segments', segmentsFile]);
        const styleFile = path.join(gapDir, 'style.json');
        await python(config, 'retrieve_style_candidates.py', [directorFile, '--registry', registry, '--db', localDb, '--limit', '5', '--out', styleFile]);
        const style = await readJson(styleFile), branch = style.branches.find(b => b.parent_cue_id === cueId);
        if (!branch) { unresolved.push(cueId); continue; }
        const selected = { ...candidate, local_path: candidate.path, source_range: window, observation_record: actual };
        const frozen = await freezeSelection({ config: { ...config, library: { ...config.library, db: localDb } }, directorFile,
          styleFile, out: path.join(gapDir, 'selection'), task: branch.frozen_task.cues[0], selected, decision, qualification: qualified.binding });
        if (!frozen) { unresolved.push(cueId); continue; } addFrozen(frozen, selected);
      }
      pending = unresolved;
    }
    if (pending.length) return Object.assign(record, { status: 'stock_gap_needs_diagnosis', pending_cues: pending,
      next_action: config.craft_mode === 'fine' ? 'diagnose_catalog_filter_and_actual_missing_sound_before_local_generation' : 'revise_stock_selection',
      generation_eligibility: 'not_established' });
    const tasksFile = path.join(out, 'music-tasks.json'), reviewsFile = path.join(out, 'music-reviews.json'), routesFile = path.join(out, 'reviewed-route.json');
    const tasks = { schema_version: 1, source_video_sha256: manifest.source_sha256,
      director_brief_sha256: director.director_brief_sha256, usage_scope: director.usage_scope, cues: allTasks };
    await saveJson(tasksFile, tasks);
    await saveJson(reviewsFile, { schema_version: 1, source_video_sha256: manifest.source_sha256,
      director_brief_sha256: director.director_brief_sha256, music_tasks_sha256: await hashFile(tasksFile), reviews: allReviews });
    const routes = { schema_version: 1, cues: allRoutes }; await saveJson(routesFile, routes);
    const soundPointers = [];
    for (const query of direction.sound_queries) {
      const event = analysis.sound_events.find(row => row.id === query.event_id);
      if (!event) throw new Error('unknown_sound_query_event');
      const packCandidates = (caseRoutes?.routes ?? []).flatMap(route => route.sound_candidates ?? [])
        .filter(candidate => candidate.applicability?.eligible_for_current_review === true && candidate.sound_role === event.role);
      const queryArgs = ['query', '--db', config.library.db, '--text', packCandidates.length ? '' : query.text,
        '--asset-kind', query.asset_kind, '--limit', '3', '--usage-scope', director.usage_scope];
      for (const id of new Set(packCandidates.map(candidate => candidate.segment_id))) queryArgs.push('--candidate-segment-id', id);
      const candidates = JSON.parse(await python(config, 'segment_library.py', queryArgs));
      record.sound_retrieval ??= [];
      record.sound_retrieval.push({ event_id: query.event_id, route: packCandidates.length ? 'case_sound_pack' : 'library_sound_gap_retrieval',
        candidate_count: candidates.candidates.length, current_review_required: true });
      for (const candidate of candidates.candidates) {
        const packed = packCandidates.find(row => row.segment_id === candidate.segment_id);
        if (packed && (packed.asset_id !== candidate.asset_id || packed.source_sha256 !== candidate.source_sha256
          || packed.source_range[0] < candidate.source_range[0] || packed.source_range[1] > candidate.source_range[1])) throw new Error('sound_pack_current_source_identity_mismatch');
        const available = packed?.source_range ?? candidate.source_range;
        const window = [available[0], Math.min(available[1], available[0] + 25)];
        const observation = await observe({ path: candidate.local_path, source_sha256: candidate.source_sha256,
          source_range: window, segment_id: candidate.segment_id, asset_id: candidate.asset_id },
        path.join(out, 'observations/sounds', String(soundPointers.length)), { purpose: 'sound_effect' });
        soundPointers.push({ ...candidate, event_id: query.event_id, source_range: window, actual_observation: observation.observation,
          ...(packed ? { sound_pack_id: packed.sound_pack_id, member_id: packed.member_id, source_anchor_seconds: packed.source_anchor_seconds } : {}) });
      }
    }
    const editPrompt = (await Promise.all(['music-editor.md', 'sfx-designer.md'].map(file =>
      readFile(path.join(refs, 'stages', file), 'utf8')))).join('\n\n');
    let edits = (await stage('music_and_sound_editing', () => session.director({
      prompt: editPrompt + '\n把已实际听核的music tasks编排为准确零起点同长音轨。music_edits每task恰一项，增益以短剧可听节奏和清晰对白为准。'
        + 'dialogue_ducking_db为正的衰减量0–18dB，不是负增益；音乐的gain_db按实际素材响度、编配与对白决定。'
        + '母cue的独立词窗会替换相应局部，父保留其余完整覆盖。action_responses每action恰一项，target_range须在该实际音乐piece之内。'
        + 'source_development要指明实际听到的发展，不能以gain冒充编配。sounds每analysis event恰一决策，保留原声先核确实存在；'
        + 'point sound给出实际source瞬态anchor和画面target，不能给整段混音随意叠；角色动作不移动。'
        + 'source_range/source_anchor_seconds均从素材文件自身零点算；观察里的changes/words相对听窗，需加该源窗起点。target_seconds从视频零点算。'
        + '仅用提供的segment IDs和实际源窗，不返回文件路径。若不能判断就uncertainties。'
        + '保留cross_film_reuse_check的实际检查范围；同作品主题复现允许，身份未知不自动禁止，缺记录不能称跨剧重复已检查。',
      data: { analysis, strategy, cross_film_reuse_check: record.cross_film_reuse_check, ...(caseRoutes ? { case_routes: caseRoutes } : {}),
        music_actions: direction.music_actions, tasks, selected_observations: selectedObservations,
        sounds: soundPointers.map(p => ({ event_id: p.event_id, segment_id: p.segment_id, source_range: p.source_range,
          actual_observation: p.actual_observation })), original_audio: originalObservations.map(p => ({ source_range: p.source_range, observation: p.observation })) },
      frames, schema: editSchema, stage: 'music_and_sound_editing' }))).value;
    if (edits.uncertainties.length) return Object.assign(record, { status: 'editing_needs_local_evidence', uncertainties: edits.uncertainties });
    const evidenceRefs = new Map();
    for (const ev of request.evidence_catalog) {
      const bound = request.bindings.find(row => row.id === ev.id);
      evidenceRefs.set(ev.id, ev.kind === 'frame' ? { kind: 'frame', path: bound.path,
        start_seconds: ev.timeline_seconds, end_seconds: Math.min(duration, ev.timeline_seconds + 1 / 25) }
        : { kind: 'transcript', path: bound.path, start_seconds: ev.start_seconds, end_seconds: ev.end_seconds });
    }
    const dialogueIntervals = originalObservations.flatMap(row => row.observation.words.filter(w => w.kind === 'speech')
      .map(w => ({ start_seconds: row.source_range[0] + w.start_seconds, end_seconds: row.source_range[0] + w.end_seconds })));
    for (let revision = 0; revision < 2; revision++) {
      const versionDir = path.join(out, `edit-${revision + 1}`); await mkdir(versionDir, { recursive: true });
      await saveJson(path.join(versionDir, 'editing-decisions.json'), edits);
      const compiled = compileEdit({ edits, tasks, routes, analysis, manifestPath, duration, audience: direction.audience,
        craftMode: config.craft_mode, evidence: { sounds: soundPointers, refs: evidenceRefs }, dialogueIntervals,
        execution: session instanceof HostFileSession ? 'host' : 'api', arcManifest: soundArcs?.arcManifest });
      const planFile = path.join(versionDir, 'plan.json'), designFile = path.join(versionDir, 'sound-decisions.json');
      await saveJson(planFile, compiled.plan); await saveJson(designFile, compiled.design);
      record.music_source_budget = await stage('music_source_budget', () => enforceEpisodeMusicSourceBudget({
        config, plan: compiled.plan, caseRoutes, out: versionDir, durationSamples: manifest.timeline.duration_samples }));
      if (!record.music_source_budget.passed) return Object.assign(record, { status: 'reference_music_budget_gap',
        next_action: record.music_source_budget.next_action, fallback_performed: false });
      const handoffFile = path.join(versionDir, 'creative-handoff.json');
      await saveJson(handoffFile, { schema_version: 2, source_video_sha256: manifest.source_sha256,
        sound_decisions_sha256: await hashFile(designFile), plan_sha256: hashCreativePlan(compiled.plan),
        director_brief: await binding(briefFile), music_tasks: await binding(tasksFile), music_reviews: await binding(reviewsFile),
        reviewed_route: await binding(routesFile), selections: compiled.selections, action_responses: compiled.actionResponses });
      const jobFile = path.join(versionDir, 'job.json');
      await saveJson(jobFile, { schema_version: 1, manifest: manifestPath, plan: planFile, sound_decisions: designFile,
        creative_handoff: await binding(handoffFile), original_gain_db: 0, original_audio_state: 'source_aligned_unprocessed',
        music_source_provenance: record.music_source_budget.provenance,
        ...(config.work_identity_evidence ? { work_identity_evidence: config.work_identity_evidence } : {}),
        ...(config.python ? { python: config.python } : {}),
        ...(config.music_source_scope ? { music_source_scope: config.music_source_scope } : {}),
        ...(config.preview ? { preview: { review_only: true } } : {}) });
      const renderDir = path.join(versionDir, 'render-job');
      const render = await stage('aligned_track_render', () => runSoundJob(jobFile, renderDir));
      if (render.cross_work_music?.passed === false) return Object.assign(record, {
        status: render.status, render_status: render.status, cross_work_music: render.cross_work_music,
        next_action: render.next_action, preview: null, audio_dir: null, fallback_performed: false });
      record.render_status = render.status;
      const accompaniment = path.join(renderDir, 'render/accompaniment.wav'), mixFile = path.join(versionDir, 'review-mix.wav');
      await execute('ffmpeg', ['-v', 'error', '-n', '-i', original, '-i', accompaniment, '-filter_complex',
        `[0:a][1:a]amix=inputs=2:normalize=0,atrim=end_sample=${manifest.timeline.duration_samples}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', mixFile], { windowsHide: true });
      const mixSha = await hashFile(mixFile), audits = [];
      // Overlap lets the listener hear both sides of a boundary, including 25-second seams.
      for (let start = 0; start < duration; start += 23) {
        const target = [start, Math.min(duration, start + 25)];
        const video = await stage('continuous_picture_review', () => prepareReviewWindow({ video: source,
          video_sha256: manifest.source_sha256, audio: mixFile, audio_sha256: mixSha,
          first_pts_seconds: manifest.video.first_pts_seconds, source_range: target }, path.join(versionDir, `review-${start}.mp4`)));
        audits.push(await observe({ path: mixFile, source_sha256: mixSha, source_video_sha256: manifest.source_sha256, source_range: target,
          segment_id: `mix/${start}`, asset_id: 'review_mix' }, path.join(versionDir, 'observations/mix', String(start)),
        { frames: localFrames(target), video, purpose: 'mix', context: { story_beats: analysis.story_beats.filter(b => overlap(target, [b.start_seconds, b.end_seconds])) } }));
      }
      const issues = audits.flatMap(row => row.observation.issues.map(item => ({ ...item,
        start_seconds: item.start_seconds + row.source_range[0], end_seconds: item.end_seconds + row.source_range[0] })));
      await saveJson(path.join(versionDir, 'mix-listening.json'), { schema_version: 1, mix_sha256: mixSha,
        actual_audio_processed: true, observations: audits.map(row => row.file), issues, artistic_acceptance: 'awaiting_user_audition' });
      if (soundArcs) {
        const seamObservations = soundArcs.seams.flatMap(seam => {
          const observed = audits.find(row => row.source_range[0] < seam.target_seconds && row.source_range[1] > seam.target_seconds);
          return observed ? [{ seam_id: seam.seam_id, pair_binding_sha256: seam.pair_binding_sha256,
            observation_record: observed.file, qualification_record: qualified.binding }] : [];
        });
        record.sound_arc_seams = validateSoundArcSeams({ arcManifest: soundArcs.arcManifest, seamObservations });
        await saveJson(path.join(versionDir, 'sound-arc-seams.json'), record.sound_arc_seams);
      }
      const technicalIssues = render.mix_issues.filter(issue => issue !== 'original_audio_kind_requires_review');
      const incomplete = render.coverage_status !== 'coverage_ready_for_audition' || record.sound_arc_seams?.pending.length > 0;
      record.status = issues.length || technicalIssues.length || incomplete ? 'needs_targeted_mix_revision' : 'ready_for_user_audition';
      record.mix_issues = issues; record.technical_issues = technicalIssues; record.audio_dir = path.join(renderDir, 'render');
      record.preview = render.preview?.status === 'not_exported' ? null : config.preview ? path.join(renderDir, 'preview.mp4') : null;
      record.next_action = record.status === 'ready_for_user_audition' ? 'audition_complete_episode' : 'revise_reported_windows';
      if (record.status === 'ready_for_user_audition' || revision === 1) break;
      const corrected = (await stage('targeted_edit_revision', () => session.director({
        prompt: '根据实际带画听审与数字检查定点返修，仅修改问题时间范围涉及的音乐或音效cue的gain、淡入淡出、音效anchor和对白避让。'
          + '保留其它cue的所有参数及选择。不能靠音量修正错误选曲或词义；此类问题写入uncertainties返回重新选材。'
          + '不新增素材，不修改剧情/原声，不将审美通过写成自己的评分。返回完整editSchema。',
        data: { current_edits: edits, issues, technical_issues: technicalIssues, analysis, tasks,
          sound_candidates: soundPointers.map(p => ({ event_id: p.event_id, segment_id: p.segment_id, source_range: p.source_range, observation: p.actual_observation })) },
        frames, schema: editSchema, stage: 'targeted_edit_revision' }))).value;
      if (corrected.uncertainties.length) {
        record.next_action = 'reselect_music_or_resolve_scene_evidence'; record.uncertainties = corrected.uncertainties; break;
      }
      const affected = cueId => technicalIssues.length > 0 || issues.some(issue => overlap(
        tasks.cues.find(t => t.cue_id === cueId)?.target_range ?? [0, duration], [issue.start_seconds, issue.end_seconds]));
      for (const edit of corrected.music_edits) if (!affected(edit.music_task_cue_id)
        && JSON.stringify(edit) !== JSON.stringify(edits.music_edits.find(row => row.music_task_cue_id === edit.music_task_cue_id))) throw new Error('revision_modified_unaffected_music');
      edits = corrected; record.revision_count = revision + 1;
    }
    if (await hashFile(config.library.db) !== record.library_database.sha256) throw new Error('library_changed_during_episode');
    if (record.case_store && await hashFile(config.cases.db) !== record.case_store.sha256) throw new Error('case_store_changed_during_episode');
    if (musicProfile) await verifyEvidenceBindings(musicProfile);
    if (!(await validateAudioQualification(qualified.binding, backend,
      ['audio_observation', 'music_candidate_judgment'])).ready) throw new Error('listener_qualification_evidence_changed');
    return record;
  } catch (error) {
    if (error instanceof HostResponsePendingError) return Object.assign(record, { status: 'host_response_pending',
      pending_host_request: error.request_file, pending_host_response: error.response_file,
      next_action: 'review_bound_request_and_write_host_response' });
    record.status = 'failed'; record.error = error.code ? `operation_failed:${error.code}`
      : /^[a-z0-9_:/. -]+$/i.test(error.message) ? error.message.slice(0, 200) : 'stage_failed_see_bound_stage_records';
    return record;
  } finally {
    if (!runtime.retriever) retriever?.close();
    record.generation_receipts = [];
    for (const directory of generationDirs) {
      const file = path.join(directory, 'generated/generation-record.json');
      if (!await exists(file)) continue;
      const receipt = await readJson(file);
      record.generation_receipts.push({ ...await binding(file), status: receipt.status,
        completed: ['candidate_generated_needs_audition', 'candidate_generated_degraded_needs_audition'].includes(receipt.status) });
    }
    record.generation_calls = Math.max(record.generation_calls, record.generation_receipts.length);
    record.runtime_calls = session?.ledger.filter(row => ['host_record_import', 'codex_cli_host_consumption'].includes(row.execution_kind)).length ?? 0;
    const accountingLedger = session?.accountingLedger ?? session?.ledger ?? [];
    record.observer_accounting_incomplete = accountingLedger.some(row => row.accounting === 'not_reported');
    record.model_calls = record.observer_accounting_incomplete ? null
      : accountingLedger.reduce((sum, row) => sum + (row.model_calls ?? 1), 0);
    record.cloud_uploads = record.observer_accounting_incomplete ? null
      : accountingLedger.reduce((sum, row) => sum + (row.cloud_uploads ?? 1), 0);
    record.estimated_cost_ceiling_usd = record.observer_accounting_incomplete
      || accountingLedger.some(row => row.accounting === 'existing_chatgpt_account_usage') ? null
      : accountingLedger.reduce((sum, row) => sum + (row.cost_ceiling_usd ?? 0), 0);
    record.account_usage = accountingLedger.filter(row => row.accounting === 'existing_chatgpt_account_usage')
      .map(row => ({ request_sha256: row.request_sha256, usage: row.usage, receipt: row.receipt }));
    record.elapsed_seconds = (performance.now() - started) / 1000;
    await saveJson(path.join(out, 'compose-record.json'), record);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, ...extra] = process.argv.slice(2);
  try {
    if (!file || extra.length) throw new Error('Usage: node compose_episode.mjs CONFIG.json');
    const result = await composeEpisode(await readJson(file));
    console.log(JSON.stringify({ status: result.status, record: path.join(path.resolve((await readJson(file)).output_dir), 'compose-record.json'),
      model_calls: result.model_calls, cloud_uploads: result.cloud_uploads }));
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } catch (error) { console.error(error.code ? `File operation failed (${error.code})` : 'Invalid compose configuration'); process.exitCode = 1; }
}
