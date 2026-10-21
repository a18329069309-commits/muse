import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,saveJson,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {createIndependentPackRetriever} from './independent_pack_clap_retriever.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),run=promisify(execFile);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const claimsApproval=value=>['qualified','qualification_granted','sound_facts_qualified','cleanliness_approved',
  'usage_approved','artistic_approval','professional_audio_review_qualified'].some(key=>value?.[key]===true);
const load=async binding=>{await verifyEvidenceBindings(binding);return readJson(binding.path);};
const binding=async p=>({path:path.resolve(p),sha256:await hashFile(p)});
const positive=value=>typeof value==='string'&&Boolean(value.trim())&&value.length<=1000
  &&!/不要|避免|不需要|不是|不用|不添加|不预设|不叠加|禁止|\b(?:without|not|no)\b/i.test(value);
export const sfxSemanticRetrievalRevision='frozen-sfx-semantic-candidates-v1';

// Reuse the existing resident CLAP worker; this wrapper establishes the sound
// publication, exact editable ranges and asset kinds before semantic ranking.
export async function createSfxClapRetriever(config,{libraryBinding,residentFactory=createIndependentPackRetriever}={}){
  if(config?.kind!=='resident_sfx_clap'||!config.snapshot||!config.weights||!config.python)
    throw Error('sfx_clap_config_required');
  const snapshot=await load(config.snapshot);
  if(snapshot.kind!=='frozen_sfx_clap_snapshot_v1'||snapshot.revision!=='frozen-sfx-clap-representatives-v1'
    ||snapshot.sound_facts_qualified!==false||snapshot.cleanliness_approved!==false
    ||snapshot.usage_approved!==false||snapshot.artistic_approval!==false||snapshot.whole_window_sound_facts!==false
    ||snapshot.professional_audio_review_qualified!==false)
    throw Error('sfx_clap_diagnostic_snapshot_required');
  const publication=await load(snapshot.sound_publication);
  if(publication.kind!=='diagnostic_sound_library'||publication.professional_audio_review_qualified!==false
    ||publication.human_audition_performed!==false||!same(snapshot.library,publication.library)
    ||libraryBinding&&(libraryBinding.sha256!==publication.library.sha256
      ||path.resolve(libraryBinding.path)!==path.resolve(publication.library.path)))
    throw Error('sfx_clap_sound_publication_or_library_changed');
  await verifyEvidenceBindings([publication.library,publication.assets,publication.segments]);
  const assets=(await readJson(publication.assets.path)).assets,
    segments=(await readJson(publication.segments.path)).segments;
  const byAsset=new Map(assets.map(a=>[a.asset_id,a])),bySegment=new Map(segments.map(s=>[s.segment_id,s]));
  if(byAsset.size!==assets.length||bySegment.size!==segments.length)throw Error('sfx_clap_original_identity_ambiguous');
  const sourceMap=await load(snapshot.source_mapping),indexSnapshot=await load(snapshot.index_snapshot);
  if(sourceMap.kind!=='diagnostic_sound_clap_mapping_source'||claimsApproval(sourceMap)
    ||!same(sourceMap.sound_publication,snapshot.sound_publication)||!same(sourceMap.library,publication.library)
    ||!same(indexSnapshot.music_publication,snapshot.source_mapping))throw Error('sfx_clap_source_map_changed');
  const mapping=await load(indexSnapshot.mapping),windows=new Map();
  for(const w of sourceMap.windows??[]){
    const s=bySegment.get(w.segment_id),a=byAsset.get(w.asset_id);
    if(!s||!a||windows.has(w.segment_id)||!['sfx','ambience','ambient'].includes(a.asset_kind)
      ||s.asset_id!==w.asset_id||s.source_sha256!==w.source_sha256||a.source_sha256!==w.source_sha256
      ||!same(s.source_range,w.source_range)||a.full_decode_verified!==true||a.production_approval!==false
      ||a.recording_family_id!==w.recording_family_id
      ||path.resolve(a.local_path??a.path)!==path.resolve(w.local_path??w.path))
      throw Error('sfx_clap_original_window_or_sha_changed');
    windows.set(w.segment_id,w);
  }
  if(windows.size!==segments.length||mapping.records?.length!==windows.size
    ||mapping.records.some(w=>!windows.has(w.segment_id)))throw Error('sfx_clap_source_map_incomplete');
  const resident=await residentFactory({...config,kind:'resident_clap',snapshot:snapshot.index_snapshot,device:'cpu'});
  const helper=await binding(path.join(here,'sound_clap_candidate_scope.py')),
    implementation=await binding(fileURLToPath(import.meta.url));
  let closed=false;
  return {snapshot:config.snapshot,revision:sfxSemanticRetrievalRevision,
    async retrieve(query,outputDir){
      if(closed)throw Error('sfx_clap_adapter_closed');
      if(!positive(query?.text)||![20,50].includes(query.limit)||!['sfx','ambience'].includes(query.asset_kind))
        throw Error('sfx_clap_positive_bounded_sound_query_required');
      await verifyEvidenceBindings([publication.library,config.snapshot,helper,implementation]);
      const {stdout}=await run(config.python,['-X','utf8',helper.path,'--library',publication.library.path,
        '--query',JSON.stringify(query),'--indexed-ids',JSON.stringify([...windows.keys()])],
        {windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024});
      const scope=JSON.parse(stdout);
      if(scope.kind!=='exact_sound_semantic_scope'||scope.scope_filtered_before_limit!==true
        ||scope.audio_files_read!==0||scope.qualification_granted!==false||!Array.isArray(scope.candidates))
        throw Error('sfx_clap_exact_scope_evidence_required');
      const allowed=new Set();
      for(const c of scope.candidates){
        const w=windows.get(c.segment_id);
        if(!w||allowed.has(c.segment_id)||c.asset_id!==w.asset_id||c.source_sha256!==w.source_sha256
          ||!same(c.source_range,w.source_range))throw Error('sfx_clap_eligible_window_or_sha_changed');
        allowed.add(c.segment_id);
      }
      const candidate_scope=scope.candidates.map(c=>({segment_id:c.segment_id,asset_id:c.asset_id,
        source_sha256:c.source_sha256,source_range:c.source_range}));
      const result=await resident.retrieve({text:query.text,semantic_query_text:query.text,
        candidate_scope,limit:query.limit},outputDir);
      if(result.scope_filtered_before_limit!==true||!Array.isArray(result.candidates)||result.artistic_approval!==false
        ||claimsApproval(result)
        ||result.candidates.length>query.limit)throw Error('sfx_clap_candidate_scope_proof_required');
      for(const hit of result.candidates){
        const w=windows.get(hit.segment_id);
        if(!w||!allowed.has(hit.segment_id)||hit.source_sha256!==w.source_sha256||hit.asset_id!==w.asset_id
          ||!same(hit.source_range,w.source_range)||hit.whole_window_encoded!==false||claimsApproval(hit))
          throw Error('sfx_clap_ranked_window_identity_changed');
      }
      await verifyEvidenceBindings([publication.library,config.snapshot,helper,implementation]);
      const receipt={...result,revision:sfxSemanticRetrievalRevision,sfx_snapshot:config.snapshot,
        sound_publication:snapshot.sound_publication,library:publication.library,query,
        scope_filters:scope.query_filters,eligible_windows:candidate_scope.length,
        score_type:'audio_text_cosine_not_sound_fact_scene_fit_cleanliness_or_quality',
        helper,implementation,model_descriptor_is_not_metadata_factual_label:true,
        qualification_granted:false,sound_facts_qualified:false,cleanliness_approved:false,usage_approved:false,
        whole_window_sound_facts:false,actual_audio_listened:false};
      if(outputDir)receipt.artifact=await saveJson(path.join(outputDir,'sfx-semantic-recall.json'),receipt);
      return receipt;
    },close(){closed=true;resident.close();}};
}

