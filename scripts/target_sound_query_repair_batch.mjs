import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,saveJson,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {normalizeSoundRetrievalQuery,isExactSoundExclusionTag} from './sound_retrieval_contract.mjs';
import {writeSoundQueryCompletionRequests,soundQueryFieldProjectionRevision} from './sound_query_contract.mjs';
import {completeSoundQueryRequest,mergeSoundQueryCompletions} from './sound_query_completion.mjs';
import {loadCompletedSoundQueryBatch} from './completed_sound_query_batch.mjs';
import {recoverSameJobCompletedMaterial} from './same_job_material_recovery.mjs';

const run=promisify(execFile),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bound=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const existing=async file=>{try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const catalogues=new Map();
export function observedPoolExclusionIntentContext(direction,catalogue){
  return {revision:'observed-candidates-final-assembly-v1',catalogue,
    queries:(direction.sound_queries??[]).map(query=>({event_id:query.event_id,
      excluded_tags:structuredClone(query.excluded_tags??[]),
      matched_metadata_labels:(query.excluded_tags??[]).filter(tag=>catalogue?.allowed_excluded_tags.includes(tag)),
      unmatched_exclusion_intents:(query.excluded_tags??[]).filter(tag=>!catalogue?.allowed_excluded_tags.includes(tag)),
      original_intent:query.text,metadata_exclusion_does_not_verify_sound_or_safety:true,
      narrative_conflicts_still_require_observed_assembly_comparison:true,qualification_granted:false}))};
}
const catalogueCode=`import json,sqlite3,sys,re
from pathlib import Path
db=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
try:
 records=[json.loads(r[0]) for r in db.execute('SELECT record_json FROM assets UNION ALL SELECT record_json FROM segments')]
 labels=set(r[0] for r in db.execute('SELECT DISTINCT function FROM functions'))
 for record in records:
  for key in ('tags','narrative_functions','substyles','timbre'):
   values=record.get(key,[])
   if isinstance(values,list): labels.update(v for v in values if isinstance(v,str))
 titles=sorted(set(r.get('title','') for r in records if isinstance(r.get('title'),str) and r['title']))
 print(json.dumps({'labels':sorted(labels),'publisher_title_examples':titles[:12]},ensure_ascii=False))
finally: db.close()
`;

// This is an inventory of frozen publisher/index metadata, not audio or use evidence.
export async function readSoundQueryCatalogue(library,python='python'){
  await verifyEvidenceBindings(library);
  const key=JSON.stringify([library,python]);let data=catalogues.get(key);
  if(!data){
    const {stdout}=await run(python,['-X','utf8','-c',catalogueCode,library.path],
      {windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
    const found=JSON.parse(stdout);
    if(!Array.isArray(found.labels)||found.labels.length>5000||found.labels.some(row=>typeof row!=='string'))
      throw Error('sound_query_catalogue_inventory_invalid');
    const labels=found.labels.filter(row=>isExactSoundExclusionTag(row)
      &&!/不要|避免|不需要|不是|不用|\b(?:without|not|no)\b/i.test(row));
    data={libraries:[library],allowed_excluded_tags:labels,publisher_title_examples:found.publisher_title_examples,
      inventory_sha256:shaBytes(JSON.stringify(found)),scope:'exact_frozen_metadata_not_audio_or_usage_approval',
      qualification_granted:false,actual_audio_read:false};
    await verifyEvidenceBindings(library);catalogues.set(key,data);
  }
  return structuredClone(data);
}

// One query-only request for the eligible invalid queries. The write-before-submit
// marker prevents replay of an unknown return. Legacy capacity-only queues remain
// immutable parents; no old accounting, stage success, event or intent is reset.
export async function repairTargetSoundQueryBatch({analysisBinding,directionBinding,source,frames=[],libraryBinding,
  python='python',session,outputDir,legacyRepairDirectory,completedRecovery,semanticRetrievalMode,
  sameJobCompletedMaterialRecovery,runtime={},assemblyCandidatePoolContract}){
  if(assemblyCandidatePoolContract!==undefined&&assemblyCandidatePoolContract!=='observed-candidates-final-assembly-v1')
    throw Error('target_sfx_observed_pool_contract_invalid');
  await verifyEvidenceBindings([analysisBinding,directionBinding,source,frames,libraryBinding]);
  const analysis=await readJson(analysisBinding.path),encoded=await readJson(directionBinding.path),direction=encoded.direction??encoded;
  if(analysis.source_video_sha256!==source.sha256||direction.source_video_sha256!==source.sha256)
    throw Error('target_sfx_query_batch_source_mismatch');
  const catalogue=libraryBinding?await readSoundQueryCatalogue(libraryBinding,python):null;
  if(semanticRetrievalMode!==undefined){
    if(semanticRetrievalMode!=='resident_sfx_clap'||!catalogue)throw Error('target_sfx_semantic_mode_invalid');
    catalogue.semantic_retrieval_mode=semanticRetrievalMode;
  }
  const events=(analysis.sound_events??[]).filter(event=>event.decision==='seek_asset'&&['dramatic','transition'].includes(event.role)
    &&direction.sound_queries?.some(query=>query.event_id===event.id&&query.asset_kind==='sfx'
      &&(!normalizeSoundRetrievalQuery(query,event).ready||!assemblyCandidatePoolContract&&catalogue&&Array.isArray(query.excluded_tags)
        &&query.excluded_tags.some(tag=>!catalogue.allowed_excluded_tags.includes(tag)))));
  const originalQueries=events.map(event=>direction.sound_queries.find(query=>query.event_id===event.id));
  const record={revision:soundQueryFieldProjectionRevision,source,analysis:analysisBinding,original_director:directionBinding,
    event_ids:events.map(event=>event.id),original_intents:originalQueries.map(query=>({event_id:query.event_id,text:query.text})),
    status:events.length?'query_repair_pending':'no_invalid_eligible_sound_queries',model_execution_attempted:false,
    actual_audio_processed:false,original_events_changed:false,qualification_granted:false,production_approval:false};
  if(assemblyCandidatePoolContract)record.exclusion_intent_context=observedPoolExclusionIntentContext(direction,catalogue);
  const finish=async()=>{
    const file=path.join(outputDir,`batch-status-${shaBytes(JSON.stringify(record))}.json`),prior=await existing(file);
    if(prior&&!same(prior,record))throw Error('target_sfx_query_batch_status_changed');
    return {...record,artifact:prior?await bound(file):await saveJson(file,record)};
  };
  if(!events.length)return finish();
  if(events.length>12){record.status='query_repair_scope_exceeds_one_request';return finish();}
  if(!libraryBinding){record.status='query_repair_frozen_catalogue_missing';return finish();}
  if(!completedRecovery&&sameJobCompletedMaterialRecovery){
    const automatic=await recoverSameJobCompletedMaterial(sameJobCompletedMaterialRecovery,{kind:'sound_query',source,session,runtime,
      loadCompleted:binding=>loadCompletedSoundQueryBatch(binding,{source,analysisBinding,directionBinding,catalogue,events,queries:originalQueries})});
    record.same_job_completed_query_admission=await saveJson(path.join(outputDir,'same-job-completed-query-admission.json'),automatic.audit);
    if(automatic.recovered){
      Object.assign(record,automatic.recovered,{original_director:directionBinding,analysis:analysisBinding,source,
        same_job_completed_query_admission:record.same_job_completed_query_admission,
        completed_recovery:automatic.binding,model_execution_attempted:false,new_model_calls:0});
      delete record.artifact;return finish();
    }
    if(automatic.audit.unreconciled_attempts?.length){
      record.status='query_repair_prior_outcome_requires_reconciliation';
      record.replay_prevented=true;return finish();
    }
  }
  if(completedRecovery){
    const recovered=await loadCompletedSoundQueryBatch(completedRecovery,{source,analysisBinding,directionBinding,catalogue,events,queries:originalQueries});
    Object.assign(record,recovered,{original_director:directionBinding,analysis:analysisBinding,source,
      completed_recovery:completedRecovery,model_execution_attempted:false,new_model_calls:0});
    delete record.artifact;return finish();
  }
  const previous=[];
  for(const event of events){
    if(!legacyRepairDirectory)continue;
    const directory=path.join(legacyRepairDirectory,encodeURIComponent(event.id)),queueFile=path.join(directory,'completion-queue.json');
    const queue=await existing(queueFile);if(!queue)continue;
    await verifyEvidenceBindings([queue.analysis,queue.director,queue.requests]);
    if(queue.analysis.sha256!==analysisBinding.sha256||queue.director.sha256!==directionBinding.sha256
      ||queue.source_video_sha256!==source.sha256||queue.requests.length!==1)throw Error('target_sfx_query_batch_legacy_binding_changed');
    const originalRequest=await readJson(queue.requests[0].path),originalQuery=originalQueries.find(query=>query.event_id===event.id);
    if(!same(originalRequest.data.events,[event])||!same(originalRequest.data.existing_sound_queries,[originalQuery]))
      throw Error('target_sfx_query_batch_legacy_scope_changed');
    const marker=await existing(path.join(directory,'attempt-started.json'));
    if(marker){
      const failure=await existing(path.join(directory,'attempt-failure.json'));
      if(await existing(path.join(directory,'execution/result.json'))||!failure
        ||!/^codex_cli_complete_input_capacity_gap$/.test(failure.error??'')||failure.cli_receipts?.length){
        record.status='query_repair_prior_outcome_requires_reconciliation';record.blocked_event_id=event.id;
        return finish();
      }
      await verifyEvidenceBindings([marker.request,marker.source,failure.attempt_started]);
      if(marker.source.sha256!==source.sha256||!queue.requests.some(ref=>ref.sha256===marker.request.sha256))
        throw Error('target_sfx_query_batch_legacy_binding_changed');
    }
    previous.push(await bound(queueFile));
  }
  const queueFile=path.join(outputDir,'completion-queue.json');
  let document=await existing(queueFile),queue;
  if(document){
    queue=await bound(queueFile);await verifyEvidenceBindings([document.analysis,document.director,document.requests]);
    if(document.analysis.sha256!==analysisBinding.sha256||document.director.sha256!==directionBinding.sha256
      ||document.source_video_sha256!==source.sha256||document.requests.length!==1)
      throw Error('target_sfx_query_batch_binding_changed');
    const request=await readJson(document.requests[0].path);
    if(!same(request.data.events,events)||!same(request.data.existing_sound_queries,originalQueries)
      ||!same(request.data.catalogue,catalogue)||!same(request.data.query_field_projection?.previous_repair_queues,previous))
      throw Error('target_sfx_query_batch_scope_changed');
  }else{
    queue=await writeSoundQueryCompletionRequests({analysis:analysisBinding,director:directionBinding,frames,
      output_dir:outputDir,event_ids:record.event_ids,retrieval_contract_version:2,
      field_projection:soundQueryFieldProjectionRevision,catalogue,previous_repair_queues:previous});
    document=await readJson(queue.path);
    if(document.requests.length!==1)throw Error('target_sfx_query_batch_one_request_required');
  }
  record.queue=queue;record.previous_capacity_only_queues=previous;
  const executeDir=path.join(outputDir,'execution'),resultFile=path.join(executeDir,'result.json');
  let result,returned=await existing(resultFile);
  if(returned){
    result=await bound(resultFile);await verifyEvidenceBindings([returned.request,returned.source,returned.analysis,returned.original_director,returned.raw_response]);
    if(returned.request.sha256!==document.requests[0].sha256||returned.source.sha256!==source.sha256
      ||returned.analysis.sha256!==analysisBinding.sha256||returned.original_director.sha256!==directionBinding.sha256)
      throw Error('target_sfx_query_batch_binding_changed');
    record.reused_bound_completion=true;
  }else{
    const marker=await existing(path.join(outputDir,'attempt-started.json'));
    if(marker){
      if(marker.request.sha256!==document.requests[0].sha256||marker.source.sha256!==source.sha256)
        throw Error('target_sfx_query_batch_binding_changed');
      record.status='query_repair_failed_or_pending';record.replay_prevented=true;return finish();
    }
    if(!session||!['runRole','request','director'].some(key=>typeof session[key]==='function'))return finish();
    const markerBinding=await saveJson(path.join(outputDir,'attempt-started.json'),{request:document.requests[0],source,
      started_at:new Date().toISOString(),status:'submitted_outcome_pending',qualification_granted:false});
    record.model_execution_attempted=true;record.attempt_started=markerBinding;
    try{result=await completeSoundQueryRequest({request:document.requests[0],source,output_dir:executeDir},session);}
    catch(error){
      record.error=error.message;record.status='query_repair_failed_or_pending';
      await saveJson(path.join(outputDir,'attempt-failure.json'),{attempt_started:markerBinding,error:error.message,
        cli_receipts:error.cli_receipts??[],status:'failed_or_outcome_unknown',qualification_granted:false});
      if(/binding_changed|source_mismatch|scope_changed/.test(error.message??''))throw error;
      return finish();
    }
  }
  const handoffFile=path.join(outputDir,'merged/handoff.json'),old=await existing(handoffFile);
  const handoff=old?await bound(handoffFile):await mergeSoundQueryCompletions({queue,results:[result],output_dir:path.join(outputDir,'merged')});
  const merged=await readJson(handoff.path);await verifyEvidenceBindings([merged.derived_director,merged.completion_results]);
  if(merged.completion_queue.sha256!==queue.sha256||!same(merged.completion_results,[result]))throw Error('target_sfx_query_batch_binding_changed');
  record.status=merged.coverage.retrieval_complete?'query_projection_completed_materials_still_pending'
    :'query_projection_recorded_with_explicit_retrieval_gaps';record.result=result;record.handoff=handoff;
  if(!merged.coverage.retrieval_complete){
    const returned=await readJson(result.path);
    record.pending_retrieval_gaps=returned.pending_retrieval_gaps;record.outcome_revision=returned.outcome_revision;
    record.historical_cli_receipts=returned.cli_receipts;
  }
  record.derived_director=merged.derived_director;return finish();
}
