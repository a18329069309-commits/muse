// A host-owned request scope, never a replacement narrative cue or material choice.
import {shaBytes} from './audio_api.mjs';
import {projectAssemblyCueGroup} from './bounded_assembly_projection.mjs';
import {assemblyMotherActionEditingRevision,withOwnedPartClockBounds,assemblyOwnedPartClockBoundsRevision,scopeAssemblySoundFunctionContext} from './assembly_consumer_projection.mjs';
import {boundedAssemblyContinuationRevision,boundedTailEnvelopeMaxItems,boundedActualTailCapacity,boundedPieceIdentifierMaxLength} from './bounded_assembly_continuation.mjs';
export const motherActionPartitionRevision='mother-cue-complete-action-subparts-v1';
const canonical=v=>JSON.stringify(v,(_,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);
const same=(a,b)=>canonical(a)===canonical(b),clone=v=>structuredClone(v);
const overlap=(a,b)=>a[0]<b[1]&&b[0]<a[1],within=(a,b)=>a[0]>=b[0]&&a[1]<=b[1];
const samples=r=>r.map(t=>Math.round(t*48000));
const fail=s=>{throw Error('bounded_mother_action_'+s);};
const wordsFields=['words_candidate_request','words_target_range','words_opportunity','words_mode','words_function',
  'words_audio_retrieval_query','words_complete_phrase_required'];

export function motherActionUnits(fullInput){
  const cues=fullInput.data?.director?.cues;
  if(fullInput.data?.bounded_assembly_projection_revision!==motherActionPartitionRevision||cues?.length!==1)fail('explicit_single_mother_required');
  const mother=cues[0],actions=fullInput.data.director.music_actions??[];
  if(actions.length<2||new Set(actions.map(a=>a.id)).size!==actions.length
    ||!same(actions.map(a=>a.id),mother.required_action_ids))fail('complete_ordered_actions_required');
  let end=samples(mother.target_range)[0];
  for(const action of actions){const r=samples(action.target_range);
    if(r[0]!==end||r[1]<=r[0]||!mother.story_beat_ids.includes(action.story_beat_id))fail('complete_contiguous_action_union_required');end=r[1];}
  if(end!==samples(mother.target_range)[1])fail('complete_contiguous_action_union_required');
  // Opportunity is an admission region, never an already selected full phrase.
  const protectedRanges=mother.words_target_range?[mother.words_target_range]:[];
  if((fullInput.data.candidates.words??[]).length&&!mother.words_target_range)fail('selected_words_requires_exact_placement');
  if(mother.words_candidate_request==='require'&&!mother.words_target_range)fail('required_words_requires_exact_placement');
  const boundaries=actions.map(a=>a.target_range[0]).slice(1);
  return {mother,actions,boundaries,protected_ranges:protectedRanges,
    legal_boundary:at=>protectedRanges.every(r=>at<=r[0]||at>=r[1])};
}

export function projectMotherActionGroup(fullInput,start,end){
  const units=motherActionUnits(fullInput),{mother,actions}=units;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>actions.length)fail('contiguous_action_group_required');
  const current=actions.slice(start,end),target=[current[0].target_range[0],current.at(-1).target_range[1]];
  if(start&&!units.legal_boundary(target[0])||end<actions.length&&!units.legal_boundary(target[1]))fail('cannot_split_words_placement');
  const base=projectAssemblyCueGroup(fullInput,[mother.cue_id],{deferOwnedPartBounds:true}),input=clone(base.input),data=input.data;
  const alias=`${mother.cue_id}/sub/${start}-${end}`,arcId=`mother_${shaBytes(canonical([fullInput.data.source_video_sha256,mother.cue_id])).slice(0,12)}`;
  const ownedEvents=data.analysis.sound_events.filter(e=>e.start_seconds>=target[0]&&e.start_seconds<target[1]);
  const relevantEvents=data.analysis.sound_events.filter(e=>overlap([e.start_seconds,e.end_seconds],target));
  const eventIds=new Set(ownedEvents.map(e=>e.id)),relevantIds=new Set(relevantEvents.map(e=>e.id));
  const beatIds=new Set(current.map(a=>a.story_beat_id));
  for(const beat of data.analysis.story_beats)if(overlap([beat.start_seconds,beat.end_seconds],target))beatIds.add(beat.id);
  const activeBeatIds=new Set(beatIds),basisFields=new Map();
  // Every original constraint and literal remains. Quotes may refer outside the
  // current subpart, so retain their exact beat fields as context, never summarize.
  for(const disposition of data.director.uncertainty_dispositions)for(const component of disposition.components??[])
    for(const basis of component.basis??[]){beatIds.add(basis.story_beat_id);
      if(!basisFields.has(basis.story_beat_id))basisFields.set(basis.story_beat_id,new Set());
      basisFields.get(basis.story_beat_id).add(basis.field);}
  const cue=clone(mother);cue.cue_id=alias;cue.target_range=target;cue.required_action_ids=current.map(a=>a.id);
  cue.story_beat_ids=mother.story_beat_ids.filter(id=>beatIds.has(id));
  cue.story_sequence=clone((mother.story_sequence??[]).filter(step=>
    step.event_anchor?.target_seconds>=target[0]&&step.event_anchor.target_seconds<target[1]));
  const opportunity=(mother.words_opportunity?.allowed_target_intervals??[]).filter(r=>overlap(r,target))
    .map(r=>[Math.max(r[0],target[0]),Math.min(r[1],target[1])]);
  const ownsWords=mother.words_target_range?within(mother.words_target_range,target):opportunity.length>0;
  if(!ownsWords)for(const key of wordsFields)delete cue[key];
  else if(!mother.words_target_range&&cue.words_opportunity)cue.words_opportunity.allowed_target_intervals=opportunity;
  const context={cue_id:mother.cue_id,case_conditions:{relationship:mother.case_conditions.relationship,
    threat_resolved:mother.case_conditions.threat_resolved},context_only:true};
  data.director.cues=[cue,context];data.director.music_actions=clone(current);
  const contextBeatMapping=[];
  data.analysis.story_beats=data.analysis.story_beats.filter(b=>beatIds.has(b.id)).map(beat=>{
    if(activeBeatIds.has(beat.id))return beat;
    const fields=new Set(['id','start_seconds','end_seconds','evidence_ids',...(basisFields.get(beat.id)??[])]);
    contextBeatMapping.push({id:beat.id,original_sha256:shaBytes(canonical(beat)),retained_fields:[...fields]});
    return {...Object.fromEntries(Object.entries(beat).filter(([key])=>fields.has(key))),context_only:true};
  });
  data.analysis.sound_events=clone(relevantEvents);
  const scopedStyleMapping=[];
  for(const [key,value] of Object.entries(data.analysis.style_direction??{}))if(typeof value==='string'){
    const lines=value.split('\n'),scoped=lines.map(line=>{
      const match=line.match(/^\[(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)s\]/);
      return match?{line,range:[Number(match[1]),Number(match[2])]}:null;});
    // Scope only an entirely structured absolute-clock field. Unstructured
    ///global language remains verbatim. Each removed line belongs to another
    //complete part, with the exact original retained in the full host request.
    if(scoped.every(Boolean)){
      data.analysis.style_direction[key]=scoped.filter(row=>overlap(row.range,target)).map(row=>row.line).join('\n');
      scopedStyleMapping.push({key,original_sha256:shaBytes(canonical(value)),all_ranges:scoped.map(r=>r.range)});
    }
  }
  data.director.sound_queries=(data.director.sound_queries??[]).filter(q=>relevantIds.has(q.event_id));
  const aliasCandidate=(row,words=false)=>{const next=clone(row);next.cue_id=words?alias+'/words':alias;
    if(next.parent_cue_id!==undefined)next.parent_cue_id=alias;return next;};
  data.candidates.music=data.candidates.music.map(row=>aliasCandidate(row));
  data.candidates.words=ownsWords?data.candidates.words.map(row=>aliasCandidate(row,true)):[];
  data.candidates.sounds=data.candidates.sounds.filter(row=>eventIds.has(row.event_id));
  if(data.sound_event_guidance)data.sound_event_guidance=data.sound_event_guidance.filter(row=>relevantIds.has(row.event_id));
  for(const key of ['editor_source_measurements','editor_original_mix_measurements'])if(data[key]?.rows){
    data[key].rows=data[key].rows.filter(row=>!row.event_id||eventIds.has(row.event_id)).map(row=>{
      const next=clone(row);if(next.cue_id===mother.cue_id)next.cue_id=alias;
      if(next.parent_cue_id===mother.cue_id)next.parent_cue_id=alias;return next;});
  }
  // Remove evidence only for nonowned sound assets. All distinct music/words
  // observations and all source probability/level trajectories are retained.
  const identities=new Set(['music','words','sounds'].flatMap(k=>data.candidates[k]).map(r=>canonical([r.segment_id,r.source_sha256,r.source_range])));
  data.material_observations=data.material_observations.filter(r=>identities.has(canonical([r.segment_id,r.source_sha256,r.source_range])));
  const partition={revision:motherActionPartitionRevision,full_input_sha256:shaBytes(canonical(fullInput)),
    parent_cue_id:mother.cue_id,parent_target_range:clone(mother.target_range),temporary_cue_id:alias,
    restored_arc_id:arcId,action_start:start,action_end:end,target_range:target,
    owned_action_ids:current.map(a=>a.id),owned_event_ids:[...eventIds],
    original_constraints_sha256:shaBytes(canonical(fullInput.data.director.uncertainty_dispositions)),
    original_scope_sha256:shaBytes(canonical(fullInput.data.director.uncertainty_scopes)),
    words_owned_here:ownsWords,original_words_context:Object.fromEntries(wordsFields.filter(k=>k in mother).map(k=>[k,clone(mother[k])])),
    context_action_route:{encoding:'object-rows-v1',columns:['id','target_range','story_beat_id'],
      rows:actions.filter((a,index)=>index<start||index>=end).map(a=>[a.id,clone(a.target_range),a.story_beat_id])},
    complete_story_sequence_sha256:shaBytes(canonical(mother.story_sequence??[])),
    context_beat_mapping:contextBeatMapping,
    scoped_style_mapping:scopedStyleMapping,
    source_windows_and_actions_unchanged:true,qualification_granted:false};
  // Integrity/expansion rows are host-owned part metadata. The model receives
  // only the edit scope and complete global/local business conditions.
  data.mother_action_partition={parent_cue_id:mother.cue_id,parent_target_range:clone(mother.target_range),
    words_owned_here:ownsWords};
  data.bounded_assembly_continuation_revision=boundedAssemblyContinuationRevision;
  const hostAliases=[];
  for(const key of ['editor_source_measurements','editor_original_mix_measurements'])if(data[key])
    for(const field of ['actual_measurement','source','parent_source','prepared_original_manifest'])if(field in data[key]){
      hostAliases.push({pointer:`/data/${key}/${field}`,value_sha256:shaBytes(canonical(data[key][field]))});
      delete data[key][field];}
  partition.host_aliases=hostAliases;
  for(const key of ['editor_source_measurements','editor_original_mix_measurements'])for(const [index,row] of (data[key]?.rows??[]).entries())
    for(const field of ['pcm_sha256'])if(field in row){hostAliases.push({pointer:`/data/${key}/rows/${index}/${field}`,
      value_sha256:shaBytes(canonical(row[field]))});delete row[field];}
  data.assembly_partition={...data.assembly_partition,revision:motherActionPartitionRevision,
    full_input_sha256:partition.full_input_sha256,owned_cue_ids:[alias],owned_action_ids:partition.owned_action_ids,
    owned_event_ids:partition.owned_event_ids,target_range:target};
  // The parent's whole function/goal/case conditions already occur in the
  // temporary cue; only its name changed, never its business conditions.
  delete data.assembly_partition.complete_episode_route;
  data.assembly_partition.complete_episode_route_refs=[alias];
  data.mother_action_partition.instruction='Temporary alias scopes whole consecutive parent actions, not a new theme. Host restores one parent arc. Global conditions/route and ALL constraints bind; context_only unedited. Continue actual adopted tail.';
  const arcSchema=input.schema?.properties?.plan?.properties?.arcs;
  if(arcSchema){arcSchema.minItems=1;arcSchema.maxItems=1;
    arcSchema.items.properties.cue_id={...arcSchema.items.properties.cue_id,enum:[alias]};
    arcSchema.items.properties.arc_id={...arcSchema.items.properties.arc_id,enum:[arcId]};
    const pieces=arcSchema.items.properties.pieces.items.properties;
    pieces.piece_id={...pieces.piece_id,maxLength:boundedPieceIdentifierMaxLength,
      pattern:`^s${start}_[A-Za-z0-9_.-]{1,${boundedPieceIdentifierMaxLength-(`s${start}_`).length}}$`};
    pieces.connection_from.properties.previous_piece_id={...pieces.connection_from.properties.previous_piece_id,maxLength:boundedPieceIdentifierMaxLength,
      pattern:`^[A-Za-z0-9_.-]{1,${boundedPieceIdentifierMaxLength}}$`};
    const envelope=input.schema.properties.edits.properties.music_edits.items.properties.gain_envelope;
    if(envelope)envelope.maxItems=boundedTailEnvelopeMaxItems;
  }
  return {input:withOwnedPartClockBounds(scopeAssemblySoundFunctionContext(fullInput,input)),cue_ids:[alias],action_ids:partition.owned_action_ids,event_ids:partition.owned_event_ids,target_range:target,
    mother_action_partition:partition};
}

