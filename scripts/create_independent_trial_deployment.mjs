import path from 'node:path';
import {lstat,mkdir} from 'node:fs/promises';
import { readJson, saveJson, verifyEvidenceBindings, resolveAudioBackend, validateAudioQualification } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { loadNativeEnvelopeCalibration } from './native_envelope_calibration.mjs';
import { validateFinalMixMasterConfig } from './final_mix_master.mjs';
import { validateDeliveryArchiveConfig } from './closed_render_archive.mjs';
import { validateRenderDecodeCacheConfig } from './render_decode_cache.mjs';
import {validateIndependentMusicComparisonPolicy} from './independent_music_comparison_policy.mjs';
import {directionSoundPropulsionRevision} from './direction_sound_propulsion.mjs';
import {assemblyDecisionContractRevision} from './assembly_decision_contract.mjs';
import {validateCompositeResearchConfig} from './composite_research_review.mjs';
import {validateEpisodeCallPlan} from './episode_call_admission.mjs';
import {validateTrialWallClockPolicy,validateReviewInputLimitPolicy} from './independent_trial_budget.mjs';

// The calibrated token envelope belongs to a specific stage reasoning setting.
// Copy that setting into the deployment, rather than relying on a caller override.
export function bindNativeStageReasoning(options, calibration) {
  const efforts = { ...(options.stageReasoningEffort ?? {}) };
  const effort = calibration?.profile?.reasoning_effort;
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)
    || !Array.isArray(calibration.allowed_stages) || !calibration.allowed_stages.length)
    throw Error('independent_deployment_native_reasoning_evidence_required');
  for (const stage of calibration.allowed_stages) {
    const explicit = efforts[stage] ?? efforts.research_style_director;
    if (explicit !== undefined && explicit !== effort)
      throw Error('independent_deployment_native_reasoning_mismatch');
    efforts[stage] = effort;
  }
  return { ...options, stageReasoningEffort: efforts };
}

export async function resolveDeploymentCodexOptions(options) {
  const result = { ...options, worker_profile: 'structured_evidence_v2', business_contract: 'compact_business_v1' };
  if(result.direction_sound_propulsion_revision!==undefined&&result.direction_sound_propulsion_revision!==directionSoundPropulsionRevision)
    throw Error('independent_deployment_direction_sound_propulsion_revision_invalid');
  if(result.sfx_event_function_revision!==undefined&&result.sfx_event_function_revision!=='sound-event-function-v2')
    throw Error('independent_deployment_sfx_event_function_revision_invalid');
  if (!result.native_envelope_calibration) return result;
  return bindNativeStageReasoning(result, await loadNativeEnvelopeCalibration(result.native_envelope_calibration));
}

