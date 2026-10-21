import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {ApiSession,readJson,shaBytes} from '../scripts/audio_api.mjs';
import {hashFile} from '../scripts/render_binding.mjs';

const execute=promisify(execFile),root=path.resolve('.muse/api-audio-review-tests');
const observation={vocal_type:'none',language:'none',description:'Synthetic tone transport fixture, not listening evidence.',
  instruments:[],original_audio_kind:'none',words:[],changes:[],issues:[],uncertainties:[]};
const response=()=>({ok:true,json:async()=>({id:'offline-fixture-request',model:'gemini-3.8-flash',status:'completed',
  steps:[{type:'model_output',status:'completed',content:[{type:'text',text:JSON.stringify(observation)}]}]})});
async function fixture({transport=response,timeoutMs=10000,model='gemini-3.8-flash'}={}){
  await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'case-'));
  const audio=path.join(dir,'source.wav'),video=path.join(dir,'source.mp4');
  await execute('ffmpeg',['-v','error','-nostdin','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1',
    '-c:a','pcm_f32le',audio],{windowsHide:true});
  await execute('ffmpeg',['-v','error','-nostdin','-n','-f','lavfi','-i','color=c=blue:s=32x24:r=8:d=1',
    '-i',audio,'-map','0:v','-map','1:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video],{windowsHide:true});
  const job={path:audio,source_sha256:await hashFile(audio),source_video_sha256:await hashFile(video),
    source_range:[0,1],segment_id:'synthetic-mix',asset_id:'offline-fixture'};
  const options={purpose:'mix',frames:[],context:{fixture_only:true,production_approval:false},video:{path:video,
    sha256:await hashFile(video),source_range:[0,1],zero_point:'start_of_review_window'}};
  const session=new ApiSession({budget:{enabled:true,max_calls:4,max_estimated_cost_usd:1,per_call_cost_ceiling_usd:.1},
    directory:path.join(dir,'api'),environment:{GEMINI_API_KEY:'offline-test-placeholder'},transport,timeoutMs,
    audioBackend:{protocol:'gemini_interactions',backend_id:model,model_revision:model}});
  return{dir,out:path.join(dir,'observation'),job,options,session};
}

test('mix preparation is local, reusable and exposes bounded multimodal planning rather than usage',async()=>{
  const f=await fixture({transport:()=>{throw Error('preparation_must_not_submit');}});
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options);
  assert.equal(f.session.audioReviewEvidenceContract,'exact_audio_picture_submission_v1');
  assert.equal(f.session.ledger.length,0);
  assert.deepEqual(await f.session.prepareAudioReviewRequest(f.job,f.out,f.options),p);
  const payload=await readJson(p.request_payload.path),video=payload.input.find(row=>row.type==='video');
  assert.deepEqual(video.processing,{type:'static',fps:1});assert.equal(video.resolution,'low');
  assert.equal(p.request_body_sha256,shaBytes(JSON.stringify(payload)));
  assert.notEqual(p.request_payload.sha256,p.request_body_sha256);
  assert.equal(p.input_budget.components.video_tokens,300);
  assert.equal(p.input_budget.components.audio_tokens,32);
  assert.equal(p.input_budget.components.video_audio_tokens,32);
  assert.equal(p.input_budget.components.wrapper_allowance_tokens,512);
  assert.equal(p.input_budget.estimate_is_provider_usage,false);
  assert.equal(p.input_budget.guaranteed_provider_token_ceiling,false);
});

test('prepared mix submission sends its frozen payload and binds final receipt, raw response and observation',async()=>{
  let submitted;const f=await fixture({transport:async(_url,request)=>{submitted=request;return response();}});
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options);
  const record=await f.session.observeAudio(f.job,f.out,{...f.options,prepared_request:p,timeoutMs:2000});
  assert.equal(submitted.body,JSON.stringify(await readJson(p.request_payload.path)));
  assert.equal(submitted.signal.aborted,false);
  assert.deepEqual(record.request_payload,p.request_payload);
  const receipt=await readJson(record.submission_receipt.path),audit=await readJson(record.api_evidence.path);
  assert.equal(receipt.provider,'gemini');assert.equal(receipt.stage,'mix');assert.equal(receipt.status,'completed');
  assert.equal(receipt.request_id,record.request_id);assert.equal(receipt.model,'gemini-3.8-flash');
  assert.equal(receipt.request_body_sha256,p.request_body_sha256);assert.equal(receipt.timeout_ms,2000);
  assert.deepEqual(audit.submission_receipt,record.submission_receipt);
  assert.deepEqual(audit.request_payload,p.request_payload);assert.equal(audit.purpose,'mix');assert.equal(audit.provider,'gemini');
  assert.deepEqual(audit.raw_response,receipt.response);assert.equal(record.artistic_approval,false);
});

