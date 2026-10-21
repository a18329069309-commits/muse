import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readJson,saveJson,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {expandCandidateEvidence} from './candidate_evidence.mjs';
import {observeMaterialCandidates} from './material_selection.mjs';
import {measureDiagnosticSfxAnchor,verifyDiagnosticSfxAnchor} from './diagnostic_sfx_anchor.mjs';
import {measureDiagnosticBedPlacement,verifyDiagnosticBedPlacement} from './diagnostic_bed_placement.mjs';
import {validateSoundFunctionIntent,validateObservedAssemblySoundFunction} from './sfx_event_function.mjs';

export const assemblySfxCandidatePoolRevision='observed-candidates-final-assembly-v1';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),run=promisify(execFile);
const load=async ref=>{await verifyEvidenceBindings(ref);return readJson(ref.path);};
const bind=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const fail=reason=>{throw Error('assembly_sfx_observed_pool_'+reason);};
const inside=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===2&&b.length===2
  &&a.every(Number.isFinite)&&b.every(Number.isFinite)&&a[0]>=b[0]&&a[1]>a[0]&&a[1]<=b[1];
export function observedAssemblySfxPoolEnabled(config){
  const revision=config?.assembly_sfx_pool_contract_revision;
  if(revision===undefined)return false;
  if(revision!==assemblySfxCandidatePoolRevision||config.sfx_adoption_mode!=='assembly'
    ||config.mode!=='research'||config.automatic_trial!==true||config.material_strategy!=='independent_music_packs'
    ||config.trial_review_policy!=='diagnostic_candidates')fail('explicit_diagnostic_assembly_required');
  return true;
}

