import path from 'node:path';
import { readJson, saveJson, verifyEvidenceBindings, objectSchema } from './audio_api.mjs';
import { auditSoundQueries } from './sound_consumption.mjs';
import {normalizeSoundRetrievalQuery,soundQueryItemSchema,soundQueryItemV2Schema,soundRetrievalInstructionFor,soundQuerySchemaForCatalog} from './sound_retrieval_contract.mjs';

export const soundQueryFieldProjectionRevision='sound_query_field_projection_v1';
export const soundQueryFieldProjectionStage='sound_query_completion_fields_v1';

export const soundQueryInstruction = '每个analysis.sound_events中decision=seek_asset的事件必须交一项独立sound_queries，event_id精确对应该事件。'
  + '查询是待比较素材意图，不表示原声缺失、确定新增、精确起音或已通过听审；原声未知不允许静默省略查询。'
  + 'ambience事件使用ambience类别，物理/剧情重音/情绪/转场保留各自意图，不能统一填whoosh。'
  + '无法制定具体声音意图时在uncertainties说明缺什么；不要虚构声音或改动原事件来填数。';

export function checkSoundQueryCoverage(analysis, direction, {catalogue_excluded_tags=null}={}) {
  if(catalogue_excluded_tags!==null&&(!Array.isArray(catalogue_excluded_tags)||catalogue_excluded_tags.some(tag=>typeof tag!=='string')))
    throw Error('sound_query_catalogue_exclusions_invalid');
  const rows = auditSoundQueries(analysis, { ...direction, source_video_sha256: direction.source_video_sha256 ?? analysis.source_video_sha256 });
  const missing = rows.filter(row => row.state === 'missing_explicit_sound_query').map(row => row.event_id);
  const repairs=rows.filter(row=>row.query&&(!normalizeSoundRetrievalQuery(row.query,
    analysis.sound_events.find(event=>event.id===row.event_id)).ready
    ||catalogue_excluded_tags!==null&&Array.isArray(row.query.excluded_tags)
      &&row.query.excluded_tags.some(tag=>!catalogue_excluded_tags.includes(tag)))).map(row=>row.event_id);
  return { complete: missing.length === 0, missing_event_ids: missing,
    retrieval_complete:missing.length===0&&repairs.length===0,completion_event_ids:[...missing,...repairs],
    missing_explicit_event_ids:missing,query_repair_required_event_ids:repairs,
    seek_asset_count: rows.filter(row => row.decision === 'seek_asset').length,
    query_count: rows.filter(row => row.query).length, formal_sound_design_complete: false };
}

// Partial replies must reach the resumable coverage check instead of failing structural validation first.
export function withSoundQueryCoverageSchema(schema, analysis, {retrieval_contract_version=1,catalogue_excluded_tags=null}={}) {
  const result = structuredClone(schema), ids = analysis.sound_events.filter(row => row.decision === 'seek_asset').map(row => row.id);
  if(![1,2].includes(retrieval_contract_version))throw Error('sound_query_contract_version_invalid');
  if(catalogue_excluded_tags!==null&&retrieval_contract_version!==2)throw Error('sound_query_catalogue_schema_requires_v2');
  if(retrieval_contract_version===2)result.properties.sound_queries.items=catalogue_excluded_tags===null
    ?structuredClone(soundQueryItemV2Schema):soundQuerySchemaForCatalog(catalogue_excluded_tags);
  result.properties.sound_queries.minItems = 0;
  result.properties.sound_queries.maxItems = ids.length;
  if (ids.length) result.properties.sound_queries.items.properties.event_id = { type: 'string', enum: ids };
  return result;
}

