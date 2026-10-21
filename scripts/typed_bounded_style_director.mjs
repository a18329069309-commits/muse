import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { objectSchema, readJson, validateSchema, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue, deduplicateBusinessSchema,
  directionTerminalFullStopRecoveryRevision } from './compact_business_contract.mjs';
import { soundRetrievalInstructionFor } from './sound_retrieval_contract.mjs';
import { inspectDirectionUncertainties } from './direction_semantics.mjs';
import { routeLanguageSummaryPolicyRevision, routeLanguageSummaryInstruction, directionRoutePolicyGaps } from './vocal_language_policy.mjs';
import { encodeContinuationLiteralParts, decodeContinuationLiteralParts } from './continuation_literal_parts.mjs';
import {actualEditOperationKinds} from './music_edit_operation_contract.mjs';
import {assertDirectionSoundPropulsion,directionSoundPropulsionInstructionFor} from './direction_sound_propulsion.mjs';
export { routeLanguageSummaryPolicyRevision } from './vocal_language_policy.mjs';

export const typedBoundedStyleRevision = 'typed-bounded-style-v1';
export const typedStyleRouteStage = 'research_style_route_v1';
export const typedStyleUncertaintyStage = 'research_style_uncertainties_v1';
export const typedStyleUncertaintySemanticRevision = 'typed-unknown-semantic-preflight-v1';
const uncertaintySemanticInstruction = ' SEMANTIC CONTRACT: evidence_gap/before_specific_edit preserves a real unresolved fact; never convert it to pending work or a narrative device to pass. '
  + 'narrative_constraint is only for story/mixed impact and deliberate unresolved narrative information. deferred_review is for music/mixed impact and allowed post-render/provenance limits, not missing story, material or lyric evidence. In assisted_trial, original_mix may defer a preserved-original-mix hearing limit with event_ids=[], actual cue/basis and unchanged conditions; this never approves sound facts or waives lyric/new physical synchronization checks. '
  + 'pending_work is only music/words/mixed impact and a not-yet-run material_selection/words_selection; every words_selection cue must already request words. '
  + 'Every non-evidence_gap component needs nonempty actual story basis and retained_constraints. Its condition_refs must contain every scope cue exactly once, no other cue. '
  + 'Each affected cue needs an intersecting story beat in that component basis; evidence_ids must belong to the cited beat and the selected field must contain actual nonempty text. Never invent plot evidence for provenance. If no valid basis exists preserve evidence_gap. '
  + 'Use only supplied cue IDs. original_sound requires actual overlapping physical/foley/ambience event IDs; original_mix requires event_ids=[]. A new dramatic hit is not an observed physical sound. '
  + 'Use mixed scope and separately classified components when the original sentence contains multiple matters. Keep all original text and constraints. No factual, listening or production approval is granted.';
export const hostExecutionNotesRevision = 'host_execution_notes_v1';
export const typedRouteCreativeProjectionRevision = 'route_facts_and_constraints_prior_creative_host_v1';
export const typedUnknownFactProjectionRevision = 'unknown_facts_basis_prior_creative_host_v1';
export const typedUnknownCompactProjectionRevision = 'typed-unknown-compact-v2';
export const typedUnknownSourceRangeRevision = 'host-codepoint-source-spans-v1';
function sourceCodepointFields(text){
  let end=0;const spans=(text.match(/[^。；，\n]+[。；，\n]?|[。；，\n]/gu)??[]).map(part=>{
    const start=end;end+=Array.from(part).length;return[start,end,part];});
  if(spans.map(row=>row[2]).join('')!==text)fail('source_range_original_text_changed');
  return{source_end_codepoint:end,source_codepoint_spans:spans};
}
function assertSourceCodepointFields(input){
  const revision=input.data?.uncertainty_batch?.source_range_revision;
  if(revision===undefined)return;
  if(revision!==typedUnknownSourceRangeRevision)fail('source_range_revision_unknown');
  for(const row of expandTypedStyleLiterals(input).data.selected_uncertainties){
    const actual=sourceCodepointFields(row.text);
    if(row.source_end_codepoint!==actual.source_end_codepoint||!same(row.source_codepoint_spans,actual.source_codepoint_spans))
      fail('source_range_host_metadata_changed');
  }
}
export const nativeRouteGuardRevision = 'native-route-boundary-anchor-guard-v2';
export const directionEditCapabilitiesRevision='renderer-edit-capabilities-v1';
const directionExecutableOperations=actualEditOperationKinds.filter(kind=>kind!=='source_development');
export const directionEditCapabilitiesInstruction=' Preserve every plot goal, viewpoint, unresolved threat and user requirement first. '
 + 'Then choose a feasible execution_route for each music_action from music_edit_capabilities. Ordinary dramatic pressure, contrast or release may use real hold/source_switch/gain_change/gain_envelope/accent/lyric_entry without requiring new DSP. '
 + 'These are planned renderer operands, not proof of musical suitability: switching proves only the actual source switch; scalar gain/fades never prove orchestration, register narrowing, low-frequency-only pressure, dissonance or removing a pulse. '
 + 'Keep desired timbre/development as unverified selection preferences in sound_goal/retrieval, not gratuitous mandatory edits. Only a truly required exact source fact uses source_fact_needed; only a truly necessary unsupported processing requirement uses unsupported_required_edit, retaining its full original requirement. Both produce a machine capability gap before selection, never silently become optional. '
 + 'renderer_operation has a supported operation and required_source_facts=[]; source_fact_needed/unsupported_required_edit have operation=null and nonempty required_source_facts. Requested hold uses hold; requested response cannot use hold. Lyric entry needs a real requested words task and later complete-phrase evidence. '
 + 'source_development is not an implemented source-local fact adapter. The current mixed-recording editor has no frequency EQ, pitch/harmony rewriting, stem separation or selective pulse removal. No hearing, source fact, lyric, artistic or production qualification is granted.';
function directionEditCapabilities(sourceSha){return {revision:directionEditCapabilitiesRevision,source_video_sha256:sourceSha,
 execution_scope:'actual_compiled_renderer_operands',operations:[...directionExecutableOperations],
 gain_scope:'scalar_whole_selected_mix',source_local_development_adapter:'unavailable',
 unsupported:['frequency_band_eq','register_or_harmony_rewriting','mixed_source_stem_separation','selective_pulse_removal'],
 source_continuation:'same_recording_exact_position_only; authored gain envelopes cannot be overwritten',
 sound_facts_qualified:false,lyric_approval:false,artistic_approval:false,production_approval:false};}
function directionExecutionRouteSchema(){return objectSchema({kind:{type:'string',enum:['renderer_operation','source_fact_needed','unsupported_required_edit']},
 operation:{type:['string','null'],enum:[...directionExecutableOperations,null]},
 required_source_facts:{type:'array',items:{type:'string',minLength:1}},reason:{type:'string',minLength:1}});}
