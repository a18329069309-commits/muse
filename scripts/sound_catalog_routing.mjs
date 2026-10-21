import path from 'node:path';
import {readJson,saveJson,verifyEvidenceBindings} from './audio_api.mjs';

export const soundCatalogRoutingRevision='event-role-sound-catalog-v1';
const roles=new Set(['physical','foley','dramatic','transition','ambience']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Asset kind is the catalog partition. A dramatic sustained bed remains SFX;
// it does not become a claimed environmental sound because it is continuous.
// This host routing changes no audio fact, intent, event, timing or selection.
export function routeSoundCatalogKinds(analysis,direction){
 if(!analysis.source_video_sha256||direction.source_video_sha256!==analysis.source_video_sha256)
  throw Error('sound_catalog_routing_source_mismatch');
 const events=new Map((analysis.sound_events??[]).map(event=>[event.id,event]));
 if(events.size!==(analysis.sound_events??[]).length)throw Error('sound_catalog_routing_duplicate_event');
 const result=structuredClone(direction),changes=[],seen=new Set();
 for(const query of result.sound_queries??[]){
  const event=events.get(query.event_id);
  if(!event||seen.has(query.event_id)||event.decision!=='seek_asset'||!roles.has(event.role)
    ||!['sfx','ambience'].includes(query.asset_kind))throw Error('sound_catalog_routing_bound_event_required');
  seen.add(query.event_id);
  const required=event.role==='ambience'?'ambience':'sfx';
  if(query.asset_kind!==required){changes.push({event_id:event.id,role:event.role,
   original_asset_kind:query.asset_kind,catalog_asset_kind:required});query.asset_kind=required;}
 }
 for(const query of result.sound_queries??[]){
  const prior=direction.sound_queries.find(item=>item.event_id===query.event_id);
  const {asset_kind:oldKind,...oldFields}=prior,{asset_kind:newKind,...newFields}=query;
  if(!same(oldFields,newFields))throw Error('sound_catalog_routing_intent_changed');
 }
 return{direction:result,changes};
}

export async function prepareBoundSoundCatalogRouting({analysisBinding,directionBinding,source,outputDir,revision}){
 if(revision!==soundCatalogRoutingRevision)throw Error('sound_catalog_routing_revision_invalid');
 await verifyEvidenceBindings([analysisBinding,directionBinding,source]);
 const analysis=await readJson(analysisBinding.path),original=await readJson(directionBinding.path);
 const direction=original.direction??original;
 if(source.sha256!==analysis.source_video_sha256)throw Error('sound_catalog_routing_source_mismatch');
 const routed=routeSoundCatalogKinds(analysis,direction);
 const derived=routed.changes.length?await saveJson(path.join(outputDir,'director.json'),routed.direction):directionBinding;
 const record={revision,source,analysis:analysisBinding,original_director:directionBinding,derived_director:derived,
  changes:routed.changes,scope:'catalog_partition_only_from_bound_event_role',original_events_changed:false,
  sound_intent_changed:false,model_calls:0,actual_audio_processed:false,original_sound_fact_approval:false,
  qualification_granted:false,artistic_approval:false,production_approval:false};
 return{...record,artifact:await saveJson(path.join(outputDir,'routing-record.json'),record)};
}
