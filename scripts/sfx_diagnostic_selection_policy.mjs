import {isValidatedIndependentMusicPackPolicy,validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {sfxEventFunctionRevision,validateSoundFunctionIntent,soundEventFunctionPrompt} from './sfx_event_function.mjs';

export const diagnosticSfxSelectionPolicyRevision='diagnostic_sfx_selection_policy_v1';
const permittedRoles=Object.freeze(['dramatic','transition']);
const fail=reason=>{throw Error('sfx_diagnostic_selection_'+reason);};

// The host authorization grants diagnostic execution, never sound/use approval.
// A model JSON object, copied token or ordinary research flag cannot grant it.
export async function bindDiagnosticSfxSelectionPolicy(policy,{projection,sourceSha,tasks,outputDirectory,eventFunctionRevision}={}){
  if(eventFunctionRevision!==undefined&&eventFunctionRevision!==sfxEventFunctionRevision)fail('event_function_revision_invalid');
  if(projection!=='sfx_lossless_shared_observations_v1')fail('explicit_projection_required');
  if(!isValidatedIndependentMusicPackPolicy(policy))fail('validated_host_policy_required');
  await validateIndependentMusicPackPolicy({mode:'research',automatic_trial:true,
    material_strategy:'independent_music_packs',trial_review_policy:'diagnostic_candidates',
    source_policy:{kind:'independent_pack_trial',authorization:policy.authorization}},
  {outputDirectory,operation:'prepare_independent_music_materials'});
  if(!/^[a-f0-9]{64}$/.test(sourceSha??'')||!tasks?.length
    ||tasks.some(task=>task.kind!=='sfx'||!permittedRoles.includes(task.sound_role)))
    fail('optional_narrative_roles_required');
  if(eventFunctionRevision)for(const task of tasks)validateSoundFunctionIntent(task.sound_function_intent,{soundRole:task.sound_role});
  return {revision:eventFunctionRevision?'diagnostic_sfx_selection_policy_v2':diagnosticSfxSelectionPolicyRevision,host_authorization:{...policy.authorization},
    source_video_sha256:sourceSha,allowed_sound_roles:[...permittedRoles],
    selection_scope:eventFunctionRevision?'provisional_event_function_and_source_window_pending_audition':'provisional_narrative_accent_or_transition_pending_audition',
    ...(eventFunctionRevision?{event_function_revision:eventFunctionRevision}:{}),
    target_anchor_scope:'creative_placement_hypothesis_inside_bound_event; not_original_physical_sync',
    qualification_granted:false,original_sound_fact_approval:false,artistic_approval:false,production_approval:false};
}

export function validateDiagnosticSfxSelectionPolicy(policy,input){
  if(!policy)return;
  if(input.sfx_material_selection_projection!=='sfx_lossless_shared_observations_v1')fail('explicit_projection_required');
  const v2=policy.revision==='diagnostic_sfx_selection_policy_v2';
  if(v2){if(policy.event_function_revision!==sfxEventFunctionRevision||input.sfx_event_function_revision!==sfxEventFunctionRevision)fail('event_function_revision_invalid');
    for(const task of input.tasks)validateSoundFunctionIntent(task.sound_function_intent,{soundRole:task.sound_role});}
  if(![diagnosticSfxSelectionPolicyRevision,'diagnostic_sfx_selection_policy_v2'].includes(policy.revision)
    ||policy.source_video_sha256!==input.source_video_sha256
    ||!policy.host_authorization?.path||!/^[a-f0-9]{64}$/.test(policy.host_authorization.sha256??'')
    ||JSON.stringify(policy.allowed_sound_roles)!==JSON.stringify(permittedRoles)
    ||policy.selection_scope!==(v2?'provisional_event_function_and_source_window_pending_audition':'provisional_narrative_accent_or_transition_pending_audition')
    ||policy.target_anchor_scope!=='creative_placement_hypothesis_inside_bound_event; not_original_physical_sync'
    ||['qualification_granted','original_sound_fact_approval','artistic_approval','production_approval'].some(key=>policy[key]!==false)
    ||!input.tasks?.length||input.tasks.some(task=>task.kind!=='sfx'||!permittedRoles.includes(task.sound_role)))
    fail('host_policy_or_roles_changed');
}

export function diagnosticSfxSelectionPromptFor(revision){
  if(revision===undefined)return diagnosticSfxSelectionPrompt;
  if(revision!==sfxEventFunctionRevision)fail('event_function_revision_invalid');
  return '比较已完成剧情与全部候选的真实PCM/专项观察，为dramatic/transition事件选择最多一个待审源窗。不得新增未知physical/foley/ambience；宿主授权不是声音或艺术批准。'+soundEventFunctionPrompt;
}

export const diagnosticSfxSelectionPrompt='比较已完成剧情与全部候选的真实PCM/专项观察，只为dramatic/transition选择最多一个待审叙事重音或转场。宿主政策允许未正式核准的候选试配，不要求先有专业听审；正式声义、干净度和用途未知仍写入缺口，不可声称听过或批准。可以建议事件范围内的叙事锚点假设，不把范围起点当已确认原有物理同步；后续编辑和渲染仍须核真实瞬态、局部对白避让与精确源窗。不得新增未知physical/foley/ambience。PANN概率、文件名、时长和召回顺序不等于声音语义；不能凭长时长强选bed。必须比较并逐项解释淘汰，真实证据不足或剧情冲突时仍可全部拒绝。';