export function assertDirectionEditCapabilities(input,{modelView=false}={}){
 const revision=input.data?.direction_edit_capabilities_revision,capabilities=input.data?.music_edit_capabilities;
 if(revision===undefined&&capabilities===undefined)return false;
 if(revision!==directionEditCapabilitiesRevision||!/^[a-f0-9]{64}$/.test(input.data?.source_video_sha256??'')
  ||!same(capabilities,directionEditCapabilities(input.data.source_video_sha256)))fail('edit_capabilities_host_contract_changed');
 const action=input.schema?.properties?.music_actions?.items;
 if(!modelView&&(!action?.required?.includes('execution_route')||!same(action.properties.execution_route,directionExecutionRouteSchema())))
  fail('edit_capabilities_action_schema_changed');
 return true;
}
export function withDirectionEditCapabilities(input,revision=null){
 if(revision===null){assertDirectionEditCapabilities(input);return input;}
 if(revision!==directionEditCapabilitiesRevision||input.stage!=='research_style_director'
  ||!input.schema?.properties?.music_actions?.items||input.data?.music_edit_capabilities!==undefined
  ||input.data?.direction_edit_capabilities_revision!==undefined)fail('edit_capabilities_explicit_fresh_request_required');
 const result=structuredClone(input),action=result.schema.properties.music_actions.items;
 if(action.properties.execution_route!==undefined)fail('edit_capabilities_reserved_action_field');
 result.data.direction_edit_capabilities_revision=revision;
 result.data.music_edit_capabilities=directionEditCapabilities(result.data.source_video_sha256);
 action.properties.execution_route=directionExecutionRouteSchema();action.required.push('execution_route');
 result.prompt=(result.prompt??'')+directionEditCapabilitiesInstruction;
 assertDirectionEditCapabilities(result);return result;
}
export function validateDirectionEditRoutes(direction,input){
 if(!assertDirectionEditCapabilities(input))return;
 if(!Array.isArray(direction.music_actions))fail('edit_capabilities_actions_required');
 for(const action of direction.music_actions){const route=action.execution_route;validateSchema(route,directionExecutionRouteSchema());
  if(!['response','hold'].includes(action.requirement)||typeof action.intent!=='string'||!action.intent.trim()
   ||!route.reason.trim()||route.required_source_facts.some(fact=>!fact.trim()))fail('edit_capabilities_original_action_required');
  if(route.kind==='renderer_operation'){
   if(!directionExecutableOperations.includes(route.operation)||route.required_source_facts.length
    ||(action.requirement==='hold')!==(route.operation==='hold'))fail('edit_capabilities_operation_requirement_mismatch');
   if(route.operation==='lyric_entry'&&!(direction.cues??[]).some(cue=>cue.required_action_ids?.includes(action.id)
     &&['explore','require'].includes(cue.words_candidate_request)))fail('edit_capabilities_real_words_request_required');
  }else if(route.operation!==null||!route.required_source_facts.length)fail('edit_capabilities_gap_requirement_required');
 }
}
export function directionEditCapabilityGaps(direction,input){
 validateDirectionEditRoutes(direction,input);if(!assertDirectionEditCapabilities(input))return [];
 return direction.music_actions.filter(action=>action.execution_route.kind!=='renderer_operation').map(action=>({
  kind:'music_edit_capability_gap',action_id:action.id,story_beat_id:action.story_beat_id,target_range:action.target_range,
  original_intent:action.intent,requirement:action.requirement,execution_route:structuredClone(action.execution_route),
  source_video_sha256:input.data.source_video_sha256,revision:directionEditCapabilitiesRevision,
  qualification_granted:false,production_approval:false}));
}
export async function hydrateTypedRouteCreativeProjection(input, projected) {
  if(input.stage!==typedStyleRouteStage||input.data?.route_creative_projection_revision!==typedRouteCreativeProjectionRevision)
    fail('creative_projection_hydration_revision_required');
  const full=input.data.full_direction_request;await verifyEvidenceBindings(full);
  const original=await readJson(full.path),expected=projectTypedStyleModelInput(input);
  if(original.stage!=='research_style_director'||original.data?.source_video_sha256!==input.data.source_video_sha256
    ||!same(projected,expected.input))fail('creative_projection_binding_or_model_input_changed');
  const source=expandTypedStyleTables(expandTypedStyleLiterals({...original,host_contract:original.host_contract??{}}).data.analysis);
  const actual=expandTypedStyleTables(expandTypedStyleLiterals(input).data.analysis);
  if(!same(source,actual))fail('creative_projection_host_analysis_changed');
  return{analysis:structuredClone(source),full_request:full,projection_audit:expected.audit,qualification_granted:false};
}
function purelyUnheardObservation(text) {
  if (typeof text !== 'string' || !text.includes('未听')) return false;
  const words = ['对白活动时钟','观看连续视频','原有音乐','既有音效','对白实况','原声构成','未核准预测','画面字幕','连续视频','无法确认','不能确定','不能确认','未核准','静帧','ASR','VAD','仅据','仅分析','所供','所附','文字','字幕','分析','未听','原音','原声','原有','对白','音效','声效','歌词','音乐','静音','均为','预测','或','及','与'];
  let remaining = text.replace(/\[[\d.]+[–,-][\d.]+s\]/gu,'');
  for (const word of words.sort((a,b)=>b.length-a.length)) remaining=remaining.split(word).join('');
  return /^[\s\p{P}]*$/u.test(remaining);
}
function projectRouteCreativeDependencies(input) {
  const original=structuredClone(input),result=structuredClone(input),analysis=expandTypedStyleTables(expandTypedStyleLiterals(input).data.analysis);
  if(!input.data.full_direction_request?.path||!input.data.full_direction_request.sha256)fail('creative_projection_full_input_required');
  const encoded=result.data.analysis,columns=encoded.story_beats?.columns;
  if(!Array.isArray(columns)||!Array.isArray(encoded.story_beats.rows))fail('creative_projection_lossless_story_table_required');
  const index=columns.indexOf('sound_decision');
  if(index>=0){encoded.story_beats.columns=columns.filter((_,at)=>at!==index);
    encoded.story_beats.rows=encoded.story_beats.rows.map(row=>row.filter((_,at)=>at!==index));}
  delete encoded.style_direction;
  // These are previous model creative suggestions. Explicit user constraints
  // remain in the complete inline preferences; quoted user/must constraints in
  // previous suggestions also remain inline rather than being silently dropped.
  const suggestions=[...Object.entries(analysis.style_direction??{}).map(([field,text])=>({field:'style_direction.'+field,text})),
    ...analysis.story_beats.map(row=>({field:'story_beats.'+row.id+'.sound_decision',text:row.sound_decision}))];
  const hard=suggestions.flatMap(row=>(String(row.text??'').match(/[^。；\n]+[。；\n]?/gu)??[])
    .filter(text=>/用户|必须|强制|user|explicit instruction|不可|不得|禁止|不准/i.test(text)).map(text=>({field:row.field,text})));
  result.data.prior_creative_dependencies={fields:['analysis.style_direction','analysis.story_beats[].sound_decision'],
    full_input_pointer:'/data/full_direction_request',role:'Prior unqualified creative suggestions; new director may replan. Any unique narrative hard constraint remains binding.',
    ...(hard.length?{hard_constraint_clauses:hard}:{})};
  if(purelyUnheardObservation(analysis.original_audio?.observation))encoded.original_audio={kind:analysis.original_audio.kind,
    observation:'Unheard original audio; exact modality-only notes remain in the bound full request.'};
  for(const key of ['source_video_sha256','request_id','schema_version'])delete encoded[key];
  const unknowns=encodeContinuationLiteralParts(analysis.uncertainties);
  if(unknowns)encoded.uncertainties=unknowns;
  for(const key of ['typed_parent_input_sha256','compact_direction_revision'])delete result.data[key];
  if(result.data.dialogue_activity_summary){const summary=result.data.dialogue_activity_summary;
    summary.records=summary.records.map(row=>[row[0],row[3]]);
    summary.columns=['story_beat_id','unverified_speech_activity_fraction'];}
  result.host_contract={revision:typedBoundedStyleRevision,source_policy:'Lossless plot tables; full_request binds prior creative suggestions and host identities. No hearing approval.',
    output_encoding:'Return the native schema object.'};
  result.prompt='全片声音总导演：据全部inline剧情、未知与用户约束输出完整Schema路线及sound_queries。关系/主动权/危险/期待驱动蓄压→推进→兑现→收束；未解危机不凯旋，切镜/分窗不换曲。旧创作建议在full_direction_request，唯一叙事硬约束仍不可忽略。此阶段不分类uncertainty_scopes/dispositions，只新增真实场景未知，勿复制已有未知或资格说明；剧情、同步、歌词、污染缺口须留。尊重audience_preference，auto可保持。prefer须探索有词机会，先设words_opportunity；歌句不替人物断定动机/结局。未限定语言用vocal_language=unknown，显式要求保留，标签用IANA，und未核。global_route_summary须完整路线文字，不只ID。text保留意图/禁用；retrieval_query用简短正向实际索引词，CLAP用英文声学词不限制歌句语言；excluded_tags据实，无则[]；filters未知null，持续床bed，点音transient，不套错误时长。尚未听音、选材或批准。columns/rows按列还原；literal_parts_v1逐行按序拼字符串和dictionary[index]，全部未知原文/全局索引/标点/时间码未删。';
  if(assertDirectionEditCapabilities(input,{modelView:true}))result.prompt+=directionEditCapabilitiesInstruction;
  result.prompt+=directionSoundPropulsionInstructionFor(input);
  const after=expandTypedStyleTables(expandTypedStyleLiterals(result).data.analysis);
  const facts=beats=>beats.map(({sound_decision,...row})=>row);
  if(!same(facts(after.story_beats),facts(analysis.story_beats))||!same(after.sound_events,analysis.sound_events)
    ||!same(decodeContinuationLiteralParts(after.uncertainties),analysis.uncertainties))fail('creative_projection_plot_or_unknown_changed');
  return{input:result,audit:{revision:typedRouteCreativeProjectionRevision,full_input_sha256:shaBytes(canonical(original)),
    model_input_sha256:shaBytes(canonical(result)),original_unknown_count:analysis.uncertainties.length,
    original_unknown_sha256:shaBytes(canonical(analysis.uncertainties)),all_plot_facts_sound_events_and_unknown_literals_retained:true,
    previous_suggestions_host_bound:true,unique_narrative_constraints_remain_binding:true,
    user_preferences_unchanged:true,qualification_granted:false,production_approval:false}};
}
function projectUnknownFactDependencies(input) {
  const result=structuredClone(input),analysis=expandTypedStyleTables(expandTypedStyleLiterals(input).data.analysis),encoded=result.data.analysis;
  const notes=result.data.host_execution_notes;
  if(notes){const records=notes.prediction_provenance?.records;
    if(!Array.isArray(records))fail('unknown_fact_projection_prediction_records_required');
    const counts=key=>records.reduce((all,row)=>{const value=String(row[key]);all[value]=(all[value]??0)+1;return all;},{});
    result.data.host_execution_notes={revision:notes.revision,direct_input_modalities:notes.direct_input_modalities,
      prediction_provenance:{count:records.length,sound_facts_qualified_counts:counts('sound_facts_qualified'),
        transcription_verified_counts:counts('transcription_verified'),dialogue_activity_verified_counts:counts('dialogue_activity_verified')},
      current_request_material_inputs:notes.current_request_material_inputs,hearing_qualification_granted:false,
      source_notes_are_not_story_unknowns:true,details_pointer:'Exact source bindings and phase clocks remain in the unchanged host full direction request.'};}
  const columns=encoded.story_beats?.columns,index=columns?.indexOf('sound_decision');
  if(Array.isArray(encoded.story_beats))encoded.story_beats=encoded.story_beats.map(({sound_decision,...row})=>row);
  else if(Array.isArray(columns)&&Array.isArray(encoded.story_beats?.rows)){
    if(index>=0){encoded.story_beats.columns=columns.filter((_,at)=>at!==index);
      encoded.story_beats.rows=encoded.story_beats.rows.map(row=>row.filter((_,at)=>at!==index));}}
  else fail('unknown_fact_projection_story_table_required');
  delete encoded.style_direction;
  if(purelyUnheardObservation(analysis.original_audio?.observation))encoded.original_audio={kind:analysis.original_audio.kind,
    observation:'Unheard original audio; exact modality-only notes remain host-bound.'};
  for(const key of ['source_video_sha256','request_id','schema_version'])delete encoded[key];
  result.data.prior_creative_dependencies={fields:['analysis.style_direction','analysis.story_beats[].sound_decision'],
    role:'Previous unqualified creative suggestions remain host-bound. They are not factual uncertainty basis; preserve user constraints and every selected original text.'};
  const suggestions=[...Object.entries(analysis.style_direction??{}).map(([field,text])=>({field:'style_direction.'+field,text})),
    ...analysis.story_beats.map(row=>({field:'story_beats.'+row.id+'.sound_decision',text:row.sound_decision}))];
  const hard=suggestions.flatMap(row=>(String(row.text??'').match(/[^。；\n]+[。；\n]?/gu)??[])
    .filter(text=>/用户|必须|强制|user|explicit instruction|不可|不得|禁止|不准/i.test(text)).map(text=>({field:row.field,text})));
  // This is a host dependency inventory, not a model resolution of a story
  // unknown. Keep even the earlier route's mistaken missing-constraint text
  // verbatim, while showing exactly which clauses (including zero) exist.
  result.data.host_dependency_fact_proof={kind:'prior_creative_dependency_inventory_v1',
    actual_hard_constraint_count:hard.length,complete_hard_constraint_clauses:hard,
    all_plot_facts_and_user_preferences_inline:true,
    additional_undisclosed_unique_hard_constraint:false,
    host_only_dependencies:'Unqualified previous creative suggestions and executor provenance; no additional hidden story/user condition.',
    sound_or_artistic_approval:false};
  result.prompt+=' Factual basis MUST use original new_information, control_change, expectation_before or expectation_after. Never use sound_decision/style_direction: those are prior creative suggestions, not observed plot facts. Preserve complete selected original text, original global indexes, every cue condition/exclusion and real unresolved constraint.';
  const after=expandTypedStyleTables(expandTypedStyleLiterals(result).data.analysis),facts=rows=>rows.map(({sound_decision,...row})=>row);
  if(!same(facts(after.story_beats),facts(analysis.story_beats))||!same(after.sound_events,analysis.sound_events)
    ||!same(result.data.selected_uncertainties,input.data.selected_uncertainties)
    ||!same(result.data.cue_context,input.data.cue_context)||!same(result.data.cue_condition_table,input.data.cue_condition_table))
    fail('unknown_fact_projection_story_scope_or_conditions_changed');
  return{input:result,audit:{revision:typedUnknownFactProjectionRevision,full_input_sha256:shaBytes(canonical(input)),
    model_input_sha256:shaBytes(canonical(result)),selected_unknown_count:result.data.selected_uncertainties.length,
    complete_plot_and_sound_facts_retained:true,selected_global_unknown_literals_and_conditions_retained:true,
    prior_creative_advice_is_not_factual_basis:true,qualification_granted:false,production_approval:false}};
}
export function withHostExecutionNotes(input) {
  if(input.stage!=='research_style_director'||!input.data?.source_video_sha256)fail('host_execution_notes_style_input_required');
  assertDirectionEditCapabilities(input);
  if(input.data.host_execution_notes)fail('host_execution_notes_cannot_be_caller_supplied');
  const result=structuredClone(input),observations=input.data.unqualified_research_observations??[];
  result.data.host_execution_notes={revision:hostExecutionNotesRevision,source_video_sha256:input.data.source_video_sha256,
    phase:'complete_story_sound_direction_before_target_material_selection',
    direct_input_modalities:{image_binding_count:input.frames?.length??0,audio_input:false,continuous_video_input:false},
    prior_story:input.data.completed_story??null,
    prediction_provenance:{count:observations.length,records:observations.map(row=>{
      const value=row.value??row;return{binding:row.binding??null,source_range:value.source_range??null,
        sound_facts_qualified:value.sound_facts_qualified??null,transcription_verified:value.transcription_verified??null,
        dialogue_activity_verified:value.dialogue_activity_verified??null,timestamp_precision:value.timestamp_precision??null};})},
    current_request_material_inputs:{candidate_pool_supplied:Object.hasOwn(input.data,'material_candidates'),
      current_materials_supplied:Object.hasOwn(input.data,'current_materials'),
      frozen_library_supply_is_not_target_selection:true},
    hearing_qualification_granted:false,source_notes_are_not_story_unknowns:true};
  result.data.director_domain_contract=hostExecutionNotesRevision;
  return result;
}
export function restoreHostExecutionNotesInput(input){
  if(input.data?.director_domain_contract!==hostExecutionNotesRevision)return input;
  const base=structuredClone(input);delete base.data.host_execution_notes;delete base.data.director_domain_contract;
  if(!same(withHostExecutionNotes(base),input))fail('host_execution_notes_changed');return base;
}
export function assertFreshDirectorUnknownDomain(route,prepared){
  if(prepared.original.data?.director_domain_contract!==hostExecutionNotesRevision)return;
  if(route.uncertainties.some(text=>prepared.analysis.uncertainties.includes(text)))fail('fresh_direction_copies_analysis_unknown');
}
export const isTypedStyleStage = stage => [typedStyleRouteStage, typedStyleUncertaintyStage, 'research_style_route_anchors_v1','research_style_boundary_fields_v1'].includes(stage);
function routeExecutionMetadata(input){
  const result=structuredClone(input),notes=result.data?.host_execution_notes;if(!notes)return{input:result,audit:null};
  const records=notes.prediction_provenance.records;
  const counts=key=>records.reduce((all,row)=>{const name=String(row[key]);all[name]=(all[name]??0)+1;return all;},{});
  result.data.host_execution_notes={revision:notes.revision,phase:notes.phase,direct_input_modalities:notes.direct_input_modalities,
    prediction_provenance:{count:records.length,sound_facts_qualified_counts:counts('sound_facts_qualified'),
      transcription_verified_counts:counts('transcription_verified'),dialogue_activity_verified_counts:counts('dialogue_activity_verified'),
      timestamp_precisions:[...new Set(records.map(row=>row.timestamp_precision))]},
    current_request_material_inputs:notes.current_request_material_inputs,hearing_qualification_granted:false,
    source_notes_are_not_story_unknowns:true,details_pointer:'/data/host_execution_notes in bound full_direction_request'};
  const actual=expandTypedStyleTables(expandTypedStyleLiterals(input)),intervals=actual.data.dialogue_intervals??[],beats=actual.data.analysis.story_beats;
  if(!Array.isArray(intervals))fail('route_dialogue_intervals_invalid');
  const ranges=intervals.map(row=>[row.start_seconds,row.end_seconds]);
  if(ranges.some(row=>row.some(x=>!Number.isFinite(x))||row[0]<0||row[1]<=row[0]))fail('route_dialogue_intervals_invalid');
  const unionDuration=rows=>{let end=-Infinity,total=0;for(const[start,finish]of rows.sort((a,b)=>a[0]-b[0])){
    if(finish>end)total+=finish-Math.max(start,end);end=Math.max(end,finish);}return total;};
  result.data.dialogue_activity_summary={interval_count:ranges.length,records:beats.map(beat=>{
    const covered=unionDuration(ranges.filter(row=>row[0]<beat.end_seconds&&row[1]>beat.start_seconds)
      .map(row=>[Math.max(row[0],beat.start_seconds),Math.min(row[1],beat.end_seconds)]));
    return[beat.id,beat.start_seconds,beat.end_seconds,covered/(beat.end_seconds-beat.start_seconds)];}),
    columns:['story_beat_id','source_start','source_end','unverified_speech_activity_fraction'],
    precision:'coarse_activity_not_word_or_phrase_boundary',qualified:false,
    details_pointer:'/data/dialogue_intervals in bound full_direction_request; restore actual local intervals for final editing'};
  delete result.data.dialogue_intervals;
  return{input:result,audit:{revision:'route-execution-metadata-summary-v1',
    omitted_fields:['data.host_execution_notes.prediction_provenance.records','data.dialogue_intervals'],
    roles:'execution_identity_qualification_repetition_and_local_ducking_intervals_are_not_route_artistic_decisions',
    full_input_sha256:shaBytes(canonical(input)),all_story_words_unknowns_constraints_clocks_retained:true,
    exact_local_dialogue_intervals_remain_bound_for_final_editing:true,qualified:false}};
}
export function typedStyleExpandedProviderSchema(schema) {
  const value = structuredClone(schema);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.properties) { node.required = Object.keys(node.properties); Object.values(node.properties).forEach(visit); }
    if (node.type === 'array' && Array.isArray(node.items?.enum) && !node.items.enum.length) {
      if ((node.minItems ?? 0) > 0) fail('empty_enum_required_array_unsatisfiable');
      node.maxItems = 0; delete node.items.enum;
    }
    if (node.items) visit(node.items);
  }
  visit(value); return value;
}
export const typedStyleProviderSchema = schema => deduplicateBusinessSchema(typedStyleExpandedProviderSchema(schema));
export function projectTypedStyleModelInput(input) {
  assertSourceCodepointFields(input);
  if(input.stage===typedStyleRouteStage){assertDirectionEditCapabilities(input);assertDirectionSoundPropulsion(input);}
  const projected=structuredClone(input);delete projected.schema;delete projected.response_schema;
  if(input.stage===typedStyleRouteStage&&input.data?.director_domain_contract===hostExecutionNotesRevision){
    const metadata=routeExecutionMetadata(projected);
    if(input.data.route_creative_projection_revision===undefined)return metadata;
    if(input.data.route_creative_projection_revision!==typedRouteCreativeProjectionRevision)fail('creative_projection_revision_unknown');
    const creative=projectRouteCreativeDependencies(metadata.input);
    return{input:creative.input,audit:{...creative.audit,metadata_projection:metadata.audit}};
  }
  const batch=input.data?.uncertainty_batch,compactV2=batch?.maximum_items===32;
  if(compactV2&&batch.compact_projection_revision!==typedUnknownCompactProjectionRevision)
    fail('compact_unknown_projection_revision_required');
  if(!compactV2&&batch?.compact_projection_revision!==undefined)fail('compact_unknown_projection_revision_unexpected');
  if(input.stage!==typedStyleUncertaintyStage||![16,32].includes(batch?.maximum_items))
    return {input:projected,audit:null};
  const omitted=[];
  for(const key of ['source_video_sha256','typed_parent_input_sha256','full_direction_request','completed_route','compact_direction_revision','dialogue_intervals']) {
    if(Object.hasOwn(projected.data,key)){delete projected.data[key];omitted.push('data.'+key);}
  }
  projected.data.uncertainty_batch={maximum_items:batch.maximum_items,phase_scope:'selected_global_origin_index_only',
    ...(compactV2?{compact_projection_revision:typedUnknownCompactProjectionRevision}:{}),
    ...(batch.source_range_revision?{source_range_revision:batch.source_range_revision}:{})};
  omitted.push('data.uncertainty_batch.indexes/revision/global_origin_counts');
  projected.host_contract={revision:typedBoundedStyleRevision,
    table_encoding:'columns/rows map values by column order. condition_row indexes cue_condition_table. All original plot words, sound decisions, conditions and exclusions remain inline.',
    selected_scope:'Classify only selected_uncertainties original global origin/index/text. Other unknowns remain host-bound and belong to other batches; no local-index remapping.',
    output_refs:'Host restores original text/source, component text from Unicode text_range(null=whole sentence), basis.quote, and condition_refs relationship/threat. Cover mixed text exactly; no gaps/overlap. '
      +(batch.source_range_revision?'source_end_codepoint is the host-computed exclusive final index; source_codepoint_spans contain [start,end,exact original clause]. Never calculate a different final end. ':'')
      +'scope.event_ids are sound event IDs; original_mix=[]; never use beat IDs there.',
    ...(projected.data.literal_table?{literal_lookup:'Resolve literal_ref from inline literal_table; join literal_parts in order, including original punctuation/clocks. Output actual typed IDs/text.'}:{})};
  const metadataAudit={revision:compactV2?typedUnknownCompactProjectionRevision:'bounded-unknown-consumer-host-metadata-v1',
    omitted_fields:omitted,omitted_field_role:'immutable_execution_identity_duplicate_phase_index_and_local_editing_VAD; classifier_does_not_perform_local_ducking_or_lyric_overlap_audition',
    actual_selected_texts_retained:true,complete_plot_and_sound_constraints_retained:true,
    full_input_sha256:shaBytes(canonical(input)),qualified:false,production_approval:false};
  if(input.data.uncertainty_batch.fact_basis_projection_revision===undefined)return{input:projected,audit:metadataAudit};
  if(input.data.uncertainty_batch.fact_basis_projection_revision!==typedUnknownFactProjectionRevision)fail('unknown_fact_projection_revision_unknown');
  const facts=projectUnknownFactDependencies(projected);return{input:facts.input,audit:{...facts.audit,metadata_projection:metadataAudit}};
}
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('typed_style_' + reason); };
const refs = ['uncertainty_scopes', 'uncertainty_dispositions'];
export function expandTypedStyleLiterals(input) {
  const values = input.data?.literal_table ?? {};
  function expand(value) {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'literal_ref')) {
      if (!Object.hasOwn(values, value.literal_ref)) fail('unknown_literal_ref'); return values[value.literal_ref];
    }
    if (!Array.isArray(value) && Object.keys(value).length === 1 && Array.isArray(value.literal_parts)) {
      const parts = value.literal_parts.map(expand);
      if (parts.some(part => typeof part !== 'string')) fail('literal_parts_not_original_text');
      return parts.join('');
    }
    return Array.isArray(value) ? value.map(expand) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
  }
  const result = expand(input); delete result.data.literal_table; delete result.host_contract.literal_lookup;
  return result;
}
export function shareTypedStyleLiterals(input, { wholeFirst = false } = {}) {
  const counts = new Map();
  const parts = text => text.match(/[^。；，\n]+[。；，\n]?|[。；，\n]/gu) ?? [text];
  function collect(value) {
    if (typeof value === 'string') {
      if (wholeFirst && Buffer.byteLength(value) >= 40 && !/^[a-f0-9]{64}$/.test(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
      if (!/^[a-f0-9]{64}$/.test(value)) for (const part of parts(value)) if (Buffer.byteLength(part) >= 40)
        counts.set(part, (counts.get(part) ?? 0) + 1);
      return;
    }
    if (value && typeof value === 'object' && !(value.path && value.sha256)) Object.values(value).forEach(collect);
  }
  collect(input.data);
  const names = new Map([...counts].filter(([value, count]) => count > 1 && (count - 1) * Buffer.byteLength(JSON.stringify(value)) > count * 24 + 16)
    .map(([value], index) => [value, 'literal_' + index]));
  if (!names.size) return input;
  const used = new Set();
  function replace(value) {
    if (typeof value === 'string') {
      if (wholeFirst && names.has(value)) { used.add(names.get(value)); return { literal_ref: names.get(value) }; }
      const chunks = parts(value);
      if (!chunks.some(chunk => names.has(chunk))) return value;
      if (chunks.length === 1) { used.add(names.get(value)); return { literal_ref: names.get(value) }; }
      const result = { literal_parts: chunks.map(chunk => names.has(chunk) ? { literal_ref: names.get(chunk) } : chunk) };
      if (Buffer.byteLength(JSON.stringify(result)) >= Buffer.byteLength(JSON.stringify(value))) return value;
      chunks.filter(chunk => names.has(chunk)).forEach(chunk => used.add(names.get(chunk))); return result;
    }
    if (!value || typeof value !== 'object' || value.path && value.sha256) return value;
    return Array.isArray(value) ? value.map(replace) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  }
  const result = structuredClone(input); result.data = replace(result.data);
  result.data.literal_table = Object.fromEntries([...names].filter(([,name])=>!wholeFirst||used.has(name)).map(([value, name]) => [name, value]));
  result.host_contract.literal_lookup = 'literal_ref resolves to the identical original clause in inline data.literal_table. Join literal_parts in order to recover the complete original sentence, including every punctuation and clock. Dereference before reasoning; output actual IDs/text, never reference objects. No word, condition or unknown was removed.';
  if (Buffer.byteLength(JSON.stringify(result)) >= Buffer.byteLength(JSON.stringify(input))) return input;
  if (!same(expandTypedStyleLiterals(result), input)) fail('literal_projection_not_lossless');
  return result;
}
export function expandTypedStyleTables(value) {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && Array.isArray(value.columns) && Array.isArray(value.rows) && Object.keys(value).length === 2)
    return value.rows.map(row => Object.fromEntries(value.columns.map((key, i) => [key, expandTypedStyleTables(row[i])])));
  return Array.isArray(value) ? value.map(expandTypedStyleTables)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandTypedStyleTables(child)]));
}
function table(value) {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, table(child)]));
  if (value.length && value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    const columns = Object.keys(value[0]);
    if (value.every(row => same(Object.keys(row).sort(), [...columns].sort()))) {
      const encoded = { columns, rows: value.map(row => columns.map(key => table(row[key]))) };
      if (Buffer.byteLength(JSON.stringify(encoded)) < Buffer.byteLength(JSON.stringify(value))) return encoded;
    }
  }
  return value.map(table);
}