// Records the user's scoped diagnostic policy; selects no episode, song or timestamp.
export async function createIndependentTrialDeployment({ directory, music_packs, sfx_library = null,
  ambient_library = null, independent_retriever = null, original_sound_reviews = [], runtime_profile,
  authorization_evidence, diagnostic_sample = null }) {
  if (!path.isAbsolute(directory) || !authorization_evidence?.trim()) throw Error('independent_deployment_scope_required');
  try {
    await lstat(directory);
    throw Error('independent_deployment_new_directory_required');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await verifyEvidenceBindings(music_packs);
  const publication = await readJson(music_packs.path), old = await readJson(runtime_profile);
  if (publication.kind !== 'independent_music_pack_publication') throw Error('independent_pack_publication_required');
  if(old.quality_review_policy!==undefined
    &&!['diagnostic_only','automatic_required','composite_research'].includes(old.quality_review_policy))
    throw Error('independent_deployment_quality_review_policy_invalid');
  if(old.quality_review_policy==='automatic_required'&&!old.quality_review_audio_backend)
    throw Error('independent_deployment_audio_review_backend_required');
  if(old.quality_review_audio_backend!==undefined)resolveAudioBackend(old.quality_review_audio_backend);
  if((old.quality_review_policy==='automatic_required'||old.quality_review_qualification!==undefined)
    &&(!path.isAbsolute(old.quality_review_qualification?.path??'')
    ||!/^[a-f0-9]{64}$/.test(old.quality_review_qualification?.sha256??'')))
    throw Error('independent_deployment_audio_review_qualification_required');
  if(old.quality_review_qualification!==undefined){
    if(!old.quality_review_audio_backend)throw Error('independent_deployment_audio_review_backend_required');
    const qualification=await validateAudioQualification(old.quality_review_qualification,
      resolveAudioBackend(old.quality_review_audio_backend),['audio_observation','music_candidate_judgment']);
    if(!qualification.ready)throw Error('independent_deployment_audio_review_qualification_invalid');
    if(old.quality_review_policy==='automatic_required'){
      const version=(await readJson(qualification.binding.path)).schema_version;
      if(!Number.isSafeInteger(version)||version<2)
        throw Error('independent_deployment_schema2_audio_review_qualification_required');
    }
  }
  validateIndependentMusicComparisonPolicy(old.independent_music_comparison_policy);
  if(old.sfx_audibility_repair!==undefined)
    (await import('./sfx_audibility_repair.mjs')).validateSfxAudibilityRepairPolicy(old.sfx_audibility_repair);
  if (old.final_mix_master !== undefined) validateFinalMixMasterConfig(old.final_mix_master);
  if(old.render_decode_cache!==undefined){validateRenderDecodeCacheConfig(old.render_decode_cache);
    if(!path.isAbsolute(old.python??''))throw Error('render_decode_cache_explicit_python_required');}
  if (old.delivery_archive !== undefined) validateDeliveryArchiveConfig(old.delivery_archive);
  if(old.assembly_decision_contract_revision!==undefined&&old.assembly_decision_contract_revision!==assemblyDecisionContractRevision)
    throw Error('independent_deployment_assembly_decision_contract_revision_invalid');
  if(old.assembly_sfx_pool_contract_revision!==undefined
    &&(old.assembly_sfx_pool_contract_revision!=='observed-candidates-final-assembly-v1'||old.sfx_adoption_mode!=='assembly'))
    throw Error('independent_deployment_assembly_sfx_pool_contract_invalid');
  if(old.trial_wall_clock_policy!==undefined)validateTrialWallClockPolicy(old.trial_wall_clock_policy);
  if(old.review_input_limit_policy!==undefined)validateReviewInputLimitPolicy(old.review_input_limit_policy);
  if(old.trial_call_plan!==undefined){
    validateEpisodeCallPlan(old.trial_call_plan);
    const wall=validateTrialWallClockPolicy(old.trial_wall_clock_policy);
    if(!wall||old.trial_call_plan.render_reserve_ms>=wall.max_elapsed_ms)
      throw Error('independent_deployment_call_plan_absolute_deadline_required');
  }
  const codexOptions = await resolveDeploymentCodexOptions(old.codex_cli ?? {});
  for (const [kind, library] of [['sfx', sfx_library], ['ambient', ambient_library]]) {
    if (!library) continue;
    if (!path.isAbsolute(library.db ?? '') || await hashFile(library.db) !== library.sha256)
      throw Error(`independent_deployment_${kind}_frozen_binding_required`);
    if (library.publication) await verifyEvidenceBindings(library.publication);
  }
  if (!Array.isArray(original_sound_reviews) || original_sound_reviews.some(row => !path.isAbsolute(row?.path ?? '')
    || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))) throw Error('independent_deployment_original_sound_review_bindings_required');
  await verifyEvidenceBindings(original_sound_reviews);
  if (independent_retriever) {
    if (independent_retriever.kind !== 'resident_clap' || !path.isAbsolute(independent_retriever.weights ?? '')
      || !path.isAbsolute(independent_retriever.snapshot?.path ?? '')) throw Error('independent_deployment_resident_retriever_binding_required');
    await verifyEvidenceBindings(independent_retriever.snapshot);
  }
  const authorizationValue = {
    schema_version: 1, kind: 'direct_human_independent_music_pack_trial_authorization', status: 'authorized',
    scope: 'independent_pack_trial', output_root: directory,
    operations: ['compose_uploaded_episode', 'compose_episode', 'user_film_trial', 'analyze_target',
      'prepare_target_materials', 'prepare_independent_music_materials', 'research_direction',
      'assemble_research_episode', 'render_research_trial', 'run_sound_job', 'render_plan', 'export_preview', 'target_material_preparation'],
    production_approval: false, material_or_listening_approval: false,
    preserves_reference_source_policy: true, evidence: authorization_evidence,
    development_budget: { revision: 'generic-adaptation-v1', max_requests: 12, max_input_tokens: 16000, max_elapsed_ms: 1200000 },
  };
  const runtimeKeys = ['python', 'contact_sheet_python', 'account_cli_slot_directory', 'codex_cli',
    'local_audio_python', 'local_audio_analysis', 'material_observer_kind', 'material_observation_execution',
    'assembly_contract_version','sound_query_contract_version','sfx_adoption_mode','music_action_contract_version',
    'quality_review_policy','quality_review_audio_backend','quality_review_qualification',
    'material_readiness_policy','final_mix_master','delivery_archive','render_decode_cache',
    'independent_music_comparison_policy','sfx_audibility_repair','assembly_decision_contract_revision',
    'composite_review','review_input_limit_policy','trial_call_plan','trial_wall_clock_policy','assembly_source_capacity_revision',
    'assembly_gap_contract_revision','sfx_offline_repair_root','assembly_sfx_pool_contract_revision'];
  const profile = { schema_version: 1, mode: 'research', automatic_trial: true, direction_contract_version: 2,
    strategy: 'case_presets', material_strategy: 'independent_music_packs', music_packs,
    source_policy: { kind: 'independent_pack_trial', authorization: null }, trial_review_policy: 'diagnostic_candidates',
    library: { db: publication.library.path, sha256: publication.library.sha256 }, craft_mode: 'fine',
    audience: 'auto', music_words_policy: 'prefer', visual_sampling_step: 6,
    trial_budget_revision: 'generic-adaptation-v1',
    trial_budget: { max_requests: 12, max_elapsed_ms: 1200000, max_input_tokens: 16000 }, preview: true,
    ...(diagnostic_sample ? { diagnostic_sample } : {}), ...(sfx_library ? { sfx_library } : {}),
    ...(ambient_library ? { ambient_library } : {}), ...(original_sound_reviews.length ? { original_sound_reviews } : {}),
    ...(independent_retriever ? { independent_retriever } : {}),
    ...Object.fromEntries(runtimeKeys.filter(key => old[key] !== undefined).map(key => [key, old[key]])),
  };
  profile.codex_cli = codexOptions;
  validateCompositeResearchConfig(profile);
  if(profile.material_readiness_policy==='offline_ready_only'){
    if(profile.material_observer_kind!=='frozen_offline'||publication.offline_readiness_contract!==1)
      throw Error('independent_deployment_offline_ready_publication_required');
    delete profile.material_observation_execution;
  }else profile.material_observation_execution = { ...profile.material_observation_execution,
    directory: path.join(directory, 'material-observations') };
  // Validate everything before any deployment/authorization file is created.
  // Claim only a fresh leaf; a racing creator must never become an update target.
  await mkdir(path.dirname(directory),{recursive:true});
  try {await mkdir(directory);}
  catch(error){if(error.code==='EEXIST')throw Error('independent_deployment_new_directory_required');throw error;}
  const authorization=await saveJson(path.join(directory,'authorization.json'),authorizationValue);
  profile.source_policy.authorization=authorization;
  const consumer = { strategy: profile.strategy, material_strategy: profile.material_strategy,
    music_packs, source_policy: profile.source_policy, trial_review_policy: profile.trial_review_policy, library: profile.library,
    ...(sfx_library ? { sfx_library } : {}), ...(ambient_library ? { ambient_library } : {}),
    ...(independent_retriever ? { independent_retriever } : {}),
    ...(profile.material_readiness_policy?{material_readiness_policy:profile.material_readiness_policy}:{}),
    ...(profile.independent_music_comparison_policy!==undefined?{independent_music_comparison_policy:profile.independent_music_comparison_policy}:{}),
    ...(profile.music_action_contract_version?{music_action_contract_version:profile.music_action_contract_version}:{}) };
  profile.consumer_publication = await saveJson(path.join(directory, 'consumer-publication.json'), {
    schema_version: 1, kind: 'independent_pack_diagnostic_consumer', consumer,
    production_approval: false, artistic_acceptance: 'pending_actual_audition',
  });
  const deployment = await saveJson(path.join(directory, 'deployment.json'), profile);
  return { deployment, authorization, consumer_publication: profile.consumer_publication,
    publication_verified: await hashFile(music_packs.path) === music_packs.sha256 };
}
