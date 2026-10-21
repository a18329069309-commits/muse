import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { analyzeTarget } from './analyze_target.mjs';
import { prepareTargetMaterials, readTargetAnalysis } from './prepare_target_materials.mjs';
import { publishTargetReadiness } from './publish_target_readiness.mjs';
import { renderResearchTrial } from './render_research_trial.mjs';
import { ApiSession, readJson, saveJson } from './audio_api.mjs';

export async function composeTargetEpisode(config, runtime = {}) {
  if (config?.visual_sampling_step !== undefined && (!Number.isFinite(config.visual_sampling_step)
    || config.visual_sampling_step < 0.1 || config.visual_sampling_step > 10)) throw Error('compose_config_invalid');
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? '')
    || !['research', 'assisted_trial'].includes(config.mode)) throw new Error('target_pipeline_config_invalid');
  if (runtime.session && runtime.createSession) throw new Error('target_pipeline_one_session_required');
  const out = path.resolve(config.output_dir);
  try { if ((await readdir(out)).length) throw new Error('output_directory_must_be_empty'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(out, { recursive: true });
  const record = { schema_version: 1, pipeline: 'analysis_materials_render', status: 'analyzing',
    mode: config.mode, model_calls: 0, cloud_uploads: 0, generation_calls: 0,
    render_calls: 0, previews_created: 0, stages: [], artistic_acceptance: 'not_assessed', production_approval: false };
  let session = runtime.session;
  const acquire = async input => {
    if (session) return session;
    if (!runtime.createSession) return null;
    session = await runtime.createSession(input); return session;
  };
  const shared = () => session ? { ...runtime, session, createSession: undefined }
    : { ...runtime, session: undefined, createSession: runtime.createSession ? acquire : undefined };
  const finish = async values => {
    Object.assign(record, values);
    const ledger = session?.accountingLedger ?? session?.ledger ?? [];
    const injected = runtime.execution_kind === 'injected_test_transport';
    const total = field => ledger.every(row => row.provider || Number.isInteger(row[field]))
      ? ledger.reduce((sum, row) => sum + (row.provider ? 1 : row[field]), 0) : null;
    record.model_calls = injected ? 0 : total('model_calls');
    record.cloud_uploads = injected ? 0 : total('cloud_uploads');
    record.execution = { accounting_ledger: ledger, existing_runtime_used: Boolean(session),
      new_paid_calls: injected || !(session instanceof ApiSession) ? 0 : ledger.length,
      actual_cost_usd: null, accounting_scope: injected ? 'injected_test_transport' : 'actual_recorded_requests' };
    record.compose_record = await saveJson(path.join(out, 'compose-record.json'), record); return record;
  };
  try {
    let analysis;
    if (config.target_analysis) {
      const supplied = await readTargetAnalysis(config.target_analysis, config);
      analysis = { ...supplied.target, artifact: config.target_analysis, supplied_analysis_reused: true };
    } else analysis = await analyzeTarget({ ...config, output_dir: path.join(out, 'target-analysis') }, shared());
    record.target_analysis = analysis.artifact; record.source_video_sha256 = analysis.source_video_sha256;
    record.stages.push({ name: 'analyze_target', status: analysis.status, reused: analysis.story_reused === true });
    if (!analysis.analysis || analysis.status === 'target_analysis_partial')
      return finish({ status: analysis.status, unresolved: analysis.unknowns ?? analysis.coverage_gaps ?? [] });
    if (config.mode === 'research') return finish({ status: 'target_analysis_complete',
      material_needs: analysis.material_needs, unresolved: analysis.unknowns ?? [],
      next_action: 'prepare_target_materials_from_bound_analysis_without_reanalyzing_story' });
    const materials = await prepareTargetMaterials({ ...config, output_dir: path.join(out, 'target-materials') }, analysis.artifact, shared());
    record.target_materials = materials.artifact;
    record.stages.push({ name: 'prepare_target_materials', status: materials.status });
    if (materials.status !== 'target_materials_prepared')
      return finish({ status: materials.status, unresolved: materials.unresolved ?? [], next_action: materials.next_action });
    const release = await publishTargetReadiness(materials.preparation_receipt, {
      outputDirectory: path.join(out, 'target-readiness'), renderConfigBinding: materials.prepared_render_config });
    record.target_readiness = release.readiness;
    const renderConfig = await readJson(materials.prepared_render_config.path);
    const rendered = await renderResearchTrial(renderConfig, runtime);
    record.stages.push({ name: 'render_bound_target', status: rendered.status });
    return finish({ status: rendered.status, trial: rendered, preview: rendered.preview, audio_dir: rendered.audio_dir,
      selected_music: rendered.selected_music, unresolved: rendered.unresolved ?? [],
      music_source_budget: rendered.music_source_budget, render_calls: rendered.audio_dir ? 1 : 0,
      previews_created: rendered.preview ? 1 : 0, artistic_acceptance: 'awaiting_actual_audition' });
  } catch (error) {
    return finish({ status: 'failed', error: error.message, unresolved: [error.message],
      next_action: 'repair_failed_stage_and_reuse_bound_successful_inputs' });
  }
}
