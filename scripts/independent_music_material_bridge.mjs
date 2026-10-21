import path from 'node:path';
import {diagnosticWindowReady} from './offline_material_readiness.mjs';
import {loadBoundQueryTranslations} from './bound_query_translation.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings, objectSchema, validateSchema, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { readTargetAnalysis } from './prepare_target_materials.mjs';
import { requestedWords, wordRequestMode, wordIntervals } from './direction_semantics.mjs';
import { loadProjectTrialPolicy } from './project_trial_gate.mjs';
import { loadCompletedMusicHistory, loadIncrementalMusicUsage } from './cross_work_music_gate.mjs';
import { validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { estimateTrialInputBudget } from './independent_trial_budget.mjs';
import { resolveVerifiedRecordingFamily } from './music_family_identity.mjs';
import { loadTargetSfxLibrary, prepareTargetSfxMaterials } from './target_sfx_material_bridge.mjs';
import { verifyCompletedMaterialSelection } from './completed_material_selection_evidence.mjs';
import { independentMusicSupplyRevision, independentMusicSupplyRequirement,
  assessIndependentMusicSupply, planIndependentMusicInspection } from './independent_music_supply.mjs';
import {recoverSameJobCompletedMaterial} from './same_job_material_recovery.mjs';
import {independentMusicSelectionProjectionRevision} from './independent_music_selection_projection.mjs';
import {independentMusicComparisonPolicy,validateIndependentMusicComparisonPolicy,
  firstInspectionFamilyLimit,diagnosticNumericEnergyRisk,independentMusicComparisonPrompt} from './independent_music_comparison_policy.mjs';

const run = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const str = { type: 'string' }, strings = { type: 'array', items: str };
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const load = async reference => { await verifyEvidenceBindings(reference); return readJson(reference.path); };
const text = value => typeof value === 'string' && Boolean(value.trim());
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const inside = (a, b) => range(a) && range(b) && a[0] >= b[0] && a[1] <= b[1];
const overlaps = (a, b) => range(a) && range(b) && a[0] < b[1] && b[0] < a[1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const fail = code => { throw Error(code); };

export function validateIndependentMusicSelectionRecoveryPolicy(config,request){
  const current=independentMusicComparisonPolicy(config);
  const original=validateIndependentMusicComparisonPolicy(request.independent_music_comparison_policy);
  // JSON object insertion order is not policy. Keep arrays in their original
  // order and validate both complete contracts before comparing any values.
  const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
    ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
  if(canonical(current)!==canonical(original))fail('independent_selection_recovery_comparison_policy_changed');
  return current;
}

// Independent packs have no successful reference-drama case IDs. Tasks are
// grounded in current cue/event identities instead of inventing corpus cases.
export const independentMaterialSelectionSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({
  task_id: str, cue_id: str, kind: { type: 'string', enum: ['music', 'words'] }, preset_id: { type: ['string', 'null'] },
  route_kind: { type: 'string', enum: ['preset', 'sound_conditions'] },
  selected_segment_ids: strings, adopt_reason: str,
  rejections: { type: 'array', items: objectSchema({ segment_id: str, reason: str }) }, unresolved_gaps: strings,
}) } });

function flattenedWindows(publication) {
  const recordings = new Map((publication.packs ?? []).flatMap(pack => pack.recordings ?? []).map(asset => [asset.asset_id, asset]));
  const values = publication.windows ?? publication.packs?.flatMap(pack => (pack.windows ?? []).map(window => ({
    ...window, pack_id: window.pack_id ?? pack.pack_id,
    ...(pack.recordings?.find(row => row.asset_id === window.asset_id) ?? {}),
    ...window,
  }))) ?? [];
  const seen = new Set();
  for (const window of values) {
    if (!text(window.pack_id) || !text(window.window_id) || window.segment_id !== window.window_id
      || !text(window.asset_id) || !/^[a-f0-9]{64}$/.test(window.source_sha256 ?? '')
      || !range(window.source_range) || !path.isAbsolute(window.local_path ?? window.path ?? '')
      || !publication.packs?.some(pack => pack.pack_id === window.pack_id)
      || !['diagnostic_candidate', 'reviewed_window'].includes(window.status)
      || window.production_approval === true || seen.has(window.segment_id)) fail('independent_pack_window_identity_invalid');
    const duration = window.recording_duration_seconds ?? window.duration_seconds;
    if (Number.isFinite(duration) && window.source_range[1] > duration) fail('independent_pack_window_outside_recording');
    seen.add(window.segment_id);
  }
  return values.map(window => ({ ...(recordings.get(window.asset_id) ?? {}), ...window }));
}

function compactPreset(preset) {
  return { preset_id: preset.preset_id, title: preset.title, basis: preset.basis,
    conditions: preset.conditions ?? [], exclusions: preset.exclusions ?? [],
    steps: (preset.steps ?? []).map(step => ({ step_id: step.step_id, event_anchor: step.event_anchor,
      sound_action: step.sound_action, relative_timing: step.relative_timing })) };
}

// Full observations remain hash-bound on disk. The selector receives bounded
// prediction fields, rather than PCM hashes, every beat or repeated raw files.
function compactPrediction(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 800 ? value.slice(0, 800) + ' [truncated; see bound observation]' : value;
  if (depth > 6) return '[nested details in bound observation]';
  if (Array.isArray(value)) {
    const rows = value.slice(0, 12).map(item => compactPrediction(item, depth + 1));
    if (value.length > 12) rows.push({ omitted_items: value.length - 12, full_evidence_retained: true });
    return rows;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['input_pcm_by_backend', 'auxiliary_acoustic_execution', 'execution', 'files',
      'rms_dbfs', 'onset_relative_seconds', 'beats_relative_seconds', 'downbeats_relative_seconds'].includes(key))
    .map(([key, item]) => [key, compactPrediction(item, depth + 1)]));
  return null;
}

export async function loadIndependentMusicPublication(config) {
  const reference = config.music_packs?.publication ?? config.music_packs;
  if (!path.isAbsolute(reference?.path ?? '') || !/^[a-f0-9]{64}$/.test(reference?.sha256 ?? ''))
    fail('independent_music_pack_frozen_publication_required');
  const publication = await load(reference);
  if (publication.kind !== 'independent_music_pack_publication' || publication.schema_version !== 1
    || publication.material_strategy !== 'independent_music_packs' || publication.mode !== 'research'
    || publication.trial_review_policy !== 'diagnostic_candidates' || publication.production_approval !== false
    || !Array.isArray(publication.packs) || !Array.isArray(publication.presets))
    fail('independent_music_pack_publication_scope_invalid');
  await verifyEvidenceBindings(publication.library);
  if (!path.isAbsolute(publication.library?.path ?? '')) fail('independent_pack_library_binding_required');
  const windows = flattenedWindows(publication), families = new Map(), familyInputs = new Map();
  for (const window of windows) {
    const identity = JSON.stringify([window.source_sha256, window.family_identity ?? null]);
    if (familyInputs.has(window.asset_id) && familyInputs.get(window.asset_id) !== identity)
      fail('independent_music_conflicting_recording_family_membership');
    familyInputs.set(window.asset_id, identity);
    if (!families.has(window.asset_id)) families.set(window.asset_id,
      await resolveVerifiedRecordingFamily(window)); // publication is already bound above; do not hash it once per recording
    window.recording_family = families.get(window.asset_id);
    window.diversity_key = window.recording_family ? `family:${window.recording_family.family_id}` : `recording:${window.source_sha256}`;
  }
  return { publication, binding: reference, windows, library: publication.library,
    familyEvidence: unique([...families.values()].flatMap(family => family?.evidence ?? [])) };
}

// Hard conflicts use actual structured story conditions. Missing observations
// remain pending; names and publisher descriptions do not approve dramatic use.
export function independentPresetConflicts(preset, cue) {
  const condition = cue.case_conditions ?? {}, id = preset.preset_id ?? '', values = [];
  const relationship = String(condition.relationship ?? '').toLowerCase();
  if (condition.threat_resolved === false && /relationship-resolution|free-departure/.test(id)) values.push('danger_unresolved');
  if (/family|亲情|母子|母女|父子|父女/.test(relationship) && /relationship-resolution/.test(id)) values.push('family_is_not_romance');
  if (/romance|romantic|love|爱情|恋人/.test(relationship) && /family-change/.test(id)) values.push('romance_is_not_family');
  for (const excluded of cue.exclude_case_conditions ?? []) {
    if (excluded.preset_id === id) values.push('explicit_preset_exclusion');
    if (excluded.narrative_function && (preset.conditions ?? []).includes(excluded.narrative_function))
      values.push('explicit_narrative_function_exclusion');
  }
  return values;
}

