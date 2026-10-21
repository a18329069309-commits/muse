"""Bounded real PCM/NCC curves using the existing pinned comparator, never approval.

python probe_original_identity_windows.py --input INPUT.json --out NEW_DIRECTORY
Each supplied window is processed once. Optional harmonic analysis is explicit.
Existing recording SHA and frozen library bindings remain separate from identity.
"""
import argparse,hashlib,importlib.util,json,math,re,shutil,sys,time
from datetime import datetime,timezone
from pathlib import Path
import numpy as np

HERE=Path(__file__).resolve().parent
WRAPPER=HERE/'reference_fingerprint/compare_recording_windows.py'
loader=importlib.util.spec_from_file_location('pinned_p2_comparator',WRAPPER)
comparison=importlib.util.module_from_spec(loader);loader.loader.exec_module(comparison)
SR=11025
def read(p):return json.loads(Path(p).read_text('utf-8-sig'))
def digest(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def bind(p):return {'path':str(Path(p).resolve()),'sha256':digest(p)}
def check(b):
 if not isinstance(b,dict) or not Path(b.get('path','')).is_absolute() or digest(b['path'])!=b.get('sha256'):raise ValueError('bound_P2_source_changed')
 return Path(b['path'])
def write(p,v):
 with Path(p).open('x',encoding='utf-8') as f:json.dump(v,f,ensure_ascii=False,indent=2,allow_nan=False)
 return bind(p)
def pcm(p,samples):
 with Path(p).open('xb') as f:np.asarray(samples,dtype='<f8').tofile(f)
 return {**bind(p),'sample_count':len(samples),'bytes':len(samples)*8,'encoding':'float64_little_endian','dtype':'<f8','channels':1,'sample_rate':SR,'bandpass_hz':[120,5000]}
def measured(scores,source,query,start):
 peak=int(np.argmax(np.abs(scores)));radius=len(query);mask=np.ones(len(scores),dtype=bool)
 mask[max(0,peak-radius):min(len(mask),peak+radius+1)]=False;other=np.abs(scores[mask])
 a=query-query.mean();b=source[peak:peak+len(query)];b=b-b.mean();dot=float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)))
 if abs(dot-float(scores[peak]))>1e-7:raise ValueError('actual_PCM_dot_and_curve_peak_disagree')
 return {'variant':'original_bandpass','status':'measured','query_start_maps_to_source_seconds':start+peak/SR,
  'query_end_maps_to_source_seconds':start+(peak+len(query))/SR,'best_absolute_ncc':float(abs(scores[peak])),
  'other_positions_abs_p99':float(np.quantile(other,.99)) if len(other) else None,'independent_background_positions':len(other)},peak,dot
