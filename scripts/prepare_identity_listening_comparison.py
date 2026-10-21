"""Prepare source-bound original/independent audio for explicit human identity review.

No person is marked as having listened. No same-version/original/Ready approval.
The stereo comparison is raw reference left / independent recording right.
"""
import argparse,hashlib,json,shutil,subprocess,wave
from pathlib import Path
from datetime import datetime,timezone
import numpy as np

def read(p):return json.loads(Path(p).read_text('utf-8-sig'))
def digest(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def bind(p):return {'path':str(Path(p).resolve()),'sha256':digest(p)}
def check(b):
 if digest(b['path'])!=b['sha256']:raise ValueError('identity_listening_source_binding_changed')
def save(p,v):
 with Path(p).open('x',encoding='utf-8') as f:json.dump(v,f,ensure_ascii=False,indent=2,allow_nan=False)
 return bind(p)
def extract(source,bounds,path):
 check(source);a,b=[round(v*16000) for v in bounds]
 if not 0<=a<b:raise ValueError('finite_identity_listening_range_required')
 cmd=['ffmpeg','-hide_banner','-v','error','-nostdin','-xerror','-n','-i',source['path'],'-map','0:a:0','-vn','-sn','-dn','-ac','1',
   '-af',f'aresample=16000,atrim=start_sample={a}:end_sample={b},asetpts=PTS-STARTPTS','-ar','16000','-c:a','pcm_s16le',str(path)]
 process=subprocess.run(cmd,capture_output=True,timeout=120)
 if process.returncode:raise ValueError('actual_identity_listening_PCM_extraction_failed')
 with wave.open(str(path),'rb') as f:
  if f.getnchannels()!=1 or f.getframerate()!=16000 or f.getsampwidth()!=2 or f.getnframes()!=b-a:raise ValueError('identity_comparison_actual_sample_extent_mismatch')
  samples=np.frombuffer(f.readframes(b-a),dtype='<i2').copy()
 check(source)
 return samples,{'source':source,'requested_range_seconds':bounds,'actual_range_seconds':[a/16000,b/16000],
  'range_coordinate':'decoded_audio_zero_start_samples','input_sample_range':[a,b],'audio':bind(path),'PCM_sha256':hashlib.sha256(samples.tobytes()).hexdigest(),
  'argv':cmd,'exit_code':0,'ffmpeg':bind(shutil.which('ffmpeg')),'stderr_sha256':hashlib.sha256(process.stderr).hexdigest(),
  'transforms':['mono downmix','16000Hz resample'],'speed_changed':False,'pitch_changed':False,'dialogue_removed':False,'actual_audio_processed':True,'actual_audio_listened':False}
def case_links(ledger,reference_sha,bounds):
 links=[]
 for suggestion in ledger['link_suggestions']:
  if suggestion['reference_source']['sha256']!=reference_sha or suggestion.get('source_clock_transform_evidence_consistent') is not True:continue
  clock=suggestion['reference_clock'];offset=clock['offset_seconds'];case_range=[v+offset for v in bounds]
  for file in ('actual_case_import','source_case_binding','preparation_manifest'):check(suggestion[file])
  for event in suggestion['reference_case_event_candidates']:
   start=max(case_range[0],event['source_event_range'][0]);end=min(case_range[1],event['source_event_range'][1])
   if start>=end:continue
   row={'case_id':event['case_id'],'step_id':event['step_id'],'source_event_id':event['source_event_id'],'actual_event_kind':event['source_event_kind'],
    'reference_case_use_range_candidate':[start,end],'reference_audio_use_range_candidate':[start-offset,end-offset],
    'reference_clock':{**clock,'timeline_range':case_range},'case_import':suggestion['actual_case_import'],'source_case_binding':suggestion['source_case_binding'],
    'relationship':'actual temporal/context join only; recording use still requires explicit identity approval','original_use_approved':False}
   if not any((r['case_id'],r['step_id'],r['source_event_id'])==(row['case_id'],row['step_id'],row['source_event_id']) for r in links):links.append(row)
 return links
def run(input_file,out):
 spec=read(input_file);out=Path(out);out.mkdir(parents=True,exist_ok=False);check(spec['case_clock_ledger']);ledger=read(spec['case_clock_ledger']['path']);rows=[]
 for index,item in enumerate(spec['comparisons']):
  folder=out/str(index);folder.mkdir();original,ref=extract(item['reference'],item['reference_range'],folder/'reference-original.wav')
  candidates=[]
  for k,candidate in enumerate(item['recording_candidates']):
   independent,record=extract(candidate['source'],candidate['source_range'],folder/('independent-'+str(k)+'.wav'))
   if len(independent)!=len(original):raise ValueError('synchronous_comparison_requires_equal_real_extents')
   paired=np.column_stack([original,independent]).astype('<i2');target=folder/('synchronous-left-reference-right-independent-'+str(k)+'.wav')
   with wave.open(str(target),'wb') as f:f.setnchannels(2);f.setsampwidth(2);f.setframerate(16000);f.writeframes(paired.tobytes())
   candidates.append({'candidate_id':candidate['candidate_id'],'independent_recording':record,'synchronous_stereo':bind(target),
    'stereo_roles':{'left':'actual original reference mix, dialogue retained','right':'actual independent recording excerpt'},
    'relative_delay_samples':0,'sample_count':len(original),'position_status':candidate.get('position_status','candidate_only'),
    'whole_catalogue_version_identity_approved':False})
  rows.append({'comparison_id':item['comparison_id'],'title_metadata_only':item['title_metadata_only'],'reference_original':ref,'candidates':candidates,
   'actual_case_event_candidates':case_links(ledger,item['reference']['sha256'],item['reference_range']),
   'machine_probe':item['machine_probe'],'decision':'pending_human_listening','actual_audio_listened':False,'same_recording_version':None,
   'question':'After actually listening, is this the same recording version within these exact source ranges? Similar melody alone is insufficient; select uncertain or different if not clear.',
   'allowed_human_answers':['same_recording_version_within_exact_ranges','same_melody_but_different_or_uncertain_recording_version','not_same_recording','not_listened_or_uncertain'],
   'Ready':False,'plot_use_approved':False})
 return save(out/'human-identity-review-package.json',{'schema_version':1,'created_at_utc':datetime.now(timezone.utc).isoformat(),'kind':'actual_source_synchronous_identity_listening_package_pending',
  'input':bind(input_file),'case_clock_ledger':spec['case_clock_ledger'],'comparisons':rows,'actual_audio_processed':True,'actual_audio_listened':False,
  'identity_approved':False,'source_clock_does_not_approve_recording_version':True,'no_new_user_movie':True,'paid_calls':0,'audio_uploads':0,'Ready':False})
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps({'artifact':run(a.input,a.out),'Ready':False}))
