import path from 'node:path';
import {readJson,verifyEvidenceBindings,validateSchema} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {researchAssemblySchema,finalizeResearchAssembly,
  auditResearchAssemblyTechnicalOperands} from './assemble_research_episode.mjs';
import {loadIndependentMusicPublication,independentMaterialSelectionSchema,independentWindowConflicts}
  from './independent_music_material_bridge.mjs';
import {auditScopedRepair,saveCompositeArtifact,verifyCompositeReview,verifyCompositeModelResponse,
  compositeResearchRevision,validateCompositeResearchConfig} from './composite_research_review.mjs';
import {verifyCompositeRequestEnvelope} from './composite_research_review.mjs';

const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),same=(a,b)=>canonical(a)===canonical(b);
const need=(v,code)=>{if(!v)throw Error('composite_scoped_repair_'+code);};
const load=async binding=>{await verifyEvidenceBindings(binding);return readJson(binding.path);};
const intersects=(a,b)=>a[0]<b[1]&&b[0]<a[1];
export function compositeRepairScope(issues,{director,plan}){
  const cueIds=new Set(issues.flatMap(i=>i.cue_ids)),eventIds=new Set(issues.flatMap(i=>i.event_ids));
  const cue_operations={},event_operations={};
  const grant=(map,id,ops)=>map[id]=[...new Set([...(map[id]??[]),...ops])];
  for(const issue of issues){for(const id of issue.cue_ids)grant(cue_operations,id,issue.allowed_operations);
    for(const id of issue.event_ids)grant(event_operations,id,issue.allowed_operations);}
  // Explicitly include real neighboring mother cues only for seam/phrase repair.
  for(const issue of issues.filter(i=>['abrupt_seam','broken_phrase'].includes(i.kind)))
    for(const cue of director.cues)if(intersects(cue.target_range,[Math.max(0,issue.target_range[0]-3),issue.target_range[1]+3]))
      {cueIds.add(cue.cue_id);grant(cue_operations,cue.cue_id,issue.allowed_operations);}
  return {cue_ids:[...cueIds],event_ids:[...eventIds],action_ids:[...new Set(director.cues.filter(c=>cueIds.has(c.cue_id))
    .flatMap(c=>c.required_action_ids??[]))],allowed_operations:[...new Set(issues.flatMap(i=>i.allowed_operations))],
    cue_operations,event_operations,
    issue_ids:issues.map(i=>i.issue_id),target_ranges:issues.map(i=>i.target_range),
    dependency_arcs:plan.arcs.filter(a=>cueIds.has(a.cue_id)).map(a=>a.arc_id)};
}
function checkCapacity(session,request){
  need(typeof session.inputBudget==='function','real_input_capacity_checker_required');
  const budget=session.inputBudget(request),tokens=budget.submitted_input_tokens??budget.estimated_tokens;
  need(Number.isFinite(tokens)&&tokens<=(session.maxSubmittedInputTokens??16000),'single_request_capacity_gap');
}

