import path from 'node:path';
import { readJson, saveJson, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { checkSoundQueryCoverage, soundQueryFieldProjectionRevision, soundQueryFieldProjectionStage } from './sound_query_contract.mjs';
import {normalizeSoundRetrievalQuery} from './sound_retrieval_contract.mjs';

export const soundQueryOutcomeRevision='completed-query-with-scoped-retrieval-gaps-v1';

// A nullable retrieval field is an explicit shortage, not a lost model return.
// Only field-only repairs can record this outcome. Missing IDs, other malformed
// fields and changed intent remain hard failures; no retrieval is invented.
export function validateSoundQueryCompletionValue(request,analysis,value){
  validateSchema(value,request.schema);
  const catalogueTags=request.stage===soundQueryFieldProjectionStage?request.data.catalogue.allowed_excluded_tags:null;
  const checked=checkSoundQueryCoverage({...analysis,sound_events:request.data.events},value,{catalogue_excluded_tags:catalogueTags});
  const ids=value.sound_queries.map(row=>row.event_id),wanted=request.data.events.map(row=>row.id);
  if(new Set(ids).size!==ids.length||ids.length!==wanted.length||wanted.some(id=>!ids.includes(id)))
    throw Error('sound_completion_response_missing_query');
  for(const id of request.data.query_repair_event_ids??[]){
    const old=request.data.existing_sound_queries.find(query=>query.event_id===id),next=value.sound_queries.find(query=>query.event_id===id);
    if(!old||next?.text!==old.text||next?.asset_kind!==old.asset_kind)throw Error('sound_completion_repair_must_preserve_original_intent');
    if(request.stage===soundQueryFieldProjectionStage&&JSON.stringify(next.filters)!==JSON.stringify(old.filters))
      throw Error('sound_completion_field_repair_must_preserve_original_filters');
  }
  const pending=[];
  if(!checked.retrieval_complete){
    if(request.stage!==soundQueryFieldProjectionStage||!value.uncertainties.some(row=>typeof row==='string'&&row.trim()))
      throw Error('sound_completion_response_missing_query');
    for(const id of checked.query_repair_required_event_ids){
      const query=value.sound_queries.find(row=>row.event_id===id),event=request.data.events.find(row=>row.id===id);
      const normalized=normalizeSoundRetrievalQuery(query,event);
      if(query?.retrieval_query!==null||!normalized.repair_reasons?.length
        ||normalized.repair_reasons.some(reason=>reason!=='positive_retrieval_projection_required')
        ||query.excluded_tags.some(tag=>!catalogueTags.includes(tag)))
        throw Error('sound_completion_response_invalid_retrieval_fields');
      pending.push({event_id:id,status:'positive_retrieval_descriptor_unavailable',original_intent:query.text,
        repair_reasons:normalized.repair_reasons,qualification_granted:false});
    }
  }
  return {coverage:checked,pending_retrieval_gaps:pending,outcome_revision:soundQueryOutcomeRevision};
}

async function readBound(ref) {
  if (!ref?.path || !ref.sha256) throw new Error('sound_completion_binding_required');
  await verifyEvidenceBindings(ref); return readJson(ref.path);
}

// The injected host/API session owns authentication, fees and execution; this stage only creates query intent.
export async function completeSoundQueryRequest(config, session) {
  const request = await readBound(config.request), analysis = await readBound(request.data.analysis);
  const original = await readBound(request.data.director), source = config.source;
  await verifyEvidenceBindings([source, ...(request.frames ?? []), ...(request.additional_frame_bindings ?? [])]);
  if (source?.sha256 !== analysis.source_video_sha256 || request.data.source_video_sha256 !== source.sha256
    || original.source_video_sha256 !== source.sha256 || !['sound_query_completion',soundQueryFieldProjectionStage].includes(request.stage))
    throw new Error('sound_completion_current_source_mismatch');
  if(request.stage===soundQueryFieldProjectionStage){
    if(request.data.query_field_projection?.revision!==soundQueryFieldProjectionRevision||request.frames?.length
      ||request.data.query_field_projection.original_event_and_intent_literals_changed!==false)
      throw Error('sound_completion_field_projection_contract_invalid');
    await verifyEvidenceBindings([request.data.catalogue?.libraries,request.data.query_field_projection.previous_repair_queues??[],
      request.data.bound_frame_references??[]]);
  }
  const catalogueTags=request.stage===soundQueryFieldProjectionStage?request.data.catalogue.allowed_excluded_tags:null;
  const pending = checkSoundQueryCoverage(analysis, original.direction ?? original,{catalogue_excluded_tags:catalogueTags}).completion_event_ids;
  const ids = request.data.events.map(row => row.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !pending.includes(id))
    || request.data.events.some(row => JSON.stringify(row) !== JSON.stringify(analysis.sound_events.find(event => event.id === row.id))))
    throw new Error('sound_completion_original_event_changed');
  const validateValue = value => validateSoundQueryCompletionValue(request,analysis,value);
  const input = { stage: request.stage, prompt: request.prompt, schema: request.schema, frames: request.frames,
    data: { ...request.data, source_video: source, original_request: config.request },
    input: config.request };
  await saveJson(path.join(config.output_dir, 'input.json'), input);
  const reply = typeof session.runRole === 'function' ? await session.runRole(request.stage, input, { validateValue })
    : typeof session.request === 'function' ? await session.request(request.stage, input, { validateValue })
    : await session.director(input, config.output_dir, { validateValue });
  const outcome=validateValue(reply.value);
  const raw = await readBound(reply.raw_response);
  if (raw.completion_status !== 'complete' && raw.status !== 'completed') throw new Error('sound_completion_actual_return_required');
  if (raw.value && JSON.stringify(raw.value) !== JSON.stringify(reply.value)) throw new Error('sound_completion_return_value_mismatch');
  if (raw.source_video_sha256 && raw.source_video_sha256 !== source.sha256) throw new Error('sound_completion_return_source_mismatch');
  if (raw.input_sha256 && raw.input_sha256 !== config.request.sha256) throw new Error('sound_completion_return_input_mismatch');
  await verifyEvidenceBindings([config.request, request.data.analysis, request.data.director, source]);
  return saveJson(path.join(config.output_dir, 'result.json'), { schema_version: 1,
    status: outcome.pending_retrieval_gaps.length?'query_intent_recorded_with_explicit_retrieval_gaps':'query_intent_completed_sound_selection_still_pending',
    ...outcome,request: config.request,
    analysis: request.data.analysis, original_director: request.data.director, source,
    event_ids: ids, value: reply.value, raw_response: reply.raw_response, cli_receipts: reply.cli_receipts ?? [],
    usage: reply.usage ?? null, actual_input_reviewed: raw.actual_input_processed === true,
    actual_runtime_executed: raw.actual_runtime_executed === true
      || reply.finish_reason === 'complete' && raw.status === 'completed' && raw.id === reply.request_id,
    actual_audio_processed: false, original_sound_audit: 'pending', missing_sound_confirmed: false,
    independent_listening_performed: false, production_approval: false });
}

