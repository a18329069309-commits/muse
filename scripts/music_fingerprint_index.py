"""Incremental SHA-addressed local music fingerprints and one-load batch query.

build --input CATALOG.json --cache CACHE --out NEW_VERSION [--previous MANIFEST]
query --input QUERIES.json --cache CACHE --out NEW_RESULTS
No provider HTTP, models, render, listening, original-use or Ready approval.
"""
import argparse
from datetime import datetime,timezone
import hashlib,json,math,os,shutil,subprocess,sys,time
from pathlib import Path
import numpy as np

HERE=Path(__file__).parent
sys.path.insert(0,str(HERE/'reference_fingerprint'))
import reference_fingerprint as fp

PARAMS={'revision':'music-centric-sha-index-v1','upstream_commit':fp.UPSTREAM_SHA,'sample_rate':fp.SR,'density':20,'index_shifts':1,
        'query_shifts':4,'span_max_seconds':120,'span_overlap_seconds':10,'hashbits':18,'depth':20}

def now():return datetime.now(timezone.utc).isoformat()
def read(p):return json.loads(Path(p).read_text('utf-8-sig'))
def digest(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def bind(p):return {'path':str(Path(p).resolve()),'sha256':digest(p)}
def checked(r):
 if digest(r['path'])!=r['sha256']:raise ValueError('music_index_bound_input_changed')
 return read(r['path'])
def put(p,v):
 with Path(p).open('x',encoding='utf-8') as f:json.dump(v,f,ensure_ascii=False,indent=2,allow_nan=False)
 return bind(p)
def stat(p):
 s=Path(p).stat();return {'path':str(Path(p).resolve()),'size':s.st_size,'mtime_ns':s.st_mtime_ns}
def key(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

PARAMS['implementation_sources']={name:digest(HERE/'reference_fingerprint'/name) for name in
 ('reference_fingerprint.py','upstream/UPSTREAM.json','upstream/audfprint_analyze.py','upstream/audfprint_match.py','upstream/hash_table.py','upstream/stft.py','upstream/audio_read.py')}

def spans(sample_count,hop=256):
 """Local time frames prevent audfprint default maxtime16384 wrapping long songs."""
 count=max(1,math.ceil(sample_count/hop));width=math.floor(120*fp.SR/hop);overlap=math.ceil(10*fp.SR/hop);step=width-overlap
 result=[];start=0
 while start<count:
  end=min(count,start+width)
  result.append({'start_frame':start,'end_frame':end,'source_start_seconds':start*hop/fp.SR,
                 'source_end_seconds':min(sample_count/fp.SR,end*hop/fp.SR),'source_offset_seconds':start*hop/fp.SR})
  if end==count:break
  start+=step
 return result

def decode(source,path,window=None):
 cmd=['ffmpeg','-nostdin','-v','error','-xerror','-n','-i',source['path'],'-map','0:a:0','-vn','-sn','-dn','-ac','1']
 if window:
  a,b=[round(x*fp.SR) for x in window];f=f'aresample={fp.SR},atrim=start_sample={a}:end_sample={b},asetpts=PTS-STARTPTS'
 else:f=f'aresample={fp.SR},asetpts=PTS-STARTPTS'
 cmd+=['-af',f,'-ar',str(fp.SR),'-c:a','pcm_s16le',str(path)]
 start=time.perf_counter();p=subprocess.run(cmd,capture_output=True,timeout=300)
 if p.returncode:raise ValueError('actual_local_pcm_decode_failed')
 return {'argv':cmd,'exit_code':0,'wall_seconds':time.perf_counter()-start,'ffmpeg':bind(shutil.which('ffmpeg')),
         'stderr_sha256':hashlib.sha256(p.stderr).hexdigest(),'PCM':bind(path),'range_coordinate':'decoded_audio_zero_start_samples',
         'actual_audio_processed':True,'actual_audio_listened':False}

def cache_recording(asset,cache,analyzer):
 source=asset['source'];root=cache/'recordings'/key({'sha':source['sha256'],'parameters':PARAMS});manifest=root/'cache.json'
 before=stat(source['path'])
 if manifest.exists():
  cached=read(manifest)
  if cached['source']['sha256']!=source['sha256'] or cached['parameters']!=PARAMS:raise ValueError('fingerprint_cache_identity_conflict')
  if cached['source_stat']!=before and digest(source['path'])!=source['sha256']:raise ValueError('changed_recording_invalidates_cache')
  for field in ('PCM','hashes'):checked_file=cached[field];assert digest(checked_file['path'])==checked_file['sha256']
  return cached,{'cache_hit':True,'decode_calls':0,'fingerprint_build_calls':0,'decode_seconds':0,'fingerprint_seconds':0}
 if digest(source['path'])!=source['sha256']:raise ValueError('real_recording_sha_required')
 root.mkdir(parents=True,exist_ok=False);execution=decode(source,root/'full-analysis.wav')
 wave,_=fp.librosa.load(str(root/'full-analysis.wav'),sr=fp.SR,mono=True)
 start=time.perf_counter();hashes=fp.fingerprint(analyzer,wave,shifts=1);elapsed=time.perf_counter()-start
 np.save(root/'landmarks.npy',hashes,allow_pickle=False)
 if stat(source['path'])!=before or digest(source['path'])!=source['sha256']:raise ValueError('recording_changed_while_precomputing')
 cached={'schema_version':1,'source':source,'source_stat':before,'parameters':PARAMS,'PCM':execution['PCM'],'hashes':bind(root/'landmarks.npy'),
         'sample_count':len(wave),'sample_rate':fp.SR,'decoded_duration_seconds':len(wave)/fp.SR,'hash_count':len(hashes),'decode_execution':execution,
         'fingerprint_wall_seconds':elapsed,'created_at_utc':now(),'actual_audio_listened':False,'Ready':False}
 put(manifest,cached)
 return cached,{'cache_hit':False,'decode_calls':1,'fingerprint_build_calls':1,'decode_seconds':execution['wall_seconds'],'fingerprint_seconds':elapsed}

def build(input_file,cache,out,previous=None):
 started=time.perf_counter();catalog=read(input_file)
 if catalog.get('schema_version')!=1 or not catalog.get('recordings'):raise ValueError('explicit_real_recording_catalogue_required')
 cache=Path(cache);out=Path(out);out.mkdir(parents=True,exist_ok=False)
 analyzer=fp.audfprint_analyze.Analyzer(density=20);assets=[];costs=[];seen=set()
 for asset in catalog['recordings']:
  if asset['source']['sha256'] in seen:continue
  seen.add(asset['source']['sha256']);record,cost=cache_recording(asset,cache,analyzer);costs.append(cost)
  record_id='recording-sha256:'+asset['source']['sha256'];asset_spans=[]
  for span in spans(record['sample_count'],analyzer.n_hop):
   asset_spans.append({**span,'index_name':record_id+':'+str(span['start_frame'])+'-'+str(span['end_frame'])})
  assets.append({'recording_id':record_id,'source':asset['source'],'source_duration_seconds':record['decoded_duration_seconds'],
                 'recording_cache':bind(Path(record['hashes']['path']).parent/'cache.json'),'spans':asset_spans,
                 'metadata_context':asset.get('metadata_context'),'identity_verified':False,'Ready':False})
 if previous:
  old=read(previous)
  if old['parameters']!=PARAMS:raise ValueError('incremental_library_parameters_changed')
  old_ids={a['recording_id'] for a in old['recordings']}
  if not old_ids.issubset({a['recording_id'] for a in assets}):raise ValueError('incremental_snapshot_must_preserve_previous_recordings')
  if digest(old['index']['path'])!=old['index']['sha256']:raise ValueError('previous_frozen_library_index_changed')
  table=fp.hash_table.HashTable(old['index']['path']);loads=1
 else:table=fp.hash_table.HashTable(hashbits=18,depth=20);loads=0
 store_count=0;index_started=time.perf_counter()
 for asset in assets:
  record=checked(asset['recording_cache']);hashes=np.load(record['hashes']['path'],allow_pickle=False)
  for span in asset['spans']:
   if span['index_name'] in table.names:continue
   subset=hashes[(hashes[:,0]>=span['start_frame'])&(hashes[:,0]<span['end_frame'])].copy();subset[:,0]-=span['start_frame']
   if len(subset) and int(subset[:,0].max())>=16384:raise ValueError('audfprint_time_wrap_not_allowed')
   table.store(span['index_name'],subset);store_count+=1
 table.save(str(out/'recordings.pklz'));index_seconds=time.perf_counter()-index_started
 manifest={'schema_version':1,'kind':'frozen_music_sha_fingerprint_library','created_at_utc':now(),'parameters':PARAMS,'recordings':assets,'index':bind(out/'recordings.pklz'),
           'input':bind(input_file),'previous_library':bind(previous) if previous else None,'unique_recording_sha_count':len(assets),'time_frames_are_span_local':True,
           'incremental_hash_bucket_policy':'old snapshot preserved; audfprint reservoir may replace crowded bucket entries in the new snapshot, so old match scores are not asserted invariant',
           'time_wrap_guard_max_frames':16384,'costs':{'recording_decode_calls':sum(c['decode_calls'] for c in costs),'recording_fingerprint_build_calls':sum(c['fingerprint_build_calls'] for c in costs),
           'recording_cache_hits':sum(c['cache_hit'] for c in costs),'index_loads':loads,'new_span_stores':store_count,'decode_seconds':sum(c['decode_seconds'] for c in costs),
           'fingerprint_seconds':sum(c['fingerprint_seconds'] for c in costs),'index_store_and_save_seconds':index_seconds,'total_wall_seconds':time.perf_counter()-started},
           'actual_audio_listened':False,'original_identity_verified':False,'Ready':False,'provider_requests':0,'models_installed':0,'new_trials':0}
 return put(out/'library-manifest.json',manifest),manifest

def query(input_file,cache,out):
 started=time.perf_counter();spec=read(input_file);manifest=checked(spec['library']);out=Path(out);out.mkdir(parents=True,exist_ok=False);cache=Path(cache)
 if manifest['parameters']!=PARAMS:raise ValueError('query_library_parameters_changed')
 if digest(manifest['index']['path'])!=manifest['index']['sha256']:raise ValueError('frozen_library_index_changed')
 t=time.perf_counter();table=fp.hash_table.HashTable(manifest['index']['path']);load_seconds=time.perf_counter()-t
 analyzer=fp.audfprint_analyze.Analyzer(density=20);matcher=fp.audfprint_match.Matcher();matcher.window=2;matcher.exact_count=True;matcher.find_time_range=True
 lookup={s['index_name']:(a,s) for a in manifest['recordings'] for s in a['spans']};verified_sources={};results=[];decode_calls=0;decode_seconds=0;match_seconds=0;fingerprint_calls=0;fingerprint_seconds=0
 for item in spec['queries']:
  source=item['reference_video'];window=item['source_window_seconds']
  if len(window)!=2 or not 0<=window[0]<window[1] or window[1]-window[0]>10:raise ValueError('bounded_real_query_window_required')
  if source['sha256'] not in verified_sources:
   if digest(source['path'])!=source['sha256']:raise ValueError('query_original_source_changed')
   verified_sources[source['sha256']]=stat(source['path'])
  qroot=cache/'queries'/key({'source':source['sha256'],'window':window,'parameters':PARAMS});qfile=qroot/'query-cache.json'
  if qfile.exists():
   q=read(qfile);assert q['source']['sha256']==source['sha256'] and q['source_window_seconds']==window
   assert digest(q['PCM']['path'])==q['PCM']['sha256']
   assert digest(q['hashes']['path'])==q['hashes']['sha256']
   hashes=np.load(q['hashes']['path'],allow_pickle=False)
  else:
   qroot.mkdir(parents=True,exist_ok=False);execution=decode(source,qroot/'original-mix.wav',window)
   wave,_=fp.librosa.load(execution['PCM']['path'],sr=fp.SR,mono=True)
   if abs(len(wave)/fp.SR-(window[1]-window[0]))>.05:raise ValueError('query_window_extends_past_real_audio')
   t=time.perf_counter();hashes=fp.fingerprint(analyzer,wave,shifts=4);fingerprint_seconds+=time.perf_counter()-t;fingerprint_calls+=1
   np.save(qroot/'landmarks.npy',hashes,allow_pickle=False)
   q={'source':source,'source_window_seconds':window,'parameters':PARAMS,'PCM':execution['PCM'],'hashes':bind(qroot/'landmarks.npy'),'execution':execution,'derivative_kind':'original mix analysis, not music master'};put(qfile,q)
   decode_calls+=1;decode_seconds+=execution['wall_seconds']
  t=time.perf_counter();raw=matcher.match_hashes(table,hashes);match_seconds+=time.perf_counter()-t;matches=[]
  for r in raw:
   a,span=lookup[table.names[int(r[0])]];offset=float(r[2])*analyzer.n_hop/fp.SR+span['source_offset_seconds']
   matches.append({'recording_id':a['recording_id'],'source':a['source'],'index_span':span,'query_start_maps_to_source_seconds':offset,
                   'reference_to_recording_offset_seconds':offset-window[0],'consistent_hash_count':int(r[1]),'raw_shared_hash_count':int(r[3]),
                   'matched_query_support_seconds':[float(r[5])*analyzer.n_hop/fp.SR,float(r[6])*analyzer.n_hop/fp.SR]})
  results.append({'query_id':item['query_id'],'reference_video':source,'source_window_seconds':window,'actual_query_PCM':q['PCM'],
                  'query_derivative_evidence':bind(qfile),'query_hash_count':len(hashes),'matches':matches,
                  'expected_recording_id_for_control':item.get('expected_recording_id'),'neighbor_group':item.get('neighbor_group'),'identity_verified':False,'Ready':False})
 for source in spec['queries']:
  s=source['reference_video'];assert stat(s['path'])==verified_sources[s['sha256']]
 result={'schema_version':1,'kind':'actual_one_load_local_music_batch_query','created_at_utc':now(),'library':spec['library'],'input':bind(input_file),'queries':results,
         'costs':{'recording_build_calls':0,'index_loads':1,'index_load_seconds':load_seconds,'new_query_decode_calls':decode_calls,'query_decode_seconds':decode_seconds,
                  'query_fingerprint_calls':fingerprint_calls,'query_fingerprint_seconds':fingerprint_seconds,'whole_reference_source_sha_checks':len(verified_sources),
                  'matching_seconds':match_seconds,'total_wall_seconds':time.perf_counter()-started},
         'incorrect_recording_controls_available':len(manifest['recordings'])>=2,'neighbor_controls_metadata_retained':True,
         'source_cleanliness':'unassessed','lyrics_verified':False,'original_identity_verified':False,'Ready':False,'provider_requests':0,'models_installed':0,'new_trials':0}
 return put(out/'batch-query-result.json',result),result

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='operation',required=True)
 for name in ('build','query'):
  q=s.add_parser(name);q.add_argument('--input',type=Path,required=True);q.add_argument('--cache',type=Path,required=True);q.add_argument('--out',type=Path,required=True)
 s.choices['build'].add_argument('--previous',type=Path);a=p.parse_args()
 artifact,result=build(a.input,a.cache,a.out,a.previous) if a.operation=='build' else query(a.input,a.cache,a.out)
 print(json.dumps({'artifact':artifact,'costs':result['costs'],'Ready':False},ensure_ascii=False))
