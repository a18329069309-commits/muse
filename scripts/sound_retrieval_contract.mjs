import {objectSchema} from './audio_api.mjs';

const str={type:'string'},nullableStr={type:['string','null']};
// A space joins words inside one exact metadata label; never trim, split or alias it.
export const exactSoundExclusionTagPattern='^[-_\\p{L}\\p{N}]+(?: [-_\\p{L}\\p{N}]+)*$';
export const isExactSoundExclusionTag=tag=>typeof tag==='string'&&tag.length>=1&&tag.length<=120
  &&new RegExp(exactSoundExclusionTagPattern,'u').test(tag);
export const soundQueryItemSchema=objectSchema({event_id:str,text:str,asset_kind:{type:'string',enum:['sfx','ambience']}});
export const soundQueryItemV2Schema=structuredClone(soundQueryItemSchema);
Object.assign(soundQueryItemV2Schema.properties,{
  retrieval_query:{type:['string','null'],maxLength:1000},
  excluded_tags:{type:'array',maxItems:30,items:str},
  filters:{...objectSchema({function:nullableStr,duration_role:{type:['string','null'],enum:['transient','bed',null]},
    min_duration:{type:['number','null'],minimum:0},max_duration:{type:['number','null'],minimum:0}}),type:['object','null']},
});
soundQueryItemV2Schema.required.push('retrieval_query','excluded_tags','filters');
// A catalogue-bound repair may choose exact index labels, or an explicit empty
// list when the original prohibition has no catalogue representation. It does
// not discard that prohibition: original text remains a separate literal.
export function soundQuerySchemaForCatalog(allowedExcludedTags){
  const schema=structuredClone(soundQueryItemV2Schema);
  Object.assign(schema.properties.excluded_tags,{uniqueItems:true,items:{type:'string',minLength:1,maxLength:120,
    pattern:'^[A-Za-z0-9_\\-\\u0080-\\uFFFF]+(?: [A-Za-z0-9_\\-\\u0080-\\uFFFF]+)*$'}});
  if(!Array.isArray(allowedExcludedTags)||new Set(allowedExcludedTags).size!==allowedExcludedTags.length
    ||allowedExcludedTags.some(tag=>!isExactSoundExclusionTag(tag)))
    throw Error('sound_query_catalogue_exclusions_invalid');
  if(allowedExcludedTags.length)schema.properties.excluded_tags.items.enum=[...allowedExcludedTags];
  else schema.properties.excluded_tags.maxItems=0;
  return schema;
}
export const soundRetrievalInstruction='text完整保留原声音意图及禁用原因；retrieval_query另给只含正向声音需求的索引词，'
  +'不要删除原text中的否定来偷偷改意图。excluded_tags给精确元数据功能/标签禁用列表；filters分开指定function、duration_role、min_duration、max_duration，未指定用null。'
  +'持续压力床用bed，按事件长度寻找可覆盖真实源窗，不套瞬态10秒上限；冲击/转场默认transient短窗。'
  +'本机音效库采用标题/功能/标签的SQLite索引，retrieval_query使用冻结库实际可见的简短正向索引词；英文目录使用英文声音词，text仍保留完整中文意图。'
  +'例如bass结合function=tension_bass_bed可检索压力床；不把长剧情、审批要求或否定说明当索引词，不猜测不存在的标签。'
  +'来源限制和剧情禁用未必对应库标签；明确excluded_tags:[]表示没有可据实映射的索引标签，完整原意仍交选材器比较，不能编造标签。'
  +'元数据标签不是已听声音或用途批准，不确定则保留待核。';

export const soundSemanticRetrievalInstruction='text完整保留声音意图及禁用情境；retrieval_query给简短正向英文声音描述，供已配置CLAP语义召回。'
  +'描述瞬态/持续床、材质、力度、动态和空间，不用长剧情、否定或待办。语义描述不是目录标签或已听事实，不必与文件标题逐字相同；不能因目录标题未含该词而把可描述的声音需求置空。'
  +'excluded_tags仍只采用实际可见精确库标签，无对应标签写[]，所有剧情禁用保留在text交实际选材器。'
  +'function是精确元数据过滤，不是自由声音描述；只有冻结目录实际提供该功能值时才填入，没有可见对应值用null，不能猜功能编号堵住语义召回。'
  +'filters独立保存function、duration_role、min_duration和max_duration，未指定用null；持续床按事件长度检索，瞬态不可冒充连续床，不改原事件来迁就库存。'
  +'确实不能确定正向声音需求时保留retrieval_query:null并说明具体原因；不得猜原声缺失、声音干净或用途已通过。相似度、PANN与目录均不签发听审资格。';

