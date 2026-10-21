import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {execOwnedFile} from './owned_process_runner.mjs';

const execute=promisify(execFile);
export async function inspectLocalResearchExecution(context={},stage){
  const timing=context.trialBudget?await context.trialBudget.inspectLocal({stage}):null;
  const explicit=context.deadlineAtMs??null;
  if(explicit!==null&&(!Number.isSafeInteger(explicit)||explicit<=0))throw Error('owned_process_deadline_invalid');
  const budgetDeadline=timing?.request_deadline_at_ms??(Number.isSafeInteger(timing?.deadline_at_ms)
    ?timing.deadline_at_ms-(timing.reserved_render_ms??0):null);
  if(explicit===null&&budgetDeadline===null)return null;
  const deadlineAtMs=Math.min(explicit??Infinity,budgetDeadline??Infinity,
    Number.isFinite(timing?.remaining_ms)?Date.now()+Math.floor(timing.remaining_ms):Infinity);
  if(deadlineAtMs<=Date.now())throw Object.assign(Error('owned_process_deadline_exhausted'),{
    code:'owned_process_deadline_exhausted',child_started:false,terminated:true});
  return {deadlineAtMs,remainingMs:deadlineAtMs-Date.now()};
}

// Legacy callers keep their existing execFile behavior. Explicit film deadlines
// own the complete child tree and retain the render reserve before local work.
export async function executeLocalResearch(command,args,options,context={},stage){
  const timing=await inspectLocalResearchExecution(context,stage);
  if(!timing)return execute(command,args,options);
  try{
    const result=await execOwnedFile(command,args,{...options,
      python:context.ownedProcessPython??process.env.SDR_PYTHON,deadlineAtMs:timing.deadlineAtMs,
      timeout:Math.max(1,Math.floor(Math.min(options.timeout??Infinity,timing.remainingMs)))});
    await inspectLocalResearchExecution(context,stage+'_result_io');return result;
  }catch(error){
    try{await inspectLocalResearchExecution(context,stage+'_failure');}
    catch(deadlineError){deadlineError.cause=error;
      for(const key of ['child_started','terminated','process_tree_owned'])if(error[key]!==undefined)deadlineError[key]=error[key];
      throw deadlineError;}
    throw error;
  }
}
