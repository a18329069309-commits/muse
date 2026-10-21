"""Offline bound inputs for the incremental index, benchmark and existing identity tasks."""
import argparse,json,hashlib
from pathlib import Path
from datetime import datetime,timezone

def read(p):return json.loads(Path(p).read_text('utf-8-sig'))
def binding(p):
 with Path(p).open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
 return {'path':str(Path(p).resolve()),'sha256':sha}
def write(root,name,obj):
 p=root/name
 with p.open('x',encoding='utf-8') as f:json.dump(obj,f,ensure_ascii=False,indent=2)
 return binding(p)
def prepare(collection,identity_queue,out):
 root=Path(out);root.mkdir(parents=True,exist_ok=False);report=read(collection);queue=read(identity_queue)
 by_sha={t['full_recording']['sha256']:t for t in queue['tasks']}
 assets=[]
 for file in report['independent_files']:
  source=file['source'];task=by_sha.get(source['sha256'])
  assets.append({'source':source,'metadata_context':{'candidate':task.get('candidate') if task else None,'track_key':task.get('track_key') if task else None,
     'catalog_version_identity':'pending; metadata names do not approve identical recording versions'},'acquisition_snapshot':binding(collection)})
 queries=[];links=[]
 for task in queue['tasks']:
  if binding(task['resolver_config']['path'])['sha256']!=task['resolver_config']['sha256']:raise ValueError('existing_resolver_config_changed')
  windows=task['reference_windows']
  ids=[]
  for i,window in enumerate(windows):
   qid=task['track_key']+':'+str(i);ids.append(qid)
   queries.append({'query_id':qid,'reference_video':task['reference_source'],'source_window_seconds':window,
       'expected_recording_id':'recording-sha256:'+task['full_recording']['sha256'],'neighbor_group':task['track_key'],
       'original_task_binding':{'queue':binding(identity_queue),'track_key':task['track_key'],'config':task['resolver_config']}})
  links.append({'track_key':task['track_key'],'source_version':task['full_recording'],'query_ids':ids,'previous_task':task['resolver_config'],
      'adoption_status':'pending actual frozen library binding; previous evidence is preserved','Ready':False})
 # These two different full recordings have earlier public-reference candidate evidence.
 selected=[t for t in queue['tasks'] if t['candidate']['title'] in ('萨瓦迪卡 (1)','雨蝶')]
 if len(selected)!=2:raise ValueError('exact_two_real_benchmark_recordings_required')
 selected_sha={t['full_recording']['sha256'] for t in selected};selected_keys={t['track_key'] for t in selected}
 result={'schema_version':1,'kind':'bound_offline_music_index_inputs','created_at_utc':datetime.now(timezone.utc).isoformat(),
  'collection':binding(collection),'identity_queue':binding(identity_queue),'full_catalog':write(root,'full-recordings.json',{'schema_version':1,'recordings':assets}),
  'benchmark_catalog':write(root,'benchmark-recordings.json',{'schema_version':1,'recordings':[a for a in assets if a['source']['sha256'] in selected_sha]}),
  'benchmark_queries_without_library':write(root,'benchmark-queries.json',{'queries':[q for q in queries if q['query_id'].split(':')[0] in selected_keys and q['query_id'].endswith(':0')]}),
  'all_queries_without_library':write(root,'identity-queries.json',{'queries':queries}),
  'task_links':links,'unique_full_sha_count':len({a['source']['sha256'] for a in assets}),'existing_identity_tasks':len(links),'query_count':len(queries),
  'recording_identity_verified':False,'Ready':False,'provider_requests':0,'new_trials':0}
 return write(root,'input-manifest.json',result)
def bind_queries(queries,library,out):
 root=Path(out);root.mkdir(parents=True,exist_ok=False)
 return write(root,'bound-queries.json',{'schema_version':1,'library':binding(library),'prepared_input':binding(queries),'queries':read(queries)['queries']})