// Reuse the existing material selector and its previously observed frozen pool.
// No online library rescan, fabricated observation, or cue-independent whole-film
// reselection is permitted. A missing suitable observed alternative is a gap.
async function reselectMusic({config,source,issues,scope,values,inputs,session,runtime,out}){
  const frozen=await loadIndependentMusicPublication(config),requests=new Map();
  const wanted=new Set();
  for(const issue of issues.filter(i=>i.repair_stage==='material_reselection'))for(const cue of issue.cue_ids){
    const kind=issue.kind==='lyric_perspective'?'words':'music',id=kind==='words'?cue+'/words':cue;
    need((values.candidates[kind]??[]).some(c=>c.cue_id===id),'actual_adopted_reselection_handoff_required');
    wanted.add(kind+':'+id);
  }
  for(const candidate of [...values.candidates.music,...(values.candidates.words??[])]){
    if(!wanted.has((candidate.cue_id.endsWith('/words')?'words':'music')+':'+candidate.cue_id))continue;
    const selection=await load(candidate.selection_record),ref=selection.selection_provenance?.input;
    need(ref,'original_selection_pool_unavailable');requests.set(ref.sha256,{ref,request:await load(ref)});
  }
  const tasks=[],observations=[],parents=[];
  for(const {ref,request}of requests.values()){
    parents.push(ref);observations.push(...request.observation_files);
    for(const task of request.tasks.filter(t=>wanted.has(t.kind+':'+t.cue_id)))
      if(!tasks.some(t=>t.task_id===task.task_id))tasks.push(task);
  }
  need(tasks.length&&tasks.length<=20,'observed_alternative_pool_unavailable');
  const first=requests.values().next().value.request;
  const request={...first,tasks,observation_files:[...new Map(observations.map(r=>[r.sha256,r])).values()],
    call_plan_phase:'reselection',repair_context:{review_issues:issues,scope,parent_selections:parents},
    prompt:first.prompt+'\nThis is the one scoped correction of the cited failures. Compare the same real observed pool. '
      +'Reject the failed music/lyric perspective rather than lowering its gain. Return a concrete alternative or a gap. '
      +'Do not alter tasks outside this supplied scope or claim to hear audio.'};
  const input=await saveCompositeArtifact(path.join(out,'reselection-request.json'),request);checkCapacity(session,request);
  const callback=session.materialRuntime?.independentMaterialSelector??session.materialRuntime?.materialSelector
    ??(runtime.execution_kind==='injected_test_transport'?(runtime.independentMaterialSelector??runtime.materialSelector):null);
  need(typeof callback==='function','same_episode_material_selector_required');
  const response=await callback({...request,input},path.join(out,'reselection'),{repairLimit:0});
  await verifyEvidenceBindings([response.raw_response,input]);const raw=await load(response.raw_response);
  need(response.input_sha256===input.sha256&&raw.input_sha256===input.sha256&&same(raw.value,response.value)
    &&response.actual_input_processed===true&&raw.completion_status==='complete','actual_reselection_response_required');
  const value=validateSchema(response.value,independentMaterialSelectionSchema),seen=new Set(),selected=[];
  const selectorRecord=await saveCompositeArtifact(path.join(out,'reselection-record.json'),{
    schema_version:1,kind:'independent_pack_material_selection',source_video_sha256:source.sha256,input,
    raw_response:response.raw_response,value,actual_asset_selection_performed:true,production_approval:false});
  for(const decision of value.decisions){
    const task=tasks.find(t=>t.task_id===decision.task_id);
    need(task&&!seen.has(task.task_id)&&decision.cue_id===task.cue_id&&decision.kind===task.kind,'reselection_task_changed');seen.add(task.task_id);
    const chosen=new Set(decision.selected_segment_ids),rejected=new Set(decision.rejections.map(r=>r.segment_id));
    need(chosen.size&&chosen.size===decision.selected_segment_ids.length&&rejected.size===decision.rejections.length
      &&task.candidates.length===chosen.size+rejected.size
      &&[...chosen,...rejected].every(id=>task.candidates.some(c=>c.segment_id===id))
      &&[...chosen].every(id=>!rejected.has(id))&&decision.adopt_reason?.trim()
      &&decision.rejections.every(r=>r.reason?.trim())&&!decision.unresolved_gaps.length,'reselection_has_no_complete_supported_choice');
    need(decision.route_kind==='sound_conditions'?decision.preset_id===null
      :task.applicable_presets.some(p=>p.preset_id===decision.preset_id),'reselection_preset_changed');
    const mother=values.director.cues.find(c=>c.cue_id===task.cue_id.replace(/\/words$/,''));
    for(const id of chosen){
      const item=frozen.windows.find(w=>w.segment_id===id),submitted=task.candidates.find(c=>c.segment_id===id);
      need(item&&same(item.source_range,submitted.source_range)&&item.source_sha256===submitted.source_sha256
        &&item.asset_id===submitted.asset_id&&!independentWindowConflicts(item,mother).length,'reselection_frozen_candidate_changed');
      if(task.kind==='words')need(item.reviewed_words?.complete_phrase===true&&item.human_review_record,'reselection_complete_words_unavailable');
      const observationRefs=[];for(const ref of request.observation_files){
        const doc=await load(ref);if(doc.source_sha256===item.source_sha256&&same(doc.source_range,item.source_range)
          &&doc.actual_audio_processed===true)observationRefs.push(ref);
      }
      need(observationRefs.length&&await hashFile(item.local_path??item.path)===item.source_sha256,'reselection_actual_source_observation_required');
      const prior=(values.candidates[task.kind==='words'?'words':'music']??[]).find(c=>c.cue_id===task.cue_id);
      need(prior,'reselection_original_handoff_required');
      const selection=await saveCompositeArtifact(path.join(out,`selection-${encodeURIComponent(task.task_id+'-'+id)}.json`),{
        schema_version:1,source_video_sha256:source.sha256,decisions:[{cue_id:task.cue_id,selected_segment_id:id,
          selected_source_range:item.source_range,reason:decision.adopt_reason}],selection_provenance:{
          selector_record:selectorRecord,raw_response:response.raw_response,input,target_context:first.target_context,publication:frozen.binding}});
      const routeId='composite-reselection/'+encodeURIComponent(task.task_id+'/'+id);
      const candidate={...prior,...item,local_path:item.local_path??item.path,
        cue_id:task.cue_id,parent_cue_id:mother.cue_id,music_pack_id:item.pack_id,preset_id:decision.preset_id,
        pack_route_id:routeId,case_route_id:routeId,
        route_kind:decision.route_kind,source_range:task.kind==='words'?item.reviewed_words.source_range:item.source_range,
        selection_source_ranges:[task.kind==='words'?item.reviewed_words.source_range:item.source_range],
        selection_record:selection,observation_record:observationRefs[0],reason:decision.adopt_reason,
        allowed_target_range:mother.target_range,qualified:false,production_approval:false};
      delete candidate.offline_observation;
      if(task.kind==='words'){
        await verifyEvidenceBindings(item.human_review_record);
        const facts=item.reviewed_words;
        need(typeof facts.text==='string'&&facts.text.trim()&&typeof facts.language==='string'
          &&facts.language!=='unknown'&&facts.source_range[0]>=item.source_range[0]
          &&facts.source_range[1]<=item.source_range[1],'reselection_bound_complete_words_required');
        candidate.offline_observation={words:structuredClone(facts)};
      }
      selected.push({kind:task.kind,candidate});
    }
  }
  need(seen.size===tasks.length,'reselection_missing_tasks');
  for(const kind of ['music','words'])values.candidates[kind]=[
    ...(values.candidates[kind]??[]).filter(c=>!wanted.has(kind+':'+c.cue_id)),
    ...selected.filter(s=>s.kind===kind).map(s=>s.candidate)];
  // New independent sources pass the existing render-source budget with explicit provenance.
  const provenance=structuredClone(values.music_source_provenance);
  for(const {candidate:c}of selected){
    const window={pack_id:c.pack_id,window_id:c.window_id,preset_id:c.preset_id,route_kind:c.route_kind,cue_id:c.cue_id,
      condition_binding:c.condition_binding,source_range:c.source_range,window_binding:frozen.binding};
    const prior=provenance.sources.find(s=>s.asset_id===c.asset_id&&s.source_sha256===c.source_sha256);
    if(prior){prior.windows??=[];if(!prior.windows.some(w=>same(w,window)))prior.windows.push(window);}
    else provenance.sources.push({asset_id:c.asset_id,source_sha256:c.source_sha256,
      origin:['user_provided','reviewed_equivalent'].includes(c.source_relation)?c.source_relation:'independent_library',
      ...window,windows:[window]});
  }
  values.music_source_provenance=provenance;
  const routes=structuredClone(values.case_routes);
  routes.routes=routes.routes.filter(r=>!wanted.has((r.cue_id?.endsWith('/words')?'words':'music')+':'+r.cue_id));
  for(const {candidate:c}of selected)routes.routes.push({route_id:c.case_route_id,cue_id:c.cue_id,
    strategy:'independent_music_packs',case_ids:[],pack_id:c.pack_id,music_pack_id:c.pack_id,
    window_id:c.window_id,preset_id:c.preset_id,route_kind:c.route_kind,condition_binding:c.condition_binding,
    basis:'same_episode_scoped_actual_selection_and_bound_observation',source_candidates:[c],production_approval:false});
  values.case_routes=routes;
  inputs.case_routes=await saveCompositeArtifact(path.join(out,'reselected-case-routes.json'),routes);
  inputs.music_source_provenance=await saveCompositeArtifact(path.join(out,'music-source-provenance.json'),provenance);
  inputs.candidates=await saveCompositeArtifact(path.join(out,'reselected-candidates.json'),values.candidates);
  return {input,raw_response:response.raw_response,selected_segment_ids:selected.map(s=>s.candidate.segment_id)};
}