export async function prepareTypedStyleContract(input, { routePolicyPreflight = false, routeCreativeProjectionRevision = null,
  routeGuardRevision = null } = {}) {
  if (input.stage !== 'research_style_director' || input.frames?.length
    || !input.schema?.properties?.uncertainty_dispositions || !input.data?.source_video_sha256) fail('v2_complete_story_required');
  assertDirectionEditCapabilities(input);
  assertDirectionSoundPropulsion(input);
  const original = structuredClone(input), hydrated = structuredClone(input), full = input.data.independent_style_projection?.full_request;
  if (full) {
    await verifyEvidenceBindings(full); const source = await readJson(full.path);
    if (source.stage !== input.stage || source.data?.source_video_sha256 !== input.data.source_video_sha256
      || !same(source.schema, input.schema)) fail('full_story_binding_changed');
    const previous = expandTypedStyleTables(input.data.analysis), complete = source.data.analysis;
    if (!same(previous.uncertainties, complete.uncertainties) || !same(previous.sound_events, complete.sound_events)) fail('original_unknowns_changed');
    const a = previous.story_beats.map(({ sound_decision, ...beat }) => beat), b = complete.story_beats.map(({ sound_decision, ...beat }) => beat);
    if (!same(a, b)) fail('original_story_facts_changed');
    hydrated.data.analysis = table(complete);
  }
  const contract = projectCompactBusinessContract(hydrated), schema = contract.businessSchema;
  const analysis = expandTypedStyleTables(hydrated.data.analysis);
  const routeSchema = objectSchema(Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !refs.includes(key))));
  if(routeGuardRevision!==null&&routeGuardRevision!==nativeRouteGuardRevision)fail('route_guard_revision_unknown');
  if(original.data.director_domain_contract===hostExecutionNotesRevision){
    // structuredClone preserves aliases. Replace each *field occurrence*, not
    // a shared str/strings node: a beat enum must never constrain cue IDs,
    // reasons, evidence IDs or other otherwise-free string fields.
    const beatIds=analysis.story_beats.map(row=>row.id),opportunity=routeSchema.properties.cues?.items?.properties?.words_opportunity;
    const anchors=opportunity?.properties?.anchor_event_ids;
    if(anchors&&beatIds.length)opportunity.properties.anchor_event_ids={...anchors,items:{...anchors.items,enum:beatIds}};
    const boundary=routeSchema.properties.boundary_events?.items?.properties;
    if(boundary&&beatIds.length){boundary.story_beat_id={...boundary.story_beat_id,enum:beatIds};
      const evidenceIds=[...new Set(analysis.story_beats.flatMap(row=>row.evidence_ids))];
      boundary.evidence_ids={...boundary.evidence_ids,items:{...boundary.evidence_ids.items,enum:evidenceIds}};}
    routeSchema.properties.uncertainties={...routeSchema.properties.uncertainties,
      description:'Only NEW scene-specific unresolved story/physical/lyric/editorial requirements. Never duplicate analysis.uncertainties or host execution notes. Keep every genuine unknown.'};
  }
  if(routeGuardRevision!==null){
    if(original.data.director_domain_contract!==hostExecutionNotesRevision)fail('route_guard_host_domain_required');
    const words=routeSchema.properties.cues?.items?.properties?.words_opportunity?.properties;
    if(words?.anchor_event_ids)words.anchor_event_ids={...words.anchor_event_ids,minItems:1,
      description:'Use existing actual story_beat IDs from the supplied enum; never invent a beat or use a physical sound event ID.'};
    routeSchema.properties.boundary_events={...routeSchema.properties.boundary_events,
      description:'EXACTLY one entry for each SECOND and later cue at its frozen cue start. Never output a first-cue boundary or an internal development/accent. If there is only one mother cue, return [].'};
  }
  const body = structuredClone(contract.input); delete body.host_contract.business_shape;
  body.data.source_video_sha256 = input.data.source_video_sha256;
  body.data.typed_parent_input_sha256 = shaBytes(canonical(original));
  // Host-bound execution paths are not music/story facts. Retain them in the
  // original request; the full binding still makes them executor dependencies.
  if (full) body.data.full_direction_request = full;
  for (const key of ['independent_style_projection', 'completed_story', 'source_frame_mapping', 'frame_policy']) delete body.data[key];
  body.host_contract = { revision: typedBoundedStyleRevision,
    direction_output_refs: body.host_contract.direction_output_refs,
    source_policy: 'columns/rows are lossless tables: map each row value to its column in order. All original story words and clocks are inline; full_direction_request binds unchanged host metadata. No audio hearing approval.' };
  const route = structuredClone(body); delete route.host_contract.direction_output_refs;
  route.stage = typedStyleRouteStage; route.schema = routeSchema;
  if(routeGuardRevision!==null)route.data.route_guard_revision=routeGuardRevision;
  if(routeCreativeProjectionRevision!==null){
    if(routeCreativeProjectionRevision!==typedRouteCreativeProjectionRevision||original.data.director_domain_contract!==hostExecutionNotesRevision)
      fail('creative_projection_configuration_invalid');
    route.data.route_creative_projection_revision=routeCreativeProjectionRevision;
  }
  if (routePolicyPreflight) route.data.route_policy_revision = routeLanguageSummaryPolicyRevision;
  route.prompt = 'Plan the COMPLETE ordered episode sound route from all supplied story facts and original unknowns. '
    + 'Return only the typed route fields, including all sound_queries and any optional retrieval fields. '
    + 'Do not classify uncertainty_scopes/dispositions in this phase. New unknowns remain in uncertainties. '
    + 'Keep character control, relationship, danger, lyrics opportunities and boundaries grounded. '
    + 'Honor explicit male/female audience_preference; with auto infer from plot and may remain auto. '
    + 'With music_words_policy=prefer, explore any appropriate lyric language and define eligible words_opportunity before song choice. '
    + 'No selected song, audio hearing or approval is implied.';
  if (routePolicyPreflight) route.prompt += routeLanguageSummaryInstruction;
  if(routeGuardRevision!==null)route.prompt+=' boundary_events are ONLY cue-entry transitions: exactly one for each second/later cue at that cue start, never for the first cue. '
    +'A single continuous mother cue has boundary_events=[]. Internal emotional changes, development and accents stay in the existing cue route, not in boundary_events. '
    +'words_opportunity.anchor_event_ids must be supplied actual story beat IDs; never invent an ID.';
  if(original.data.director_domain_contract===hostExecutionNotesRevision)route.prompt+=
    ' Do NOT copy ANY analysis.uncertainties into route.uncertainties: existing matters are referenced by their original analysis indexes in the following classification phase. '
    +'The route uncertainties array is only genuinely NEW scene-specific unresolved story/physical/lyric/edit requirements. '
    +'Host execution_notes/source prediction qualification/input modalities/partition clocks/candidate stage status are retained host provenance, not new plot unknowns; do not recreate their boilerplate in uncertainties. '
    +'This is not permission to defer a true relationship, danger, physical synchronization, lyric or source-cleanliness gap. Preserve all original constraints and sound-query intents.';
  if(original.data.director_domain_contract===hostExecutionNotesRevision&&(original.prompt??'').includes('CLAP为英文训练'))route.prompt+=' CLAP retrieval queries must be short positive English acoustic descriptions, not long Chinese plot, negations or pending work. This does not restrict the song lyric language. Keep exclusions in case conditions and preserve full sound-query intent.';
  if (routeSchema.properties?.sound_queries?.items?.properties?.retrieval_query) route.prompt += soundRetrievalInstructionFor(original);
  if(assertDirectionEditCapabilities(original))route.prompt+=directionEditCapabilitiesInstruction;
  route.prompt+=directionSoundPropulsionInstructionFor(original);
  route.host_contract.output_encoding = 'Return the business object directly under the typed output schema; no business_json wrapper.';
  const sharedRoute = shareTypedStyleLiterals(route);
  if (!same(expandTypedStyleTables(expandTypedStyleLiterals(sharedRoute).data.analysis), analysis)) fail('analysis_projection_not_lossless');
  return { original, hydrated, contract, analysis, route: sharedRoute, body, routeSchema };
}

