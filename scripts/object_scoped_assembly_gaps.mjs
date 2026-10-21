import {objectSchema, validateSchema, readJson, verifyEvidenceBindings, shaBytes} from './audio_api.mjs';
import {validatePreparedSoundFunction,isObservedAssemblySoundCandidate,validateObservedAssemblySoundFunction} from './sfx_event_function.mjs';

export const assemblyGapContractRevision='object-scoped-gap-v1';
const text=v=>typeof v==='string'&&Boolean(v.trim());
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const range=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&v[0]>=0&&Math.round(v[1]*48000)>Math.round(v[0]*48000);
const samples=v=>Math.round(v[1]*48000)-Math.round(v[0]*48000);
const fail=reason=>{throw Error('assembly_gap_'+reason);};
const kinds=['execution_blocker','exploration_record','post_render_check','qualification_gap'];
const reasons=['execution_missing_or_invalid','optional_words_compared_rejected','post_mix_scene_fit_and_sync',
 'post_mix_audibility','post_mix_seam_continuity','professional_hearing_qualification'];
export const assemblyGapRecordSchema=objectSchema({gap_index:{type:'integer',minimum:0},
 kind:{type:'string',enum:kinds},object_kind:{type:'string',enum:['episode','cue','event','asset']},
 object_id:{type:'string',minLength:1},evidence_ids:{type:'array',minItems:1,items:{type:'string',minLength:1}},
 reason_code:{type:'string',enum:reasons},next_action:{type:'string',minLength:1}});
export const assemblyGapPrompt=' Preserve every original execution_gaps string and return exactly one gap_records row per string, with its zero-based gap_index. '
 +'Bind object_kind/object_id and evidence_ids to assembly_gap_context. Unknown or ambiguous problems remain execution_blocker with reason_code execution_missing_or_invalid. '
 +'Missing or invalid required sources, identities, source bounds, coverage, phrases, required effects and edits are execution_blocker. '
 +'Only an already executed, source-bound optional words comparison listed in word_explorations may be exploration_record/optional_words_compared_rejected; require cannot. '
 +'Actual fit/sync, audibility and seam checks requiring the finished mix are post_render_check using the corresponding post_mix reason_code; these remain unperformed and must run after rendering. '
 +'Professional hearing eligibility alone may be qualification_gap/professional_hearing_qualification, never an approval. '
 +'Give a concrete next_action for each scoped record. Classification cannot alter any edit, waive a mandatory gap or grant hearing, phrase, artistic or production qualification.';

export function applyAssemblyGapSchema(schema,config){
 if(config.assembly_gap_contract_revision===undefined)return schema;
 if(config.assembly_gap_contract_revision!==assemblyGapContractRevision)fail('explicit_revision_required');
 const out=structuredClone(schema);out.properties.gap_records={type:'array',items:structuredClone(assemblyGapRecordSchema)};
 if(!out.required.includes('gap_records'))out.required.push('gap_records');return out;
}

export function assemblyGapContext(values,wordExplorations=[]){
 const sha=values.manifest.source_sha256;
 return {revision:assemblyGapContractRevision,source_video_sha256:sha,
  known_objects:{episode:[sha],cue:(values.director.cues??[]).map(row=>row.cue_id),
   event:(values.analysis.sound_events??[]).map(row=>row.id),
   asset:[...new Set(['music','words','sounds'].flatMap(key=>(values.candidates[key]??[]).flatMap(row=>[row.asset_id,row.segment_id]).filter(text)))]},
  evidence_ids:[...new Set([...(values.evidence_catalog.evidence??[]).map(row=>row.id),...wordExplorations.map(row=>row.evidence_id)])],
  words_requests:(values.director.cues??[]).map(row=>({cue_id:row.cue_id,requested_mode:row.words_candidate_request??null})),
  word_explorations:wordExplorations,qualification_granted:false,actual_audio_hearing_approved:false};
}

export function withAssemblyGapContract(request,config,context){
 if(config.assembly_gap_contract_revision===undefined)return request;
 if(context.revision!==assemblyGapContractRevision)fail('bound_context_required');
 return {...request,schema:applyAssemblyGapSchema(request.schema,config),
  data:{...request.data,assembly_gap_contract_revision:assemblyGapContractRevision,assembly_gap_context:context},
  prompt:request.prompt+assemblyGapPrompt};
}