export function createCompositeScopedRepair(config,runtime={}){
  validateCompositeResearchConfig(config);
  const verification={allowInjectedTestTransport:runtime.execution_kind==='injected_test_transport'};
  return async(input,{session,trialBudget})=>{
    const review=await verifyCompositeReview(input.review_binding,{source:input.source,render_binding:input.render_binding},verification),
      assembled=await load(input.assembly_binding),rendered=await load(input.render_binding);
    const out=path.resolve(input.output_dir),issues=review.issues.filter(i=>input.issue_ids.includes(i.issue_id));
    need(issues.length===input.issue_ids.length&&issues.length,'bound_review_issues_required');
    const budget=await trialBudget.inspectLocal({stage:'composite_scoped_repair_admission',reserveMs:120000});
    need(budget.remaining_ms>0,'no_remaining_episode_time');
    const inputs=structuredClone(assembled.inputs),values={};
    // Re-finalize the actual original SFX pool so the changed final response is
    // verified by the normal adoption consumer, including omitted required events.
    if(rendered.sfx_adoption_record){const adoption=await load(rendered.sfx_adoption_record);
      inputs.candidates=adoption.original_candidates;inputs.current_materials=adoption.original_current_materials;}
    // render records carry the frozen config's adoption record under inputs on
    // some legacy versions; obtain it from the assembled frozen configuration.
    const frozenConfig=await load(assembled.render_config);
    if(frozenConfig.sfx_adoption_record){const adoption=await load(frozenConfig.sfx_adoption_record);
      inputs.candidates=adoption.original_candidates;inputs.current_materials=adoption.original_current_materials;}
    for(const [key,ref]of Object.entries(inputs))values[key]=await load(ref);
    const manifest=values.manifest,scope=compositeRepairScope(issues,{director:values.director,plan:values.arc_plan}),
      before={plan:structuredClone(values.arc_plan),edits:structuredClone(values.edits)};
    let reselection=null;
    if(issues.some(i=>i.repair_stage==='material_reselection'))
      reselection=await reselectMusic({config,source:input.source,issues,scope,values,inputs,session,runtime,out});
    for(const issue of issues.filter(i=>i.kind==='missing_sfx'))need(issue.event_ids.every(id=>
      values.candidates.sounds?.some(c=>c.event_id===id)),'required_sound_candidate_unavailable');
    const request={stage:'composite_scoped_edit_repair',call_plan_phase:'edit_repair',frames:[],schema:researchAssemblySchema(config),
      prompt:'Return the complete plan and edits with one actual scoped correction. Keep every unowned field byte-equivalent. '
        +'The host has frozen scope and allowed_operations; only supplied real source candidates may be adopted. '
        +'Do not change plot, original sound, global ducking, event requirement or unrelated cues/actions/sounds. '
        +'Correct wrong music or lyric perspective by a real reselection/source change, never gain alone. '
        +'Preserve complete phrases, legal bounds and real neighbor seams. Return a concrete execution_gap if no legal repair exists. '
        +'Do not claim you heard PCM or approve production. Return one final decision for every original sound event.',
      data:{source_video_sha256:input.source.sha256,source:input.source,review:input.review_binding,
        prior_assembly:input.assembly_binding,prior_render:input.render_binding,scope,issues,current:before,
        manifest:values.manifest,analysis:values.analysis,director:values.director,candidates:values.candidates,
        bound_artifacts:inputs,reselection}};
    checkCapacity(session,request);const requestBinding=await saveCompositeArtifact(path.join(out,'edit-request.json'),request);
    const response=await session.director({...request,data:{...request.data,composite_request_binding:requestBinding}});
    const raw=await verifyCompositeModelResponse(response,input.source,verification);
    await verifyCompositeRequestEnvelope(raw,requestBinding,verification);
    validateSchema(response.value,request.schema);
    need(!response.value.execution_gaps.length,'model_reported_execution_gap');
    const after={plan:response.value.plan,edits:response.value.edits},audit=auditScopedRepair(before,after,scope);
    need(audit.changed,'no_actual_operand_change');
    for(const issue of issues.filter(i=>i.repair_stage==='material_reselection'))need(issue.cue_ids.some(id=>{
      const beforeArc=before.plan.arcs.find(a=>a.cue_id===id),afterArc=after.plan.arcs.find(a=>a.cue_id===id);
      return !same(beforeArc?.pieces.map(p=>p.source_window),afterArc?.pieces.map(p=>p.source_window));
    }),'semantic_failure_not_repaired_by_source_change');
    values.arc_plan=after.plan;values.edits=after.edits;
    auditResearchAssemblyTechnicalOperands(values,response.value,{manifestPath:inputs.manifest.path,
      musicActionContractVersion:config.music_action_contract_version??1});
    inputs.arc_plan=await saveCompositeArtifact(path.join(out,'arc-plan.json'),after.plan);
    inputs.edits=await saveCompositeArtifact(path.join(out,'edits.json'),after.edits);
    const scopeAudit=await saveCompositeArtifact(path.join(out,'scope-audit.json'),{...audit,before:input.assembly_binding,
      request:requestBinding,raw_response:response.raw_response,review:input.review_binding});
    const result=await finalizeResearchAssembly({config:{...frozenConfig,...config,output_dir:out,
      render_output_dir:path.join(out,'render'),render:false},runtime,source:input.source,manifest,inputs,values,
      stage:{request:requestBinding,raw_response:response.raw_response,execution_kind:response.execution_kind,
        scoped_repair:scopeAudit,independent_audio_hearing_approved:false},
      review:response.value.review_pending.map(text=>({text,actual_assembly_response:response.raw_response})),out});
    need(result.status==='research_episode_config_frozen','normal_assembly_finalizer_required');
    const assemblyBinding={path:path.join(out,'assembly-record.json'),sha256:await hashFile(path.join(out,'assembly-record.json'))};
    const artifact=await saveCompositeArtifact(path.join(out,'repair.json'),{schema_version:1,revision:compositeResearchRevision,
      kind:'executed_composite_scoped_repair',status:'scoped_repair_applied',source:input.source,
      prior_assembly:input.assembly_binding,prior_render:input.render_binding,review:input.review_binding,
      assembly_binding:assemblyBinding,scope,scope_audit:scopeAudit,reselection,raw_response:response.raw_response,
      changes:{arc_plan:inputs.arc_plan,edits:inputs.edits},actual_operand_change:true,production_approval:false});
    return {...await load(artifact),artifact};
  };
}

