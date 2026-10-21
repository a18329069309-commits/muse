import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {readJson,verifyEvidenceBindings,validateSchema,shaBytes} from './audio_api.mjs';
import {projectCompactBusinessContract,restoreCompactBusinessValue} from './compact_business_contract.mjs';
import {baseStructuredEvidencePrompt} from './codex_cli_runtime.mjs';
import {completedBatchEventsValid} from './bound_direction_execution_evidence.mjs';
import {soundQueryFieldProjectionRevision,soundQueryFieldProjectionStage,checkSoundQueryCoverage} from './sound_query_contract.mjs';
import {soundQueryOutcomeRevision,validateSoundQueryCompletionValue} from './sound_query_completion.mjs';

const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b),fail=reason=>{throw Error('completed_sound_query_'+reason);};

// Reuses one already completed actual field-only call. It never submits a model
// request and does not turn metadata queries into sound/use qualification.
export async function loadCompletedSoundQueryBatch(binding,{source,analysisBinding,directionBinding,catalogue,events,queries}){
  await verifyEvidenceBindings(binding);const record=await readJson(binding.path);
  const pending=record.status==='query_projection_recorded_with_explicit_retrieval_gaps';
  if(record.revision!==soundQueryFieldProjectionRevision||record.status!=='query_projection_completed_materials_still_pending'&&!pending
    ||pending&&record.outcome_revision!==soundQueryOutcomeRevision
    ||record.original_events_changed!==false||record.qualification_granted!==false||record.production_approval!==false
    ||record.source?.sha256!==source.sha256||record.analysis?.sha256!==analysisBinding.sha256
    ||record.original_director?.sha256!==directionBinding.sha256||!same(record.event_ids,events.map(row=>row.id)))fail('current_binding_changed');
  await verifyEvidenceBindings([record.source,record.analysis,record.original_director,record.queue,record.result,record.handoff,record.derived_director]);
  const queue=await readJson(record.queue.path),result=await readJson(record.result.path),handoff=await readJson(record.handoff.path);
  if(queue.requests?.length!==1||queue.source_video_sha256!==source.sha256||queue.analysis.sha256!==analysisBinding.sha256
    ||queue.director.sha256!==directionBinding.sha256||result.request?.sha256!==queue.requests[0].sha256
    ||result.source?.sha256!==source.sha256||result.analysis?.sha256!==analysisBinding.sha256
    ||result.original_director?.sha256!==directionBinding.sha256||result.actual_runtime_executed!==true
    ||result.actual_input_reviewed!==true||result.actual_audio_processed!==false||result.production_approval!==false
    ||!same(handoff.completion_queue,record.queue)||!same(handoff.completion_results,[record.result])
    ||!same(handoff.derived_director,record.derived_director))fail('completed_chain_changed');
  await verifyEvidenceBindings([queue.requests,result.raw_response,result.cli_receipts]);
  const request=await readJson(queue.requests[0].path);
  if(request.stage!==soundQueryFieldProjectionStage||request.frames?.length
    ||!same(request.data.events,events)||!same(request.data.existing_sound_queries,queries)
    ||!same(request.data.catalogue,catalogue))fail('event_intent_or_catalogue_changed');
  validateSchema(result.value,request.schema);
  const checked=checkSoundQueryCoverage({source_video_sha256:source.sha256,sound_events:events},result.value,{catalogue_excluded_tags:catalogue.allowed_excluded_tags});
  if(!checked.retrieval_complete){
    if(!pending||result.outcome_revision!==soundQueryOutcomeRevision)fail('returned_query_incomplete');
    const outcome=validateSoundQueryCompletionValue(request,{source_video_sha256:source.sha256,sound_events:events},result.value);
    if(!same(outcome.pending_retrieval_gaps,record.pending_retrieval_gaps)||!same(outcome.pending_retrieval_gaps,result.pending_retrieval_gaps))
      fail('pending_retrieval_scope_changed');
  }else if(pending)fail('pending_retrieval_scope_changed');
  for(const original of queries){const next=result.value.sound_queries.find(row=>row.event_id===original.event_id);
    if(next?.text!==original.text||next?.asset_kind!==original.asset_kind||!same(next.filters,original.filters))fail('original_intent_or_filters_changed');}
  const raw=await readJson(result.raw_response.path);
  if(raw.execution_kind!=='codex_cli_inference'||raw.backend_id!=='codex-cli-chatgpt'||raw.completion_status!=='complete'
    ||raw.actual_runtime_executed!==true||raw.actual_input_processed!==true||raw.actual_frames_submitted!==0
    ||raw.actual_audio_processed!==false||raw.actual_video_processed!==false||raw.qualified!==false
    ||raw.artistic_approval!==false||raw.production_approval!==false||raw.synthetic_protocol_fixture
    ||raw.source_video_sha256!==source.sha256||raw.input_sha256!==queue.requests[0].sha256
    ||!same(raw.value,result.value)||raw.cli_receipts?.length!==1||raw.historical_cli_receipts?.length
    ||!same(raw.cli_receipts,result.cli_receipts)||!same(raw.usage,result.usage))fail('actual_unqualified_return_required');
  await verifyEvidenceBindings(raw.evidence_files);
  const cliRequestRef=raw.evidence_files.find(ref=>path.resolve(ref.path)===path.join(path.dirname(result.raw_response.path),'request.json'));
  if(!cliRequestRef)fail('actual_cli_request_required');
  const cliRequest=await readJson(cliRequestRef.path),receipt=await readJson(raw.cli_receipts[0].path);
  const expected={stage:request.stage,prompt:request.prompt,schema:request.schema,frames:request.frames,
    data:{...request.data,source_video:result.source,original_request:queue.requests[0]},input:queue.requests[0]};
  if(cliRequest.role!==soundQueryFieldProjectionStage||!same(cliRequest.input,expected)
    ||cliRequest.source_video_sha256!==source.sha256||cliRequest.input_sha256!==queue.requests[0].sha256
    ||cliRequest.model_revision!==raw.model_revision||cliRequest.model_requested!==raw.model
    ||shaBytes(canonical(cliRequest))!==raw.request_sha256||receipt.status!=='complete'
    ||receipt.cli_invocations!==1||receipt.process_terminated!==true||receipt.timed_out!==false
    ||receipt.exit_code!==0&&!receipt.completed_turn_cleanup||receipt.synthetic_protocol_fixture
    ||receipt.source_video_sha256!==source.sha256||receipt.input_sha256!==queue.requests[0].sha256
    ||receipt.request_sha256!==raw.request_sha256||!same(receipt.request,cliRequestRef)
    ||receipt.model_revision!==raw.model_revision||receipt.model_requested!==raw.model||!same(receipt.usage,raw.usage))fail('actual_request_or_receipt_changed');
  await verifyEvidenceBindings([cliRequest.input_bindings,receipt.final,receipt.schema,receipt.prompt,receipt.jsonl,
    receipt.host_business_contract,receipt.worker_instructions,receipt.host_cli_resolution]);
  const contract=projectCompactBusinessContract(cliRequest.input),wire=await readJson(receipt.final.path);
  if(!same(await readJson(receipt.schema.path),contract.wireSchema)
    ||!same(await readJson(receipt.host_business_contract.path),contract.audit)
    ||!same(restoreCompactBusinessValue(wire,contract),raw.value)
    ||await readFile(receipt.prompt.path,'utf8')!==baseStructuredEvidencePrompt(cliRequest.role,contract.input))fail('actual_compact_return_changed');
  const eventsLog=(await readFile(receipt.jsonl.path,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if(!completedBatchEventsValid(eventsLog,receipt,{finalBytes:await readFile(receipt.final.path),schema:contract.wireSchema})
    ||eventsLog.filter(row=>row.type==='turn.completed').length!==1
    ||!same(JSON.parse(eventsLog.findLast(row=>row.type==='item.completed'&&row.item?.type==='agent_message')?.item.text??'null'),wire))fail('actual_turn_event_changed');
  const turn=eventsLog.find(row=>row.type==='turn.completed');
  for(const key of ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'])
    if((receipt.usage?.tokens?.[key]??0)!==(turn.usage?.[key]??0))fail('actual_turn_usage_changed');
  const derived=await readJson(record.derived_director.path),original=await readJson(record.original_director.path),direction=original.direction??original;
  const expectedDirection={...direction,sound_queries:direction.sound_queries.map(query=>result.value.sound_queries.find(row=>row.event_id===query.event_id)??query),
    uncertainties:[...(direction.uncertainties??[]),...result.value.uncertainties]};
  if(!same(derived,expectedDirection))fail('derived_direction_changed');
  return {...record,reused_bound_completion:true,completed_recovery:binding,model_execution_attempted:false,new_model_calls:0,
    historical_cli_receipts:raw.cli_receipts,qualification_granted:false};
}