export function validateTypedStyleRoutePolicy(route, prepared) {
  validateDirectionEditRoutes(route,prepared.route);
  const revision = prepared.route.data.route_policy_revision;
  if (revision === undefined) return; // Historical request keeps its original contract.
  if (revision !== routeLanguageSummaryPolicyRevision) fail('route_policy_revision_unknown');
  const gaps = directionRoutePolicyGaps(route, prepared.analysis);
  if (gaps.length) fail('route_policy_invalid:' + gaps.join(','));
}

export function buildTypedStyleUncertaintyBatch(prepared, route, routeBinding, items, { maximumItems = 8, semanticPreflight = true,
  sourceRangeRevision = null } = {}) {
  validateSchema(route, prepared.routeSchema);
  if(sourceRangeRevision!==null&&sourceRangeRevision!==typedUnknownSourceRangeRevision)fail('source_range_revision_unknown');
  if (![8,16,32].includes(maximumItems)||!items.length || items.length > maximumItems) fail('bounded_unknown_batch_required');
  const schema = objectSchema(Object.fromEntries(refs.map(key => [key, { ...structuredClone(prepared.contract.businessSchema.properties[key]),
    minItems: items.length, maxItems: items.length }])));
  if (semanticPreflight) {
    const cueIds = route.cues.map(cue => cue.cue_id), scope = schema.properties.uncertainty_scopes.items.properties;
    // Replace occurrences: shared primitive schema nodes must not leak enums.
    scope.cue_ids = { ...scope.cue_ids, minItems: 1, items: { ...scope.cue_ids.items, enum: cueIds } };
    const conditions = schema.properties.uncertainty_dispositions.items.properties.components.items.properties.condition_refs.items.properties;
    conditions.cue_id = { ...conditions.cue_id, enum: cueIds };
  }
  const input = structuredClone(prepared.body); input.stage = typedStyleUncertaintyStage; input.schema = schema;
  // Scope decisions need cue functions, clocks and conditions, not another
  // copy of retrieval queries. The full unchanged route is host-bound.
  const completedQueryFields = ['audio_retrieval_query', 'words_audio_retrieval_query', 'source_tag_queries', 'expert_ids',
    ...(maximumItems>8?['story_sequence','required_action_ids']:[])];
  const cues = route.cues.map(cue => Object.fromEntries(Object.entries(cue).filter(([key]) => !completedQueryFields.includes(key))));
  if(maximumItems>8){
    const originals=structuredClone(cues),conditions=cues.flatMap(cue=>[cue.case_conditions,...(cue.exclude_case_conditions??[])]).filter(Boolean);
    const columns=Object.keys(conditions[0]??{}),rows=[];
    if(conditions.length&&conditions.every(row=>same(Object.keys(row).sort(),[...columns].sort()))){
      const bindCondition=row=>{let index=rows.findIndex(value=>same(value,row));if(index<0){index=rows.length;rows.push(row);}return{condition_row:index};};
      for(const cue of cues){if(cue.case_conditions)cue.case_conditions=bindCondition(cue.case_conditions);
        if(cue.exclude_case_conditions)cue.exclude_case_conditions=cue.exclude_case_conditions.map(bindCondition);}
      input.data.cue_condition_table={columns,rows:rows.map(row=>columns.map(key=>row[key]))};
      const expanded=cues.map(cue=>({...cue,case_conditions:originals.find(row=>row.cue_id===cue.cue_id).case_conditions,
        exclude_case_conditions:originals.find(row=>row.cue_id===cue.cue_id).exclude_case_conditions}));
      if(!same(expanded,originals))fail('cue_conditions_not_lossless');
      input.host_contract.cue_condition_lookup='condition_row indexes inline cue_condition_table.rows; columns define every original relationship, danger and exclusion value. No condition is omitted or re-decided.';
    }
    input.host_contract.direction_output_refs={instruction:'Only output the typed fields. Host restores original_text/source identity, exact components.text from text_range, basis.quote and condition_refs relationship/threat. text_range=null means the full selected original sentence; otherwise [start,end) Unicode offsets must exactly cover it. Use actual plot beat/field/evidence IDs for basis; scope.event_ids are SOUND EVENT IDs, never beat IDs. original_mix uses []; original_sound requires actual physical event IDs. Keep every constraint and unknown, no listening or approval claim.'};
  }
  input.data.cue_context = table(cues); input.data.direction_uncertainties = route.uncertainties;
  input.data.global_route_summary = route.global_route_summary;
  input.data.selected_uncertainties = sourceRangeRevision?items.map(item=>({...item,...sourceCodepointFields(item.text)})):items;
  input.data.completed_route = routeBinding;
  input.data.uncertainty_batch = { revision: typedBoundedStyleRevision, indexes: items.map(({ origin, uncertainty_index }) => ({ origin, uncertainty_index })) };
  if(sourceRangeRevision)input.data.uncertainty_batch.source_range_revision=sourceRangeRevision;
  if(prepared.route.data.route_creative_projection_revision===typedRouteCreativeProjectionRevision&&[16,32].includes(maximumItems))
    input.data.uncertainty_batch.fact_basis_projection_revision=typedUnknownFactProjectionRevision;
  if(maximumItems===32)input.data.uncertainty_batch.compact_projection_revision=typedUnknownCompactProjectionRevision;
  if (semanticPreflight) input.data.uncertainty_batch.semantic_contract_revision = typedStyleUncertaintySemanticRevision;
  if(maximumItems>8){input.data.uncertainty_batch.maximum_items=maximumItems;
    input.data.analysis=expandTypedStyleTables(input.data.analysis);delete input.data.analysis.uncertainties;
    input.data.analysis=table(input.data.analysis);delete input.data.direction_uncertainties;
    input.data.uncertainty_batch.global_origin_counts={analysis:prepared.analysis.uncertainties.length,direction:route.uncertainties.length};
    input.host_contract.selected_text_lookup='This phase classifies ONLY selected_uncertainties. Each entry includes original global origin/index and COMPLETE original text. Do not use local array position as a global index. Other original unknowns are bound in the complete original request/route and handled by other batches, not read or classified here. Complete plot beats, original sound decisions, style constraints and cue conditions/exclusions remain inline; prior route story_sequence remains frozen in completed_route, not re-decided.';}
  input.host_contract.output_encoding = 'Return uncertainty_scopes and uncertainty_dispositions directly under the typed output schema. Use original global indexes, not batch-local indexes.';
  input.prompt = 'Classify ONLY selected_uncertainties, exactly once in each output list, using the unchanged complete story and completed route. '
    + 'Original text and source identity are restored by the host, never paraphrased. Preserve all mixed components with exact text_range coverage. '
    + (sourceRangeRevision?'Use the host-provided source_end_codepoint as the exclusive final end, never count the text yourself. source_codepoint_spans gives [start,end,exact original clause] in Unicode code points, not UTF-16 units. Adjacent component ranges start at 0, meet without gaps/overlap and end exactly at source_end_codepoint; null means the whole original text. Preserve every clause and constraint. ':'')
    + 'Other unknowns stay visible as context; do not output them in this batch. Keep every real gap and sound limit. No audio hearing or qualification is granted. '
    + 'Use evidence_gap/before_specific_edit, narrative_constraint/persistent_narrative_constraint, deferred_review/after_trial_render or persistent_provenance_limit, pending_work/material_selection or words_selection only.';
  if (semanticPreflight) input.prompt += uncertaintySemanticInstruction;
  if(maximumItems===32)input.prompt=input.prompt.replace('Other unknowns stay visible as context; do not output them in this batch.',
    'Only selected original unknowns are classified here; every other original unknown remains unchanged in the host-bound full input and its later batch.');
  return shareTypedStyleLiterals(input,{wholeFirst:maximumItems>8});
}