export function independentWindowConflicts(window, cue) {
  const reasons = [], condition = cue.case_conditions ?? {}, excluded = cue.exclude_case_conditions ?? [];
  if (['rejected', 'contaminated', 'failed'].includes(window.status) || window.contamination === 'dialogue'
    || window.contamination === 'scene_sounds' || window.contamination === 'damaged') reasons.push('contaminated_or_rejected_window');
  for (const forbidden of window.exclusions ?? []) {
    if (typeof forbidden === 'object' && Object.entries(forbidden).every(([key, value]) => condition[key] === value))
      reasons.push('window_forbidden_story_conditions');
    if (typeof forbidden === 'string' && Object.values(condition).includes(forbidden)) reasons.push('window_forbidden_story_tag');
  }
  for (const forbidden of excluded) {
    if (forbidden.asset_id === window.asset_id || forbidden.pack_id === window.pack_id
      || forbidden.source_sha256 === window.source_sha256) reasons.push('explicit_material_exclusion');
    const known = window.usage_conditions ?? (window.conditions && !Array.isArray(window.conditions) ? window.conditions : {});
    if (Object.keys(forbidden).length && Object.entries(forbidden).every(([key, value]) => known[key] === value))
      reasons.push('window_matches_story_counterexample');
  }
  const hints = [...(window.narrative_functions ?? []), ...(window.development_roles ?? [])];
  const use = window.usage_conditions ?? (window.conditions && !Array.isArray(window.conditions) ? window.conditions : {});
  const relationship = value => /family|亲情|母子|母女|父子|父女/i.test(value ?? '') ? 'family'
    : /romance|romantic|love|爱情|恋人/i.test(value ?? '') ? 'romance' : null;
  if (relationship(condition.relationship) && relationship(use.relationship)
    && relationship(condition.relationship) !== relationship(use.relationship)) reasons.push('family_romance_window_conflict');
  if (/humiliation|受辱|羞辱|巴掌/.test(String(condition.narrative_function ?? ''))
    && hints.some(value => ['light_comedy', 'comedy', 'playful_comedy'].includes(value)))
    reasons.push('light_comedy_after_serious_humiliation');
  if (condition.threat_resolved === false && hints.some(value => ['celebration', 'victory', 'triumph'].includes(value)))
    reasons.push('premature_victory_under_unresolved_threat');
  if (condition.narrative_function === 'agency_light_irony' && hints.includes('oppressive_wordless_chant'))
    reasons.push('pressure_chant_incompatible_with_financial_agency');
  return [...new Set(reasons)];
}

async function inputs(config, analysisBinding, directionBinding, frames) {
  const encoded = await load(analysisBinding);
  let analysis, analysisRef, manifestRef, manifest, source, catalog;
  if (encoded.kind === 'target_analysis') {
    const data = await readTargetAnalysis(analysisBinding, config);
    analysis = data.analysis; analysisRef = data.target.analysis; manifestRef = data.target.manifest;
    manifest = data.manifest; source = data.target.source_video;
    catalog = { source_video_sha256: source.sha256, evidence: data.request.evidence_catalog.map(row => ({
      ...row, ...(data.request.bindings ?? []).find(binding => binding.id === row.id) })) };
  } else {
    analysis = encoded; analysisRef = analysisBinding;
    source = await bound(config.video?.path ?? config.video ?? config.source_video?.path ?? config.source_video);
    manifestRef = typeof config.manifest === 'string' ? await bound(config.manifest) : config.manifest ?? config.prepared_manifest_binding?.manifest;
    manifest = await load(manifestRef);
    catalog = config.evidence_catalog ? await load(config.evidence_catalog) : {
      source_video_sha256: source.sha256, evidence: frames.map(frame => ({ ...frame, kind: 'frame' })) };
  }
  const wrapper = await load(directionBinding), direction = wrapper.direction ?? wrapper;
  const duration = manifest.timeline?.duration_samples / 48000;
  if (analysis.source_video_sha256 !== source.sha256 || manifest.source_sha256 !== source.sha256
    || (wrapper.source_video_sha256 ?? direction.source_video_sha256) !== source.sha256
    || direction.source_video_sha256 !== undefined && direction.source_video_sha256 !== source.sha256 || !(duration > 0)
    || manifest.timeline?.sample_rate !== 48000 || wrapper.analysis && wrapper.analysis.sha256 !== analysisRef.sha256)
    fail('independent_music_target_source_or_clock_changed');
  // The director wire schema does not own file identity. Preserve the host's
  // wrapper SHA in the downstream direction rather than asking the model to
  // rewrite or infer it.
  const director = { ...structuredClone(direction), source_video_sha256: source.sha256 };
  const beats = new Map((analysis.story_beats ?? []).map(beat => [beat.id, beat]));
  const ids = new Set((catalog.evidence ?? []).map(row => row.id));
  if (!beats.size || !ids.size || !director.cues?.length
    || beats.size !== analysis.story_beats.length || new Set(director.cues.map(cue => cue.cue_id)).size !== director.cues.length
    || analysis.story_beats.some(beat => !inside([beat.start_seconds, beat.end_seconds], [0, duration])
      || !beat.evidence_ids?.length || beat.evidence_ids.some(id => !ids.has(id)))
    || director.cues.some(cue => !text(cue.cue_id) || !text(cue.function) || !text(cue.sound_goal)
      || !inside(cue.target_range, [0, duration]) || !cue.story_beat_ids?.length
      || cue.story_beat_ids.some(id => !beats.has(id)
        || !overlaps(cue.target_range, [beats.get(id).start_seconds, beats.get(id).end_seconds]))))
    fail('independent_music_actual_story_cue_evidence_required');
  await verifyEvidenceBindings([source, manifestRef, analysisRef, directionBinding, frames, catalog.evidence]);
  for (const row of catalog.evidence ?? []) if (row.kind === 'audio_observation') {
    const observation = await readJson(row.path);
    Object.assign(row, { source_video_sha256: observation.source_video_sha256, source_sha256: observation.source_sha256,
      verified: false, qualified: false, sound_facts_qualified: false });
  }
  return { analysis, analysisRef, manifestRef, manifest, source, catalog, duration, director };
}

async function historyGuidance(config, data, outputDir) {
  const loaded = await loadProjectTrialPolicy(config, { cwd: outputDir, inputFiles: [data.source.path],
    ...(config.project_policy_path ? { policyPath: config.project_policy_path } : {}) });
  if (loaded?.gap) return { excluded: [], gaps: [{ gap: loaded.gap.code, blocks_render: true }], policy: loaded.binding };
  const policy = loaded?.policy?.cross_work_music;
  if (policy?.status !== 'active') return { excluded: [], gaps: [], status: 'no_active_cross_work_policy' };
  let current = null;
  for (const reference of policy.work_identity_index ?? []) {
    const identity = await load(reference);
    if (identity.source?.sha256 === data.source.sha256) {
      if (current && current.work_id !== identity.work_id) fail('independent_music_conflicting_work_identity');
      current = identity;
    }
  }
  if (!current && config.work_identity_evidence) current = await load(config.work_identity_evidence);
  if (current?.kind !== 'host_validated_work_identity' || current.source?.sha256 !== data.source.sha256 || !text(current.work_id))
    return { excluded: [], gaps: [{ gap: 'cross_work_current_work_identity_missing', blocks_render: true }], policy: loaded.binding };
  const incremental = await loadIncrementalMusicUsage(policy, { source_sha256: data.source.sha256, work_id: current.work_id });
  if (incremental) return { excluded: [], gaps: [], work_id: current.work_id, policy: loaded.binding, ...incremental };
  const history = await loadCompletedMusicHistory(policy);
  const days = policy.independent_reuse_window_days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) fail('independent_music_history_window_invalid');
  const since = Date.now() - days * 86400000, usage = {}, undated = {};
  const seen = new Set();
  for (const row of history.toSorted((a, b) => (Date.parse(b.delivered_at) || 0) - (Date.parse(a.delivered_at) || 0))) {
    if (row.source.sha256 === data.source.sha256 || row.work?.id === current.work_id || seen.has(row.source.sha256)) continue;
    seen.add(row.source.sha256);
    const date = Date.parse(row.delivered_at), keys = new Set();
    for (const recording of row.recordings ?? []) {
      keys.add(`recording:${recording.recording_sha256}`);
      const family = row.recording_family_by_sha256?.[recording.recording_sha256];
      if (family?.family_id && family.identity_basis === 'hash_bound_verified_recording_family_membership')
        keys.add(`family:${family.family_id}`);
    }
    for (const key of keys) {
      if (!Number.isFinite(date)) undated[key] = (undated[key] ?? 0) + 1;
      else if (date >= since && date <= Date.now()) usage[key] = (usage[key] ?? 0) + 1;
    }
  }
  return { excluded: [], gaps: [], work_id: current.work_id, policy: loaded.binding,
    recent_window_days: days, recent_usage_by_key: usage, undated_usage_by_key: undated,
    history_deliveries: history.map(row => row.delivery),
    status: 'independent_reuse_is_context_not_lifetime_song_ban', selection_approval: false };
}

