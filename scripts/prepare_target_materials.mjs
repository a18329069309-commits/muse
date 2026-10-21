import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostFileSession, HostResponsePendingError } from './host_runtime.mjs';
import { ApiSession, readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { bindPreparedEpisode } from './distill_episode.mjs';
import { researchDirection, caseSourceFormatOptions } from './compose_episode.mjs';
import { completeAssistedTrial } from './assisted_episode.mjs';
import { prepareResearchTrial } from './render_research_trial.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export async function readTargetAnalysis(binding, config = {}) {
  await verifyEvidenceBindings(binding);
  const target = await readJson(binding.path);
  if (target.kind !== 'target_analysis' || target.schema_version !== 2 || target.analysis_only !== true
    || !target.analysis || !target.analysis_request || !target.manifest || !target.raw_response
    || !['target_analysis_available', 'target_analysis_available_with_unknowns'].includes(target.status))
    throw new Error('completed_target_analysis_required_for_material_preparation');
  await verifyEvidenceBindings([target.source_video, target.analysis, target.analysis_request, target.manifest, target.raw_response]);
  const manifest = await readJson(target.manifest.path), analysis = await readJson(target.analysis.path);
  const request = await readJson(target.analysis_request.path);
  const raw = await readJson(target.raw_response.path);
  let originalValue = raw.value;
  if (originalValue === undefined && (raw.response || raw.output)) {
    const provider = raw.response ?? raw;
    if (provider.status !== 'completed') throw new Error('target_analysis_completed_raw_response_required');
    const text = provider.output_text ?? provider.output?.flatMap(row => row.content ?? [])
      .filter(row => ['text', 'output_text'].includes(row.type)).map(row => row.text).join('');
    if (text?.trim()) originalValue = JSON.parse(text);
  }
  if (JSON.stringify(canonical(originalValue)) !== JSON.stringify(canonical(analysis)))
    throw new Error('target_analysis_raw_response_mismatch');
  if (raw.execution_kind === 'deterministic_merge_of_bound_story_responses') {
    if (raw.facts_rewritten !== false || !raw.constituent_responses?.length || !raw.frame_mapping)
      throw new Error('target_analysis_bound_cli_history_required');
    await verifyEvidenceBindings([raw.frame_mapping, ...raw.constituent_responses]);
  }
  if (target.source_video_sha256 !== target.source_video.sha256 || manifest.source_sha256 !== target.source_video_sha256
    || analysis.source_video_sha256 !== target.source_video_sha256 || request.source_video_sha256 !== target.source_video_sha256
    || manifest.timeline?.duration_samples !== request.timeline?.duration_samples
    || manifest.timeline?.sample_rate !== 48000 || request.timeline?.sample_rate !== 48000
    || request.timeline?.zero_point !== 'first_visible_video_frame'
    || !Number.isFinite(manifest.video?.first_pts_seconds)
    || request.timeline?.source_first_pts_seconds !== manifest.video.first_pts_seconds)
    throw new Error('target_analysis_source_or_clock_mismatch');
  const declared = [config.source_video_sha256, config.target_source_sha256, config.source_sha256,
    config.source_video?.sha256, config.video?.sha256, config.prepared_manifest_binding?.source?.sha256]
    .filter(value => value !== undefined);
  if (declared.some(value => value !== target.source_video_sha256))
    throw new Error('target_material_caller_source_hash_mismatch');
  const callerVideos = [config.video?.path ?? config.video, config.source_video?.path ?? config.source_video]
    .filter(value => value !== undefined);
  for (const callerVideo of callerVideos) {
    if (typeof callerVideo !== 'string' || !path.isAbsolute(callerVideo)
      || await hashFile(callerVideo) !== target.source_video_sha256)
      throw new Error('target_material_caller_video_mismatch');
  }
  if (config.prepared_manifest_binding) {
    await verifyEvidenceBindings(config.prepared_manifest_binding);
    if (config.prepared_manifest_binding.manifest?.sha256 !== target.manifest.sha256)
      throw new Error('target_material_caller_preparation_mismatch');
  }
  if (config.manifest) {
    const supplied = typeof config.manifest === 'string' ? config.manifest : config.manifest.path;
    if (config.manifest.sha256) await verifyEvidenceBindings(config.manifest);
    const caller = await readJson(supplied);
    if (caller.source_sha256 !== target.source_video_sha256 || caller.timeline?.duration_samples !== manifest.timeline.duration_samples)
      throw new Error('target_material_caller_manifest_mismatch');
  }
  if (request.bindings) await verifyEvidenceBindings(request.bindings);
  return { target, manifest, analysis, request, binding };
}