// Independent consumer check. It proves actual observations and frozen identity;
// it does not create selection, hearing, cleanliness or narrative-fit approval.
export async function verifyObservedAssemblySfxCandidate({candidate,poolDocument,sourceSha}){
  let pool=poolDocument??await load(candidate.selection_record);
  if(pool.original_pool){
    if(candidate.adoption_pending!==false||!same(pool.sound_adoption_response,candidate.actual_adoption_response)
      ||!same(candidate.function_decision_response,candidate.actual_adoption_response))fail('actual_adoption_response_required');
    pool=await load(pool.original_pool);
  }
  const p=pool.prepared_candidate;
  if(candidate.adoption_pending!==false)validateObservedAssemblySoundFunction(candidate);
  const provenance=pool.observation_provenance;
  if(candidate.assembly_sfx_pool_contract_revision!==assemblySfxCandidatePoolRevision
    ||pool.assembly_sfx_pool_contract_revision!==assemblySfxCandidatePoolRevision
    ||pool.kind!=='sound_pool_pending_final_assembly'||pool.final_adoption_performed!==false
    ||pool.selection_provenance!==undefined||provenance?.revision!==assemblySfxCandidatePoolRevision
    ||!p||pool.source_video_sha256!==(sourceSha??candidate.current_target_video_sha256)
    ||candidate.current_target_video_sha256!==pool.source_video_sha256
    ||!['dramatic','transition'].includes(candidate.sound_role))fail('identity_or_revision_changed');
  await verifyEvidenceBindings([pool.source,pool.analysis,pool.direction,pool.manifest,pool.library,provenance,candidate.observation_record]);
  for(const key of ['segment_id','asset_id','source_sha256','event_id','sound_role','local_path','target_case_id','target_step_id'])
    if(candidate[key]!==p[key])fail('candidate_identity_changed');
  for(const key of ['sound_function_intent','sound_query_projection','current_event_target_range','observation_record'])
    if(!same(candidate[key],p[key]))fail('candidate_constraints_changed');
  if(candidate.adoption_pending!==false&&!same(candidate.source_anchor_evidence,p.source_anchor_evidence))fail('candidate_anchor_changed');
  if(candidate.source_anchor_seconds!==p.source_anchor_seconds||!inside(candidate.source_range,p.source_range)
    ||candidate.adoption_pending!==false&&!same(candidate.source_range,p.source_range)
    ||await hashFile(candidate.local_path)!==candidate.source_sha256)fail('source_window_changed');
  validateSoundFunctionIntent(p.sound_function_intent,{soundRole:p.sound_role,eventId:p.event_id,targetRange:p.current_event_target_range});
  const story=await load(pool.analysis),encodedDirection=await load(pool.direction),manifest=await load(pool.manifest);
  const event=story.sound_events?.find(e=>e.id===p.event_id),director=encodedDirection.direction??encodedDirection;
  const query=director.sound_queries?.find(q=>q.event_id===p.event_id);
  if(story.source_video_sha256!==pool.source_video_sha256||director.source_video_sha256!==pool.source_video_sha256
    ||manifest.source_sha256!==pool.source_video_sha256||manifest.timeline?.sample_rate!==48000
    ||!event||event.role!==p.sound_role||!same([event.start_seconds,event.end_seconds],p.current_event_target_range)
    ||query?.text!==p.sound_query_projection?.original_intent
    ||!same(query.excluded_tags??[],p.sound_query_projection.excluded_tags)
    ||candidate.duration_role!==p.duration_role||candidate.required_duration_seconds!==p.required_duration_seconds)
    fail('original_event_or_intent_changed');
  const record=await load(provenance.observation_record),caseInput=await load(provenance.case_input);
  if(record.kind!=='observed_material_candidates_pending_final_assembly'||record.automatic_selection_performed!==false
    ||record.actual_asset_selection_performed!==false||record.raw_response!==undefined
    ||record.source_video_sha256!==pool.source_video_sha256||!same(record.candidate_source,provenance.candidate_source)
    ||!same(record.case_source,provenance.case_input)||record.production_approval!==false||record.artistic_approval!==false
    ||!caseInput.cases?.some(row=>row.case_id===p.target_case_id&&row.evidence?.source_video_sha256===pool.source_video_sha256))
    fail('observation_provenance_changed');
  await verifyEvidenceBindings([record.input,record.observation_files,record.visual_files]);
  const submitted=await load(record.input);
  if(!same(submitted.tasks,record.tasks)||!same(submitted.candidate_source,record.candidate_source)
    ||!same(submitted.case_source,record.case_source))fail('submitted_observations_changed');
  const tasks=record.tasks.filter(t=>t.case_id===p.target_case_id&&t.step_id===p.target_step_id);
  if(tasks.length!==1||tasks[0].kind!=='sfx'||tasks[0].sound_role!==p.sound_role
    ||!same(tasks[0].sound_function_intent,p.sound_function_intent))fail('observed_task_changed');
  const task=tasks[0],heard=task.candidates.filter(c=>c.segment_id===p.segment_id);
  const observations=record.observations.filter(o=>o.source_sha256===p.source_sha256&&same(o.source_range,p.source_range));
  if(heard.length!==1||observations.length!==1)fail('actual_observation_ambiguous_or_missing');
  const observation=observations[0];await verifyEvidenceBindings(observation);
  const boundObservation=await load(candidate.observation_record);
  if(observation.actual_audio_processed!==true||!observation.model_revision||!observation.files?.length
    ||heard[0].source_sha256!==p.source_sha256||!same(heard[0].source_range,p.source_range)
    ||!same(heard[0].observation,observation.observations)||boundObservation.source_sha256!==p.source_sha256
    ||!same(boundObservation.source_range,p.source_range)||boundObservation.actual_audio_processed!==true
    ||!same(boundObservation.observations,observation.observations))fail('actual_observation_changed');
  if(observation.protocol==='ffmpeg_pcm_offline')await verifyFrozenPcmObservation(p,observation);
  const raw=expandCandidateEvidence(await load(provenance.candidate_source));
  const originalTask=raw.tasks.find(t=>t.case_id===p.target_case_id&&t.step_id===p.target_step_id);
  const original=originalTask?.candidates.find(c=>c.candidate.segment_id===p.segment_id);
  if(!original||original.candidate.source_sha256!==p.source_sha256||!same(original.candidate.source_range,p.source_range)
    ||path.resolve(original.candidate.local_path)!==path.resolve(p.local_path))fail('frozen_candidate_changed');
  if(!same(originalTask.sound_function_intent,p.sound_function_intent)||!same(originalTask.sound_query_projection,p.sound_query_projection))
    fail('frozen_query_constraints_changed');
  if(candidate.duration_role==='bed')await verifyDiagnosticBedPlacement(candidate);
  else await verifyDiagnosticSfxAnchor(candidate);
  if(candidate.adoption_pending===false){
    const raw=await load(candidate.function_decision_response);
    const items=raw.output?.flatMap(row=>row.content??[])??raw.steps?.filter(row=>row.type==='model_output').flatMap(row=>row.content??[])??raw.outputs??[];
    const encoded=items.filter(row=>['text','output_text'].includes(row.type)).map(row=>row.text).join('');
    const value=raw.value??(raw.status==='completed'&&encoded?JSON.parse(encoded):undefined);
    const edits=value?.edits?.sounds??[],actual=edits.filter(e=>e.event_id===candidate.event_id);
    if(actual.length!==1||actual[0].decision!=='new_asset'||actual[0].selected_segment_id!==candidate.segment_id
      ||!same(actual[0].source_range,candidate.source_range)||actual[0].source_anchor_seconds!==candidate.source_anchor_seconds
      ||!same(actual[0].sound_usage,candidate.sound_usage)||actual[0].reason!==candidate.assembly_adopt_reason)
      fail('actual_assembly_usage_changed');
  }
  return {pool,record,task,observation};
}