export async function writeSoundQueryCompletionRequests({ analysis, director, frames = [], output_dir, event_ids, retrieval_contract_version=1,
  field_projection=null, catalogue=null, previous_repair_queues=[] }) {
  if(field_projection!==null&&field_projection!==soundQueryFieldProjectionRevision)throw Error('sound_query_field_projection_revision_invalid');
  if(field_projection&&(!catalogue?.libraries?.length||!Array.isArray(catalogue.allowed_excluded_tags)))
    throw Error('sound_query_field_projection_bound_catalogue_required');
  if (!analysis?.path || !analysis.sha256 || !director?.path || !director.sha256)
    throw new Error('sound_completion_bound_inputs_required');
  await verifyEvidenceBindings(analysis); await verifyEvidenceBindings(director);
  const observed = await readJson(analysis.path), document = await readJson(director.path);
  if (document.source_video_sha256 !== observed.source_video_sha256) throw new Error('sound_completion_source_mismatch');
  const direction = document.direction ?? document, coverage = checkSoundQueryCoverage(observed, direction,
    {catalogue_excluded_tags:field_projection?catalogue.allowed_excluded_tags:null});
  if(event_ids&&(!Array.isArray(event_ids)||event_ids.some(id=>!coverage.completion_event_ids.includes(id))))
    throw Error('sound_completion_scope_requires_missing_or_invalid_query');
  const missing = observed.sound_events.filter(row => coverage.completion_event_ids.includes(row.id)&&(!event_ids||event_ids.includes(row.id)));
  const requests = [], batches = [];
  for (const event of missing) {
    const previous = batches.at(-1), combinedIds = new Set([...(previous ?? []), event].flatMap(row => row.evidence_ids));
    if (previous && previous.length < 12 && (field_projection||combinedIds.size <= 8)) previous.push(event);
    else batches.push([event]);
  }
  for (const events of batches) {
    const ids = new Set(events.flatMap(row => row.evidence_ids));
    const allFrames = frames.filter(row => ids.has(row.id)), selectedFrames = allFrames.slice(0, 8);
    await verifyEvidenceBindings(selectedFrames);
    const repairing=events.some(event=>coverage.query_repair_required_event_ids.includes(event.id));
    const item=field_projection?soundQuerySchemaForCatalog(catalogue.allowed_excluded_tags)
      :structuredClone(repairing||retrieval_contract_version===2?soundQueryItemV2Schema:soundQueryItemSchema);
    item.properties.event_id={type:'string',enum:events.map(row=>row.id)};
    const schema = objectSchema({ sound_queries: { type: 'array', minItems: events.length, maxItems: events.length,
      items:item }, uncertainties: { type: 'array', items: { type: 'string' } } });
    requests.push(await saveJson(path.join(output_dir, `request-${String(requests.length + 1).padStart(3, '0')}.json`), {
      schema_version: 1, stage: field_projection?soundQueryFieldProjectionStage:'sound_query_completion', status: 'pending_not_executed',
      prompt: soundQueryInstruction + soundRetrievalInstructionFor({data:{catalogue}})+'本次只补所列事件，不重做音乐导演，不执行素材采纳。'
        +(repairing?'已有query的event_id/text/asset_kind逐字保持，仅补正向retrieval_query、excluded_tags和filters；不许删除原否定意图。':'')
        +(field_projection?'本次为已完成导演的检索字段修复，不重新看画面或判断原声音。只修retrieval_query和excluded_tags；filters原样保留，不改bed/transient或长度限制。仅从catalogue.allowed_excluded_tags选精确标签；不能把短语改成猜测的下划线标签。无法映射的禁用情境仍完整保存在text，并明确excluded_tags:[]。所有事件的role、时钟、reason和evidence_ids由宿主固定，不返回也不改动。':''), schema,
      data: { source_video_sha256: observed.source_video_sha256, analysis, director, events,
        original_sound_audit: 'not_certified_by_query_stage', binding_references_accepted_by_this_contract: false,
        query_repair_event_ids:events.filter(event=>coverage.query_repair_required_event_ids.includes(event.id)).map(event=>event.id),
        existing_sound_queries:direction.sound_queries.filter(query=>events.some(event=>event.id===query.event_id)),
        ...(field_projection?{query_field_projection:{revision:field_projection,previous_repair_queues,
          frame_observation_repeated:false,original_event_and_intent_literals_changed:false},catalogue,
          bound_frame_references:allFrames}:{} ) },
      frames: field_projection?[]:selectedFrames, missing_frame_ids: [...ids].filter(id => !allFrames.some(row => row.id === id)),
      additional_frame_bindings: field_projection?allFrames:allFrames.slice(8),
      actual_runtime_executed: false, production_approval: false,
    }));
  }
  return saveJson(path.join(output_dir, 'completion-queue.json'), { schema_version: 1, analysis, director,
    source_video_sha256: observed.source_video_sha256, coverage, requests,
    status: requests.length ? 'pending_sound_query_completion' : 'queries_covered_still_requires_original_audit_and_selection',
    actual_runtime_executed: false, music_diagnostic_allowed: true, formal_full_sound_output_allowed: false,
    scope: 'Resumable query-only work packages, not completed sound selection or sound design.' });
}
