import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, stat, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeTarget, resumePartialTargetAnalysis } from './analyze_target.mjs';
import { prepareTargetMaterials, readTargetAnalysis } from './prepare_target_materials.mjs';
import { publishTargetReadiness } from './publish_target_readiness.mjs';
import { renderResearchTrial } from './render_research_trial.mjs';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { researchDirection } from './compose_episode.mjs';
import { assembleResearchEpisode } from './assemble_research_episode.mjs';
import { HostFileSession, HostResponsePendingError } from './host_runtime.mjs';
import { createEpisodeMaterialRuntime } from './episode_material_runtime.mjs';
import { runEpisodeQueue } from './episode_task_queue.mjs';
import {isIndependentMusicPackTrial,validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {preflightPostRenderQuality,reviewRenderedEpisode,verifyPostRenderQualityReview} from './post_render_quality_review.mjs';
import {buildResearchAudioWindows} from './local_research_audio_observer.mjs';
import {captureAutomaticStageFailure,resolvePersistedFailedNativeRoute} from './automatic_stage_failure_evidence.mjs';
import {boundAssemblyGapRuntimeSpec,preflightBoundAssemblyGapControllerRecovery,
  preserveBoundAssemblyMaterialIdentity} from './bounded_assembly_gap_runtime.mjs';
import {validateFinalMixMasterConfig} from './final_mix_master.mjs';
import {independentMusicComparisonPolicy} from './independent_music_comparison_policy.mjs';
import {directionSoundPropulsionRevision} from './direction_sound_propulsion.mjs';
import {diagnosticAssemblySoundPolicyRevision} from './assembly_consumer_projection.mjs';
import {archiveClosedRender,validateDeliveryArchiveConfig} from './closed_render_archive.mjs';
import {readPostRenderSoundGaps} from './post_render_sound_gaps.mjs';
import {resolvePersistedFailedUnknownRange} from './typed_unknown_range_recovery.mjs';
import {sameJobMaterialRecoveryRevision} from './same_job_material_recovery.mjs';
import {runPostRenderRequiredSfxOfflineRepair,runAssemblyMaterialRequiredSfxOfflineRepair} from './required_sfx_offline_repair.mjs';
import {validateSfxOfflineRepairRoot} from './sfx_offline_repair_policy.mjs';
import {validateTrialWallClockPolicy} from './independent_trial_budget.mjs';
import {validateCompositeResearchConfig,verifyCompositeReview,compositeResearchRevision,assertCompositeSoundCompletion} from './composite_research_review.mjs';
import {verifyCompositeRepair} from './composite_scoped_repair.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
// Reuse preparation after a planning-only stop, without reclassifying the old
// error or granting any new invocation/time allowance.
export async function verifyZeroCallStoryCapacityPreparation({analysisStage:row,budget,source,directory}){
  if(row?.status!=='failed'||row.error!=='independent_trial_budget_exhausted'||!row.directory
    ||typeof budget?.snapshot!=='function')return null;
  const receipt=(row.cli_receipts??[]).find(ref=>ref.path===row.receipt_file);
  if(!receipt)return null;
  await verifyEvidenceBindings(receipt);const stop=await readJson(receipt.path),state=await budget.snapshot();
  if(stop.status!=='independent_trial_budget_exhausted'||stop.reason!=='call_plan_phase_capacity_exceeded'
    ||stop.input?.phase!=='story'||stop.charged_request_slots!==0||stop.actual_new_cli_invocations!==0
    ||stop.unknown_or_reserved_invocations!==0||stop.identity?.source_video_sha256!==source.sha256
    ||path.resolve(stop.identity.output_root??'')!==path.resolve(directory)||canonical(stop.identity)!==canonical(state.identity)
    ||state.charged_request_slots!==0||state.requests.some(request=>request.confirmed_invocations!==0)
    ||!state.stops.some(ref=>ref.path===receipt.path&&ref.sha256===receipt.sha256))return null;
  return {revision:'zero-call-story-capacity-preparation-reuse-v1',source_video_sha256:source.sha256,
    output_root:path.resolve(directory),original_analysis_directory:row.directory,stop:receipt,
    historical_error_preserved:row.error,gap_classification:'story_call_plan_shape_capacity_gap_before_any_account_invocation',
    charged_request_slots:0,actual_new_cli_invocations:0,unknown_or_reserved_invocations:0,
    request_and_preparation_only:true,deadline_or_request_allowance_extended:false,production_approval:false};
}
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const now = () => new Date().toISOString();
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const execute = promisify(execFile);
const completedAnalysis = value => Boolean(value?.analysis)
  && ['target_analysis_available', 'target_analysis_available_with_unknowns'].includes(value.status);
const pending = value => /(?:director_pending|host_response_pending)$/.test(value?.status ?? '');
const unreconciledStages = stages => Object.entries(stages ?? {}).filter(([name, row]) => name!=='delivery_archive'&&(
  row.status === 'running' || row.status === 'waiting_result' || row.status === 'waiting' && pending(row.result)))
  .map(([stage, row]) => ({ stage, attempt: row.attempt, status: row.status,
    request: row.result?.host_request ?? null, response_file: row.result?.host_response_file ?? null }));

function normalizeRenderOutputs(result) {
  if (!result?.audio_dir || !result.render?.outputs) return result;
  const base = path.dirname(result.audio_dir);
  return { ...result, render: { ...result.render, outputs: Object.fromEntries(Object.entries(result.render.outputs)
    .map(([key, value]) => [key, value?.path && !path.isAbsolute(value.path)
      ? { ...value, path: path.resolve(base, value.path) } : value])) } };
}

async function deliveredResearchAudioInputs(rendered, renderFiles, originalSource) {
  if (!rendered.preview) throw Error('research_audio_registered_delivered_preview_required');
  const preview = renderFiles.find(row => path.resolve(row.path) === path.resolve(rendered.preview));
  if (!preview) throw Error('research_audio_registered_delivered_preview_required');
  await verifyEvidenceBindings(preview);
  const probe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
    '-of', 'json', preview.path], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const audio = probe.streams?.find(row => row.codec_type === 'audio');
  if (!audio || !probe.streams?.some(row => row.codec_type === 'video'))
    throw Error('research_audio_delivered_preview_audio_and_video_required');
  const duration = Number(audio.duration ?? probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw Error('research_audio_delivered_duration_required');
  let offset = 0, originalDuration = null;
  if (rendered.inputs?.manifest) {
    await verifyEvidenceBindings(rendered.inputs.manifest);
    const manifest = await readJson(rendered.inputs.manifest.path);
    if (manifest.source_sha256 !== originalSource.sha256) throw Error('research_audio_manifest_wrong_original_source');
    if (manifest.timeline?.sample_rate === 48000 && Number.isSafeInteger(manifest.timeline.duration_samples))
      originalDuration = manifest.timeline.duration_samples / 48000;
  }
  if (rendered.diagnostic_sample) {
    if (!rendered.diagnostic_sample_receipt) throw Error('research_audio_sample_clock_receipt_required');
    await verifyEvidenceBindings(rendered.diagnostic_sample_receipt);
    const sample = await readJson(rendered.diagnostic_sample_receipt.path), range = sample.target_range;
    if (canonical(sample.preview) !== canonical(preview) || !Array.isArray(range) || range.length !== 2
      || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]
      || Math.abs(range[1] - range[0] - duration) > 0.1) throw Error('research_audio_sample_delivered_clock_mismatch');
    offset = range[0];
  }
  const extras = [];
  if (rendered.inputs?.arc_plan) {
    await verifyEvidenceBindings(rendered.inputs.arc_plan);
    const plan = await readJson(rendered.inputs.arc_plan.path);
    if (plan.source_video_sha256 !== originalSource.sha256) throw Error('research_audio_arc_plan_wrong_source');
    const seams = [...new Set((plan.arcs ?? []).flatMap(arc => (arc.pieces ?? []).map(piece => piece.target_range?.[0])))]
      .filter(Number.isFinite).map(time => time - offset).filter(time => time > 0 && time < duration);
    seams.forEach((time, index) => extras.push({ id: `seam-${index}`, kind: 'actual_edit_seam',
      source_range: [Math.max(0, time - 3), Math.min(duration, time + 3)] }));
  }
  // These are actual delivered AAC inputs, not a separately reconstructed WAV.
  await verifyEvidenceBindings(preview);
  return { preview, duration_seconds: duration, scope: { kind: 'actual_delivered_preview_audio_only',
    parent_episode_offset_seconds: offset, parent_episode_duration_seconds: originalDuration,
    complete_original_episode: originalDuration !== null && offset === 0 && Math.abs(duration - originalDuration) <= 0.1,
    actual_picture_processed: false }, ...buildResearchAudioWindows(duration, extras) };
}

async function validateResearchAudioScreen(result, inputs, originalSource) {
  if (!['actual_audio_research_screen_complete', 'actual_audio_research_screen_partial'].includes(result?.status)
    || ['qualified', 'sound_facts_qualified', 'artistic_approval', 'production_approval', 'audio_review_accepted',
      'actual_picture_processed'].some(key => result[key] !== false))
    throw Error('research_audio_screen_cannot_grant_listening_or_production_approval');
  for (const key of ['source', 'source_video']) if (canonical(result[key]) !== canonical(inputs.preview))
    throw Error('research_audio_screen_delivered_preview_identity_mismatch');
  if (result.original_source_video_sha256 !== originalSource.sha256 || !result.raw_report
    || result.windows?.length !== inputs.windows.length) throw Error('research_audio_screen_bound_windows_required');
  await verifyEvidenceBindings(result);
  const raw = await readJson(result.raw_report.path);
  if (raw.qualified !== false || raw.jobs?.length !== inputs.windows.length)
    throw Error('research_audio_screen_actual_raw_report_required');
  let actualCount = 0;
  for (const [index, window] of result.windows.entries()) {
    const expected = inputs.windows[index], job = raw.jobs[index];
    if (window.id !== expected.id || canonical(window.source_range) !== canonical(expected.source_range)
      || window.source_sha256 !== inputs.preview.sha256 || window.source_video_sha256 !== inputs.preview.sha256
      || window.qualified !== false || job.id !== expected.id
      || canonical(job.source_range) !== canonical(expected.source_range)
      || canonical(job.source_binding) !== canonical(inputs.preview)
      || window.evidence?.report_sha256 !== result.raw_report.sha256 || window.evidence?.job_index !== index
      || canonical(window.input_audio) !== canonical(job.input_audio))
      throw Error('research_audio_screen_actual_window_identity_mismatch');
    const processed = job.execution?.actual_audio_processed === true;
    if (window.actual_audio_processed !== processed) throw Error('research_audio_screen_actual_forward_required');
    if (processed) {
      if (!/^[a-f0-9]{64}$/.test(job.input_audio?.pcm_sha256 ?? '')
        || job.execution.processor_pcm_sha256 !== job.input_audio.pcm_sha256
        || !(job.execution.actual_audio_tokens > 0) || !(job.execution.encoder_forward_count > 0))
        throw Error('research_audio_screen_actual_forward_required');
      actualCount++;
    }
  }
  if (result.actual_observation_count !== actualCount
    || result.full_timeline_audio_windows_processed !== (actualCount === inputs.windows.length)
    || (result.status === 'actual_audio_research_screen_complete') !== (actualCount === inputs.windows.length))
    throw Error('research_audio_screen_full_axis_claim_mismatch');
  return result;
}

