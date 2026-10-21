import {objectSchema} from './audio_api.mjs';

export const sfxEventFunctionRevision='sound-event-function-v2';
const str={type:'string'},strings={type:'array',items:str};
const fail=reason=>{throw Error('sfx_event_function_'+reason);};
const range=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&v[0]>=0&&v[1]>v[0];
const inside=(a,b)=>range(a)&&range(b)&&a[0]>=b[0]&&a[1]<=b[1];
const observedPoolRevision='observed-candidates-final-assembly-v1';
export function isObservedAssemblySoundCandidate(candidate){
  if(candidate.assembly_sfx_pool_contract_revision===undefined)return false;
  if(candidate.assembly_sfx_pool_contract_revision!==observedPoolRevision)fail('observed_pool_revision_invalid');
  return true;
}
export const soundUsageSchema={...objectSchema({segment_id:str,function:{type:'string',enum:['point','bed','ambience']},
  usable_source_range:{type:'array',items:{type:'number'},minItems:2,maxItems:2},
  basis:str,review_pending:strings}),type:['object','null']};

// Catalogue kind is a retrieval partition, never the event's narrative role.
// A sustained dramatic layer remains dramatic even when its search hint says ambience.
export function soundEventFunctionIntent({event,projected,query}){
  const target=[event?.start_seconds,event?.end_seconds],role=event?.role;
  if(!range(target)||!['physical','foley','dramatic','transition','ambience'].includes(role)
    ||!['transient','bed'].includes(projected?.duration_role))fail('bound_event_and_duration_required');
  const expected=role==='ambience'?'ambience':projected.duration_role==='bed'?'bed':'point';
  if(expected==='bed'&&role!=='dramatic'||expected==='point'&&role==='ambience')fail('role_duration_conflict');
  return {revision:sfxEventFunctionRevision,event_id:event.id,event_role:role,expected_function:expected,
    duration_role:projected.duration_role,target_range:target,required_duration_samples:Math.round((target[1]-target[0])*48000),
    catalogue_kind:query.asset_kind,original_intent:query.text,
    interpretation:'catalogue_kind_is_retrieval_hint_only; event_role_is_canonical; function_is_unapproved_selection_hypothesis',
    qualification_granted:false,original_sound_fact_approval:false,artistic_approval:false,production_approval:false};
}

export function validateSoundFunctionIntent(intent,{soundRole,eventId,targetRange}={}){
  if(intent?.revision!==sfxEventFunctionRevision||!['point','bed','ambience'].includes(intent.expected_function)
    ||!['physical','foley','dramatic','transition','ambience'].includes(intent.event_role)||!range(intent.target_range)
    ||intent.required_duration_samples!==Math.round((intent.target_range[1]-intent.target_range[0])*48000)
    ||intent.required_duration_samples<=0||!['sfx','ambience'].includes(intent.catalogue_kind)
    ||typeof intent.original_intent!=='string'||!intent.original_intent.trim()
    ||intent.interpretation!=='catalogue_kind_is_retrieval_hint_only; event_role_is_canonical; function_is_unapproved_selection_hypothesis'
    ||['qualification_granted','original_sound_fact_approval','artistic_approval','production_approval'].some(k=>intent[k]!==false)
    ||intent.expected_function==='ambience'&&intent.event_role!=='ambience'
    ||intent.expected_function==='bed'&&intent.event_role!=='dramatic'
    ||intent.expected_function==='point'&&intent.event_role==='ambience'
    ||intent.duration_role!==(intent.expected_function==='point'?'transient':'bed')
    ||soundRole!==undefined&&soundRole!==intent.event_role||eventId!==undefined&&eventId!==intent.event_id
    ||targetRange!==undefined&&JSON.stringify(targetRange)!==JSON.stringify(intent.target_range))fail('intent_changed');
  return intent;
}

// This checks selected operands and the declared function, not auditory suitability.
// Mismatched but otherwise real choices remain recorded gaps; they cannot become beds.
export function validateSelectedSoundUsage(decision,task){
  const intent=validateSoundFunctionIntent(task.sound_function_intent,{soundRole:task.sound_role});
  const ids=decision.selected_segment_ids??[],usage=decision.sound_usage;
  if(!ids.length){if(usage!==null)fail('omission_cannot_claim_usage');return null;}
  if(ids.length!==1||!usage||usage.segment_id!==ids[0]||typeof usage.basis!=='string'||!usage.basis.trim()
    ||!Array.isArray(usage.review_pending)||usage.review_pending.some(v=>typeof v!=='string'||!v.trim()))fail('selected_usage_required');
  const candidate=task.candidates.find(row=>row.segment_id===usage.segment_id);
  if(!candidate||!inside(usage.usable_source_range,candidate.source_range)
    ||Math.round(usage.usable_source_range[1]*48000)<=Math.round(usage.usable_source_range[0]*48000))fail('usable_source_range_invalid');
  if(!['point','bed','ambience'].includes(usage.function)
    ||intent.event_role==='ambience'&&usage.function!=='ambience'
    ||intent.event_role!=='ambience'&&usage.function==='ambience'
    ||intent.event_role==='transition'&&usage.function!=='point')fail('selected_function_role_changed');
  if(usage.function!==intent.expected_function)return {gap:'selected_sound_function_conflicts_with_event_intent',
    expected_function:intent.expected_function,selected_function:usage.function};
  const samples=Math.round(usage.usable_source_range[1]*48000)-Math.round(usage.usable_source_range[0]*48000);
  if(usage.function!=='point'&&samples<intent.required_duration_samples)return {
    gap:'selected_sound_usable_bed_window_duration_insufficient',required_samples:intent.required_duration_samples,available_samples:samples};
  return null;
}

