import path from 'node:path';
import {readJson,verifyEvidenceBindings} from './audio_api.mjs';
import {routeSoundCatalogKinds,soundCatalogRoutingRevision} from './sound_catalog_routing.mjs';
import {loadCompletedSoundQueryBatch} from './completed_sound_query_batch.mjs';
import {readSoundQueryCatalogue,observedPoolExclusionIntentContext} from './target_sound_query_repair_batch.mjs';
import {normalizeSoundRetrievalQuery} from './sound_retrieval_contract.mjs';

export const boundSfxDirectionProvenanceRevision='bound-sfx-retrieval-direction-chain-v1';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refSame=(a,b)=>a?.sha256===b?.sha256&&path.resolve(a?.path??'')===path.resolve(b?.path??'');
const load=async ref=>{await verifyEvidenceBindings(ref);return readJson(ref.path);};
const fail=reason=>{throw Error('assembly_sfx_direction_chain_'+reason);};

// A catalog/query derivative is a different, real file. It is never relabelled
// with the original director's SHA. Only the already bound material handoff can
// establish the narrow path from the editing director to the selection director.
export async function verifyAssemblySoundDirectionChain({source,analysisBinding,directorBinding,manifestBinding,
  poolBinding,currentMaterialsBinding,expectedProof}){
  const pool=await load(poolBinding);
  if(refSame(pool.direction,directorBinding)){
    if(expectedProof)fail('unexpected_derivation');
    return null;
  }
  await verifyEvidenceBindings([source,analysisBinding,directorBinding,manifestBinding,currentMaterialsBinding]);
  const analysis=await readJson(analysisBinding.path),original=await readJson(directorBinding.path),
    materials=await readJson(currentMaterialsBinding.path),sourceSha=source.sha256;
  if(pool.source_video_sha256!==sourceSha||pool.source?.sha256!==sourceSha
    ||!refSame(pool.analysis,analysisBinding)||!refSame(pool.manifest,manifestBinding)
    ||analysis.source_video_sha256!==sourceSha||(original.direction??original).source_video_sha256!==sourceSha
    ||materials.source_video_sha256!==sourceSha||!materials.material_sound_preparation)fail('current_bindings_required');
  const matches=[],visited=new Set();
  const walk=async(ref,depth=0)=>{
    if(depth>2||visited.size>=8)fail('preparation_scope_exceeded');
    const key=JSON.stringify(ref);if(visited.has(key))return;visited.add(key);
    const preparation=await load(ref);
    if(preparation.source_video_sha256!==sourceSha||preparation.production_approval!==false)fail('preparation_source_or_scope_changed');
    if(preparation.sounds?.some(row=>refSame(row.selection_record,poolBinding)))matches.push({binding:ref,preparation});
    for(const child of preparation.material_preparations??[])await walk(child,depth+1);
  };
  await walk(materials.material_sound_preparation);
  // A combined record may retain the same sound as its child. Require one
  // concrete leaf carrying the actual query/selection direction and handoff.
  const leaves=matches.filter(row=>!row.preparation.material_preparations?.length);
  if(leaves.length!==1)fail('unique_bound_preparation_required');
  const {binding:preparationBinding,preparation}=leaves[0];
  if(!refSame(preparation.direction,pool.direction)||!refSame(preparation.analysis,analysisBinding)
    ||!refSame(preparation.manifest,manifestBinding)||preparation.source?.sha256!==sourceSha
    ||!refSame(preparation.library,pool.library))fail('selection_preparation_changed');
  let cursor=directorBinding;const chain=[];
  if(preparation.catalog_routing){
    const routing=await load(preparation.catalog_routing);
    if(routing.revision!==soundCatalogRoutingRevision||!refSame(routing.original_director,cursor)
      ||!refSame(routing.analysis,analysisBinding)||routing.source?.sha256!==sourceSha
      ||routing.scope!=='catalog_partition_only_from_bound_event_role'||routing.model_calls!==0
      ||routing.original_events_changed!==false||routing.sound_intent_changed!==false
      ||routing.actual_audio_processed!==false||routing.original_sound_fact_approval!==false
      ||routing.qualification_granted!==false||routing.artistic_approval!==false||routing.production_approval!==false)
      fail('catalog_routing_scope_changed');
    await verifyEvidenceBindings([routing.original_director,routing.derived_director,routing.source,routing.analysis]);
    const old=await readJson(cursor.path),actual=await readJson(routing.derived_director.path),
      recomputed=routeSoundCatalogKinds(analysis,old.direction??old);
    if(!same(recomputed.changes,routing.changes)||!same(recomputed.direction,actual.direction??actual))fail('catalog_routing_value_changed');
    chain.push({kind:'catalog_partition',record:preparation.catalog_routing,original_director:cursor,
      derived_director:routing.derived_director});cursor=routing.derived_director;
  }
  if(preparation.query_repair_batch){
    const batch=preparation.query_repair_batch;
    if(!batch.artifact||!refSame(batch.original_director,cursor))fail('field_projection_parent_changed');
    const boundBatch=await load(batch.artifact);
    // The embedded preparation record must reproduce the immutable batch record;
    // its only additional field is that record's own binding.
    const embedded={...batch};delete embedded.artifact;
    if(!same(embedded,boundBatch))fail('field_projection_record_changed');
    if(!boundBatch.queue&&pool.assembly_sfx_pool_contract_revision==='observed-candidates-final-assembly-v1'){
      const prior=await readJson(cursor.path),direction=prior.direction??prior;
      if(boundBatch.status!=='no_invalid_eligible_sound_queries'||boundBatch.model_execution_attempted!==false
        ||!same(boundBatch.event_ids,[])||boundBatch.original_events_changed!==false
        ||boundBatch.production_approval!==false||!refSame(boundBatch.analysis,analysisBinding)
        ||boundBatch.source?.sha256!==sourceSha||!refSame(boundBatch.original_director,cursor)
        ||analysis.sound_events.filter(event=>event.decision==='seek_asset'&&['dramatic','transition'].includes(event.role))
          .some(event=>{const query=direction.sound_queries?.find(q=>q.event_id===event.id&&q.asset_kind==='sfx');
            return query&&!normalizeSoundRetrievalQuery(query,event).ready;}))fail('observed_pool_exclusion_scope_changed');
      const catalogue=await readSoundQueryCatalogue(pool.library,process.env.SDR_PYTHON??'python');
      if(boundBatch.exclusion_intent_context?.catalogue?.semantic_retrieval_mode!==undefined)
        catalogue.semantic_retrieval_mode=boundBatch.exclusion_intent_context.catalogue.semantic_retrieval_mode;
      if(!same(boundBatch.exclusion_intent_context,observedPoolExclusionIntentContext(direction,catalogue)))
        fail('observed_pool_exclusion_intent_changed');
    }else{
    const queue=await load(boundBatch.queue);
    if(queue.requests?.length!==1)fail('single_actual_field_request_required');
    const request=await load(queue.requests[0]),prior=await readJson(cursor.path),direction=prior.direction??prior;
    if(!refSame(request.data.analysis,analysisBinding)||!refSame(request.data.director,cursor)
      ||request.data.source_video_sha256!==sourceSha
      ||!same(request.data.events,request.data.events.map(row=>analysis.sound_events?.find(event=>event.id===row.id)))
      ||!same(request.data.existing_sound_queries,request.data.events.map(event=>direction.sound_queries?.find(row=>row.event_id===event.id)))
      ||!request.data.catalogue?.libraries?.some(ref=>refSame(ref,pool.library)))fail('field_projection_scope_changed');
    // This existing reader verifies the complete original request, real CLI turn,
    // compact schema, raw value, receipts, usage and exact derived director.
    const checked=await loadCompletedSoundQueryBatch(batch.artifact,{source,analysisBinding,directionBinding:cursor,
      catalogue:request.data.catalogue,events:request.data.events,queries:request.data.existing_sound_queries});
    chain.push({kind:'actual_query_field_projection',record:batch.artifact,handoff:checked.handoff,
      completion_queue:checked.queue,completion_result:checked.result,original_director:cursor,
      derived_director:checked.derived_director});cursor=checked.derived_director;
    }
  }
  if(!chain.length||!refSame(cursor,pool.direction))fail('unproven_selection_director');
  const proof={revision:boundSfxDirectionProvenanceRevision,source,analysis:analysisBinding,manifest:manifestBinding,
    original_director:directorBinding,selection_director:pool.direction,original_pool:poolBinding,
    current_materials:currentMaterialsBinding,material_sound_preparation:materials.material_sound_preparation,
    actual_preparation:preparationBinding,chain,original_events_roles_and_targets_changed:false,
    music_cues_and_actions_changed:false,new_model_calls:0,actual_audio_processed:false,
    qualification_granted:false,artistic_approval:false,production_approval:false};
  if(expectedProof&&!same(proof,expectedProof))fail('published_provenance_changed');
  return proof;
}