export function soundRetrievalInstructionFor(input){
  const mode=input?.data?.sound_retrieval_mode??input?.data?.catalogue?.semantic_retrieval_mode;
  if(mode===undefined||mode===null)return soundRetrievalInstruction;
  if(mode!=='resident_sfx_clap')throw Error('sound_query_semantic_mode_invalid');
  return soundSemanticRetrievalInstruction;
}

const negative=/不要|避免|不需要|不是|不用|不添加|不预设|不叠加|禁止|\b(?:without|not|no)\b/i;
const text=value=>typeof value==='string'&&Boolean(value.trim());
const validNumber=value=>value===undefined||value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function normalizeSoundRetrievalQuery(query,event){
  const failures=[];
  if(!query||!text(query.text)||!['sfx','ambience'].includes(query.asset_kind))failures.push('sound_intent_or_kind_required');
  const explicit=text(query?.retrieval_query),positive=explicit?query.retrieval_query:query?.text;
  if(!text(positive)||negative.test(positive))failures.push('positive_retrieval_projection_required');
  if(positive?.length>1000)failures.push('positive_retrieval_projection_too_long');
  if(query?.retrieval_query!=null&&!explicit)failures.push('nonempty_explicit_retrieval_query_required');
  const excluded=query&&Object.hasOwn(query,'excluded_tags')?query.excluded_tags:[];
  if(!Array.isArray(excluded)||excluded.length>30||excluded.some(tag=>!text(tag)||negative.test(tag)
    ||!isExactSoundExclusionTag(tag))||new Set(excluded).size!==excluded.length)failures.push('exact_excluded_tags_required');
  // V2 deliberately permits an explicit empty list: provenance and narrative
  // restrictions do not necessarily name catalog tags. The exact original
  // intent remains in the selection task; retrieval is never use approval.
  // An older mixed query without an explicit exclusion decision still needs
  // the query-only repair, rather than silently discarding its negative text.
  if(explicit&&negative.test(query?.text??'')&&!Object.hasOwn(query,'excluded_tags'))
    failures.push('negated_intent_requires_explicit_exclusion_tags');
  const filters=query?.filters??{};
  if(typeof filters!=='object'||Array.isArray(filters)||Object.keys(filters).some(key=>!['function','duration_role','min_duration','max_duration'].includes(key)))
    failures.push('supported_sound_filters_required');
  if(filters.function!=null&&(!text(filters.function)||negative.test(filters.function)))failures.push('positive_sound_function_required');
  if(filters.duration_role!=null&&!['bed','transient'].includes(filters.duration_role))failures.push('supported_sound_duration_role_required');
  if(!validNumber(filters.min_duration)||!validNumber(filters.max_duration))failures.push('finite_sound_duration_filters_required');
  const duration=(event?.end_seconds??0)-(event?.start_seconds??0);
  const bed=query?.asset_kind==='ambience'||filters.duration_role==='bed'||/_bed$/.test(filters.function??'');
  if(bed&&event?.role&&!['dramatic','ambience'].includes(event.role))failures.push('bed_role_requires_dramatic_or_ambience');
  if(bed&&(!(duration>0)||filters.min_duration!=null&&filters.min_duration<duration))failures.push('bed_window_must_cover_current_event');
  const minimum=filters.min_duration??(bed?duration:null),maximum=filters.max_duration??(bed?null:10);
  if(minimum!=null&&maximum!=null&&minimum>maximum)failures.push('sound_duration_filter_order_invalid');
  if(failures.length)return {ready:false,status:'query_repair_required',repair_reasons:failures,
    original_intent:query?.text??'',qualification_granted:false};
  return {ready:true,status:'positive_sound_query_bound',original_intent:query.text,
    retrieval:{text:positive,asset_kind:query.asset_kind,excluded_tags:[...excluded],
      ...(filters.function?{function:filters.function}:{}),...(minimum!=null?{min_duration:minimum}:{}),
      ...(maximum!=null?{max_duration:maximum}:{}),usage_scope:'research_noncommercial',limit:20},
    duration_role:bed?'bed':'transient',projection_basis:explicit?'explicit_director_fields':'legacy_positive_text_unchanged',qualification_granted:false};
}
