import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { prepareSpecialistCandidateBatch } from './prepare_specialist_candidate_batch.mjs';
import { selectMaterials } from './material_selection.mjs';
import {normalizeSoundRetrievalQuery} from './sound_retrieval_contract.mjs';
import {validSpecialistDevice,specialistModelEnvironment} from './specialist_cache_identity.mjs';

const execute=promisify(execFile), scripts=path.dirname(fileURLToPath(import.meta.url));
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const load=async ref=>{await verifyEvidenceBindings(ref);return readJson(ref.path);};

function eventCases(parent,sourceSha,range) {
  const eligible=parent.cases.filter(row=>row.evidence?.source_video_sha256===sourceSha
    &&parent.episodes.some(episode=>episode.episode_id===row.episode_id&&episode.source_video?.sha256===sourceSha)
    &&Array.isArray(row.source_range)&&row.source_range.length===2&&row.source_range.every(Number.isFinite)
    &&row.source_range[0]<row.source_range[1]&&row.source_range[0]<range[1]&&range[0]<row.source_range[1]);
  const single=eligible.find(row=>row.source_range[0]<=range[0]&&range[1]<=row.source_range[1]);
  if(single)return [single];
  for(const episodeId of new Set(eligible.map(row=>row.episode_id))){
    let cursor=range[0];const covered=[];
    for(const item of eligible.filter(row=>row.episode_id===episodeId).sort((a,b)=>a.source_range[0]-b.source_range[0])){
      if(item.source_range[0]>cursor)break;
      if(item.source_range[1]<=cursor)continue;
      covered.push(item);cursor=item.source_range[1];if(cursor>=range[1])return covered;
    }
  }
  return [];
}

const commonConditions=cases=>Array.isArray(cases[0].conditions)
  ?cases[0].conditions.filter(value=>cases.every(item=>item.conditions.some(other=>JSON.stringify(other)===JSON.stringify(value))))
  :Object.fromEntries(Object.entries(cases[0].conditions??{}).filter(([key,value])=>cases.every(item=>JSON.stringify(item.conditions?.[key])===JSON.stringify(value))));
const unique=value=>[...new Map(value.map(item=>[JSON.stringify(item),item])).values()];

// A completed query is only an intention. This consumer retains current-target identity
// through existing recall, actual candidate observation, selector and research binding.
export async function prepareCompletedSoundQuery(config) {
  const completion=await load(config.completion_result), analysis=await load(completion.analysis);
  const parent=await load(config.case_input), raw=await load(completion.raw_response);
  await verifyEvidenceBindings(completion.source);
  if(completion.actual_runtime_executed!==true||raw.actual_runtime_executed!==true
    ||raw.input_sha256!==completion.request.sha256||completion.source.sha256!==analysis.source_video_sha256
    ||raw.source_video_sha256&&raw.source_video_sha256!==completion.source.sha256
    ||JSON.stringify(raw.value)!==JSON.stringify(completion.value))throw new Error('sound_material_actual_completed_query_required');
  const event=analysis.sound_events.find(row=>row.id===config.event_id);
  const query=completion.value.sound_queries.find(row=>row.event_id===config.event_id);
  if(!event||event.decision!=='seek_asset'||!query||!completion.event_ids.includes(event.id))
    throw new Error('sound_material_current_event_query_required');
  if((event.role==='ambience')!==(query.asset_kind==='ambience'))throw new Error('sound_material_query_kind_mismatch');
  const range=[event.start_seconds,event.end_seconds];
  if(!range.every(Number.isFinite)||range[0]<0||range[1]<=range[0])throw new Error('sound_material_event_range_invalid');
  const originals=eventCases(parent,analysis.source_video_sha256,range),original=originals[0];
  if(!original)throw new Error('sound_material_event_outside_bound_case');
  await verifyEvidenceBindings(originals.map(row=>row.evidence.files));
  const item=structuredClone(original), stepId=event.id+'_completed_query';
  item.case_id=original.case_id+'/sound-query/'+event.id;item.source_range=range;
  item.description=event.reason;item.source_role='current_unscored_target_not_reference_success_case';
  item.music_pack_ids=[];item.sound_pack_ids=[];item.theme_bundle_ids=[];
  if(originals.length>1){
    item.conditions=commonConditions(originals);
    item.exclude_case_conditions=unique(originals.flatMap(row=>row.exclude_case_conditions??[]));
    item.context_cases=originals.map(row=>({case_id:row.case_id,episode_id:row.episode_id,source_range:row.source_range,
      conditions:row.conditions,exclude_case_conditions:row.exclude_case_conditions}));
  }
  item.story_sequence=unique(originals.flatMap(row=>row.story_sequence)).filter(row=>row.event_anchor
    &&range[0]<=row.event_anchor.target_seconds&&row.event_anchor.target_seconds<=range[1]);
  item.evidence={...item.evidence,source_range:range,files:[config.case_input,config.completion_result,completion.analysis,
    completion.original_director,completion.raw_response,...unique(originals.flatMap(row=>row.evidence.files))],
    source_case_ids:originals.map(row=>row.case_id),observation_ids:event.evidence_ids,
    actual_audio_processed:false,evidence_status:'current_visual_query_intention_no_original_audio_audit',artistic_approval:false};
  item.source_events=[{event_id:event.id,kind:'sound',source_range:range,observation_ids:event.evidence_ids,
    description:event.reason,frame_ids:event.evidence_ids,existing_source_sound:'not_audited',missing_sound_confirmed:false}];
  item.development_preset={steps:[{step_id:stepId,source_event_id:event.id,action:'compare_'+event.role+'_query_material',
    anchor:event.id,offset_seconds:0,target_range:range,development_description:query.text,music_pack_ids:[],sound_pack_ids:[],window_refs:[]}]};
  const document={...parent,cases:[item],packs:[],sound_packs:[],theme_bundles:[],
    purpose:'completed_query_to_current_target_research_material_not_successful_reference',production_approval:false};
  const input=await saveJson(path.join(config.output_dir,'case-input.json'),document);
  const projection=normalizeSoundRetrievalQuery(query,event);
  const task={case_id:item.case_id,step_id:stepId,source_event_id:event.id,sound_role:event.role,
    reason:query.text+' 原声、起音、干净度与是否新增均未核验。',
    query:projection.ready?projection.retrieval:null,
    sound_query_projection:projection,
    evidence_files:[config.completion_result,completion.analysis,completion.raw_response]};
  return {input,document,task,event,query,projection};
}

