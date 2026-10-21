import path from 'node:path';
import { open, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { completeSoundQueryRequest, mergeSoundQueryCompletions } from './sound_query_completion.mjs';
import { createCodexCliRuntime, createAccountAuthAdmission } from './codex_cli_runtime.mjs';
import { createAccountCliSchedule } from './account_cli_slots.mjs';

const bound = async file => ({path:path.resolve(file),sha256:await hashFile(file)});
const existsJson = async file => {try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
export const archiveGateReady = (status, ids) => ids.every(id => {
  const row=status.videos?.find(row=>row.id===id);
  return row?.status==='actual_whole_episode_music_diagnostic_rendered'&&row.preview?.path&&row.preview.sha256
    &&row.stem_archive?.path&&row.stem_archive.sha256;
});

export async function runSoundQueryCompletionQueue(config) {
  await verifyEvidenceBindings(config.completion_index);
  const index=await readJson(config.completion_index.path), ids=index.rows.map(row=>row.id);
  const local=path.resolve(config.state_dir);await mkdir(local,{recursive:true});
  const lockFile=path.join(local,'lock.json');let lock;
  try{lock=await open(lockFile,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=await readJson(lockFile);if(!Number.isInteger(owner.pid))throw new Error('sound_queue_unknown_lock');
    let alive=true;try{process.kill(owner.pid,0);}catch(failure){if(failure.code==='ESRCH')alive=false;else throw failure;}
    if(alive)throw new Error('sound_queue_already_running');
    await rename(lockFile,path.join(local,`stale-lock-${owner.pid}-${Date.now()}.json`));lock=await open(lockFile,'wx');
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));await lock.close();
  const stateFile=path.join(local,'state.json'), state=await existsJson(stateFile)??{
    schema_version:1,pid:process.pid,completion_index:config.completion_index,status:'waiting_for_nine_archives',tasks:{},works:{}};
  if(state.completion_index.sha256!==config.completion_index.sha256)throw new Error('sound_queue_index_changed');
  const checkpoint=async()=>{state.pid=process.pid;state.updated_at=new Date().toISOString();
    await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2)+'\n');await rename(stateFile+'.tmp',stateFile);};
  try {
    state.executor_source_bindings=await Promise.all(['run_sound_query_completion_queue.mjs','sound_query_completion.mjs','sound_query_contract.mjs']
      .map(file=>bound(path.join(path.dirname(fileURLToPath(import.meta.url)),file))));
    while(!state.start_condition_verified){
      const status=await readJson(config.authoritative_status_file);
      if(archiveGateReady(status,ids)){
        const evidence=[];
        for(const id of ids){
          const row=status.videos.find(row=>row.id===id);await verifyEvidenceBindings([row.preview,row.stem_archive]);
          const archive=await readJson(row.stem_archive.path), stems=['bgm','sfx','ambience','accompaniment'].map(kind=>archive.stems?.[kind]);
          if(stems.some(ref=>!ref?.path||!ref.sha256)||archive.duration_samples!==row.duration_samples)
            throw new Error('sound_queue_four_archived_stems_required');
          await verifyEvidenceBindings(stems);evidence.push({id,preview:row.preview,stem_archive:row.stem_archive,stems});
        }
        state.start_condition_verified=await saveJson(path.join(config.output_dir,'nine-archive-start-condition.json'),{
          verified_at:new Date().toISOString(),authoritative_status:await bound(config.authoritative_status_file),evidence,
          purpose:'Start query-only continuation after nine music diagnostic previews and four stems are archived; not sound quality approval.'});
      }else{state.status='waiting_for_nine_archives';await checkpoint();await new Promise(resolve=>setTimeout(resolve,30000));}
    }
    const sources=[];
    for(const row of index.rows){await verifyEvidenceBindings(row.completion_queue);
      const queue=await readJson(row.completion_queue.path);await verifyEvidenceBindings([queue.analysis,queue.director]);
      const analysis=await readJson(queue.analysis.path);
      const source=(await readJson(config.authoritative_status_file)).videos.find(v=>v.id===row.id)?.source;
      if(source?.sha256!==analysis.source_video_sha256)throw new Error('sound_queue_video_identity_mismatch');
      await verifyEvidenceBindings(source);sources.push(source);}
    const session=createCodexCliRuntime({...config.cli,stateDirectory:path.join(local,'cli'),archiveDirectory:path.join(config.output_dir,'cli'),
      cwd:path.dirname(fileURLToPath(import.meta.url)),mediaBindings:sources,
      authAdmission:createAccountAuthAdmission(config.account_cli_slot_directory),
      schedule:createAccountCliSchedule({directory:config.account_cli_slot_directory})});
    state.status='consuming_actual_query_requests';await checkpoint();
    for(const [workIndex,row] of index.rows.entries()){
      await verifyEvidenceBindings([row.completion_queue,sources[workIndex]]);
      const queue=await readJson(row.completion_queue.path), results=[];
      await verifyEvidenceBindings([queue.analysis,queue.director]);
      for(const [requestIndex,request] of queue.requests.entries()){
        const key=`${row.id}/${requestIndex+1}`, output=path.join(config.output_dir,row.id,`q${requestIndex+1}`);
        const prior=state.tasks[key];
        if(prior?.status==='completed'){
          await verifyEvidenceBindings(prior.result);const cached=await readJson(prior.result.path);
          if(cached.request.sha256!==request.sha256||cached.source.sha256!==sources[workIndex].sha256
            ||cached.analysis.sha256!==queue.analysis.sha256||cached.original_director.sha256!==queue.director.sha256
            ||cached.actual_runtime_executed!==true)throw new Error('sound_queue_cached_result_identity_invalid');
          await verifyEvidenceBindings([cached.request,cached.source,cached.raw_response,cached.analysis,cached.original_director]);
          results.push(prior.result);continue;
        }
        if(prior?.status==='failed_or_unknown')continue;
        const recovered=await existsJson(path.join(output,'result.json'));
        if(recovered){
          if(recovered.request.sha256!==request.sha256||recovered.source.sha256!==sources[workIndex].sha256
            ||recovered.actual_runtime_executed!==true)throw new Error('sound_queue_recovered_result_identity_invalid');
          await verifyEvidenceBindings([recovered.raw_response,recovered.analysis,recovered.original_director]);
          const result=await bound(path.join(output,'result.json'));results.push(result);
          state.tasks[key]={status:'completed',request,result,recovered_existing_actual_return:true};await checkpoint();continue;
        }
        if(prior?.status==='running'){
          state.tasks[key]={...prior,status:'failed_or_unknown',reason:'Interrupted in-flight request must be audited, not replayed.'};
          state.status='account_or_unknown_execution_attention';await checkpoint();return state;
        }
        state.tasks[key]={status:'running',request,started_at:new Date().toISOString()};await checkpoint();
        try{
          const result=await completeSoundQueryRequest({request,source:sources[workIndex],output_dir:output},session);
          const returned=await readJson(result.path);
          if(!returned.actual_runtime_executed)throw new Error('sound_queue_actual_runtime_required');
          results.push(result);state.tasks[key]={...state.tasks[key],status:'completed',result,completed_at:new Date().toISOString()};
        }catch(error){
          const failure=await saveJson(path.join(output,'failure.json'),{request,error:error.code??error.message,
            actual_completion_confirmed:false,cli_receipts:error.cli_receipts??[],production_approval:false});
          state.tasks[key]={...state.tasks[key],status:'failed_or_unknown',failure};
          if(/quota|authorization|outcome_unknown|slots_needs_attention/.test(error.code??error.message)){
            state.status='account_or_unknown_execution_attention';await checkpoint();return state;}
        }
        await checkpoint();
      }
      if(!state.works[row.id]?.handoff){
        const handoff=await mergeSoundQueryCompletions({queue:row.completion_queue,results,output_dir:path.join(config.output_dir,row.id,'derived')});
        state.works[row.id]={handoff};await checkpoint();
      }
    }
    state.status=Object.values(state.tasks).some(row=>row.status!=='completed')?'query_queue_finished_with_gaps':'query_queue_consumed_material_selection_and_original_audit_still_pending';
    state.actual_completed_requests=Object.values(state.tasks).filter(row=>row.status==='completed').length;
    state.production_approval=false;await checkpoint();return state;
  }finally{await unlink(lockFile);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  runSoundQueryCompletionQueue(await readJson(process.argv[2])).then(state=>console.log(JSON.stringify({status:state.status,actual_completed_requests:state.actual_completed_requests??0})))
    .catch(error=>{console.error(error.code??error.message);process.exitCode=1;});
}
