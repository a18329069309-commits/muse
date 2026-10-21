import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiSession, readJson, saveJson as writeNewJson, verifyEvidenceBindings, validateSchema, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { prepareEpisode } from './prepare_episode.mjs';
import { bindPreparedEpisode } from './distill_episode.mjs';
import { prepareAnalysisRequest, validateAnalysisResponse, directorResponseSchema } from './analysis_bridge.mjs';
import { HostFileSession, HostResponsePendingError } from './host_runtime.mjs';
import { loadTargetStoryCheckpoint } from './target_story_checkpoint.mjs';
import { prepareLocalResearchEvidence } from './local_research_evidence.mjs';
import { captureLocalResearchDependencies, createLocalResearchCheckpoint, restoreLocalResearchCheckpoint } from './research_story_resume.mjs';
import {inspectLocalResearchExecution} from './local_research_execution.mjs';

const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function saveJson(file, value) {
  try { return await writeNewJson(file, value); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!same(await readJson(file), value)) throw Error('target_analysis_saved_evidence_changed');
    return binding(file);
  }
}
const validBinding = value => path.isAbsolute(value?.path ?? '') && /^[a-f0-9]{64}$/.test(value.sha256 ?? '');
const readBound = async value => {
  if (!validBinding(value)) throw Error('target_analysis_explicit_binding_required');
  await verifyEvidenceBindings(value); return readJson(value.path);
};

async function sourceAndPreparation(config, output,executionContext) {
  await inspectLocalResearchExecution(executionContext,'target_source_preparation_io');
  const supplied = config.prepared_manifest_binding;
  if (supplied) {
    if (!validBinding(supplied.manifest) || !validBinding(supplied.source) || !validBinding(supplied.audio)
      || !Array.isArray(supplied.frames) || !supplied.frames.length || supplied.frames.some(row => !validBinding(row)))
      throw Error('target_analysis_full_prepared_binding_required');
    await verifyEvidenceBindings(supplied);
  }
  const sourcePath = typeof config.video === 'string' ? config.video : config.video?.path
    ?? supplied?.source.path;
  if (!path.isAbsolute(sourcePath ?? '')) throw Error('target_analysis_actual_absolute_video_required');
  const source = await binding(sourcePath);
  const declared = [config.source_video_sha256, config.target_source_sha256, config.source_sha256,
    config.source_video?.sha256, config.video?.sha256,
    supplied?.source.sha256].filter(value => value !== undefined);
  if (declared.some(value => value !== source.sha256)) throw Error('target_analysis_source_hash_mismatch');
  for (const value of [config.source_video, config.source_video?.path].filter(value => typeof value === 'string')) {
    if (!path.isAbsolute(value) || await hashFile(value) !== source.sha256) throw Error('target_analysis_caller_source_mismatch');
  }
  if (supplied) {
    const actual = await bindPreparedEpisode(supplied.manifest.path);
    if (!same(actual, supplied) || actual.source.sha256 !== source.sha256)
      throw Error('target_analysis_prepared_source_mismatch');
    const manifest=await readJson(actual.manifest.path);
    await inspectLocalResearchExecution(executionContext,'target_prepared_binding_io_complete');
    return { source, prepared: actual, manifest, reused: true };
  }
  const media = path.join(output, 'media');
  await prepareEpisode({ video: source.path, out: media, step: config.visual_sampling_step ?? 2,...executionContext });
  const prepared = await bindPreparedEpisode(path.join(media, 'manifest.json'));
  if (prepared.source.sha256 !== source.sha256) throw Error('target_analysis_source_changed_during_preparation');
  const manifest=await readJson(prepared.manifest.path);
  await inspectLocalResearchExecution(executionContext,'target_preparation_io_complete');
  return { source, prepared, manifest, reused: false };
}