// This receipt only proves the existing selector compared the actual supplied
// words candidates. It approves no lyric truth, complete phrase or new use.
export async function readAssemblyWordExplorations(values){
 const found=[],seen=new Set(),sha=values.manifest.source_sha256;
 for(const candidate of values.candidates.music??[]){
  const binding=candidate.selection_record;if(!binding||seen.has(binding.sha256))continue;seen.add(binding.sha256);
  await verifyEvidenceBindings(binding);const selection=await readJson(binding.path),provenance=selection.selection_provenance;
  if(!provenance?.selector_record||!provenance.raw_response||!provenance.input)continue;
  await verifyEvidenceBindings([provenance.selector_record,provenance.raw_response,provenance.input]);
  const selector=await readJson(provenance.selector_record.path),raw=await readJson(provenance.raw_response.path),input=await readJson(provenance.input.path);
  if(selector.source_video_sha256!==sha||input.source_video_sha256!==sha||selector.raw_response?.sha256!==provenance.raw_response.sha256
   ||selector.input?.sha256!==provenance.input.sha256||selector.actual_asset_selection_performed!==true
   ||raw.completion_status!=='complete'||!same(raw.value,selector.value))continue;
  for(const cue of values.director.cues??[]){
   if(cue.words_candidate_request!=='explore')continue;
   const task=input.tasks?.find(row=>row.cue_id===cue.cue_id+'/words'&&row.kind==='words');
   const decision=selector.value?.decisions?.find(row=>row.cue_id===cue.cue_id+'/words'&&row.kind==='words');
   const ids=task?.candidates?.map(row=>row.segment_id)??[],rejections=decision?.rejections??[];
   if(!ids.length||new Set(ids).size!==ids.length||!decision||decision.selected_segment_ids?.length!==0||!text(decision.adopt_reason)
    ||rejections.length!==ids.length||new Set(rejections.map(row=>row.segment_id)).size!==ids.length
    ||ids.some(id=>!rejections.some(row=>row.segment_id===id&&text(row.reason))))continue;
   const evidenceId='word-comparison/'+shaBytes(provenance.selector_record.sha256+'/'+cue.cue_id).slice(0,24);
   if(found.some(row=>row.evidence_id===evidenceId))continue;
   found.push({cue_id:cue.cue_id,requested_mode:'explore',status:'compared_rejected',source_video_sha256:sha,
    evidence_id:evidenceId,comparison_verified:true,selector_record:provenance.selector_record,
    raw_response:provenance.raw_response,input:provenance.input,candidate_segment_ids:ids,
    qualification_granted:false});
  }
 }
 return found;
}

const blocker=(objectKind,objectId,reasonCode,nextAction,details={})=>({kind:'execution_blocker',object_kind:objectKind,
 object_id:objectId,reason_code:reasonCode,next_action:nextAction,...details});
