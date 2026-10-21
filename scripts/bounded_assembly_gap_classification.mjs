import path from 'node:path';
import {readJson,saveJson,shaBytes,objectSchema,validateSchema,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {verifyBoundedAssemblyPartExecution} from './bounded_assembly_execution_evidence.mjs';
import {encodeBoundedInlineRecords,expandBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';
import {projectAssemblyConsumerInput} from './assembly_consumer_projection.mjs';
import {compileEdit} from './compose_episode.mjs';
import {auditMusicActionExecution} from './music_action_execution_audit.mjs';

export const boundedAssemblyGapClassificationRevision='diagnostic-only-gap-classification-v1';
export const boundedAssemblyGapClassificationStage='diagnostic_assembly_gap_fields_v1';
export const boundedAssemblyGapClassifiedPartKind='bound_diagnostic_gap_classified_assembly_part_v1';
const keys=['manifest','analysis','director','evidence_catalog','candidates','current_materials','case_routes','music_source_provenance'];
const canonical=v=>JSON.stringify(v,(_,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);
const same=(a,b)=>canonical(a)===canonical(b),fail=r=>{throw Error('bounded_assembly_gap_classification_'+r);};
const sameRef=(a,b)=>a?.sha256===b?.sha256&&typeof a?.path==='string'&&typeof b?.path==='string'&&path.resolve(a.path)===path.resolve(b.path);
const load=async ref=>{await verifyEvidenceBindings(ref);return readJson(ref.path);};
async function stable(file,value){try{return await saveJson(file,value);}catch(e){if(e.code!=='EEXIST')throw e;
 if(!same(await readJson(file),value))fail('existing_evidence_changed');return {path:path.resolve(file),sha256:await hashFile(file)};}}
const reused=(raw,ref)=>({...raw,raw_response:ref,reused:true,cli_receipts:[],historical_cli_receipts:raw.cli_receipts});
const schemaFor=raw=>objectSchema({classifications:{type:'array',minItems:raw.value.execution_gaps.length,maxItems:raw.value.execution_gaps.length,
 items:objectSchema({gap_id:{type:'string',enum:raw.value.execution_gaps.map((_,i)=>'gap_'+(i+1))},
 disposition:{type:'string',enum:['execution_gap','review_pending']},reason:{type:'string',minLength:1,maxLength:512}})}});

// Classification can never repair a source, clock, action, phrase or event.
// Prove the unchanged plan is technically executable before spending a call.
function classificationTechnicalCandidate(raw,part,caller){
 if(!Array.isArray(raw.value?.execution_gaps)||!raw.value.execution_gaps.length||raw.value.execution_gaps.some(s=>typeof s!=='string'||!s.trim()))fail('nonempty_original_gaps_required');
 const check=structuredClone(raw.value);check.execution_gaps=[];
 return {check,part,caller};
}

export async function auditBoundGapClassificationOperands({caller,part,values},value){
 const {finitePartSchema}=await import('./bounded_research_assembly.mjs');
 const {mergeMotherActionValues}=await import('./bounded_mother_action_projection.mjs');
 const {compileSoundArcPlan}=await import('./sound_arc_plan.mjs');
 const normalized=mergeMotherActionValues([{value,mother_action_partition:part.mother_action_partition}],
  {...caller,schema:finitePartSchema(caller.schema)},{complete:false});
 const director={...normalized.director,music_actions:caller.data.director.music_actions.filter(a=>part.action_ids.includes(a.id))};
 const arcs=compileSoundArcPlan({plan:normalized.value.plan,director,candidates:values.candidates.music,wordsCandidates:values.candidates.words});
 const tasks={cues:[...arcs.splitCues]},routes={cues:[]};
 for(const task of arcs.splitCues){
  const piece=arcs.arcManifest.arcs.flatMap(a=>a.pieces).find(p=>p.cue_id===task.cue_id);
  const found=values.candidates.music.filter(c=>c.segment_id===piece.source_window.segment_id&&c.asset_id===piece.source_window.asset_id
   &&c.source_sha256===piece.source_window.source_sha256&&same(c.source_range,piece.source_window.candidate_source_range));
  if(found.length!==1)fail('unique_actual_source_for_compiler_required');
  await verifyEvidenceBindings({path:found[0].local_path,sha256:found[0].source_sha256});
  routes.cues.push({cue_id:task.cue_id,status:'research_selected',selected:{...found[0],source_range:piece.source_window.source_range}});
  if(task.words_target_range){
   const words=values.candidates.words.filter(w=>w.parent_cue_id===task.arc_parent_cue_id);
   if(words.length!==1)fail('required_actual_words_source_for_compiler_required');
   const word=words[0],child={cue_id:task.cue_id+'/words',parent_cue_id:task.cue_id,music_role:'words_candidate',target_range:task.words_target_range,words_mode:task.words_mode};
   if(Math.round((word.source_range[1]-word.source_range[0])*48000)!==Math.round((task.words_target_range[1]-task.words_target_range[0])*48000))fail('complete_required_words_phrase_required');
   await verifyEvidenceBindings({path:word.local_path,sha256:word.source_sha256});tasks.cues.push(child);routes.cues.push({cue_id:child.cue_id,status:'research_selected',selected:word});
  }
 }
 const analysis={...values.analysis,sound_events:values.analysis.sound_events.filter(e=>part.event_ids.includes(e.id))};
 const compiled=compileEdit({edits:normalized.value.edits,tasks,routes,analysis,manifestPath:caller.data.bound_artifacts.manifest.path,
  duration:values.manifest.timeline.duration_samples/48000,execution:'host',arcManifest:arcs.arcManifest,
  evidence:{refs:new Map(values.evidence_catalog.evidence.map(e=>[e.id,e])),sounds:values.candidates.sounds},dialogueIntervals:[]});
 const audit=auditMusicActionExecution({director,plan:normalized.value.plan,edits:normalized.value.edits,compiled});
 // A source-local artistic-development fact can remain unknown. A nonexistent
 // actual operation or a discontinuous requested hold cannot be relabelled.
 if(audit.actions.some(a=>a.status==='unresolved'&&a.execution_evidence?.operation?.kind!=='source_development'))fail('actual_technical_edit_or_hold_still_unresolved');
 return {audit,compiled_operand_sha256:shaBytes(canonical(compiled)),actual_audio_hearing_approved:false,production_approval:false};
}

export async function preflightBoundAssemblyGapClassificationRecovery(spec,{inputs,schema,source,request}={}){
 if(spec?.revision!==boundedAssemblyGapClassificationRevision)fail('explicit_revision_required');
 const caller=await load(spec.caller),old=await load(spec.preflight),completed=await load(spec.part);
 if(caller.stage!=='current_research_episode_assembly'||caller.data?.bounded_assembly_projection_revision!=='mother-cue-complete-action-subparts-v1'
  ||!same(Object.keys(caller.data.bound_artifacts??{}).sort(),[...keys].sort())||schema&&!same(schema,caller.schema)
  ||source&&source.sha256!==caller.data.source_video_sha256||request&&!same(request,caller))fail('exact_original_caller_required');
 if(inputs&&(!same(Object.keys(inputs).sort(),[...keys].sort())||keys.some(k=>!same(inputs[k],caller.data.bound_artifacts[k]))))fail('exact_eight_current_inputs_required');
 const values={};for(const k of keys)values[k]=await load(caller.data.bound_artifacts[k]);
 const full=await load(caller.data.full_input),actualSource=full.data?.source;
 if(!same(full.data?.bound_artifacts,caller.data.bound_artifacts)||!same(full.schema,caller.schema)||full.stage!==caller.stage
  ||full.data.source_video_sha256!==caller.data.source_video_sha256||actualSource?.sha256!==caller.data.source_video_sha256
  ||keys.some(k=>!same(full.data[k],values[k]))||!same(caller.data.analysis,values.analysis)||!same(caller.data.director,values.director)
  ||values.manifest.source_sha256!==actualSource.sha256||!same(values.manifest.timeline,caller.data.timeline))fail('full_host_or_source_changed');
 await verifyEvidenceBindings(actualSource);if(source?.path&&path.resolve(source.path)!==path.resolve(actualSource.path))fail('source_path_changed');
 if(!sameRef(old.original_request,spec.caller)||old.parts?.length<2||old.parts.length>4||!same(old.parts[0].target_range,completed.target_range)
  ||completed.execution_gap!==true||completed.previous_response!==null||completed.actual_audio_hearing_approved!==false||completed.production_approval!==false)fail('only_original_first_gap_part_supported');
 const {finitePartSchema,validateBoundedAssemblyPart}=await import('./bounded_research_assembly.mjs');
 const {projectMotherActionGroup}=await import('./bounded_mother_action_projection.mjs');
 let next=0;
 for(const p of old.parts){
  const partition=p.mother_action_partition;
  if(!partition||partition.action_start!==next)fail('complete_original_partition_required');
  const expected=projectMotherActionGroup({...caller,schema:finitePartSchema(caller.schema)},partition.action_start,partition.action_end);
  expected.input.data.assembly_consumer_projection_revision='assembly-mother-action-inline-records-v5';
  const sounds=expected.input.schema.properties.edits.properties.sounds;sounds.minItems=sounds.maxItems=expected.event_ids.length;
  if(expected.event_ids.length)sounds.items.properties.event_id={...sounds.items.properties.event_id,enum:[...expected.event_ids]};
  if(!same(expected.input,p.input)||!same(expected.mother_action_partition,partition)
   ||!same(expected.action_ids,p.action_ids)||!same(expected.event_ids,p.event_ids))fail('original_partition_projection_changed');
  next=partition.action_end;
 }
 if(next!==caller.data.director.music_actions.length)fail('complete_original_partition_required');
 const input=await load(completed.input),part=old.parts[0],raw=await load(completed.raw_response);
 if(!same(input,part.input)||!same(completed.cue_ids,part.cue_ids)||!same(completed.action_ids,part.action_ids)||!same(completed.event_ids,part.event_ids)
  ||!same(completed.mother_action_partition,part.mother_action_partition)||input.data.actual_previous_assembly_tail)fail('original_part_changed');
 const actualRequestRef=raw.evidence_files?.find(r=>path.resolve(r.path)===path.join(path.dirname(completed.raw_response.path),'request.json'));
 if(!actualRequestRef)fail('original_cli_request_required');const actualRequest=await load(actualRequestRef);
 const session={backend:{protocol:'codex_cli',backend_id:raw.backend_id,model_revision:raw.model_revision},story:actualRequest.input.data.completed_story?
  {analysis:actualRequest.input.data.completed_story,frame_mapping:actualRequest.input.data.source_frame_mapping}:null};
 const execution=await verifyBoundedAssemblyPartExecution(reused(raw,completed.raw_response),{input,session});
 const eligible=classificationTechnicalCandidate(raw,{...part,input},caller);
 validateBoundedAssemblyPart(eligible.check,eligible.part,[],caller);
 const operands=await auditBoundGapClassificationOperands({caller,part:{...part,input},values},eligible.check);
 return {spec,caller,requestBinding:spec.caller,old,completed,input,part:{...part,input},raw,execution,values,operands,story:session.story};
}

export function createBoundAssemblyGapClassificationRequest(row){
 const d=row.input.data;
 const projection=projectAssemblyConsumerInput(row.input);
 if(!projection?.input.data.inline||projection.audit.constraint_mapping_bijective!==true)fail('existing_complete_constraint_projection_required');
 const scoped=expandBoundedInlineRecords(projection.input.data.inline);
 const request={stage:boundedAssemblyGapClassificationStage,schema:schemaFor(row.raw),frames:[],
 prompt:'Classify only the supplied original execution_gaps. Do not return or alter plan/edits, sources, clocks, ownership, gains, bounds or qualification. Return one classification per gap_id. True missing/invalid required source, coverage, identity, full required phrase or edit remains execution_gap. Empty words pool with optional explore (even a proposed target) can stay review_pending without inventing vocals; require cannot. Unverified common musical identity/development, actual hearing, scene fit, gain-vs-orchestration, optional opportunity and seam continuity can stay review_pending when the unchanged actual plan remains technically executable. Same narrative mother arc does not certify a common recording family or heard continuity. Preserve all original unknown/prohibited facts. No new audio/video/frames or independent audition occurred. This is diagnostic-only; no production or professional approval. Explain each disposition against the exact original gap and inline direction/source facts.',
 data:{source_video_sha256:d.source_video_sha256,assembly_partition:d.assembly_partition,
  gap_classification_revision:boundedAssemblyGapClassificationRevision,
  original_caller:row.spec.caller,original_preflight:row.spec.preflight,original_completed_part:row.spec.part,
  original_part_input:row.completed.input,original_response:row.completed.raw_response,full_input:d.full_input,bound_artifacts:d.bound_artifacts,
  original_model_value_sha256:shaBytes(canonical(row.raw.value)),original_plan_and_edits:{plan:row.raw.value.plan,edits:row.raw.value.edits},
  original_gaps:row.raw.value.execution_gaps.map((text,i)=>({gap_id:'gap_'+(i+1),text})),original_review_pending:row.raw.value.review_pending,
  original_direction:scoped.director,original_plot:scoped.analysis,
  editing_constraints:scoped.editing_constraints,original_uncertainty_refs:scoped.original_uncertainty_refs,
  original_music_candidates:d.candidates.music,original_words_candidates:d.candidates.words,
  scope:'Only gap labels/reasons may change; every original edit and review remains immutable and host-bound.',qualification_granted:false}};
 const fields=['original_plan_and_edits','original_gaps','original_review_pending','original_direction','original_plot','editing_constraints','original_uncertainty_refs','original_music_candidates','original_words_candidates'];
 const context=Object.fromEntries(fields.map(k=>[k,request.data[k]])),inline=encodeBoundedInlineRecords(context);
 if(!same(expandBoundedInlineRecords(inline),context))fail('lossless_context_roundtrip_changed');
 for(const k of fields)delete request.data[k];
 request.data.original_context_inline={instruction:'Lossless original context: ["~",i,...values] maps shapes[i]; ["~s",i] maps strings[i]. Original plan/edits/gaps/reviews and existing scoped plot/direction/ALL constraints/source candidates are exact. Expand before classifying.',
  fact_tables_instruction:projection.input.data.assembly_consumer_encoding.instruction,inline};
 return request;
}

export function deriveBoundAssemblyGapClassification(original,classification){
 validateSchema(classification,schemaFor({value:original}));const rows=classification.classifications;
 if(new Set(rows.map(r=>r.gap_id)).size!==rows.length||rows.some(r=>!r.reason.trim()))fail('exact_unique_nonempty_classification_required');
 const value=structuredClone(original);value.execution_gaps=[];
 for(const [i,text]of original.execution_gaps.entries()){
  const row=rows.find(r=>r.gap_id==='gap_'+(i+1));if(!row)fail('missing_original_gap');
  if(row.disposition==='execution_gap')value.execution_gaps.push(text);
  else value.review_pending.push(text+' [Actual diagnostic classification: '+row.reason+']');
 }
 if(!same(value.plan,original.plan)||!same(value.edits,original.edits)||!same(value.review_pending.slice(0,original.review_pending.length),original.review_pending))fail('immutable_model_edit_or_review_changed');
 return value;
}

function wrapper(row,classificationRef,classificationRaw,value){return {schema_version:1,kind:boundedAssemblyGapClassifiedPartKind,
 execution_kind:'host_bound_diagnostic_gap_classification',source_video_sha256:row.caller.data.source_video_sha256,
 recovery:row.spec,original_part_input:row.completed.input,original_model_response:row.completed.raw_response,
 classification_response:classificationRef,original_model_value_sha256:shaBytes(canonical(row.raw.value)),value,
 modified_fields:['/execution_gaps','/review_pending'],original_plan_and_edits_unchanged:true,
 completion_status:'complete',actual_input_processed:true,actual_audio_processed:false,actual_video_processed:false,
 actual_model_gap_classification_executed:true,usage:null,usage_is_in_constituent_receipts:true,
 cli_receipts:classificationRaw.cli_receipts,historical_cli_receipts:row.raw.cli_receipts,
 qualified:false,artistic_approval:false,production_approval:false};}

export async function executeBoundAssemblyGapClassification({row,session,directory}){
 if(!same(row.story?.analysis,session.story?.analysis)||!same(row.story?.frame_mapping,session.story?.frame_mapping))fail('completed_story_binding_changed');
 const input=createBoundAssemblyGapClassificationRequest(row);
 if(session.runtime?.stageRepairCap?.(input.stage)!==0)fail('zero_implicit_repairs_required');
 const {assemblySessionEnvelope}=await import('./bounded_research_assembly.mjs');
 const budget=session.inputBudget(assemblySessionEnvelope(input,session));
 if((budget.submitted_input_tokens??budget.estimated_tokens)>(session.maxSubmittedInputTokens??16000))fail('complete_classifier_input_exceeds_capacity');
 await stable(path.join(directory,'classification-input.json'),input);
 const classification=typeof session.director==='function'?await session.director(input):await session.request(input.stage,input);
 const execution=await verifyBoundedAssemblyPartExecution(classification,{input,session});
 const raw=await load(classification.raw_response),value=deriveBoundAssemblyGapClassification(row.raw.value,raw.value);
 const {validateBoundedAssemblyPart}=await import('./bounded_research_assembly.mjs');
 validateBoundedAssemblyPart(value,row.part,[],row.caller);
 const result=wrapper(row,classification.raw_response,raw,value),ref=await stable(path.join(directory,'classified-part-response.json'),result);
 return {...result,raw_response:ref,classification_execution:execution,mother_action_partition:row.part.mother_action_partition,
  ...(classification.reused?{reused:true,cli_receipts:[],historical_cli_receipts:[...row.raw.cli_receipts,...classification.historical_cli_receipts]}:{})};
}

export async function verifyBoundAssemblyGapClassifiedPart(response,{input}){
 const raw=await load(response.raw_response);
 if(raw.kind!==boundedAssemblyGapClassifiedPartKind||!same(response.value,raw.value))fail('derived_wrapper_changed');
 const row=await preflightBoundAssemblyGapClassificationRecovery(raw.recovery);
 if(!same(input,row.input))fail('derived_part_input_changed');
 const classificationRaw=await load(raw.classification_response),request=createBoundAssemblyGapClassificationRequest(row);
 const cliRef=classificationRaw.evidence_files?.find(r=>path.resolve(r.path)===path.join(path.dirname(raw.classification_response.path),'request.json'));
 if(!cliRef)fail('classification_cli_request_required');const actualRequest=await load(cliRef);
 const session={backend:{protocol:'codex_cli',backend_id:classificationRaw.backend_id,model_revision:classificationRaw.model_revision},
  story:actualRequest.input.data.completed_story?{analysis:actualRequest.input.data.completed_story,frame_mapping:actualRequest.input.data.source_frame_mapping}:null};
 if(!same(session.story,row.story))fail('classification_completed_story_binding_changed');
 const execution=await verifyBoundedAssemblyPartExecution(reused(classificationRaw,raw.classification_response),{input:request,session});
 const value=deriveBoundAssemblyGapClassification(row.raw.value,classificationRaw.value);
 if(!same(raw,wrapper(row,raw.classification_response,classificationRaw,value)))fail('derived_value_or_proof_changed');
 const expectedReceipts=response.reused?[...raw.historical_cli_receipts,...raw.cli_receipts]:raw.cli_receipts;
 if(!same(response.reused?response.historical_cli_receipts:response.cli_receipts,expectedReceipts)
  ||!same(response.reused?response.cli_receipts:response.historical_cli_receipts,response.reused?[]:raw.historical_cli_receipts))fail('derived_invocation_accounting_changed');
 const {validateBoundedAssemblyPart}=await import('./bounded_research_assembly.mjs');validateBoundedAssemblyPart(value,row.part,[],row.caller);
 return {original_execution:row.execution,classification_execution:execution,original_response:row.completed.raw_response,
  classification_response:raw.classification_response,actual_model_execution_verified:true,plan_and_edits_unchanged:true,
  new_cli_invocations:response.reused?0:1,actual_audio_hearing_approved:false,production_approval:false};
}

// Independent consumer rechecks both original and field-only executions and
// the actual later part. A host-written derived wrapper cannot grant adoption.
export async function verifyBoundAssemblyGapClassificationMerge(rawResponse,{sourceSha,edits}={}){
 const merged=await load(rawResponse);
 if(!merged.gap_classification_recovery){
  for(const ref of merged.constituent_responses??[])if((await load(ref)).kind===boundedAssemblyGapClassifiedPartKind)fail('merge_recovery_binding_required');
  return null;
 }
 if(merged.kind!=='bounded_research_assembly_result'||merged.execution_kind!=='host_bounded_assembly_merge'
  ||merged.qualified!==false||merged.artistic_approval!==false||merged.production_approval!==false||merged.actual_audio_processed!==false
  ||merged.actual_video_processed!==false||merged.completion_status!=='complete'||sourceSha&&merged.source_video_sha256!==sourceSha
  ||edits&&!same(merged.value?.edits,edits))fail('final_merge_or_edits_changed');
 const row=await preflightBoundAssemblyGapClassificationRecovery(merged.gap_classification_recovery);
 if(!sameRef(merged.original_request,row.spec.caller)||merged.input_sha256!==row.spec.caller.sha256)fail('merge_original_caller_changed');
 const preflight=await load(merged.preflight);
 if(!same(preflight.gap_classification_recovery,row.spec)||!same(preflight.parts.map(p=>p.input),row.old.parts.map(p=>p.input))
  ||merged.parts.length!==preflight.parts.length||merged.constituent_responses.length!==merged.parts.length)fail('merge_partition_changed');
 const {validateBoundedAssemblyPart,mergeBoundedAssemblyValues,actualAssemblyTail}=await import('./bounded_research_assembly.mjs');
 const {withActualPreviousAssemblyTail}=await import('./bounded_assembly_projection.mjs');
 const accepted=[],proofs=[];
 for(const [i,ref]of merged.parts.entries()){
  const completed=await load(ref),part=preflight.parts[i],raw=await load(completed.raw_response),input=await load(completed.input);
  let expected=structuredClone(part.input);
  if(i){expected=withActualPreviousAssemblyTail(expected,actualAssemblyTail(accepted.at(-1).value,accepted.at(-1).raw_response,row.caller));
   expected.schema.properties.edits.properties.dialogue_ducking_db.enum=[accepted[0].value.edits.dialogue_ducking_db];}
  if(!same(input,expected)||!same(completed.raw_response,merged.constituent_responses[i])||completed.execution_gap!==false
   ||!same(completed.mother_action_partition,part.mother_action_partition)||!same(completed.previous_response,i?accepted.at(-1).raw_response:null)
   ||!same(completed.cue_ids,part.cue_ids)||!same(completed.action_ids,part.action_ids)||!same(completed.event_ids,part.event_ids)
   ||!same(completed.target_range,part.target_range)||completed.actual_audio_hearing_approved!==false||completed.production_approval!==false)fail('merged_part_or_input_changed');
  if(!i&&(raw.kind!==boundedAssemblyGapClassifiedPartKind||!same(raw.recovery,row.spec)
    ||!same(raw.original_model_response,row.completed.raw_response)))fail('original_classified_part_binding_changed');
  const response=raw.kind===boundedAssemblyGapClassifiedPartKind?{...raw,raw_response:completed.raw_response,reused:true,cli_receipts:[],
    historical_cli_receipts:[...raw.historical_cli_receipts,...raw.cli_receipts]}:reused(raw,completed.raw_response);
  const session={story:row.story,backend:{protocol:'codex_cli',backend_id:raw.backend_id,model_revision:raw.model_revision}};
  proofs.push(await verifyBoundedAssemblyPartExecution(response,{input,session}));
  const validated=validateBoundedAssemblyPart(raw.value,{...part,input},accepted,row.caller);
  if(validated.execution_gap)fail('actual_hard_gap_still_blocks');
  accepted.push({...response,mother_action_partition:part.mother_action_partition});
 }
 if(!same(mergeBoundedAssemblyValues(accepted,row.caller),merged.value))fail('full_unchanged_plan_merge_changed');
 return {original_response:row.completed.raw_response,verified_part_proofs:proofs,unchanged_original_plan_and_edits:true,
  actual_audio_hearing_approved:false,production_approval:false,new_model_calls:0};
}