test('unknown model has no exact review capability and malformed or unsupported requests fail before preparation',async()=>{
  const unknown=await fixture({model:'gemini-unknown'});
  assert.equal(unknown.session.audioReviewEvidenceContract,null);
  await assert.rejects(()=>unknown.session.prepareAudioReviewRequest(unknown.job,unknown.out,unknown.options),/model_not_registered/);
  const f=await fixture();
  for(const changed of [{context:{bad:NaN}},{context:{bad:Infinity}},{purpose:'candidate'},
    {frames:[{path:'unused'}]},{processing:{type:'agentic'}},{processing:{type:'static',fps:2}},{resolution:'high'},
    {video:{...f.options.video,sha256:null}},{video:null}]){
    await assert.rejects(()=>f.session.prepareAudioReviewRequest(f.job,f.out,{...f.options,...changed}));
  }
  assert.equal(f.session.ledger.length,0);
});

test('completed mix reuse revalidates exact evidence and does not submit again',async()=>{
  let submissions=0;const f=await fixture({transport:async()=>{submissions++;return response();}});
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options),options={...f.options,prepared_request:p};
  const first=await f.session.observeAudio(f.job,f.out,options);
  const cached=await f.session.observeAudio(f.job,f.out,options);
  assert.deepEqual(cached,first);assert.equal(submissions,1);
  await writeFile(first.submission_receipt.path,'{}\n');
  await assert.rejects(()=>f.session.observeAudio(f.job,f.out,options),/binding|evidence/);
  assert.equal(submissions,1);
});

test('synchronized review rejects nonzero media timestamps even when container duration looks close',async()=>{
  const f=await fixture(),shifted=path.join(f.dir,'shifted.mp4');
  await execute('ffmpeg',['-v','error','-nostdin','-n','-i',f.options.video.path,'-c','copy','-output_ts_offset','0.1',shifted],{windowsHide:true});
  const options={...f.options,video:{...f.options.video,path:shifted,sha256:await hashFile(shifted)}};
  await assert.rejects(()=>f.session.prepareAudioReviewRequest(f.job,f.out,options),/synchronized_media/);
  assert.equal(f.session.ledger.length,0);
});

test('prepared bindings reject changed options, budget, media and payload before external submission',async()=>{
  let submissions=0;const f=await fixture({transport:async()=>{submissions++;return response();}});
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options);
  for(const changed of [{...p,input_budget:{...p.input_budget,submitted_input_tokens:1}},
    {...p,timeout_ms:1},{...p,request_payload:{path:p.request_payload.path}},
    {...p,preparation:{...p.preparation,path:'relative.json'}}]){
    await assert.rejects(()=>f.session.observeAudio(f.job,f.out,{...f.options,prepared_request:changed}));
  }
  await assert.rejects(()=>f.session.observeAudio(f.job,f.out,{...f.options,context:{different:true},prepared_request:p}));
  await assert.rejects(()=>f.session.observeAudio(f.job,f.out,{...f.options,prepared_request:p,timeoutMs:NaN}));
  await writeFile(p.request_payload.path,'{}\n');
  await assert.rejects(()=>f.session.observeAudio(f.job,f.out,{...f.options,prepared_request:p}),/binding/);
  assert.equal(submissions,0);
  const media=await fixture({transport:async()=>{submissions++;return response();}});
  const mp=await media.session.prepareAudioReviewRequest(media.job,media.out,media.options);
  await writeFile(media.options.video.path,'changed video');
  await assert.rejects(()=>media.session.observeAudio(media.job,media.out,{...media.options,prepared_request:mp}),/binding/);
  assert.equal(submissions,0);
});

for(const [kind,transport,expected] of [
  ['http',async()=>({ok:false,status:429}),'provider_rejected'],
  ['json',async()=>({ok:true,json:async()=>{throw SyntaxError('offline fixture');}}),'invalid_json_response'],
  ['refusal',async()=>({ok:true,json:async()=>({id:'refused-fixture',status:'completed',model:'gemini-3.8-flash',
    steps:[{type:'model_output',content:[{type:'refusal'}]}]})}),'invalid_response'],
  ['wrong-model',async()=>({ok:true,json:async()=>({...await response().json(),model:'gemini-other'})}),'invalid_response'],
  ['timeout',async()=>new Promise(()=>{}),'provider_outcome_unknown'],
])test(`failed ${kind} submissions retain pending evidence across restart and cannot be resent`,async()=>{
  let calls=0;const f=await fixture({transport:async(...args)=>{calls++;return transport(...args);}});
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options),options={...f.options,prepared_request:p,timeoutMs:25};
  await assert.rejects(()=>f.session.observeAudio(f.job,f.out,options),new RegExp(expected));
  const receipt=await readJson(path.join(f.session.directory,'1-receipt.json'));
  assert.equal(receipt.status,expected);assert.equal(receipt.timeout_ms,25);
  assert.equal((await readJson(path.join(f.out,'submission-pending.json'))).request_body_sha256,p.request_body_sha256);
  const restarted=new ApiSession({budget:f.session.budget,directory:f.session.directory,environment:f.session.environment,
    transport:async()=>{calls++;return response();},timeoutMs:f.session.timeoutMs});
  await assert.rejects(()=>restarted.observeAudio(f.job,f.out,options),/pending_submission_requires_reconciliation/);
  assert.equal(calls,1);
});

