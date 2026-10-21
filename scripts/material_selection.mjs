import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ApiSession, readJson, saveJson, objectSchema, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { attachPrecedingArcContext } from './material_arc_context.mjs';
import { loadInvalidMaterialWindows } from './invalid_material_window_evidence.mjs';
import { projectFlatMaterialObservations } from './material_observation_projection.mjs';
import { loadPendingMaterialComparison, verifyRebuiltMaterialComparison } from './material_comparison_resume.mjs';
import {sfxMaterialSelectionProjectionRevision} from './sfx_material_selection_projection.mjs';
import {bindDiagnosticSfxSelectionPolicy,diagnosticSfxSelectionPromptFor} from './sfx_diagnostic_selection_policy.mjs';
import {sfxEventFunctionRevision,soundUsageSchema,validateSoundFunctionIntent,validateSelectedSoundUsage,soundEventFunctionPrompt} from './sfx_event_function.mjs';
import {isValidatedIndependentMusicPackPolicy} from './independent_music_policy.mjs';

const str = { type: 'string' }, strings = { type: 'array', items: str };
export const materialSelectionSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({
  case_id: str, step_id: str, kind: { type: 'string', enum: ['music', 'sfx', 'ambience'] },
  sound_role: { type: ['string', 'null'] }, selected_segment_ids: strings, adopt_reason: str,
  rejections: { type: 'array', items: objectSchema({ segment_id: str, reason: str }) }, unresolved_gaps: strings,
}) } });
const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const key = task => JSON.stringify([task.case_id, task.step_id, task.kind, task.sound_role ?? null]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const observationIdentity = candidate => JSON.stringify([candidate.candidate.source_sha256, candidate.candidate.source_range,
  candidate.observation_contexts ?? null, candidate.human_context_review?.sha256 ?? null]);
async function checkObservedCandidate(pointer, observed) {
  if (!observed?.model_revision || observed.actual_audio_processed !== true
    || observed.source_sha256 !== pointer.source_sha256 || !same(observed.source_range, pointer.source_range)
    || !observed.observations || !observed.files?.length) throw new Error('candidate_actual_audio_observation_required');
  await verifyEvidenceBindings(observed);
}

// Plain SFX/music windows can share model loading. Context or human-review
// jobs retain their existing individual path and its extra evidence checks.
async function prefetchPlainObservations(tasks, runtime, out, cache, exclusions = new Map()) {
  if (typeof runtime.materialObserverBatch !== 'function') return;
  const unique = new Map();
  for (const [taskIndex, task] of tasks.entries())
    for (const [index, candidate] of selectInspectionCandidates(task.candidates).entries()) {
      if (exclusions.has(JSON.stringify([candidate.candidate.source_sha256, candidate.candidate.source_range]))) continue;
      if (candidate.observation_contexts?.length || candidate.human_context_review) continue;
      const identity = observationIdentity(candidate);
      if (cache.has(identity)) continue;
      if (!unique.has(identity)) unique.set(identity, { candidate, identity,
        directory: path.join(out, 'observations', `${taskIndex}-${index}`) });
    }
  const entries = [...unique.values()];
  for (let start = 0; start < entries.length; start += 8) {
    const batch = entries.slice(start, start + 8);
    const budget = await runtime.trialBudget?.inspectLocal?.({ stage: 'corpus_candidate_observation_batch' });
    const deadlineMs = Number.isFinite(budget?.remaining_ms) ? Date.now() + budget.remaining_ms : undefined;
    const jobs = [];
    for (const entry of batch) {
      const c = entry.candidate, pointer = c.candidate;
      await mkdir(entry.directory, { recursive: true });
      jobs.push({ directory: entry.directory, job: {
        source_file: typeof c.source_file === 'string' ? c.source_file : c.source_file.path,
        source_sha256: pointer.source_sha256, source_range: pointer.source_range, segment_id: pointer.segment_id } });
    }
    const rows = await runtime.materialObserverBatch(jobs, { deadlineMs });
    if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('candidate_batch_observation_cardinality');
    for (const [index, row] of rows.entries()) {
      if (row?.status === 'rejected') throw row.reason instanceof Error ? row.reason : new Error(String(row.reason));
      if (row?.status !== 'fulfilled') throw new Error('candidate_batch_observation_status');
      await checkObservedCandidate(batch[index].candidate.candidate, row.value);
      cache.set(batch[index].identity, row.value);
    }
  }
}

// Read only manifests already bound to the case. Image submission is distinct
// from the earlier director's text description and grants no audio qualification.
export async function caseImageEvidence(caseItems) {
  const manifests = new Map(), frames = new Map(), files = new Map(), gaps = [];
  for (const item of caseItems) {
    let located = false;
    for (const reference of item.evidence?.files ?? []) {
      if (path.basename(reference.path ?? '') !== 'manifest.json') continue;
      let prepared = manifests.get(reference.path);
      if (!prepared) {
        await verifyEvidenceBindings(reference);
        prepared = await readJson(reference.path);
        manifests.set(reference.path, prepared);
      }
      if (prepared.source_sha256 !== item.evidence.source_video_sha256 || !Array.isArray(prepared.frames)) continue;
      const source = { path: path.resolve(prepared.source_video), sha256: prepared.source_sha256 };
      if (!files.has(source.path)) { await verifyEvidenceBindings(source); files.set(source.path, source); }
      const range = item.source_range, eligible = prepared.frames.filter(row => Number.isFinite(row.timeline_seconds)
        && row.timeline_seconds >= range[0] && row.timeline_seconds < range[1]);
      if (!eligible.length) continue;
      for (const index of new Set([0, Math.floor((eligible.length - 1) / 2), eligible.length - 1])) {
        const row = eligible[index], absolute = path.resolve(path.dirname(reference.path), row.path);
        let frame = frames.get(absolute);
        if (!frame) {
          frame = { ...await binding(absolute), timeline_seconds: row.timeline_seconds,
            source_video_sha256: prepared.source_sha256, case_ids: [] };
          frames.set(absolute, frame);
        }
        if (!frame.case_ids.includes(item.case_id)) frame.case_ids.push(item.case_id);
      }
      files.set(reference.path, reference); located = true; break;
    }
    if (!located) gaps.push({ case_id: item.case_id, gap: 'bound_case_frames_unavailable' });
  }
  return { frames: [...frames.values()], files: [...files.values()], gaps };
}

export function selectInspectionCandidates(candidates, limit = 5) {
  const selected = [], recordings = new Set();
  for (const candidate of candidates) {
    if (recordings.has(candidate.candidate.source_sha256)) continue;
    selected.push(candidate); recordings.add(candidate.candidate.source_sha256);
    if (selected.length === limit) return selected;
  }
  // The recall still retains every window. When fewer recordings exist, use
  // the remaining inspection slots to compare developments of the same song.
  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

// Construction is offline. Calls retain ApiSession's configured budget and credential checks.
export function createApiMaterialObserver(session) {
  if (!(session instanceof ApiSession)) throw new Error('material_audio_api_session_required');
  return { materialObserver_backend_id: session.audioBackend.protocol,
    materialObserver_model_revision: session.audioBackend.model_revision,
    materialObserver: async (job, directory) => {
      const observed = await session.observeAudio({ path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
        source_sha256: job.source_sha256,
        source_range: job.source_range, segment_id: job.segment_id }, directory, { purpose: 'candidate' });
      await verifyEvidenceBindings([observed.file, observed.api_evidence, observed.input_audio]);
      if (observed.actual_audio_processed !== true || observed.source_sha256 !== job.source_sha256
        || !same(observed.source_range, job.source_range)) throw new Error('candidate_api_observation_identity_mismatch');
      return { source_sha256: observed.source_sha256, source_range: observed.source_range,
        actual_audio_processed: true, model_revision: observed.model_revision, observations: observed.observation,
        files: [observed.file, observed.api_evidence, observed.input_audio],
        evidence_status: 'unqualified_research_prediction', artistic_approval: false, production_approval: false };
    } };
}

// Candidate observers receive actual recording windows. GPT receives their bound observations;
// it must never infer what an unheard WAV sounds like from its filename or retrieval rank.
export async function selectMaterials(input,runtime={}) {return prepareMaterialComparison(input,runtime,false);}
// This shares the actual source-window observer, not the selector or its receipts.
export async function observeMaterialCandidates(input,runtime={}) {return prepareMaterialComparison(input,runtime,true);}
async function prepareMaterialComparison({ candidate_file, input_file, output_dir, preceding_arc, resume_existing_request,
  sfx_material_selection_projection,completed_target_story,sfx_diagnostic_policy,sfx_event_function_revision }, runtime = {}, observationOnly=false) {
  if(sfx_event_function_revision!==undefined&&sfx_event_function_revision!==sfxEventFunctionRevision)
    throw Error('sfx_event_function_revision_invalid');
  if(sfx_event_function_revision&&sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision)
    throw Error('sfx_event_function_selection_projection_required');
  if(sfx_diagnostic_policy!==undefined&&(sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision
    ||!isValidatedIndependentMusicPackPolicy(sfx_diagnostic_policy)))throw Error('sfx_diagnostic_selection_validated_host_policy_required');
  const out = path.resolve(output_dir); await mkdir(out, { recursive: true });
  const source = await binding(candidate_file), caseSource = await binding(input_file);
  const encoded = await readJson(source.path);
  if (resume_existing_request && (typeof runtime.materialObserver !== 'function' || typeof runtime.materialSelector !== 'function'))
    throw new Error('material_comparison_resume_runtime_required');
  if (typeof runtime.materialObserver !== 'function') {
    // No selection is attempted, so avoid expanding and hashing the entire candidate corpus.
    const record = { schema_version: 1, status: 'material_comparison_pending', candidate_source: source, case_source: caseSource,
      selected_count: 0, automatic_selection_performed: false, artistic_approval: false, production_approval: false,
      gaps: encoded.tasks.map(task => ({ case_id: task.case_id, step_id: task.step_id,
        gap: task.candidates.length ? 'candidate_audio_observation_pending' : 'candidate_retrieval_empty' })) };
    await saveJson(path.join(out, 'selection-record.json'), record);
    return record;
  }
  await verifyEvidenceBindings(encoded);
  const document = expandCandidateEvidence(encoded);
  const cases = await readJson(caseSource.path);
  const byCase = new Map(cases.cases.map(item => [item.case_id, item]));
  const observationCache = new Map(), eligible = [], gaps = [];
  const recovery = resume_existing_request ? await loadPendingMaterialComparison(resume_existing_request,
    { source, caseSource, outputDir: out, runtime }) : null;
  if (recovery) for (const [identity, value] of recovery.observations) observationCache.set(identity, value);
  const invalidWindows = runtime.invalidMaterialWindows ? await loadInvalidMaterialWindows(runtime.invalidMaterialWindows) : null;
  const exclusions = new Map((invalidWindows?.windows ?? []).map(row => [JSON.stringify([row.source_sha256,row.source_range]),row]));
  for (const task of document.tasks) if (!byCase.has(task.case_id)
    || !['music', 'sfx', 'ambience'].includes(task.attempts[0]?.query.asset_kind))
    throw new Error('material_task_case_or_kind_invalid');
  await prefetchPlainObservations(document.tasks, runtime, out, observationCache, exclusions);
  for (const [taskIndex, task] of document.tasks.entries()) {
    const kind = task.attempts[0]?.query.asset_kind, role = task.candidates[0]?.binding.sounds[0]?.sound_role ?? null;
    if (!byCase.has(task.case_id) || !['music', 'sfx', 'ambience'].includes(kind)) throw new Error('material_task_case_or_kind_invalid');
    const candidates = [];
    // Preserve all recalled windows while comparing different recordings first.
    const inspectionCandidates = selectInspectionCandidates(task.candidates);
    if (task.candidates.length > inspectionCandidates.length) gaps.push({ case_id: task.case_id, step_id: task.step_id,
      gap: 'additional_recalled_windows_not_listened', remaining_count: task.candidates.length - inspectionCandidates.length });
    for (const [index, candidate] of inspectionCandidates.entries()) {
      const pointer = candidate.candidate;
      const invalid = exclusions.get(JSON.stringify([pointer.source_sha256,pointer.source_range]));
      if (invalid) {
        gaps.push({ case_id:task.case_id, step_id:task.step_id, segment_id:pointer.segment_id,
          source_sha256:pointer.source_sha256, source_range:pointer.source_range,
          gap:'candidate_source_window_exceeds_verified_decoded_audio', reason:invalid.reason,
          evidence:invalid.evidence, invalid_window_registry:invalidWindows.evidence,
          source_window_changed:false, actual_audio_observation_performed:false });
        continue;
      }
      const identity = observationIdentity(candidate);
      let observed = observationCache.get(identity);
      if (recovery && !observed) throw new Error('material_comparison_resume_missing_observed_window');
      if (!observed && typeof runtime.materialObserver === 'function') {
        const directory = path.join(out, 'observations', `${taskIndex}-${index}`);
        await mkdir(directory, { recursive: true });
        observed = await runtime.materialObserver({ source_file: typeof candidate.source_file === 'string'
          ? candidate.source_file : candidate.source_file.path,
          source_sha256: pointer.source_sha256, source_range: pointer.source_range, segment_id: pointer.segment_id,
          ...(candidate.observation_contexts ? { observation_contexts: candidate.observation_contexts,
            bridge_recording_role: candidate.bridge_recording_role } : {}),
          ...(candidate.human_context_review ? { human_context_review: candidate.human_context_review } : {}) }, directory);
        await checkObservedCandidate(pointer, observed);
        observationCache.set(identity, observed);
      }
      if (!observed) continue;
      if ((candidate.observation_contexts ?? []).some(context => !observed.observation_contexts?.some(actual =>
        actual.context_only === true && actual.actual_audio_processed === true && actual.source_sha256 === pointer.source_sha256
        && same(actual.source_range, context.source_range)))
        || candidate.human_context_review && observed.human_context_review?.review?.sha256 !== candidate.human_context_review.sha256)
        throw new Error('candidate_actual_context_observation_and_scoped_human_facts_required');
      // Keep the shared evidence table outside the model's per-candidate data.
      candidates.push({ segment_id: pointer.segment_id, asset_id: pointer.asset_id,
        source_sha256: pointer.source_sha256, source_range: pointer.source_range, phase: pointer.phase,
        observation: observed.observations, evidence_status: observed.evidence_status ?? 'unqualified_research_prediction',
        model_revision: observed.model_revision,
        ...(observed.observation_contexts ? { observation_contexts: observed.observation_contexts } : {}),
        ...(observed.human_context_review ? { human_context_review: observed.human_context_review } : {}) });
    }
    if (candidates.length) {
      if(sfx_event_function_revision)validateSoundFunctionIntent(task.sound_function_intent,{soundRole:role,
        eventId:task.source_event_id,targetRange:task.reference_event.source_range});
      eligible.push({ case_id: task.case_id, step_id: task.step_id, kind, sound_role: role,
      reference_event: task.reference_event, reason: task.reason,
      ...(sfx_event_function_revision?{sound_function_intent:task.sound_function_intent,
        sound_query_projection:Object.fromEntries(Object.entries(task.sound_query_projection??{}).filter(([field])=>
          ['original_intent','retrieval_query','excluded_tags','duration_role','basis','qualification_granted'].includes(field))),
        sound_query_projection_host_evidence:{candidate_source:source,json_pointer:`/tasks/${taskIndex}/sound_query_projection`,
          scope:'complete_retrieval_execution_metadata_retained_in_bound_candidate_source; not_current_sound_facts'}}:{}), candidates });
    }
    else gaps.push({ case_id: task.case_id, step_id: task.step_id, gap: task.candidates.length
      ? 'candidate_audio_observation_pending' : 'candidate_retrieval_empty' });
  }
  const observedFiles = [...new Map([...observationCache.values()].flatMap(item => item.files)
    .map(file => [JSON.stringify(file), file])).values()];
  const caseItems = [...new Set(eligible.map(task => task.case_id))].map(id => byCase.get(id));
  const visual = await caseImageEvidence(caseItems); gaps.push(...visual.gaps);
  let request = { schema_version: 1, candidate_source: source, case_source: caseSource,
    ...(invalidWindows ? { invalid_window_registry:invalidWindows.evidence,
      excluded_windows:gaps.filter(row=>row.gap==='candidate_source_window_exceeds_verified_decoded_audio') } : {}),
    backend_id: runtime.materialSelector_backend_id ?? null,
    observation_backend_id: runtime.materialObserver_backend_id ?? null,
    observation_model_revision: runtime.materialObserver_model_revision ?? null,
    prompt: '比较当前剧情任务与候选实际源窗的声音观察，先判断人物观点、未解威胁、关系变化、年代、推进与兑现，'
      + '再比较律动、声部、乐句、歌词含义及对白密度。不得将曲名、标签、召回顺序当听核。'
      + '未知保持未知；研究预测只支持暂定研究选择，不能签发已核唱词或艺术通过。'
      + '仅选择给定segment_id，每任务最多5个不同录音；可保留同曲不同发展窗。'
      + '每任务返回选用原因、逐项淘汰原因或未解决缺口。未获实际音频观察的候选禁止判定；'
      + '已有绑定的未资格化观察可支持明确标注的暂定研究选择，不能冒充亲自听过或艺术认可。'
      + '不明的律动、声部、唱词及对白冲突不得编造；证据不足仍可全部拒绝。'
      + 'observation_contexts是同源音乐发展观察上下文，不是可采用源窗或原剧出现位置；不得因看了上下文扩大source_range。'
      + 'human_context_review仅保存原审核源窗内的声音事实及原用途条件，不能自动认可当前情境；'
      + '优先保留已有范围内的无词/干净事实，不把ASR短预测改称已核唱词；完整乐句、当前采用与Ready仍须独立证据。',
    tasks: eligible, frames: visual.frames, visual_files: visual.files, case_context: caseItems.map(item => {
      const id = item.case_id;
      return { case_id: id, description: item.description, conditions: item.conditions,
        story_sequence: item.story_sequence, development_preset: item.development_preset, uncertainties: item.uncertainties };
    }), observation_files: observedFiles, response_schema: materialSelectionSchema };
  if(sfx_material_selection_projection!==undefined){
    if(sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision||!completed_target_story)
      throw Error('sfx_material_projection_completed_story_required');
    await verifyEvidenceBindings(completed_target_story);
    const story=await readJson(completed_target_story.path);
    if(!story.source_video_sha256||caseItems.some(item=>item.evidence.source_video_sha256!==story.source_video_sha256)
      ||eligible.some(task=>!['sfx','ambience'].includes(task.kind)))throw Error('sfx_material_projection_story_or_kind_changed');
    request.sfx_material_selection_projection=sfx_material_selection_projection;
    request.source_video_sha256=story.source_video_sha256;
    request.completed_target_story={analysis:completed_target_story,source_video_sha256:story.source_video_sha256,
      scope:'previously_completed_target_picture_and_story; no_new_sound_or_picture_observation'};
    request.response_schema=structuredClone(materialSelectionSchema);
    request.response_schema.properties.decisions.items.properties.selected_segment_ids.maxItems=1;
    request.prompt=request.prompt.replace('每任务最多5个不同录音；可保留同曲不同发展窗。',
      '每个声音事件最多采用一个给定源窗；必须真实比较全部给定候选，对所有未采用候选分别给出淘汰理由，或全部拒绝。');
    if(sfx_event_function_revision){
      request.sfx_event_function_revision=sfx_event_function_revision;
      const decision=request.response_schema.properties.decisions.items;
      decision.properties.sound_usage=structuredClone(soundUsageSchema);decision.required.push('sound_usage');
      request.prompt+='\n'+soundEventFunctionPrompt;
    }
    if(sfx_diagnostic_policy!==undefined&&eligible.length){
      request.sfx_diagnostic_selection_policy=await bindDiagnosticSfxSelectionPolicy(sfx_diagnostic_policy,{
        projection:sfx_material_selection_projection,sourceSha:story.source_video_sha256,tasks:eligible,outputDirectory:out,
        eventFunctionRevision:sfx_event_function_revision});
      request.prompt=diagnosticSfxSelectionPromptFor(sfx_event_function_revision);
    }
  }
  if (preceding_arc && eligible.length) request = await attachPrecedingArcContext(request, {
    handoff: preceding_arc, currentCase: caseSource });
  if(observationOnly){
    if(resume_existing_request||preceding_arc||!sfx_material_selection_projection||!sfx_event_function_revision
      ||eligible.some(task=>!['dramatic','transition'].includes(task.sound_role)||task.kind!=='sfx'))
      throw Error('assembly_sfx_observed_pool_scope_required');
    const input=await saveJson(path.join(out,'candidate-observation-input.json'),request);
    const record={schema_version:1,kind:'observed_material_candidates_pending_final_assembly',
      candidate_source:source,case_source:caseSource,input,source_video_sha256:request.source_video_sha256,
      tasks:eligible,observations:[...observationCache.values()],observation_files:observedFiles,
      visual_files:visual.files,gaps,selected_count:0,automatic_selection_performed:false,
      actual_asset_selection_performed:false,artistic_approval:false,production_approval:false};
    return {...record,artifact:await saveJson(path.join(out,'candidate-observation-record.json'),record)};
  }
  const input = recovery ? verifyRebuiltMaterialComparison(recovery, request)
    : await saveJson(path.join(out, 'selection-request.json'), request);
  const record = { schema_version: 1, status: 'material_comparison_pending', candidate_source: source, case_source: caseSource,
    input, observation_files: observedFiles, visual_files: visual.files,
    submitted_frame_count:sfx_material_selection_projection?0:visual.frames.length,
    ...(sfx_material_selection_projection?{source_frame_binding_count:visual.frames.length}:{}),
    selected_count: 0, automatic_selection_performed: false,
    artistic_approval: false, production_approval: false, gaps };
  if (!eligible.length || typeof runtime.materialSelector !== 'function') {
    if (eligible.length) record.gaps.push({ gap: 'material_selector_runtime_missing' });
    await saveJson(path.join(out, 'selection-record.json'), record);
    return record;
  }
  if (!runtime.materialSelector_backend_id?.trim()) throw new Error('material_selector_backend_identity_required');
  const response = await runtime.materialSelector(projectFlatMaterialObservations({ ...request, input }), out);
  if (await hashFile(source.path) !== source.sha256 || await hashFile(caseSource.path) !== caseSource.sha256
    || await hashFile(input.path) !== input.sha256) throw new Error('material_selection_input_changed');
  await verifyEvidenceBindings(observedFiles);
  await verifyEvidenceBindings([visual.frames, visual.files]);
  if(request.completed_target_story)await verifyEvidenceBindings(request.completed_target_story.analysis);
  if(request.sfx_diagnostic_selection_policy)await verifyEvidenceBindings(request.sfx_diagnostic_selection_policy.host_authorization);
  await verifyEvidenceBindings(request.preceding_arc_context);
  if (response.input_sha256 !== input.sha256 || response.actual_input_processed !== true || !response.model
    || !response.raw_response?.path || await hashFile(response.raw_response.path) !== response.raw_response.sha256)
    throw new Error('material_selection_response_binding_required');
  const raw = await readJson(response.raw_response.path);
  if (raw.input_sha256 !== input.sha256 || raw.model !== response.model || !same(raw.value, response.value))
    throw new Error('material_selection_raw_result_mismatch');
  const value = validateSchema(response.value, request.response_schema);
  const tasks = new Map(eligible.map(task => [key(task), task])), seen = new Set(), mappings = new Map();
  for (const decision of value.decisions) {
    const taskKey = key(decision), task = tasks.get(taskKey);
    if (!task || seen.has(taskKey)) throw new Error('material_decision_unknown_or_duplicate_task');
    seen.add(taskKey);
    const candidateIds = new Set(task.candidates.map(row => row.segment_id));
    const selected = new Set(decision.selected_segment_ids), rejected = new Set(decision.rejections.map(row => row.segment_id));
    if (selected.size !== decision.selected_segment_ids.length || rejected.size !== decision.rejections.length
      || [...selected, ...rejected].some(id => !candidateIds.has(id))
      || [...selected].some(id => rejected.has(id)) || decision.rejections.some(row => !row.reason.trim())
      || selected.size && !decision.adopt_reason.trim()
      || candidateIds.size !== selected.size + rejected.size || !selected.size && !decision.unresolved_gaps.length)
      throw new Error('material_decision_incomplete_or_unbound');
    const sources = new Set(task.candidates.filter(row => selected.has(row.segment_id)).map(row => row.source_sha256));
    if (sources.size > 5) throw new Error('material_selected_recording_limit_exceeded');
    const usageGap=sfx_event_function_revision?validateSelectedSoundUsage(decision,task):null;
    if(usageGap)record.gaps.push({case_id:task.case_id,step_id:task.step_id,...usageGap,
      sound_usage:decision.sound_usage,qualification_granted:false});
    const original = document.tasks.find(row => row.case_id === task.case_id && row.step_id === task.step_id
      && row.attempts[0]?.query.asset_kind === task.kind
      && (row.candidates[0]?.binding.sounds[0]?.sound_role ?? null) === task.sound_role);
    for (const id of selected) {
      const candidate = original.candidates.find(row => row.candidate.segment_id === id);
      const frozen = structuredClone(candidate.binding), observation = observationCache.get(JSON.stringify([
        candidate.candidate.source_sha256, candidate.candidate.source_range,
        candidate.observation_contexts ?? null, candidate.human_context_review?.sha256 ?? null]));
      const mapping = mappings.get(task.case_id) ?? { ...frozen, music: [], sounds: [], evidence_files: [] };
      mapping.evidence_files.push(...frozen.evidence_files, ...observation.files, ...visual.files,
        ...visual.frames.filter(frame => frame.case_ids.includes(task.case_id)), input, response.raw_response);
      if (request.preceding_arc_context) mapping.evidence_files.push(...[
        request.preceding_arc_context.handoff, request.preceding_arc_context.case_input,
        request.preceding_arc_context.selection, request.preceding_arc_context.bound_materials,
        request.preceding_arc_context.selection_input, request.preceding_arc_context.selection_raw_response,
        request.preceding_arc_context.selected_bindings,
        ...request.preceding_arc_context.alternatives.map(row => row.observation_record) ]);
      for (const field of ['music', 'sounds']) for (const item of frozen[field]) {
        item.reason = decision.adopt_reason;
        if(field==='sounds'&&sfx_event_function_revision){
          item.sound_function_intent=structuredClone(task.sound_function_intent);
          item.sound_usage=structuredClone(decision.sound_usage);
          item.selection_source_ranges=[structuredClone(decision.sound_usage.usable_source_range)];
        }
        // Independent qualification/publish gates remain responsible for observed and approved status.
        item.status = 'research';
        item.listening_evidence = { ...observation, actual_audio_processed: true, observations: observation.observations };
        if (!mapping[field].some(row => row.step_id === item.step_id && row.segment_id === item.segment_id)) mapping[field].push(item);
      }
      mappings.set(task.case_id, mapping);
      record.selected_count++;
    }
    record.gaps.push(...decision.unresolved_gaps.map(gap => ({ case_id: task.case_id, step_id: task.step_id, gap })));
  }
  if (seen.size !== tasks.size) throw new Error('material_decisions_missing_tasks');
  for (const mapping of mappings.values()) mapping.evidence_files = [...new Map(mapping.evidence_files.map(file =>
    [JSON.stringify(file), file])).values()];
  record.bindings_file = record.selected_count ? await saveJson(path.join(out, 'selected-bindings.json'), {
    schema_version: 1, bindings: [...mappings.values()], source, case_source: caseSource, input,
    raw_response: response.raw_response, artistic_approval: false, production_approval: false }) : null;
  record.raw_response = response.raw_response;
  record.cli_receipts = response.cli_receipts ?? [];
  await verifyEvidenceBindings(record.cli_receipts);
  record.automatic_selection_performed = true;
  record.status = record.selected_count ? 'research_materials_selected_pending_independent_review' : 'material_selection_gap';
  await saveJson(path.join(out, 'selection-record.json'), record);
  return record;
}