export function restoreMotherActionValue(value,partition){
  if(partition?.revision!==motherActionPartitionRevision||value.plan.arcs.length!==1
    ||value.plan.arcs[0].cue_id!==partition.temporary_cue_id||value.plan.arcs[0].arc_id!==partition.restored_arc_id)fail('response_alias_identity_changed');
  const result=clone(value),arc=result.plan.arcs[0],mapping=[];
  for(const piece of arc.pieces){if(!piece.piece_id.startsWith(`s${partition.action_start}_`))fail('global_piece_namespace_changed');
    const from=`${partition.temporary_cue_id}/arc/${arc.arc_id}/${piece.piece_id}`;
    mapping.push({from,to:`${partition.parent_cue_id}/arc/${arc.arc_id}/${piece.piece_id}`});}
  const tasks=new Map(mapping.flatMap(row=>[[row.from,row.to],[row.from+'/words',row.to+'/words']]));
  const task=id=>{if(!tasks.has(id))fail('unknown_part_music_task');return tasks.get(id);};
  arc.cue_id=partition.parent_cue_id;
  for(const edit of result.edits.music_edits)edit.music_task_cue_id=task(edit.music_task_cue_id);
  for(const response of result.edits.action_responses){response.music_task_cue_id=task(response.music_task_cue_id);
    if(response.music_task_cue_ids)response.music_task_cue_ids=response.music_task_cue_ids.map(task);}
  return {value:result,mapping};
}