// Plan every request before submitting any classifier. This retains original
// global indexes and exact literals; capacity changes only batch boundaries.
export function planTypedStyleUncertaintyBatches(prepared,route,routeBinding,items,{maximumItems=8,
  maxInputTokens,estimateBudget,sourceRangeRevision=null}={}){
  if(![8,16,32].includes(maximumItems)||!Number.isSafeInteger(maxInputTokens)||maxInputTokens<1
    ||typeof estimateBudget!=='function')fail('unknown_batch_capacity_plan_required');
  const result=[];
  for(let start=0;start<items.length;){
    let count=Math.min(maximumItems,items.length-start),input,budget;
    do{
      input=buildTypedStyleUncertaintyBatch(prepared,route,routeBinding,items.slice(start,start+count),{maximumItems,sourceRangeRevision});
      budget=estimateBudget(input);
      if(!Number.isSafeInteger(budget?.estimated_tokens)||budget.estimated_tokens<1)fail('unknown_batch_budget_estimate_required');
      if(budget.estimated_tokens<=maxInputTokens||count===1)break;
      count--;
    }while(count>0);
    result.push({input,budget,start,count,within_capacity:budget.estimated_tokens<=maxInputTokens});
    start+=count;
  }
  return result;
}

export const typedStyleUnknownItems = (prepared, route) => ['analysis', 'direction'].flatMap(origin =>
  (origin === 'analysis' ? prepared.analysis.uncertainties : route.uncertainties).map((text, uncertainty_index) => ({ origin, uncertainty_index, text })));
