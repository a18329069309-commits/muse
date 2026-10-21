// Prompt-only representation. Exact predictions and timing remain in the bound full request.
import {shaBytes} from './audio_api.mjs';
import {projectSfxMaterialSelectionInput,sfxMaterialSelectionProjectionRevision} from './sfx_material_selection_projection.mjs';
export const materialObservationProjectionRevision='window_prediction_tables_and_acoustic_prompt_v4';
// Flat specialist windows (not the music window grid above) retain every ASR
// value and every class probability. Only host execution metadata is referenced.
export function projectFlatMaterialObservations(input){
  if(!input.input?.path||!input.input.sha256)throw new Error('material_projection_full_request_required');
  if(input.sfx_material_selection_projection!==undefined){
    if(input.sfx_material_selection_projection!==sfxMaterialSelectionProjectionRevision)throw Error('sfx_material_projection_revision_invalid');
    return projectSfxMaterialSelectionInput(input);
  }
  const output=structuredClone(input),semantics=new Map();
  if(!output.tasks.some(task=>task.candidates.some(candidate=>Array.isArray(candidate.observation?.predictions))))return output;
  for(const key of ['observation_files','visual_files'])if(Array.isArray(output[key])){
    output[key+'_host_evidence']={json_pointer:'/'+key,count:output[key].length};delete output[key];
  }
  for(const [taskIndex,task]of output.tasks.entries())for(const [candidateIndex,candidate]of task.candidates.entries()){
    const observation=candidate.observation;
    if(!Array.isArray(observation?.predictions))continue;
    observation.actual_execution_proof_indices=[taskIndex,candidateIndex];
    delete observation.evidence;delete observation.input_pcm_by_backend;
    delete candidate.asset_id;delete candidate.model_revision;
    for(const prediction of observation.predictions){
      delete prediction.model_revision;delete prediction.model_sha256;
      if(prediction.scores&&Object.keys(prediction.scores).length===2
        &&typeof prediction.scores.path==='string'&&/^[a-f0-9]{64}$/i.test(prediction.scores.sha256??''))delete prediction.scores;
      if(Array.isArray(prediction.top_labels)&&prediction.top_labels.every(row=>Object.keys(row).length===2
        &&Object.hasOwn(row,'label')&&Object.hasOwn(row,'probability'))){
        prediction.top_label_columns=['label','probability'];
        prediction.top_labels=prediction.top_labels.map(row=>[row.label,row.probability]);
      }
    }
    const fields={};
    for(const key of ['scope','limitations','sound_semantics_verified','lyrics_verified','artistic_approval'])
      if(Object.hasOwn(observation,key)){fields[key]=observation[key];delete observation[key];}
    const encoded=JSON.stringify(fields);
    if(!semantics.has(encoded))semantics.set(encoded,{id:'semantics-'+(semantics.size+1),fields});
    observation.sound_semantics_ref=semantics.get(encoded).id;
  }
  output.shared_sound_semantics=[...semantics.values()];
  for(const context of output.case_context??[]){
    const states=(context.story_sequence??[]).flatMap(step=>[step.before,step.after]);
    if(!states.length||states.some(state=>!state||typeof state!=='object'||Array.isArray(state)))continue;
    const columns=Object.keys(states[0]);
    if(!states.every(state=>Object.keys(state).length===columns.length&&columns.every(key=>Object.hasOwn(state,key))))continue;
    context.story_state_columns=columns;
    for(const step of context.story_sequence){step.before=columns.map(key=>step.before[key]);step.after=columns.map(key=>step.after[key]);}
  }
  if(Array.isArray(output.excluded_windows))output.excluded_windows=output.excluded_windows.map(row=>({
    segment_id:row.segment_id,source_range:row.source_range,gap:row.gap,reason:row.reason}));
  output.host_execution_proof={revision:'flat_material_exact_tables_v1',full_request:input.input,
    scope:'Task/candidate indices bind omitted asset/model identity, PCM hashes and execution files. ASR and all probabilities remain exact. story_state_columns names before/after array values; shared_sound_semantics fields apply by reference.'};
  return output;
}
export function projectMaterialObservations(input,activityScores={}){
  if(!input.input?.path||!input.input.sha256)throw new Error('material_projection_full_request_required');
  const output=structuredClone(input), refs=[];
  for(const [taskIndex,task] of output.tasks.entries())for(const [candidateIndex,candidate] of task.candidates.entries()){
    const original=candidate.observation;if(!Array.isArray(original.window_predictions))continue;
    const pointer=`/tasks/${taskIndex}/candidates/${candidateIndex}/observation`;
    const reference={...input.input,json_pointer:pointer};refs.push(reference);
    const evidenceRef={observation_ref:refs.length-1};
    const activityColumns=['Speech','Music','Singing','Humming','Silence'];
    const windows=original.window_predictions.map(window=>{
      const asr=window.predictions.find(row=>row.backend_id==='qwen3_asr'),panns=window.predictions.find(row=>row.backend_id==='panns_sed');
      if(!asr||!panns||window.predictions.length!==2)throw new Error('material_projection_backend_pair_required');
      const activity={...panns.human_activity_scores,...activityScores[JSON.stringify([candidate.source_sha256,window.source_range])]};
      return [window.source_range,{parsed:asr.parsed,
        ...(typeof asr.parsed?.transcription==='string'&&asr.raw_output?.includes(asr.parsed.transcription)
          ?{}:{raw_output:asr.raw_output})},
        [panns.top_labels.slice(0,8).map(row=>[row.label,row.probability]),activityColumns.map(key=>activity[key]??null)]];
    });
    const features=structuredClone(original.auxiliary_acoustic_features);
    const envelopeCount=features.rms_envelope_half_second?.length??0;delete features.rms_envelope_half_second;
    for(const field of ['beats_relative_seconds','downbeats_relative_seconds','onset_relative_seconds']){
      const times=features[field];
      features[field+'_count']=times.length;
      features[field]=times.length<=24?times.map(value=>Number(value.toFixed(3))):undefined;
      if(times.length>24)features[field+'_edge_preview']={first:times.slice(0,12).map(value=>Number(value.toFixed(3))),last:times.slice(-12).map(value=>Number(value.toFixed(3))),
        scope:'bounded_prompt_preview_not_complete_positions',full_positions:{...evidenceRef,json_pointer_suffix:'/auxiliary_acoustic_features/'+field}};
    }
    features.prompt_only_timing_precision_seconds=0.001;features.full_precision_and_rms_envelope_in=evidenceRef;
    features.rms_envelope_half_second_count=envelopeCount;
    candidate.observation={scope:original.scope,window_prediction_columns:['source_range','qwen3_asr','panns_sed'],window_predictions:windows,
      panns_columns:['top_labels','human_activity_scores'],panns_top_label_columns:['label','probability'],human_activity_score_columns:activityColumns,
      backend_prediction_semantics:{qwen3_asr:{qualified:false,transcription_is_unverified_prediction:true,lyrics_verified:false,
        raw_output_retained_in:evidenceRef,empty_transcription_does_not_prove_instrumental:true},panns_sed:{qualified:false,exact_event_onsets_verified:false,low_singing_does_not_prove_no_lyrics:true}},
      auxiliary_acoustic_features:features,
      lyrics_verified:false,sound_semantics_verified:false,artistic_approval:false,limitations:original.limitations,
      full_observation_in:evidenceRef,prompt_projection_revision:materialObservationProjectionRevision};
  }
  output.observation_projection={revision:materialObservationProjectionRevision,full_request:input.input,
    original_observation_refs:refs,original_tasks_sha256:shaBytes(JSON.stringify(input.tasks)),
    prompt_tasks_sha256:shaBytes(JSON.stringify(output.tasks)),semantic_conditions_unchanged:true,
    source_ranges_unchanged:true,precision_change_scope:'prompt_copy_only_not_render_or_source_anchors'};
  // Repeated administrative development descriptions are stored once, in full.
  // Conditions, order, IDs, source ranges, and every distinct sentence remain unchanged.
  const counts=new Map(),ids=new Map(),table={};
  const isText=(key,value)=>['description','development_description','reason'].includes(key)&&typeof value==='string'&&value.length>=80;
  function count(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(isText(key,item))counts.set(item,(counts.get(item)??0)+1);else count(item);}}
  count(output);
  function replace(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){
    if(isText(key,item)&&counts.get(item)>1){let id=ids.get(item);if(!id){id='text-'+(ids.size+1);ids.set(item,id);table[id]=item;}value[key]={metadata_text_ref:id};}else replace(item);}}
  replace(output);output.metadata_text_table=table;
  output.observation_projection.metadata_text_scope='lossless_repeated_description_interning_not_story_summarization';
  return output;
}
