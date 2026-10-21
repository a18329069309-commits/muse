import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { readJson, saveJson, objectSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import {reloadDirectionExecutionBasis} from './bound_direction_execution_evidence.mjs';
import { createCaseMatcher } from './case_host_adapter.mjs';
import { filterReferenceMaterialRoutes, filterMusicProfileRoutes, musicProfileDirectionGaps, loadOfflineHumanReview } from './music_profile.mjs';
import { compileSoundArcPlan, soundArcPlanV2Schema } from './sound_arc_plan.mjs';
import { adaptCaseDevelopment, validateCaseEventAnchors, editSchema } from './compose_episode.mjs';
import { directionSemanticGaps, inspectDirectionUncertainties, requestedWords,
  buildLyricRecallDirector, resolveWordDecisions, resolveDirectionPendingWork } from './direction_semantics.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const range = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] >= 0 && r[1] > r[0];
const contains = (outer, inner) => range(outer) && range(inner) && inner[0] >= outer[0] && inner[1] <= outer[1];
const str = { type: 'string' };
const wordSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({ cue_id: str,
  selected_segment_id: { type: ['string', 'null'] }, selected_source_range: { type: ['array', 'null'], items: { type: 'number' }, minItems: 2, maxItems: 2 },
  selected_target_range: { type: ['array', 'null'], items: { type: 'number' }, minItems: 2, maxItems: 2 },
  reason: str, rejected: { type: 'array', items: objectSchema({ segment_id: str, source_sha256: str,
    source_range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    conflict_kind: { type: 'string', enum: ['lyrics_semantics', 'dialogue_conflict', 'style_conflict'] }, reason: str }) } }) } });
function wordComparisonSchema(overlapTrial) {
  const schema = structuredClone(wordSchema);
  if (overlapTrial) {
    const decision = schema.properties.decisions.items;
    decision.properties.dialogue_overlap_proposal = { ...objectSchema({ semantic_reason: str, masking_risk: str, mix_instruction: str,
      dialogue_assessments: { type: 'array', items: objectSchema({ evidence_id: str,
        importance: { type: 'string', enum: ['critical', 'noncritical', 'unknown'] }, reason: str }) } }), type: ['object', 'null'] };
    decision.required.push('dialogue_overlap_proposal');
  }
  return schema;
}
const soundSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({ event_id: str,
  selected_segment_id: { type: ['string', 'null'] },
  selected_source_range: { type: ['array', 'null'], items: { type: 'number' }, minItems: 2, maxItems: 2 }, reason: str,
  decision: { type: 'string', enum: ['new_asset', 'retain_original', 'omit', 'missing_asset', 'needs_review'] } }) } });
const equivalentSchema = objectSchema({ cue_id: str, source_sha256: str,
  source_range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
  reference_case_ids: { type: 'array', items: str }, original_gap: str, selection_reason: str,
  original_rejections: { type: 'array', items: objectSchema({ source_sha256: str,
    source_range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, reason: str }) } });

export function exactEventDecisions(decisions, ids, key) {
  if (decisions.length !== ids.length || new Set(decisions.map(row => row[key])).size !== ids.length
    || decisions.some(row => !ids.includes(row[key]))) throw new Error('assisted_exact_task_decisions_required');
}

export function chosenWindow(candidates, decision, key) {
  const matches = candidates.filter(row => row[key] === decision[key] && row.segment_id === decision.selected_segment_id
    && contains(row.source_range, decision.selected_source_range));
  if (matches.length !== 1) throw new Error('assisted_unique_selected_window_required');
  return matches[0];
}

export function assertSoundPackageMember(candidate, event, cases) {
  const memberMatches = cases.routes.filter(route => route.route_id === candidate.case_route_id
    && candidate.case_ids?.length && candidate.case_ids.every(id => route.case_ids?.includes(id)))
    .flatMap(route => (route.sound_candidates ?? []).filter(member => member.sound_pack_id === candidate.sound_pack_id
      && member.member_id === candidate.member_id && member.asset_id === candidate.asset_id
      && member.segment_id === candidate.segment_id && member.source_sha256 === candidate.source_sha256
      && contains(member.case_source_range ?? member.source_range, candidate.source_range)));
  const member = memberMatches[0], applicability = member?.applicability;
  if (memberMatches.length !== 1 || applicability?.pack_status !== 'approved'
    || applicability.source_integrity_verified !== true || applicability.eligible_for_current_review !== true
    || applicability.historical_clean_content_verified !== true || member.clean_content_status === 'contaminated'
    || member.unresolved_gaps?.some(value => /contaminated|not_eligible/.test(value))
    || member.sound_role !== candidate.sound_role
    || member.human_review_record?.sha256 !== candidate.human_review_record?.sha256
    || member.sound_role !== event.role && !(event.role === 'transition' && member.sound_role === 'dramatic')
    || event.role !== 'ambience' && member.source_anchor_seconds !== candidate.source_anchor_seconds)
    throw new Error('assisted_reference_sound_member_required');
}