export async function mergeSoundQueryCompletions({ queue, results, output_dir }) {
  const pending = await readBound(queue), original = await readBound(pending.director), analysis = await readBound(pending.analysis);
  const direction = original.direction ?? original, additions = [], uncertainties = [], executions = [],repairIds=new Set();
  for (const reference of results) {
    const result = await readBound(reference);
    if (result.analysis.sha256 !== pending.analysis.sha256 || result.original_director.sha256 !== pending.director.sha256
      || !pending.requests.some(row => row.sha256 === result.request.sha256)) throw new Error('sound_completion_merge_identity_mismatch');
    const request = await readBound(result.request);
    const outcome=validateSoundQueryCompletionValue(request,analysis,result.value);
    if(outcome.pending_retrieval_gaps.length&&result.outcome_revision!==soundQueryOutcomeRevision)
      throw Error('sound_completion_merge_unbound_pending_outcome');
    for(const id of request.data.query_repair_event_ids??[]){
      const prior=request.data.existing_sound_queries.find(query=>query.event_id===id),next=result.value.sound_queries.find(query=>query.event_id===id);
      if(!prior||next?.text!==prior.text||next?.asset_kind!==prior.asset_kind)throw Error('sound_completion_repair_must_preserve_original_intent');
      if(request.stage===soundQueryFieldProjectionStage&&JSON.stringify(next.filters)!==JSON.stringify(prior.filters))
        throw Error('sound_completion_field_repair_must_preserve_original_filters');
      repairIds.add(id);
    }
    const raw = await readBound(result.raw_response);
    if (raw.value && JSON.stringify(raw.value) !== JSON.stringify(result.value)) throw new Error('sound_completion_return_value_mismatch');
    if (raw.input_sha256 && raw.input_sha256 !== result.request.sha256) throw new Error('sound_completion_return_input_mismatch');
    additions.push(...result.value.sound_queries); uncertainties.push(...result.value.uncertainties); executions.push(result.actual_runtime_executed);
  }
  const byId=new Map(additions.map(query=>[query.event_id,query]));
  const derived = { ...direction, sound_queries: [...direction.sound_queries.map(query=>repairIds.has(query.event_id)?byId.get(query.event_id):query),
    ...additions.filter(query=>!repairIds.has(query.event_id))],
    uncertainties: [...(direction.uncertainties??[]), ...uncertainties] };
  const coverage = checkSoundQueryCoverage(analysis, derived);
  const director = await saveJson(path.join(output_dir, 'director.json'), derived);
  return saveJson(path.join(output_dir, 'handoff.json'), { schema_version: 1, original_director: pending.director,
    analysis: pending.analysis, source_video_sha256: analysis.source_video_sha256, completion_queue: queue,
    completion_results: results, derived_director: director, coverage,
    status: coverage.retrieval_complete ? 'query_coverage_complete_actual_materials_and_original_audit_pending' : 'query_coverage_partial',
    actual_runtime_execution_count: executions.filter(Boolean).length, actual_audio_processed: false,
    original_event_decisions_changed: false, original_sound_audit: 'pending', production_approval: false });
}
