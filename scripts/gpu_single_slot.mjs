import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const gpuSingleSlotRevision='local-gpu-single-slot-v1';
// All processes/checkouts sharing a GPU must use the same explicit root.
const defaultGpuSingleSlotRoot=fileURLToPath(new URL('../.muse/gpu-execution-slots',import.meta.url));
export function resolveGpuSingleSlotRoot(environment=process.env){
  const root=environment.SDR_GPU_SLOT_ROOT??defaultGpuSingleSlotRoot;
  if(typeof root!=='string'||!path.isAbsolute(root)||/^(\\\\|\/\/)/.test(root)
    ||path.resolve(root)===path.parse(path.resolve(root)).root)throw Error('gpu_slot_root_invalid');
  return path.resolve(root);
}
export const gpuSingleSlotRoot=resolveGpuSingleSlotRoot();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateGpuSingleSlotConfig(value,environment=process.env){
  if(!value||Object.keys(value).sort().join(',')!=='acquire_timeout_ms,device,maximum_concurrency,revision,root'
    ||value.revision!==gpuSingleSlotRevision||value.device!=='cuda:0'||value.maximum_concurrency!==1
    ||!Number.isSafeInteger(value.acquire_timeout_ms)||value.acquire_timeout_ms<1||value.acquire_timeout_ms>3600000
    ||typeof value.root!=='string'||!path.isAbsolute(value.root)||/^(\\\\|\/\/)/.test(value.root)
    ||path.resolve(value.root)===path.parse(path.resolve(value.root)).root
    ||path.resolve(value.root).toLowerCase()!==resolveGpuSingleSlotRoot(environment).toLowerCase())
    throw Error('gpu_slot_config_invalid');
  return value;
}
export function resolveGpuSingleSlotBinding(value,environment=process.env){
  return value??((environment.SDR_GPU_SLOT_CONFIG!=null||environment.SDR_GPU_SLOT_SHA256!=null)
    ?{path:environment.SDR_GPU_SLOT_CONFIG,sha256:environment.SDR_GPU_SLOT_SHA256}:undefined);
}
export async function readGpuSingleSlotBinding(binding,environment=process.env){
  if(!binding||Object.keys(binding).sort().join(',')!=='path,sha256'||!/^[a-f0-9]{64}$/.test(binding.sha256??'')
    ||typeof binding.path!=='string'||!path.isAbsolute(binding.path))throw Error('gpu_slot_explicit_config_binding_required');
  const bytes=await readFile(binding.path);
  if(hash(bytes)!==binding.sha256)throw Error('gpu_slot_config_sha_changed');
  return validateGpuSingleSlotConfig(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),environment);
}
export async function prepareGpuSingleSlotCommand({python,script,args=[],device,slot,helper,
  environment=process.env}){
  if(device==='cpu')return {file:python,args:['-B','-X','utf8',script,...args]};
  if(!['cuda','cuda:0'].includes(device)||(environment.CUDA_VISIBLE_DEVICES??'0')!=='0')
    throw Error('gpu_slot_physical_gpu_identity_ambiguous');
  slot=resolveGpuSingleSlotBinding(slot,environment);
  await readGpuSingleSlotBinding(slot,environment);
  const runner=helper??path.join(path.dirname(fileURLToPath(import.meta.url)),'gpu_single_slot.py');
  const implementation={path:runner,sha256:hash(await readFile(runner))};
  const target={path:script,sha256:hash(await readFile(script))};
  return {file:python,args:['-B','-X','utf8',runner,'--gpu-slot-config',slot.path,'--gpu-slot-sha256',slot.sha256,
    '--target',script,'--target-sha256',target.sha256,'--device',device,'--',...args],
    gpu_slot_execution:{revision:gpuSingleSlotRevision,config:slot,implementation,target,
      maximum_concurrency:1,same_process_execution:true,qualification_granted:false}};
}
