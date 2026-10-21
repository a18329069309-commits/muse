import path from 'node:path';
import {validatePreparedSoundFunction,validateSelectedSoundUsage} from './sfx_event_function.mjs';
import {assemblySfxCandidatePoolRevision,verifyObservedAssemblySfxCandidate} from './assembly_sfx_candidate_pool.mjs';
import {readJson,saveJson,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {isIndependentMusicPackTrial} from './independent_music_policy.mjs';
import {measureDiagnosticBedPlacement,verifyDiagnosticBedPlacement} from './diagnostic_bed_placement.mjs';
import {hashFile} from './render_binding.mjs';
import {verifyHostSoundOmissionRecoveryForRender} from './assembly_host_sound_omissions.mjs';
import {verifyBoundSoundDecisionRecoveryForRender} from './bound_sound_decision_recovery.mjs';
import {verifyAssemblySoundDirectionChain} from './bound_sfx_direction_provenance.mjs';

const kind='sound_pool_pending_final_assembly';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const range=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&v[0]>=0&&v[1]>v[0];
const inside=(a,b)=>range(a)&&range(b)&&a[0]>=b[0]&&a[1]<=b[1];
const load=async binding=>{await verifyEvidenceBindings(binding);return readJson(binding.path);};
const saveStable=async(file,value)=>{
  try{return await saveJson(file,value);}catch(error){if(error.code!=='EEXIST')throw error;
    if(!same(await readJson(file),value))throw Error('assembly_sfx_artifact_changed');
    return {path:path.resolve(file),sha256:await hashFile(file)};}
};
const responseValue=raw=>{
  if(raw.value!==undefined)return raw.value;
  if(raw.status!=='completed')return undefined;
  const items=raw.output?.flatMap(row=>row.content??[])
    ??raw.steps?.filter(row=>row.type==='model_output').flatMap(row=>row.content??[])??raw.outputs??[];
  const text=items.filter(row=>['text','output_text'].includes(row.type)).map(row=>row.text).join('');
  return text?JSON.parse(text):undefined;
};
const verifyConstraintExecution=async(raw,binding,expected,config)=>{
  if(raw.kind!=='constraint_episode_editor_result'
    &&config.editor_strategy!=='constraint_editor_diagnostic_v1')return;
  const {verifyConstraintEditorExecution}=await import('./constraint_episode_editor.mjs');
  await verifyConstraintEditorExecution(binding,expected);
};
const verifySelectionDirectionForRender=async({config,sourceSha,candidate,selection})=>{
  const pool=await load(selection.original_pool),proofRef=selection.sound_direction_provenance;
  if(!proofRef){
    if(pool.direction?.sha256!==config.director?.sha256
      ||path.resolve(pool.direction?.path??'')!==path.resolve(config.director?.path??''))
      throw Error('assembly_sfx_bound_direction_provenance_required');
    if(candidate.sound_direction_provenance)throw Error('assembly_sfx_direction_provenance_changed');
    return;
  }
  if(!same(candidate.sound_direction_provenance,proofRef))throw Error('assembly_sfx_direction_provenance_changed');
  const proof=await load(proofRef);
  if(proof.source?.sha256!==sourceSha||!same(proof.original_pool,selection.original_pool)
    ||!same(proof.original_director,config.director)||!same(proof.analysis,config.analysis)
    ||!same(proof.manifest,config.manifest)||!same(proof.current_materials,config.current_materials))
    throw Error('assembly_sfx_direction_provenance_current_binding_changed');
  await verifyAssemblySoundDirectionChain({source:proof.source,analysisBinding:config.analysis,
    directorBinding:config.director,manifestBinding:config.manifest,poolBinding:selection.original_pool,
    currentMaterialsBinding:proof.current_materials,expectedProof:proof});
};

// Independent consumer guard: a rewritten host selection alone is not final assembly adoption.
export async function verifyAssemblySfxRecordForRender({config,sourceSha,edits,candidates}){
  if(!assemblySfxAdoptionEnabled(config))return;
  if(!config.sfx_adoption_record)throw Error('assembly_sfx_bound_final_record_required');
  const record=await load(config.sfx_adoption_record),raw=await load(record.raw_response),value=responseValue(raw);
  await verifyHostSoundOmissionRecoveryForRender({config,sourceSha,edits,rawResponse:record.raw_response});
  await verifyBoundSoundDecisionRecoveryForRender({config,sourceSha,edits,rawResponse:record.raw_response});
  await verifyConstraintExecution(raw,record.raw_response,{sourceSha,edits,directorBinding:config.director},config);
  if(record.kind!=='final_assembly_sound_adoption'||record.source_video_sha256!==sourceSha
    ||record.actual_sound_adoption_performed!==true||record.production_approval!==false
    ||record.independent_audio_hearing_approved!==false||raw.source_video_sha256!==sourceSha
    ||!same(value?.edits?.sounds,edits.sounds)||record.selected_count!==(candidates.sounds?.length??0))
    throw Error('assembly_sfx_final_record_or_edits_changed');
  await verifyEvidenceBindings([record.original_candidates,record.original_current_materials]);
  for(const candidate of candidates.sounds??[]){
    if(candidate.actual_adoption_response?.sha256!==record.raw_response.sha256)
      throw Error('assembly_sfx_final_record_candidate_changed');
    const selection=await load(candidate.selection_record);
    await verifySelectionDirectionForRender({config,sourceSha,candidate,selection});
    if(candidate.sound_direction_provenance){
      if(!record.sound_direction_provenance?.some(ref=>same(ref,candidate.sound_direction_provenance)))
        throw Error('assembly_sfx_final_record_direction_provenance_changed');
      const proof=await load(candidate.sound_direction_provenance);
      if(!same(proof.current_materials,record.original_current_materials))
        throw Error('assembly_sfx_final_record_direction_materials_changed');
    }
  }
  const actualDirectionProofs=(candidates.sounds??[]).flatMap(candidate=>candidate.sound_direction_provenance?[candidate.sound_direction_provenance]:[]);
  if(!same(record.sound_direction_provenance??[],actualDirectionProofs))
    throw Error('assembly_sfx_final_record_exact_direction_provenance_required');
}
export async function verifyAssemblySfxAdoptionForRender({config,sourceSha,candidate,selection,edit,allSoundEdits}){
  if(!assemblySfxAdoptionEnabled(config))return;
  if(candidate.sfx_adoption_mode!=='assembly'||candidate.adoption_pending!==false
    ||selection.assembly_adoption_mode!=='assembly'||!candidate.actual_adoption_response
    ||!selection.sound_adoption_response||!selection.original_pool
    ||candidate.actual_adoption_response.sha256!==selection.sound_adoption_response.sha256
    ||path.resolve(candidate.actual_adoption_response.path)!==path.resolve(selection.sound_adoption_response.path))
    throw Error('assembly_sfx_actual_final_adoption_required');
  const pending=await load(selection.original_pool),raw=await load(candidate.actual_adoption_response);
  await verifyConstraintExecution(raw,candidate.actual_adoption_response,{sourceSha,soundEdits:allSoundEdits,
    directorBinding:config.director},config);
  const value=responseValue(raw),actual=value?.edits?.sounds?.find(row=>row.event_id===candidate.event_id);
  if(pending.kind!==kind||pending.source_video_sha256!==sourceSha||pending.final_adoption_performed!==false
    ||raw.source_video_sha256!==sourceSha||!same(value?.edits?.sounds,allSoundEdits)||!same(actual,edit)
    ||actual?.decision!=='new_asset'||actual.selected_segment_id!==candidate.segment_id
    ||!same(actual.source_range,candidate.source_range)||!inside(candidate.source_range,pending.prepared_candidate?.source_range)
    ||pending.prepared_candidate?.source_sha256!==candidate.source_sha256)
    throw Error('assembly_sfx_final_response_edit_or_source_changed');
  await verifyEvidenceBindings(pending);
  if(candidate.assembly_sfx_pool_contract_revision===assemblySfxCandidatePoolRevision){
    if(config.assembly_sfx_pool_contract_revision!==assemblySfxCandidatePoolRevision)
      throw Error('assembly_sfx_observed_pool_explicit_config_required');
    await verifyObservedAssemblySfxCandidate({candidate,poolDocument:pending,sourceSha});
    validatePreparedSoundFunction(candidate);
  }
  await verifySelectionDirectionForRender({config,sourceSha,candidate,selection});
}

export function assemblySfxAdoptionEnabled(config){
  if(config.sfx_adoption_mode===undefined||config.sfx_adoption_mode==='separate')return false;
  if(config.sfx_adoption_mode!=='assembly')throw Error('sfx_adoption_mode_invalid');
  if(config.mode!=='research'||config.automatic_trial!==true||config.material_strategy!=='independent_music_packs'
    ||config.trial_review_policy!=='diagnostic_candidates'||!isIndependentMusicPackTrial(config))
    throw Error('assembly_sfx_diagnostic_policy_required');
  return true;
}

export async function prepareAssemblySfxPool({pool,source,analysis,direction,manifest,library,caseInput,selectionRef,selectorRaw,outputDir}){
  const sounds=[];
  for(const candidate of pool){
    const selection=await saveStable(path.join(outputDir,`assembly-pool-${shaBytes(candidate.event_id+':'+candidate.segment_id).slice(0,20)}.json`),{
      schema_version:1,kind,source_video_sha256:source.sha256,source,analysis,direction,manifest,library,
      prepared_candidate:candidate,selection_provenance:{selector_record:selectionRef,raw_response:selectorRaw,case_input:caseInput},
      final_adoption_performed:false,actual_audio_listened:false,qualified:false,artistic_approval:false,production_approval:false});
    sounds.push({...candidate,selection_record:selection,sfx_adoption_mode:'assembly',adoption_pending:true});
  }
  return sounds;
}

// Runs only after the actual bound final assembly return. It does not choose any sound.
export async function finalizeAssemblySfxAdoption({config,source,analysis,direction,manifest,candidates,currentMaterials,
  originalInputs,edits,stage,outputDir}){
  if(!assemblySfxAdoptionEnabled(config))return null;
  if(!stage?.raw_response)throw Error('assembly_sfx_actual_final_response_required');
  const raw=await load(stage.raw_response);
  await verifyConstraintExecution(raw,stage.raw_response,{sourceSha:source.sha256,edits},config);
  const value=responseValue(raw);
  if(!same(value?.edits,edits)||raw.source_video_sha256&&raw.source_video_sha256!==source.sha256)
    throw Error('assembly_sfx_actual_final_response_mismatch');
  const events=analysis.sound_events??[],seen=new Set(),sounds=[],eventDecisions=[],directionProvenances=[];
  for(const edit of edits.sounds){
    const event=events.find(row=>row.id===edit.event_id);
    if(!event||seen.has(event.id)||typeof edit.reason!=='string'||!edit.reason.trim())throw Error('assembly_sfx_exact_current_events_required');
    seen.add(event.id);
    const originalFact=candidates.sounds?.find(row=>row.event_id===event.id&&row.original_sound_review);
    if(edit.original_status!==(originalFact?.original_status??'unknown'))throw Error('assembly_sfx_original_status_cannot_be_inferred');
    if(edit.decision==='omit'){
      if(edit.selected_segment_id!==null||edit.source_range!==null)throw Error('assembly_sfx_omission_cannot_consume_asset');
      if(config.assembly_sfx_pool_contract_revision===assemblySfxCandidatePoolRevision&&edit.sound_usage!==null)
        throw Error('assembly_sfx_observed_pool_omission_cannot_claim_usage');
      eventDecisions.push({event_id:event.id,role:event.role,decision:'omit',reason:edit.reason,
        original_status:edit.original_status,preserve_original_track:true,actual_adoption_response:stage.raw_response});continue;
    }
    const candidate=candidates.sounds?.find(row=>row.event_id===event.id&&row.segment_id===edit.selected_segment_id);
    if(!candidate||!['dramatic','transition','ambience'].includes(event.role))throw Error('assembly_sfx_actual_scoped_candidate_required');
    const observedPool=candidate.assembly_sfx_pool_contract_revision===assemblySfxCandidatePoolRevision;
    if(observedPool&&config.assembly_sfx_pool_contract_revision!==assemblySfxCandidatePoolRevision)
      throw Error('assembly_sfx_observed_pool_explicit_config_required');
    let selectedFunction;
    if(observedPool){
      await verifyObservedAssemblySfxCandidate({candidate,sourceSha:source.sha256});
      const gap=validateSelectedSoundUsage({selected_segment_ids:[candidate.segment_id],sound_usage:edit.sound_usage},
        {sound_role:event.role,sound_function_intent:candidate.sound_function_intent,
          candidates:[{segment_id:candidate.segment_id,source_range:candidate.source_range}]});
      if(gap)throw Error('assembly_sfx_observed_pool_'+gap.gap);
      selectedFunction={intent:candidate.sound_function_intent,usage:edit.sound_usage};
    }else selectedFunction=validatePreparedSoundFunction(candidate,event);
    if(selectedFunction&&!inside(edit.source_range,selectedFunction.usage.usable_source_range))
      throw Error('assembly_sfx_selected_function_range_changed');
    const pending=await load(candidate.selection_record);
    if(pending.kind!==kind||pending.source_video_sha256!==source.sha256||pending.final_adoption_performed!==false
      ||pending.qualified!==false||pending.production_approval!==false)
      throw Error('assembly_sfx_bound_pool_required');
    await verifyEvidenceBindings(pending);
    const original={...candidate};delete original.selection_record;delete original.sfx_adoption_mode;delete original.adoption_pending;
    if(!same(original,pending.prepared_candidate)||pending.source.sha256!==source.sha256
      ||pending.analysis.sha256!==originalInputs.analysis.sha256
      ||pending.manifest.sha256!==originalInputs.manifest.sha256)
      throw Error('assembly_sfx_prepared_candidate_changed');
    const directionProof=await verifyAssemblySoundDirectionChain({source,analysisBinding:originalInputs.analysis,
      directorBinding:originalInputs.director,manifestBinding:originalInputs.manifest,
      poolBinding:candidate.selection_record,currentMaterialsBinding:originalInputs.current_materials});
    const directionProvenance=directionProof?await saveStable(path.join(outputDir,
      `direction-provenance-${shaBytes(JSON.stringify(candidate.selection_record)).slice(0,20)}.json`),directionProof):null;
    if(directionProvenance)directionProvenances.push(directionProvenance);
    const provenance=observedPool?pending.observation_provenance:pending.selection_provenance;
    if(!observedPool){
    const selector=await load(provenance.selector_record),selectedRaw=await load(provenance.raw_response);
    const caseInput=await load(provenance.case_input);
    if(selector.raw_response?.sha256!==provenance.raw_response.sha256||selector.case_source?.sha256!==provenance.case_input.sha256
      ||selectedRaw.input_sha256!==selector.input?.sha256||selectedRaw.completion_status!=='complete'
      ||!selectedRaw.value?.decisions?.some(row=>row.case_id===candidate.target_case_id&&row.step_id===candidate.target_step_id
        &&['sfx','ambience'].includes(row.kind)&&row.selected_segment_ids?.includes(candidate.segment_id)
        &&typeof row.adopt_reason==='string'&&row.adopt_reason.trim())
      ||!caseInput.cases?.some(row=>row.case_id===candidate.target_case_id&&row.evidence?.source_video_sha256===source.sha256))
      throw Error('assembly_sfx_actual_selector_provenance_required');
    }
    const item=currentMaterials.cases?.find(row=>row.case_id===candidate.target_case_id);
    const pack=currentMaterials.sound_packs?.find(row=>row.sound_pack_id===candidate.sound_pack_id);
    if(item?.source_role!=='current_unscored_target_not_reference_success_case'||item.evidence?.source_video_sha256!==source.sha256
      ||!item.sound_pack_ids?.includes(pack?.sound_pack_id)||!pack?.members?.some(row=>row.segment_id===candidate.segment_id
        &&row.asset_id===candidate.asset_id&&row.source_sha256===candidate.source_sha256&&inside(candidate.source_range,row.source_range))
      ||await hashFile(candidate.local_path)!==candidate.source_sha256||!inside(edit.source_range,candidate.source_range)
      ||candidate.sound_role!==event.role)throw Error('assembly_sfx_material_link_or_range_changed');
    const ambient=event.role==='ambience';
    if(ambient){if(!candidate.original_sound_review||!['verified_missing','verified_insufficient'].includes(candidate.original_status))
      throw Error('assembly_sfx_unknown_ambient_must_preserve_original');}
    else if(edit.source_anchor_seconds!==candidate.source_anchor_seconds||edit.source_anchor_seconds<edit.source_range[0]
      ||edit.source_anchor_seconds>=edit.source_range[1])throw Error('assembly_sfx_source_anchor_changed');
    let placement=candidate.source_anchor_evidence;
    if(candidate.duration_role==='bed'&&!ambient){
      const bedRange=selectedFunction?.usage.usable_source_range??candidate.source_range;
      if(edit.source_range[0]!==bedRange[0]||edit.source_anchor_seconds!==edit.source_range[0]
        ||Math.abs(edit.target_seconds-event.start_seconds)>1/48000
        ||Math.abs(edit.source_range[1]-edit.source_range[0]-(event.end_seconds-event.start_seconds))>1/48000)
        throw Error('assembly_sfx_bed_full_current_event_required');
      await verifyDiagnosticBedPlacement(candidate);
      if(!same(edit.source_range,bedRange)){
        const directory=path.join(outputDir,'adopted-bed-placement',encodeURIComponent(event.id)),file=path.join(directory,'measurement.json');
        try{await readJson(file);placement={path:file,sha256:await hashFile(file)};
          await verifyDiagnosticBedPlacement({...candidate,source_range:edit.source_range,
            ...(selectedFunction?{sound_usage:{...candidate.sound_usage,usable_source_range:edit.source_range}}:{}),source_anchor_evidence:placement});}
        catch(error){if(error.code!=='ENOENT')throw error;
          placement=await measureDiagnosticBedPlacement({source:{path:candidate.local_path,sha256:candidate.source_sha256},
            sourceRange:edit.source_range,targetSource:source,event,outputDir:directory});}
      }
    }
    const selection=await saveStable(path.join(outputDir,`current-selection-${encodeURIComponent(event.id)}.json`),{
      schema_version:1,source_video_sha256:source.sha256,decisions:[{event_id:event.id,selected_segment_id:candidate.segment_id,
        selected_source_range:edit.source_range,reason:edit.reason}],sound_adoption_response:stage.raw_response,
      assembly_adoption_mode:'assembly',original_pool:candidate.selection_record,
      ...(observedPool?{assembly_sfx_pool_contract_revision:assemblySfxCandidatePoolRevision,observation_provenance:provenance}
        :{selection_provenance:provenance}),
      ...(directionProvenance?{sound_direction_provenance:directionProvenance}:{}),
      artistic_approval:false,production_approval:false});
    const adopted={...candidate,source_range:edit.source_range,selection_source_ranges:[edit.source_range],selection_record:selection,
      actual_adoption_response:stage.raw_response,adoption_pending:false,...(placement?{source_anchor_evidence:placement}:{})};
    if(observedPool)Object.assign(adopted,{sound_usage:structuredClone(edit.sound_usage),assembly_adopt_reason:edit.reason,
      function_decision_response:stage.raw_response});
    if(directionProvenance)adopted.sound_direction_provenance=directionProvenance;
    sounds.push(adopted);eventDecisions.push({event_id:event.id,role:event.role,decision:'new_asset',reason:edit.reason,
      selected_segment_id:candidate.segment_id,selected_source_range:edit.source_range,source_anchor_seconds:edit.source_anchor_seconds,
      original_status:edit.original_status,preserve_original_track:true,actual_adoption_response:stage.raw_response,artistic_approval:false});
  }
  if(seen.size!==events.length)throw Error('assembly_sfx_missing_current_events');
  return {candidates:{...candidates,sounds,sound_event_guidance:eventDecisions},record:{schema_version:1,
    kind:'final_assembly_sound_adoption',source_video_sha256:source.sha256,raw_response:stage.raw_response,
    original_candidates:originalInputs.candidates,original_current_materials:originalInputs.current_materials,
    selected_count:sounds.length,pool_count:candidates.sounds?.length??0,event_decisions:eventDecisions,
    ...(directionProvenances.length?{sound_direction_provenance:directionProvenances}:{}),
    actual_sound_adoption_performed:true,independent_audio_hearing_approved:false,production_approval:false}};
}