const retrievalProgram = `import sys,json,pathlib
sys.path.insert(0,sys.argv[1])
import segment_library
config=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'))
result=segment_library.query_library(config['library'],text=config['text'],asset_kind='music',limit=config['limit'],
usage_scope='research_noncommercial',preserve_source_windows=True,candidate_scope=config['candidate_scope'])
pathlib.Path(sys.argv[3]).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')`;

async function recall({ config, frozen, task, limit, broaden, outputDir, runtime }) {
  const eligible = new Map(), exclusions = [];
  for (const window of frozen.windows) {
    const reasons = independentWindowConflicts(window, task.cue);
    if (config.material_readiness_policy === 'offline_ready_only' && !diagnosticWindowReady(window))
      reasons.push('offline_window_not_ready');
    if (task.kind === 'words' && window.vocal_presence === 'instrumental') reasons.push('known_instrumental_cannot_supply_words');
    const presetIds = (window.preset_ids ?? []).filter(id => task.presets.some(preset => preset.preset_id === id));
    if (reasons.length) { exclusions.push({ segment_id: window.segment_id, reasons }); continue; }
    eligible.set(window.segment_id, { ...window, preset_ids: presetIds });
  }
  const usage = window => Math.max(task.history.recent_usage_by_key?.[window.diversity_key] ?? 0,
    task.history.recent_usage_by_key?.[`recording:${window.source_sha256}`] ?? 0);
  const query = { library: frozen.library.path, text: broaden ? '' : task.query_text.slice(0, 1000), limit,
    semantic_query_text: task.query_text.slice(0, 1000),
    ...(config.independent_retriever ? {independent_retriever:config.independent_retriever} : {}),
    preserve_source_windows: true, asset_kind: 'music', usage_scope: 'research_noncommercial',
    candidate_scope: [...eligible.values()].map(window => ({ segment_id: window.segment_id,
      diversity_key: window.diversity_key, usage_count: usage(window),
      preference: task.kind === 'words' && window.publisher_vocal_hint !== true ? 1 : 0 })),
    scope_basis: 'host_frozen_window_conflicts_before_limit; verified_family_or_exact_recording; reuse_hint_not_ban',
    publisher_voice_hint_only: task.kind === 'words', actual_window_singing_or_words_not_verified: true };
  const request = await saveJson(path.join(outputDir, 'recall-request.json'), query);
  let result;
  if (!eligible.size) result = { candidates: [], audio_files_read: 0, scope_filtered_before_limit: true,
    gaps: ['no_eligible_frozen_window'], skipped_index_query: true };
  else if (runtime.independentPackRetriever) result = await runtime.independentPackRetriever(query, outputDir,
    {trialBudget:runtime.session?.trialBudget??runtime.trialBudget??null});
  else {
    const resultFile = path.join(outputDir, 'recall-result.json');
    await run(config.python ?? 'python', ['-X', 'utf8', '-c', retrievalProgram, here, request.path, resultFile],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    result = await readJson(resultFile);
  }
  await verifyEvidenceBindings([frozen.binding, frozen.library, request]);
  if (!Array.isArray(result?.candidates)) fail('independent_music_actual_retrieval_required');
  const indexed = new Map(frozen.windows.map(window => [window.segment_id, window]));
  const admitted = [], seen = new Set();
  for (const item of result.candidates.slice(0, limit)) {
    const window = indexed.get(item.segment_id);
    if (!window || window.asset_id !== item.asset_id || window.source_sha256 !== item.source_sha256
      || !same(window.source_range, item.source_range)) fail('independent_music_retrieval_outside_frozen_pack');
    if (seen.has(window.segment_id)) continue;
    seen.add(window.segment_id);
    if (!eligible.has(window.segment_id)) fail('independent_music_retriever_ignored_eligible_scope');
    admitted.push({ ...item, ...eligible.get(window.segment_id), local_path: window.local_path ?? window.path,
      reuse_guidance: { recent_other_work_count: usage(window), window_days: task.history.recent_window_days ?? 30,
        undated_other_work_count: task.history.undated_usage_by_key?.[`recording:${window.source_sha256}`] ?? 0,
        blocks_reuse: false, scope: 'concentration_hint_requires_current_story_comparison' } });
  }
  const receipt = await saveJson(path.join(outputDir, 'admitted-candidates.json'), { schema_version: 1,
    kind: 'independent_pack_recall', task_id: task.task_id, cue_id: task.cue.cue_id, limit, broadened: broaden,
    publication: frozen.binding, library: frozen.library, query: request, candidates: admitted, exclusions,
    indexed_retrieval: result, qualification_granted: false });
  return { candidates: admitted, request, receipt };
}

function inspectionWindows(candidates, targetDuration, { recordingLimit, preferVocalHint = false, inspected = new Set() }) {
  // Begin with a real two-recording comparison; expand once only after a
  // selector has rejected it. The recall remains 20/50 and every admitted
  // window remains archived, so this is staged scrutiny, not lost evidence.
  const ordered = preferVocalHint ? [...candidates].sort((left, right) =>
    Number(right.publisher_vocal_hint === true) - Number(left.publisher_vocal_hint === true)) : candidates;
  const recordings = [], families = new Set(), selected = [], nextInspected = new Set(inspected);
  for (const item of ordered) if (!families.has(item.diversity_key)) {
    if (!nextInspected.has(item.source_sha256) && nextInspected.size >= 5) continue;
    recordings.push(item.source_sha256); families.add(item.diversity_key); nextInspected.add(item.source_sha256);
    if (recordings.length === recordingLimit) break;
  }
  for (const sha of recordings) {
    const windows = ordered.filter(item => item.source_sha256 === sha);
    const span = windows[0]?.source_range[1] - windows[0]?.source_range[0];
    const count = span > 0 && targetDuration <= span ? 1 : 3;
    selected.push(...windows.slice(0, count));
  }
  return selected;
}

async function observe(candidate, runtime, outputDir, cache) {
  const key = JSON.stringify([candidate.source_sha256, candidate.source_range]);
  if (cache.has(key)) return cache.get(key);
  // Local processing does not reserve an account request, but cannot run
  // indefinitely after the film's elapsed/request budget has been exhausted.
  if (runtime.trialBudget?.inspectLocal) await runtime.trialBudget.inspectLocal({ stage: 'candidate_window_observation' });
  else await runtime.trialBudget?.inspect({ budget: { submitted_input_tokens: 0,
    scope: 'local_candidate_window_observation', source_sha256: candidate.source_sha256,
    source_range: candidate.source_range } });
  if (await hashFile(candidate.local_path) !== candidate.source_sha256) fail('independent_music_recording_changed');
  await mkdir(outputDir, { recursive: true });
  const observed = await runtime.materialObserver({ source_file: candidate.local_path, source_sha256: candidate.source_sha256,
    source_range: candidate.source_range, segment_id: candidate.segment_id, pack_id: candidate.pack_id,
    window_id: candidate.window_id, trial_review_policy: 'diagnostic_candidates' }, outputDir);
  return cacheObservation(candidate, observed, outputDir, cache);
}

async function cacheObservation(candidate, observed, outputDir, cache) {
  const key = JSON.stringify([candidate.source_sha256, candidate.source_range]);
  if (observed?.actual_audio_processed !== true || observed.source_sha256 !== candidate.source_sha256
    || !same(observed.source_range, candidate.source_range) || !text(observed.model_revision)
    || !observed.observations || !observed.files?.length) fail('independent_music_actual_window_observation_required');
  await verifyEvidenceBindings(observed);
  // Do not let an unqualified predictor manufacture approval through this adapter.
  const saved = { ...observed, qualified: false, sound_facts_qualified: false, artistic_approval: false, production_approval: false,
    actual_audio_listened: false, evidence_status: 'unqualified_diagnostic_window_prediction' };
  const binding = observed.observation_record ?? await saveJson(path.join(outputDir, 'observation.json'), saved);
  await verifyEvidenceBindings(binding);
  const result = { value: saved, binding }; cache.set(key, result); return result;
}

export async function observeIndependentCandidateBatch(entries, runtime, cache) {
  const failures = new Map();
  if (typeof runtime.materialObserverBatch !== 'function') return failures;
  const unique = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.candidate.source_sha256, entry.candidate.source_range]);
    if (!cache.has(key) && !unique.has(key)) unique.set(key, { ...entry, key });
  }
  const missing = [...unique.values()];
  for (let start = 0; start < missing.length; start += 8) {
    const batch = missing.slice(start, start + 8);
    const budget = runtime.trialBudget?.inspectLocal
      ? await runtime.trialBudget.inspectLocal({ stage: 'candidate_window_observation_batch' })
      : await runtime.trialBudget?.inspect({ budget: { submitted_input_tokens: 0, scope: 'local_candidate_window_observation_batch' } });
    const deadlineMs = Number.isFinite(budget?.remaining_ms) ? Date.now() + budget.remaining_ms : undefined;
    for (const { candidate, directory } of batch) {
      if (await hashFile(candidate.local_path) !== candidate.source_sha256) fail('independent_music_recording_changed');
      await mkdir(directory, { recursive: true });
    }
    const rows = await runtime.materialObserverBatch(batch.map(({ candidate, directory }) => ({ directory,
      job: { source_file: candidate.local_path, source_sha256: candidate.source_sha256,
        source_range: candidate.source_range, segment_id: candidate.segment_id, pack_id: candidate.pack_id,
        window_id: candidate.window_id, trial_review_policy: 'diagnostic_candidates' } })), { deadlineMs });
    if (!Array.isArray(rows) || rows.length !== batch.length) fail('independent_music_batch_observation_cardinality');
    for (const [index, row] of rows.entries()) {
      const entry = batch[index];
      if (row?.status === 'rejected') { failures.set(entry.key, row.reason); continue; }
      if (row?.status !== 'fulfilled') fail('independent_music_batch_observation_status');
      await cacheObservation(entry.candidate, row.value, entry.directory, cache);
    }
  }
  return failures;
}

