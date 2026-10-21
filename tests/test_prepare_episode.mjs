import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {prepareEpisode} from '../scripts/prepare_episode.mjs';

test('prepared JPEGs preserve anamorphic display aspect, square pixels, bounds and frame times',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'muse-prepare-geometry-'));
 try{
  for(const [index,size,sar,expected] of [
   [0,'720x576','16/15',[1280,960]],
   [1,'720x576','64/45',[1280,720]],
   [2,'720x576','8/15',[853,1280]],
   [3,'64x128','1',[640,1280]],
   [4,'128x64','1',[1280,640]],
  ]){
   const video=path.join(root,`synthetic-${index}.mp4`),out=path.join(root,`prepared-${index}`);
   execFileSync('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i',`color=black:s=${size}:r=10:d=1`,
    '-vf',`setsar=${sar}`,'-an','-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true});
   const manifest=await prepareEpisode({video,out,step:0.5,noAudio:true});
   assert.equal(manifest.timeline.duration_samples,48000);
   assert.deepEqual(manifest.frames.map(frame=>frame.timeline_seconds),[0,0.5]);
   assert.deepEqual(manifest.frames.map(frame=>frame.source_pts_seconds),[0,0.5]);
   assert.equal(manifest.original_audio,null);
   for(const frame of manifest.frames){
    const result=execFileSync('ffprobe',['-v','error','-show_streams','-of','json',path.join(out,frame.path)],{windowsHide:true});
    const stream=JSON.parse(result).streams[0];
    assert.ok(stream.width>0&&stream.height>0&&stream.width<=1280&&stream.height<=1280);
    // Integer image dimensions may round a fractional aspect by at most one pixel.
    assert.ok(Math.abs(stream.width-expected[0])<=1&&Math.abs(stream.height-expected[1])<=1);
    assert.equal(stream.sample_aspect_ratio,'1:1');
   }
  }
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('muse-prepare-geometry-'));
  await rm(root,{recursive:true,force:true});
 }
});