// Literal translation to existing positive library labels, never an audio verdict.
// Negative/unknown clauses cannot be used as positive retrieval evidence.
export function soundQueryLabelExpansion(query,role,aliases=[]) {
  const projection=normalizeSoundRetrievalQuery({...query,asset_kind:role==='ambience'?'ambience':'sfx'},
    {start_seconds:0,end_seconds:1});
  if(!projection.ready)return null;
  const positive=projection.retrieval.text;
  const alias=aliases.find(row=>row.roles.includes(role)&&row.terms.some(term=>positive.includes(term)));
  return alias?{text:alias.label,reason:'One literal positive-label translation from the actual query: '+alias.terms.filter(term=>positive.includes(term)).join(', '),
    evidence:alias.evidence,original_intent:query.text,original_positive_query_text:positive,semantics_verified:false}:null;
}

export async function consumeCompletedSoundQuery(config,runtime={}) {
  await verifyEvidenceBindings(config.library);
  const prepared=await prepareCompletedSoundQuery(config), local=path.resolve(config.state_dir);
  await mkdir(local,{recursive:true});
  if(!prepared.projection.ready)return saveJson(path.join(config.output_dir,'handoff.json'),{
    schema_version:1,completion_result:config.completion_result,current_case:prepared.input,library:config.library,
    event_id:prepared.event.id,status:'query_repair_required',sound_query_projection:prepared.projection,
    selected_count:0,actual_audio_processed:false,actual_asset_selection_performed:false,
    original_sound_audit:'pending',exact_action_anchor_verified:false,missing_sound_confirmed:false,
    qualified:false,artistic_approval:false,production_approval:false});
  const runPython=async args=>execute(config.python,['-X','utf8',path.join(scripts,'corpus_materials.py'),...args],
    {windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});
  const retrieve=async(task,name)=>{
    const tasks=await saveJson(path.join(config.output_dir,name+'-tasks.json'),{schema_version:1,tasks:[task]});
    if(runtime.retrieve)return runtime.retrieve(prepared,tasks,name);
    const output=path.join(config.output_dir,name+'-candidates.json');
    await runPython(['--input',prepared.input.path,'--candidate-tasks',tasks.path,'--library-db',config.library.path,
      '--candidate-report',path.join(config.output_dir,name+'-recall.json'),'--output',output]);
    return bind(output);
  };
  let candidate=await retrieve(prepared.task,'original'), recalled=expandCandidateEvidence(await load(candidate));
  const original=candidate;
  let expansion=null;
  if(!recalled.tasks[0].candidates.length&&config.label_expansion){
    if(!config.label_expansion.text?.trim()||!config.label_expansion.reason?.trim()||!config.label_expansion.evidence?.length)
      throw new Error('sound_material_expansion_must_be_explicit_and_bound');
    const translated=normalizeSoundRetrievalQuery({...prepared.query,retrieval_query:config.label_expansion.text},prepared.event);
    if(!translated.ready)throw Error('sound_material_expansion_requires_positive_projection');
    await verifyEvidenceBindings(config.label_expansion.evidence);
    expansion=await saveJson(path.join(config.output_dir,'one-label-expansion.json'),{
      original_query:prepared.query,original_recall:original,...config.label_expansion,
      expansion_count:1,automatic_sound_semantics_approval:false});
    const task=structuredClone(prepared.task);task.query.text=config.label_expansion.text;
    task.evidence_files.push(expansion);
    candidate=await retrieve(task,'expanded');recalled=expandCandidateEvidence(await load(candidate));
  }
  const finish=async extra=>saveJson(path.join(config.output_dir,'handoff.json'),{
    schema_version:1,completion_result:config.completion_result,current_case:prepared.input,library:config.library,
    original_recall:original,candidate_file:candidate,label_expansion:expansion,event_id:prepared.event.id,
    original_sound_audit:'pending',exact_action_anchor_verified:false,missing_sound_confirmed:false,
    sound_semantics_verified:false,qualified:false,artistic_approval:false,production_approval:false,...extra});
  if(!recalled.tasks[0].candidates.length)return finish({status:'actual_recall_empty_after_bounded_expansion',selected_count:0,
    actual_asset_selection_performed:false,actual_audio_processed:false});
  const prepRef=await (runtime.prepare??prepareSpecialistCandidateBatch)({candidate_file:candidate.path,
    case_input:prepared.input.path,task_indices:[0],output_dir:path.join(config.output_dir,'observation'),
    config_dir:path.join(local,'configs'),model_configs:config.model_configs});
  const prep=await load(prepRef),receipts=[];
  for(const ref of prep.configs){
    const model=await load(ref);
    const receiptFile=path.join(model.output_dir,'receipt.json');
    if(runtime.observeBatch)await runtime.observeBatch(ref,model);
    else{
      const result=await execute(config.observer_python,['-X','utf8',path.join(scripts,'specialist_audio_observer.py'),'--config',ref.path],
        {windowsHide:true,encoding:'utf8',maxBuffer:1024*1024,env:specialistModelEnvironment(model,config.observer_env)});
      await writeFile(path.join(local,model.backend+'-stdout.log'),result.stdout,{flag:'wx'});
      await writeFile(path.join(local,model.backend+'-stderr.log'),result.stderr,{flag:'wx'});
    }
    const receipt=await readJson(receiptFile);
    if(!validSpecialistDevice(model.device)||receipt.device!==model.device
      ||receipt.model_revision!==model.model_revision||receipt.model_sha256!==model.model_sha256
      ||receipt.status!=='completed_unqualified'||receipt.jobs.some(row=>row.status!=='predicted'||row.forward_calls<=0))
      throw new Error('sound_material_actual_forward_incomplete');
    receipts.push(await bind(receiptFile));
  }
  const selector=await runtime.makeSelector(receipts,prepared.document);
  const selection=await (runtime.select??selectMaterials)({candidate_file:prep.candidate_file.path,input_file:prep.case_input.path,
    output_dir:path.join(config.output_dir,'select')},selector);
  let binding=null;
  if(selection.bindings_file){
    const output=path.join(config.output_dir,'bound-case.json');
    if(runtime.bind)binding=await runtime.bind(prep,selection,output);
    else{await runPython(['--input',prep.case_input.path,'--bindings',selection.bindings_file.path,
      '--library-db',config.library.path,'--output',output]);binding=await bind(output);}
  }
  return finish({status:selection.selected_count?'actual_research_material_binding_pending_original_audit':'actual_selector_retained_material_gap',
    selected_count:selection.selected_count,selection:await bind(path.join(config.output_dir,'select/selection-record.json')),
    binding,actual_candidate_windows:prep.unique_windows,actual_audio_receipts:receipts,
    actual_audio_processed:true,actual_asset_selection_performed:true});
}
