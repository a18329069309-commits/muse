import {readJson,verifyEvidenceBindings} from './audio_api.mjs';

// A recovery may translate a previously generated acoustic request. It selects
// no recording, source window, cue, language of song or editing timestamp.
export async function loadBoundQueryTranslations(binding,{sourceSha,director}){
  if(!binding)return new Map();
  await verifyEvidenceBindings(binding);
  const value=await readJson(binding.path);
  if(value.kind!=='bound_acoustic_query_language_correction' || value.schema_version!==1
    || value.source_video_sha256!==sourceSha || value.qualified!==false || value.production_approval!==false
    || value.song_or_timeline_preselection!==false || !Array.isArray(value.translations))
    throw Error('bound_query_translation_scope_invalid');
  await verifyEvidenceBindings(value.direction);
  const saved=await readJson(value.direction.path),old=saved.direction??saved;
  if((saved.source_video_sha256??old.source_video_sha256)!==sourceSha)
    throw Error('bound_query_translation_original_source_changed');
  const allowed=new Set(['task_id','original_query','english_acoustic_query']);
  const result=new Map();
  for(const row of value.translations){
    const parts=row.task_id?.split('/'),kind=parts?.at(-1),id=parts?.slice(0,-1).join('/');
    const cue=director.cues?.find(c=>c.cue_id===id),previous=old.cues?.find(c=>c.cue_id===id);
    const key=kind==='music'?'audio_retrieval_query':kind==='words'?'words_audio_retrieval_query':null;
    if(!key || !cue || !previous || result.has(row.task_id) || Object.keys(row).some(k=>!allowed.has(k))
      || cue[key]!==row.original_query || previous[key]!==row.original_query
      || typeof row.english_acoustic_query!=='string' || !row.english_acoustic_query.trim()
      || row.english_acoustic_query.length>1000)
      throw Error('bound_query_translation_original_request_changed');
    result.set(row.task_id,{text:row.english_acoustic_query,binding,original_query:row.original_query,
      provenance:'explicit_host_language_correction_only; auditory_and_artistic_approval_not_granted'});
  }
  return result;
}
