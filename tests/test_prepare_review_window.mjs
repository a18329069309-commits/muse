import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {prepareReviewWindow} from '../scripts/prepare_review_window.mjs';
import {hashFile} from '../scripts/render_binding.mjs';

const artifacts=fileURLToPath(new URL('../.muse/',import.meta.url));
const run=(name,args,extra={})=>execFileSync(name,args,{windowsHide:true,timeout:20000,maxBuffer:8*1024*1024,...extra});
const probe=file=>JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
async function fixture({size='720x576',sar='8/15',pts=0}={}){
  await mkdir(artifacts,{recursive:true});
  const root=await mkdtemp(path.join(artifacts,'review-window-'));
  const video=path.join(root,'source.mp4'),audio=path.join(root,'original.wav');
  run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i',`testsrc2=size=${size}:rate=10:duration=3`,
    '-vf',`setsar=${sar},setpts=PTS+${pts}/TB`,'-fps_mode','passthrough','-c:v','libx264','-pix_fmt','yuv420p','-an',video]);
  run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i',
    'aevalsrc=0.1*sin(2*PI*440*t)*between(t\\,0.75\\,0.85):s=48000:d=3','-c:a','pcm_f32le',audio]);
  return {root,video,audio,video_sha256:await hashFile(video),audio_sha256:await hashFile(audio),first_pts_seconds:pts};
}

test('review window keeps anamorphic portrait geometry within even H264 dimensions',async()=>{
  const input=await fixture();
  const output=path.join(input.root,'review.mp4');
  const binding=await prepareReviewWindow({...input,source_range:[0.5,1.5]},output);
  const stream=probe(output).streams.find(row=>row.codec_type==='video');
  assert.deepEqual([stream.width,stream.height],[426,640]);
  assert.equal(stream.sample_aspect_ratio,'1:1');
  assert.equal(binding.sha256,await hashFile(output));
  assert.deepEqual(binding.source_range,[0.5,1.5]);
  assert.equal(binding.zero_point,'start_of_review_window');
});

test('review geometry preserves landscape and portrait display ratios for five source pixel shapes',async()=>{
  for(const [size,sar,expected] of [
    ['720x576','16/15',[640,480]],
    ['720x576','64/45',[640,360]],
    ['720x576','8/15',[426,640]],
    ['64x128','1',[320,640]],
    ['128x64','1',[640,320]],
  ]){
    const input=await fixture({size,sar}),output=path.join(input.root,'review.mp4');
    await prepareReviewWindow({...input,source_range:[0.5,1.5]},output);
    const stream=probe(output).streams.find(row=>row.codec_type==='video');
    assert.deepEqual([stream.width,stream.height],expected);
    assert.equal(stream.width%2,0);assert.equal(stream.height%2,0);
    assert.equal(stream.sample_aspect_ratio,'1:1');
    assert.ok(Math.abs(Number(stream.duration)-1)<1/48000);
  }
});

test('nonzero source PTS and window start retain the intended picture and audible pulse at zero-based output',async()=>{
  const input=await fixture({size:'120x80',sar:'1',pts:5}),output=path.join(input.root,'review.mp4');
  assert.ok(Math.abs(Number(probe(input.video).streams[0].start_time)-5)<0.000001);
  await prepareReviewWindow({...input,source_range:[0.5,1.5]},output);
  const streams=probe(output).streams;
  for(const stream of streams){
    assert.ok(Math.abs(Number(stream.start_time))<1/48000);
    assert.ok(Math.abs(Number(stream.duration)-1)<1/48000);
  }
  const frames=JSON.parse(run('ffprobe',['-v','error','-select_streams','v','-show_frames',
    '-show_entries','frame=best_effort_timestamp_time','-of','json',output])).frames;
  assert.equal(frames.length,10);
  assert.deepEqual(frames.map(row=>Number(row.best_effort_timestamp_time)),[0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9]);
  const expected=run('ffmpeg',['-v','error','-nostdin','-copyts','-i',input.video,'-vf',
    'trim=start=5.5:end=5.6,setpts=PTS-STARTPTS,scale=64:64,format=gray','-frames:v','1','-f','rawvideo','pipe:1']);
  const actual=run('ffmpeg',['-v','error','-nostdin','-i',output,'-vf','scale=64:64,format=gray',
    '-frames:v','1','-f','rawvideo','pipe:1']);
  assert.equal(actual.length,4096);assert.equal(expected.length,4096);
  let squared=0;for(let i=0;i<actual.length;i++)squared+=(actual[i]-expected[i])**2;
  assert.ok(Math.sqrt(squared/actual.length)<8,'output first frame must depict source PTS 5.5, allowing lossy encoding');
  const decoded=run('ffmpeg',['-v','error','-nostdin','-i',output,'-map','0:a:0','-ar','48000',
    '-ac','1','-c:a','pcm_f32le','-f','f32le','pipe:1']);
  assert.ok(decoded.length>=48000*4);
  const rms=(start,end)=>{let sum=0;for(let i=start;i<end;i++)sum+=decoded.readFloatLE(i*4)**2;return Math.sqrt(sum/(end-start));};
  assert.ok(rms(12000,16800)>0.03,'source pulse at .75s must move to .25s');
  assert.ok(rms(0,8000)<0.002);assert.ok(rms(21000,40000)<0.002);
});

test('review windows reject invalid bindings or ranges and never overwrite an existing output',async()=>{
  const input=await fixture({size:'120x80',sar:'1'}),output=path.join(input.root,'review.mp4');
  for(const source_range of [[-1,1],[1,1],[0,31],[0,NaN]]){
    await assert.rejects(prepareReviewWindow({...input,source_range},output),/bounded_picture_review_window_required/);
    await assert.rejects(access(output));
  }
  await assert.rejects(prepareReviewWindow({...input,video_sha256:'0'.repeat(64),source_range:[0,1]},output),/review_source_changed/);
  await assert.rejects(access(output));
  await prepareReviewWindow({...input,source_range:[0,1]},output);
  const original=await readFile(output);
  await assert.rejects(prepareReviewWindow({...input,source_range:[0,1]},output));
  assert.deepEqual(await readFile(output),original);
});
