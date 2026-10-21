"""Register actually acquired full files in an isolated pending-review library.

No case provenance, artistic approval or production eligibility is manufactured.
This permits fact/phrase review before an original-use mapping is complete.
"""
import argparse,json,sqlite3,re
from pathlib import Path
from contextlib import closing
import bridge_original_candidates as bridge
import segment_library


def previous_decodes(reference):
    if not reference:return {},None
    bound=bridge.verify(reference);inventory=bridge.read_json(bound['path'])
    if inventory.get('status')!='full_files_registered_isolated_pending_review':raise ValueError('previous_pending_inventory_required')
    rows={}
    for row in inventory['recordings']:
        sha=row['source']['sha256']
        if sha in rows:raise ValueError('previous_inventory_duplicate_sha')
        rows[sha]=row
    return rows,bound


def reuse_previous_decode(row,source):
    receipt=bridge.verify(row['decode_receipt']);decoded=bridge.read_json(receipt['path'])
    if decoded.get('protocol')=='reuse_actual_acquisition_full_pcm16le_16k_mono_v1':
        origin=bridge.verify(decoded['acquisition_result']);result=bridge.read_json(origin['path'])
        recordings=[r for r in result.get('actual_recordings',[]) if r.get('source',{}).get('sha256')==source['sha256']]
        if result.get('full_recording_acquired') is not True or len(recordings)!=1:raise ValueError('previous_actual_acquisition_decode_binding_invalid')
        expected=acquisition_decode_view(recordings[0],origin,source)
        if (row['source']['sha256']!=source['sha256'] or decoded.get('source',{}).get('sha256')!=source['sha256']
                or any(decoded.get(field)!=expected[field] for field in ('pcm_sha256','pcm_bytes','decoded_samples_per_channel','sample_rate_hz','channels','decoded_duration_seconds','actual_audio_processed','actual_listening_performed','nonzero_pcm_bytes','new_decode_execution_performed','musical_or_plot_suitability_approved'))
                or row['duration']!=expected['decoded_duration_seconds']):raise ValueError('previous_actual_decode_identity_or_extent_invalid')
        return receipt,row['duration']
    samples=decoded.get('decoded_samples_per_channel',0);rate=decoded.get('sample_rate_hz',0)
    if (row['source']['sha256']!=source['sha256'] or decoded.get('source',{}).get('sha256')!=source['sha256']
            or decoded.get('protocol')!='ffmpeg_full_decode_pcm_f32le_48k_stereo_v1' or decoded.get('exit_code')!=0
            or decoded.get('actual_audio_processed') is not True or decoded.get('nonzero_pcm_bytes') is not True
            or not isinstance(samples,int) or samples<=0 or rate!=48000 or decoded.get('channels')!=2
            or decoded.get('pcm_bytes')!=samples*8 or not re.fullmatch('[a-f0-9]{64}',decoded.get('pcm_sha256',''))
            or abs(decoded.get('decoded_duration_seconds',0)-samples/rate)>1/rate
            or abs(row['duration']-samples/rate)>1/rate):raise ValueError('previous_actual_decode_identity_or_extent_invalid')
    return receipt,row['duration']


def acquisition_decode_view(recording,result_binding,source):
    pcm=recording.get('decoded_pcm',{});samples=pcm.get('sample_count',0);rate=pcm.get('sample_rate',0)
    executions=recording.get('decode_executions',[])
    if (recording.get('source',{}).get('sha256')!=source['sha256'] or recording.get('full_file_decode_success') is not True
            or recording.get('actual_audio_processed') is not True or recording.get('actual_audio_listened') is not False
            or pcm.get('protocol')!='actual_ffmpeg_complete_file_pcm16le_16000_mono' or rate!=16000
            or not isinstance(samples,int) or samples<=0 or not re.fullmatch('[a-f0-9]{64}',pcm.get('sha256',''))
            or abs(pcm.get('duration_seconds',0)-samples/rate)>1/rate
            or abs(recording.get('duration_seconds',0)-samples/rate)>1/rate
            or len(executions)!=2 or any(e.get('exit_code')!=0 or e.get('actual_subprocess_executed') is not True for e in executions)
            or executions[-1].get('stdout_sha256')!=pcm['sha256']):raise ValueError('actual_acquisition_full_pcm_decode_required')
    return {'schema_version':1,'source':source,'protocol':'reuse_actual_acquisition_full_pcm16le_16k_mono_v1',
            'acquisition_result':result_binding,'acquisition_decode_executions':executions,
            'actual_audio_processed':True,'actual_listening_performed':False,'new_decode_execution_performed':False,
            'pcm_sha256':pcm['sha256'],'pcm_bytes':samples*2,'decoded_samples_per_channel':samples,
            'sample_rate_hz':rate,'channels':1,'decoded_duration_seconds':samples/rate,'nonzero_pcm_bytes':None,
            'musical_or_plot_suitability_approved':False}