export function assertAssistedSoundEdits(edits, analysis, sounds) {
  exactEventDecisions(edits.sounds, analysis.sound_events.map(row => row.id), 'event_id');
  for (const row of edits.sounds) {
    const event = analysis.sound_events.find(event => event.id === row.event_id);
    // This route has no qualified observation of original physical sounds. Images cannot establish absence.
    if (['physical', 'foley'].includes(event.role) && (row.original_status !== 'unknown'
      || !['needs_review', 'omit'].includes(row.decision))) throw new Error('assisted_original_physical_sound_unverified');
    // Supplied new-asset reviews do not verify what is already audible in the current film, for any role.
    if (row.original_status !== 'unknown' || row.decision === 'retain_original') throw new Error('assisted_original_sound_unverified');
    if (row.decision !== 'new_asset') continue;
    const selected = chosenWindow(sounds, { ...row, selected_source_range: row.source_range }, 'event_id');
    if (event.role !== 'ambience' && (!Number.isFinite(row.source_anchor_seconds)
      || !Number.isFinite(selected.source_anchor_seconds)
      || Math.abs(row.source_anchor_seconds - selected.source_anchor_seconds) > 1 / 48000
      || row.source_anchor_seconds < row.source_range[0] || row.source_anchor_seconds >= row.source_range[1]))
      throw new Error('assisted_verified_sound_anchor_required');
    if (!Number.isFinite(row.target_seconds) || row.target_seconds < event.start_seconds
      || row.target_seconds > event.end_seconds) throw new Error('assisted_sound_target_outside_current_event');
  }
}

// Human listening is supplied evidence; the director never receives an invented audio capability.
export async function humanWindowObservation(candidate, directory, conditions, expectedKind = 'music') {
  const human = await loadOfflineHumanReview(candidate.human_review_record, {
    sourceSha: candidate.source_sha256, sourceRange: candidate.source_range,
    caseIds: candidate.case_ids, conditions, requireWords: candidate.cue_id?.endsWith('/words'),
  });
  if (human.record.asset_kind !== expectedKind) throw new Error('assisted_review_asset_kind_mismatch');
  if (expectedKind === 'sfx' && (!Number.isFinite(human.record.source_anchor_seconds)
    || human.record.source_anchor_seconds !== candidate.source_anchor_seconds))
    throw new Error('assisted_reviewed_sound_anchor_mismatch');
  if (await hashFile(candidate.local_path) !== candidate.source_sha256) throw new Error('assisted_candidate_source_changed');
  await mkdir(directory, { recursive: true });
  const record = { schema_version: 1, protocol: 'offline_human_review', origin: 'human',
    actual_audio_processed: true, actual_audio_listened: true, actual_model_audio_inference: false,
    source_sha256: candidate.source_sha256, source_range: human.record.source_range,
    human_review_record: human.binding, source_audio: human.source,
    observation: human.record.observations, words: human.record.words, music_form: human.record.music_form,
    qualified: false, scopes: [], formal_adoption_allowed: false, production_approval: false };
  return { record, file: await saveJson(path.join(directory, 'human-observation.json'), record) };
}