async function visualEvidence(data, frames, tasks) {
  const provided = [...frames], seen = new Set(provided.map(frame => frame.path));
  if (!provided.length) for (const frame of data.manifest.frames ?? []) {
    const file = path.resolve(path.dirname(data.manifestRef.path), frame.path);
    if (!seen.has(file)) { provided.push({ ...frame, ...await bound(file), source_video_sha256: data.source.sha256 }); seen.add(file); }
  }
  const selected = [];
  for (const task of tasks) {
    const candidates = provided.filter(frame => Number.isFinite(frame.timeline_seconds)
      && frame.timeline_seconds >= task.cue.target_range[0] && frame.timeline_seconds < task.cue.target_range[1]);
    for (const index of new Set([0, Math.max(0, candidates.length - 1)])) if (candidates[index]) selected.push(candidates[index]);
  }
  // The actual plot analysis already binds the continuous picture evidence.
  // Re-submit one contextual still here; duplicate images alone can exceed
  // the independent request budget without adding any audio observation.
  return unique(selected).slice(0, 1);
}

// A failed parent stage can already own completed, paid-for selections. Reuse
// those exact decisions and audio observations only after comparing the current
// full story, publication and every task/window. New attempt paths are not facts.
export async function loadIndependentCompletedSelection(binding, { config, data, frozen, tasks }) {
  // Readiness can deny a bound old request before its costly account-evidence
  // replay. Passing this check still requires the complete verifier below.
  if (config?.material_readiness_policy === 'offline_ready_only') {
    const record = await load(binding), request = await load(record.input);
    if (request.publication?.sha256 !== frozen.binding.sha256)
      fail('independent_selection_recovery_current_story_or_publication_changed');
    const windows = new Map(frozen.windows.map(window => [window.segment_id, window]));
    for (const task of request.tasks ?? []) for (const candidate of task.candidates ?? [])
      if (!diagnosticWindowReady(windows.get(candidate.segment_id)))
        fail('independent_selection_recovery_window_not_offline_ready');
  }
  const recovered = await verifyCompletedMaterialSelection(binding);
  const { request } = recovered, old = await load(request.target_context);
  const comparisonPolicy=validateIndependentMusicSelectionRecoveryPolicy(config,request);
  if (request.music_supply_contract_revision !== undefined
    && request.music_supply_contract_revision !== independentMusicSupplyRevision)
    fail('independent_selection_recovery_music_supply_revision_invalid');
  if (request.source_video_sha256 !== data.source.sha256 || old.source_video_sha256 !== data.source.sha256
    || old.source?.sha256 !== data.source.sha256 || old.manifest?.sha256 !== data.manifestRef.sha256
    || request.publication?.sha256 !== frozen.binding.sha256 || old.publication?.sha256 !== frozen.binding.sha256
    || !same(await load(old.analysis), data.analysis) || !same(await load(old.director), data.director)
    || !same(old.cues, data.director.cues) || old.successful_reference_case !== false || old.production_approval !== false)
    fail('independent_selection_recovery_current_story_or_publication_changed');
  await verifyEvidenceBindings([old.source, old.manifest, frozen.library]);
  if (request.tasks.length !== tasks.length || !same(request.response_schema, independentMaterialSelectionSchema))
    fail('independent_selection_recovery_current_tasks_changed');
  const candidateMap = new Map(), observedBySegment = new Map();
  for (const [index, supplied] of request.tasks.entries()) {
    const task = tasks[index];
    const expected = { task_id: task.task_id, cue_id: task.cue_id, kind: task.kind,
      route_kinds: ['preset', 'sound_conditions'], request_mode: task.request_mode, target_range: task.cue.target_range,
      allowed_words_intervals: task.kind === 'words' ? wordIntervals(task.cue) : [], story_beat_ids: task.cue.story_beat_ids,
      conditions: task.cue.case_conditions ?? {}, story_sequence: task.cue.story_sequence ?? [],
      sound_goal: task.cue.sound_goal, query_text: task.query_text,
      ...(request.music_supply_contract_revision === independentMusicSupplyRevision && task.kind === 'music'
        ? { music_supply_requirement: independentMusicSupplyRequirement(task.cue.target_range) } : {}),
      ...(task.query_language_correction ? { query_language_correction: { binding: task.query_language_correction.binding,
        provenance: task.query_language_correction.provenance } } : {}) };
    const { candidates, applicable_presets, ...actual } = supplied;
    if (!same(actual, expected) || !Array.isArray(candidates) || !candidates.length
      || new Set(candidates.map(row => row.segment_id)).size !== candidates.length)
      fail('independent_selection_recovery_current_tasks_changed');
    for (const candidate of candidates) {
      const item = frozen.windows.find(window => window.segment_id === candidate.segment_id);
      const presetIds = item?.preset_ids?.filter(id => task.presets.some(preset => preset.preset_id === id)) ?? [];
      const usage = Math.max(task.history.recent_usage_by_key?.[item?.diversity_key] ?? 0,
        task.history.recent_usage_by_key?.[`recording:${item?.source_sha256}`] ?? 0);
      const reuse = { recent_other_work_count: usage, window_days: task.history.recent_window_days ?? 30,
        undated_other_work_count: task.history.undated_usage_by_key?.[`recording:${item?.source_sha256}`] ?? 0,
        blocks_reuse: false, scope: 'concentration_hint_requires_current_story_comparison' };
      if (!item || ['asset_id', 'pack_id', 'window_id', 'source_sha256', 'diversity_key'].some(key => item[key] !== candidate[key])
        || !same(item.source_range, candidate.source_range) || !same(presetIds, candidate.preset_ids)
        || !same(reuse, candidate.reuse_guidance) || independentWindowConflicts(item, task.cue).length
        || task.kind === 'words' && item.vocal_presence === 'instrumental')
        fail('independent_selection_recovery_current_window_or_history_changed');
      if(comparisonPolicy&&!same(candidate.technical_energy?.numeric_risk,
        diagnosticNumericEnergyRisk(item.technical_rms_dbfs??null,comparisonPolicy)))
        fail('independent_selection_recovery_numeric_energy_risk_changed');
      if (config?.material_readiness_policy === 'offline_ready_only' && !diagnosticWindowReady(item))
        fail('independent_selection_recovery_window_not_offline_ready');
      const observation = recovered.observations.find(row => row.value.source_sha256 === item.source_sha256
        && same(row.value.source_range, item.source_range) && row.value.model_revision === candidate.model_revision
        && same(compactPrediction(row.value.observations ?? row.value.observation), candidate.observation));
      if (!observation) fail('independent_selection_recovery_exact_observation_required');
      task.inspected.add(item.source_sha256);
      candidateMap.set(task.task_id + ':' + item.segment_id, { ...item, preset_ids: presetIds,
        local_path: item.local_path ?? item.path, reuse_guidance: reuse });
      observedBySegment.set(task.task_id + ':' + item.segment_id, observation);
    }
    if (!same(applicable_presets, task.presets.filter(preset => candidates.some(candidate =>
      candidate.preset_ids.includes(preset.preset_id))).map(compactPreset)))
      fail('independent_selection_recovery_current_presets_changed');
  }
  return { ...recovered, candidateMap, observedBySegment };
}