async function verifyStageResult(name, result) {
  // The release receipt is immutable; shared scheduling policy changes after later episodes publish.
  if (name === 'publish') {
    const { policy, ...immutable } = result;
    return verifyEvidenceBindings(immutable);
  }
  return verifyEvidenceBindings(result);
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function acquireLock(file) {
  try { return await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(file).catch(() => null);
    if (!Number.isInteger(previous?.pid) || previous.pid < 1) throw new Error('automatic_lock_identity_requires_attention');
    try { process.kill(previous.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw new Error('automatic_lock_owner_cannot_be_verified');
      await unlink(file); return open(file, 'wx');
    }
    throw new Error('automatic_episode_already_running');
  }
}

// Changes to frozen material stores may reopen material work; story controls may not.
function storyConfig(config) {
  const { output_dir, cases, library, music_packs, sfx_library, ambient_library, independent_retriever, original_sound_reviews, consumer_publication, target_analysis,
    source_policy, trial_review_policy, material_strategy, assembly_contract_version, sound_query_contract_version, sfx_adoption_mode, assembly_sfx_pool_contract_revision, editor_strategy,
    quality_review_policy, quality_review_audio_backend, quality_review_qualification,composite_review,trial_call_plan,assembly_decision_contract_revision,review_input_limit_policy,
    material_readiness_policy, music_action_contract_version, bounded_assembly_projection_revision,bounded_assembly_part_scope_revision,
    sound_edit_decision_contract_revision,final_mix_master,delivery_archive,render_decode_cache,independent_music_comparison_policy,sfx_audibility_repair,
    assembly_source_capacity_revision,assembly_gap_contract_revision,trial_wall_clock_policy,sfx_offline_repair_root,...story } = config;
  const result=Object.fromEntries(Object.entries(story).filter(([key]) => !/^material_(?:observer|observation|selector)/.test(key)));
  if(result.codex_cli&&(Object.hasOwn(result.codex_cli,'sfx_event_function_revision')
    ||Object.hasOwn(result.codex_cli,'direction_sound_propulsion_revision')||Object.hasOwn(result.codex_cli,'director_source_range_revision'))) {
    const {sfx_event_function_revision,direction_sound_propulsion_revision,director_source_range_revision,...storyCli}=result.codex_cli;
    result.codex_cli=storyCli;
    if(direction_sound_propulsion_revision!==undefined&&!Object.keys(storyCli).length)delete result.codex_cli;
  }
  return result;
}

function outsideFrozenPublication(config) {
  const { cases, library, music_packs, sfx_library, ambient_library, independent_retriever, consumer_publication,
    quality_review_policy, quality_review_audio_backend, quality_review_qualification,composite_review,trial_call_plan,assembly_decision_contract_revision,review_input_limit_policy,
    material_readiness_policy, music_action_contract_version,delivery_archive,render_decode_cache,independent_music_comparison_policy,sfx_audibility_repair,sfx_offline_repair_root, ...unchanged } = config;
  return unchanged;
}

async function materialRuntimeIdentity(runtime, config, session, sourceSha) {
  const comparisonPolicy=independentMusicComparisonPolicy(config);
  const comparisonIdentity=comparisonPolicy?{independent_music_comparison_policy:comparisonPolicy,
    independent_music_comparison_implementations:Object.fromEntries(await Promise.all([
      'independent_music_comparison_policy.mjs','independent_music_supply.mjs','independent_music_material_bridge.mjs',
      'independent_music_selection_projection.mjs','material_observation_projection.mjs','bounded_inline_record_encoding.mjs',
      'completed_material_selection_evidence.mjs'
    ].map(async file=>[file,await hashFile(fileURLToPath(new URL('./'+file,import.meta.url)))])))}:{};
  const soundFunctionRevision = runtime.sfxEventFunctionRevision ?? config.codex_cli?.sfx_event_function_revision;
  let soundFunctionIdentity = {};
  if (soundFunctionRevision !== undefined) {
    if (soundFunctionRevision !== 'sound-event-function-v2') throw Error('automatic_sfx_event_function_revision_invalid');
    const files = ['sfx_event_function.mjs','sfx_diagnostic_selection_policy.mjs','material_selection.mjs',
      'target_sfx_material_bridge.mjs','corpus_materials.py','diagnostic_bed_placement.mjs','assembly_sfx_adoption.mjs',
      'sfx_material_selection_projection.mjs','completed_sfx_cli_evidence.mjs'];
    soundFunctionIdentity = { sfx_event_function_revision: soundFunctionRevision,
      sfx_event_function_implementations: Object.fromEntries(await Promise.all(files.map(async file =>
        [file, await hashFile(fileURLToPath(new URL('./'+file, import.meta.url)))]))) };
  }
  const revision=runtime.soundCatalogRoutingRevision??config.codex_cli?.sound_catalog_routing_revision;
  let catalogRouting={};
  if(revision!==undefined){
    const {soundCatalogRoutingRevision}=await import('./sound_catalog_routing.mjs');
    if(revision!==soundCatalogRoutingRevision)throw Error('automatic_sound_catalog_routing_revision_invalid');
    catalogRouting={sound_catalog_routing_revision:revision,
      sound_catalog_routing_sha256:await hashFile(fileURLToPath(new URL('./sound_catalog_routing.mjs',import.meta.url))),
      sound_bridge_sha256:await hashFile(fileURLToPath(new URL('./target_sfx_material_bridge.mjs',import.meta.url)))};
  }
  return {
    ...comparisonIdentity,
    ...soundFunctionIdentity,
    ...catalogRouting,
    ...((runtime.soundQueryRepairContract ?? config.codex_cli?.sound_query_repair_contract) !== undefined
      ? { sound_query_repair_contract: runtime.soundQueryRepairContract ?? config.codex_cli.sound_query_repair_contract } : {}),
    ...((runtime.sfxMaterialSelectionProjection ?? config.codex_cli?.sfx_material_selection_projection) !== undefined
      ? { sfx_material_selection_projection: runtime.sfxMaterialSelectionProjection ?? config.codex_cli.sfx_material_selection_projection } : {}),
    ...(config.sfx_adoption_mode!==undefined?{sfx_adoption_mode:config.sfx_adoption_mode}:{}),
    ...(config.assembly_sfx_pool_contract_revision!==undefined?{
      assembly_sfx_pool_contract_revision:config.assembly_sfx_pool_contract_revision,
      assembly_sfx_pool_implementations:Object.fromEntries(await Promise.all([
        'assembly_sfx_candidate_pool.mjs','target_sfx_material_bridge.mjs','target_sound_query_repair_batch.mjs',
        'sound_retrieval_contract.mjs','material_selection.mjs','assembly_sfx_adoption.mjs'
      ].map(async file=>[file,await hashFile(fileURLToPath(new URL('./'+file,import.meta.url)))])))
    }:{}),
    ...(config.material_readiness_policy!==undefined?{material_readiness_policy:config.material_readiness_policy}:{}),
    ...(runtime.invalidMaterialWindows ? { invalid_window_registry:runtime.invalidMaterialWindows } : {}),
    execution_kind: runtime.execution_kind ?? null,
    observer_backend_id: runtime.materialObserver_backend_id ?? config.material_observer_backend_id ?? null,
    observer_model_revision: runtime.materialObserver_model_revision ?? config.material_observer_model_revision ?? null,
    sfx_observer_backend_id:runtime.sfxMaterialObserver_backend_id??null,
    sfx_observer_model_revision:runtime.sfxMaterialObserver_model_revision??null,
    observer_audio_backend: runtime.materialObserver_audio_backend ?? null,
    selector_backend_id: runtime.materialSelector_backend_id ?? config.material_selector_backend_id ?? null,
    selector_model_revision: runtime.materialSelector_model_revision ?? session?.backend?.model_revision ?? null,
    observer_present: typeof runtime.materialObserver === 'function', selector_present: typeof runtime.materialSelector === 'function',
    query_language_correction:runtime.retrievalQueryCorrections?.[sourceSha]??null,
  };
}

const materialReaderKeys=[['independent_music_comparison_implementations','completed_material_selection_evidence.mjs'],
  ['sfx_event_function_implementations','completed_sfx_cli_evidence.mjs']];
export function materialRuntimeReaderOnlyChange(previous,requested){
  if(!previous||!requested)return false;
  const old=structuredClone(previous),next=structuredClone(requested);let changed=false;
  for(const[group,file]of materialReaderKeys){
    const a=old[group]?.[file],b=next[group]?.[file];
    if(!/^[a-f0-9]{64}$/.test(a??'')||!/^[a-f0-9]{64}$/.test(b??''))return false;
    changed ||= a!==b;delete old[group][file];delete next[group][file];
  }
  return changed&&canonical(old)===canonical(next);
}

// A proof-reader upgrade does not select material. Revalidate the immutable
// completed parent and its actual children before restoring that same result.
export async function revalidateCompletedMaterialsAfterReaderUpgrade({state,requestedIdentity,snapshotSha,source,episodeRoot}){
  const requestedSha=digest(requestedIdentity);
  if(state.source?.sha256!==source.sha256||state.current_snapshot_sha256!==snapshotSha)return null;
  const candidates=[{snapshot_sha256:state.current_snapshot_sha256,material_runtime_identity:state.material_runtime_identity,
    stages:{materials:state.stages.materials}},...(state.material_history??[]).toReversed()];
  const previous=candidates.find(row=>row.snapshot_sha256===snapshotSha&&row.stages?.materials?.status==='completed'
    &&materialRuntimeReaderOnlyChange(row.material_runtime_identity,requestedIdentity));
  if(!previous)return null;
  const row=previous.stages.materials;
  if(state.stages.materials?.status==='completed'&&state.material_runtime_sha256===requestedSha)return null;
  if(!row.result_binding||!path.resolve(row.result_binding.path).startsWith(path.resolve(episodeRoot)+path.sep))
    throw Error('automatic_material_reader_reuse_same_job_result_required');
  await verifyEvidenceBindings([source,row.result_binding]);const result=await readJson(row.result_binding.path);
  if(canonical(result)!==canonical(row.result)||result.status!=='target_research_materials_selected'
    ||result.source_video_sha256!==source.sha256||result.material_strategy!=='independent_music_packs'
    ||result.qualified!==false||result.artistic_approval!==false||result.production_approval!==false
    ||canonical(result.target_analysis)!==canonical(state.stages.analysis?.result?.artifact)
    ||canonical(result.direction)!==canonical(state.stages.direction?.result?.direction_binding))
    throw Error('automatic_material_reader_reuse_completed_current_intent_required');
  await verifyStageResult('materials',result);
  const {verifyCompletedMaterialSelection}=await import('./completed_material_selection_evidence.mjs');
  const {loadCompletedTargetSfxSelection}=await import('./completed_sfx_material_recovery.mjs');
  const {expandCandidateEvidence}=await import('./candidate_evidence.mjs');
  const music=[];
  if(!result.material_selections?.length)throw Error('automatic_material_reader_reuse_music_evidence_required');
  for(const selection of result.material_selections){
    const proof=await verifyCompletedMaterialSelection(selection.selection);
    if(proof.request.source_video_sha256!==source.sha256||proof.request.publication?.sha256!==result.publication?.sha256)
      throw Error('automatic_material_reader_reuse_music_source_or_publication_changed');
    music.push({selection:selection.selection,actual_cli_receipts:proof.raw.cli_receipts});
  }
  const sounds=await readJson(result.sound_materials.path),sfx=[];
  if(!sounds.material_preparations?.length)throw Error('automatic_material_reader_reuse_sound_evidence_required');
  for(const reference of sounds.material_preparations){
    const preparation=await readJson(reference.path);
    if(preparation.source_video_sha256!==source.sha256)throw Error('automatic_material_reader_reuse_sound_source_changed');
    if(!preparation.selection){
      if(preparation.selected_count!==0||preparation.sound_pool_count>0)
        throw Error('automatic_material_reader_reuse_sound_selection_required');
      continue;
    }
    const record=await readJson(preparation.selection.path),document=await readJson(record.case_source.path);
    const candidates=expandCandidateEvidence(await readJson(record.candidate_source.path));
    const taskRef=candidates.evidence_files.find(ref=>path.basename(ref.path)==='tasks.json');
    await verifyEvidenceBindings(taskRef);const tasks=await readJson(taskRef.path);
    const proof=await loadCompletedTargetSfxSelection(preparation.selection,{source,libraryBinding:preparation.library,
      assetKind:preparation.asset_kind,document,tasks:tasks.tasks});
    sfx.push(proof.proof);
  }
  const interrupted=state.stages.materials;
  let interruption=null;
  if(interrupted?.status==='running'){
    const budgetRef=await bind(path.join(episodeRoot,'independent-trial-budget','state.json'));
    const budget=await readJson(budgetRef.path),start=Date.parse(interrupted.started_at);
    if(budget.identity?.source_video_sha256!==source.sha256||!Number.isFinite(start))
      throw Error('automatic_material_reader_reuse_interruption_budget_identity_required');
    const requests=budget.requests.filter(item=>item.reserved_at_ms>=start);
    if(!requests.length)throw Error('automatic_material_reader_reuse_interruption_reconciliation_required');
    const owners=[];
    for(const request of requests){
      const run=budget.run_history?.find(item=>item.id===request.run_id&&Number.isFinite(item.finished_at_ms));
      if(!run||!Number.isSafeInteger(run.pid)||run.pid===process.pid||request.terminated!==true)
        throw Error('automatic_material_reader_reuse_interruption_not_terminated');
      try{process.kill(run.pid,0);throw Error('automatic_material_reader_reuse_interruption_owner_alive');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      owners.push({pid:run.pid,run_id:run.id,request_id:request.id,request_sha256:request.request_sha256,
        confirmed_invocations:request.confirmed_invocations,terminated:true});
    }
    await verifyEvidenceBindings(budgetRef);
    // The live budget will advance during later calls. Keep its checked bytes
    // identity and full historical value, not an allegedly immutable live ref.
    interruption={budget_state_path:budgetRef.path,live_budget_state_sha256_at_check:budgetRef.sha256,
      budget_snapshot:budget,budget_snapshot_canonical_sha256:digest(budget),requests:owners,
      unknown_reservations_preserved:true,new_budget_reservations:0};
  }
  return {stage:structuredClone(row),proof:{revision:'completed-material-proof-reader-revalidation-v1',
    result:row.result_binding,old_material_runtime_identity:previous.material_runtime_identity,
    requested_material_runtime_identity:requestedIdentity,requested_material_runtime_sha256:requestedSha,
    music,sfx,interruption,new_model_calls:0,new_budget_reservations:0,qualification_granted:false}};
}

// Replace only the adapters whose exact-window maps are tied to a frozen
// publication. The current film session, selector and budget stay in place.
async function refreshFrozenMaterialAdapters(config, adapters) {
  if (config.material_observer_kind !== 'frozen_offline') return adapters;
  if (config.material_readiness_policy !== 'offline_ready_only' || config.material_observation_execution)
    throw Error('offline_materials_cannot_run_online_inference');
  const { createFrozenMaterialObserver } = await import('./offline_material_readiness.mjs');
  const refreshed = { ...adapters, ...await createFrozenMaterialObserver({
    publication: config.music_packs?.publication ?? config.music_packs }) };
  const soundKeys = ['sfxMaterialObserver', 'sfxMaterialObserverBatch', 'sfxMaterialObserver_backend_id',
    'sfxMaterialObserver_model_revision', 'sfxAnchorMeasurer'];
  // Explicit undefined also masks a removed store's adapters from runtime.
  for (const key of soundKeys) refreshed[key] = undefined;
  if (config.sfx_library?.publication) {
    const { createFrozenSoundMaterialObserver } = await import('./frozen_sound_material_observer.mjs');
    const sound = await createFrozenSoundMaterialObserver(config.sfx_library);
    for (const key of soundKeys) refreshed[key] = sound[key];
  }
  return refreshed;
}

async function sourceAudioForStages(analysis, config, source) {
  if (!analysis.local_audio_evidence) {
    if (config.dialogue_intervals === undefined && analysis.dialogue_intervals !== undefined)
      throw new Error('automatic_derived_dialogue_intervals_bound_source_evidence_required');
    return null;
  }
  const data = await readTargetAnalysis(analysis.artifact, config), local = data.target.local_audio_evidence;
  if (!local || canonical(local) !== canonical(analysis.local_audio_evidence))
    throw new Error('automatic_source_audio_analysis_artifact_mismatch');
  await verifyEvidenceBindings(local);
  const receipt = await readJson(local.receipt.path), checkpoint = await readJson(local.checkpoint.path);
  const N = data.manifest.timeline.duration_samples, duration = N / 48000;
  const originalAudio = await bind(path.resolve(path.dirname(data.target.manifest.path), data.manifest.original_audio));
  const analysisAudio = await bind(path.resolve(path.dirname(data.target.manifest.path), data.manifest.analysis_audio));
  if (receipt.source_video_sha256 !== source.sha256 || receipt.manifest_sha256 !== data.target.manifest.sha256
    || checkpoint.manifest?.sha256 !== receipt.manifest_sha256
    || receipt.original_audio_sha256 !== originalAudio.sha256 || receipt.analysis_audio_sha256 !== analysisAudio.sha256
    || receipt.sound_facts_qualified !== false || local.sound_facts_qualified !== false
    || !Array.isArray(local.observation_files) || !Array.isArray(local.bridge_observation_files)
    || canonical(receipt.observation_files) !== canonical(local.observation_files.map(row => row.path))
    || canonical(local.dialogue_intervals) !== canonical(receipt.dialogue_intervals))
    throw new Error('automatic_source_audio_receipt_identity_mismatch');
  let previousEnd = 0;
  if (!Array.isArray(local.dialogue_intervals)) throw new Error('automatic_source_dialogue_intervals_required');
  for (const interval of local.dialogue_intervals) {
    const start = interval.start_seconds, end = interval.end_seconds;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || end > duration
      || Math.round(start * 48000) < 0 || Math.round(end * 48000) > N
      || Math.round(end * 48000) <= Math.round(start * 48000))
      throw new Error('automatic_source_dialogue_interval_outside_bound_timeline');
    previousEnd = end;
  }
  for (const reference of [...local.observation_files, ...local.bridge_observation_files]) {
    const observation = await readJson(reference.path);
    if (observation.source_video_sha256 !== source.sha256 || observation.sound_facts_qualified !== false
      || observation.original_audio_sha256 && observation.original_audio_sha256 !== originalAudio.sha256
      || observation.analysis_audio_sha256 && observation.analysis_audio_sha256 !== analysisAudio.sha256
      || observation.source_sha256 && observation.source_sha256 !== analysisAudio.sha256
      || observation.manifest_sha256 && observation.manifest_sha256 !== data.target.manifest.sha256
      || !Array.isArray(observation.source_range) || observation.source_range.length !== 2
      || !observation.source_range.every(Number.isFinite) || observation.source_range[0] < 0
      || observation.source_range[1] <= observation.source_range[0] || observation.source_range[1] > duration)
      throw new Error('automatic_source_audio_observation_identity_mismatch');
  }
  if (config.dialogue_intervals === undefined && canonical(data.target.dialogue_intervals) !== canonical(local.dialogue_intervals))
    throw new Error('automatic_derived_dialogue_intervals_receipt_mismatch');
  return { local, intervals: local.dialogue_intervals, sha256: digest({ receipt: local.receipt, checkpoint: local.checkpoint,
    observations: local.observation_files, bridge_observations: local.bridge_observation_files, N,
    intervals: local.dialogue_intervals }) };
}

async function frozenMaterials(config) {
  const value = { cases: config.cases ?? null, library: config.library ?? null,
    music_packs: config.music_packs ?? null, sfx_library: config.sfx_library ?? null,
    independent_retriever: config.independent_retriever ?? null,
    ambient_library: config.ambient_library ?? null, original_sound_reviews: config.original_sound_reviews ?? null,
    material_strategy: config.material_strategy ?? null,
    source_policy: config.source_policy ?? null, trial_review_policy: config.trial_review_policy ?? null,
    consumer_publication: config.consumer_publication ?? null,
    material_execution_config: Object.fromEntries(Object.entries(config).filter(([key]) => /^material_(?:observer|observation|selector)/.test(key))) }, files = new Map();
  const collect = async (item, label) => {
    if (!item || typeof item !== 'object') return;
    if (typeof item.path === 'string' && item.sha256) {
      await verifyEvidenceBindings(item);
      files.set(path.resolve(item.path), { ...await bind(item.path), label });
    }
    for (const [key, child] of Object.entries(item)) {
      if (['db', 'rules_db'].includes(key) && typeof child === 'string') {
        if (!path.isAbsolute(child)) throw new Error('automatic_frozen_store_absolute_path_required');
        files.set(path.resolve(child), await exists(child)
          ? { ...await bind(child), label: `${label}.${key}` }
          : { path: path.resolve(child), missing: true, label: `${label}.${key}` });
      } else if (child && typeof child === 'object') await collect(child, `${label}.${key}`);
    }
  };
  await collect(value, 'frozen');
  const snapshot = { config: value, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  return { ...snapshot, sha256: digest(snapshot) };
}

function structuredGaps(result, source, stage, snapshot, analysis) {
  const rows = result.unresolved?.length ? result.unresolved : result.coverage_gaps?.length ? result.coverage_gaps
    : result.unknowns?.length ? result.unknowns : [result.error ?? result.status];
  return rows.map(value => {
    const object = typeof value === 'object' && value !== null ? value : { reason: String(value) };
    const identity = { source_video_sha256: source.sha256, stage, snapshot_sha256: snapshot.sha256,
      object_id: object.object_id ?? object.event_id ?? object.cue_id ?? object.story_beat_id ?? object.id ?? null,
      target_range: object.target_range ?? object.range ?? null, reason: object.reason ?? object.reason_code ?? object.problem ?? canonical(value) };
    return { ...object, ...identity, gap_id: digest(identity), status: pending(result) ? 'runtime_pending' : 'unresolved',
      stage_status: result.status, target_analysis: analysis?.artifact ?? null, created_at: now(),
      facts_qualification_granted: false, production_approval: false };
  });
}

async function prepareResearchDirection(config, analysisBinding, runtime) {
  const data = await readTargetAnalysis(analysisBinding, config), out = config.output_dir;
  await mkdir(out, { recursive: false });
  const record = { schema_version: 1, stages: [], target_analysis: analysisBinding,
    source_video_sha256: data.target.source_video_sha256, production_approval: false };
  const frames = data.request.bindings.filter(row => row.kind === 'frame').map(row => ({ ...row,
    timeline_seconds: data.request.evidence_catalog.find(item => item.id === row.id)?.timeline_seconds }));
  const session = runtime.session ?? await runtime.createSession?.({ config, directory: path.join(out, 'host'),
    media: [data.target.source_video], source: data.target.source_video });
  if (!session) return { ...record, status: 'target_material_director_pending', unresolved: ['actual_session_required'] };
  if (typeof session.restoreTargetAnalysis === 'function') await session.restoreTargetAnalysis(analysisBinding, frames);
  const stage = async (name, action) => { const row = { name, status: 'running' }; record.stages.push(row);
    try { const result = await action(); row.status = 'completed'; return result; }
    catch (error) { row.status = 'failed'; throw error; } };
  try {
    const settings = { ...config, direction_contract_version: 2 };
    await researchDirection({ config: settings, session, record, out,
      manifestPath: data.target.manifest.path, manifest: data.manifest, frames, stage,
      bridgeConfig: version => ({ schema_version: version, manifest: data.target.manifest.path,
        craft_mode: settings.craft_mode ?? 'fine', music_words_policy: settings.music_words_policy ?? 'prefer',
        input_mode: version === 1 ? 'frames_only' : 'frames_and_observations', knowledge_files: settings.knowledge_files ?? [] }),
      analyzedTarget: { ...data, value: data.analysis, analysis: data.target.analysis,
        analysis_request: data.target.analysis_request, raw_response: data.target.raw_response } });
    return { ...record, direction_binding: record.research_candidate, frames };
  } catch (error) {
    if (!(error instanceof HostResponsePendingError)) throw error;
    return { ...record, status: 'target_material_director_pending', host_request: await bind(error.request_file),
      host_response_file: error.response_file, unresolved: ['actual_host_response_pending'] };
  }
}

const defaultStages = { analyzeTarget, resumePartialTargetAnalysis, prepareTargetMaterials, readTargetAnalysis, publishTargetReadiness, renderResearchTrial,
  prepareResearchDirection, assembleResearchEpisode, reviewRenderedEpisode,
  prepareTargetResearchMaterials: async input => {
    if (input.config.material_strategy === 'independent_music_packs') {
      const { prepareIndependentMusicPackMaterials } = await import('./independent_music_material_bridge.mjs');
      return prepareIndependentMusicPackMaterials(input);
    }
    const { prepareTargetResearchMaterials } = await import('./target_music_material_bridge.mjs');
    return prepareTargetResearchMaterials(input);
  } };

// The controller never substitutes material evidence, listened audio, or an approved result.
export async function composeAutomaticEpisode(config, runtime = {}) {
  validateCompositeResearchConfig(config);
  validateSfxOfflineRepairRoot(config);
  independentMusicComparisonPolicy(config);
  if(config.trial_wall_clock_policy!==undefined){
    if(!isIndependentMusicPackTrial(config))throw Error('automatic_trial_wall_clock_diagnostic_scope_required');
    validateTrialWallClockPolicy(config.trial_wall_clock_policy,{maxElapsedMs:config.trial_budget?.max_elapsed_ms??1200000});
  }
  for(const[key,revision]of [['assembly_source_capacity_revision','admitted-continuous-source-capacity-v1'],
    ['assembly_gap_contract_revision','object-scoped-gap-v1']]){
    if(config[key]!==undefined&&(config[key]!==revision||config.assembly_contract_version!==2))
      throw Error('automatic_assembly_execution_revision_invalid:'+key);
  }
  if(config.sfx_audibility_repair!==undefined)
    (await import('./sfx_audibility_repair.mjs')).validateSfxAudibilityRepairPolicy(config.sfx_audibility_repair);
  const propulsionRevision=config.codex_cli?.direction_sound_propulsion_revision;
  if(propulsionRevision!==undefined&&propulsionRevision!==directionSoundPropulsionRevision)
    throw Error('automatic_direction_sound_propulsion_revision_invalid');
  if(config.final_mix_master!==undefined)validateFinalMixMasterConfig(config.final_mix_master);
  if(config.delivery_archive!==undefined)validateDeliveryArchiveConfig(config.delivery_archive);
  if(config.quality_review_policy!==undefined&&!['diagnostic_only','automatic_required','composite_research'].includes(config.quality_review_policy))
    throw Error('automatic_quality_review_policy_invalid');
  if (config?.visual_sampling_step !== undefined && (!Number.isFinite(config.visual_sampling_step)
    || config.visual_sampling_step < 0.1 || config.visual_sampling_step > 10)) throw Error('compose_config_invalid');
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? '')
    || !['research', 'assisted_trial'].includes(config.mode)
    || config.assembly_contract_version !== undefined && ![1, 2].includes(config.assembly_contract_version)
    || config.sound_query_contract_version !== undefined && ![1, 2].includes(config.sound_query_contract_version)) throw new Error('automatic_episode_config_invalid');
  if(config.sfx_adoption_mode!==undefined&&!['separate','assembly'].includes(config.sfx_adoption_mode))
    throw Error('automatic_sfx_adoption_mode_invalid');
  if(config.sfx_adoption_mode==='assembly'){
    if(!isIndependentMusicPackTrial(config))throw Error('automatic_sfx_adoption_diagnostic_scope_required');
    await validateIndependentMusicPackPolicy(config,{outputDirectory:config.output_dir,operation:'compose_episode'});
  }
  if(config.assembly_sfx_pool_contract_revision!==undefined
    &&(config.assembly_sfx_pool_contract_revision!=='observed-candidates-final-assembly-v1'
      ||config.sfx_adoption_mode!=='assembly'||!isIndependentMusicPackTrial(config)))
    throw Error('automatic_assembly_sfx_pool_contract_invalid');
  if (config.editor_strategy !== undefined && runtime.diagnosticEditorStrategy !== undefined
    && config.editor_strategy !== runtime.diagnosticEditorStrategy) throw Error('automatic_editor_strategy_conflict');
  const editorStrategy = config.editor_strategy ?? runtime.diagnosticEditorStrategy ?? null;
  const boundedAssemblyProjectionRevision = runtime.boundedAssemblyProjectionRevision
    ?? config.bounded_assembly_projection_revision ?? config.codex_cli?.bounded_assembly_projection_revision;
  if (runtime.boundedAssemblyProjectionRevision !== undefined && config.bounded_assembly_projection_revision !== undefined
    && runtime.boundedAssemblyProjectionRevision !== config.bounded_assembly_projection_revision)
    throw Error('automatic_bounded_assembly_projection_conflict');
  if (boundedAssemblyProjectionRevision !== undefined && boundedAssemblyProjectionRevision !== 'mother-cue-complete-action-subparts-v1')
    throw Error('automatic_bounded_assembly_projection_invalid');
  const scopeRevisions=[runtime.boundedAssemblyPartScopeRevision,config.bounded_assembly_part_scope_revision,
    config.codex_cli?.bounded_assembly_part_scope_revision].filter(value=>value!==undefined);
  const boundedAssemblyPartScopeRevision=scopeRevisions[0];
  if(scopeRevisions.some(value=>value!==boundedAssemblyPartScopeRevision))throw Error('automatic_bounded_part_scope_conflict');
  if(boundedAssemblyPartScopeRevision!==undefined&&(boundedAssemblyPartScopeRevision!=='owned-target-clock-bounds-v1'
    ||config.assembly_contract_version!==2||config.music_action_contract_version!==2||editorStrategy!==null))
    throw Error('automatic_bounded_part_scope_invalid');
  const soundEditRevisions=[runtime.soundEditDecisionContractRevision,config.sound_edit_decision_contract_revision,
    config.codex_cli?.sound_edit_decision_contract_revision].filter(value=>value!==undefined);
  const soundEditDecisionContractRevision=soundEditRevisions[0];
  if(soundEditRevisions.some(value=>value!==soundEditDecisionContractRevision))throw Error('automatic_sound_edit_contract_conflict');
  if(soundEditDecisionContractRevision!==undefined&&soundEditDecisionContractRevision!=='strict-sound-decisions-v1')
    throw Error('automatic_sound_edit_contract_invalid');
  if (editorStrategy !== null) {
    if (editorStrategy !== 'constraint_editor_diagnostic_v1') throw Error('automatic_editor_strategy_invalid');
    if (!isIndependentMusicPackTrial(config)) throw Error('automatic_editor_diagnostic_scope_required');
    await validateIndependentMusicPackPolicy(config, { outputDirectory: config.output_dir, operation: 'compose_episode' });
  }
  if (runtime.session && runtime.createSession) throw new Error('automatic_episode_one_session_required');
  if (runtime.controllerStages && runtime.execution_kind !== 'injected_test_transport')
    throw new Error('automatic_controller_stage_overrides_test_only');
  const stages = { ...defaultStages, ...(runtime.controllerStages ?? {}) };
  const sourcePath = config.video?.path ?? config.video ?? config.prepared_manifest_binding?.source?.path;
  if (!path.isAbsolute(sourcePath ?? '')) throw new Error('automatic_actual_video_absolute_path_required');
  const source = await bind(sourcePath), directory = path.resolve(config.output_dir);
  const boundedAssemblyGapRecovery = boundAssemblyGapRuntimeSpec(runtime, source.sha256);
  let boundSoundDecisionRecovery=null;
  if(runtime.assemblyRecoveries?.[source.sha256]){
    const candidate=runtime.assemblyRecoveries[source.sha256];await verifyEvidenceBindings(candidate);
    if((await readJson(candidate.path)).kind==='bound_completed_sound_decision_recovery')boundSoundDecisionRecovery=candidate;
  }
  const editorAuthorization = editorStrategy ? runtime.diagnosticTrialAuthorizations?.[source.sha256] ?? null : null;
  if (editorAuthorization) {
    await verifyEvidenceBindings(editorAuthorization);
    const authorization = await readJson(editorAuthorization.path);
    if (authorization.kind !== 'direct_human_single_episode_trial_request'
      || authorization.source?.sha256 !== source.sha256 || authorization.material_or_listening_approval !== false
      || authorization.production_approval !== false) throw Error('automatic_editor_trial_authorization_mismatch');
  }
  const editorIdentity = editorStrategy ? { strategy: editorStrategy,
    implementation_sha256: await hashFile(fileURLToPath(new URL('./constraint_episode_editor.mjs', import.meta.url))),
    action_execution_audit_sha256:await hashFile(fileURLToPath(new URL('./music_action_execution_audit.mjs',import.meta.url))),
    trial_authorization: editorAuthorization } : {
      strategy: 'actual_model_episode_assembly_v1',
      implementation_sha256: await hashFile(fileURLToPath(new URL('./assemble_research_episode.mjs', import.meta.url))),
      material_observation_sha256: await hashFile(fileURLToPath(new URL('./assembly_material_observation.mjs', import.meta.url))),
      sound_arc_edit_sha256: await hashFile(fileURLToPath(new URL('./sound_arc_edit.mjs', import.meta.url))),
      bounded_assembly_sha256: await hashFile(fileURLToPath(new URL('./bounded_research_assembly.mjs', import.meta.url))),
      role_split_assembly_sha256: await hashFile(fileURLToPath(new URL('./role_split_research_assembly.mjs', import.meta.url))),
      role_split_projection_sha256: await hashFile(fileURLToPath(new URL('./role_split_assembly_projection.mjs', import.meta.url))),
      source_measurements_sha256: await hashFile(fileURLToPath(new URL('./editor_source_window_measurements.mjs', import.meta.url))),
      original_mix_measurements_sha256: await hashFile(fileURLToPath(new URL('./editor_original_mix_measurements.mjs', import.meta.url))),
      bounded_projection_sha256: await hashFile(fileURLToPath(new URL('./bounded_assembly_projection.mjs', import.meta.url))),
      action_execution_audit_sha256: await hashFile(fileURLToPath(new URL('./music_action_execution_audit.mjs', import.meta.url))),
    };
  editorIdentity.music_action_contract_version=config.music_action_contract_version??1;
  if(config.assembly_decision_contract_revision!==undefined){
    if(config.assembly_decision_contract_revision!=='host-bound-editor-decisions-v1')throw Error('automatic_assembly_decision_contract_revision_invalid');
    editorIdentity.assembly_decision_contract_revision=config.assembly_decision_contract_revision;
    editorIdentity.assembly_decision_contract_sha256=await hashFile(fileURLToPath(new URL('./assembly_decision_contract.mjs',import.meta.url)));
  }
  const executionRevisionFiles=new Set();
  if(config.assembly_source_capacity_revision!==undefined){
    editorIdentity.assembly_source_capacity_revision=config.assembly_source_capacity_revision;
    executionRevisionFiles.add('role_split_assembly_projection.mjs');executionRevisionFiles.add('independent_music_supply.mjs');
  }
  if(config.assembly_gap_contract_revision!==undefined){
    editorIdentity.assembly_gap_contract_revision=config.assembly_gap_contract_revision;
    executionRevisionFiles.add('object_scoped_assembly_gaps.mjs');
  }
  if(executionRevisionFiles.size)editorIdentity.execution_revision_implementations=Object.fromEntries(await Promise.all(
    [...executionRevisionFiles].sort().map(async file=>[file,await hashFile(fileURLToPath(new URL('./'+file,import.meta.url)))])));
  if(config.sfx_adoption_mode==='assembly'){
    editorIdentity.sfx_adoption_sha256=await hashFile(fileURLToPath(new URL('./assembly_sfx_adoption.mjs',import.meta.url)));
    editorIdentity.sfx_direction_provenance_sha256=await hashFile(fileURLToPath(new URL('./bound_sfx_direction_provenance.mjs',import.meta.url)));
    if(config.assembly_sfx_pool_contract_revision!==undefined){
      editorIdentity.assembly_sfx_pool_contract_revision=config.assembly_sfx_pool_contract_revision;
      editorIdentity.assembly_sfx_pool_contract_sha256=await hashFile(fileURLToPath(new URL('./assembly_sfx_candidate_pool.mjs',import.meta.url)));
    }
    if(isIndependentMusicPackTrial(config)){
      editorIdentity.diagnostic_sound_adoption_policy_revision=diagnosticAssemblySoundPolicyRevision;
      editorIdentity.diagnostic_sound_consumer_projection_sha256=await hashFile(fileURLToPath(new URL('./assembly_consumer_projection.mjs',import.meta.url)));
    }
  }
  if(soundEditDecisionContractRevision!==undefined){
    editorIdentity.sound_edit_decision_contract_revision=soundEditDecisionContractRevision;
    editorIdentity.sound_edit_contract_sha256=await hashFile(fileURLToPath(new URL('./sound_edit_decision_contract.mjs',import.meta.url)));
    editorIdentity.sound_decision_recovery_sha256=await hashFile(fileURLToPath(new URL('./bound_sound_decision_recovery.mjs',import.meta.url)));
  }
  if(boundedAssemblyPartScopeRevision!==undefined){
    editorIdentity.bounded_assembly_part_scope_revision=boundedAssemblyPartScopeRevision;
    editorIdentity.owned_part_consumer_projection_sha256=await hashFile(fileURLToPath(new URL('./assembly_consumer_projection.mjs',import.meta.url)));
  }
  if (boundedAssemblyProjectionRevision !== undefined) {
    editorIdentity.bounded_assembly_projection_revision = boundedAssemblyProjectionRevision;
    editorIdentity.mother_action_projection_sha256 = await hashFile(fileURLToPath(new URL('./bounded_mother_action_projection.mjs', import.meta.url)));
    editorIdentity.inline_record_encoding_sha256 = await hashFile(fileURLToPath(new URL('./bounded_inline_record_encoding.mjs', import.meta.url)));
    editorIdentity.bounded_continuation_sha256 = await hashFile(fileURLToPath(new URL('./bounded_assembly_continuation.mjs', import.meta.url)));
  }
  if (boundedAssemblyGapRecovery) {
    if (editorStrategy !== null) throw Error('automatic_bound_gap_actual_model_editor_required');
    editorIdentity.bounded_gap_classification_recovery = boundedAssemblyGapRecovery;
    editorIdentity.gap_runtime_sha256 = await hashFile(fileURLToPath(new URL('./bounded_assembly_gap_runtime.mjs', import.meta.url)));
    editorIdentity.gap_classification_sha256 = await hashFile(fileURLToPath(new URL('./bounded_assembly_gap_classification.mjs', import.meta.url)));
  }
  const automaticResearch = config.mode === 'research' && config.automatic_trial === true;
  await mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, 'automatic-state.json'), lockFile = path.join(directory, 'automatic.lock');
  const lock = await acquireLock(lockFile);
  await lock.writeFile(JSON.stringify({ pid: process.pid, source, started_at: now() }));
  let state, activeConfig = structuredClone(config), session = runtime.session, materialAdapters = {}, stageAudio = null,
    failedStoryPartRecovery = null, boundedAssemblyGapProof = null, boundSoundDecisionProof=null,
    filmTrialBudget=runtime.ensureBudget?null:runtime.session?.trialBudget??runtime.trialBudget;
  const configForStage = (base = activeConfig, { render = false,assembly = false } = {}) => {
    const {delivery_archive,render_decode_cache,sfx_audibility_repair,sfx_offline_repair_root,
      assembly_source_capacity_revision,assembly_gap_contract_revision,...stageConfig}=base;
    return { ...stageConfig,
    ...(assembly?Object.fromEntries(['assembly_source_capacity_revision','assembly_gap_contract_revision']
      .filter(key=>activeConfig[key]!==undefined).map(key=>[key,activeConfig[key]])):{}),
    ...(render && activeConfig.render_decode_cache !== undefined
      ? { render_decode_cache: structuredClone(activeConfig.render_decode_cache) } : {}),
    ...(render&&activeConfig.sfx_audibility_repair!==undefined
      ?{sfx_audibility_repair:structuredClone(activeConfig.sfx_audibility_repair)}:{}),
    ...(activeConfig.dialogue_intervals !== undefined ? { dialogue_intervals: activeConfig.dialogue_intervals }
      : stageAudio ? { dialogue_intervals: stageAudio.intervals } : {}),
    ...(stageAudio ? { local_audio_evidence: stageAudio.local,
      research_observation_files: [...new Set([...(base.research_observation_files ?? []),
        ...stageAudio.local.observation_files.map(row => row.path)])] } : {}),
  }; };
  const shared = () => session ? { ...runtime, ...materialAdapters, session,
    trialBudget: session.trialBudget ?? filmTrialBudget ?? runtime.trialBudget, createSession: undefined }
    : { ...runtime, ...materialAdapters, trialBudget:filmTrialBudget??runtime.trialBudget, session: undefined, createSession: runtime.createSession ? async input => {
      session = await runtime.createSession({ ...input, episode_id: runtime.episode_id ?? null,
        ...(failedStoryPartRecovery ? { failedStoryPartRecovery } : {}) }); return session;
    } : undefined };
  const persist = async () => {
    state.updated_at = now(); await atomicJson(stateFile, state);
    await atomicJson(path.join(directory, 'material-gap-queue.json'), { schema_version: 1, source,
      target_analysis: state.stages.analysis?.result?.artifact ?? null,
      gaps: state.gaps, resolver_attempts: state.resolver_attempts, production_approval: false });
    await runtime.onProgress?.({ episode_id: runtime.episode_id ?? null, status: state.status,
      checkpoint: stateFile, unresolved_gaps: state.gaps.filter(row => row.status !== 'resolved').length });
  };
  const finish = async (status, values = {}) => {
    const soundGaps = state.gaps.filter(row => row.stage === 'post_render_sound_coverage' && row.status !== 'resolved');
    if (status === 'director_trial_pending_audition' && soundGaps.length) {
      values = { ...values, render_status: status, sound_coverage_status: 'required_sound_coverage_incomplete',
        next_action: 'repair_only_bound_sound_materials_and_edit; preserve_rendered_diagnostic_and_other_episode_progress' };
      status = 'director_trial_with_sound_gaps';
    }
    Object.assign(state, { status, ...values }); await persist();
    const materialPreflight=state.stages.assembly?.result?.stage?.material_preflight;
    if(materialPreflight&&activeConfig.assembly_gap_contract_revision==='object-scoped-gap-v1'
      &&activeConfig.trial_review_policy==='diagnostic_candidates'&&isIndependentMusicPackTrial(activeConfig)
      &&activeConfig.sfx_library?.publication){
      const shortRoot=validateSfxOfflineRepairRoot(activeConfig);
      const outputDirectory=shortRoot?path.join(shortRoot,digest({job_root:directory,source,material_preflight:materialPreflight}))
        :path.join(directory,'assembly-sfx-offline-repair');
      try{
        state.assembly_required_sfx_offline_repair=await runAssemblyMaterialRequiredSfxOfflineRepair({state,
          materialPreflight,jobRoot:directory,outputDirectory,soundPublication:activeConfig.sfx_library.publication});
      }catch(error){
        state.assembly_required_sfx_offline_repair={status:'offline_sound_repair_evidence_gap',reason:error.message,
          new_model_calls:0,required_sound_gap_resolved:false,qualification_granted:false,production_approval:false};
      }
      values={...values,assembly_required_sfx_offline_repair:state.assembly_required_sfx_offline_repair};
      await persist();
    }
    if (soundGaps.length && activeConfig.trial_review_policy === 'diagnostic_candidates'
        && isIndependentMusicPackTrial(activeConfig) && activeConfig.sfx_library?.publication) {
      try {
        state.required_sfx_offline_repair = await runPostRenderRequiredSfxOfflineRepair({ state,
          gapQueue: await bind(path.join(directory, 'material-gap-queue.json')), jobRoot: directory,
          outputDirectory: path.join(directory, 'required-sfx-offline-repair'),
          soundPublication: activeConfig.sfx_library.publication });
      } catch (error) {
        state.required_sfx_offline_repair = { status: 'offline_sound_repair_evidence_gap',
          reason: error.message, new_model_calls: 0, qualification_granted: false, production_approval: false };
      }
      values = { ...values, required_sfx_offline_repair: state.required_sfx_offline_repair };
      await persist();
    }
    const checkpoint = await bind(stateFile);
    return { schema_version: 1, status, checkpoint, automatic_record: checkpoint, source_video: source,
      target_analysis: state.stages.analysis?.result?.artifact ?? null,
      target_materials: state.stages.materials?.result?.artifact ?? null,
      trial: state.stages.render?.result ?? null, render_registry: state.render_registry,
      ...(activeConfig.delivery_archive!==undefined?{delivery_archive:state.stages.delivery_archive?.result??null}:{}),
      gaps: state.gaps.filter(row => row.status !== 'resolved'), resolver_attempts: state.resolver_attempts,
      Ready: false, production_approval: false, actual_audio_listened: false,
      rendered:state.render_registry.length>0,
      quality_status:activeConfig.quality_review_policy==='automatic_required'?'not_accepted':'not_assessed',
      artistic_acceptance:activeConfig.quality_review_policy==='automatic_required'?'not_accepted'
        :state.render_registry.length ? 'awaiting_actual_audition' : 'not_assessed',
      fallback_performed: false, ...values };
  };
  const archiveCompletedRender = async registry => {
    if(activeConfig.delivery_archive===undefined)return;
    const policy=validateDeliveryArchiveConfig(activeConfig.delivery_archive);
    const exporterScript=fileURLToPath(new URL('./package_audio_handoff.py',import.meta.url));
    const archiveIdentity=digest({revision:policy.revision,policy,render_id:registry.render_id,
      rendered_result:registry.rendered_result,
      implementation_sha256:await hashFile(fileURLToPath(new URL('./closed_render_archive.mjs',import.meta.url))),
      exporter_sha256:await hashFile(exporterScript),python:activeConfig.python??null});
    let row=state.stages.delivery_archive;
    if(row?.identity===archiveIdentity&&row.status==='failed')return;
    if(row?.identity!==archiveIdentity){
      if(row)(state.stage_attempt_history??=[]).push({stage:'delivery_archive',...row});
      state.stages.delivery_archive=row={attempt:(row?.attempt??0)+1,status:'running',identity:archiveIdentity,
        render_id:registry.render_id,started_at:now(),account_requests:0,blocks_inference:false,blocks_render:false};
    }else row.status='running';
    // Save the closed render before any external copying. No archive lock/queue lives on S.
    await persist();
    let result;
    try{
      await verifyEvidenceBindings(registry);
      result=await archiveClosedRender({registry,config:policy,python:activeConfig.python,exporterScript});
    }catch(error){
      result={schema_version:1,kind:'append_only_closed_render_archive_stage',revision:policy.revision,
        status:'delivery_archive_failed',error:error.message,render_id:registry.render_id,
        original_render_status:registry.status,account_requests:0,moves:0,deletes:0,
        qualification_granted:false,blocks_inference:false,blocks_render:false,original_result_modified:false,
        next_action:'repair_only_delivery_archive; preserve_original_outputs_and_continue_other_episodes'};
    }
    const resultDirectory=path.join(directory,'delivery-archive');await mkdir(resultDirectory,{recursive:true});
    const resultFile=path.join(resultDirectory,`result-${row.attempt}-${randomUUID()}.json`);
    if(row.result_binding)(row.verification_history??=[]).push(row.result_binding);
    row.result_binding=await saveJson(resultFile,result);row.result=result;
    row.status=result.status==='delivery_archive_verified'?'completed':'failed';row.finished_at=now();
    await persist();
  };
  const holdChangeUntilReconciled = async (kind, requestedIdentity) => {
    const unresolved = unreconciledStages(state.stages);
    if (!unresolved.length) return null;
    // A changed publication/backend may reopen known material gaps, but may not
    // discard a call whose result is unknown. Keep its original request and clock.
    for (const item of unresolved) {
      const row = state.stages[item.stage];
      if (row.result_binding) await verifyEvidenceBindings(row.result_binding);
      if (row.result) await verifyStageResult(item.stage, row.result);
    }
    state.deferred_execution_change = { kind, requested_identity: requestedIdentity,
      unreconciled_stages: unresolved, recorded_at: now(), new_inference_calls: 0 };
    return finish('automatic_host_response_pending', {
      next_action: 'reconcile_bound_pending_request_using_recorded_configuration_before_reapplying_change',
      pending_change: state.deferred_execution_change, fallback_performed: false });
  };
  const recordFailureEvidence = async (target, error, stage, stageDirectory, filename = 'failure-evidence.json') => {
    try {
      const captured = await captureAutomaticStageFailure(error, { stage, source, episodeRoot: directory,
        stageDirectory, outputFile: path.join(stageDirectory, filename) });
      target.failure_evidence = captured.binding;
      target.failure_evidence_capture_errors = captured.document.capture_errors;
      // These convenience fields contain verified references only. The exact
      // reported references, including rejected ones, remain in the bound record.
      target.receipt_file = captured.document.primary_receipt?.path ?? null;
      target.cli_receipts = captured.document.receipt_entries.map(entry => entry.binding);
    } catch (cause) { target.failure_evidence_capture_error = cause.message; }
  };
  const invoke = async (name, action, success, recoveryName) => {
    let row = state.stages[name];
    if (row?.status === 'completed' || row?.status === 'waiting') {
      await verifyEvidenceBindings(row.result_binding); await verifyStageResult(name, row.result);
      if (row.status === 'waiting' && pending(row.result) && row.result.host_request && typeof runtime.resumeStage === 'function') {
        const requestBinding = row.result.host_request;
        await verifyEvidenceBindings(requestBinding);
        const request = await readJson(requestBinding.path);
        const responseFile = row.result.host_response_file ?? path.join(path.dirname(requestBinding.path), 'response.json');
        if (!await exists(responseFile)) return row.result;
        const responseBinding = await bind(responseFile);
        row.resume_attempts ??= [];
        if (row.resume_attempts.some(attempt => attempt.response.sha256 === responseBinding.sha256)) return row.result;
        const resumeAttempt = { request: requestBinding, response: responseBinding, status: 'consuming_bound_response', started_at: now() };
        row.resume_attempts.push(resumeAttempt); await persist();
        let consumed;
        const consumePendingRequest = async () => {
          if (consumed) return consumed;
          if (request.backend?.protocol !== 'codex_host_file') throw new Error('automatic_resume_importable_host_request_required');
          // This existing importer reads the exact recorded response. It cannot
          // submit a fresh CLI/API inference or create a different request.
          const importer = new HostFileSession({ directory: path.dirname(path.dirname(requestBinding.path)),
            backend: request.backend, media: request.payload.input_bindings });
          consumed = await importer.request(request.payload.role, request.payload.input);
          if (consumed.raw_response.sha256 !== responseBinding.sha256)
            throw new Error('automatic_resume_response_changed_during_consumption');
          return consumed;
        };
        try {
          const resumed = await runtime.resumeStage({ stage: name, episode_id: runtime.episode_id ?? null,
            config: structuredClone(activeConfig), source_video: source, pending_result: structuredClone(row.result),
            original_stage_directory: row.directory, request: requestBinding, response: responseBinding,
            original_request: request, target_analysis: state.stages.analysis?.result?.artifact ?? null,
            consumePendingRequest, runtime: shared(), checkpoint: stateFile });
          if (!consumed) throw new Error('automatic_resume_exact_pending_request_must_be_consumed');
          const resultBinding = resumed?.result_binding;
          if (!path.isAbsolute(resultBinding?.path ?? '') || !/^[a-f0-9]{64}$/.test(resultBinding?.sha256 ?? ''))
            throw new Error('automatic_resume_bound_completed_stage_result_required');
          await verifyEvidenceBindings(resultBinding);
          let result = await readJson(resultBinding.path);
          if (name === 'analysis') {
            const data = await stages.readTargetAnalysis(resultBinding, activeConfig);
            if (data.target.raw_response.sha256 !== consumed.raw_response.sha256)
              throw new Error('automatic_resume_analysis_exact_response_required');
            result = { ...data.target, artifact: resultBinding };
          } else {
            if (result.source_video_sha256 && result.source_video_sha256 !== source.sha256)
              throw new Error('automatic_resume_completed_stage_source_mismatch');
            if (name === 'direction' && !result.direction_binding && result.research_candidate)
              result = { ...result, direction_binding: result.research_candidate };
            if (name === 'render') result = normalizeRenderOutputs(result);
          }
          await verifyStageResult(name, result);
          if (!success(result)) throw new Error('automatic_resume_actual_completed_stage_required');
          resumeAttempt.status = 'completed'; resumeAttempt.completed_at = now();
          resumeAttempt.result_binding = resultBinding; resumeAttempt.consumed_response = consumed.raw_response;
          row.result = result; row.result_binding = resultBinding; row.status = 'completed'; row.finished_at = now();
          row.pending_request_consumed_without_new_inference = true; await persist();
        } catch (error) {
          resumeAttempt.status = 'failed'; resumeAttempt.error = error.message;
          await recordFailureEvidence(resumeAttempt, error, name, row.directory,
            `resume-failure-evidence-${row.resume_attempts.length}.json`);
          await persist(); throw error;
        }
      }
      return row.result;
    }
    if (row?.status === 'running') {
      const recovery = recoveryName && path.join(row.directory, recoveryName);
      if (!recovery || !await exists(recovery)) throw new Error(`automatic_interrupted_${name}_requires_bound_recovery`);
      const saved = await readJson(recovery), result = name === 'render' ? normalizeRenderOutputs(saved) : saved;
      await verifyStageResult(name, result);
      row.result = result; row.result_binding = await bind(recovery);
      row.status = success(result) ? 'completed' : 'waiting'; row.recovered_from_existing_receipt = true;
      await persist(); return result;
    }
    const attempt = (row?.attempt ?? 0) + 1, attemptDirectory = path.join(directory, name, `attempt-${attempt}`);
    await mkdir(path.dirname(attemptDirectory), { recursive: true });
    if (row) (state.stage_attempt_history ??= []).push({ stage: name, ...row });
    state.stages[name] = row = { status: 'running', attempt, directory: attemptDirectory, started_at: now() };
    delete state.error; delete state.next_action;
    state.status = name; await persist();
    try {
      const returned = await action(attemptDirectory), result = name === 'render' ? normalizeRenderOutputs(returned) : returned;
      if (!result || typeof result.status !== 'string') throw new Error(`automatic_${name}_status_required`);
      await verifyStageResult(name, result);
      row.result_binding = await saveJson(path.join(directory, name, `result-${attempt}.json`), result);
      row.result = result; row.status = success(result) ? 'completed' : 'waiting'; row.finished_at = now();
      await persist(); return result;
    } catch (error) {
      if (error instanceof HostResponsePendingError) {
        const result = { status: `${name}_host_response_pending`, source_video_sha256: source.sha256,
          host_request: await bind(error.request_file), host_response_file: error.response_file,
          unresolved: ['actual_host_response_pending'], actual_audio_listened: false, production_approval: false };
        row.result = result; row.result_binding = await saveJson(path.join(directory, name, `result-${attempt}.json`), result);
        row.status = 'waiting'; await persist(); return result;
      }
      row.status = 'failed'; row.error = error.message; row.finished_at = now();
      await recordFailureEvidence(row, error, name, row.directory);
      await persist(); throw error;
    }
  };
  try {
    const storyIdentity = digest({ source, config: storyConfig(config) });
    state = await exists(stateFile) ? await readJson(stateFile) : { schema_version: 1, kind: 'automatic_episode_controller',
      source, story_identity: storyIdentity, editor_identity: editorIdentity, status: 'queued', stages: {}, gaps: [], snapshots: [],
      resolver_attempts: [], render_registry: [], assembly_contract_version: config.assembly_contract_version ?? 1,
      sound_query_contract_version: config.sound_query_contract_version ?? 1, created_at: now() };
    if (state.source.sha256 !== source.sha256 || state.story_identity !== storyIdentity)
      throw new Error('automatic_source_or_story_controls_changed_requires_new_output');
    await verifyEvidenceBindings(state.render_registry);
    // This read-only capability check precedes every new analysis/material/model/render action.
    // Enabling review never invalidates completed story, selections or prior diagnostic renders.
    if(config.quality_review_policy==='automatic_required'){
      const readiness=await preflightPostRenderQuality(config,shared());
      const identity=digest(readiness);
      if(state.quality_readiness_identity!==identity){
        state.quality_readiness_history??=[];
        if(state.quality_readiness)state.quality_readiness_history.push(state.quality_readiness);
        const file=path.join(directory,'quality-readiness',`${identity}.json`);
        if(await exists(file)){
          if(digest(await readJson(file))!==identity)throw Error('automatic_quality_readiness_changed');
          state.quality_readiness=await bind(file);
        }else state.quality_readiness=await saveJson(file,readiness);
        state.quality_readiness_identity=identity;
      }else await verifyEvidenceBindings(state.quality_readiness);
      if(!readiness.ready)return finish('audio_review_backend_unavailable',{
        quality_readiness:state.quality_readiness,quality_status:'not_accepted',artistic_acceptance:'not_accepted',
        actual_audio_listened:false,manual_episode_audition_required:false,
        repair_dependencies:readiness.repair_dependencies,next_action:readiness.next_action});
    }
    if(config.quality_review_policy==='composite_research'){
      let readiness;
      try{
        const reviewer=shared().compositeReviewer;
        if(typeof reviewer!=='function'||typeof reviewer.getIdentity!=='function'||typeof shared().scopedRepair!=='function')
          throw Error('composite_research_real_runtime_adapters_required');
        const identity=await reviewer.getIdentity();await verifyEvidenceBindings(identity);
        readiness={ready:true,identity,read_only:true,new_model_calls:0,qualification_granted:false,production_approval:false};
      }catch(error){readiness={ready:false,reason:error.message,read_only:true,new_model_calls:0,
        qualification_granted:false,production_approval:false};}
      const key=digest(readiness),file=path.join(directory,'composite-readiness',key+'.json');
      state.composite_readiness=await exists(file)?await bind(file):await saveJson(file,readiness);
      if(!readiness.ready)return finish('composite_review_backend_unavailable',{composite_readiness:state.composite_readiness,
        quality_status:'not_assessed',actual_audio_listened:false,production_approval:false,new_model_calls:0});
    }
    if(typeof runtime.ensureBudget==='function')filmTrialBudget=await runtime.ensureBudget({config:activeConfig});
    if(activeConfig.trial_wall_clock_policy)await filmTrialBudget?.inspectLocal({stage:'automatic_analysis_preparation_admission'});
    let snapshot = await frozenMaterials(activeConfig);
    // A resolver may have published new stores and saved them before a process exit.
    if (state.active_frozen_config && snapshot.sha256 === state.initial_snapshot_sha256) {
      const resumed = structuredClone(state.active_frozen_config);
      if (config.assembly_contract_version !== undefined) resumed.assembly_contract_version = config.assembly_contract_version;
      if (config.sound_query_contract_version !== undefined) resumed.sound_query_contract_version = config.sound_query_contract_version;
      if(config.sfx_adoption_mode!==undefined)resumed.sfx_adoption_mode=config.sfx_adoption_mode;
      delete resumed.assembly_sfx_pool_contract_revision;
      if(config.assembly_sfx_pool_contract_revision!==undefined)
        resumed.assembly_sfx_pool_contract_revision=config.assembly_sfx_pool_contract_revision;
      // Render policy belongs to this invocation, not to an older material publication.
      delete resumed.final_mix_master;
      if(config.final_mix_master!==undefined)resumed.final_mix_master=structuredClone(config.final_mix_master);
      delete resumed.delivery_archive;
      if(config.delivery_archive!==undefined)resumed.delivery_archive=structuredClone(config.delivery_archive);
      delete resumed.render_decode_cache;
      if(config.render_decode_cache!==undefined)resumed.render_decode_cache=structuredClone(config.render_decode_cache);
      delete resumed.sfx_audibility_repair;
      if(config.sfx_audibility_repair!==undefined)resumed.sfx_audibility_repair=structuredClone(config.sfx_audibility_repair);
      delete resumed.independent_music_comparison_policy;
      if(config.independent_music_comparison_policy!==undefined)
        resumed.independent_music_comparison_policy=structuredClone(config.independent_music_comparison_policy);
      for(const key of ['assembly_source_capacity_revision','assembly_gap_contract_revision','trial_wall_clock_policy','sfx_offline_repair_root','review_input_limit_policy']){
        delete resumed[key];if(config[key]!==undefined)resumed[key]=structuredClone(config[key]);
      }
      if(config.codex_cli?.sfx_event_function_revision!==undefined)
        resumed.codex_cli={...resumed.codex_cli,sfx_event_function_revision:config.codex_cli.sfx_event_function_revision};
      if(resumed.codex_cli&&Object.hasOwn(resumed.codex_cli,'director_source_range_revision')){
        const{director_source_range_revision,...rest}=resumed.codex_cli;resumed.codex_cli=rest;
      }
      if(config.codex_cli?.director_source_range_revision!==undefined)
        resumed.codex_cli={...resumed.codex_cli,director_source_range_revision:config.codex_cli.director_source_range_revision};
      if(resumed.codex_cli&&Object.hasOwn(resumed.codex_cli,'direction_sound_propulsion_revision')){
        const{direction_sound_propulsion_revision,...rest}=resumed.codex_cli;resumed.codex_cli=rest;
      }
      if(propulsionRevision!==undefined)resumed.codex_cli={...resumed.codex_cli,direction_sound_propulsion_revision:propulsionRevision};
      if (digest({ source, config: storyConfig(resumed) }) !== storyIdentity) throw new Error('automatic_saved_story_controls_changed');
      activeConfig = resumed; snapshot = await frozenMaterials(activeConfig);
    }
    if (boundedAssemblyGapRecovery) {
      if (state.current_snapshot_sha256 !== snapshot.sha256)
        throw Error('automatic_bound_gap_material_snapshot_changed');
      boundedAssemblyGapProof = await preflightBoundAssemblyGapControllerRecovery(boundedAssemblyGapRecovery,
        { config: activeConfig, source, state });
    }
    if(boundSoundDecisionRecovery){
      if(state.current_snapshot_sha256!==snapshot.sha256)throw Error('automatic_sound_decision_material_snapshot_changed');
      const {preflightBoundSoundDecisionControllerRecovery}=await import('./bound_sound_decision_recovery.mjs');
      boundSoundDecisionProof=await preflightBoundSoundDecisionControllerRecovery(boundSoundDecisionRecovery,
        {config:activeConfig,source,state});
    }
    const assemblyVersion = activeConfig.assembly_contract_version ?? 1, previousAssemblyVersion = state.assembly_contract_version ?? 1;
    if (assemblyVersion !== previousAssemblyVersion) {
      const held = await holdChangeUntilReconciled('assembly_contract', { assembly_contract_version: assemblyVersion });
      if (held) return held;
      state.assembly_contract_history ??= [];
      state.assembly_contract_history.push({ from_version: previousAssemblyVersion, to_version: assemblyVersion, changed_at: now(),
        stages: Object.fromEntries(['assembly', 'render'].filter(key => state.stages[key]).map(key => [key, state.stages[key]])) });
      for (const name of ['assembly', 'render']) if (state.stages[name])
        state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_assembly_contract' };
      if (state.active_frozen_config && config.assembly_contract_version !== undefined)
        state.active_frozen_config.assembly_contract_version = config.assembly_contract_version;
    }
    state.assembly_contract_version = assemblyVersion;
    if (canonical(state.editor_identity ?? null) !== canonical(editorIdentity)) {
      const held = await holdChangeUntilReconciled('editor_strategy', editorIdentity);
      if (held) return held;
      (state.editor_strategy_history ??= []).push({ previous: state.editor_identity ?? null, next: editorIdentity,
        changed_at: now(), stages: Object.fromEntries(['assembly', 'render'].filter(key => state.stages[key])
          .map(key => [key, state.stages[key]])) });
      for (const name of ['assembly', 'render']) if (state.stages[name])
        state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_editor_strategy' };
    }
    state.editor_identity = editorIdentity;
    const soundQueryVersion = activeConfig.sound_query_contract_version ?? 1,
      previousSoundQueryVersion = state.sound_query_contract_version ?? 1;
    if (soundQueryVersion !== previousSoundQueryVersion) {
      const held = await holdChangeUntilReconciled('sound_query_contract', { sound_query_contract_version: soundQueryVersion });
      if (held) return held;
      state.sound_query_contract_history ??= [];
      state.sound_query_contract_history.push({ from_version: previousSoundQueryVersion, to_version: soundQueryVersion, changed_at: now(),
        stages: Object.fromEntries(['direction', 'materials', 'publish', 'assembly', 'render']
          .filter(key => state.stages[key]).map(key => [key, state.stages[key]])) });
      for (const name of ['direction', 'materials', 'publish', 'assembly', 'render']) if (state.stages[name])
        state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_sound_query_contract' };
      if (state.active_frozen_config && config.sound_query_contract_version !== undefined)
        state.active_frozen_config.sound_query_contract_version = config.sound_query_contract_version;
    }
    state.sound_query_contract_version = soundQueryVersion;
    if (!state.initial_snapshot_sha256) state.initial_snapshot_sha256 = snapshot.sha256;
    if (state.current_snapshot_sha256 && state.current_snapshot_sha256 !== snapshot.sha256) {
      const held = await holdChangeUntilReconciled('material_snapshot', { snapshot_sha256: snapshot.sha256 });
      if (held) return held;
      state.material_history ??= []; state.material_history.push({ snapshot_sha256: state.current_snapshot_sha256,
        stages: Object.fromEntries(['materials', 'publish', 'assembly', 'render'].filter(key => state.stages[key]).map(key => [key, state.stages[key]])) });
      for (const name of ['materials', 'publish', 'assembly', 'render']) {
        if (state.stages[name]) state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_material_snapshot' };
      }
    }
    state.current_snapshot_sha256 = snapshot.sha256;
    if (!state.snapshots.some(row => row.sha256 === snapshot.sha256)) state.snapshots.push(snapshot);
    await persist();
    let analysis;
    if (activeConfig.target_analysis && state.stages.analysis?.status !== 'completed') {
      const data = await stages.readTargetAnalysis(activeConfig.target_analysis, activeConfig);
      analysis = { ...data.target, artifact: activeConfig.target_analysis, supplied_analysis_reused: true };
      const attempt = (state.stages.analysis?.attempt ?? 0) + 1;
      state.stages.analysis = { status: 'completed', attempt, result: analysis,
        result_binding: await saveJson(path.join(directory, 'analysis', `result-${attempt}.json`), analysis) };
      await persist();
    } else {
      const priorAnalysis = state.stages.analysis;
      let resumeAnalysisDirectory = priorAnalysis?.directory;
      let analysisPreparationRecovery=null;
      const preparationProof=await verifyZeroCallStoryCapacityPreparation({analysisStage:priorAnalysis,
        budget:shared().trialBudget,source,directory});
      if(preparationProof){
        const file=path.join(directory,'analysis-preparation-recoveries',preparationProof.stop.sha256+'.json');
        analysisPreparationRecovery=await exists(file)?await bind(file):await saveJson(file,preparationProof);
        await verifyEvidenceBindings(analysisPreparationRecovery);
        if(canonical(await readJson(file))!==canonical(preparationProof))throw Error('automatic_analysis_preparation_recovery_changed');
        state.analysis_preparation_reuse_proofs??=[];
        if(!state.analysis_preparation_reuse_proofs.some(ref=>ref.sha256===analysisPreparationRecovery.sha256))
          state.analysis_preparation_reuse_proofs.push(analysisPreparationRecovery);
        await persist();
      }
      if (priorAnalysis?.status === 'failed' && priorAnalysis.failure_evidence && priorAnalysis.directory
        && (runtime.storyPartEvidenceRepair ?? activeConfig.codex_cli?.story_part_evidence_repair) === 'evidence_ids_once') {
        const { resolveFailedStoryPartFromCheckpoint } = await import('./story_part_evidence_repair.mjs');
        const recovery = await resolveFailedStoryPartFromCheckpoint(state, { source, episodeRoot: directory,
          outputDirectory: path.join(directory, 'recorded-analysis-recoveries', priorAnalysis.failure_evidence.sha256) });
        if (recovery.binding) failedStoryPartRecovery = recovery.binding;
        if (recovery.binding && recovery.resume_directory) resumeAnalysisDirectory = recovery.resume_directory;
        state.failed_story_part_recovery_dispatches ??= []; state.failed_story_part_recovery_dispatches.push(recovery);
        await persist();
        if (recovery.status === 'story_part_evidence_repair_already_attempted')
          return finish('automatic_story_part_evidence_gap', { recovery, error: priorAnalysis.error,
            next_action: recovery.next_action, failure_evidence: priorAnalysis.failure_evidence,
            receipt_file: priorAnalysis.receipt_file ?? null, cli_receipts: priorAnalysis.cli_receipts ?? [] });
      }
      analysis = await invoke('analysis', out => {
        const input={...activeConfig,output_dir:out};delete input.delivery_archive;delete input.render_decode_cache;
        delete input.sfx_audibility_repair;
        delete input.sfx_offline_repair_root;
        delete input.independent_music_comparison_policy;
        delete input.assembly_source_capacity_revision;delete input.assembly_gap_contract_revision;
        if(input.codex_cli&&Object.hasOwn(input.codex_cli,'direction_sound_propulsion_revision')){
          const{direction_sound_propulsion_revision,...storyCli}=input.codex_cli;input.codex_cli=storyCli;
        }
        return priorAnalysis?.status === 'failed'
          && (priorAnalysis.error === 'codex_episode_capacity_gap' || failedStoryPartRecovery || analysisPreparationRecovery) && resumeAnalysisDirectory
          ? stages.resumePartialTargetAnalysis(input, {...shared(),...(analysisPreparationRecovery?{analysisPreparationRecovery}:{})}, { directory: resumeAnalysisDirectory })
          : stages.analyzeTarget(input, shared());
      }, completedAnalysis, 'target-analysis.json');
    }
    if (!completedAnalysis(analysis)) {
      state.gaps = structuredGaps(analysis, source, 'analysis', snapshot, analysis);
      return finish(analysis.status, { next_action: pending(analysis)
        ? 'complete_bound_pending_analysis_then_supply_target_analysis; do_not_replay_pending_call'
        : 'resolve_specific_analysis_coverage_before_materials' });
    }
    if (activeConfig.mode === 'research' && !automaticResearch) return finish('target_analysis_complete', { material_needs: analysis.material_needs });
    stageAudio = await sourceAudioForStages(analysis, activeConfig, source);
    // Cached analysis never calls the factory itself. A fresh process still needs
    // real material adapters and a same-source restored session before uncached work.
    if (!session && runtime.createSession) {
      let frames = state.stages.direction?.result?.frames ?? [];
      if (analysis.analysis_request) {
        await verifyEvidenceBindings(analysis.analysis_request);
        const request = await readJson(analysis.analysis_request.path);
        frames = (request.bindings ?? []).filter(row => row.kind === 'frame').map(row => ({ ...row,
          timeline_seconds: request.evidence_catalog.find(item => item.id === row.id)?.timeline_seconds }));
      }
      const hostDirectory = path.join(directory, 'resumed-sessions', randomUUID());
      await mkdir(hostDirectory, { recursive: true });
      let failedRouteRecovery=null,failedUnknownRangeRecovery=null;
      const explicitDirectionRecovery = runtime.typedStyleFailedRouteRecoveries?.[source.sha256]
        ?? runtime.typedStyleRouteRecoveries?.[source.sha256] ?? runtime.directionRecoveries?.[source.sha256]
        ??runtime.typedStyleFailedUnknownRangeRecoveries?.[source.sha256];
      if(!explicitDirectionRecovery && state.stages.direction?.status==='failed'&&state.stages.direction.failure_evidence){
        const recovery=await resolvePersistedFailedNativeRoute(state.stages.direction.failure_evidence,{source,
          episodeRoot:directory,outputDirectory:path.join(hostDirectory,'recorded-stage-recovery')});
        if(recovery.binding)failedRouteRecovery=recovery.binding;
        state.failed_route_recovery_dispatches??=[];state.failed_route_recovery_dispatches.push(recovery);
        if(!recovery.binding&&activeConfig.codex_cli?.director_contract==='typed_bounded_v1'){
          const range=await resolvePersistedFailedUnknownRange(state.stages.direction.failure_evidence,{source,
            episodeRoot:directory,outputDirectory:path.join(hostDirectory,'recorded-stage-recovery')});
          if(range.binding)failedUnknownRangeRecovery=range.binding;
          (state.failed_unknown_range_recovery_dispatches??=[]).push(range);
        }
        await persist();}
      session = await runtime.createSession({ config: configForStage(), directory: hostDirectory, source, media: [source],
        episode_id: runtime.episode_id ?? null,...(failedRouteRecovery?{failedRouteRecovery}:{}),
        ...(failedUnknownRangeRecovery?{failedUnknownRangeRecovery}:{}) });
      if (typeof session?.restoreTargetAnalysis === 'function') {
        const restored = await session.restoreTargetAnalysis(analysis.artifact, frames);
        state.session_restores ??= []; state.session_restores.push({ restored, restored_at: now(), new_story_calls: 0 });
      }
    }
    const adapted = await createEpisodeMaterialRuntime({ ...runtime, ...session?.materialRuntime, session, createSession: undefined });
    materialAdapters = Object.fromEntries(['sfxMaterialObserver', 'sfxMaterialObserverBatch', 'sfxMaterialObserver_backend_id',
      'sfxMaterialObserver_model_revision', 'sfxAnchorMeasurer',
      'materialObserver', 'materialObserverBatch', 'materialObserver_backend_id', 'materialObserver_model_revision',
      'materialObserver_audio_backend', 'materialSelector', 'materialSelector_backend_id', 'materialSelector_model_revision',
      'materialPlanner'].filter(key => adapted[key] !== undefined).map(key => [key, adapted[key]]));
    materialAdapters = await refreshFrozenMaterialAdapters(activeConfig, materialAdapters);
    let executionIdentity = { ...await materialRuntimeIdentity({ ...runtime, ...materialAdapters }, activeConfig, session, source.sha256),
      sound_bridge_sha256: await hashFile(fileURLToPath(new URL('./target_sfx_material_bridge.mjs', import.meta.url))),
      sound_catalog_function_resolution_sha256: await hashFile(fileURLToPath(new URL('./sound_catalog_function_resolution.mjs', import.meta.url))),
      source_audio_evidence_sha256: stageAudio?.sha256 ?? null }, executionSha = digest(executionIdentity);
    if (boundedAssemblyGapProof||boundSoundDecisionProof) {
      const requested = executionIdentity;
      executionIdentity = preserveBoundAssemblyMaterialIdentity(state.material_runtime_identity, requested);
      executionSha = digest(executionIdentity);
      if (executionSha !== state.material_runtime_sha256) throw Error('automatic_bound_gap_original_material_identity_changed');
      (state.bound_assembly_material_reuse ??= []).push({ recovery: boundedAssemblyGapRecovery??boundSoundDecisionRecovery,
        materials_result: (boundedAssemblyGapProof??boundSoundDecisionProof).materials_result,
        old_material_runtime_identity: executionIdentity, requested_material_runtime_identity: requested,
        completed_material_execution_reused: true, new_material_policy_executed: false,
        qualification_granted: false, production_approval: false, reused_at: now() });
    }
    const readerReuse=automaticResearch?await revalidateCompletedMaterialsAfterReaderUpgrade({state,
      requestedIdentity:executionIdentity,snapshotSha:snapshot.sha256,source,episodeRoot:directory}):null;
    if(readerReuse){
      if(state.stages.materials)(state.stage_attempt_history??=[]).push({stage:'materials',...state.stages.materials,
        status:state.stages.materials.status==='running'?'superseded_interrupted':state.stages.materials.status,
        original_status:state.stages.materials.status,unknown_request_and_budget_preserved:true});
      state.stages.materials=readerReuse.stage;
      (state.material_reader_revalidations??=[]).push({...readerReuse.proof,revalidated_at:now()});
    }
    if (!readerReuse&&state.material_runtime_sha256 && state.material_runtime_sha256 !== executionSha) {
      const held = await holdChangeUntilReconciled('material_runtime', { sha256: executionSha, identity: executionIdentity });
      if (held) return held;
      state.material_history ??= []; state.material_history.push({ snapshot_sha256: snapshot.sha256,
        material_runtime_identity: state.material_runtime_identity,
        stages: Object.fromEntries(['materials', 'publish', 'assembly', 'render'].filter(key => state.stages[key]).map(key => [key, state.stages[key]])) });
      for (const name of ['materials', 'publish', 'assembly', 'render']) if (state.stages[name])
        state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_material_runtime_identity' };
    }
    state.material_runtime_identity = executionIdentity; state.material_runtime_sha256 = executionSha; await persist();
    let direction;
    if (automaticResearch) {
      if(propulsionRevision!==undefined||state.direction_propulsion_identity!==undefined){
        const identity=propulsionRevision===undefined?null:{revision:propulsionRevision,
          implementations:Object.fromEntries(await Promise.all(['direction_sound_propulsion.mjs',
            'typed_bounded_style_director.mjs','compose_episode.mjs'].map(async file=>
              [file,await hashFile(fileURLToPath(new URL('./'+file,import.meta.url)))])))};
        if(canonical(state.direction_propulsion_identity??null)!==canonical(identity)){
          const held=await holdChangeUntilReconciled('direction_propulsion',identity);if(held)return held;
          (state.direction_propulsion_history??=[]).push({previous:state.direction_propulsion_identity??null,next:identity,
            changed_at:now(),stages:Object.fromEntries(['direction','materials','publish','assembly','render']
              .filter(key=>state.stages[key]).map(key=>[key,state.stages[key]]))});
          for(const name of['direction','materials','publish','assembly','render'])if(state.stages[name])
            state.stages[name]={attempt:state.stages[name].attempt,status:'invalidated_direction_propulsion'};
        }
        state.direction_propulsion_identity=identity;await persist();
      }
      direction = await invoke('direction', out => stages.prepareResearchDirection(configForStage({ ...activeConfig, output_dir: out }),
        analysis.artifact, shared()), value => Boolean(value.direction_binding));
      if (!direction.direction_binding) {
        state.gaps = structuredGaps(direction, source, 'direction', snapshot, analysis);
        return finish(direction.status);
      }
    }
    let materialRetries = 0;
    while (true) {
      const materials = await invoke('materials', async out => automaticResearch
        ? stages.prepareTargetResearchMaterials({ config: configForStage(), analysisBinding: analysis.artifact,
          directionBinding: direction.direction_binding, frames: direction.frames ?? [],
          session, runtime: { ...shared(),
            ...(activeConfig.material_strategy==='independent_music_packs'?{sameJobCompletedMaterialRecovery:{
              revision:sameJobMaterialRecoveryRevision,checkpoint:await bind(stateFile),attempt_directory:out,
              analysis:analysis.artifact,direction:direction.direction_binding}}:{}) }, outputDir: out })
        : stages.prepareTargetMaterials(configForStage({ ...activeConfig, output_dir: out }), analysis.artifact, shared()),
      value => value.status === (automaticResearch ? 'target_research_materials_selected' : 'target_materials_prepared'),
      automaticResearch ? null : 'target-material-preparation.json');
      let gapResult = materials, gapStage = 'materials';
      if (materials.status === (automaticResearch ? 'target_research_materials_selected' : 'target_materials_prepared')) {
        for (const gap of state.gaps) if (gap.stage === 'materials') gap.status = 'resolved';
        let renderBinding = materials.prepared_render_config;
        if (automaticResearch) {
          const assembled = await invoke('assembly', out => stages.assembleResearchEpisode(configForStage({ ...activeConfig,
            ...materials.prepared_assembly_config, mode: 'research', strategy: 'current_director_research',
            assembly_contract_version: activeConfig.assembly_contract_version ?? 1,
            editor_strategy: editorStrategy ?? undefined,
            ...(boundedAssemblyProjectionRevision !== undefined ? { bounded_assembly_projection_revision: boundedAssemblyProjectionRevision } : {}),
            ...(boundedAssemblyPartScopeRevision!==undefined?{bounded_assembly_part_scope_revision:boundedAssemblyPartScopeRevision}:{}),
            ...(soundEditDecisionContractRevision!==undefined?{sound_edit_decision_contract_revision:soundEditDecisionContractRevision}:{}),
            ...(editorAuthorization ? { research_trial_authorization: editorAuthorization } : {}),
            output_dir: out, render: false },{assembly:true}), shared()), value => value.status === 'research_episode_config_frozen', 'assembly-record.json');
          if (assembled.status !== 'research_episode_config_frozen') {
            // The host can detect a required adoption gap after a model reports
            // no strings. Keep its typed object/clock and all original text;
            // legacy results without scoped records retain their old behavior.
            const assemblyGaps=assembled.gap_records?.length?assembled.gap_records.map(row=>({...row,
              original_execution_gaps:structuredClone(assembled.execution_gaps??[])})):assembled.execution_gaps;
            state.gaps = structuredGaps({ ...assembled, unresolved: assemblyGaps }, source, 'assembly', snapshot, analysis);
            return finish(assembled.status);
          }
          renderBinding = assembled.render_config;
        } else {
          const release = await invoke('publish', out => stages.publishTargetReadiness(materials.preparation_receipt,
            { outputDirectory: out, renderConfigBinding: materials.prepared_render_config }),
          value => value.status === 'target_release_published');
          if (release.status !== 'target_release_published') return finish(release.status);
        }
        await verifyEvidenceBindings(renderBinding);
        const {final_mix_master:boundMaster,sfx_audibility_repair:boundSfxAudibility,...renderConfig}=await readJson(renderBinding.path);
        if(activeConfig.final_mix_master!==undefined)
          renderConfig.final_mix_master=validateFinalMixMasterConfig(activeConfig.final_mix_master);
        if(activeConfig.sfx_audibility_repair!==undefined)
          renderConfig.sfx_audibility_repair=(await import('./sfx_audibility_repair.mjs')).validateSfxAudibilityRepairPolicy(activeConfig.sfx_audibility_repair);
        // Legacy missing-policy tasks retain their old cache identity. Once explicitly
        // enabled, enabling/disabling or changing the actual renderer reopens only render
        // and its consumers; authored assembly and selections remain immutable.
        if(activeConfig.final_mix_master!==undefined||activeConfig.sfx_audibility_repair!==undefined||state.render_identity!==undefined){
          const modules=['render_research_trial.mjs','run_sound_job.mjs','render_audio.mjs',
            'render_binding.mjs','final_mix_master.mjs','export_preview.mjs',
            'music_source_delivery_gate.mjs','music_source_budget.mjs',
            'actual_pcm_source_clock.mjs','actual_pcm_source_clock.py','independent_recording_checks.py'];
          if(activeConfig.sfx_audibility_repair!==undefined)modules.push('sfx_audibility_repair.mjs');
          const renderIdentity={revision:'explicit-final-mix-render-identity-v1',render_config:renderBinding,
            final_mix_master:activeConfig.final_mix_master??null,
            ...(activeConfig.sfx_audibility_repair!==undefined?{sfx_audibility_repair:activeConfig.sfx_audibility_repair}:{}),
            implementations:Object.fromEntries(await Promise.all(modules.map(async file=>
              [file,await hashFile(fileURLToPath(new URL('./'+file,import.meta.url)))])))};
          if(canonical(state.render_identity??null)!==canonical(renderIdentity)){
            const held=await holdChangeUntilReconciled('render_policy',renderIdentity);
            if(held)return held;
            const affected=['render','quality_review','research_audio_screen','composite_review','composite_render','composite_recheck'];
            const previousStages=Object.fromEntries(affected.filter(name=>state.stages[name])
              .map(name=>[name,state.stages[name]]));
            if(Object.keys(previousStages).length)(state.render_policy_history??=[]).push({
              previous:state.render_identity??null,next:renderIdentity,changed_at:now(),stages:previousStages});
            for(const name of affected)if(state.stages[name])state.stages[name]={
              attempt:state.stages[name].attempt,status:'invalidated_render_policy'};
            state.render_identity=renderIdentity;await persist();
          }
        }
        const rendered = await invoke('render', async out => {
          if(activeConfig.quality_review_policy==='composite_research')
            await shared().trialBudget.inspectLocal({stage:'composite_first_render',useRenderReserve:true});
          return stages.renderResearchTrial(configForStage({ ...renderConfig, output_dir: out }, { render: true }), shared());
        }, value => Boolean(value.audio_dir), 'trial-record.json');
        if (rendered.audio_dir) {
          for (const gap of state.gaps) if (['materials', 'assembly', 'render', 'render_source_budget'].includes(gap.stage))
            gap.status = 'resolved';
          const resultBinding = state.stages.render.result_binding;
          const files = [], report = path.join(rendered.audio_dir, 'report.json');
          if (await exists(report)) files.push(await bind(report));
          if (rendered.preview) files.push(await bind(rendered.preview));
          // Short-sample stems are separate deliverables; register their actual identities too.
          for (const evidence of [rendered.diagnostic_sample_receipt,
            rendered.whole_episode_intermediate_preview,
            ...Object.values(rendered.diagnostic_sample?.stems ?? {})]) {
            if (!evidence) continue;
            await verifyEvidenceBindings(evidence);
            if (!files.some(row => path.resolve(row.path) === path.resolve(evidence.path)))
              files.push(await bind(evidence.path));
          }
          for (const file of Object.values(rendered.render?.outputs ?? {})) {
            const outputPath = typeof file === 'string' ? file : file?.path;
            if (outputPath && path.isAbsolute(outputPath) && await exists(outputPath)) files.push(await bind(outputPath));
          }
          if (!files.length) throw new Error('automatic_render_actual_output_evidence_required');
          const id = digest({ source, resultBinding });
          if (!state.render_registry.some(row => row.render_id === id)) state.render_registry.push({ render_id: id,
            source_video: source, target_analysis: analysis.artifact, frozen_snapshot_sha256: snapshot.sha256,
            rendered_result: resultBinding, files, status: rendered.status, registered_at: now(),
            artistic_acceptance: 'awaiting_actual_audition', production_approval: false });
          const soundCoverage = await readPostRenderSoundGaps(rendered, resultBinding, source);
          for (const gap of state.gaps) if (gap.stage === 'post_render_sound_coverage') gap.status = 'resolved';
          if (soundCoverage.gaps.length) state.gaps.push(...structuredGaps({
            status: soundCoverage.status, unresolved: soundCoverage.gaps }, source,
            'post_render_sound_coverage', snapshot, analysis));
          await archiveCompletedRender(state.render_registry.find(row=>row.render_id===id));
          if (config.quality_review_policy === 'automatic_required' && soundCoverage.gaps.length)
            return finish('director_trial_with_sound_gaps', { render_status: rendered.status,
              preview: rendered.preview ?? null, audio_dir: rendered.audio_dir,
              render_calls: state.render_registry.length, quality_status: 'not_accepted',
              sound_coverage_status: soundCoverage.status, artistic_acceptance: 'not_accepted',
              next_action: 'repair_only_bound_required_sound_gaps_before_quality_acceptance' });
          if(config.quality_review_policy==='automatic_required'){
            const identity=digest({render:resultBinding,analysis:analysis.artifact,readiness:state.quality_readiness,
              implementation:await hashFile(fileURLToPath(new URL('./post_render_quality_review.mjs',import.meta.url))),
              action_execution_audit:await hashFile(fileURLToPath(new URL('./music_action_execution_audit.mjs',import.meta.url)))});
            if(state.quality_review_identity!==identity){
              const held=await holdChangeUntilReconciled('quality_review_inputs',{identity});
              if(held)return held;
              if(state.stages.quality_review){
                (state.stage_attempt_history??=[]).push({stage:'quality_review',...state.stages.quality_review});
                state.stages.quality_review={attempt:state.stages.quality_review.attempt,status:'invalidated_quality_inputs'};
              }
              state.quality_review_identity=identity;
            }
            const review=await invoke('quality_review',out=>stages.reviewRenderedEpisode({source,render_binding:resultBinding,
              analysis_binding:analysis.artifact,config,output_dir:out,render_files:files,
              cache_dir:path.join(directory,'quality-review-cache')},shared()),
              value=>typeof value.quality_status==='string','quality-review-record.json');
            const verified=await verifyPostRenderQualityReview(state.stages.quality_review.result_binding,
              {source,render_binding:resultBinding,render_files:files,readiness:await readJson(state.quality_readiness.path)});
            const accepted=verified.accepted;
            // A synthetic hook cannot upgrade the actual listener or publish a production approval.
            if(runtime.execution_kind==='injected_test_transport'&&accepted)throw Error('synthetic_quality_acceptance_forbidden');
            return finish(review.status,{render_status:rendered.status,rendered:true,
              preview:rendered.preview??null,audio_dir:rendered.audio_dir,render_calls:state.render_registry.length,
              quality_review:state.stages.quality_review.result_binding,quality_status:accepted?'accepted':'not_accepted',
              artistic_acceptance:accepted?'accepted_for_this_rendition':'not_accepted',
              actual_audio_listened:verified.actual_audio_listened,manual_episode_audition_required:false,
              repair_dependencies:review.repair_dependencies??[],next_action:review.next_action});
          }
          if(config.quality_review_policy==='composite_research'){
            let currentRendered=rendered,currentBinding=resultBinding,currentFiles=files,firstReview;
            const compositeVerification={allowInjectedTestTransport:runtime.execution_kind==='injected_test_transport'};
            try{
              const adapter=shared().compositeReviewer;
              if(typeof adapter!=='function'||typeof adapter.getIdentity!=='function'||typeof shared().scopedRepair!=='function')
                throw Error('composite_research_real_runtime_adapters_required');
              const observerIdentity=await adapter.getIdentity();await verifyEvidenceBindings(observerIdentity);
              const identity=digest({revision:compositeResearchRevision,render:resultBinding,observerIdentity,
                config:activeConfig.composite_review,...(activeConfig.review_input_limit_policy
                  ?{review_input_limit_policy:activeConfig.review_input_limit_policy}:{}),controller:await hashFile(fileURLToPath(import.meta.url))});
              if(state.composite_review_identity!==identity){
                const held=await holdChangeUntilReconciled('composite_review_inputs',{identity});if(held)return held;
                for(const name of ['composite_review','composite_repair','composite_render','composite_recheck'])if(state.stages[name]){
                  (state.stage_attempt_history??=[]).push({stage:name,...state.stages[name]});
                  state.stages[name]={attempt:state.stages[name].attempt,status:'invalidated_composite_inputs'};
                }
                state.composite_review_identity=identity;await persist();
              }
              const reviewInput={source,render_binding:resultBinding,render_files:files,analysis_binding:analysis.artifact,
                direction_binding:direction.direction_binding,prior_review_binding:null};
              firstReview=await invoke('composite_review',out=>adapter({...reviewInput,output_dir:out},shared()),
                value=>['composite_review_needs_repair','composite_review_unresolved','composite_research_passed'].includes(value.status));
              firstReview=await verifyCompositeReview(firstReview.artifact,reviewInput,compositeVerification);
              let finalReview=firstReview,reviewBinding=state.stages.composite_review.result.artifact;
              if(firstReview.issues.length){
                const admission={review:reviewBinding,assembly:state.stages.assembly.result_binding,
                  issue_ids:firstReview.issues.map(i=>i.issue_id)};
                if(state.composite_repair_admission&&canonical(state.composite_repair_admission)!==canonical(admission))
                  throw Error('composite_research_single_repair_round_already_consumed');
                state.composite_repair_admission??=admission;await persist();
                const repairInput={source,assembly_binding:admission.assembly,render_binding:resultBinding,
                  review_binding:reviewBinding,issue_ids:admission.issue_ids};
                const repair=await invoke('composite_repair',out=>shared().scopedRepair({...repairInput,output_dir:out},shared()),
                  value=>value.status==='scoped_repair_applied');
                await verifyCompositeRepair(repair.artifact,repairInput,compositeVerification);
                const repairedAssembly=await readJson(repair.assembly_binding.path);
                await verifyEvidenceBindings(repairedAssembly.render_config);
                const repairedConfig=await readJson(repairedAssembly.render_config.path);
                currentRendered=await invoke('composite_render',async out=>{
                  await shared().trialBudget.inspectLocal({stage:'composite_repair_render',useRenderReserve:true});
                  return normalizeRenderOutputs(await stages.renderResearchTrial(configForStage({...repairedConfig,output_dir:out},{render:true}),shared()));
                },value=>Boolean(value.audio_dir),'trial-record.json');
                if(!currentRendered.audio_dir)throw Error('composite_research_repaired_render_failed');
                currentBinding=state.stages.composite_render.result_binding;currentFiles=[];
                for(const file of [path.join(currentRendered.audio_dir,'report.json'),currentRendered.preview,
                  ...Object.values(currentRendered.render?.outputs??{}).map(v=>typeof v==='string'?v:v.path)])
                  if(file&&path.isAbsolute(file)&&await exists(file))currentFiles.push(await bind(file));
                if(!currentFiles.length||!currentRendered.preview)throw Error('composite_research_repaired_delivered_preview_required');
                const repairedId=digest({source,resultBinding:currentBinding});
                if(!state.render_registry.some(row=>row.render_id===repairedId))state.render_registry.push({render_id:repairedId,
                  source_video:source,target_analysis:analysis.artifact,frozen_snapshot_sha256:snapshot.sha256,
                  rendered_result:currentBinding,files:currentFiles,status:currentRendered.status,registered_at:now(),
                  scoped_repair:repair.artifact,artistic_acceptance:'awaiting_actual_audition',production_approval:false});
                await persist();await archiveCompletedRender(state.render_registry.find(row=>row.render_id===repairedId));
                const repairedCoverage=await readPostRenderSoundGaps(currentRendered,currentBinding,source);
                for(const gap of state.gaps)if(gap.stage==='post_render_sound_coverage')gap.status='resolved';
                if(repairedCoverage.gaps.length)state.gaps.push(...structuredGaps({status:repairedCoverage.status,
                  unresolved:repairedCoverage.gaps},source,'post_render_sound_coverage',snapshot,analysis));
                const recheckInput={...reviewInput,render_binding:currentBinding,render_files:currentFiles,
                  prior_review_binding:reviewBinding};
                const rechecked=await invoke('composite_recheck',out=>adapter({...recheckInput,output_dir:out},shared()),
                  value=>['composite_review_needs_repair','composite_review_unresolved','composite_research_passed'].includes(value.status));
                finalReview=await verifyCompositeReview(rechecked.artifact,recheckInput,compositeVerification);reviewBinding=rechecked.artifact;
                const priorMedia=await readJson(firstReview.media.path),newMedia=await readJson(finalReview.media.path);
                if(priorMedia.mix.sha256===newMedia.mix.sha256)throw Error('composite_research_no_actual_repaired_pcm_change');
              }
              assertCompositeSoundCompletion(finalReview,state.gaps.filter(gap=>gap.stage==='post_render_sound_coverage'));
              for(const gap of state.gaps)if(gap.stage==='composite_review')gap.status='resolved';
              if(finalReview.issues.length||finalReview.unresolved.length)state.gaps.push(...structuredGaps({status:finalReview.status,
                unresolved:[...finalReview.issues,...finalReview.unresolved]},source,'composite_review',snapshot,analysis));
              return finish(finalReview.status,{render_status:currentRendered.status,preview:currentRendered.preview,
                audio_dir:currentRendered.audio_dir,trial:currentRendered,render_calls:state.render_registry.length,
                composite_review:reviewBinding,composite_repair:state.stages.composite_repair?.result?.artifact??null,
                composite_repair_rounds:state.composite_repair_admission?1:0,
                actual_research_audio_processed:finalReview.actual_research_audio_processed,
                actual_picture_samples_submitted:true,actual_audio_listened:false,quality_status:'not_assessed',
                artistic_acceptance:'awaiting_actual_audition',production_approval:false});
            }catch(error){
              const gap={reason:error.message,rendered_outputs_preserved:true,rendered_result:currentBinding,
                preview:currentRendered.preview,required_stage:'composite_research_review_or_scoped_repair'};
              state.gaps.push(...structuredGaps({status:'composite_review_unresolved',unresolved:[gap]},source,
                'composite_review',snapshot,analysis));
              return finish('composite_review_unresolved',{preview:currentRendered.preview,audio_dir:currentRendered.audio_dir,
                trial:currentRendered,render_calls:state.render_registry.length,composite_review_gap:gap,
                composite_repair_rounds:state.composite_repair_admission?1:0,actual_audio_listened:false,quality_status:'not_assessed',
                next_action:'reconcile_or_resolve_bound_composite_gap_without_replaying_completed_story_or_resetting_budget'});
            }
          }
          if (automaticResearch && typeof shared().researchAudioObserver === 'function') {
            const observer = shared().researchAudioObserver;
            let screenInputs, screenIdentity;
            try {
              if (typeof observer.getIdentity !== 'function') throw Error('research_audio_observer_readonly_identity_required');
              screenInputs = await deliveredResearchAudioInputs(rendered, files, source);
              const observerIdentity = await observer.getIdentity();
              if (!observerIdentity?.model || !observerIdentity?.runtime || !observerIdentity?.implementation)
                throw Error('research_audio_observer_model_runtime_implementation_identity_required');
              await verifyEvidenceBindings(observerIdentity);
              screenIdentity = digest({ source, preview: screenInputs.preview, duration_seconds: screenInputs.duration_seconds,
                windows: screenInputs.windows, scope: screenInputs.scope, observer: observerIdentity,
                controller: await hashFile(fileURLToPath(import.meta.url)) });
              if (state.research_audio_screen_identity !== screenIdentity) {
                if (state.stages.research_audio_screen) {
                  (state.stage_attempt_history ??= []).push({ stage: 'research_audio_screen', ...state.stages.research_audio_screen });
                  state.stages.research_audio_screen = { attempt: state.stages.research_audio_screen.attempt,
                    status: 'invalidated_research_audio_inputs' };
                }
                state.research_audio_screen_identity = screenIdentity;
              }
              // Stable per-identity directory lets the observer reconcile unknown local
              // submissions; a controller retry never creates a fresh model submission.
              const cache = path.join(directory, 'research-audio-screen-cache', screenIdentity);
              const screen = await invoke('research_audio_screen', async () => {
                if (!await exists(path.join(cache, 'actual-output', 'report.json'))) {
                  const budget = shared().trialBudget;
                  if (typeof budget?.inspectLocal !== 'function') throw Error('research_audio_shared_episode_budget_required');
                  const remaining = await budget.inspectLocal({ stage: 'local_research_audio_screen_admission' });
                  const minimum = runtime.researchAudioMinimumMs ?? screenInputs.windows.length * 30000 + 15000;
                  if (!Number.isFinite(minimum) || minimum < 1) throw Error('research_audio_minimum_time_estimate_invalid');
                  // Scheduling estimate only, based on retained local throughput. The
                  // worker is still bounded by the exact shared remaining film time.
                  if (!Number.isFinite(remaining?.remaining_ms) || remaining.remaining_ms < minimum)
                    throw Error(`research_audio_insufficient_remaining_episode_time:${remaining?.remaining_ms ?? 'unknown'}<${minimum}`);
                }
                const result = await observer({ source: screenInputs.preview, source_video: screenInputs.preview,
                  original_source_video_sha256: source.sha256, windows: screenInputs.windows,
                  duration_seconds: screenInputs.duration_seconds, directory: cache, trialBudget: shared().trialBudget });
                return validateResearchAudioScreen(result, screenInputs, source);
              }, value => value.status === 'actual_audio_research_screen_complete');
              await validateResearchAudioScreen(screen, screenInputs, source);
              for (const gap of state.gaps) if (gap.stage === 'research_audio_screen') gap.status = 'resolved';
              const unresolved = [...screenInputs.omitted_extras.map(window => ({ reason: 'research_audio_supplemental_window_capacity_gap',
                id: window.id, target_range: window.source_range, blocks_render: false })),
                ...screen.windows.filter(window => !window.actual_audio_processed).map(window => ({
                  reason: 'research_audio_window_not_actually_processed', id: window.id,
                  target_range: window.source_range, blocks_render: false }))];
              if (unresolved.length) state.gaps.push(...structuredGaps({ status: screen.status, unresolved },
                source, 'research_audio_screen', snapshot, analysis));
              return finish(rendered.status, { preview: rendered.preview, audio_dir: rendered.audio_dir,
                render_calls: state.render_registry.length, research_audio_screen: state.stages.research_audio_screen.result_binding,
                research_audio_gap: null,
                research_audio_scope: screenInputs.scope,
                research_audio_status: unresolved.length ? 'incomplete' : 'actual_audio_research_screen_complete',
                actual_research_audio_processed: screen.actual_observation_count > 0,
                actual_audio_listened: false, actual_picture_processed: false,
                research_audio_is_qualified_listening: false, quality_status: 'not_assessed',
                artistic_acceptance: 'awaiting_actual_audition' });
            } catch (error) {
              for (const gap of state.gaps) if (gap.stage === 'research_audio_screen') gap.status = 'resolved';
              const gap = { reason: error.message, id: 'delivered_preview_audio_screen', blocks_render: false,
                ...(screenInputs ? { target_range: [0, screenInputs.duration_seconds] } : {}),
                rendered_outputs_preserved: true, rendered_result: resultBinding, preview: rendered.preview,
                observer_input_identity: screenIdentity ?? null, required_stage: 'local_research_audio_screen' };
              state.gaps.push(...structuredGaps({ status: 'local_research_audio_screen_incomplete', unresolved: [gap] },
                source, 'research_audio_screen', snapshot, analysis));
              return finish(rendered.status, { render_status: rendered.status, preview: rendered.preview ?? null,
                audio_dir: rendered.audio_dir, render_calls: state.render_registry.length,
                research_audio_status: 'incomplete', research_audio_screen: null, research_audio_gap: gap,
                research_audio_scope: screenInputs?.scope ?? null,
                actual_research_audio_processed: false, actual_audio_listened: false, actual_picture_processed: false,
                research_audio_is_qualified_listening: false, quality_status: 'not_assessed',
                artistic_acceptance: 'awaiting_actual_audition',
                next_action: 'reconcile_or_repair_only_bound_local_audio_screen; preserve_completed_render_and_continue_other_episodes' });
            }
          }
          return finish(rendered.status, { preview: rendered.preview ?? null, audio_dir: rendered.audio_dir,
            render_calls: state.render_registry.length });
        }
        if (rendered.music_source_budget?.passed === false) {
          const budget = rendered.music_source_budget, reason = (budget.gaps ?? []).join(';') || 'reference_music_budget_gap';
          const sourceGaps = (budget.spans ?? []).filter(span => span.origin === 'auxiliary').flatMap(span =>
            (span.cue_ids ?? ['source-budget']).map(cue_id => ({ cue_id,
              target_range: span.target_range_samples.map(sample => sample / 48000), reason,
              kind: 'music_source', blocks_render: true, hot_drama_percent: budget.hot_drama_percent,
              auxiliary_percent: budget.auxiliary_percent, music_source_budget_receipt: budget.receipt ?? null })));
          gapResult = { ...rendered, unresolved: sourceGaps.length ? sourceGaps : (budget.gaps ?? []).map(reason => ({
            reason, kind: 'music_source', blocks_render: true, music_source_budget_receipt: budget.receipt ?? null })) };
          gapStage = 'render_source_budget';
        } else {
          state.gaps = structuredGaps(rendered, source, 'render', snapshot, analysis);
          return finish(rendered.status);
        }
      }
      state.gaps = structuredGaps({ ...gapResult, unresolved: gapResult.gaps ?? gapResult.unresolved }, source, gapStage, snapshot, analysis); await persist();
      if (pending(gapResult)) return finish(gapResult.status, { next_action: 'complete_bound_pending_material_request; do_not_replay_pending_call' });
      if (typeof runtime.materialResolver !== 'function') return finish(gapResult.status, {
        next_action: 'provide_actual_materialResolver_or_changed_frozen_cases_and_library' });
      if (state.resolver_attempts.some(row => row.snapshot_sha256 === snapshot.sha256)) return finish('automatic_material_gap_unchanged', {
        next_action: 'publish_changed_frozen_material_snapshot_before_retry' });
      // Bound the pass even if a resolver keeps publishing unusable stores.
      if (materialRetries >= 1) return finish('automatic_material_gap_after_changed_snapshot', {
        next_action: 'continue_independent_episodes; inspect_recorded_remaining_object_gaps' });
      const attempt = { snapshot_sha256: snapshot.sha256, gap_ids: state.gaps.map(row => row.gap_id),
        status: 'invoking_actual_resolver', started_at: now() };
      state.resolver_attempts.push(attempt); await persist();
      let resolved;
      const resolverTimeout = runtime.materialResolverTimeoutMs ?? 600000;
      if (!Number.isInteger(resolverTimeout) || resolverTimeout < 1 || resolverTimeout > 1800000)
        throw new Error('automatic_material_resolver_timeout_invalid');
      const abort = new AbortController(); let timer;
      try { resolved = await Promise.race([
        runtime.materialResolver({ episode_id: runtime.episode_id ?? null, config: structuredClone(activeConfig),
          source_video: source, target_analysis: analysis.artifact, material_result: materials, failed_result: gapResult,
          frozen_snapshot: snapshot, gaps: structuredClone(state.gaps), checkpoint: stateFile, signal: abort.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          abort.abort(); reject(new Error('automatic_material_resolver_timeout'));
        }, resolverTimeout); }),
      ]); }
      catch (error) { attempt.status = 'failed'; attempt.error = error.message; return finish('automatic_material_resolver_failed'); }
      finally { clearTimeout(timer); }
      attempt.finished_at = now();
      if (!resolved?.frozen_config) {
        attempt.status = 'pending_or_no_publication'; attempt.result = resolved ?? null;
        return finish('automatic_material_gap_unpublished', { next_action: 'resolver_must_publish_actual_frozen_config_before_material_retry' });
      }
      const candidate = structuredClone(resolved.frozen_config);
      if (digest({ source, config: storyConfig(candidate) }) !== storyIdentity)
        throw new Error('automatic_resolver_cannot_change_source_or_story_controls');
      if (canonical(outsideFrozenPublication(candidate)) !== canonical(outsideFrozenPublication(activeConfig)))
        throw new Error('automatic_resolver_publication_can_change_only_frozen_stores');
      const updated = await frozenMaterials(candidate);
      if (updated.sha256 === snapshot.sha256) {
        attempt.status = 'unchanged'; return finish('automatic_material_gap_unchanged', {
          next_action: 'publish_changed_frozen_material_snapshot_before_retry' });
      }
      attempt.status = 'published_changed_snapshot'; attempt.next_snapshot_sha256 = updated.sha256;
      const held = await holdChangeUntilReconciled('material_snapshot', { snapshot_sha256: updated.sha256 });
      if (held) return held;
      const refreshedAdapters = await refreshFrozenMaterialAdapters(candidate, materialAdapters);
      state.active_frozen_config = candidate; state.material_history ??= [];
      state.material_history.push({ snapshot_sha256: snapshot.sha256,
        material_runtime_identity: state.material_runtime_identity, stages: { materials: state.stages.materials } });
      activeConfig = candidate; snapshot = updated; materialRetries++;
      materialAdapters = refreshedAdapters;
      state.material_runtime_identity = { ...executionIdentity,
        ...await materialRuntimeIdentity({ ...runtime, ...materialAdapters }, activeConfig, session, source.sha256) };
      state.material_runtime_sha256 = digest(state.material_runtime_identity);
      state.current_snapshot_sha256 = updated.sha256; state.snapshots.push(updated);
      for (const name of ['materials', 'publish', 'assembly', 'render']) if (state.stages[name])
        state.stages[name] = { attempt: state.stages[name].attempt, status: 'invalidated_material_snapshot' };
      await persist();
    }
  } catch (error) {
    if (!state) throw error;
    const failedStage = Object.values(state.stages).find(row => row.status === 'failed' && row.error === error.message);
    const failureReferences = failedStage?.failure_evidence ? {
      failure_evidence: failedStage.failure_evidence, receipt_file: failedStage.receipt_file ?? null,
      cli_receipts: failedStage.cli_receipts ?? [] } : {};
    // Inspect authorization after a timeout: an exhausted live budget forbids
    // retry even if transport failure and deadline expiry happen together.
    // This classifies the current stop, not the timeout's sole causal origin.
    if(error.message==='codex_cli_timeout'){
      const budget=session?.trialBudget??filmTrialBudget??runtime.trialBudget;
      if(typeof budget?.inspectLocal==='function'){
        try{await budget.inspectLocal({stage:'automatic_timeout_budget_classification'});}
        catch(budgetError){
          if(budgetError.code==='independent_trial_budget_exhausted')return finish('independent_trial_budget_exhausted',{
            error:budgetError.message,original_stage_error:error.message,cli_receipts:error.cli_receipts??[],
            budget_classification:'exhausted_at_timeout_check',timeout_cause:'retained_in_child_receipts_not_inferred',
            budget_receipt_file:budgetError.receipt_file??null,
            next_action:'preserve_completed_stages_and_reconcile_timed_out_child; no_retry_without_remaining_authorized_budget'});
        }
      }
    }
    if (error.code === 'independent_trial_budget_exhausted') return finish('independent_trial_budget_exhausted', {
      error: error.message, budget_receipt_file: error.receipt_file ?? null,
      next_action: 'resume_verified_stages_after_resolving_recorded_request_or_time_budget; continue_other_episodes' });
    return finish('automatic_episode_failed', { error: error.message, ...failureReferences,
      next_action: 'repair_specific_stage_and_reuse_verified_completed_stage_cache' });
  } finally {
    try { await runtime.closeFilmBudget?.({ config: activeConfig, directory }); }
    finally { await lock.close(); await unlink(lockFile); }
  }
}