// Select and compile reviewed materials, but never mix audio or release a target.
export async function prepareTargetMaterials(config, analysisBinding, runtime = {}) {
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? ''))
    throw new Error('target_material_config_invalid');
  const data = await readTargetAnalysis(analysisBinding, config);
  const out = path.resolve(config.output_dir); await mkdir(out, { recursive: false });
  const record = { schema_version: 1, kind: 'target_material_preparation', target_analysis: analysisBinding,
    source_video_sha256: data.target.source_video_sha256, stages: [], model_calls: 0,
    cloud_uploads: 0, render_calls: 0, generation_calls: 0, previews_created: 0,
    actual_material_consumer_verified: false, Ready: false, production_approval: false };
  let session = runtime.session;
  const initialLedgerLength = session?.accountingLedger?.length ?? session?.ledger?.length ?? 0;
  const finish = async value => {
    Object.assign(record, value);
    const calls = (session?.accountingLedger ?? session?.ledger ?? []).slice(initialLedgerLength);
    const count = field => calls.every(row => row.provider || Number.isInteger(row[field]))
      ? calls.reduce((sum, row) => sum + (row.provider ? 1 : row[field]), 0) : null;
    record.model_calls = runtime.execution_kind === 'injected_test_transport' ? 0 : count('model_calls');
    record.cloud_uploads = runtime.execution_kind === 'injected_test_transport' ? 0 : count('cloud_uploads');
    record.accounting_ledger = calls;
    record.artifact = await saveJson(path.join(out, 'target-material-preparation.json'), record);
    return record;
  };
  if (!config.cases?.db || !config.library?.db) return finish({ status: 'target_material_gap',
    unresolved: [!config.cases?.db && 'frozen_reference_cases_required', !config.library?.db && 'frozen_library_required'].filter(Boolean),
    material_needs: data.target.material_needs, next_action: 'prepare_only_missing_reference_packages' });
  const sourceFormatOptions = await caseSourceFormatOptions(config.cases);
  if (session && runtime.createSession) throw new Error('target_material_one_session_required');
  if (!session && runtime.createSession) session = await runtime.createSession({ config,
    directory: path.join(out, 'host'), media: [data.target.source_video], source: data.target.source_video });
  if (!(session instanceof HostFileSession) && !(session instanceof ApiSession))
    return finish({ status: 'target_material_director_pending', unresolved: ['actual_host_or_api_session_required'],
      material_needs: data.target.material_needs, next_action: 'consume_analysis_with_existing_director_session' });
  const stage = async (name, action) => {
    const row = { name, status: 'running' }, start = performance.now(); record.stages.push(row);
    try { const result = await action(); row.status = 'completed'; return result; }
    catch (error) { row.status = 'failed'; throw error; }
    finally { row.elapsed_seconds = (performance.now() - start) / 1000; }
  };
  try {
    const prepared = await bindPreparedEpisode(data.target.manifest.path);
    record.prepared_manifest = prepared;
    const manifestPath = data.target.manifest.path;
    const frames = data.request.bindings.filter(row => row.kind === 'frame').map(row => ({ ...row,
      timeline_seconds: data.request.evidence_catalog.find(item => item.id === row.id)?.timeline_seconds }));
    if (typeof session.restoreTargetAnalysis === 'function')
      record.session_story_restore = await session.restoreTargetAnalysis(analysisBinding, frames);
    const settings = { ...config, mode: 'assisted_trial', direction_contract_version: 2,
      craft_mode: config.craft_mode ?? 'fine', music_words_policy: config.music_words_policy ?? 'prefer' };
    const direction = await researchDirection({ config: settings, session, record, out,
      manifestPath, manifest: data.manifest, frames, stage, sourceFormatOptions,
      bridgeConfig: version => ({ schema_version: version, manifest: manifestPath,
        craft_mode: settings.craft_mode, music_words_policy: settings.music_words_policy,
        input_mode: version === 1 ? 'frames_only' : 'frames_and_observations',
        knowledge_files: settings.knowledge_files ?? [] }),
      analyzedTarget: { ...data, value: data.analysis, analysis: data.target.analysis,
        analysis_request: data.target.analysis_request, raw_response: data.target.raw_response } });
    if (!direction.research_candidate) return finish({ status: direction.status, unresolved: direction.unresolved ?? [] });
    const selected = await completeAssistedTrial({ config: settings, runtime, session, record, out,
      frames, manifestPath, manifest: data.manifest, sourceFormatOptions, stage, prepareOnly: true });
    if (!selected.prepared_render_config) return finish({ status: selected.status,
      unresolved: selected.unresolved ?? [], next_action: selected.next_action });
    const renderConfig = await readJson(selected.prepared_render_config.path);
    record.preflight = await prepareResearchTrial({ ...renderConfig, preview: false,
      output_dir: path.join(out, 'render-preflight') });
    return finish({ status: record.preflight.status === 'target_material_preparation_verified'
      ? 'target_materials_prepared' : record.preflight.status,
      actual_material_consumer_verified: record.preflight.actual_material_consumer_verified === true,
      prepared_render_config: selected.prepared_render_config,
      preparation_receipt: record.preflight.preparation_receipt ?? null,
      unresolved: record.preflight.required_tasks_unresolved ?? record.preflight.unresolved ?? [],
      next_action: record.preflight.status === 'target_material_preparation_verified'
        ? 'publish_target_readiness_then_render_bound_config' : 'resolve_only_recorded_material_gaps' });
  } catch (error) {
    if (error instanceof HostResponsePendingError) return finish({ status: 'target_material_director_pending',
      pending_stage: record.stages.at(-1)?.name ?? null,
      host_request: await bind(error.request_file), host_response_file: error.response_file,
      unresolved: ['actual_host_response_pending'], next_action: 'consume_bound_pending_material_request_without_reanalyzing_story' });
    return finish({ status: 'target_material_preparation_failed', error: error.message,
      unresolved: [error.message], next_action: 'repair_specific_material_stage_without_reanalyzing_story' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = await readJson(process.argv[2]);
  console.log(JSON.stringify(await prepareTargetMaterials(config, config.target_analysis)));
}