// Run before source measurements/editor requests, and again on actual adoption.
// Existing source identity/phrase/compile validators remain authoritative.
export function preflightAssemblyMaterials(values,{edits}={}){
 const gaps=[],sounds=values.candidates.sounds??[],words=values.candidates.words??[];
 for(const cue of values.director.cues??[]){
  if(cue.words_candidate_request!=='require')continue;
  const matching=words.filter(row=>row.parent_cue_id===cue.cue_id||row.cue_id===cue.cue_id+'/words');
  if(!matching.length||matching.every(row=>{
   const phrase=row.offline_observation?.words;
   return !range(row.source_range)||phrase?.complete_phrase!==true||!text(phrase.actual_words)
    ||!range(phrase.source_range)||!same(row.source_range,phrase.source_range);
  }))gaps.push(blocker('cue',cue.cue_id,
   'required_complete_words_material_missing','Prepare and verify an actual complete phrase for this required cue.'));
 }
 for(const event of values.analysis.sound_events??[]){
  if(event.decision!=='seek_asset')continue;
  const candidates=sounds.filter(row=>row.event_id===event.id);
  const valid=candidates.filter(candidate=>{
   if(!range(candidate.source_range))return false;
   try{
    if(isObservedAssemblySoundCandidate(candidate)&&candidate.adoption_pending!==false)
      validateObservedAssemblySoundFunction(candidate,event);
    else validatePreparedSoundFunction(candidate,event);
   }catch{return false;}
   const bed=candidate.sound_usage?.function==='bed'||candidate.sound_usage?.function==='ambience'||candidate.duration_role==='bed';
   if(bed&&samples(candidate.sound_usage?.usable_source_range??candidate.source_range)<samples([event.start_seconds,event.end_seconds]))return false;
   return bed||Number.isFinite(candidate.source_anchor_seconds)&&candidate.source_anchor_seconds>=candidate.source_range[0]
    &&candidate.source_anchor_seconds<candidate.source_range[1];
  });
  if(!valid.length)gaps.push(blocker('event',event.id,candidates.length?'required_sound_window_insufficient':'required_sound_material_missing',
   'Prepare an actually selected source window and anchor/function covering this unchanged required event.',
   {target_range:[event.start_seconds,event.end_seconds],event_role:event.role}));
  else if(edits&&!edits.sounds?.some(row=>row.event_id===event.id&&row.decision==='new_asset'
   &&valid.some(candidate=>candidate.segment_id===row.selected_segment_id)))gaps.push(blocker('event',event.id,
   'required_sound_event_not_adopted','Repair the actual sound adoption; do not relabel the required event as optional.'));
 }
 return {revision:assemblyGapContractRevision,source_video_sha256:values.manifest.source_sha256,
  status:gaps.length?'assembly_material_execution_gap':'assembly_materials_technically_available',execution_blockers:gaps,
  qualification_granted:false,production_approval:false,new_model_calls:0};
}

export function auditAssemblyGapDisposition(value,context){
 const original=value.execution_gaps??[];
 if(!Array.isArray(original)||original.some(row=>!text(row)))fail('original_gap_strings_required');
 const result={revision:assemblyGapContractRevision,source_video_sha256:context.source_video_sha256,
  original_execution_gaps:[...original],execution_blockers:[],exploration_records:[],post_render_checks:[],qualification_gaps:[],
  technical_validation_required:false,qualification_granted:false,production_approval:false};
 if(value.gap_records===undefined){
  result.execution_blockers=original.map((message,gap_index)=>({...blocker('episode',context.source_video_sha256,
   'untyped_original_gap','Classify this exact gap with bound object and evidence; do not assume it is optional.'),gap_index,text:message}));return result;
 }
 if(!Array.isArray(value.gap_records)||value.gap_records.length!==original.length
  ||new Set(value.gap_records.map(row=>row.gap_index)).size!==original.length)fail('exact_gap_index_union_required');
 for(const record of value.gap_records){
  validateSchema(record,assemblyGapRecordSchema);
  if(!original[record.gap_index]||!context.known_objects[record.object_kind]?.includes(record.object_id)
   ||new Set(record.evidence_ids).size!==record.evidence_ids.length||record.evidence_ids.some(id=>!context.evidence_ids.includes(id))
   ||!text(record.next_action))fail('bound_object_and_evidence_required');
  const row={...structuredClone(record),text:original[record.gap_index]};
  if(record.kind==='execution_blocker'){
   if(record.reason_code!=='execution_missing_or_invalid')fail('execution_reason_required');
   result.execution_blockers.push(row);continue;
  }
  if(record.kind==='exploration_record'){
   const request=context.words_requests.find(item=>item.cue_id===record.object_id);
   const comparison=context.word_explorations.find(item=>item.cue_id===record.object_id&&item.requested_mode==='explore'
    &&item.status==='compared_rejected'&&item.source_video_sha256===context.source_video_sha256
    &&item.comparison_verified===true&&record.evidence_ids.includes(item.evidence_id));
   if(record.reason_code!=='optional_words_compared_rejected'||record.object_kind!=='cue'||request?.requested_mode!=='explore'||!comparison)
    fail('actual_optional_comparison_required');
   result.exploration_records.push(row);
  }else if(record.kind==='post_render_check'){
   if(!['post_mix_scene_fit_and_sync','post_mix_audibility','post_mix_seam_continuity'].includes(record.reason_code))fail('post_render_reason_required');
   result.post_render_checks.push({...row,status:'pending_actual_render_and_review'});
  }else{
   if(record.reason_code!=='professional_hearing_qualification')fail('qualification_reason_required');
   result.qualification_gaps.push({...row,status:'not_qualified'});
  }
  result.technical_validation_required=true;
 }
 return result;
}