export function validateTypedStyleBatch(value, input, {encodingAudit = null} = {}) {
  assertSourceCodepointFields(input);
  input = expandTypedStyleLiterals(input);
  validateSchema(value, input.schema);
  const ids = input.data.selected_uncertainties.map(row => row.origin + '/' + row.uncertainty_index).sort();
  const pairs = { evidence_gap: ['before_specific_edit'], narrative_constraint: ['persistent_narrative_constraint'],
    deferred_review: ['after_trial_render', 'persistent_provenance_limit'], pending_work: ['material_selection', 'words_selection'] };
  for (const key of refs) if (!same(value[key].map(row => row.origin + '/' + row.uncertainty_index).sort(), ids)) fail('unknown_batch_identity_changed');
  for (const row of value.uncertainty_dispositions) for (const part of row.components)
    if (!pairs[part.kind]?.includes(part.required_stage)) fail('unknown_kind_stage_mismatch');
  if (input.data.uncertainty_batch?.semantic_contract_revision === typedStyleUncertaintySemanticRevision)
    validateTypedStyleBatchSemantics(value, input, encodingAudit);
}
// Rehydrate only the batch's immutable references, then run the same semantic
// checker used by the final consumer BEFORE another model batch is submitted.
// Other global indexes stay absent; no source unknown or route is rewritten.
function validateTypedStyleBatchSemantics(value, input, encodingAudit) {
  const data = expandTypedStyleTables(input.data), cues = structuredClone(data.cue_context);
  const resolveCondition = condition => Object.hasOwn(condition ?? {}, 'condition_row')
    ? data.cue_condition_table?.[condition.condition_row] : condition;
  for (const cue of cues) {
    cue.case_conditions = resolveCondition(cue.case_conditions);
    if (cue.exclude_case_conditions) cue.exclude_case_conditions = cue.exclude_case_conditions.map(resolveCondition);
  }
  const analysis = { ...data.analysis, source_video_sha256: data.source_video_sha256, uncertainties: [] };
  const direction = { direction_version: 2, cues, uncertainties: [],
    uncertainty_scopes: structuredClone(value.uncertainty_scopes), uncertainty_dispositions: structuredClone(value.uncertainty_dispositions) };
  for (const selected of data.selected_uncertainties)
    (selected.origin === 'analysis' ? analysis : direction).uncertainties[selected.uncertainty_index] = selected.text;
  for (const row of direction.uncertainty_dispositions) {
    const original = (row.origin === 'analysis' ? analysis : direction).uncertainties[row.uncertainty_index];
    const chars = Array.from(original); let end = 0, lastOriginalRange = null;
    row.original_text = original; row.source_video_sha256 = data.source_video_sha256;
    for (const component of row.components) {
      const range = component.text_range === null ? [0, chars.length] : component.text_range;
      if (!Array.isArray(range) || range.length !== 2 || range.some(n => !Number.isInteger(n))
        || range[0] !== end || range[1] <= range[0] || range[1] > chars.length) fail('batch_component_range_invalid');
      component.text = chars.slice(...range).join(''); end = range[1]; lastOriginalRange = [...range]; delete component.text_range;
      for (const basis of component.basis) {
        if(data.uncertainty_batch?.fact_basis_projection_revision===typedUnknownFactProjectionRevision&&basis.field==='sound_decision')
          fail('actual_story_fact_basis_required');
        const beat = analysis.story_beats.find(beat => beat.id === basis.story_beat_id);
        if (!beat || typeof beat[basis.field] !== 'string' || !beat[basis.field].trim()) fail('batch_basis_reference_invalid');
        basis.quote = beat[basis.field];
      }
      for (const ref of component.condition_refs) {
        const cue = cues.find(cue => cue.cue_id === ref.cue_id);
        if (!cue?.case_conditions) fail('batch_condition_reference_invalid');
        ref.relationship = cue.case_conditions.relationship; ref.threat_resolved = cue.case_conditions.threat_resolved;
      }
    }
    if (end !== chars.length) {
      // Match the existing compact decoder's exact terminal U+3002 rule.
      // Only this temporary semantic view is restored; raw model ranges stay
      // unchanged and actual merge still binds the reconstruction to receipts.
      if (end !== chars.length - 1 || chars[end] !== '。' || !lastOriginalRange || !row.components.length)
        fail('batch_component_range_invalid');
      row.components.at(-1).text += chars[end];
      encodingAudit?.push({revision:directionTerminalFullStopRecoveryRevision,
        source_video_sha256:data.source_video_sha256,origin:row.origin,uncertainty_index:row.uncertainty_index,
        component_index:row.components.length-1,original_text_sha256:shaBytes(original),
        original_range:lastOriginalRange,reconstructed_range:[lastOriginalRange[0],chars.length],
        appended_original_character:chars[end],semantic_classification_changed:false});
    }
  }
  inspectDirectionUncertainties(direction, analysis, { mode: data.execution_mode === 'research' ? 'assisted_trial' : data.execution_mode });
}
export function mergeTypedStyleResult(prepared, route, batches, { encodingAudit = null, batchSources = null } = {}) {
  const business = { ...route, ...Object.fromEntries(refs.map(key => [key, batches.flatMap(batch => batch[key])])) };
  const recovered=[];
  const value=restoreCompactBusinessValue({ business_json: JSON.stringify(business) }, prepared.contract,
    encodingAudit===null?{}:{terminalFullStopRecovery:directionTerminalFullStopRecoveryRevision,encodingAudit:recovered});
  for(const row of recovered){
    const indexes=batches.flatMap((batch,index)=>batch.uncertainty_dispositions.some(item=>item.origin===row.origin
      &&item.uncertainty_index===row.uncertainty_index)?[index]:[]);
    const source=indexes.length===1?batchSources?.[indexes[0]]:null;
    if(!source?.actual_raw_response?.path||!/^[a-f0-9]{64}$/.test(source.actual_raw_response.sha256??'')
      ||!source.request?.path||!/^[a-f0-9]{64}$/.test(source.request.sha256??''))fail('component_encoding_actual_batch_binding_required');
    encodingAudit.push({...row,actual_raw_response:source.actual_raw_response,request:source.request});
  }
  return value;
}