test('the API allowance and session timeout cannot be widened by a prepared request',async()=>{
  let calls=0;const f=await fixture({timeoutMs:1000,transport:async()=>{calls++;return response();}});
  f.session.budget.max_calls=1;
  const p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options);
  const result=await f.session.observeAudio(f.job,f.out,{...f.options,prepared_request:p,timeoutMs:5000});
  assert.equal((await readJson(result.submission_receipt.path)).timeout_ms,1000);
  const other=path.join(f.dir,'another-observation'),prepared=await f.session.prepareAudioReviewRequest(f.job,other,f.options);
  await assert.rejects(()=>f.session.observeAudio(f.job,other,{...f.options,prepared_request:prepared}),/budget_exhausted/);
  assert.equal(calls,1);
});

test('existing incomplete preparation is never overwritten and non-mix legacy observation remains usable',async()=>{
  const f=await fixture();await mkdir(f.out);await writeFile(path.join(f.out,'sentinel.txt'),'retained');
  await assert.rejects(()=>f.session.prepareAudioReviewRequest(f.job,f.out,f.options),/incomplete_preparation/);
  assert.equal(await readFile(path.join(f.out,'sentinel.txt'),'utf8'),'retained');
  const legacy=await f.session.observeAudio(f.job,path.join(f.dir,'legacy'),{purpose:'candidate'});
  assert.equal(legacy.completion_status,'complete');assert.equal(legacy.purpose,'candidate');
  assert.equal(legacy.artistic_approval,false);
});

test('oversized or incomplete synchronized video is rejected locally before media is encoded into a request',async()=>{
  let submissions=0;const f=await fixture({transport:async()=>{submissions++;return response();}});
  const huge=path.join(f.dir,'oversized.mp4');await writeFile(huge,Buffer.alloc(14*1024*1024+1));
  await assert.rejects(async()=>f.session.prepareAudioReviewRequest(f.job,f.out,{...f.options,
    video:{...f.options.video,path:huge,sha256:await hashFile(huge)}}),/inline_video_size/);
  const short=path.join(f.dir,'short.mp4');
  await execute('ffmpeg',['-v','error','-nostdin','-n','-i',f.options.video.path,'-t','0.5','-c','copy',short],{windowsHide:true});
  await assert.rejects(async()=>f.session.prepareAudioReviewRequest(f.job,f.out,{...f.options,
    video:{...f.options.video,path:short,sha256:await hashFile(short)}}),/synchronized_media/);
  assert.equal(submissions,0);
});

test('resumed preparation cannot understate decoded audio samples by rewriting its metadata',async()=>{
  const f=await fixture(),p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options);
  const metadata=await readJson(p.preparation.path);
  metadata.identity.samples=0;metadata.input_budget.components.audio_tokens=0;
  metadata.input_budget.submitted_input_tokens-=32;
  await writeFile(p.preparation.path,JSON.stringify(metadata,null,2)+'\n');
  await assert.rejects(()=>f.session.prepareAudioReviewRequest(f.job,f.out,f.options),/audio_review.*identity/);
  assert.equal(f.session.ledger.length,0);
});

test('completed cache rejects rewritten identity metadata even when its file hash is refreshed',async()=>{
  const f=await fixture(),p=await f.session.prepareAudioReviewRequest(f.job,f.out,f.options),options={...f.options,prepared_request:p};
  const first=await f.session.observeAudio(f.job,f.out,options),original=await readJson(first.file.path);
  for(const patch of [{backend_id:'different'},{protocol:'local_audio_model'},{pcm_sha256:'0'.repeat(64)},{samples:1},{sample_rate_hz:8000}]){
    await writeFile(first.file.path,JSON.stringify({...original,...patch},null,2)+'\n');
    await assert.rejects(()=>f.session.observeAudio(f.job,f.out,options),/cached_evidence/);
  }
});