export async function composeBatch(config, runtime = {}) {
  if (config?.schema_version !== 1 || !path.isAbsolute(config.output_dir ?? '') || !Array.isArray(config.episodes)
    || !config.episodes.length || config.episodes.some(row => typeof row.episode_id !== 'string' || !row.episode_id.trim() || !row.config)
    || new Set(config.episodes.map(row => row.episode_id)).size !== config.episodes.length)
    throw new Error('automatic_batch_config_invalid');
  if (runtime.session) throw new Error('automatic_batch_per_episode_createSession_required');
  const directory = path.resolve(config.output_dir); await mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, 'automatic-batch-state.json');
  const prior = await exists(stateFile) ? await readJson(stateFile) : null;
  // Legacy batch callbacks may write shared artifacts; explicit modern deployments opt into two workers.
  const result = await runEpisodeQueue({ concurrency: 1, ...config }, runtime, { compose: composeAutomaticEpisode });
  const state = { schema_version: 2, kind: 'automatic_episode_batch',
    invocations: (prior?.invocations ?? 0) + 1, episodes: result.episodes,
    render_registry: Object.entries(result.episodes).flatMap(([episode_id, row]) =>
      (row.render_registry ?? []).map(item => ({ ...item, episode_id }))),
    queue_file: result.queue_file, executor_state: result.executor_state, queue_counts: result.counts,
    job_versions: result.job_versions, admission_gaps: result.admission_gaps,
    entire_corpus_complete: false, updated_at: now() };
  state.status = result.executor_state === 'waiting_auth' ? 'automatic_batch_waiting_auth'
    : result.admission_gaps.length || Object.values(result.episodes).some(row => row.gaps?.length
      || !(['director_trial_pending_audition','target_analysis_complete'].includes(row.status)
        ||row.status==='quality_review_accepted'&&row.quality_status==='accepted'&&row.actual_audio_listened===true))
      ? 'automatic_batch_finished_with_gaps' : 'automatic_batch_pass_completed';
  await atomicJson(stateFile, state);
  const gaps = Object.entries(state.episodes).flatMap(([episode_id, row]) => (row.gaps ?? []).map(gap => ({ episode_id, ...gap })));
  const gapFile = path.join(directory, 'material-gap-queue.json');
  await atomicJson(gapFile, { schema_version: 1, gaps, production_approval: false });
  return { ...state, checkpoint: await bind(stateFile), material_gap_queue: await bind(gapFile),
    Ready: false, production_approval: false, artistic_acceptance: 'not_assessed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = await readJson(process.argv[2]);
    const result = await (config.episodes ? composeBatch(config) : composeAutomaticEpisode(config));
    console.log(JSON.stringify({ status: result.status, checkpoint: result.checkpoint, Ready: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
