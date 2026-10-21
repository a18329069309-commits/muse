import {objectSchema,shaBytes} from './audio_api.mjs';
import {expandBoundedInlineRecords,encodeBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';
import {validateGainEnvelope} from './music_edit_operation_contract.mjs';

export const assemblyDecisionContractRevision='host-bound-editor-decisions-v1';
const clone=structuredClone, sample=t=>Math.round(t*48000), seconds=n=>n/48000;
const canonical=v=>JSON.stringify(v,(_,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);
const fail=reason=>{throw Error('assembly_decision_'+reason);};
const rows=v=>Array.isArray(v)?v:v?.rows?.map(row=>Object.fromEntries(v.columns.map((key,i)=>[key,row[i]])))??[];
const str={type:'string'},num={type:'number'};
const within=(a,b)=>a.every(Number.isFinite)&&b.every(Number.isFinite)&&sample(a[0])>=sample(b[0])&&sample(a[1])<=sample(b[1])&&sample(a[1])>sample(a[0]);

// This adapter removes only mechanically recoverable output operands. The
// model still authors source starts, target pieces, gain curves and transitions.
export function projectAssemblyDecisionContract(input){
 const revision=input.data?.assembly_decision_contract_revision;
 if(revision===undefined)return null;
 if(revision!==assemblyDecisionContractRevision||input.stage!=='current_research_episode_assembly')fail('revision_invalid');
 const schema=input.schema??input.response_schema,arc=schema.properties?.plan?.properties?.arcs?.items;
 if(!arc)return null; // The sound-only role retains its original business schema.
 const cue=arc.properties.cue_id.enum,arcIds=arc.properties.arc_id.enum;
 if(cue?.length!==1||arcIds?.length!==1)return null; // Unscoped parent is projected into roles before execution.
 const view=input.data.inline?expandBoundedInlineRecords(input.data.inline):input.data;
 const actions=rows(view.director?.music_actions),candidates=input.data.candidates?.music??[];
 if(!actions.length||new Set(actions.map(a=>a.id)).size!==actions.length||!candidates.length)fail('bound_actions_and_sources_required');
 const originalPiece=arc.properties.pieces.items,edit=schema.properties.edits.properties;
 if(!edit.music_edits||!edit.action_responses||!edit.dialogue_ducking_db)fail('full_edit_schema_required');
 const source=objectSchema({segment_id:{type:'string',enum:[...new Set(candidates.map(c=>c.segment_id))]},source_start_seconds:num});
 source.type=['object','null'];
 const connection=objectSchema({type:clone(originalPiece.properties.connection_from.properties.type),
  overlap_seconds:num,lead_seconds:num,fade_curve:clone(originalPiece.properties.connection_from.properties.fade_curve),reason:str});
 connection.type=['object','null'];
 const musicEdit=clone(edit.music_edits.items);delete musicEdit.properties.music_task_cue_id;
 musicEdit.required=musicEdit.required.filter(k=>k!=='music_task_cue_id');musicEdit.type=['object','null'];
 const response=edit.action_responses.items;
 const properties={pieces:{type:'array',minItems:1,items:objectSchema({target_range:clone(originalPiece.properties.target_range),
  source,development_role:clone(originalPiece.properties.development_role),silence_reason:clone(originalPiece.properties.silence_reason),
  connection,edit:musicEdit})},actions:{type:'array',maxItems:actions.length,
  items:objectSchema({action_id:{type:'string',enum:actions.map(a=>a.id)},
   operation:clone(response.properties.actual_edit_operation),reason:clone(response.properties.reason)})},
  dialogue_ducking_db:clone(edit.dialogue_ducking_db),execution_gaps:clone(schema.properties.execution_gaps),review_pending:clone(schema.properties.review_pending)};
 const mother=rows(view.director?.cues).find(c=>c.cue_id===cue[0]),words=input.data.candidates?.words??[];
 if(words.length){if(!mother?.words_target_range)fail('selected_words_requires_bound_full_placement');properties.words_edit=clone(musicEdit);properties.words_edit.type='object';}
 if(edit.sounds)properties.sounds=clone(edit.sounds);
 if(schema.properties.gap_records)properties.gap_records=clone(schema.properties.gap_records);
 const match=originalPiece.properties.piece_id.pattern?.match(/\^s(\d+)_/);
 const context={revision,sourceSha:input.data.source_video_sha256,cue_id:cue[0],arc_id:arcIds[0],
  prefix:`s${match?.[1]??0}_`,actions:clone(actions),candidates:clone(candidates),schema:clone(schema),
  previous_tail:clone(input.data.actual_previous_assembly_tail??null),words_target_range:words.length?clone(mother.words_target_range):null};
 return {schema:objectSchema(properties),context,instruction:'Ordered pieces; one decision/action. Host restores IDs/source ends/task mappings/handles at 48kHz. source=null requires edit=null and silence reason. Otherwise choose supplied segment/start and actual gain/full relative curve. connection=null only at origin; overlap=lead+outgoing tail; non-crossfade uses zeros. Same recording_ref means same recording, never new permissions. All constraints/unknowns bind; no inferred phrases or approval.',
  audit:{revision,host_context_sha256:shaBytes(canonical(context)),creative_source_gain_curve_and_transition_decisions_preserved:true,
   host_identity_fields:['asset_id','source_sha256','condition_binding','assembly_partition','completed_story','source_frame_mapping'],
   complete_original_schema_revalidated:true,qualification_granted:false}};
}

// Selected asset hashes and provenance links are immutable host identities.
// Keep exact selectable clocks and permission intervals plus an equality alias
// for recording continuity; do not drop a sound fact or executable constraint.
export function projectAssemblyDecisionInput(input,context){
 const output=clone(input),recordings=[...new Set(context.candidates.map(c=>c.source_sha256))];
 // Role/action ownership is already pinned by the decision schema and inline
 // current actions. Full parent/request identity remains in the host audit.
 delete output.data.assembly_partition;delete output.data.source_video_sha256;
 delete output.data.assembly_decision_contract_revision;
 delete output.data.completed_story;delete output.data.source_frame_mapping;
 output.prompt=output.prompt.replace('Task=cue_id/arc/arc_id/piece_id; ','');
 if(output.data.candidates?.music)output.data.candidates.music=context.candidates.map(c=>({
  ...Object.fromEntries(['segment_id','source_range','selection_source_ranges','allowed_target_range'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,clone(c[k])])),
  recording_ref:recordings.indexOf(c.source_sha256)}));
 if(output.data.inline){const view=expandBoundedInlineRecords(output.data.inline);
  for(const group of view.source_window_capacity?.groups??[]){group.recording_ref=recordings.indexOf(group.source_sha256);
   delete group.source_sha256;delete group.asset_id;delete group.permission_sha256;}
  output.data.inline=encodeBoundedInlineRecords(view);
 }
 return output;
}

export function restoreAssemblyDecisionValue(decision,context){
 const pieces=[],music_edits=[],actions=context.actions,previous=context.previous_tail;
 for(const [index,row]of decision.pieces.entries()){
  const id=`${context.prefix}p${index}`,target=row.target_range;
  if(!target.every(Number.isFinite)||sample(target[1])<=sample(target[0]))fail('target_range_invalid');
  let window=null;
  if(row.source!==null){
   const matches=context.candidates.filter(c=>c.segment_id===row.source.segment_id&&(c.cue_id===context.cue_id||c.parent_cue_id===context.cue_id));
   if(matches.length!==1)fail('unknown_or_ambiguous_source');
   const candidate=matches[0],start=sample(row.source.source_start_seconds),end=start+sample(target[1])-sample(target[0]);
   const range=[seconds(start),seconds(end)];
   if(!within(range,candidate.source_range)||candidate.library_allowed_source_range&&!within(range,candidate.library_allowed_source_range)
    ||candidate.allowed_target_range&&!within(target,candidate.allowed_target_range)
    ||candidate.selection_source_ranges&&!candidate.selection_source_ranges.some(r=>within(range,r)))fail('source_or_target_permission_changed');
   window={segment_id:candidate.segment_id,asset_id:candidate.asset_id,source_sha256:candidate.source_sha256,
    candidate_source_range:clone(candidate.source_range),source_range:range};
  }
  const before=pieces.at(-1)??previous?.piece;
  let connection_from=null;
  if(row.connection!==null){
   if(!before)fail('actual_previous_piece_required');
   const link=row.connection,total=sample(link.overlap_seconds),lead=sample(link.lead_seconds),tail=total-lead;
   if(!Number.isFinite(total)||!Number.isFinite(lead)||total<0||lead<0||tail<0||link.type!=='crossfade'&&(total!==0||lead!==0))fail('connection_duration_invalid');
   connection_from={previous_piece_id:before.piece_id,type:link.type,overlap_seconds:seconds(total),
    from_source_handle_range:link.type==='crossfade'&&before.source_window?[before.source_window.source_range[1],seconds(sample(before.source_window.source_range[1])+tail)]:null,
    to_source_handle_range:link.type==='crossfade'&&window?[seconds(sample(window.source_range[0])-lead),window.source_range[0]]:null,
    fade_curve:link.fade_curve,reason:link.reason};
  }else if(before)fail('explicit_actual_connection_required');
  const piece={piece_id:id,target_range:clone(target),source_window:window,development_role:row.development_role,
   silence_reason:row.silence_reason,connection_from};pieces.push(piece);
  if(window){
   if(!row.edit)fail('actual_music_edit_required');
   if(row.edit.gain_envelope!==null)validateGainEnvelope(row.edit.gain_envelope,seconds(sample(target[1])-sample(target[0])),row.edit.gain_db);
   music_edits.push({...clone(row.edit),music_task_cue_id:`${context.cue_id}/arc/${context.arc_id}/${id}`});
  }else if(row.edit!==null)fail('silence_cannot_invent_music_edit');
 }
 if((!decision.execution_gaps.length&&decision.actions.length!==actions.length)
  ||new Set(decision.actions.map(a=>a.action_id)).size!==decision.actions.length)fail('complete_unique_actions_required');
 let wordsTask=null;
 if(context.words_target_range){const owners=pieces.filter(p=>p.source_window&&within(context.words_target_range,p.target_range));
  if(owners.length!==1||!decision.words_edit)fail('whole_selected_words_piece_required');
  wordsTask=`${context.cue_id}/arc/${context.arc_id}/${owners[0].piece_id}/words`;
  if(decision.words_edit.gain_envelope!==null)validateGainEnvelope(decision.words_edit.gain_envelope,
   seconds(sample(context.words_target_range[1])-sample(context.words_target_range[0])),decision.words_edit.gain_db);
  music_edits.push({...clone(decision.words_edit),music_task_cue_id:wordsTask});
 }
 const action_responses=decision.actions.map(row=>{
  const action=actions.find(a=>a.id===row.action_id);if(!action)fail('unknown_action');
  const tasks=pieces.filter(p=>p.source_window&&sample(p.target_range[0])<sample(action.target_range[1])&&sample(action.target_range[0])<sample(p.target_range[1]))
   .map(p=>`${context.cue_id}/arc/${context.arc_id}/${p.piece_id}`);
  if(!tasks.length)fail('action_music_coverage_required');
  if(row.operation.kind==='lyric_entry'&&wordsTask&&sample(context.words_target_range[0])<sample(action.target_range[1])
   &&sample(action.target_range[0])<sample(context.words_target_range[1]))tasks.push(wordsTask);
  return {action_id:row.action_id,music_task_cue_id:tasks[0],music_task_cue_ids:tasks,target_range:clone(action.target_range),
   response_kind:row.operation.kind==='hold'?'hold':row.operation.kind==='source_development'?'source_development':'edit_operation',
   actual_edit_operation:clone(row.operation),reason:row.reason};
 });
 const result={plan:{schema_version:2,source_video_sha256:context.sourceSha,
  arcs:[{cue_id:context.cue_id,arc_id:context.arc_id,pieces}]},edits:{schema_version:2,music_edits,action_responses,
   dialogue_ducking_db:decision.dialogue_ducking_db,uncertainties:[]},execution_gaps:clone(decision.execution_gaps),review_pending:clone(decision.review_pending)};
 if(decision.sounds)result.edits.sounds=clone(decision.sounds);
 if(decision.gap_records)result.gap_records=clone(decision.gap_records);
 return result;
}
