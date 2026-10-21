// A music-only, versioned prompt view. The existing flat projection retains
// every ASR value and class probability; this additional encoding is lossless.
import {shaBytes} from './audio_api.mjs';
import {projectFlatMaterialObservations} from './material_observation_projection.mjs';
import {encodeBoundedInlineRecords,expandBoundedInlineRecords} from './bounded_inline_record_encoding.mjs';

export const independentMusicSelectionProjectionRevision='independent-music-flat-records-v1';
const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
const json=value=>JSON.parse(JSON.stringify(value));
const fail=detail=>{throw Error('independent_music_selection_projection_'+detail);};
const instruction='music_task_evidence_inline contains the complete tasks in reversible shared-inline-record-shapes-v1 form. Expand ["~",shape_index,...values] using shapes field names, and ["~s",string_index] using strings. Every distinct observation, all ASR words, probabilities, unknowns, conditions, source windows and limitations remain present. The tasks list supplies output IDs only: compare the complete encoded tasks, not that short list. No listening, lyric, clean-audio, use or production qualification is granted.';
function assertInput(input){
  if(input.independent_music_selection_projection!==independentMusicSelectionProjectionRevision
    ||input.material_strategy!=='independent_music_packs'
    ||input.stage!=='independent_music_pack_material_selection'
    ||!input.input?.path||!/^[a-f0-9]{64}$/i.test(input.input.sha256??'')
    ||!Array.isArray(input.tasks)||!input.tasks.length||input.sfx_material_selection_projection!==undefined)
    fail('source_bound_music_request_required');
  const ids=new Set();
  for(const task of input.tasks){
    if(!['music','words'].includes(task.kind)||!task.task_id||!task.cue_id||ids.has(task.task_id)
      ||!Array.isArray(task.candidates)||!task.candidates.length)fail('complete_task_required');
    ids.add(task.task_id);
  }
}
function encodedView(baseline,scope=null){
  const output=json(baseline),completeTasks=output.tasks;
  output.music_task_evidence_inline=encodeBoundedInlineRecords({tasks:completeTasks});
  if(!same(expandBoundedInlineRecords(output.music_task_evidence_inline),{tasks:completeTasks}))fail('lossless_roundtrip_failed');
  output.tasks=completeTasks.map(({task_id,cue_id,kind})=>({task_id,cue_id,kind}));
  output.music_selection_projection={revision:independentMusicSelectionProjectionRevision,full_request:output.input,
    projected_complete_tasks_sha256:shaBytes(canonical(completeTasks)),
    encoded_tasks_sha256:shaBytes(canonical(output.music_task_evidence_inline)),
    ...(scope?{partition_scope:scope}:{}),instruction};
  return output;
}
export function projectIndependentMusicSelectionInput(input){
  assertInput(input);
  // Explicit new contract normalizes only JSON serialization; no legacy view
  // or source file is rewritten. Undefined optional keys were never submitted.
  return encodedView(projectFlatMaterialObservations(json(input)));
}
export function expandIndependentMusicSelectionInput(projected,{fullInput}={}){
  if(!fullInput)fail('full_parent_required');
  const expected=projectIndependentMusicSelectionInput(fullInput);
  if(!same(projected,expected))fail('projected_parent_changed');
  const tasks=expandBoundedInlineRecords(projected.music_task_evidence_inline)?.tasks;
  const baseline=projectFlatMaterialObservations(json(fullInput));
  if(!same(tasks,baseline.tasks))fail('complete_task_facts_changed');
  return baseline;
}
export function projectIndependentMusicSelectionPartition(part,{fullInput}={}){
  if(!fullInput)fail('full_parent_required');
  const parent=projectIndependentMusicSelectionInput(fullInput),partition=part.partition;
  if(!partition||!Number.isSafeInteger(partition.item_start)||partition.item_start<0
    ||partition.total_items!==parent.tasks.length||partition.source_order_preserved!==true
    ||!Array.isArray(part.tasks)||!part.tasks.length)fail('contiguous_partition_required');
  const start=partition.item_start,count=part.tasks.length;
  if(start+count>parent.tasks.length
    ||!same(part,{...parent,tasks:parent.tasks.slice(start,start+count),partition}))fail('partition_parent_or_tasks_changed');
  const baseline=projectFlatMaterialObservations(json(fullInput));
  baseline.tasks=baseline.tasks.slice(start,start+count);baseline.partition=json(partition);
  return encodedView(baseline,{parent_projected_tasks_sha256:parent.music_selection_projection.projected_complete_tasks_sha256,
    item_start:start,item_count:count,total_items:parent.tasks.length});
}