export function mergeMotherActionValues(responses,fullInput,{complete=true}={}){
  const {mother,actions}=motherActionUnits(fullInput),partitions=responses.map(r=>r.mother_action_partition);
  let next=0;
  for(const p of partitions){if(p?.revision!==motherActionPartitionRevision||p.full_input_sha256!==shaBytes(canonical(fullInput))
    ||p.parent_cue_id!==mother.cue_id||p.action_start!==next)fail('part_binding_or_order_changed');
    const expected=projectMotherActionGroup(fullInput,p.action_start,p.action_end).mother_action_partition;
    if(!same(p,expected))fail('part_binding_changed');next=p.action_end;}
  if(!responses.length||complete&&next!==actions.length)fail('all_complete_action_parts_required');
  const restored=responses.map((r,i)=>restoreMotherActionValue(r.value,partitions[i]));
  const first=restored[0].value;
  const value={plan:{...first.plan,arcs:[{...first.plan.arcs[0],pieces:restored.flatMap(r=>r.value.plan.arcs[0].pieces)}]},
    edits:{...first.edits,music_edits:restored.flatMap(r=>r.value.edits.music_edits),
      action_responses:restored.flatMap(r=>r.value.edits.action_responses),sounds:restored.flatMap(r=>r.value.edits.sounds),
      uncertainties:restored.flatMap(r=>r.value.edits.uncertainties)},
    execution_gaps:restored.flatMap(r=>r.value.execution_gaps),review_pending:restored.flatMap(r=>r.value.review_pending)};
  if(responses.some(r=>r.value.edits.dialogue_ducking_db!==first.edits.dialogue_ducking_db))fail('global_ducking_changed');
  const director=clone(fullInput.data.director);
  if(!complete){const prefix=director.cues[0];prefix.target_range=[mother.target_range[0],actions[next-1].target_range[1]];
    prefix.required_action_ids=actions.slice(0,next).map(a=>a.id);
    const protectedRanges=motherActionUnits(fullInput).protected_ranges;
    if(protectedRanges.some(r=>!within(r,prefix.target_range)))for(const k of wordsFields)delete prefix[k];}
  return {value,director,mapping:restored.flatMap(r=>r.mapping)};
}