// This is also the fresh/resume proof used by the existing checkpoint reader.
// Completion readers must reconstruct the exact producer contract, including
// opt-in host codepoint metadata. Recomputing the fields also rejects forgery.
export function rebuildTypedStyleCompletionBatch(prepared,route,routeBinding,selected,originalInput){
  return buildTypedStyleUncertaintyBatch(prepared,route,routeBinding,selected,{
    maximumItems:originalInput.data.uncertainty_batch.maximum_items??8,
    semanticPreflight:Boolean(originalInput.data.uncertainty_batch.semantic_contract_revision),
    sourceRangeRevision:originalInput.data.uncertainty_batch.source_range_revision??null});
}

export async function verifyTypedStyleCompletion({ raw, payload, request }) {
  if (raw.typed_style_merge?.revision !== typedBoundedStyleRevision || payload.role !== 'director'
    || payload.execution_kind !== 'codex_cli_inference' || raw.execution_kind !== 'codex_cli_inference'
    || raw.source_video_sha256 !== payload.source_video_sha256 || raw.model_revision!==payload.model_revision
    || raw.request_sha256 !== shaBytes(canonical(payload))) fail('actual_parent_execution_required');
  const stagePolicy=payload.typed_stage_reasoning_policy;
  if(stagePolicy&&(stagePolicy.revision!=='typed-stage-reasoning-identity-v1'
    ||typeof stagePolicy.base_model_revision!=='string'
    ||!same(Object.keys(stagePolicy.efforts??{}).sort(),['research_style_director',typedStyleRouteStage,typedStyleUncertaintyStage].sort())
    ||Object.values(stagePolicy.efforts).some(effort=>effort!==null&&!['low','medium','high','xhigh','max','ultra'].includes(effort))))
    fail('parent_stage_reasoning_policy_invalid');
  const expectedRevision=stage=>{
    if(!stagePolicy)return raw.model_revision;
    if(!Object.hasOwn(stagePolicy.efforts,stage))fail('child_stage_outside_parent_policy');
    const effort=stagePolicy.efforts[stage];return stagePolicy.base_model_revision+(effort?`:stage-reasoning-${effort}`:'');
  };
  if(expectedRevision(payload.input.stage)!==raw.model_revision)fail('parent_stage_reasoning_identity_changed');
  if (payload.typed_route_policy_revision !== undefined && payload.typed_route_policy_revision !== routeLanguageSummaryPolicyRevision)
    fail('route_policy_revision_unknown');
  const prepared = await prepareTypedStyleContract(payload.input,
    { routePolicyPreflight: payload.typed_route_policy_revision === routeLanguageSummaryPolicyRevision,
      routeCreativeProjectionRevision:payload.typed_route_creative_projection_revision??null,
      routeGuardRevision:payload.typed_route_guard_revision??null }), parts = [];
  const { baseStructuredEvidencePrompt, structuredEvidenceRetryPrompt, completedCliEventsValid, validateCompletedTurnCleanup } = await import('./codex_cli_runtime.mjs');
  for (const ref of raw.constituent_responses ?? []) {
    await verifyEvidenceBindings(ref); const child = await readJson(ref.path);
    if(child.host_single_cue_boundary_normalization||child.host_route_anchor_merge||child.host_boundary_merge||child.host_completed_native_route_reuse||child.restoration){const {loadNativeRouteAnchorRecovery}=await import('./native_route_anchor_recovery.mjs');
      const checked=await loadNativeRouteAnchorRecovery(ref,{input:prepared.route,expectedModelRevision:expectedRevision(prepared.route.stage)});
      parts.push({child:checked,input:prepared.route,binding:ref});continue;}
    if(child.host_completed_native_uncertainty_reuse){
      const{loadCompletedTypedUncertaintyRecovery}=await import('./completed_typed_uncertainty_recovery.mjs');
      await verifyEvidenceBindings(child.host_completed_native_uncertainty_reuse.current_batch_input);
      const input=await readJson(child.host_completed_native_uncertainty_reuse.current_batch_input.path);
      const checked=await loadCompletedTypedUncertaintyRecovery(ref,{input,expectedModelRevision:expectedRevision(input.stage)});
      parts.push({child:checked,input,binding:ref});continue;}
    if(child.host_typed_unknown_range_merge){
      const{loadTypedUnknownRangeRecovery}=await import('./typed_unknown_range_recovery.mjs');
      await verifyEvidenceBindings(child.host_typed_unknown_range_merge.current_batch_input);
      const input=await readJson(child.host_typed_unknown_range_merge.current_batch_input.path);
      const checked=await loadTypedUnknownRangeRecovery(ref,{input,expectedModelRevision:expectedRevision(input.stage)});
      parts.push({child:checked,input,binding:ref});continue;}
    if (child.execution_kind !== 'codex_cli_inference' || child.actual_runtime_executed !== true
      || child.actual_input_processed !== true || !same(child.scopes, []) || child.synthetic_protocol_fixture
      || child.completion_status !== 'complete' || child.qualified !== false || child.artistic_approval !== false
      || child.production_approval !== false || child.actual_audio_processed !== false || child.actual_video_processed !== false
      || child.source_video_sha256 !== raw.source_video_sha256) fail('actual_child_completion_required');
    await verifyEvidenceBindings(child.evidence_files);
    const childRequest = child.evidence_files.find(row => path.resolve(row.path) === path.join(path.dirname(ref.path), 'request.json'));
    if (!childRequest) fail('child_request_required');
    const document = await readJson(childRequest.path);
    if (document.execution_kind !== 'codex_cli_inference' || document.typed_output_revision !== typedBoundedStyleRevision
      || document.role !== 'director' || document.source_video_sha256 !== raw.source_video_sha256
      || document.backend_id !== raw.backend_id || document.model_requested !== child.model
      ||document.model_revision!==expectedRevision(document.input?.stage)||child.model_revision!==document.model_revision
      ||stagePolicy&&(document.stage_reasoning_effort??null)!==stagePolicy.efforts[document.input?.stage]
      ||shaBytes(canonical(document))!==child.request_sha256) fail('child_request_changed');
    const completed = [...(child.cli_receipts ?? []), ...(child.historical_cli_receipts ?? [])];
    let proven = false, prior = null;
    for (const receiptRef of completed) {
      await verifyEvidenceBindings(receiptRef); const receipt = await readJson(receiptRef.path);
      if (receipt.status !== 'complete') { prior = receipt; continue; }
      if (receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
        || receipt.exit_code !== 0 && !receipt.completed_turn_cleanup
        || receipt.timed_out !== false || receipt.process_terminated !== true || receipt.synthetic_protocol_fixture
        || receipt.source_video_sha256 !== raw.source_video_sha256 || receipt.request_sha256 !== child.request_sha256
        || receipt.request?.sha256 !== childRequest.sha256 || receipt.model_revision !== expectedRevision(document.input.stage)) fail('child_receipt_changed');
      await verifyEvidenceBindings([receipt.final, receipt.schema, receipt.prompt, receipt.jsonl]);
      if (!same(await readJson(receipt.final.path), child.value)
        || !same(await readJson(receipt.schema.path), typedStyleProviderSchema(document.input.schema))) fail('child_final_changed');
      const promptInput = projectTypedStyleModelInput(document.input).input;
      const expectedPrompt = receipt.repair_of ? structuredEvidenceRetryPrompt('director', promptInput, {
        reason: receipt.repair_of, detail: prior?.detail ?? null,
        transportTimeoutRepair: receipt.repair_action === 'disable_failed_websocket_transport_use_chatgpt_https_preserve_evidence_and_reasoning' })
        : baseStructuredEvidencePrompt('director', promptInput);
      if (receipt.repair_of && (!prior || prior.status !== receipt.repair_of || !['schema_invalid', 'semantic_invalid', 'timeout'].includes(prior.status)
        || prior.request_sha256 !== child.request_sha256 || prior.cli_invocations !== 1 || prior.process_terminated !== true)) fail('unproved_child_repair');
      if (await readFile(receipt.prompt.path, 'utf8') !== expectedPrompt) fail('child_stdin_changed');
      const events = (await readFile(receipt.jsonl.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      if(!completedCliEventsValid(events))fail('child_actual_events_changed');
      if(receipt.terminal_result_origin!==undefined&&(receipt.terminal_result_origin!=='owned_completed_event'
        ||receipt.original_last_message_absent_at_capture!==true||path.basename(receipt.final.path)!=='terminal-event-final.json'
        ||!path.isAbsolute(receipt.original_last_message_path??'')
        ||path.resolve(receipt.original_last_message_path)===path.resolve(receipt.final.path))
        ||receipt.completed_turn_cleanup?.result_origin!==undefined
          &&receipt.completed_turn_cleanup.result_origin!==receipt.terminal_result_origin)fail('child_terminal_origin_changed');
      if (receipt.completed_turn_cleanup) validateCompletedTurnCleanup(receipt.completed_turn_cleanup,
        { events, finalBytes: await readFile(receipt.final.path), schema: typedStyleExpandedProviderSchema(document.input.schema) });
      const turns = events.filter(row => row.type === 'turn.completed');
      if (turns.length !== 1 ||!same(receipt.usage?.tokens,turns[0].usage)||receipt.usage?.reported_turns!==1
        || !same(JSON.parse(events.findLast(row => row.type === 'item.completed' && row.item?.type === 'agent_message')?.item.text ?? 'null'), child.value)) fail('child_actual_events_changed');
      proven = true;
    }
    if (!proven) fail('complete_child_receipt_required'); parts.push({ child, input: document.input, binding: ref });
  }
  if (!parts.length || !same(parts[0].input, prepared.route)) fail('route_request_changed');
  const route = parts[0].child.value, items = typedStyleUnknownItems(prepared, route), batches = []; let start = 0;
  validateTypedStyleRoutePolicy(route, prepared);
  for (const part of parts.slice(1)) {
    const count = part.input.data.selected_uncertainties.length, selected = items.slice(start, start + count);
    const expected = rebuildTypedStyleCompletionBatch(prepared,route,parts[0].binding,selected,part.input);
    if (!same(part.input, expected)) fail('unknown_request_changed');
    validateTypedStyleBatch(part.child.value, expected); batches.push(part.child.value); start += count;
  }
  const encodingAudit=[],batchSources=parts.slice(1).map(({child,binding})=>child.host_typed_unknown_range_merge
    ?{actual_raw_response:binding,request:child.host_typed_unknown_range_merge.original_request}
    :child.host_completed_native_uncertainty_reuse
    ?{actual_raw_response:child.host_completed_native_uncertainty_reuse.original_completed_batch,
      request:child.host_completed_native_uncertainty_reuse.original_request}
    :{actual_raw_response:binding,
      request:child.evidence_files.find(row=>path.resolve(row.path)===path.join(path.dirname(binding.path),'request.json'))});
  if (start !== items.length || !same(mergeTypedStyleResult(prepared, route, batches,{encodingAudit,batchSources}), raw.value)) fail('full_merge_changed');
  if(!same(encodingAudit,raw.typed_style_merge.component_text_encoding_recoveries??[]))fail('component_encoding_recovery_audit_changed');
  const { createCodexStyleSemanticValidator } = await import('./compose_codex_episode.mjs');
  const mode=payload.input.data.execution_mode??payload.input.data.mode;
  const{reloadDirectionExecutionBasis}=await import('./bound_direction_execution_evidence.mjs');
  const executionBasis=await reloadDirectionExecutionBasis(raw.direction_execution_basis,{sourceSha:raw.source_video_sha256,
    input:payload.input,analysis:prepared.analysis,mode:mode==='research'?'assisted_trial':mode});
  await createCodexStyleSemanticValidator(payload.input, { mode:executionBasis?'assisted_trial':mode,executionBasis })(raw.value);
  return true;
}
