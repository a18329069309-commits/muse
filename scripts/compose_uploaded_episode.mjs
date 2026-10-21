import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readJson,verifyEvidenceBindings} from './audio_api.mjs';
import {composeCodexEpisode,createCodexEpisodeRuntime,validateDirectorSourceRangeConfig} from './compose_codex_episode.mjs';
import {composeBatch} from './automatic_episode_controller.mjs';
import {registerUploadedWork} from './register_uploaded_work.mjs';
import {isIndependentMusicPackTrial,validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {validateFinalMixMasterConfig} from './final_mix_master.mjs';
import {validateDeliveryArchiveConfig} from './closed_render_archive.mjs';
import {validateRenderDecodeCacheConfig} from './render_decode_cache.mjs';
import {summarizeUploadedEpisodeResult} from './upload_result_summary.mjs';
import {independentMusicComparisonPolicy} from './independent_music_comparison_policy.mjs';
import {directionSoundPropulsionRevision} from './direction_sound_propulsion.mjs';
import {validateTrialWallClockPolicy} from './independent_trial_budget.mjs';
import {validateCompositeResearchConfig} from './composite_research_review.mjs';
import {validateEpisodeCallPlan} from './episode_call_admission.mjs';
import {validateSfxOfflineRepairRoot} from './sfx_offline_repair_policy.mjs';

const profileFields=new Set(['schema_version','mode','automatic_trial','direction_contract_version','strategy',
  'craft_mode','audience','music_words_policy','cases','library','consumer_publication','python','contact_sheet_python',
  'account_cli_slot_directory','codex_cli','local_audio_python','local_audio_analysis','material_observer_kind',
  'material_observation_execution','material_observation_receipts','material_acoustic_receipts',
  'material_observer_backend_id','material_observer_model_revision','preview','visual_sampling_step',
  'original_gain_db','preview_master_gain_db','material_strategy','music_packs','source_policy','trial_review_policy',
  'trial_budget','trial_budget_revision','trial_wall_clock_policy','diagnostic_sample','sfx_library','ambient_library','independent_retriever','original_sound_reviews','contact_sheet_profile',
  'assembly_contract_version','assembly_source_capacity_revision','assembly_gap_contract_revision','sound_query_contract_version','sfx_adoption_mode','assembly_sfx_pool_contract_revision',
  'quality_review_policy','quality_review_audio_backend','quality_review_qualification','composite_review','trial_call_plan','review_input_limit_policy',
  'material_readiness_policy','music_action_contract_version','final_mix_master','delivery_archive','render_decode_cache',
  'independent_music_comparison_policy','sfx_audibility_repair','sfx_offline_repair_root','assembly_decision_contract_revision']);
const batchFields=new Set(['episode_id','video','work_id','work_title','series_id','target_analysis','work_identity_evidence']);
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const validBinding=value=>path.isAbsolute(value?.path??'')&&/^[a-f0-9]{64}$/.test(value?.sha256??'');

export async function loadUploadDeploymentProfile(file){
  const profile=await readJson(file);
  if(profile?.schema_version!==1||profile.mode!=='research'||profile.automatic_trial!==true)
    throw Error('upload_automatic_deployment_required');
  if(Object.keys(profile).some(key=>!profileFields.has(key)))throw Error('deployment_cannot_preselect_episode_music_or_source');
  independentMusicComparisonPolicy(profile);
  validateDirectorSourceRangeConfig(profile);
  if(profile.trial_wall_clock_policy!==undefined){
    if(!isIndependentMusicPackTrial(profile))throw Error('upload_trial_wall_clock_diagnostic_scope_required');
    validateTrialWallClockPolicy(profile.trial_wall_clock_policy,{maxElapsedMs:profile.trial_budget?.max_elapsed_ms??1200000});
  }
  if(profile.assembly_source_capacity_revision!==undefined
    &&(profile.assembly_source_capacity_revision!=='admitted-continuous-source-capacity-v1'||profile.assembly_contract_version!==2))
    throw Error('upload_assembly_source_capacity_revision_invalid');
  if(profile.assembly_gap_contract_revision!==undefined
    &&(profile.assembly_gap_contract_revision!=='object-scoped-gap-v1'||profile.assembly_contract_version!==2))
    throw Error('upload_assembly_gap_contract_revision_invalid');
  validateSfxOfflineRepairRoot(profile);
  if(profile.sfx_audibility_repair!==undefined)
    (await import('./sfx_audibility_repair.mjs')).validateSfxAudibilityRepairPolicy(profile.sfx_audibility_repair);
  if(profile.codex_cli?.direction_sound_propulsion_revision!==undefined
    &&profile.codex_cli.direction_sound_propulsion_revision!==directionSoundPropulsionRevision)
    throw Error('upload_direction_sound_propulsion_revision_invalid');
  if(profile.codex_cli?.sfx_event_function_revision!==undefined
    &&profile.codex_cli.sfx_event_function_revision!=='sound-event-function-v2')
    throw Error('upload_sfx_event_function_revision_invalid');
  if(profile.final_mix_master!==undefined)validateFinalMixMasterConfig(profile.final_mix_master);
  if(profile.delivery_archive!==undefined)validateDeliveryArchiveConfig(profile.delivery_archive);
  if(profile.render_decode_cache!==undefined){validateRenderDecodeCacheConfig(profile.render_decode_cache);
    if(!path.isAbsolute(profile.python??''))throw Error('render_decode_cache_explicit_python_required');}
  if(profile.assembly_contract_version!==undefined&&![1,2].includes(profile.assembly_contract_version))
    throw Error('upload_assembly_contract_version_invalid');
  if(profile.sound_query_contract_version!==undefined&&![1,2].includes(profile.sound_query_contract_version))
    throw Error('upload_sound_query_contract_version_invalid');
  if(profile.music_action_contract_version!==undefined&&![1,2].includes(profile.music_action_contract_version))
    throw Error('upload_music_action_contract_version_invalid');
  if(profile.material_readiness_policy!==undefined&&profile.material_readiness_policy!=='offline_ready_only')
    throw Error('upload_material_readiness_policy_invalid');
  if(profile.material_readiness_policy==='offline_ready_only'&&(profile.material_observer_kind!=='frozen_offline'
    ||profile.material_observation_execution))throw Error('upload_offline_materials_cannot_run_online_inference');
  if(profile.quality_review_policy!==undefined&&!['diagnostic_only','automatic_required','composite_research'].includes(profile.quality_review_policy))
    throw Error('upload_quality_review_policy_invalid');
  validateCompositeResearchConfig(profile);
  if(profile.trial_call_plan!==undefined){
    validateEpisodeCallPlan(profile.trial_call_plan);
    if(!profile.trial_wall_clock_policy)throw Error('upload_call_plan_wall_clock_policy_required');
    validateTrialWallClockPolicy(profile.trial_wall_clock_policy,{maxElapsedMs:profile.trial_budget?.max_elapsed_ms??1200000});
  }
  if(profile.assembly_decision_contract_revision!==undefined&&profile.assembly_decision_contract_revision!=='host-bound-editor-decisions-v1')
    throw Error('upload_assembly_decision_contract_revision_invalid');
  if(profile.sfx_adoption_mode!==undefined&&(!['separate','assembly'].includes(profile.sfx_adoption_mode)
    ||profile.sfx_adoption_mode==='assembly'&&(profile.material_strategy!=='independent_music_packs'
      ||profile.source_policy?.kind!=='independent_pack_trial'||profile.trial_review_policy!=='diagnostic_candidates')))
    throw Error('upload_sfx_adoption_mode_invalid');
  if(profile.assembly_sfx_pool_contract_revision!==undefined
    &&(profile.assembly_sfx_pool_contract_revision!=='observed-candidates-final-assembly-v1'
      ||profile.sfx_adoption_mode!=='assembly'||!isIndependentMusicPackTrial(profile)))
    throw Error('upload_assembly_sfx_pool_contract_invalid');
  if(!validBinding(profile.consumer_publication))throw Error('upload_bound_consumer_publication_required');
  await verifyEvidenceBindings(profile.consumer_publication);
  const publication=await readJson(profile.consumer_publication.path),consumer=publication.consumer;
  if(!consumer||consumer.strategy!==profile.strategy||canonical(consumer.cases)!==canonical(profile.cases)
    ||canonical(consumer.library)!==canonical(profile.library)
    || ['material_strategy','music_packs','source_policy','trial_review_policy','sfx_library','ambient_library','independent_retriever',
      'material_readiness_policy','music_action_contract_version','independent_music_comparison_policy'].some(key=>canonical(consumer[key])!==canonical(profile[key])))
    throw Error('upload_frozen_consumer_profile_mismatch');
  return profile;
}

// A deployment contains reusable library/runtime settings. Uploads supply no songs, cues or edits.
export async function composeUploadedEpisode({deployment,video,output_dir,work_id,work_title,series_id,work_identity_evidence,batch},runtime={}) {
  if (!path.isAbsolute(deployment??'')||!path.isAbsolute(output_dir??''))throw Error('upload_deployment_and_output_absolute_paths_required');
  const profile=await loadUploadDeploymentProfile(deployment);
  const independent=profile.material_strategy==='independent_music_packs';
  if(independent)await validateIndependentMusicPackPolicy(profile,{outputDirectory:output_dir,operation:'compose_uploaded_episode'});
  if (batch) {
    if(!path.isAbsolute(batch)||video!==undefined)throw Error('upload_batch_absolute_path_without_single_video_required');
    const input=await readJson(batch);
    if (!Array.isArray(input.episodes)||!input.episodes.length)throw Error('upload_batch_episodes_required');
    if(input.episodes.some(row=>!row||typeof row!=='object'||Object.keys(row).some(key=>!batchFields.has(key))
      ||typeof row.episode_id!=='string'||!row.episode_id.trim()||!path.isAbsolute(row.video??'')
      ||row.work_id!==undefined&&(typeof row.work_id!=='string'||!row.work_id.trim())
      ||row.target_analysis!==undefined&&!validBinding(row.target_analysis)
      ||row.work_identity_evidence!==undefined&&!validBinding(row.work_identity_evidence))
      ||new Set(input.episodes.map(row=>row.episode_id)).size!==input.episodes.length)
      throw Error('upload_batch_media_metadata_only_required');
    const registrations=independent?await Promise.all(input.episodes.map(row=>registerUploadedWork({...row,
      evidence:row.work_identity_evidence,directory:path.join(output_dir,'registered-works')}))):[];
    const episodes=input.episodes.map((row,index)=>({episode_id:row.episode_id,
      config:{...profile,video:row.video,work_id:row.work_id,...(row.target_analysis?{target_analysis:row.target_analysis}:{}),
        ...(row.work_identity_evidence?{work_identity_evidence:row.work_identity_evidence}:{}),...(registrations[index]??{})}}));
    const shared=await createCodexEpisodeRuntime(profile,runtime);
    try {return await composeBatch({schema_version:1,output_dir,episodes,concurrency:2},shared);}
    finally {await shared.closeMaterialRetriever?.();}
  }
  if(!path.isAbsolute(video??''))throw Error('upload_video_absolute_path_required');
  const registered=independent?await registerUploadedWork({video,work_id,work_title,series_id,
    evidence:work_identity_evidence,directory:path.join(output_dir,'registered-works')}):{};
  return composeCodexEpisode({...profile,video,output_dir,...(work_id?{work_id}:{}),
    ...(work_identity_evidence?{work_identity_evidence}:{}),...registered},runtime);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{profile:{type:'string'},video:{type:'string'},out:{type:'string'},
      'work-id':{type:'string'},batch:{type:'string'}}});
    const result=await composeUploadedEpisode({deployment:values.profile,video:values.video,output_dir:values.out,
      work_id:values['work-id'],batch:values.batch});
    console.log(JSON.stringify(summarizeUploadedEpisodeResult(result)));
    if(!['director_trial_pending_audition','automatic_batch_pass_completed','target_analysis_complete'].includes(result.status)
      &&!(result.status==='quality_review_accepted'&&result.quality_status==='accepted'&&result.actual_audio_listened===true))process.exitCode=2;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