async function verifyFrozenPcmObservation(candidate,observation){
  const document=await load(observation.observation_record),pcm=await load(document.pcm_receipt),facts=observation.observations;
  if(document.kind!=='frozen_offline_pcm_technical_observation'||document.source_sha256!==candidate.source_sha256
    ||!same(document.source_range,candidate.source_range)||document.actual_audio_processed!==true
    ||document.qualified!==false||document.artistic_approval!==false||document.production_approval!==false
    ||pcm.kind!=='local_sound_actual_pcm_decode'||pcm.pcm_sha256!==candidate.source_sha256
    ||pcm.sample_rate_hz!==48000||pcm.channels!==2||!Number.isSafeInteger(pcm.decoded_samples)||pcm.decoded_samples<=0
    ||pcm.full_decode?.exit_code!==0||pcm.full_decode.strict_errors!==true||pcm.sound_facts_qualified!==false
    ||!same(facts.actual_clock,{samples:pcm.decoded_samples,sample_rate_hz:48000,source_range:[0,pcm.decoded_samples/48000]})
    ||!same(facts.window_source_range,candidate.source_range)||candidate.source_range[1]>pcm.decoded_samples/48000
    ||facts.whole_recording_measurements?.peak_dbfs!==pcm.profile?.peak_dbfs
    ||facts.whole_recording_measurements?.rms_dbfs!==pcm.profile?.rms_dbfs
    ||!same(facts.whole_recording_measurements?.source_range,[0,pcm.decoded_samples/48000])
    ||facts.sound_semantics_verified!==false||facts.usage_approved!==false||facts.lyrics_verified!==false)
    fail('frozen_pcm_clock_or_level_changed');
  const measured=(pcm.profile.transient_candidates??[]).filter(row=>Number.isSafeInteger(row.sample_index)
    &&row.sample_index>=0&&row.sample_index<pcm.decoded_samples&&row.seconds===row.sample_index/48000
    &&row.seconds>=candidate.source_range[0]&&row.seconds<candidate.source_range[1]);
  if(!same(measured,facts.measured_transient_candidates))fail('frozen_pcm_transient_changed');
  if(document.optional_specialist?.status==='unqualified_predictions_consumed'){
    const predicted=await load(document.optional_specialist.response);await verifyEvidenceBindings(predicted.evidence_files);
    if(predicted.source_video_sha256!==candidate.source_sha256||!same(predicted.source_range,candidate.source_range)
      ||predicted.actual_input_processed!==true||!same(predicted.value?.predictions,facts.specialist_predictions)
      ||!same(predicted.value?.limitations,facts.specialist_limitations))fail('frozen_specialist_prediction_changed');
  }else if((facts.specialist_predictions??[]).length)fail('frozen_specialist_proof_required');
}