function deriveNeeds(analysis, duration) {
  const unknowns = [];
  if (analysis.original_audio.kind === 'unknown') unknowns.push({ area: 'original_audio', target_range: [0, duration],
    reason: analysis.original_audio.observation, status: 'unverified' });
  const marker = /unknown|未知|待核|不确定/i;
  for (const beat of analysis.story_beats) {
    for (const field of ['perspective', 'control_change', 'sound_decision']) if (marker.test(beat[field]))
      unknowns.push({ area: field, story_beat_id: beat.id, target_range: [beat.start_seconds, beat.end_seconds], reason: beat[field] });
  }
  for (const event of analysis.sound_events) if (marker.test(event.reason)) unknowns.push({ area: 'sound_event',
    event_id: event.id, target_range: [event.start_seconds, event.end_seconds], reason: event.reason });
  for (const reason of analysis.uncertainties) unknowns.push({ area: 'analysis', target_range: null,
    reason, range_status: 'not_supplied; do not infer a whole-film blocker' });
  return { unknowns, material_needs: {
    music: analysis.story_beats.map(beat => ({ story_beat_id: beat.id,
      target_range: [beat.start_seconds, beat.end_seconds], perspective: beat.perspective,
      expectation_before: beat.expectation_before, expectation_after: beat.expectation_after,
      new_information: beat.new_information, control_change: beat.control_change,
      sound_goal: beat.sound_decision, evidence_ids: beat.evidence_ids,
      source_recording_identity: 'not_selected', status: 'needs_target_material_matching' })),
    words: { request: analysis.style_direction.words_use, language_constraint: 'not_inferred',
      source_phrase: null, status: 'needs_actual_phrase_evidence_if_required' },
    sounds: analysis.sound_events.map(event => ({ event_id: event.id, role: event.role,
      target_range: [event.start_seconds, event.end_seconds], decision: event.decision, reason: event.reason,
      evidence_ids: event.evidence_ids, original_presence: 'not_approved_by_analysis',
      status: event.decision === 'seek_asset' ? 'needs_actual_asset' : 'needs_source_facts_for_final_decision' })),
    timing_assessment: 'story/event model estimates; not verified sound sync anchors',
  } };
}

// Existing offline ASR/VAD is a separate actual stage. Its predictions grant no hearing or mix qualification.
async function targetLocalAudio(config, prepared, out, runtime,executionContext) {
  if (!config.local_audio_analysis) return null;
  if (runtime.localAudioStages && runtime.execution_kind !== 'injected_test_transport')
    throw Error('target_local_audio_stage_overrides_test_only');
  const stages = { capture: captureLocalResearchDependencies, prepare: prepareLocalResearchEvidence,
    createCheckpoint: createLocalResearchCheckpoint, restoreCheckpoint: restoreLocalResearchCheckpoint,
    ...(runtime.localAudioStages ?? {}) };
  const options = config.local_audio_analysis, python = config.local_audio_python ?? config.python;
  const manifestPath = prepared.prepared.manifest.path, directory = path.join(out, 'local-audio');
  const checkpoint = config.local_audio_checkpoint ?? config.resume?.local_audio_checkpoint;
  let local, checkpointRef;
  if (checkpoint) {
    local = await stages.restoreCheckpoint({ checkpoint, options, python, manifestPath },executionContext);
    checkpointRef = local.checkpoint;
  } else {
    const before = await stages.capture({ options, python, manifestPath },executionContext);
    local = await stages.prepare({ options, python, manifestPath, outputDirectory: directory, dependencies: before },executionContext);
    checkpointRef = await stages.createCheckpoint({ before, local, options, python, manifestPath, outputDirectory: directory },executionContext);
  }
  await verifyEvidenceBindings([local.receipt, checkpointRef]);
  const receipt = await readJson(local.receipt.path), base = path.dirname(manifestPath), observationFiles = [];
  const originalAudio = await binding(path.resolve(base, prepared.manifest.original_audio));
  const analysisAudio = await binding(path.resolve(base, prepared.manifest.analysis_audio));
  if (receipt.source_video_sha256 !== prepared.source.sha256 || receipt.original_audio_sha256 !== originalAudio.sha256
    || receipt.analysis_audio_sha256 !== analysisAudio.sha256 || receipt.sound_facts_qualified !== false
    || !same(receipt.dialogue_intervals, local.dialogueIntervals) || !same(receipt.observation_files, local.observationFiles))
    throw Error('target_local_audio_receipt_identity_changed');
  const report = await binding(path.join(path.dirname(local.receipt.path), 'raw/analysis-report.json'));
  const originalManifest = (await readJson(checkpointRef.path)).manifest;
  for (const [index, file] of local.observationFiles.entries()) {
    const original = await binding(file), value = await readJson(file);
    const wrapper = await saveJson(path.join(out, `local-audio-bridge-${String(index + 1).padStart(3, '0')}.json`), {
      schema_version: 1, protocol: 'local_research_audio_prediction', source_video_sha256: prepared.source.sha256,
      source_sha256: analysisAudio.sha256, source_range: value.source_range,
      actual_audio_processed: true, actual_audio_listened: false, sound_facts_qualified: false,
      qualified: false, qualification_granted: false,
      original_audio_kind: 'unknown', model: 'SenseVoiceSmall+silero-vad', request_id: shaBytes(JSON.stringify([local.receipt, original])),
      observation: { transcription_prediction: value.transcription_prediction, transcription_verified: false,
        dialogue_activity_prediction: value.dialogue_activity_prediction, dialogue_activity_verified: false,
        timestamp_precision: value.timestamp_precision, sound_facts_qualified: false, original_audio_kind: 'unknown' },
      local_research_evidence: { receipt: local.receipt, observation: original, report,
        transcript: receipt.raw_references[0], activity: receipt.raw_references[1], original_audio: originalAudio, analysis_audio: analysisAudio,
        original_manifest: originalManifest, current_manifest: prepared.prepared.manifest },
      artistic_approval: false, production_approval: false });
    observationFiles.push(wrapper);
  }
  return { receipt: local.receipt, checkpoint: checkpointRef,
    observation_files: await Promise.all(local.observationFiles.map(binding)), bridge_observation_files: observationFiles,
    dialogue_intervals: local.dialogueIntervals, reused: local.reused === true,
    sound_facts_qualified: false, qualified: false, qualification_granted: false, production_approval: false,
    dialogue_activity_verified: false, actual_audio_listened: false,
    new_inference_calls: local.reused === true ? 0 : null,
    execution_kind: runtime.execution_kind === 'injected_test_transport' ? 'injected_test_transport' : 'existing_local_cpu_analysis' };
}