// This is the missing consumer of research direction. All artistic stages use the real injected session.
export async function completeAssistedTrial(context) {
  const { config, runtime, session, record, out, frames, manifestPath, manifest, sourceFormatOptions, musicProfile, stage, prepareOnly = false } = context;
  const gap = (status, gaps) => Object.assign(record, { status, unresolved: gaps, fallback_performed: false,
    formal_adoption_allowed: false, next_action: 'resolve_only_recorded_package_or_event_gaps' });
  if ((config.strategy ?? 'case_presets') !== 'case_presets' || !config.cases?.db || !config.library?.db)
    return gap('assisted_frozen_packages_required', ['frozen_case_and_library_databases_required']);
  if (!['avoid', 'trial_overlap'].includes(config.words_dialogue_policy ?? 'avoid')
    || config.words_dialogue_policy === 'trial_overlap' && config.mode !== 'assisted_trial')
    throw new Error('assisted_explicit_words_dialogue_policy_required');
  record.case_store = await bound(config.cases.db); record.library_database = await bound(config.library.db);
  const research = await readJson(record.research_candidate.path), analysis = await readJson(research.analysis.path);
  const duration = manifest.timeline.duration_samples / 48000, direction = research.direction;
  const profileGaps = musicProfileDirectionGaps(direction, musicProfile);
  if (profileGaps.length) return gap('music_profile_gap', profileGaps);
  if (config.music_words_policy === 'prefer' && !direction.cues.some(requestedWords))
    return gap('assisted_words_opportunity_not_compared', ['preferred_words_candidate_task_required']);
  if (!direction.cues.length) return gap('assisted_direction_pending', ['music_direction_required']);
  const semanticGaps = directionSemanticGaps(direction, analysis);
  let executionBasis=null;
  if(research.direction_raw_response){await verifyEvidenceBindings(research.direction_raw_response);
    const actual=await readJson(research.direction_raw_response.path);
    if(actual.direction_execution_basis){if(JSON.stringify(actual.value)!==JSON.stringify(direction))throw Error('assisted_direction_execution_response_changed');
      executionBasis=await reloadDirectionExecutionBasis(actual.direction_execution_basis,{sourceSha:manifest.source_sha256,analysis,mode:config.mode});}}
  const uncertainty = inspectDirectionUncertainties(direction, analysis, { mode: config.mode, executionBasis });
  record.direction_uncertainty_scope = uncertainty;
  let pendingDirectionWork = structuredClone(uncertainty.pending_work);
  const savePendingWork = async label => {
    if (!pendingDirectionWork.length) return;
    record.direction_pending_work_items = pendingDirectionWork;
    record.direction_pending_work = await saveJson(path.join(out, `direction-stage-work-${label}.json`), {
      schema_version: 1, source_video_sha256: manifest.source_sha256, analysis: research.analysis,
      direction: record.research_candidate, items: pendingDirectionWork,
      unresolved: pendingDirectionWork.filter(item => item.status === 'pending_stage_execution'),
      original_unknown_text_retained: true, factual_approval: false, qualification_granted: false, production_approval: false });
  };
  const completePendingWork = async (name, evidence, completed, exploration = []) => {
    await verifyEvidenceBindings(evidence);
    pendingDirectionWork = resolveDirectionPendingWork(pendingDirectionWork, { stage: name, evidence,
      completed_cue_ids: completed, exploration_gap_cue_ids: exploration });
    await savePendingWork(name);
  };
  await savePendingWork('initial');
  const uncertaintyReview = uncertainty.narrative_constraints.length || uncertainty.deferred_review.length
    ? await saveJson(path.join(out, 'direction-uncertainty-review.json'), { schema_version: 1,
      source_video_sha256: manifest.source_sha256, analysis: research.analysis, direction: record.research_candidate,
      original_uncertainties: uncertainty.all, narrative_constraints: uncertainty.narrative_constraints,
      deferred_review: uncertainty.deferred_review, status: 'unresolved_constraints_and_review_retained',
      formal_adoption_allowed: false, production_approval: false }) : null;
  if (uncertaintyReview) record.direction_uncertainty_review = uncertaintyReview;
  const uncertaintyData = uncertaintyReview ? { direction_uncertainty_review: uncertaintyReview } : {};
  const uncertaintyInstruction = uncertaintyReview ? '遵守绑定未知处置中的剧情约束及待审项，保留原文、关系、危险状态；不能把延后听审写成已通过。' : '';
  const deferredMixReview = uncertainty.deferred_review.filter(row => row.disposition.components.some(part =>
    part.kind === 'deferred_review' && part.required_stage === 'after_trial_render'));
  const pending = [...semanticGaps, ...uncertainty.blocking,
    ...(research.sound_query_coverage?.complete === true ? [] : ['complete_sound_query_direction_required'])];
  const brief = await saveJson(path.join(out, 'director-brief.json'), { schema_version: 1,
    source_video_sha256: manifest.source_sha256, story_beats: analysis.story_beats, music_actions: direction.music_actions });
  let director = { ...structuredClone(direction), schema_version: 1, source_video_sha256: manifest.source_sha256, director_brief_sha256: brief.sha256,
    usage_scope: 'research_noncommercial', music_actions: direction.music_actions,
    cues: direction.cues.map(row => {
      const cue = { ...row, mode: config.craft_mode, allow_generation: false };
      if (cue.words_target_range === null) { delete cue.words_target_range; if (!cue.words_opportunity) delete cue.words_candidate_request; }
      return cue;
    }) };
  const locations = validateCaseEventAnchors(director, analysis, duration);
  if (locations.pending.length) return gap('current_event_location_pending', locations.pending);
  await saveJson(path.join(out, 'assisted-director-proposal.json'), director);
  record.current_event_locations = await saveJson(path.join(out, 'current-event-locations.json'), locations);
  const matcher = runtime.caseMatcher ?? (['codex_cli', 'codex_host_file'].includes(session.backend_kind)
    ? createCaseMatcher({ python: config.python, candidatePool: config.cases.semantic_candidate_pool,
      packageLinkedOnly: prepareOnly || config.cases.package_linked_only === true,
      reviewLinkedOnly: prepareOnly || config.cases.review_linked_only === true }) : null);
  let cases, soundCases, previousRoutes = [], inspected = [];
  let researchCases;
  const researchComparisons = new Map();
  const recallAttempts = [];
  const recallDirector = buildLyricRecallDirector(director);
  for (const limit of [20, 50]) {
    const directory = path.join(out, `package-recall-${limit}`); await mkdir(directory);
    const query = await saveJson(path.join(directory, 'query.json'), { schema_version: 2,
      source_video_sha256: manifest.source_sha256, store_sha256: record.case_store.sha256,
      usage_scope: director.usage_scope, sequence_match: 'ordered_compatible', limit, inspected_comparisons: inspected, ...sourceFormatOptions,
      story_beats: analysis.story_beats, music_actions: direction.music_actions, cues: recallDirector.cues, ...uncertaintyData });
    cases = await stage(`case_package_recall_${limit}`, async () => {
      if (matcher) return matcher({ query, database: record.case_store, library_db: config.library.db, output_dir: directory }, session);
      const file = path.join(directory, 'routes.json');
      await execute(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'case_preset_store.py'), 'query',
        '--db', config.cases.db, '--input', query.path, '--library-db', config.library.db, '--output', file],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return readJson(file);
    });
    await verifyEvidenceBindings([record.case_store, record.library_database]);
    if (cases.source_video_sha256 !== manifest.source_sha256 || cases.store_sha256 !== record.case_store.sha256
      || !Array.isArray(cases.routes) || cases.formal_adoption_allowed !== false) throw new Error('assisted_case_route_identity_mismatch');
    recallAttempts.push({ limit, query, response: await saveJson(path.join(directory, 'received-routes.json'), cases) });
    record.case_package_recall_attempts = recallAttempts;
    if (sourceFormatOptions.source_format_manifest && (cases.source_format_policy?.prefer_vertical !== sourceFormatOptions.prefer_vertical
      || cases.source_format_policy?.source_format_manifest?.sha256 !== sourceFormatOptions.source_format_manifest.sha256
      || path.resolve(cases.source_format_policy?.source_format_manifest?.path ?? '') !== sourceFormatOptions.source_format_manifest.path
      || cases.source_format_policy?.story_hard_exclusions_preserved !== true)) throw new Error('case_source_format_policy_mismatch');
    inspected.push(...(cases.comparisons ?? []).flatMap(row => row.decisions.map(item => ({ cue_id: row.cue_id, case_id: item.case_id }))));
    cases.routes = [...new Map([...previousRoutes, ...cases.routes].map(row => [row.route_id, row])).values()];
    previousRoutes = cases.routes;
    cases = adaptCaseDevelopment(cases, { director: recallDirector, analysis, duration });
    for (const row of cases.comparisons ?? []) researchComparisons.set(row.cue_id + ':' + row.response?.sha256, row);
    const researchCoverage = recallDirector.cues.map(cue => {
      const routes = cases.routes.filter(row => row.cue_id === cue.cue_id), mapped = new Set(routes.flatMap(row =>
        (row.structure_match?.steps ?? []).map(step => step.target_story_step_id)));
      const required = (cue.story_sequence ?? []).map(step => step.step_id), uncovered = required.filter(id => !mapped.has(id));
      const prior = cases.coverage?.find(row => row.cue_id === cue.cue_id) ?? {};
      return { ...prior, cue_id: cue.cue_id, case_count: new Set(routes.flatMap(row => row.case_ids)).size,
        required_target_story_step_ids: required, covered_target_story_step_ids: required.filter(id => mapped.has(id)),
        uncovered_target_story_step_ids: uncovered, step_coverage_status: uncovered.length ? 'partial_ordered_research_mapping' : 'all_steps_mapped_not_material_approval',
        gaps: [...(prior.gaps ?? []).filter(gap => !gap.startsWith('unmapped_current_story_step:')
          && (!routes.length || !['no_recalled_case', 'no_semantically_compatible_reference_in_inspected_pool'].includes(gap))),
        ...uncovered.map(id => 'unmapped_current_story_step:' + id)] };
    });
    researchCases = { ...cases, kind: 'cumulative_unqualified_research_case_routes', coverage: researchCoverage,
      comparisons: [...researchComparisons.values()], recall_attempts: recallAttempts,
      gaps: researchCoverage.flatMap(row => row.gaps.map(gap => ({ cue_id: row.cue_id, gap }))),
      status: !cases.routes.length ? 'no_research_case_mapping' : researchCoverage.some(row => row.uncovered_target_story_step_ids.length)
        ? 'partial_ordered_research_mapping' : 'ordered_research_mapping_not_material_approval',
      formal_adoption_allowed: false, artistic_approval: false, production_approval: false };
    soundCases = cases;
    const profile = filterMusicProfileRoutes(cases, director, musicProfile);
    cases = profile.caseRoutes;
    const admission = await filterReferenceMaterialRoutes(cases, director, config.cases.material_policy);
    record.material_admission = { material_policy: config.cases.material_policy ?? 'reference_original_only',
      status: admission.status, gaps: admission.gaps, formal_adoption_allowed: false };
    cases = admission.caseRoutes;
    let wordsObservable = true;
    for (const cue of director.cues.filter(requestedWords)) {
      let available = false;
      for (const route of cases.routes.filter(row => row.cue_id === cue.cue_id + '/words')) for (const candidate of route.source_candidates) {
        try {
          const human = await loadOfflineHumanReview(candidate.human_review_record, { sourceSha: candidate.source_sha256,
            sourceRange: candidate.case_source_range ?? candidate.source_range, caseIds: route.case_ids,
            conditions: cue.case_conditions, requireWords: true });
          if (human.record.asset_kind === 'music' && await hashFile(candidate.local_path) === candidate.source_sha256) available = true;
        } catch { /* The normal observation phase retains the specific failure; first expand recall once. */ }
      }
      if (!available) wordsObservable = false;
    }
    if (admission.ready && wordsObservable && !admission.gaps.some(row => row.comparison_status === 'material_missing_not_rejected')) break;
    if (limit === 50 && !admission.ready) pending.push(...admission.gaps.filter(row => row.required !== false));
  }
  record.research_case_routes = await saveJson(path.join(out, 'research-case-routes.json'), researchCases);
  const caseFile = await saveJson(path.join(out, 'assisted-case-routes.json'), cases);
  const music = [], words = [], soundPool = [], reviewGaps = [];
  for (const cue of director.cues) {
    for (const id of [cue.cue_id, ...(requestedWords(cue) ? [cue.cue_id + '/words'] : [])]) {
      const recordings = new Set(), windows = new Set();
      for (const route of cases.routes.filter(row => row.cue_id === id)) for (const supplied of route.source_candidates) {
        if (!recordings.has(supplied.source_sha256) && recordings.size >= 5) continue;
        const sourceRange = supplied.case_source_range ?? supplied.source_range;
        const key = supplied.source_sha256 + JSON.stringify(sourceRange) + JSON.stringify(supplied.allowed_target_range ?? null);
        if (windows.has(key)) continue;
        const candidate = { ...supplied, cue_id: id, source_range: sourceRange,
          case_route_id: route.route_id, case_ids: route.case_ids, music_pack_id: route.music_pack_id };
        try {
          const observed = await humanWindowObservation(candidate, path.join(out, 'package-observations', String(music.length + words.length)), cue.case_conditions);
          candidate.observation_record = observed.file; candidate.offline_observation = observed.record;
          (id.endsWith('/words') ? words : music).push(candidate); recordings.add(candidate.source_sha256); windows.add(key);
        } catch (error) {
          reviewGaps.push({ cue_id: id, segment_id: supplied.segment_id,
            gap: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'source_window_human_review_missing' });
        }
      }
    }
  }
  record.package_review_gaps = reviewGaps;
  const missing = director.cues.filter(cue => !music.some(row => row.cue_id === cue.cue_id));
  pending.push(...missing.map(row => ({ cue_id: row.cue_id, gap: 'actual_approved_window_facts_required' })));
  for (const event of analysis.sound_events) {
    const recordings = new Set(), windows = new Set();
    for (const route of soundCases.routes) for (const member of route.sound_candidates ?? []) {
      if (!recordings.has(member.source_sha256) && recordings.size >= 5) continue;
      const applicability = member.applicability;
      if (applicability?.pack_status !== 'approved' || applicability.source_integrity_verified !== true
        || applicability.eligible_for_current_review !== true || applicability.historical_clean_content_verified !== true
        || member.clean_content_status === 'contaminated'
        || member.unresolved_gaps?.some(value => /contaminated|not_eligible/.test(value))) continue;
      if (member.sound_role !== event.role && !(event.role === 'transition' && member.sound_role === 'dramatic')) continue;
      const candidate = { ...member, event_id: event.id, case_ids: route.case_ids, case_route_id: route.route_id,
        source_range: member.case_source_range ?? member.source_range };
      const key = member.source_sha256 + JSON.stringify(candidate.source_range);
      if (windows.has(key)) continue;
      try {
        assertSoundPackageMember(candidate, event, soundCases);
        const conditions = director.cues.find(cue => event.start_seconds >= cue.target_range[0] && event.start_seconds < cue.target_range[1])?.case_conditions;
        const observation = await humanWindowObservation(candidate, path.join(out, 'sound-observations', String(soundPool.length)),
          conditions, event.role === 'ambience' ? 'ambience' : 'sfx');
        soundPool.push({ ...candidate, observation_record: observation.file, offline_observation: observation.record });
        recordings.add(candidate.source_sha256); windows.add(key);
      } catch { /* No human record means no new sound; original status remains explicit. */ }
    }
  }
  let chosenWords = [], lyricExplorationGaps = [], lyricOverlapTrials = [];
  const overlapTrial = config.words_dialogue_policy === 'trial_overlap', dialogueEvidence = [];
  if (overlapTrial && words.length) {
    // Host-bound transcript chunks remain predictions. The model cannot invent dialogue evidence or upgrade it.
    await verifyEvidenceBindings(research.observation_bindings ?? []);
    for (const [index, binding] of (research.observation_bindings ?? []).entries()) {
      const observation = await readJson(binding.path);
      if (observation.source_video_sha256 !== manifest.source_sha256) throw new Error('assisted_dialogue_observation_source_changed');
      if (!range(observation.source_range) || typeof observation.transcription_prediction !== 'string'
        || !observation.transcription_prediction.trim()) continue;
      dialogueEvidence.push({ id: 'dialogue-observation-' + index, binding, source_video_sha256: manifest.source_sha256,
        source_range: observation.source_range, text: observation.transcription_prediction,
        verification: 'unverified_prediction', timestamp_precision: observation.timestamp_precision ?? 'unknown' });
    }
  }
  const missingDialogue = director.cues.some(requestedWords) && !Array.isArray(config.dialogue_intervals);
  if (missingDialogue) pending.push('actual_local_dialogue_intervals_required_for_words');
  if (!uncertainty.blocking.length && !semanticGaps.length && !missingDialogue) {
    const suppliedWordIds = [...new Set(words.map(row => row.cue_id))];
    const result = suppliedWordIds.length ? await stage('assisted_chinese_words_comparison', () => session.director({
      stage: 'assisted_chinese_words_comparison', frames, schema: wordComparisonSchema(overlapTrial),
      prompt: '先比较所供实际人工核过的完整歌句，再在words_opportunity许可区间选择原速落点。'
        + '按剧情和人物视角比较任何已核语言；请求unknown表示不限定，显式zh/en等必须保持，真实素材语言unknown仍拒绝。'
        + 'selected_source_range须等于已核完整歌句，selected_target_range长度相同，默认避开对白；不裁字、不拉伸。'
        + (overlapTrial ? '本次显式允许提出叠唱试听，非正式通过。若与对白相交，dialogue_overlap_proposal须逐个引用相交的dialogue_evidence，'
          + '注明重要性及理由、人物视角和词义、遮字风险、局部混音措施。关键剧情信息或重要性未知均不允许叠唱；不叠唱填null。'
          + '所供对白仍是预测且只有块边界，不宣称已核词或已听过混音。生成试听之后必须完成本片声画听核，不要求先听不存在的混音。' : '')
        + '旧版固定words_target_range仍须遵守。每个有实际候选的/words任务返回一次决定。'
        + 'explore可以因实际词义、对白或风格冲突拒绝，但须逐源窗引用SHA、范围和具体原因；require缺适合歌词保持未完成。'
        + '空库不能说成歌词不适合。人工核音记录不是你当次听音。' + uncertaintyInstruction,
      data: { source_video_sha256: manifest.source_sha256, director, analysis,
        dialogue_intervals: config.dialogue_intervals ?? [], dialogue_evidence: dialogueEvidence,
        words_dialogue_policy: config.words_dialogue_policy ?? 'avoid', human_words_candidates: words, requested_cue_ids: suppliedWordIds, ...uncertaintyData },
    })) : { value: { decisions: [] }, raw_response: null };
    const resolved = resolveWordDecisions({ director, candidates: words, decisions: result.value.decisions,
      dialogueIntervals: config.dialogue_intervals ?? [], mode: config.mode,
      dialoguePolicy: config.words_dialogue_policy ?? 'avoid', dialogueEvidence });
    // An optional empty pool can become a preview gap only after the bounded expansion really ran.
    for (const item of resolved.gaps.filter(row => row.blocks_render === false)) {
      if (!recallAttempts.some(row => row.limit === 50)) {
        item.blocks_render = true; item.execution_action = 'expanded_recall_pending';
      }
    }
    record.words_comparison = await saveJson(path.join(out, 'words-selection.json'), {
      ...result.value, comparisons: resolved.comparisons, gaps: resolved.gaps, overlap_trials: resolved.overlap_trials, recall_attempts: recallAttempts,
      source_video_sha256: manifest.source_sha256, raw_response: result.raw_response });
    const comparedWordCues = director.cues.filter(requestedWords).filter(cue =>
      !resolved.gaps.some(item => item.cue_id === cue.cue_id + '/words')).map(cue => cue.cue_id);
    await completePendingWork('words_selection', record.words_comparison, comparedWordCues,
      resolved.gaps.filter(item => item.blocks_render === false).map(item => item.cue_id.replace(/\/words$/, '')));
    director = resolved.director;
    chosenWords = resolved.chosen.map(row => ({ ...row, selection_record: record.words_comparison }));
    lyricExplorationGaps = resolved.gaps.filter(row => row.blocks_render === false);
    lyricOverlapTrials = resolved.overlap_trials;
    record.lyric_dialogue_overlap_trials = lyricOverlapTrials;
    record.lyric_exploration_gaps = lyricExplorationGaps;
    pending.push(...resolved.gaps.filter(row => row.blocks_render !== false));
  } else record.words_comparison_pending = missingDialogue ? 'actual_dialogue_intervals_pending' : 'critical_story_or_direction_gap_retained';
  record.prepared_candidate_evidence = await saveJson(path.join(out, 'prepared-candidate-evidence.json'), {
    source_video_sha256: manifest.source_sha256, music, words, sounds: soundPool,
    unresolved: [...pending, ...lyricExplorationGaps], formal_adoption_allowed: false, production_approval: false });
  if (pending.length) {
    // A local plot/words gap does not discard independently observed music or sound candidates.
    // This record is preparatory only; no incomplete episode can reach the renderer.
    return gap('assisted_scoped_work_pending', [...pending, ...lyricExplorationGaps]);
  }
  const directorFile = await saveJson(path.join(out, 'assisted-director.json'), director);
  const arcResult = await stage('assisted_music_arc_selection', () => session.director({ stage: 'assisted_music_arc_selection', frames,
    prompt: '依据本片剧情与已供人工实际听音记录选择真实音乐乐句，返回v2声音弧线。人工记录只批准其具体源窗，不是你当次听音。'
      + '完整覆盖每个母cue；切镜不换曲。source_continuation须同录音连续；crossfade用明确已核余量。留白必须明确剧情理由。'
      + '音乐根据蓄压、推动、兑现发展。不可循环补长度、扩大已核窗、捏造乐句或唱词。缺素材返回null并说明。'
      + 'words_target_range必须位于一个音乐piece内，保留歌句任务及明确的语言要求，不允许用器乐默默代替。'
      + '剧情适配先于原曲身份，适用原曲优先。采用认可等效源窗时逐窗填写equivalent_adoptions，说明原曲缺口和本片选择原因；'
      + '同任务若有已核原曲，逐一列出为何不适用。不能仅因等效曲排序靠前选它。' + uncertaintyInstruction,
    data: { source_video_sha256: manifest.source_sha256, director, case_routes: cases,
      human_package_observations: music, chosen_complete_words: chosenWords,
      lyric_exploration_gaps: lyricExplorationGaps, formal_listening_qualification: false, ...uncertaintyData },
    schema: objectSchema({ plan: { ...soundArcPlanV2Schema, type: ['object', 'null'] }, unresolved_gaps: { type: 'array', items: str },
      equivalent_adoptions: { type: 'array', items: equivalentSchema } }) }));
  if (!arcResult.value.plan || arcResult.value.unresolved_gaps.length) return gap('sound_arc_gap', arcResult.value.unresolved_gaps);
  const arcPlan = arcResult.value.plan, compiled = compileSoundArcPlan({ plan: arcPlan, director, candidates: music });
  const selection = await saveJson(path.join(out, 'music-selection.json'), { schema_version: 1,
    source_video_sha256: manifest.source_sha256, origin: 'actual_director_package_selection',
    raw_response: arcResult.raw_response, decisions: compiled.arcManifest.arcs.flatMap(arc => arc.pieces.filter(piece => piece.source_window).map(piece => ({
      cue_id: piece.parent_cue_id ?? arc.parent_cue_id, selected_segment_id: piece.source_window.segment_id,
      selected_source_range: piece.source_window.source_range, reason: piece.function ?? piece.development_role ?? 'Actual chosen arc piece; see bound director response.' }))) });
  for (const candidate of music) candidate.selection_record = selection;
  const selectedMusic = music.flatMap(candidate => {
    const windows = compiled.arcManifest.arcs.flatMap(arc => arc.pieces).filter(piece => piece.source_window
      && piece.parent_cue_id === candidate.cue_id && piece.source_window.segment_id === candidate.segment_id
      && piece.source_window.source_sha256 === candidate.source_sha256
      && contains(candidate.source_range, piece.source_window.source_range)).map(piece => piece.source_window.source_range);
    return windows.length ? [{ ...candidate, selection_source_ranges: windows }] : [];
  });
  for (const candidate of selectedMusic.filter(row => row.material_source_kind === 'reviewed_equivalent')) {
    for (const window of candidate.selection_source_ranges) {
      const decisions = arcResult.value.equivalent_adoptions.filter(row => row.cue_id === candidate.cue_id
        && row.source_sha256 === candidate.source_sha256 && JSON.stringify(row.source_range) === JSON.stringify(window));
      const decision = decisions[0], originals = music.filter(row => row.cue_id === candidate.cue_id && row.material_source_kind === 'reference_original');
      if (decisions.length !== 1 || !decision.original_gap.trim() || !decision.selection_reason.trim()
        || !decision.reference_case_ids.length || !decision.reference_case_ids.every(id => candidate.case_ids.includes(id))
        || originals.some(original => !decision.original_rejections.some(row => row.source_sha256 === original.source_sha256
          && JSON.stringify(row.source_range) === JSON.stringify(original.source_range) && row.reason.trim())))
        return gap('assisted_equivalent_adoption_reason_missing', [{ cue_id: candidate.cue_id, source_range: window }]);
    }
  }
  await completePendingWork('material_selection', selection,
    [...new Set(compiled.arcManifest.arcs.flatMap(arc => arc.pieces.filter(piece => piece.source_window)
      .map(piece => piece.parent_cue_id ?? arc.parent_cue_id)))]);
  record.material_equivalence = await saveJson(path.join(out, 'equivalent-adoptions.json'), {
    decisions: arcResult.value.equivalent_adoptions, raw_response: arcResult.raw_response,
    original_admission_gaps: record.material_admission.gaps, current_target_not_reference: true });
  const soundResult = await stage('assisted_sound_selection', () => session.director({ stage: 'assisted_sound_selection', frames,
    prompt: '逐事件决定新增、省略或待核。只能选择所供已核干净音效。原片音效未知时needs_review，不能猜无巴掌后重复叠加。'
      + '当前辅助路径没有合格原声核验，所有类别original_status必须unknown，不得retain_original；physical/foley只能needs_review或omit。'
      + '音乐与音效统一分配重点；环境声单独处理。不把声音预测当事实。new_asset必须返回具体selected_source_range，其他决定填null。' + uncertaintyInstruction,
    data: { source_video_sha256: manifest.source_sha256, analysis, director, arc_plan: arcPlan, human_sound_candidates: soundPool, ...uncertaintyData }, schema: soundSchema }));
  const soundFile = await saveJson(path.join(out, 'sound-selection.json'), { ...soundResult.value,
    source_video_sha256: manifest.source_sha256, raw_response: soundResult.raw_response });
  exactEventDecisions(soundResult.value.decisions, analysis.sound_events.map(row => row.id), 'event_id');
  const sounds = soundResult.value.decisions.filter(row => row.decision === 'new_asset').map(decision => ({
    ...chosenWindow(soundPool, decision, 'event_id'), source_range: decision.selected_source_range, selection_record: soundFile }));
  // Freeze a render-compatible current-event mapping; these IDs never alter the reference case identity.
  const normalizedSounds = { ...soundResult.value, source_video_sha256: manifest.source_sha256, raw_response: soundResult.raw_response,
    decisions: soundResult.value.decisions };
  // saveJson refuses overwrites: use a separate bound record after normalization.
  const normalizedSoundFile = await saveJson(path.join(out, 'sound-current-selection.json'), normalizedSounds);
  for (const candidate of sounds) candidate.selection_record = normalizedSoundFile;
  const dialogueIntervals = config.dialogue_intervals ?? [];
  const edited = await stage('assisted_music_and_sound_edit', () => session.director({ stage: 'assisted_music_and_sound_edit', frames,
    prompt: '编排实际采用的音乐、已核语言的完整歌句与音效。每个split cue及歌句一个music_edit，每个真实sound_event一个决定。'
      + '同源连续外端淡化由编译器完成，不造中间音量凹口。跨曲连接使用v2真实余量，不能声称加淡化就是剧情契合。'
      + '本辅助路线所有类别的original_status必须unknown，禁止凭推测写verified或retain_original；物理事件只needs_review/omit。'
      + '已核新增剧情重音、转场和环境素材可独立编排，不证明原轨缺声。不修改对白原轨，不整体压低新增音乐，只在所供局部对白区间避让。'
      + 'source_range、锚点不能越过已核窗，完整唱词不得截断；返修明确段落。' + uncertaintyInstruction,
    data: { source_video_sha256: manifest.source_sha256, analysis, director, arc_manifest: compiled.arcManifest,
      tasks: compiled.splitCues, chosen_words: chosenWords, sound_decisions: normalizedSounds, selected_sounds: sounds,
      dialogue_intervals: dialogueIntervals, ...uncertaintyData }, schema: editSchema }));
  assertAssistedSoundEdits(edited.value, analysis, sounds);
  const catalog = await readJson(path.join(out, 'analysis/request.json'));
  const frameEvidence = catalog.bindings.filter(row => row.kind === 'frame').map(row => {
    const clock = catalog.evidence_catalog.find(item => item.id === row.id);
    return { ...row, start_seconds: clock.timeline_seconds, end_seconds: clock.timeline_seconds };
  });
  const renderConfig = { schema_version: 1, mode: 'assisted_trial', craft_mode: config.craft_mode, audience: direction.audience,
    strategy: 'case_presets', cases: { ...config.cases, material_policy: config.cases.material_policy ?? 'reference_original_only' },
    ...(config.python ? { python: config.python } : {}),
    ...(config.music_source_provenance ? { music_source_provenance: config.music_source_provenance } : {}),
    ...(config.music_source_scope ? { music_source_scope: config.music_source_scope } : {}),
    ...(config.work_identity_evidence ? { work_identity_evidence: config.work_identity_evidence } : {}),
    output_dir: path.join(out, 'trial'), manifest: await bound(manifestPath), analysis: research.analysis, director: directorFile,
    arc_plan: await saveJson(path.join(out, 'chosen-sound-arc.json'), arcPlan),
    candidates: await saveJson(path.join(out, 'chosen-candidates.json'), { music: selectedMusic, words: chosenWords, sounds }),
    edits: await saveJson(path.join(out, 'chosen-edits.json'), edited.value),
    evidence_catalog: await saveJson(path.join(out, 'render-evidence.json'), { source_video_sha256: manifest.source_sha256, evidence: frameEvidence }),
    case_routes: caseFile, dialogue_intervals: dialogueIntervals, original_gain_db: 0, preview: config.preview !== false,
    ...((lyricExplorationGaps.length || lyricOverlapTrials.length || deferredMixReview.length) ? {
      research_review_pending: [...(lyricExplorationGaps.length || lyricOverlapTrials.length ? [record.words_comparison] : []),
        ...(deferredMixReview.length ? [uncertaintyReview] : [])] } : {}),
    cross_film_reuse_check: record.cross_film_reuse_check,
  };
  await savePendingWork('before_render');
  const unexecutedWork = pendingDirectionWork.filter(item => item.status === 'pending_stage_execution');
  if (unexecutedWork.length) return gap('direction_pending_work_stage_pending', unexecutedWork);
  await saveJson(path.join(out, 'assisted-render-config.json'), renderConfig);
  await verifyEvidenceBindings([record.case_store, record.library_database, research.analysis, directorFile, caseFile,
    ...dialogueEvidence.map(row => row.binding)]);
  if (prepareOnly) return Object.assign(record, { status: 'target_material_selection_prepared',
    prepared_render_config: await bound(path.join(out, 'assisted-render-config.json')),
    selected_complete_lyric_phrases_count: chosenWords.length,
    render_calls: 0, previews_created: 0, actual_material_consumer_verified: false,
    formal_adoption_allowed: false, production_approval: false });
  const { renderResearchTrial } = await import('./render_research_trial.mjs');
  const rendered = await stage('assisted_render', () => renderResearchTrial(renderConfig, runtime));
  if (!rendered.audio_dir) return Object.assign(record, { status: rendered.status, technical_status: rendered.status,
    trial: rendered, preview: rendered.preview ?? null, audio_dir: rendered.audio_dir,
    unresolved: rendered.unresolved, next_action: rendered.next_action, music_source_budget: rendered.music_source_budget,
    ...(rendered.error ? { error: rendered.error } : {}), fallback_performed: rendered.fallback_performed ?? false,
    formal_adoption_allowed: false, production_approval: false });
  if (deferredMixReview.length) record.direction_uncertainty_mix_review = await saveJson(path.join(out, 'direction-uncertainty-mix-review-pending.json'), {
    schema_version: 1, status: 'pending_actual_audiovisual_audition', source_video_sha256: manifest.source_sha256,
    uncertainty_review: uncertaintyReview, deferred_review: deferredMixReview,
    preview: rendered.preview ? await bound(rendered.preview) : null,
    accompaniment: await bound(path.join(rendered.audio_dir, 'accompaniment.wav')),
    actual_listening_review: 'not_performed', formal_adoption_allowed: false, production_approval: false });
  if (lyricOverlapTrials.length) record.lyric_dialogue_mix_review = await saveJson(path.join(out, 'lyric-dialogue-mix-review-pending.json'), {
    schema_version: 1, status: 'pending_actual_audiovisual_audition', source_video_sha256: manifest.source_sha256,
    words_selection: record.words_comparison, trials: lyricOverlapTrials,
    preview: rendered.preview ? await bound(rendered.preview) : null,
    accompaniment: await bound(path.join(rendered.audio_dir, 'accompaniment.wav')),
    required_checks: ['current_dialogue_intelligibility', 'character_and_lyrics_semantic_fit', 'complete_phrase_boundaries', 'lyrics_audibility_after_ducking'],
    actual_listening_review: 'not_performed', formal_adoption_allowed: false, production_approval: false });
  const phrasesByLanguage = {};
  for (const row of chosenWords) {
    const language = row.offline_observation.words.vocal_language;
    phrasesByLanguage[language] = (phrasesByLanguage[language] ?? 0) + 1;
  }
  return Object.assign(record, { status: lyricExplorationGaps.length && rendered.preview
    ? 'assisted_preview_with_lyric_exploration_gaps' : lyricOverlapTrials.length && rendered.preview
      ? 'assisted_preview_with_lyric_dialogue_overlap' : deferredMixReview.length
        ? rendered.preview ? 'assisted_preview_with_direction_review_pending' : 'assisted_audio_with_direction_review_pending' : rendered.status,
    technical_status: rendered.status, trial: rendered, preview: rendered.preview, audio_dir: rendered.audio_dir,
    selected_music: rendered.selected_music, unresolved: [...rendered.unresolved, ...lyricExplorationGaps,
      ...lyricOverlapTrials.map(row => ({ cue_id: row.cue_id, reason: 'lyric_dialogue_actual_mix_review_pending', review: record.lyric_dialogue_mix_review })),
      ...uncertainty.deferred_review.map(row => ({ ...row,
        reason: deferredMixReview.includes(row) ? 'direction_uncertainty_actual_mix_review_pending' : 'direction_uncertainty_provenance_limit_retained',
        review: deferredMixReview.includes(row) ? record.direction_uncertainty_mix_review : uncertaintyReview }))], formal_adoption_allowed: false,
    lyric_exploration_complete: lyricExplorationGaps.length === 0, selected_complete_chinese_phrases_count: phrasesByLanguage.zh ?? 0,
    selected_complete_lyric_phrases_count: chosenWords.length, selected_complete_lyric_phrases_by_language: phrasesByLanguage,
    artistic_acceptance: lyricExplorationGaps.length ? 'lyric_exploration_incomplete_pending_actual_audition' : 'awaiting_actual_audition',
    production_approval: false });
}