export function prepareMotherActionAssemblyInputs(fullInput,{estimateInputBudget,maxInputTokens,maxParts,previousTailAllowanceTokens}){
  const {actions}=motherActionUnits(fullInput),cache=new Map();
  const part=(start,end)=>{
    const key=`${start}/${end}`;if(cache.has(key))return cache.get(key);
    let row;try{row=projectMotherActionGroup(fullInput,start,end);}catch(error){
      if(error.message==='bounded_mother_action_cannot_split_words_placement')return null;throw error;}
    if(row.input.data.assembly_consumer_projection_revision!==assemblyOwnedPartClockBoundsRevision)
      row.input.data.assembly_consumer_projection_revision=assemblyMotherActionEditingRevision;
    const sounds=row.input.schema.properties.edits.properties.sounds;
    sounds.minItems=row.event_ids.length;sounds.maxItems=row.event_ids.length;
    if(row.event_ids.length)sounds.items.properties.event_id={...sounds.items.properties.event_id,enum:[...row.event_ids]};
    const budget=estimateInputBudget(row.input),tokens=typeof budget==='number'?budget:budget?.submitted_input_tokens??budget?.estimated_tokens;
    if(!Number.isFinite(tokens)||tokens<=0)fail('complete_capacity_estimate_required');
    const tailCapacity=boundedActualTailCapacity(row.input,{originalActionCount:actions.length});
    const reserve=start?tailCapacity.reserved_input_tokens:0;
    row={...row,input_budget:budget,estimated_tokens:tokens,reserved_previous_tail_tokens:reserve,
      continuation_capacity:tailCapacity,fits:tokens+reserve<=maxInputTokens};
    cache.set(key,row);return row;
  };
  function search(start,left){
    if(start===actions.length)return [];if(!left)return null;
    for(let end=actions.length;end>start;end--){const row=part(start,end);if(!row?.fits)continue;
      const rest=search(end,left-1);if(rest)return [row,...rest];}return null;
  }
  let parts;for(let count=1;count<=maxParts;count++){parts=search(0,count);if(parts)break;}
  if(!parts){const error=Error('bounded_assembly_complete_action_subparts_exceed_capacity');
    error.capacity_report={revision:motherActionPartitionRevision,max_input_tokens:maxInputTokens,max_parts:maxParts,
      evaluated_groups:[...cache.values()].map(({input,...row})=>row),new_calls:0,qualification_granted:false};throw error;}
  return {parts:parts.map(({fits,...row})=>row),audit:{revision:motherActionPartitionRevision,
    full_input_sha256:shaBytes(canonical(fullInput)),part_count:parts.length,max_input_tokens:maxInputTokens,
    previous_tail_allowance_tokens:previousTailAllowanceTokens,typed_continuation_bound_used:true,final_tail_must_be_reestimated:true,
    original_mother_cue_restored_as_one_arc:true,source_clocks_changed:false,new_calls:0,qualification_granted:false}};
}