async function independentTasks(data, frozen, history, runtime) {
  const tasks = data.director.cues.flatMap(cue => ['music', ...(requestedWords(cue) ? ['words'] : [])].map(kind => ({
    task_id: `${cue.cue_id}/${kind}`, cue, kind, cue_id: kind === 'words' ? `${cue.cue_id}/words` : cue.cue_id,
    query_text: String(kind === 'words' ? cue.words_audio_retrieval_query || cue.words_function || cue.sound_goal
      : cue.audio_retrieval_query || cue.music_audio_retrieval_query || cue.style_text || cue.sound_goal),
    presets: frozen.publication.presets.filter(preset => !independentPresetConflicts(preset, cue).length),
    history, inspected: new Set(), request_mode: kind === 'words' ? wordRequestMode(cue) : null,
  })));
  const translations = await loadBoundQueryTranslations(runtime.retrievalQueryCorrections?.[data.source.sha256],
    { sourceSha: data.source.sha256, director: data.director });
  for (const task of tasks) if (translations.has(task.task_id)) {
    const correction = translations.get(task.task_id);
    task.original_query_text = task.query_text; task.query_text = correction.text; task.query_language_correction = correction;
  }
  return { tasks, translations };
}

// Read-only preflight of the exact same seam used by the material consumer.
export async function preflightIndependentCompletedSelection({ config, analysisBinding, directionBinding,
  frames = [], runtime = {}, outputDir = config?.output_dir, selectionBinding }) {
  await validateIndependentMusicPackPolicy(config, { outputDirectory: outputDir, operation: 'prepare_independent_music_materials' });
  const data = await inputs(config, analysisBinding, directionBinding, frames), frozen = await loadIndependentMusicPublication(config);
  const history = await historyGuidance(config, data, outputDir);
  if (history.gaps.length) fail('independent_selection_recovery_current_history_gap');
  const { tasks } = await independentTasks(data, frozen, history, runtime);
  return loadIndependentCompletedSelection(selectionBinding, { config, data, frozen, tasks });
}

/** Real independent-pack consumption, with no reference-case projection.
 * Callback execution and raw result bindings are mandatory for selection.
 */