export async function verifyCompositeRepair(artifact,input,verification={}){
  const record=await load(artifact);
  need(record.kind==='executed_composite_scoped_repair'&&record.status==='scoped_repair_applied'
    &&same(record.source,input.source)&&same(record.prior_assembly,input.assembly_binding)
    &&same(record.prior_render,input.render_binding)&&same(record.review,input.review_binding)
    &&record.actual_operand_change===true&&record.production_approval===false,'receipt_identity_changed');
  await verifyEvidenceBindings(record);
  const audit=await load(record.scope_audit),request=await load(audit.request),assembly=await load(record.assembly_binding),
    raw=await load(record.raw_response);
  await verifyCompositeModelResponse({...raw,raw_response:record.raw_response},input.source,verification);
  await verifyCompositeRequestEnvelope(raw,audit.request,verification);
  const prior=await load(input.assembly_binding),review=await verifyCompositeReview(input.review_binding,
    {source:input.source,render_binding:input.render_binding},verification);
  const expectedScope=compositeRepairScope(review.issues.filter(i=>input.issue_ids.includes(i.issue_id)),
    {director:await load(prior.inputs.director),plan:await load(prior.inputs.arc_plan)});
  need(same(expectedScope,record.scope)&&same(request.data.scope,expectedScope),'host_scope_changed');
  need(same(request.data.current.plan,await load((await load(input.assembly_binding)).inputs.arc_plan))
    &&same(request.data.current.edits,await load((await load(input.assembly_binding)).inputs.edits))
    &&same(raw.value.plan,await load(assembly.inputs.arc_plan))&&same(raw.value.edits,await load(assembly.inputs.edits))
    &&same(assembly.stage.raw_response,record.raw_response),'actual_repaired_decision_changed');
  const checked=auditScopedRepair(request.data.current,{plan:raw.value.plan,edits:raw.value.edits},record.scope);
  need(checked.changed&&same(checked.scope,audit.scope),'actual_scope_audit_changed');return record;
}