// A null repair answer remains a gap. Do not turn the negative/full scene intent
// into an embedding query or delete its original restrictions.
export async function resolveSfxSemanticCandidates({projected,query,libraryBinding,directorBinding,retrieve,outputDir}){
  if(!projected?.ready||projected.retrieval?.asset_kind!=='sfx'||typeof retrieve!=='function')return projected;
  if(!positive(query?.retrieval_query))return {...projected,sound_semantic_recall:{
    revision:sfxSemanticRetrievalRevision,status:'explicit_positive_semantic_descriptor_not_provided',
    qualification_granted:false,original_intent:projected.original_intent}};
  await verifyEvidenceBindings([libraryBinding,directorBinding]);
  if(directorBinding){
    const encoded=await readJson(directorBinding.path),director=encoded.direction??encoded;
    if(!same(director.sound_queries?.find(q=>q.event_id===query.event_id),query))
      throw Error('sfx_clap_bound_director_query_changed');
  }
  const retrieval={...projected.retrieval,text:query.retrieval_query};
  const result=await retrieve(retrieval,outputDir);
  if(!Array.isArray(result?.candidates)||claimsApproval(result))throw Error('sfx_clap_recall_proof_invalid');
  const ids=result.candidates.map(c=>c.segment_id);
  if(new Set(ids).size!==ids.length||ids.length>retrieval.limit||result.qualification_granted!==false
    ||result.candidates.some(c=>claimsApproval(c)||c.whole_window_encoded!==false)
    ||result.scope_filtered_before_limit!==true)throw Error('sfx_clap_recall_proof_invalid');
  const audit={revision:sfxSemanticRetrievalRevision,status:ids.length?'semantic_candidates_ranked':'no_eligible_semantic_candidates',
    positive_descriptor:query.retrieval_query,original_intent:projected.original_intent,
    original_filters_preserved:true,library:libraryBinding,snapshot:result.sfx_snapshot,
    evidence:result.artifact??null,eligible_windows:result.eligible_windows,candidate_count:ids.length,
    candidates:result.candidates,qualification_granted:false,whole_window_sound_facts:false,
    candidate_use_requires_actual_observation_and_comparison:true};
  return ids.length?{...projected,retrieval:{...projected.retrieval,text:'',candidate_segment_ids:ids},sound_semantic_recall:audit}
    :{...projected,sound_semantic_recall:audit};
}