// This entry only prepares and analyzes a bound target. It cannot select, approve or render materials.
export async function analyzeTarget(config, runtime = {}) {
  if (config?.visual_sampling_step !== undefined && (!Number.isFinite(config.visual_sampling_step)
    || config.visual_sampling_step < 0.1 || config.visual_sampling_step > 10)) throw Error('compose_config_invalid');
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? '')) throw Error('target_analysis_config_invalid');
  const out = path.resolve(config.output_dir);
  const trialBudget=runtime.session?.trialBudget??runtime.trialBudget??await runtime.ensureBudget?.({config});
  runtime={...runtime,trialBudget};
  const executionContext={trialBudget,ownedProcessPython:config.python,
    ...(runtime.analysisPreparationRecovery?{analysisPreparationRecovery:runtime.analysisPreparationRecovery}:{})};
  const admission=await inspectLocalResearchExecution(executionContext,'target_analysis_preparation_admission');
  if(admission)executionContext.deadlineAtMs=admission.deadlineAtMs;
  const prepared = await sourceAndPreparation(config, out,executionContext);
  await mkdir(out, { recursive: true });
  const localAudio = await targetLocalAudio(config, prepared, out, runtime,executionContext);
  await inspectLocalResearchExecution(executionContext,'target_local_audio_bridge_io_complete');
  const localFields = { ...(localAudio ? { local_audio_evidence: localAudio, local_audio_checkpoint: localAudio.checkpoint } : {}),
    ...(config.dialogue_intervals !== undefined ? { dialogue_intervals: config.dialogue_intervals }
      : localAudio ? { dialogue_intervals: localAudio.dialogue_intervals } : {}) };
  if (config.story_checkpoint) {
    const reused = await loadTargetStoryCheckpoint(config.story_checkpoint, prepared,
      { injected: runtime.execution_kind === 'injected_test_transport' });
    const analysis = await saveJson(path.join(out, 'analysis-reused.json'), reused.value);
    const analysisRequest = await saveJson(path.join(out, 'analysis-request-reused.json'), reused.request);
    const check = await saveJson(path.join(out, 'analysis-check-reused.json'), reused.check);
    const needs = deriveNeeds(reused.value, reused.request.timeline.duration_samples / 48000);
    const record = { schema_version: 2, kind: 'target_analysis', analysis_only: true,
      status: needs.unknowns.length ? 'target_analysis_available_with_unknowns' : 'target_analysis_available',
      source_video_sha256: prepared.source.sha256, target_source_sha256: prepared.source.sha256,
      source_video: prepared.source, manifest: prepared.prepared.manifest,
      prepared_manifest_binding: prepared.prepared, preparation_reused: prepared.reused,
      analysis, analysis_request: analysisRequest, analysis_check: check,
      raw_response: config.story_checkpoint.raw_response, director_input: config.story_checkpoint.original_request,
      source_contract_schema_version: reused.request.schema_version, timeline: reused.request.timeline,
      story_reused: true, actual_analysis_performed: false, historical_analysis_reused: true,
      execution_kind: reused.execution_kind, execution: { reused_bindings: reused.bindings,
        request: config.story_checkpoint.original_request, response: config.story_checkpoint.raw_response },
      new_director_calls: 0, model_calls: 0, cloud_uploads: 0, render_calls: 0, generation_calls: 0,
      new_paid_calls: 0, actual_audio_listened: false, source_budget_evaluated: false,
      material_approval: false, target_release_granted: false, Ready: false,
      ...needs, ...localFields, next_action: 'match_target_materials_from_verified_reused_story; never replay completed story' };
    record.artifact = await saveJson(path.join(out, 'target-analysis.json'), record); return record;
  }
  const observationFiles = [...(config.observation_files ?? []), ...(localAudio?.bridge_observation_files ?? []).map(row => row.path)];
  const useAudio = Boolean(observationFiles.length);
  const requestConfig = await saveJson(path.join(out, 'analysis-config.json'), {
    schema_version: useAudio ? 2 : 1, manifest: prepared.prepared.manifest.path,
    craft_mode: config.craft_mode ?? 'fine', music_words_policy: config.music_words_policy ?? 'prefer',
    input_mode: useAudio ? 'frames_and_observations' : 'frames_only', knowledge_files: config.knowledge_files ?? [],
    ...(useAudio ? { observation_files: observationFiles } : {}),
  });
  const request = runtime.reuseAnalysisRequest
    ? await readBound(runtime.reuseAnalysisRequest.request)
    : await prepareAnalysisRequest(requestConfig.path, path.join(out, 'analysis'), {
      allowUnqualifiedLocalResearch: Boolean(localAudio) });
  const analysisRequest = await binding(path.join(out, 'analysis/request.json'));
  const baseRecord = { schema_version: 2, kind: 'target_analysis', analysis_only: true,
    source_video_sha256: prepared.source.sha256, target_source_sha256: prepared.source.sha256,
    source_video: prepared.source, manifest: prepared.prepared.manifest,
    prepared_manifest_binding: prepared.prepared, preparation_reused: prepared.reused,
    analysis_request: analysisRequest, timeline: request.timeline,
    source_contract_schema_version: request.schema_version, Ready: false,
    material_approval: false, source_budget_evaluated: false, target_release_granted: false,
    actual_audio_listened: false, render_calls: 0, generation_calls: 0, new_paid_calls: 0,
    ...localFields,
  };
  let session = runtime.session;
  if (session && runtime.createSession) throw Error('target_analysis_one_session_required');
  if (!session && runtime.createSession) session = await runtime.createSession({ config, source: prepared.source,
    media: [prepared.source], directory: path.join(out, 'host') });
  if (session && !(session instanceof HostFileSession) && !(session instanceof ApiSession))
    throw Error('target_analysis_existing_host_or_api_session_required');
  const apiSession = session instanceof ApiSession;
  const ledgerStart = session?.ledger?.length ?? 0;
  const injected = runtime.execution_kind === 'injected_test_transport';
  if (!session && runtime.director && (!injected || !runtime.director_backend_id))
    throw Error('target_analysis_real_host_session_or_explicit_test_transport_required');
  if (!session && !runtime.director) {
    const record = { ...baseRecord, status: 'target_analysis_director_pending', analysis: null,
      actual_analysis_performed: false, model_calls: 0, cloud_uploads: 0,
      unknowns: [{ area: 'analysis', target_range: null, reason: 'actual bound host director not supplied' }],
      material_needs: null, next_action: 'provide_existing_host_session_then_analyze_bound_target' };
    record.artifact = await saveJson(path.join(out, 'target-analysis.json'), record); return record;
  }
  const audioObservations = useAudio ? await Promise.all(observationFiles.map(readJson)) : [];
  const input = { source_video: prepared.source,
    prompt: await readFile(request.bindings.find(row => row.kind === 'prompt').path, 'utf8'),
    data: { schema_version: request.schema_version, request_id: request.request_id,
      source_video_sha256: request.source_video_sha256, timeline: request.timeline, controls: request.controls,
      instructions: request.instructions, evidence_catalog: request.evidence_catalog,
      knowledge: await Promise.all(request.bindings.filter(row => row.kind === 'knowledge').map(async row => ({
        id: row.id, source_label: row.source_label, text: await readFile(row.path, 'utf8') }))),
      ...(useAudio && !localAudio ? { audio_observations: audioObservations } : {}),
      ...(localAudio ? { unqualified_research_observations: await Promise.all(audioObservations.map(async (value, index) => ({
        binding: await binding(observationFiles[index]), value, sound_facts_qualified: value.sound_facts_qualified ?? false }))) } : {}),
    }, frames: request.bindings.filter(row => row.kind === 'frame').map(row => ({ ...row,
      timeline_seconds: request.evidence_catalog.find(item => item.id === row.id).timeline_seconds })),
    input: analysisRequest, schema: directorResponseSchema(request.schema_version), stage: 'research_story_director' };
  const executionInput = await saveJson(path.join(out, 'director-input.json'), input);
  if (runtime.reuseAnalysisRequest) {
    const priorInput = await readBound(runtime.reuseAnalysisRequest.director_input);
    if (!same(priorInput, input)) throw Error('target_partial_analysis_input_changed');
  }
  let response;
  try { response = await (session ? session.director(input) : runtime.director(input)); }
  catch (error) {
    if (!(error instanceof HostResponsePendingError)) throw error;
    const record = { ...baseRecord, status: 'target_analysis_director_pending', analysis: null,
      director_input: executionInput, host_request: await binding(error.request_file),
      actual_analysis_performed: false, model_calls: 0, cloud_uploads: 0,
      unknowns: [{ area: 'analysis', target_range: null, reason: 'host_response_pending' }], material_needs: null };
    record.artifact = await saveJson(path.join(out, 'target-analysis.json'), record); return record;
  }
  if ((!apiSession && response.actual_input_processed !== true) || !response.model || !validBinding(response.raw_response))
    throw Error('target_analysis_actual_response_evidence_required');
  const raw = await readBound(response.raw_response);
  if (apiSession) {
    const receipt = session.ledger.slice(ledgerStart).find(row => row.response?.sha256 === response.raw_response.sha256);
    if (!receipt || receipt.provider !== 'openai' || receipt.stage !== input.stage || receipt.status !== 'completed'
      || receipt.request_id !== response.request_id || receipt.model !== response.model
      || raw.status !== 'completed' || raw.id !== response.request_id)
      throw Error('target_analysis_completed_api_receipt_required');
    const text = raw.output?.flatMap(row => row.content ?? []).filter(row => ['text', 'output_text'].includes(row.type))
      .map(row => row.text).join('');
    if (!text?.trim() || !same(JSON.parse(text), response.value)) throw Error('target_analysis_raw_response_mismatch');
  } else if (!same(raw.value, response.value)) throw Error('target_analysis_raw_response_mismatch');
  validateSchema(response.value, directorResponseSchema(request.schema_version));
  if (useAudio && (audioObservations.every(row => row.sound_facts_qualified === false)
    || localAudio && !audioObservations.some(row => row.sound_facts_qualified === true))
    && response.value.original_audio.kind !== 'unknown') throw Error('target_analysis_unqualified_audio_mix_must_remain_unknown');
  const analysis = await saveJson(path.join(out, 'analysis/result.json'), response.value);
  const check = await validateAnalysisResponse(analysisRequest.path, analysis.path);
  await saveJson(path.join(out, 'analysis/check.json'), check);
  if (!check.structure_valid) throw Error('target_analysis_response_contract_invalid:' + check.issues.join(','));
  await verifyEvidenceBindings(prepared.prepared);
  await verifyEvidenceBindings(request.bindings);
  if (await hashFile(prepared.source.path) !== prepared.source.sha256) throw Error('target_analysis_source_changed');
  const needs = deriveNeeds(response.value, request.timeline.duration_samples / 48000);
  const record = { ...baseRecord, status: check.coverage_gaps.length ? 'target_analysis_partial'
    : needs.unknowns.length ? 'target_analysis_available_with_unknowns' : 'target_analysis_available',
    analysis, analysis_check: await binding(path.join(out, 'analysis/check.json')),
    raw_response: response.raw_response, director_input: executionInput,
    execution_kind: injected ? 'injected_test_transport' : apiSession ? 'api_director_completed' : response.execution_kind,
    actual_analysis_performed: !injected, story_reused: false,
    execution: { request: executionInput, response: response.raw_response,
      accounting_ledger: session?.accountingLedger ?? session?.ledger ?? [], injected_test_transport: injected },
    model_calls: injected || session?.backend_kind === 'codex_host_file' ? 0 : apiSession ? session.ledger.length - ledgerStart : null,
    cloud_uploads: injected || session?.backend_kind === 'codex_host_file' ? 0 : apiSession ? session.ledger.length - ledgerStart : null,
    new_paid_calls: injected || !apiSession ? 0 : session.ledger.length - ledgerStart,
    coverage_gaps: check.coverage_gaps, ...needs,
    next_action: 'match_target_materials_using_bound_analysis_and_keep_local_unknowns' };
  record.artifact = await saveJson(path.join(out, 'target-analysis.json'), record); return record;
}