def run(input_file,out):
 started=time.perf_counter();spec=read(input_file);out=Path(out);out.mkdir(parents=True,exist_ok=False)
 if spec.get('schema_version')!=1 or not 1<=len(spec.get('assets',[]))<=20 or not 1<=len(spec.get('queries',[]))<=10:raise ValueError('bounded_P2_assets_and_queries_required')
 library=read(check(spec['library']));library_shas={a['source']['sha256'] for a in library['recordings']}
 if spec['positive_source_sha256'] not in library_shas:raise ValueError('positive_must_be_existing_frozen_music_recording')
 module,provenance=comparison.load_upstream();sources={};source_rows=[]
 def load(source,bounds):
  check(source);comparison.valid_range(bounds)
  samples=np.asarray(module.load_audio(Path(source['path']),SR,120,5000,bounds[0],bounds[1]-bounds[0]),dtype='<f8')
  if len(samples)!=math.floor((bounds[1]-bounds[0])*SR+.5) or not np.isfinite(samples).all():raise ValueError('actual_P2_PCM_extent_or_finiteness_invalid')
  check(source);return samples
 ids=set()
 for i,asset in enumerate(spec['assets']):
  if not re.fullmatch('[A-Za-z0-9_.-]{1,80}',asset['asset_id']) or asset['asset_id'] in ids:raise ValueError('unique_safe_asset_id_required')
  ids.add(asset['asset_id']);bounds=asset['source_range']
  if bounds[1]-bounds[0]>120:raise ValueError('bounded_source_search_max120_seconds')
  samples=load(asset['source'],bounds);sources[asset['asset_id']]=samples
  source_rows.append({'asset_id':asset['asset_id'],'source':asset['source'],'source_range':bounds,'pcm':pcm(out/('source-'+str(i)+'.f64le'),samples)})
 queries=[];results=[]
 for index,item in enumerate(spec['queries']):
  bounds=item['source_window_seconds'];comparison.valid_range(bounds)
  if bounds[1]-bounds[0]>10:raise ValueError('P2_query_max10_seconds')
  original=load(item['reference_video'],bounds);query_pcm=pcm(out/('query-'+str(index)+'.f64le'),original)
  if np.linalg.norm(original-original.mean())<1e-10:raise ValueError('P2_query_has_no_variance')
  candidates=[];rows=[]
  for j,asset in enumerate(spec['assets']):
   source=sources[asset['asset_id']]
   if len(source)<len(original):raise ValueError('source_search_shorter_than_query')
   scores=module.sliding_ncc(source,original);summary,peak,dot=measured(scores,source,original,asset['source_range'][0])
   file=out/('curve-'+str(index)+'-'+str(j)+'.npz')
   with file.open('xb') as f:np.savez_compressed(f,ncc=np.asarray(scores,dtype='<f8'))
   row={'asset_id':asset['asset_id'],'path':asset['source']['path'],'sha256':asset['source']['sha256'],'source_range':asset['source_range'],'comparisons':[summary]}
   candidates.append(row);rows.append({**source_rows[j],'full_array':bind(file),'full_array_key':'ncc','curve_sample_count':len(scores),'peak_sample_index':peak,
    'peak_source_seconds':summary['query_start_maps_to_source_seconds'],'signed_peak_ncc':float(scores[peak]),'actual_pcm_peak_dot_ncc':dot})
  raw={'schema_version':1,'operation':'candidate_recording_comparison','query':item['reference_video']['path'],'query_sha256':item['reference_video']['sha256'],
   'source_range':bounds,'sample_rate':SR,'bandpass_hz':[120,5000],'upstream_revision':provenance['revision'],'candidates':candidates,'identity_verified':False}
  result=write(out/('comparison-'+str(index)+'.json'),raw)
  queries.append({'query_id':item['query_id'],'query_range':bounds,'query_source':item['reference_video'],'query_raw_source':item['reference_video'],
   'query_pcm':query_pcm,'raw_comparison_result':result,'query_clock':'decoded_source_audio_zero_start_samples','candidates':[{**r,'raw_comparison_result':result} for r in rows]})
  results.append({'query_id':item['query_id'],'reference':item['reference_video'],'range':bounds,'actual_comparison':result,
   'matches':[{**a['comparisons'][0],'source_sha256':a['sha256'],'asset_id':a['asset_id']} for a in candidates]})
 controls=[]
 for asset in spec['assets']:
  if asset.get('control_kind'):
   if asset.get('control_origin_evidence'):check(asset['control_origin_evidence'])
   controls.append({'kind':asset['control_kind'],'source':asset['source'],'source_range':asset['source_range'],'basis':asset.get('control_origin_evidence')})
 manifest={'schema_version':1,'operation':'pinned_bandpass_pcm_for_ncc_v1','created_at_utc':datetime.now(timezone.utc).isoformat(),'producer':bind(__file__),
  'upstream':bind(WRAPPER.parent/'candidate_upstream/compare_candidate.py'),'upstream_provenance':bind(WRAPPER.parent/'candidate_upstream/UPSTREAM.json'),
  'upstream_revision':provenance['revision'],'comparison_wrapper':bind(WRAPPER),'verification_producer':bind(HERE/'verify_reference_identity_derivatives.py'),
  'python_binary':bind(sys.executable),'ffmpeg_binary':bind(shutil.which('ffmpeg')),'sample_rate':SR,'bandpass_hz':[120,5000],
  'dtype':'<f8','queries':queries,'candidates':source_rows,'controls':controls,'actual_audio_processed':True,'actual_audio_listened':False,
  'identity_verified':False,'production_approval':False,'http_calls':0,'model_calls':0}
 p=write(out/'pinned-pcm-curves.json',manifest)
 result={'schema_version':1,'input':bind(input_file),'library':spec['library'],'PCM_curves':p,'results':results,
  'strict_machine_identity_status':'not_evaluated_missing_or_pending_required_evidence','actual_audio_processed':True,'actual_audio_listened':False,
  'new_curve_count':len(queries)*len(source_rows),'HTTP_calls':0,'model_calls':0,'Ready':False,'wall_seconds':time.perf_counter()-started}
 return write(out/'local-probe-result.json',result),result
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 artifact,result=run(a.input,a.out);print(json.dumps({'artifact':artifact,'new_curves':result['new_curve_count'],'wall_seconds':result['wall_seconds'],'Ready':False}))
