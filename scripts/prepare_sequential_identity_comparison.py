"""Source-bound A, 0.6 seconds silence, B identity audition; never approve identity.

Consumes already prepared mono clips from a bound human identity package.
Original stereo/source media and historical evidence are never overwritten.
"""
import argparse,hashlib,json,shutil,subprocess,wave
from datetime import datetime,timezone
from pathlib import Path

def read(p):return json.loads(Path(p).read_text('utf-8-sig'))
def digest(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def bind(p):return {'path':str(Path(p).resolve()),'sha256':digest(p)}
def checked(b):
 if digest(b['path'])!=b['sha256']:raise ValueError('bound_identity_media_changed')
 return Path(b['path'])
def write(p,v):
 with Path(p).open('x',encoding='utf-8') as f:json.dump(v,f,ensure_ascii=False,indent=2,allow_nan=False)
 return bind(p)
def mono16(b):
 p=checked(b)
 with wave.open(str(p),'rb') as f:
  if (f.getnchannels(),f.getframerate(),f.getsampwidth())!=(1,16000,2):raise ValueError('existing_bound_mono16_PCM_required')
  count=f.getnframes();data=f.readframes(count)
 if len(data)!=count*2:raise ValueError('actual_PCM_extent_missing')
 return data,count
def prepare(package_binding,out,indices=(0,1)):
 package=read(checked(package_binding));out=Path(out);out.mkdir(parents=True,exist_ok=False);results=[]
 ffmpeg=bind(shutil.which('ffmpeg'))
 for index in indices:
  item=package['comparisons'][index];a=item['reference_original'];b=item['candidates'][0]['independent_recording']
  left,na=mono16(a['audio']);right,nb=mono16(b['audio'])
  if na!=nb or na<=0:raise ValueError('A_B_actual_mono_extents_must_match')
  gap=round(.6*16000);raw=left+b'\0\0'*gap+right;total=na+gap+nb
  wav=out/(item['comparison_id']+'-sequential-A-silence-B.wav')
  with wave.open(str(wav),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(raw)
  mp3=wav.with_suffix('.mp3')
  command=[ffmpeg['path'],'-v','error','-nostdin','-xerror','-n','-i',str(wav),'-map','0:a:0','-c:a','libmp3lame','-b:a','64k','-ar','16000','-ac','1',str(mp3)]
  encoded=subprocess.run(command,capture_output=True,timeout=60)
  if encoded.returncode:raise ValueError('actual_A_B_MP3_encoding_failed')
  decode=[ffmpeg['path'],'-v','error','-nostdin','-xerror','-i',str(mp3),'-map','0:a:0','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','s16le','pipe:1']
  decoded=subprocess.run(decode,capture_output=True,timeout=60)
  if decoded.returncode or len(decoded.stdout)!=total*2:raise ValueError('actual_A_B_MP3_decoded_extent_mismatch')
  # Lossless WAV concatenation must retain each mono source byte-for-byte.
  with wave.open(str(wav),'rb') as f:
   if f.getnframes()!=total or f.readframes(total)!=raw:raise ValueError('actual_A_B_WAV_concat_identity_mismatch')
  results.append({'comparison_id':item['comparison_id'],'title_metadata_only':item['title_metadata_only'],
   'source_identity_package':package_binding,'original_comparison_index':index,'A':{'role':'original reference mix, actor dialogue retained',
     'source':a['source'],'source_range':a['actual_range_seconds'],'mono_input':a['audio'],'target_sample_range':[0,na],'target_range_seconds':[0,na/16000]},
   'silence':{'synthesized_separator_only':True,'sample_count':gap,'target_sample_range':[na,na+gap],'target_range_seconds':[na/16000,(na+gap)/16000]},
   'B':{'role':'independent recording exact bound excerpt','source':b['source'],'source_range':b['actual_range_seconds'],'mono_input':b['audio'],
     'target_sample_range':[na+gap,total],'target_range_seconds':[(na+gap)/16000,total/16000]},
   'actual_concat_WAV':bind(wav),'actual_concat_PCM_sha256':hashlib.sha256(raw).hexdigest(),'actual_MP3':bind(mp3),
   'duration_samples':total,'sample_rate':16000,'duration_seconds':total/16000,
   'execution':{'encoding_argv':command,'encoding_exit_code':encoded.returncode,'encoding_stderr_sha256':hashlib.sha256(encoded.stderr).hexdigest(),
     'full_MP3_decode_argv':decode,'full_MP3_decode_exit_code':decoded.returncode,'decoded_PCM_sha256':hashlib.sha256(decoded.stdout).hexdigest(),'decoded_sample_count':len(decoded.stdout)//2,'ffmpeg':ffmpeg},
   'level_changed':False,'speed_changed':False,'pitch_changed':False,'dialogue_separated_or_removed':False,
   'preview_format':'lossy MP3; original source mono clips and lossless concat WAV preserved',
   'feedback_interpretation':'previous feedback described confusing simultaneous/left-right playback; no new recording-version conclusion granted',
   'actual_audio_processed':True,'actual_audio_listened':False,'same_recording_version':None,'Ready':False})
 result={'schema_version':1,'created_at_utc':datetime.now(timezone.utc).isoformat(),'kind':'actual_sequential_original_A_then_independent_B_identity_audition',
  'source_package':package_binding,'comparisons':results,'producer':bind(__file__),'old_source_and_stereo_files_preserved':True,'models':0,'uploads':0,'paid_calls':0,'Ready':False}
 return write(out/'sequential-identity-audition-receipt.json',result),result
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--package',required=True);p.add_argument('--package-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 artifact,result=prepare({'path':str(Path(a.package).resolve()),'sha256':a.package_sha256},a.out)
 print(json.dumps({'receipt':artifact,'audio':[{'id':r['comparison_id'],'MP3':r['actual_MP3'],'seconds':r['duration_seconds']} for r in result['comparisons']],'Ready':False}))
