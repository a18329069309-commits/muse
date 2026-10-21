import path from 'node:path';
import { mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { makeRuntime } from './run_corpus_batch.mjs';
import { consumeCompletedSoundQuery, soundQueryLabelExpansion } from './sound_query_material_bridge.mjs';

const bound=async file=>({path:path.resolve(file),sha256:await hashFile(file)});
const maybeRead=async file=>{try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

// Continuous research binding never automatically adds or approves sounds.
export async function runSoundQueryMaterialQueue(config) {
  await mkdir(config.state_dir,{recursive:true});
  const lockFile=path.join(config.state_dir,'lock.json');let lock;
  try{lock=await open(lockFile,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=await readJson(lockFile);if(!Number.isInteger(owner.pid))throw new Error('sound_material_queue_unknown_lock');
    try{process.kill(owner.pid,0);throw new Error('sound_material_queue_already_running');}
    catch(failure){if(failure.code!=='ESRCH')throw failure;}
    await rename(lockFile,path.join(config.state_dir,`stale-lock-${owner.pid}-${Date.now()}.json`));lock=await open(lockFile,'wx');
  }
  await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.close();
  const stateFile=path.join(config.state_dir,'state.json'),state=await maybeRead(stateFile)??{schema_version:1,pid:process.pid,tasks:{}};
  const checkpoint=async()=>{state.updated_at=new Date().toISOString();state.pid=process.pid;
    await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2)+'\n');await rename(stateFile+'.tmp',stateFile);};
  try {
    if(state.source_bindings)(state.previous_source_bindings??=[]).push(state.source_bindings);
    state.source_bindings=await Promise.all(['run_sound_query_material_queue.mjs','sound_query_material_bridge.mjs']
      .map(file=>bound(path.join(path.dirname(fileURLToPath(import.meta.url)),file))));
    while(true){
      const completed=await readJson(config.completion_state_file);
      for(const [key,task] of Object.entries(completed.tasks)){
        if(task.status!=='completed')continue;
        await verifyEvidenceBindings(task.result);const result=await readJson(task.result.path),workId=key.split('/')[0];
        if(result.actual_runtime_executed!==true)throw new Error('sound_material_queue_actual_query_required');
        for(const query of result.value.sound_queries){
          const eventKey=workId+'/'+query.event_id;
          if(!state.tasks[eventKey])state.tasks[eventKey]={status:'pending_actual_material_execution',completion_result:task.result,
            work_id:workId,event_id:query.event_id,asset_kind:query.asset_kind,query_text:query.text,
            original_sound_audit:'pending',production_approval:false};
        }
      }
      await checkpoint();
      const admittedEvents=config.auto_admit_completed_events?Object.values(state.tasks)
        .filter(row=>row.status==='pending_actual_material_execution').map(row=>({work_id:row.work_id,event_id:row.event_id,
          label_expansion:config.admitted_events?.find(item=>item.work_id===row.work_id&&item.event_id===row.event_id)?.label_expansion}))
        :config.admitted_events;
      for(const admitted of admittedEvents){
        const key=admitted.work_id+'/'+admitted.event_id,task=state.tasks[key];
        if(!task||task.status!=='pending_actual_material_execution')continue;
        task.status='running_actual_recall_observation_selector_binding';await checkpoint();
        const output=path.join(config.output_dir,admitted.work_id,admitted.event_id);
        try{
          const completion=await readJson(task.completion_result.path),analysis=await readJson(completion.analysis.path);
          const event=analysis.sound_events.find(item=>item.id===admitted.event_id);
          const labelExpansion=admitted.label_expansion??soundQueryLabelExpansion({text:task.query_text},event.role,config.label_aliases);
          const handoff=await consumeCompletedSoundQuery({...config.material,completion_result:task.completion_result,
            case_input:config.case_inputs[admitted.work_id],event_id:admitted.event_id,label_expansion:labelExpansion,
            output_dir:output,state_dir:path.join(config.state_dir,admitted.work_id,admitted.event_id)},
            {makeSelector:async(receipts,caseInput)=>makeRuntime({...config.runtime,material_observer_kind:'specialist_receipts',
              material_observation_receipts:receipts},{stateDirectory:path.join(config.state_dir,'cli'),
              archiveDirectory:path.join(config.output_dir,'cli'),mediaBindings:caseInput.episodes.map(row=>row.source_video)}, {})});
          task.handoff=handoff;const result=await readJson(handoff.path);
          task.status=result.status;task.selected_count=result.selected_count;task.completed_at=new Date().toISOString();
        }catch(error){
          task.status='failed_or_unknown_material_execution';task.error=error.code??error.message;
          task.actual_asset_completion_confirmed=false;
          if(/quota|authorization|outcome_unknown|slots_needs_attention/.test(error.code??error.message)){
            state.status='material_account_or_unknown_execution_attention';await checkpoint();return state;
          }
        }
        await checkpoint();
      }
      state.pending_material_events=Object.values(state.tasks).filter(task=>task.status==='pending_actual_material_execution').length;
      state.actual_selected_materials=Object.values(state.tasks).reduce((sum,task)=>sum+(task.selected_count??0),0);
      state.production_approval=false;state.status=config.auto_admit_completed_events?'continuously_consuming_actual_sound_material_tasks'
        :'continuously_accepting_completed_queries_with_bounded_material_admission';await checkpoint();
      if(!['waiting_for_nine_archives','consuming_actual_query_requests'].includes(completed.status)){
        state.status='query_queue_exhausted_actual_sound_material_gaps_retained';await checkpoint();return state;
      }
      await new Promise(resolve=>setTimeout(resolve,30000));
    }
  }finally{await unlink(lockFile);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  runSoundQueryMaterialQueue(await readJson(process.argv[2])).then(state=>console.log(JSON.stringify({status:state.status,
    pending_material_events:state.pending_material_events,actual_selected_materials:state.actual_selected_materials})))
    .catch(error=>{console.error(error.code??error.message);process.exitCode=1;});
}