def stage(config):
    root=Path(config['output_dir']);root.mkdir(parents=True,exist_ok=False)
    with sqlite3.connect(Path(config['consumer_db']).resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.execute('BEGIN');rows=db.execute('SELECT task_key,payload FROM full_tasks').fetchall();db.rollback()
    previous,previous_binding=previous_decodes(config.get('previous_inventory'))
    files={};gaps=[];costs={'new_decode_calls':0,'previous_full_decode_reuses':0,'actual_acquisition_decode_reuses':0}
    for key,raw in rows:
        item=json.loads(raw)
        if not item.get('result'):continue
        result_binding=bridge.verify(item['result']);result=bridge.read_json(result_binding['path'])
        if result.get('full_recording_acquired') is not True:continue
        for recording in result.get('actual_recordings',[]):
            source=bridge.verify(recording['source']);sha=source['sha256']
            if sha in files:continue
            extent,_,gap=bridge.extent_status({'recording_extent':'full_recording','extent_evidence':result_binding},source)
            if extent!='full_recording':gaps.append({'task_key':key,'gap':gap});continue
            if sha in previous:
                receipt,duration=reuse_previous_decode(previous[sha],source);mode='previous_actual_full_decode';costs['previous_full_decode_reuses']+=1
            elif config.get('reuse_actual_acquisition_decode') is True:
                decoded=acquisition_decode_view(recording,result_binding,source);duration=decoded['decoded_duration_seconds']
                receipt=bridge.save(root/'decode'/ (sha+'.json'),decoded);mode='actual_acquisition_full_decode';costs['actual_acquisition_decode_reuses']+=1
            else:
                decoded=bridge.decode_recording(source);duration=decoded['decoded_duration_seconds']
                receipt=bridge.save(root/'decode'/ (sha+'.json'),decoded);mode='new_actual_full_decode';costs['new_decode_calls']+=1
            files[sha]={'source':source,'acquisition_result':result_binding,'decode_receipt':receipt,
                        'duration':duration,'task_key':key,'decode_origin':mode,
                        'media_type':recording.get('media_type'),'catalogue_version_relation':recording.get('catalogue_version_relation')}
    if previous and not set(previous).issubset(files):raise ValueError('previous_inventory_recordings_must_remain_present')
    assets=[];segments=[]
    for sha,row in files.items():
        asset='pending-full/'+sha;duration=row['duration']
        assets.append({'asset_id':asset,'asset_kind':'music','family_id':'recording/'+sha,
            'title':'pending full recording '+sha[:12],'local_path':row['source']['path'],
            'source_sha256':sha,'commercial_use_allowed':False,'listening_status':'pending',
            'tag_status':'research_pending','full_song_acquired':True,'Ready':False,
            'recording_origin_role':'unresolved_original_candidate','acquisition_result':row['acquisition_result'],
            'decode_receipt':row['decode_receipt'],'production_usable':False})
        # Representative analysis windows only; neither phrases nor approved uses.
        starts=sorted(set([0.0,max(0.0,duration/2-15),max(0.0,duration-30)]))
        for n,start in enumerate(starts):
            segments.append({'segment_id':asset+'/analysis-'+str(n),'asset_id':asset,'source_sha256':sha,
                'source_start_seconds':start,'source_end_seconds':min(duration,start+30),
                'phase':'unknown','vocal_presence':'unknown','narrative_functions':[],
                'listening_status':'pending','Ready':False,'window_kind':'analysis_only_not_phrase'})
    dbfile=root/'pending-full-library.sqlite'
    catalog=bridge.save(root/'assets.json',{'assets':assets})
    ranges=bridge.save(root/'analysis-windows.json',{'segments':segments})
    imported=segment_library.import_library(dbfile,catalog['path'],ranges['path'],rehash=True)
    record={'schema_version':1,'status':'full_files_registered_isolated_pending_review',
        'library':bridge.binding(dbfile),'consumer_source':str(config['consumer_db']),
        'unique_full_recording_sha256':len(files),'representative_analysis_windows':len(segments),
        'recordings':list(files.values()),'gaps':gaps,'import_report':imported,'production_usable':False,
        'previous_inventory':previous_binding,'costs':costs,
        'assets':catalog,'segments':ranges,'config_input':config,
        'implementation':bridge.binding(Path(__file__)),
        'strict_original_use_verified_by_this_stage':False,'Ready_packages':0,'model_calls':0,'new_user_trials':0}
    bridge.save(root/'inventory-receipt.json',record)
    print(json.dumps({k:record[k] for k in ('status','unique_full_recording_sha256','representative_analysis_windows','Ready_packages')},ensure_ascii=True))
    return record


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=Path,required=True);a=p.parse_args();stage(bridge.read_json(a.config))