export async function prepareIndependentMusicPackMaterials({ config, analysisBinding, directionBinding, frames = [], session,
  runtime = {}, outputDir = config?.output_dir }) {
  const comparisonPolicy=independentMusicComparisonPolicy(config);
  await validateIndependentMusicPackPolicy(config, { outputDirectory: outputDir,
    operation: 'prepare_independent_music_materials' });
  await mkdir(outputDir, { recursive: true });
  const data = await inputs(config, analysisBinding, directionBinding, frames);
  const frozen = await loadIndependentMusicPublication(config);
  const record = { schema_version: 1, kind: 'independent_pack_target_preparation', source_video_sha256: data.source.sha256,
    target_analysis: analysisBinding, direction: directionBinding, publication: frozen.binding, library: frozen.library,
    material_strategy: 'independent_music_packs', source_policy: config.source_policy,
    trial_review_policy: 'diagnostic_candidates', gaps: [], material_recall_attempts: [], material_selections: [], candidate_handoffs: [],
    Ready: false, qualified: false, artistic_approval: false, production_approval: false, render_calls: 0, generation_calls: 0 };
  const finish = async values => { Object.assign(record, values);
    record.artifact = await saveJson(path.join(outputDir, 'independent-pack-materials.json'), record); return record; };
  const history = await historyGuidance(config, data, outputDir); record.cross_work_preselection = history;
  if (history.gaps.length) return finish({ status: 'target_research_material_gap', gaps: history.gaps });
  const { tasks, translations } = await independentTasks(data, frozen, history, runtime);
  // A recipe is optional. The bound current story, observations and hard
  // conflicts still apply when no frozen preset describes this new scene.
  const active = tasks;
  if(translations.size) record.query_language_corrections=[...translations.entries()].map(([task_id,value])=>({task_id,...value}));
  let recoveryBinding = runtime.materialSelectionRecoveries?.[data.source.sha256];
  let recovery = recoveryBinding ? await loadIndependentCompletedSelection(recoveryBinding, { config, data, frozen, tasks: active }) : null;
  if(!recoveryBinding&&runtime.sameJobCompletedMaterialRecovery){
    const automatic=await recoverSameJobCompletedMaterial(runtime.sameJobCompletedMaterialRecovery,{
      kind:'music',source:data.source,session,runtime,
      loadCompleted:binding=>loadIndependentCompletedSelection(binding,{config,data,frozen,tasks:active})});
    recoveryBinding=automatic.binding;recovery=automatic.recovered;
    record.same_job_completed_selection_admission=await saveJson(path.join(outputDir,'same-job-completed-selection-admission.json'),automatic.audit);
  }
  if (typeof runtime.materialObserver !== 'function' || typeof (runtime.independentMaterialSelector ?? runtime.materialSelector) !== 'function')
    return finish({ status: 'target_research_material_gap', gaps: [...record.gaps, ...active.map(task => ({
      task_id: task.task_id, cue_id: task.cue_id, kind: task.kind, gap: typeof runtime.materialObserver !== 'function'
        ? 'candidate_audio_observation_pending' : 'independent_material_selector_runtime_missing',
      blocks_render: task.kind === 'music' || task.request_mode === 'require' }))] });
  const director = await saveJson(path.join(outputDir, 'current-director.json'), data.director);
  const catalog = await saveJson(path.join(outputDir, 'evidence-catalog.json'), data.catalog);
  const context = await saveJson(path.join(outputDir, 'current-target-context.json'), { schema_version: 1,
    kind: 'independent_pack_target_context', source_video_sha256: data.source.sha256,
    source: data.source,
    analysis: data.analysisRef, director, manifest: data.manifestRef, publication: frozen.binding,
    cues: data.director.cues, successful_reference_case: false, production_approval: false });
  const selected = [], cache = new Map(), completedExplorations = new Set();
  // Old paid-for selection requests retain their exact contract on replay.
  // New offline-ready music requests expose the source-capacity requirement.
  const freshSupplyContract = config.material_readiness_policy === 'offline_ready_only';
  let pending = active;
  for (const limit of [20, 50]) {
    if (!pending.length) break;
    const recovered = limit === 20 ? recovery : null;
    const eligible = [], candidateMap = new Map(), observedBySegment = new Map(), round = [];
    let request, input, response, sourceFrames;
    const directory = path.join(outputDir, `selection-${limit}`); await mkdir(directory, { recursive: true });
    if (recovered) {
      request = recovered.request; input = recovered.record.input; response = recovered.response;
      sourceFrames = request.source_frames; eligible.push(...request.tasks);
      for (const [key, value] of recovered.candidateMap) candidateMap.set(key, value);
      for (const [key, value] of recovered.observedBySegment) observedBySegment.set(key, value);
      record.completed_selection_recovery = await saveJson(path.join(directory, 'completed-selection-recovery.json'), {
        schema_version: 1, kind: 'completed_independent_selection_reuse', original_selection: recoveryBinding,
        current_context: context, original_context: request.target_context, original_input: input,
        original_response: response.raw_response, source_video_sha256: data.source.sha256,
        proof: recovered.proof, current_story_tasks_publication_and_windows_verified: true,
        original_decisions_and_observations_changed: false, new_model_calls: 0, new_observer_calls: 0,
        original_account_usage_preserved: true, qualified: false, production_approval: false });
    } else {
    for (const [index, task] of pending.entries()) {
      const directory = path.join(outputDir, `recall-${limit}`, String(index)); await mkdir(directory, { recursive: true });
      const recalled = await recall({ config, frozen, task, limit, broaden: limit === 50, outputDir: directory, runtime });
      record.material_recall_attempts.push({ task_id: task.task_id, limit, request: recalled.request, response: recalled.receipt });
      const recordingLimit=firstInspectionFamilyLimit(comparisonPolicy,task.kind,limit);
      const supplyPlan = freshSupplyContract && task.kind === 'music'
        ? planIndependentMusicInspection(recalled.candidates, task.cue.target_range,
          { recordingLimit, inspected: task.inspected }) : null;
      const inspection = supplyPlan?.windows ?? inspectionWindows(recalled.candidates,
        task.cue.target_range[1] - task.cue.target_range[0],
        { recordingLimit, preferVocalHint: task.kind === 'words', inspected: task.inspected }), candidates = [];
      for (const window of inspection) task.inspected.add(window.source_sha256);
      record.candidate_inspections ??= [];
      record.candidate_inspections.push({ task_id: task.task_id, recall_limit: limit,
        recording_limit: recordingLimit, actual_recordings: unique(inspection.map(item => item.source_sha256)).length,
        cumulative_distinct_recordings: task.inspected.size,
        distinct_comparison_families: unique(inspection.map(item => item.diversity_key)).length,
        window_count: inspection.length, source_window_refs: inspection.map(item => ({
          source_sha256: item.source_sha256, source_range: item.source_range, segment_id: item.segment_id })),
        all_recalled_candidates_archived: recalled.receipt,
        ...(supplyPlan ? { music_supply: { ...supplyPlan, windows: supplyPlan.windows.map(item => ({
          segment_id: item.segment_id, source_sha256: item.source_sha256, source_range: item.source_range })) } } : {}),
        publisher_vocal_hint_is_auditory_approval: false });
      round.push({ task, directory, inspection, candidates });
    }
    const batchFailures = await observeIndependentCandidateBatch(round.flatMap(({ directory, inspection }) =>
      inspection.map((candidate, slot) => ({ candidate, directory: path.join(directory, `observation-${slot}`) }))), runtime, cache);
    for (const { task, directory, inspection, candidates } of round) {
      for (const [slot, candidate] of inspection.entries()) {
        let observation;
        try {
          const failed = batchFailures.get(JSON.stringify([candidate.source_sha256, candidate.source_range]));
          if (failed) throw failed;
          observation = await observe(candidate, runtime, path.join(directory, `observation-${slot}`), cache);
        }
        catch (error) {
          if (!/window_not_observed|window_not_available|audio_observation_pending|feature_window_not_observed|specialist_window_inference_failed/.test(error.message ?? '')) throw error;
          const observationTask = await saveJson(path.join(directory, `observation-pending-${slot}.json`), { schema_version: 1,
            kind: 'independent_pack_window_observation_task', task_id: task.task_id, cue_id: task.cue_id,
            source_video_sha256: data.source.sha256, source_file: { path: candidate.local_path, sha256: candidate.source_sha256 },
            source_range: candidate.source_range, pack_id: candidate.pack_id, window_id: candidate.window_id,
            segment_id: candidate.segment_id, publication: frozen.binding,
            status: 'awaiting_actual_observer_execution', error: error.message, actual_audio_processed: false,
            qualified: false, production_approval: false });
          record.gaps.push({ task_id: task.task_id, cue_id: task.cue_id, kind: task.kind,
            gap: 'candidate_audio_observation_pending', candidate_segment_id: candidate.segment_id,
            observation_task: observationTask, blocks_render: false });
          continue;
        }
        candidateMap.set(task.task_id + ':' + candidate.segment_id, candidate);
        observedBySegment.set(task.task_id + ':' + candidate.segment_id, observation);
        candidates.push({ segment_id: candidate.segment_id, asset_id: candidate.asset_id, pack_id: candidate.pack_id,
          window_id: candidate.window_id, source_sha256: candidate.source_sha256, source_range: candidate.source_range,
          diversity_key: candidate.diversity_key, recording_family: candidate.recording_family ? {
            family_id: candidate.recording_family.family_id, identity_basis: candidate.recording_family.identity_basis } : null,
          reuse_guidance: candidate.reuse_guidance,
          preset_ids: candidate.preset_ids, observation: compactPrediction(observation.value.observations),
          model_revision: observation.value.model_revision, evidence_status: 'unqualified_diagnostic_window_prediction',
          lyrics_state: candidate.lyrics_state ?? 'pending', phrase_boundaries_verified: candidate.phrase_boundaries_verified === true,
          publisher_metadata: { title: candidate.title ?? null, artist: candidate.artist ?? null,
            declared_variant: candidate.publisher_variant_label ?? null, description: String(candidate.publisher_description ?? candidate.description ?? '').slice(0, 300),
            publisher_vocal_hint: candidate.publisher_vocal_hint ?? null, scope: 'publisher_hint_not_window_sound_or_lyric_verification' },
          technical_energy: { rms_dbfs: candidate.technical_rms_dbfs ?? null,
            change_db: candidate.technical_energy_change_db ?? null, direction: candidate.technical_energy_direction ?? 'unknown',
            ...(comparisonPolicy?{numeric_risk:diagnosticNumericEnergyRisk(candidate.technical_rms_dbfs??null,comparisonPolicy)}:{}),
            scope: 'actual_pcm_measurement_not_drama_fit_or_phrase_boundary' },
          publisher_vocal_hint: candidate.publisher_vocal_hint ?? null });
      }
      if (candidates.length) eligible.push({ task_id: task.task_id, cue_id: task.cue_id, kind: task.kind,
        route_kinds: ['preset', 'sound_conditions'],
        request_mode: task.request_mode, target_range: task.cue.target_range,
        allowed_words_intervals: task.kind === 'words' ? wordIntervals(task.cue) : [],
        story_beat_ids: task.cue.story_beat_ids, conditions: task.cue.case_conditions ?? {},
        story_sequence: task.cue.story_sequence ?? [], sound_goal: task.cue.sound_goal, query_text: task.query_text,
        ...(freshSupplyContract && task.kind === 'music'
          ? { music_supply_requirement: independentMusicSupplyRequirement(task.cue.target_range) } : {}),
        ...(task.query_language_correction?{query_language_correction:{binding:task.query_language_correction.binding,
          provenance:task.query_language_correction.provenance}}:{}),
        applicable_presets: task.presets.filter(preset => candidates.some(candidate => candidate.preset_ids.includes(preset.preset_id)))
          .map(compactPreset), candidates });
    }
    if (!eligible.length) continue;
    sourceFrames = await visualEvidence(data, frames, pending);
    request = { schema_version: 1, stage: 'independent_music_pack_material_selection',
      material_strategy: 'independent_music_packs', source_video_sha256: data.source.sha256,
      ...(comparisonPolicy?{independent_music_comparison_policy:comparisonPolicy}:{}),
      ...(comparisonPolicy?{independent_music_selection_projection:independentMusicSelectionProjectionRevision}:{}),
      ...(freshSupplyContract ? { music_supply_contract_revision: independentMusicSupplyRevision } : {}),
      publication: frozen.binding, target_context: context,
      prompt: 'Compare actual current story and candidate-window observations. Select supplied windows by ordered story development, character agency, unresolved danger, relationship and dialogue competition. '
        + 'Use route_kind=preset only when one supplied applicable preset matches all selected windows. Otherwise use route_kind=sound_conditions with preset_id=null and explain the current story and sound conditions. Never invent a preset or reference case. '
        + 'Publisher titles, lexical retrieval and editorial recipes are not auditory or artistic approval. You did not hear the PCM; preserve uncertainty and all diagnostic restrictions. '
        + 'This explicit diagnostic trial permits a provisional selection supported by actual source-window predictions and measurements plus current plot conditions. Pending professional listening alone is not a reason to reject an otherwise supported diagnostic choice; retain it as pending. Still reject actual plot conflicts, contamination, unsafe bounds or unavailable source evidence, and allow all candidates to be rejected. '
        + 'No reference drama case is claimed by this route. A cut or observation boundary is not a reason to change song. '
        + 'Keep multiple development windows of one recording when useful. For every inspected candidate provide adoption or a specific rejection. '
        + 'Recent cross-work use is concentration evidence, never a permanent song ban or a fixed per-drama style. '
        + 'Judge this cue independently and explain any reuse against its current story; do not copy another work\'s arrangement. '
        + 'Words candidates require real semantic and phrase evidence for full-phrase use; unknown words may only become explicitly pending diagnostic candidates, never verified lyrics. '
        + 'English, Chinese and other languages are allowed unless this cue explicitly restricts language. Do not default to instrumentals. '
        + 'No light comedy after serious humiliation, no victory before threat resolution, no pressure chant for independent financial agency. '
        + 'Return exact task_id, cue_id and kind. A preset route must name an applicable compatible preset; a sound_conditions route must have null preset_id. Empty selection must state an unresolved gap.'
        + (freshSupplyContract ? ' For music tasks, compare the supplied exact source windows against music_supply_requirement: select enough actual ready source capacity for the target, without assuming loops, stretching or unseen extensions. Multiple recordings or source windows are allowed where current plot conditions support their development; one mother cue is not a same-recording restriction. Overlapping windows of the same recording are not additional duration. Capacity does not approve smooth connections, words, a theme or dramatic suitability; actual editing still must establish them. If all appropriate choices remain insufficient, state that concrete supply gap rather than calling nonempty selection complete.' : ''),
      tasks: eligible, source_frames: sourceFrames, frames: [],
      picture_evidence_submission: 'bound_current_plot_analysis_previously_processed_picture; no duplicate image submitted in material selection',
      observation_files: unique([...observedBySegment.values()].map(value => value.binding)),
      response_schema: independentMaterialSelectionSchema };
    if(comparisonPolicy)request.prompt+=independentMusicComparisonPrompt;
    let inputBudget = estimateTrialInputBudget(request);
    record.selection_input_budgets ??= [];
    record.selection_input_budgets.push({ limit, ...inputBudget });
    input = await saveJson(path.join(directory, 'selection-request.json'), request);
    const callback = runtime.independentMaterialSelector ?? runtime.materialSelector;
    response = await callback({ ...request, input }, directory);
    }
    await verifyEvidenceBindings([input, frozen.binding, frozen.library, context, response?.raw_response,
      request.observation_files, sourceFrames, response?.cli_receipts ?? []]);
    if (response?.input_sha256 !== input.sha256 || response.actual_input_processed !== true || !text(response.model)
      || !response.raw_response?.path) fail('independent_music_actual_selector_response_required');
    const raw = await load(response.raw_response);
    if (raw.input_sha256 !== input.sha256 || raw.model !== response.model || !same(raw.value, response.value))
      fail('independent_music_selector_raw_result_mismatch');
    const value = validateSchema(response.value, independentMaterialSelectionSchema);
    const byTask = new Map(eligible.map(task => [task.task_id, task])), seen = new Set();
    for (const decision of value.decisions) {
      const task = byTask.get(decision.task_id);
      if (!task || seen.has(task.task_id) || decision.cue_id !== task.cue_id || decision.kind !== task.kind)
        fail('independent_music_unknown_or_duplicate_decision');
      seen.add(task.task_id);
      const chosen = new Set(decision.selected_segment_ids), rejected = new Set(decision.rejections.map(row => row.segment_id));
      const ids = new Set(task.candidates.map(row => row.segment_id));
      if (chosen.size !== decision.selected_segment_ids.length || rejected.size !== decision.rejections.length
        || [...chosen, ...rejected].some(id => !ids.has(id)) || [...chosen].some(id => rejected.has(id))
        || ids.size !== chosen.size + rejected.size || decision.rejections.some(row => !text(row.reason))
        || decision.route_kind === 'sound_conditions' && decision.preset_id !== null
        || chosen.size && (!text(decision.adopt_reason) || decision.route_kind === 'preset'
          && !task.applicable_presets.some(preset => preset.preset_id === decision.preset_id))
        || !chosen.size && !decision.unresolved_gaps.length) fail('independent_music_incomplete_or_unbound_decision');
      const supply = request.music_supply_contract_revision === independentMusicSupplyRevision && task.kind === 'music'
        ? assessIndependentMusicSupply([...chosen].map(id => candidateMap.get(task.task_id + ':' + id)), task.target_range) : null;
      if (supply) {
        record.music_supply_assessments ??= [];
        record.music_supply_assessments.push({ task_id: task.task_id, attempt_limit: limit,
          selected_segment_ids: [...chosen], input, raw_response: response.raw_response, supply,
          original_selector_response_changed: false, accepted_for_editing: supply.sufficient_without_source_repetition });
        if (chosen.size && !supply.sufficient_without_source_repetition)
          record.gaps.push({ task_id: task.task_id, cue_id: task.cue_id, kind: task.kind,
            gap: 'selected_ready_source_capacity_shortfall', origin: 'source_supply', attempt_limit: limit,
            shortfall_samples: supply.shortfall_samples, blocks_render: true });
      }
      for (const id of chosen) {
        const item = candidateMap.get(task.task_id + ':' + id);
        if (decision.route_kind === 'preset' && !item.preset_ids.includes(decision.preset_id)) fail('independent_music_selected_preset_window_mismatch');
        // The real provisional choice remains in its immutable response and
        // assessment. It cannot finish preparation when source capacity is short.
        if (supply && !supply.sufficient_without_source_repetition) continue;
        selected.push({ task_id: task.task_id, cue_id: task.cue_id, kind: task.kind, preset_id: decision.preset_id,
          route_kind: decision.route_kind,
          item, observation: observedBySegment.get(task.task_id + ':' + id), reason: decision.adopt_reason,
          raw_response: response.raw_response, input, target_context: request.target_context });
      }
      record.gaps.push(...decision.unresolved_gaps.map(gap => ({ task_id: task.task_id, cue_id: task.cue_id,
        kind: task.kind, gap, origin: 'selector_unresolved', attempt_limit: limit,
        blocks_render: !chosen.size && (task.kind === 'music' || task.request_mode === 'require') })));
    }
    if (seen.size !== byTask.size) fail('independent_music_missing_task_decisions');
    const selector = await saveJson(path.join(directory, 'selection-record.json'), { schema_version: 1,
      kind: 'independent_pack_material_selection', source_video_sha256: data.source.sha256, input,
      raw_response: response.raw_response, value, actual_asset_selection_performed: true,
      selected_count: value.decisions.reduce((total, decision) => total + decision.selected_segment_ids.length, 0),
      artistic_approval: false, production_approval: false, cli_receipts: response.cli_receipts ?? [] });
    record.material_selections.push({ limit, selection: selector });
    for (const item of selected.filter(item => item.input.sha256 === input.sha256)) item.selector_record = selector;
    // Exploration is a real comparison, not a mandatory lyric placement. Once
    // every supplied candidate has a concrete rejection, retain that evidence
    // for offline replenishment and let unrelated music/SFX continue.
    for (const decision of value.decisions) {
      const task = byTask.get(decision.task_id);
      if (task.kind !== 'words' || task.request_mode !== 'explore' || decision.selected_segment_ids.length
        || !decision.rejections.length || !decision.unresolved_gaps.length) continue;
      completedExplorations.add(task.task_id);
      record.deferred_word_explorations ??= [];
      record.deferred_word_explorations.push({ task_id: task.task_id, cue_id: task.cue_id,
        status: 'actually_compared_rejected_pending_replenishment', selection: selector,
        compared_segment_ids: decision.rejections.map(row => row.segment_id),
        unresolved_gaps: decision.unresolved_gaps, blocks_render: false, lyrics_verified: false });
    }
    pending = active.filter(task => !selected.some(item => item.task_id === task.task_id)
      && !completedExplorations.has(task.task_id));
  }
  for (const gap of record.gaps) if (['selector_unresolved', 'source_supply'].includes(gap.origin) && gap.blocks_render
    && selected.some(item => item.task_id === gap.task_id)) {
    gap.status = 'resolved_by_actual_expanded_selection'; gap.blocks_render = false;
  }
  for (const task of pending) record.gaps.push({ task_id: task.task_id, cue_id: task.cue_id, kind: task.kind,
    gap: 'no_actual_selected_pack_window_after_20_then_50', blocks_render: task.kind === 'music' || task.request_mode === 'require' });
  const music = [], words = [], diagnosticWords = [], routes = [], sources = new Map();
  for (const selectedWindow of selected) {
    const { item, observation, preset_id: presetId, cue_id: cueId, route_kind: routeKind } = selectedWindow;
    if (await hashFile(item.local_path) !== item.source_sha256) fail('independent_music_selected_recording_changed');
    const task = active.find(task => task.task_id === selectedWindow.task_id);
    const token = shaBytes(JSON.stringify([selectedWindow.task_id, item.segment_id])).slice(0, 20);
    const routeId = `independent-pack/${token}`;
    const selection = await saveJson(path.join(outputDir, `selection-${token}.json`), { schema_version: 1,
      source_video_sha256: data.source.sha256,
      decisions: [{ cue_id: cueId, selected_segment_id: item.segment_id, selected_source_range: item.source_range,
        reason: selectedWindow.reason }], selection_provenance: {
        selector_record: selectedWindow.selector_record, raw_response: selectedWindow.raw_response,
        input: selectedWindow.input, target_context: selectedWindow.target_context, publication: frozen.binding } });
    const candidate = { ...item, cue_id: cueId, parent_cue_id: task.cue.cue_id, music_pack_id: item.pack_id,
      preset_id: presetId, route_kind: routeKind, condition_binding: context,
      pack_route_id: routeId, case_route_id: routeId, case_ids: [],
      source_range: [...item.source_range], allowed_target_range: task.cue.target_range,
      observation_record: observation.binding, selection_record: selection, selection_source_ranges: [[...item.source_range]],
      reason: selectedWindow.reason, source_relation: item.source_relation ?? 'independent_library',
      evidence_status: 'unqualified_diagnostic_window_prediction', source_identity_verified_by_retrieval: true,
      diagnostic_candidate: true, qualified: false, artistic_approval: false, production_approval: false };
    const handoff = await saveJson(path.join(outputDir, `handoff-${token}.json`), { schema_version: 1,
      source_video_sha256: data.source.sha256, cue_id: cueId, task_id: task.task_id, kind: task.kind,
      pack_id: item.pack_id, window_id: item.window_id, preset_id: presetId, route_kind: routeKind,
      condition_binding: context, publication: frozen.binding,
      selection, observation: observation.binding, target_range: task.cue.target_range, source_range: item.source_range,
      qualified: false, production_approval: false });
    record.candidate_handoffs.push(handoff);
    if (task.kind === 'words') {
      const facts = item.reviewed_words;
      if (facts?.complete_phrase !== true || !inside(facts.source_range, item.source_range)
        || !text(facts.text) || !text(facts.language) || facts.language === 'unknown' || !item.human_review_record) {
        diagnosticWords.push(candidate);
        record.gaps.push({ cue_id: cueId, kind: 'words', gap: 'actual_complete_phrase_content_or_boundary_pending',
          candidate_handoff: handoff, blocks_render: task.request_mode === 'require' });
        continue;
      }
      await verifyEvidenceBindings(item.human_review_record);
      candidate.source_range = [...facts.source_range]; candidate.selection_source_ranges = [[...facts.source_range]];
      candidate.offline_observation = { words: facts }; words.push(candidate);
    } else music.push(candidate);
    routes.push({ route_id: routeId, cue_id: cueId, strategy: 'independent_music_packs', case_ids: [],
      pack_id: item.pack_id, music_pack_id: item.pack_id, window_id: item.window_id, preset_id: presetId,
      route_kind: routeKind, condition_binding: context,
      basis: routeKind === 'preset' ? 'editorial_recipe_and_actual_candidate_observation_not_distilled_reference'
        : 'bound_current_story_sound_conditions_and_actual_candidate_observation_not_distilled_reference',
      source_candidates: [candidate], production_approval: false });
    const windowProvenance = { pack_id: item.pack_id, window_id: item.window_id, preset_id: presetId,
      route_kind: routeKind, cue_id: cueId, condition_binding: context,
      source_range: [...item.source_range], window_binding: frozen.binding };
    const sourceDescriptor = sources.get(item.asset_id) ?? { asset_id: item.asset_id, source_sha256: item.source_sha256,
      origin: ['user_provided', 'reviewed_equivalent'].includes(item.source_relation) ? item.source_relation : 'independent_library',
      ...windowProvenance, windows: [] };
    sourceDescriptor.windows = unique([...sourceDescriptor.windows, windowProvenance]);
    sources.set(item.asset_id, sourceDescriptor);
  }
  // Current unscored story inputs are explicit compatibility context for the
  // existing SFX selector, not successful reference cases or a music recipe.
  const soundContext = await saveJson(path.join(outputDir, 'current-sound-context.json'), {
    schema_version: 2, works: [{ work_id: `current/${data.source.sha256}`, title: 'Current unscored target', split: 'research' }],
    episodes: [{ episode_id: `current/${data.source.sha256}/episode`, work_id: `current/${data.source.sha256}`, source_video: data.source }],
    cases: data.director.cues.map(cue => ({ case_id: `current/${data.source.sha256}/cue/${encodeURIComponent(cue.cue_id)}`,
      episode_id: `current/${data.source.sha256}/episode`, source_role: 'current_unscored_target_not_reference_success_case',
      source_range: cue.target_range, conditions: cue.case_conditions ?? {}, description: cue.sound_goal,
      story_sequence: cue.story_sequence ?? [], evidence: { source_video_sha256: data.source.sha256,
        source_range: cue.target_range, observation_ids: unique(cue.story_beat_ids.flatMap(id => data.analysis.story_beats.find(beat => beat.id === id).evidence_ids)),
        files: [data.analysisRef, director, data.manifestRef, catalog] } })),
    packs: [], sound_packs: [], theme_bundles: [], production_approval: false,
  });
  const sfxLibrary = await loadTargetSfxLibrary(config);
  const soundMaterials = await prepareTargetSfxMaterials({ config, analysisBinding: data.analysisRef, directionBinding: director,
    currentCaseBinding: soundContext, source: data.source, manifestBinding: data.manifestRef, libraryBinding: sfxLibrary,
    evidenceCatalogBinding: catalog, frames, session, runtime, outputDir: path.join(outputDir, 'sounds') });
  record.sound_materials = soundMaterials.artifact; record.sound_gaps = soundMaterials.gaps;
  const eventDecisions = soundMaterials.event_decisions;
  const candidates = await saveJson(path.join(outputDir, 'candidates.json'), { schema_version: 1,
    kind: 'independent_pack_candidates', source_video_sha256: data.source.sha256,
    music, words, diagnostic_words_candidates: diagnosticWords, sounds: soundMaterials.sounds,
    sound_event_guidance: eventDecisions, sound_material_gaps: soundMaterials.gaps,
    artistic_approval: false, production_approval: false });
  const packRoutes = await saveJson(path.join(outputDir, 'pack-routes.json'), { schema_version: 1,
    kind: 'independent_music_pack_routes', source_video_sha256: data.source.sha256,
    store_sha256: frozen.binding.sha256, publication: frozen.binding, routes,
    formal_adoption_allowed: false, production_approval: false });
  const provenance = await saveJson(path.join(outputDir, 'music-source-provenance.json'), { schema_version: 1,
    sources: [...sources.values()], source_policy: config.source_policy, source_ratio_policy: 'independent_pack_trial_only', production_approval: false });
  const boundSounds = soundMaterials.current_materials ? await load(soundMaterials.current_materials) : null;
  const currentMaterials = await saveJson(path.join(outputDir, 'current-materials.json'), { schema_version: 1,
    kind: 'independent_pack_target_materials', source_video_sha256: data.source.sha256,
    publication: frozen.binding, music_packs: frozen.binding, library: frozen.library,
    selected_windows: [...music, ...words].map(item => ({ pack_id: item.pack_id, window_id: item.window_id,
      preset_id: item.preset_id, asset_id: item.asset_id, source_sha256: item.source_sha256, source_range: item.source_range,
      route_kind: item.route_kind, condition_binding: item.condition_binding,
      cue_id: item.cue_id, selection_record: item.selection_record })),
    target_context: context, sound_event_guidance: eventDecisions, sfx_library: sfxLibrary,
    ...(soundMaterials.ambient_library ? { ambient_library: soundMaterials.ambient_library } : {}),
    ...(boundSounds ? { cases: boundSounds.cases ?? [], sound_packs: boundSounds.sound_packs ?? [] } : {}),
    material_sound_preparation: soundMaterials.artifact, artistic_approval: false, production_approval: false });
  const prepared = { manifest: data.manifestRef, analysis: data.analysisRef, director, evidence_catalog: catalog,
    candidates, current_materials: currentMaterials, pack_routes: packRoutes, case_routes: packRoutes,
    music_source_provenance: provenance, music_packs: frozen.binding, material_strategy: 'independent_music_packs',
    source_policy: config.source_policy, trial_review_policy: 'diagnostic_candidates', audience: data.director.audience,
    ...(config.sfx_adoption_mode?{sfx_adoption_mode:config.sfx_adoption_mode}:{}),
    ...(config.assembly_sfx_pool_contract_revision?{assembly_sfx_pool_contract_revision:config.assembly_sfx_pool_contract_revision}:{}),
    ...(config.sfx_library ? { sfx_library: config.sfx_library } : {}),
    ...(config.ambient_library ? { ambient_library: config.ambient_library } : {}),
    ...(config.original_sound_reviews ? { original_sound_reviews: config.original_sound_reviews } : {}) };
  await verifyEvidenceBindings([analysisBinding, directionBinding, frozen.binding, frozen.library, frozen.familyEvidence,
    candidates, packRoutes, provenance]);
  return finish({ status: record.gaps.some(gap => gap.blocks_render) || !music.length
    ? 'target_research_material_gap' : 'target_research_materials_selected', ...prepared,
    prepared_assembly_config: prepared, selected_count: music.length + words.length + soundMaterials.selected_count,
    selected_sounds_count: soundMaterials.selected_count,
    ...(config.sfx_adoption_mode==='assembly'?{sound_adoption_pending:soundMaterials.adoption_pending===true,
      sound_pool_count:soundMaterials.sound_pool_count??0,actual_sound_adoption_performed:false}:{}),
    diagnostic_words_count: diagnosticWords.length, actual_asset_selection_performed: selected.length > 0,
    actual_audio_processed: music.length + words.length + diagnosticWords.length > 0 });
}