// A pool describes observed alternatives; the final sound assembler has not yet
// chosen a function, useful interval or reason. Never manufacture selector facts.
export function validateObservedAssemblySoundFunction(candidate,event){
  if(!isObservedAssemblySoundCandidate(candidate))fail('observed_pool_revision_required');
  const intent=validateSoundFunctionIntent(candidate.sound_function_intent,{soundRole:candidate.sound_role,
    eventId:event?.id??candidate.event_id,...(event?{targetRange:[event.start_seconds,event.end_seconds]}:{})});
  if(!range(candidate.source_range)||candidate.duration_role!==(intent.expected_function==='point'?'transient':'bed')
    ||candidate.sound_usage!==undefined||candidate.selector_adopt_reason!==undefined
    ||candidate.assembly_adopt_reason!==undefined||candidate.function_decision_response!==undefined
    ||candidate.adoption_pending===false)fail('observed_pool_cannot_claim_selection');
  return {intent,usage:null,pending_final_assembly:true};
}

export function validatePreparedSoundFunction(candidate,event){
  if(candidate.sound_function_intent===undefined&&candidate.sound_usage===undefined&&!isObservedAssemblySoundCandidate(candidate))return null;
  const intent=validateSoundFunctionIntent(candidate.sound_function_intent,{soundRole:candidate.sound_role,
    ...(event?{eventId:event.id,targetRange:[event.start_seconds,event.end_seconds]}:{})});
  const usage=candidate.sound_usage;
  if(isObservedAssemblySoundCandidate(candidate)){
    // The immutable pool/final-response consumer separately binds the complete
    // model usage to the original observed window. Keep that model declaration
    // verbatim while the render candidate represents only its executed subwindow.
    if(!usage||candidate.adoption_pending!==false||candidate.selector_adopt_reason!==undefined
      ||typeof candidate.assembly_adopt_reason!=='string'||!candidate.assembly_adopt_reason.trim()
      ||!candidate.function_decision_response?.path||!/^[a-f0-9]{64}$/.test(candidate.function_decision_response.sha256??'')
      ||!inside(candidate.source_range,usage.usable_source_range)
      ||JSON.stringify(candidate.selection_source_ranges)!==JSON.stringify([candidate.source_range])
      ||candidate.duration_role!==(usage.function==='point'?'transient':'bed'))fail('observed_pool_final_usage_required');
    const gap=validateSelectedSoundUsage({selected_segment_ids:[candidate.segment_id],sound_usage:usage},
      {sound_role:candidate.sound_role,sound_function_intent:intent,
        candidates:[{segment_id:candidate.segment_id,source_range:usage.usable_source_range}]});
    if(gap)fail('observed_pool_final_function_changed');
    return {intent,usage};
  }
  const gap=validateSelectedSoundUsage({selected_segment_ids:[candidate.segment_id],sound_usage:usage},
    {sound_role:candidate.sound_role,sound_function_intent:intent,
      candidates:[{segment_id:candidate.segment_id,source_range:candidate.source_range}]});
  if(gap||JSON.stringify(candidate.selection_source_ranges)!==JSON.stringify([usage.usable_source_range])
    ||candidate.duration_role!==(usage.function==='point'?'transient':'bed')
    ||typeof candidate.selector_adopt_reason!=='string'||!candidate.selector_adopt_reason.trim())fail('prepared_function_changed');
  return {intent,usage};
}

export const soundEventFunctionPrompt='逐事件读取sound_function_intent：event_role是实际剧情角色，catalogue_kind仅检索目录分区，不能把dramatic持续暗压误当环境声。'
  +'point比较明确的短叙事重音/转场；bed比较低密度、持续发展的戏剧底声；ambience只对应真实ambience事件且仍要求原声缺失/不足审核。'
  +'每个选择必须返回sound_usage，声明point/bed/ambience及给定观察窗内的usable_source_range、比较依据和review_pending；未选返回null。'
  +'函数和源窗是待审选材假设，不是已核连续床/干净度/用途；读完整PCM能量变化、专项概率及限制。'
  +'要求bed时，瞬态后衰减、多鼓峰或不相符材料可全部拒绝并返回具体功能缺口，不得凭长文件时长声称持续床。'
  +'如果实际只适合point，可以如实声明point，但不能以此满足bed任务，宿主保留该功能冲突。缺少正式资格本身不否决dramatic/transition诊断选择；真实污染、剧情冲突、源窗不足仍可否决。';