export async function prepareObservedAssemblySfxPool({config,source,analysis,direction,manifest,library,caseInput,
  candidateFile,events,outputDir,runtime,observationOptions}){
  if(!observedAssemblySfxPoolEnabled(config))fail('explicit_contract_required');
  const observed=await observeMaterialCandidates({candidate_file:candidateFile,input_file:caseInput.path,
    output_dir:path.join(outputDir,'observations'),...observationOptions},runtime);
  const candidates=expandCandidateEvidence(await readJson(candidateFile)),mappings=new Map(),pool=[],gaps=[...observed.gaps];
  for(const task of observed.tasks){
    const original=candidates.tasks.find(t=>t.case_id===task.case_id&&t.step_id===task.step_id);
    const event=events.find(e=>e.id===task.sound_function_intent?.event_id);
    if(!event||!['dramatic','transition'].includes(event.role))fail('actual_event_required');
    for(const heard of task.candidates){
      await runtime.trialBudget?.inspectLocal?.({stage:'assembly_observed_sfx_candidate_preparation'});
      const raw=original.candidates.find(c=>c.candidate.segment_id===heard.segment_id),pointer=raw.candidate;
      const observation=observed.observations.find(o=>o.source_sha256===pointer.source_sha256&&same(o.source_range,pointer.source_range));
      const mapping=structuredClone(raw.binding),sound=mapping.sounds.find(s=>s.segment_id===pointer.segment_id);
      const token=shaBytes(task.case_id+':'+pointer.segment_id).slice(0,20),bed=task.sound_function_intent.expected_function==='bed';
      sound.listening_evidence=observation;sound.reason='Actually observed candidate pending final assembly comparison; no standalone selection.';
      mapping.evidence_files.push(...observation.files,observed.artifact);
      const observationRef=await saveJson(path.join(outputDir,`pool-observation-${token}.json`),{
        ...observation,actual_audio_listened:false,qualified:false,production_approval:false});
      const sourceAudio={path:pointer.local_path,sha256:pointer.source_sha256};
      const measured=bed?await measureDiagnosticBedPlacement({source:sourceAudio,sourceRange:pointer.source_range,
        targetSource:source,event,outputDir:path.join(outputDir,'pool-bed-placement',token)})
        :await (runtime.sfxAnchorMeasurer??measureDiagnosticSfxAnchor)({source:sourceAudio,segmentId:pointer.segment_id,
          sourceRange:pointer.source_range,outputDir:path.join(outputDir,'pool-anchors',token)});
      await runtime.trialBudget?.inspectLocal?.({stage:'assembly_observed_sfx_candidate_placement_complete'});
      const anchor=bed?pointer.source_range[0]:(await load(measured)).anchor_candidates[0]?.seconds;
      if(!Number.isFinite(anchor)||anchor<pointer.source_range[0]||anchor>=pointer.source_range[1]){
        gaps.push({event_id:event.id,gap:'observed_candidate_scoped_anchor_unavailable',segment_id:pointer.segment_id,blocks_render:false});continue;}
      // The existing binder owns one mapping per current case. Alternatives
      // remain distinct real windows inside that mapping; this chooses none.
      const combined=mappings.get(mapping.case_id)??{...mapping,music:[],sounds:[],evidence_files:[]};
      if(combined.source_video_sha256!==mapping.source_video_sha256||!same(combined.case_source_range,mapping.case_source_range))
        fail('observed_case_binding_changed');
      for(const field of ['music','sounds'])for(const item of mapping[field]??[])
        if(!combined[field].some(row=>row.step_id===item.step_id&&row.segment_id===item.segment_id))combined[field].push(item);
      combined.evidence_files=[...new Map([...combined.evidence_files,...mapping.evidence_files].map(ref=>[JSON.stringify(ref),ref])).values()];
      mappings.set(mapping.case_id,combined);
      const prepared={...sound,event_id:event.id,local_path:pointer.local_path,observation_record:observationRef,
        assembly_sfx_pool_contract_revision:assemblySfxCandidatePoolRevision,sound_function_intent:task.sound_function_intent,
        sound_query_projection:original.sound_query_projection,duration_role:bed?'bed':'transient',
        required_duration_seconds:bed?event.end_seconds-event.start_seconds:null,current_event_target_range:[event.start_seconds,event.end_seconds],
        current_target_video_sha256:source.sha256,target_case_id:task.case_id,target_step_id:task.step_id,
        source_anchor_seconds:anchor,source_anchor_evidence:measured,anchor_review_status:'measured_diagnostic_pending_audition',
        source_facts_scope:bed?'technical_window_start_not_transient_or_approved_scene_fit':'measured_candidate_not_approved_attack_or_scene_fit',
        clean_content_status:'unknown',qualified:false,artistic_approval:false,production_approval:false};
      const pending={schema_version:1,kind:'sound_pool_pending_final_assembly',assembly_sfx_pool_contract_revision:assemblySfxCandidatePoolRevision,
        source_video_sha256:source.sha256,source,analysis,direction,manifest,library,prepared_candidate:prepared,
        observation_provenance:{revision:assemblySfxCandidatePoolRevision,candidate_source:observed.candidate_source,
          case_input:caseInput,observation_record:observed.artifact},final_adoption_performed:false,
        actual_audio_listened:false,qualified:false,artistic_approval:false,production_approval:false};
      const selection=await saveJson(path.join(outputDir,`assembly-observed-pool-${token}.json`),pending);
      const candidate={...prepared,selection_record:selection,sfx_adoption_mode:'assembly',adoption_pending:true};
      await verifyObservedAssemblySfxCandidate({candidate,poolDocument:pending,sourceSha:source.sha256});pool.push(candidate);
    }
  }
  const binding=await saveJson(path.join(outputDir,'observed-bindings.json'),{schema_version:1,bindings:[...mappings.values()],
    source:observed.candidate_source,case_source:caseInput,observation_record:observed.artifact,
    automatic_selection_performed:false,artistic_approval:false,production_approval:false});
  const boundFile=path.join(outputDir,'current-observed-sound-materials.json');
  await run(config.python??'python',['-X','utf8',path.join(path.dirname(fileURLToPath(import.meta.url)),'corpus_materials.py'),
    '--input',caseInput.path,'--bindings',binding.path,'--library-db',library.path,'--output',boundFile],
    {windowsHide:true,encoding:'utf8',maxBuffer:64*1024*1024});
  return {sounds:pool,current_materials:await bind(boundFile),observation_record:observed.artifact,gaps,
    assembly_sfx_pool_contract_revision:assemblySfxCandidatePoolRevision};
}
