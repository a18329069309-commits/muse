import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hashFile } from './render_binding.mjs';

export const renderDecodeCacheRevision='bounded-render-decode-cache-v1';
const helper=fileURLToPath(new URL('./render_decode_cache.py',import.meta.url));
export function validateRenderDecodeCacheConfig(config){
 if(config?.revision!==renderDecodeCacheRevision||!path.isAbsolute(config.root??'')||config.root.startsWith('\\\\')
  ||config.root.startsWith('//')||path.resolve(config.root)===path.parse(path.resolve(config.root)).root
  ||Object.keys(config).some(k=>!['revision','root','max_bytes','min_free_bytes'].includes(k))
  ||!Number.isSafeInteger(config.max_bytes??1073741824)||(config.max_bytes??1073741824)<4096||(config.max_bytes??1073741824)>1073741824
  ||!Number.isSafeInteger(config.min_free_bytes??2147483648)||(config.min_free_bytes??2147483648)<2147483648)
  throw Error('render_decode_cache_explicit_local_bounded_policy_required');
 return{...config,root:path.resolve(config.root),max_bytes:config.max_bytes??1073741824,min_free_bytes:config.min_free_bytes??2147483648};
}
export async function decodeWithBoundedRenderCache(file,{policy,python,legacyDecode}={}){
 const config=validateRenderDecodeCacheConfig(policy);
 if(!path.isAbsolute(python??''))throw Error('render_decode_cache_explicit_python_required');
 const source={path:path.resolve(file),sha256:await hashFile(file)};
 const processor={path:helper,sha256:await hashFile(helper)};
 const request={policy:config,source,ffmpeg_command:'ffmpeg'};
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(python,['-X','utf8',helper],{windowsHide:true,shell:false});const chunks=[];let stderr='';
  child.stdout.on('data',v=>chunks.push(v));child.stderr.on('data',v=>{stderr+=v.toString('utf8');});
  child.stdin.on('error',()=>{}); // Early helper exit is handled by close/error.
  child.on('error',reject);child.on('close',code=>resolve({code,bytes:Buffer.concat(chunks),stderr}));
  child.stdin.end(JSON.stringify(request));
 }).catch(error=>({code:2,bytes:Buffer.alloc(0),stderr:JSON.stringify({cache_gap:error.message,legacy_decode_fallback_allowed:true})}));
 let receipt;try{receipt=JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));}catch{receipt={cache_gap:'render_decode_cache_helper_receipt_invalid',legacy_decode_fallback_allowed:true};}
 if(result.code===0){
  if(receipt.revision!==renderDecodeCacheRevision||receipt.source?.sha256!==source.sha256
   ||receipt.identity?.cache_processor_sha256!==processor.sha256||receipt.qualification_granted!==false
   ||!Number.isSafeInteger(receipt.decoded_samples)||receipt.decoded_samples<=0
   ||result.bytes.length!==receipt.decoded_samples*8||receipt.payload_bytes!==result.bytes.length
   ||receipt.payload_sha256!==await shaBytes(result.bytes)||await hashFile(file)!==source.sha256
   ||await hashFile(helper)!==processor.sha256)throw Error('render_decode_cache_execution_identity_changed');
  return{bytes:result.bytes,receipt:{...receipt,processor,python,new_model_or_paid_calls:0}};
 }
 if(receipt.legacy_decode_fallback_allowed!==true)throw Error(receipt.cache_gap??'render_decode_cache_decode_failed');
 if(typeof legacyDecode!=='function')throw Error('render_decode_cache_legacy_fallback_required');
 const bytes=await legacyDecode();
 if(await hashFile(file)!==source.sha256)throw Error('render_decode_cache_source_changed_in_legacy_fallback');
 return{bytes,receipt:{revision:renderDecodeCacheRevision,status:'cache_legacy_bypass',cache_gap:receipt.cache_gap,
  source,processor,python,actual_decode_calls:1,new_model_or_paid_calls:0,qualification_granted:false,
  payload_bytes:bytes.length,payload_sha256:await shaBytes(bytes),source_decode_scope:'entire_first_audio_stream'}};
}
async function shaBytes(bytes){const{createHash}=await import('node:crypto');return createHash('sha256').update(bytes).digest('hex');}