// Continue the exact bound request after a partition capacity stop. Completed CLI
// partitions remain in their original host cache; request IDs are never rewritten.
export async function resumePartialTargetAnalysis(config, runtime, { directory }) {
  const executionContext={trialBudget:runtime.session?.trialBudget??runtime.trialBudget,ownedProcessPython:config.python};
  await inspectLocalResearchExecution(executionContext,'target_analysis_reuse_io_admission');
  const prior = path.resolve(directory), sourcePath = config.video?.path ?? config.video;
  if (!path.isAbsolute(sourcePath ?? '')) throw Error('target_partial_analysis_source_required');
  const prepared = await bindPreparedEpisode(path.join(prior, 'media/manifest.json'));
  const requestBinding = await binding(path.join(prior, 'analysis/request.json'));
  const inputBinding = await binding(path.join(prior, 'director-input.json'));
  const request = await readBound(requestBinding), input = await readBound(inputBinding);
  await verifyEvidenceBindings([prepared, request.bindings, input]);
  if (prepared.source.sha256 !== await hashFile(sourcePath)
    || request.source_video_sha256 !== prepared.source.sha256
    || input.data?.source_video_sha256 !== prepared.source.sha256
    || input.data?.request_id !== request.request_id
    || request.controls?.craft_mode !== (config.craft_mode ?? 'fine')
    || request.controls?.music_words_policy !== (config.music_words_policy ?? 'prefer'))
    throw Error('target_partial_analysis_identity_changed');
  const checkpoint = config.local_audio_analysis
    ? await binding(path.join(prior, 'local-audio/dependency-checkpoint.json')) : null;
  await inspectLocalResearchExecution(executionContext,'target_analysis_reuse_io_complete');
  const result = await analyzeTarget({ ...config, output_dir: prior, prepared_manifest_binding: prepared,
    ...(checkpoint ? { local_audio_checkpoint: checkpoint } : {}) }, { ...runtime,
    reuseAnalysisRequest: { request: requestBinding, director_input: inputBinding } });
  return { ...result, partial_analysis_recovery: { request: requestBinding, director_input: inputBinding,
    original_host_directory: path.join(prior, 'host'), request_id_rewritten: false,
    completed_partition_cache_preserved: true, production_approval: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('usage: node analyze_target.mjs CONFIG.json');
    const result = await analyzeTarget(await readJson(process.argv[2]));
    console.log(JSON.stringify({ status: result.status, artifact: result.artifact, Ready: false, render_calls: 0 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