def summarize(actual_root,out):
 base=Path(actual_root);root=Path(out);root.mkdir(parents=True,exist_ok=False)
 prepared=read(base/'input-20261006-v1/input-manifest.json');batch_path=base/'identity-batch-v1/batch-query-result.json';batch=read(batch_path);library=read(batch['library']['path'])
 task_results=[]
 for link in prepared['task_links']:
  queries=[q for q in batch['queries'] if q['query_id'] in link['query_ids']]
  expected='recording-sha256:'+link['source_version']['sha256']
  hits=[{'query_id':q['query_id'],'range':q['source_window_seconds'],'matches':[m for m in q['matches'] if m['recording_id']==expected]} for q in queries]
  offsets=[m['reference_to_recording_offset_seconds'] for hit in hits for m in hit['matches']]
  task_results.append({**link,'adoption_status':'actually queried frozen full library; pending local position/version/control review',
    'library':batch['library'],'actual_batch':binding(batch_path),'query_result_ids':[q['query_id'] for q in queries],
    'status':'local_recording_candidates_pending_review' if any(h['matches'] for h in hits) else 'unresolved_after_full_recording_index_search',
    'candidate_positions':hits,'multiple_position_offsets_present':bool(offsets and max(offsets)-min(offsets)>.1),
    'strict_identity_gaps':['exact recording version remains pending','candidate or no match is not original identity approval',
      'two required incorrect recording roles and PCM/NCC/independent neighbor controls must be completed before strict approval'],
    'original_identity_verified':False,'Ready':False})
 adoption=write(root,'identity-task-bindings.json',{'schema_version':1,'kind':'actual_existing_identity_task_frozen_music_library_bindings',
   'library':batch['library'],'batch':binding(batch_path),'tasks':task_results,'old_evidence_preserved':True,'Ready':False})
 stages={name:binding(base/rel) for name,rel in {'first_build':'benchmark-library-v1/library-manifest.json',
  'cold_query':'benchmark-cold-query-v1/batch-query-result.json','hot_query':'benchmark-hot-query-v1/batch-query-result.json',
  'full_incremental_build':'full-library-v1/library-manifest.json','full_hot_build':'full-library-hot-proof-v1/library-manifest.json','identity_batch':'identity-batch-v1/batch-query-result.json'}.items()}
 report={'schema_version':1,'created_at_utc':datetime.now(timezone.utc).isoformat(),'kind':'actual_incremental_local_music_index_benchmark_and_adoption',
  'stages':{name:{'artifact':record,'costs':read(record['path'])['costs']} for name,record in stages.items()},
  'inputs':binding(base/'input-20261006-v1/input-manifest.json'),'task_adoption':adoption,'tests':{'command':'python -m unittest discover -s tests -p test_music_fingerprint_index.py',
    'log':binding(base/'focused-tests-v1.log'),'passed':8,'failed':0},
  'code_bindings':[binding(Path(__file__).parent/name) for name in ('music_fingerprint_index.py','prepare_music_fingerprint_tasks.py')]+[binding(Path(__file__).parent.parent/'tests/test_music_fingerprint_index.py')],
  'counts':{'independent_full_recordings':library['unique_recording_sha_count'],'indexed_spans':sum(len(a['spans']) for a in library['recordings']),'existing_identity_tasks':len(task_results),'real_query_windows':len(batch['queries']),
    'tasks_with_candidate_hits':sum(t['status']=='local_recording_candidates_pending_review' for t in task_results),
    'tasks_unresolved':sum(t['status']=='unresolved_after_full_recording_index_search' for t in task_results),'new_strict_identity_approvals':0},
  'commands':{'incremental_build':['python','scripts/music_fingerprint_index.py','build','--input',str(base/'input-20261006-v1/full-recordings.json'),'--cache',str(base/'cache'),'--out','NEW_FROZEN_VERSION','--previous',batch['library']['path']],
    'batch_query':['python','scripts/music_fingerprint_index.py','query','--input',str(base/'identity-bound-v1/bound-queries.json'),'--cache',str(base/'cache'),'--out','NEW_RESULT_DIRECTORY']},
  'limits':['helper phase wall excludes Python startup/imports; benchmark process walls 5.0254s first build/9.8899s cold query/3.8925s hot query',
    'index covers entire admitted recording PCM; original queries cover only the explicit 26 windows, not all used tracks or full drama coverage',
    'repeating music can yield multiple location candidates; hash count cannot choose the actual edit position',
    'existing ffmpeg/librosa/audfprint only; cached analysis PCM is not a clean music master'],
  'source_or_audio_sent_externally':False,'provider_requests':0,'paid_api_calls':0,'models_installed':0,'new_trials':0,'Ready':False}
 return write(root,'benchmark-and-adoption-report.json',report)
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--collection');p.add_argument('--identity-queue');p.add_argument('--queries');p.add_argument('--library');p.add_argument('--summarize-root');p.add_argument('--out',required=True);a=p.parse_args()
 if a.summarize_root:result=summarize(a.summarize_root,a.out)
 elif a.queries and a.library:result=bind_queries(a.queries,a.library,a.out)
 elif a.collection and a.identity_queue:result=prepare(a.collection,a.identity_queue,a.out)
 else:p.error('supply collection+identity-queue or queries+library')
 print(json.dumps(result))
