import path from 'node:path';
import {readJson, verifyEvidenceBindings} from './audio_api.mjs';
import {sfxEventFunctionRevision,validatePreparedSoundFunction,validateSelectedSoundUsage,
  isObservedAssemblySoundCandidate,validateObservedAssemblySoundFunction} from './sfx_event_function.mjs';
import {verifyObservedAssemblySfxCandidate} from './assembly_sfx_candidate_pool.mjs';

const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
const refEqual=(a,b)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&typeof b?.path==='string'
  &&path.resolve(a.path)===path.resolve(b.path);
const fail=reason=>{throw Error('assembly_material_observation_'+reason);};
const load=async binding=>{await verifyEvidenceBindings(binding);return readJson(binding.path);};

// Music observations embed their facts. Legacy frozen PCM sound receipts bind
// processing evidence instead; recover the identical facts actually submitted
// to selection, never fill missing sound facts from a filename or a prediction.
export async function readActualAssemblyMaterialObservation({candidate, observationDocument, selectionDocument}) {
  if(isObservedAssemblySoundCandidate(candidate)){
    if(candidate.adoption_pending===false)validatePreparedSoundFunction(candidate);
    else validateObservedAssemblySoundFunction(candidate);
    const verified=await verifyObservedAssemblySfxCandidate({candidate,poolDocument:selectionDocument,
      sourceSha:candidate.current_target_video_sha256});
    if(!same(await load(candidate.observation_record),observationDocument)
      ||!same(observationDocument?.observations,verified.observation.observations)
      ||observationDocument.actual_audio_processed!==true||observationDocument.actual_audio_listened!==false
      ||observationDocument.qualified!==false||observationDocument.production_approval!==false)
      fail('observed_pool_facts_changed');
    return structuredClone(verified.observation.observations);
  }
  if(candidate.sound_function_intent!==undefined||candidate.sound_usage!==undefined){
    validatePreparedSoundFunction(candidate);
    const prepared=selectionDocument?.prepared_candidate,provenance=selectionDocument?.selection_provenance;
    if(selectionDocument?.kind!=='sound_pool_pending_final_assembly'||!prepared
      ||prepared.segment_id!==candidate.segment_id||prepared.asset_id!==candidate.asset_id
      ||prepared.source_sha256!==candidate.source_sha256||!same(prepared.source_range,candidate.source_range)
      ||!refEqual(prepared.observation_record,candidate.observation_record)
      ||['sound_function_intent','sound_usage','selection_source_ranges','selector_adopt_reason'].some(field=>!same(candidate[field],prepared[field])))
      fail('selected_function_pool_changed');
    const record=await load(provenance?.selector_record),request=await load(record.input),raw=await load(provenance.raw_response);
    if(!refEqual(record.raw_response,provenance.raw_response)||record.automatic_selection_performed!==true
      ||raw.input_sha256!==record.input.sha256||request.sfx_event_function_revision!==sfxEventFunctionRevision)
      fail('selected_function_request_changed');
    if(request.source_video_sha256!==selectionDocument.source_video_sha256
      ||prepared.current_target_video_sha256!==selectionDocument.source_video_sha256)fail('target_identity_changed');
    const task=request.tasks?.find(row=>row.case_id===prepared.target_case_id&&row.step_id===prepared.target_step_id);
    const choice=raw.value?.decisions?.find(row=>row.case_id===prepared.target_case_id&&row.step_id===prepared.target_step_id);
    if(!task||!choice||!same(task.sound_function_intent,prepared.sound_function_intent)
      ||!same(choice.sound_usage,prepared.sound_usage)||choice.adopt_reason!==prepared.selector_adopt_reason
      ||validateSelectedSoundUsage(choice,task))fail('selected_function_choice_changed');
    const selected=task.candidates?.find(row=>row.segment_id===candidate.segment_id);
    if(!selected||selected.asset_id!==candidate.asset_id||selected.source_sha256!==candidate.source_sha256
      ||!same(selected.source_range,candidate.source_range))fail('selected_function_source_changed');
    const embeddedFacts=observationDocument?.observation??observationDocument?.observations;
    if(embeddedFacts&&typeof embeddedFacts==='object'
      &&(!same(await load(candidate.observation_record),observationDocument)||!same(embeddedFacts,selected.observation)))
      fail('selected_function_embedded_facts_changed');
  }
  const embedded=observationDocument?.observation??observationDocument?.observations;
  if(embedded&&typeof embedded==='object')return embedded;
  if(observationDocument?.kind!=='frozen_offline_pcm_technical_observation'
    ||selectionDocument?.kind!=='sound_pool_pending_final_assembly')fail('supported_bound_facts_required');
  const prepared=selectionDocument.prepared_candidate,heard=prepared?.listening_evidence;
  if(!prepared||!heard||!heard.observations||typeof heard.observations!=='object'
    ||prepared.segment_id!==candidate.segment_id||prepared.asset_id!==candidate.asset_id
    ||prepared.source_sha256!==candidate.source_sha256||!same(prepared.source_range,candidate.source_range)
    ||heard.source_sha256!==candidate.source_sha256||!same(heard.source_range,candidate.source_range)
    ||!refEqual(prepared.observation_record,candidate.observation_record)
    ||!refEqual(heard.observation_record,candidate.observation_record)
    ||observationDocument.source_sha256!==candidate.source_sha256
    ||!same(observationDocument.source_range,candidate.source_range)
    ||observationDocument.actual_audio_processed!==true||observationDocument.qualified!==false
    ||observationDocument.artistic_approval!==false||observationDocument.production_approval!==false
    ||heard.actual_audio_processed!==true||heard.actual_audio_listened!==false
    ||heard.observations.sound_semantics_verified!==false||heard.observations.usage_approved!==false
    ||heard.observations.lyrics_verified!==false)fail('pcm_candidate_or_facts_changed');
  const provenance=selectionDocument.selection_provenance;
  await verifyEvidenceBindings([provenance?.selector_record,provenance?.raw_response,provenance?.case_input]);
  const record=await load(provenance.selector_record);
  if(!refEqual(record.raw_response,provenance.raw_response)||record.automatic_selection_performed!==true
    ||record.artistic_approval!==false||record.production_approval!==false)fail('actual_selector_required');
  const submitted=await load(record.input);
  await verifyEvidenceBindings(record.observation_files);
  if(submitted.source_video_sha256!==selectionDocument.source_video_sha256
    ||prepared.current_target_video_sha256!==selectionDocument.source_video_sha256)fail('target_identity_changed');
  const matches=(submitted.tasks??[]).flatMap(task=>task.candidates??[]).filter(row=>
    row.segment_id===candidate.segment_id&&row.asset_id===candidate.asset_id
    &&row.source_sha256===candidate.source_sha256&&same(row.source_range,candidate.source_range));
  if(!matches.length||matches.some(row=>!same(row.observation,heard.observations)))fail('submitted_observation_changed');
  if(!(record.observation_files??[]).some(ref=>refEqual(ref,candidate.observation_record)))fail('pcm_record_not_submitted');
  const pcm=await load(observationDocument.pcm_receipt),facts=heard.observations;
  if(pcm.kind!=='local_sound_actual_pcm_decode'||pcm.pcm_sha256!==candidate.source_sha256
    ||pcm.sample_rate_hz!==48000||pcm.channels!==2||!Number.isSafeInteger(pcm.decoded_samples)||pcm.decoded_samples<=0
    ||pcm.full_decode?.exit_code!==0||pcm.full_decode.strict_errors!==true||pcm.sound_facts_qualified!==false
    ||!same(facts.actual_clock,{samples:pcm.decoded_samples,sample_rate_hz:48000,source_range:[0,pcm.decoded_samples/48000]})
    ||!same(facts.window_source_range,candidate.source_range)
    ||candidate.source_range[0]<0||candidate.source_range[1]>pcm.decoded_samples/48000
    ||facts.whole_recording_measurements?.peak_dbfs!==pcm.profile?.peak_dbfs
    ||facts.whole_recording_measurements?.rms_dbfs!==pcm.profile?.rms_dbfs
    ||!same(facts.whole_recording_measurements.source_range,[0,pcm.decoded_samples/48000]))fail('bound_pcm_clock_or_level_changed');
  const measured=(pcm.profile.transient_candidates??[]).filter(row=>Number.isSafeInteger(row.sample_index)
    &&row.sample_index>=0&&row.sample_index<pcm.decoded_samples&&row.seconds===row.sample_index/48000
    &&row.seconds>=candidate.source_range[0]&&row.seconds<candidate.source_range[1]);
  if(!same(measured,facts.measured_transient_candidates))fail('bound_pcm_transient_changed');
  const optional=observationDocument.optional_specialist;
  if(optional?.status==='unqualified_predictions_consumed'){
    const predicted=await load(optional.response);
    await verifyEvidenceBindings(predicted.evidence_files);
    if(predicted.source_video_sha256!==candidate.source_sha256||!same(predicted.source_range,candidate.source_range)
      ||predicted.actual_input_processed!==true||!same(predicted.value?.predictions,facts.specialist_predictions)
      ||!same(predicted.value?.limitations,facts.specialist_limitations))fail('bound_specialist_prediction_changed');
  }else if((facts.specialist_predictions??[]).length)fail('bound_specialist_prediction_required');
  // Returning the historical object verbatim preserves every clock, raw
  // probability and limitation. This does not add observation or qualification.
  return structuredClone(heard.observations);
}
