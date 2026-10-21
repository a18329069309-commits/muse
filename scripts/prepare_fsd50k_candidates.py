"""Frozen FSD50K label candidates, isolated holdout, then real-WAV pending imports.

No downloading. No labels establish clean audio, onset, emotion, or approval.
The official eval role is retained; the project partition is a separate role.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path

NAMESPACE='short-drama-sfx-fsd50k-eval-holdout-v1:'
RULE='uint64_be(SHA256(ASCII(namespace + canonical_decimal_clip_id))[0:8]) % 10000 < 2000'
ENVIRONMENT_ANCHORS={'Ocean','Waves_and_surf','Wind','Rain','Stream'}
ENVIRONMENT_LABELS=ENVIRONMENT_ANCHORS|{'Water','Liquid'}
CATEGORIES={
    'doors_furniture_household':set('Door Cupboard_open_or_close Doorbell Drawer_open_or_close Sliding_door Slam Dishes_and_pots_and_pans Cutlery_and_silverware Microwave_oven Domestic_sounds_and_home_sounds Clock Tick-tock'.split()),
    'body_foley_motion':set('Walk_and_footsteps Run Zipper_(clothing) Hands Finger_snapping Clapping Writing'.split()),
    'impacts_materials':set('Boom Crack Crackle Crushing Crumpling_and_crinkling Glass Shatter Thump_and_thud Tap Knock Coin_(dropping) Keys_jangling Packing_tape_and_duct_tape Tearing Scissors Wood Squeak Whoosh_and_swoosh_and_swish'.split()),
    'machines_transport_tools':set('Aircraft Fixed-wing_aircraft_and_airplane Boat_and_Water_vehicle Vehicle Motor_vehicle_(road) Car Car_passing_by Bus Truck Motorcycle Bicycle Train Rail_transport Subway_and_metro_and_underground Engine Engine_starting Idling Accelerating_and_revving_and_vroom Traffic_noise_and_roadway_noise Vehicle_horn_and_car_horn_and_honking Mechanical_fan Mechanisms Drill Hammer Sawing Ratchet_and_pawl Tools Power_tool Camera Computer_keyboard Typing Typewriter Printer Telephone Ringtone Alarm Siren Gunshot_and_gunfire Explosion Fireworks'.split()),
    'water_weather_fire':set('Water Liquid Drip Trickle_and_dribble Pour Fill_(with_liquid) Splash_and_splatter Stream Ocean Waves_and_surf Rain Raindrop Thunder Thunderstorm Wind Fire Frying_(food) Boiling Sink_(filling_or_washing) Bathtub_(filling_or_washing) Toilet_flush Water_tap_and_faucet'.split()),
    'animals_nature_environment':set('Animal Bird Bird_vocalization_and_bird_call_and_bird_song Chirp_and_tweet Cricket Crow Gull_and_seagull Insect Frog Dog Bark Cat Meow Purr Growling Domestic_animals_and_pets Livestock_and_farm_animals_and_working_animals Fowl Chicken_and_rooster Wild_animals'.split()),
    'human_nonverbal_or_crowd':set('Applause Cheering Crowd Chatter Human_group_actions Breathing Burping_and_eructation Chewing_and_mastication Cough Crying_and_sobbing Fart Gasp Giggle Laughter Chuckle_and_chortle Respiratory_sounds Screaming Sigh Sneeze Shout Yell Whispering'.split()),
}

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):
            h.update(block)
    return h.hexdigest()

def canonical_id(value):
    if not str(value).isdigit():
        raise ValueError('Freesound clip ID must be decimal')
    return str(int(value))

def partition(clip_id):
    digest=hashlib.sha256((NAMESPACE+canonical_id(clip_id)).encode('ascii')).digest()
    return 'model_eval_holdout' if int.from_bytes(digest[:8],'big')%10000<2000 else 'production_candidate_research'

def asset_kind_from_labels(labels):
    """Only a pure environment label set is an ambience candidate, never approval."""
    labels=set(labels)
    if labels.intersection(ENVIRONMENT_ANCHORS) and labels.issubset(ENVIRONMENT_LABELS):
        return 'ambience','pure_environment_label_candidate_pending_listening'
    return 'sfx','needs_classification_no_isolation_or_onset_evidence'

def build_plan(dataset):
    ground=dataset/'FSD50K.ground_truth/eval.csv'
    infofile=dataset/'FSD50K.metadata/eval_clips_info_FSD50K.json'
    info=json.loads(infofile.read_text(encoding='utf-8'))
    seen=set()
    entries=[]
    with ground.open(encoding='utf-8-sig',newline='') as stream:
        for raw in csv.DictReader(stream):
            clip_id=canonical_id(raw['fname'])
            if clip_id in seen:
                raise ValueError('duplicate eval clip ID')
            seen.add(clip_id)
            labels=raw['labels'].split(',')
            metadata=info.get(clip_id,{})
            categories=[name for name,values in CATEGORIES.items() if values.intersection(labels)]
            role=partition(clip_id)
            kind,classification=asset_kind_from_labels(labels)
            entries.append({'clip_id':clip_id,'official_split':'eval','project_role':role,'labels':labels,'mids':raw['mids'].split(','),'asset_kind_candidate':kind,'classification_status':classification,'physical_environment_categories_from_labels':categories,'category_basis':'official clip-level weak labels; not event onset or isolated recording','title':metadata.get('title'),'uploader':metadata.get('uploader'),'original_tags':metadata.get('tags',[]),'license_url':metadata.get('license'),'public_source_page':'https://freesound.org/s/'+clip_id+'/','candidate_for_pending_import':role=='production_candidate_research' and bool(categories),'listening_status':'pending','cleanliness':'unknown','event_onset_seconds':None,'production_use_approved':False,'actual_wav_decoded':False})
    return {'schema':'fsd50k-project-partition-and-candidates-v1','created_at':datetime.now(timezone.utc).isoformat(),'dataset_source':'https://zenodo.org/records/4060432','official_split':'eval','partition_namespace':NAMESPACE,'partition_rule':RULE,'partition_expected_holdout_fraction':0.2,'partition_is_project_role_not_official_train_val_split':True,'source_files':[{'path':str(p),'sha256':sha(p)} for p in [ground,infofile,dataset/'FSD50K.doc/README.md',dataset/'FSD50K.doc/LICENSE-DATASET']],'counts':{'metadata_clips':len(entries),'project_roles':dict(Counter(x['project_role'] for x in entries)),'physical_environment_label_candidates':sum(x['candidate_for_pending_import'] for x in entries),'candidate_asset_kinds':dict(Counter(x['asset_kind_candidate'] for x in entries if x['candidate_for_pending_import'])),'actual_wav_decoded':0,'imported_assets':0,'imported_segments':0,'qualified_approved':0},'entries':entries,'commercial_use_status':'not_approved; preserve each clip license; dataset publisher also requests contact for commercial use; no contact performed','isolation':'Holdout IDs are never emitted in material catalog. When audio is present, all holdout WAV SHA256 values must be scanned first and duplicate candidate hashes excluded.','limitations':['Weak labels can describe mixed recordings; no clean/stem/onset/dynamic approval inferred.','An ID split does not isolate uploaders or recording families. Do not claim independent benchmark generalization.','Metadata counts do not mean audio acquired or decoded.','Ambience candidates require only environment anchor/ancestor labels; any voice/music/single-event intersection stays sfx pending classification. No narrative sound-effect function is invented.']}

def decode_wav(path):
    import numpy as np
    import soundfile as sf
    before=path.stat()
    digest=sha(path)
    with sf.SoundFile(path) as stream:
        if stream.format!='WAV':
            raise ValueError('source must decode as WAV')
        rate,channels,frames=stream.samplerate,stream.channels,len(stream)
        subtype=stream.subtype
        if rate<=0 or channels<=0 or frames<=0:
            raise ValueError('invalid WAV metadata')
        peak=0.
        for block in stream.blocks(blocksize=rate,dtype='float64',always_2d=True):
            if not np.isfinite(block).all():
                raise ValueError('nonfinite WAV sample')
            peak=max(peak,float(np.max(np.abs(block))))
    duration=frames/rate
    if not math.isfinite(duration) or duration<=0:
        raise ValueError('invalid WAV duration')
    after=path.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or sha(path)!=digest:
        raise ValueError('WAV changed during decode')
    return {'source_sha256':digest,'duration_seconds':duration,'sample_rate_hz':rate,'channels':channels,'decoded_frames':frames,'wav_subtype':subtype,'sample_peak_linear':peak,'actual_wav_decoded':True,'cleanliness':'unknown','event_onset_seconds':None}

def decode_candidate(row,audio_dir,holdout_hashes):
    path=audio_dir/(row['clip_id']+'.wav')
    if not path.is_file():
        return row,None,'missing_candidate_wav'
    try:
        details=decode_wav(path)
    except (ValueError,RuntimeError,OSError):
        return row,None,'wav_decode_failed'
    if details['source_sha256'] in holdout_hashes:
        return row,None,'excluded_same_audio_sha256_as_holdout'
    return row,details,None

def pending_catalog(plan,audio_dir,workers=4):
    if type(workers) is not int or not 1<=workers<=4:
        raise ValueError('candidate decode workers must be between1and4')
    assets,segments,gaps=[],[],[]
    holdout_hashes=set()
    holdout_records=[]
    for row in plan['entries']:
        if row['project_role']!='model_eval_holdout':
            continue
        path=audio_dir/(row['clip_id']+'.wav')
        if not path.is_file():
            gaps.append({'clip_id':row['clip_id'],'status':'missing_holdout_wav_hash_isolation_incomplete'})
        else:
            digest=sha(path)
            holdout_hashes.add(digest)
            holdout_records.append({'clip_id':row['clip_id'],'source_sha256':digest})
    if gaps:
        return assets,segments,gaps,{'holdout_hash_scan_complete':False,'holdout_unique_audio_hashes':len(holdout_hashes),'holdout_records':holdout_records,'candidate_decode_count':0,'duplicate_holdout_hashes_excluded':0}
    decoded=0
    duplicates=0
    candidates=[r for r in plan['entries'] if r['candidate_for_pending_import'] and r['project_role']!='model_eval_holdout']
    # map retains source CSV order; worker threads never write output files or DB.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results=list(pool.map(lambda row:decode_candidate(row,audio_dir,holdout_hashes),candidates))
    for row,details,error in results:
        path=audio_dir/(row['clip_id']+'.wav')
        if error:
            gaps.append({'clip_id':row['clip_id'],'status':error})
            duplicates+=int(error=='excluded_same_audio_sha256_as_holdout')
            continue
        decoded+=1
        asset_id='fsd50k-eval-'+row['clip_id']
        kind,classification=asset_kind_from_labels(row['labels'])
        license_url=row.get('license_url') or ''
        license_name='CC0 1.0' if '/zero/' in license_url else 'CC BY 3.0' if '/by/3.0/' in license_url else 'CC BY 4.0' if '/by/4.0/' in license_url else 'CC BY-NC' if '/by-nc/' in license_url else 'CC Sampling+' if '/sampling+/' in license_url else 'unknown'
        asset={'asset_id':asset_id,'asset_kind':kind,'classification_status':classification,'family_id':'fsd50k-clip-'+row['clip_id'],'source_uploader':row.get('uploader'),'local_path':str(path.resolve()),'title':row.get('title') or asset_id,**details,'license':license_name,'license_url':license_url,'license_evidence':{'metadata_source_files':plan['source_files'],'clip_id':row['clip_id'],'uploader':row.get('uploader'),'license_url':license_url},'commercial_use_allowed':False,'production_use_approved':False,'official_split':'eval','project_role':row['project_role'],'project_partition_rule':RULE,'listening_status':'pending','tag_status':'official_weak_clip_labels_not_listening_approved','original_labels':row['labels'],'original_mids':row['mids'],'original_tags':row['original_tags'],'physical_environment_categories_from_labels':row['physical_environment_categories_from_labels'],'narrative_functions':[],'cleanliness':'unknown','onset_verified':False}
        assets.append(asset)
        # ffprobe reports seconds to six decimals; never exceed its source EOF.
        end=math.floor(details['duration_seconds']*1_000_000)/1_000_000
        segments.append({'segment_id':asset_id+'-whole-clip-pending','asset_id':asset_id,'source_sha256':details['source_sha256'],'source_start_seconds':0,'source_end_seconds':end,'source_end_quantization_seconds':details['duration_seconds']-end,'phase':'unlabelled','listening_status':'pending','vocal_presence':'unknown','tags':row['labels']+row['physical_environment_categories_from_labels'],'description':'Official weak clip-level labels: '+', '.join(row['labels']),'narrative_functions':[],'cleanliness':'unknown','onset_verified':False,'production_use_approved':False,'project_role':row['project_role']})
    return assets,segments,gaps,{'holdout_hash_scan_complete':True,'holdout_unique_audio_hashes':len(holdout_hashes),'holdout_records':holdout_records,'candidate_decode_count':decoded,'candidate_decode_count_including_excluded_duplicates':decoded+duplicates,'duplicate_holdout_hashes_excluded':duplicates}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-root',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--audio-dir',type=Path)
    parser.add_argument('--library-script',type=Path)
    args=parser.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError('new empty output directory required')
    args.out.mkdir(parents=True,exist_ok=True)
    plan=build_plan(args.dataset_root)
    plan['script']={'path':str(Path(__file__).resolve()),'sha256':sha(Path(__file__))}
    holdoutfile=args.out/'model-eval-holdout-ids.json'
    candidatefile=args.out/'physical-environment-candidates.jsonl'
    holdoutfile.write_text(json.dumps({'namespace':NAMESPACE,'rule':RULE,'official_split':'eval','clip_ids':[r['clip_id'] for r in plan['entries'] if r['project_role']=='model_eval_holdout']},indent=2)+'\n',encoding='utf-8')
    candidatefile.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in plan['entries'] if r['candidate_for_pending_import']),encoding='utf-8')
    plan['partition_outputs']=[{'path':str(p),'sha256':sha(p)} for p in [holdoutfile,candidatefile]]
    assets,segments,gaps,decode=[],[],[],{'status':'metadata_only_no_audio_dir','candidate_decode_count':0}
    if args.audio_dir:
        assets,segments,gaps,decode=pending_catalog(plan,args.audio_dir)
        hashfile=args.out/'model-eval-holdout-hashes.json'
        hashfile.write_text(json.dumps({'official_split':'eval','project_role':'model_eval_holdout','hash_scan_complete':decode['holdout_hash_scan_complete'],'records':decode.pop('holdout_records')},indent=2)+'\n',encoding='utf-8')
        plan['holdout_audio_hashes_file']={'path':str(hashfile),'sha256':sha(hashfile)}
    assetfile=args.out/'new-assets.json'
    segmentfile=args.out/'new-segments.json'
    assetfile.write_text(json.dumps({'assets':assets},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    segmentfile.write_text(json.dumps({'segments':segments},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    plan['actual_audio_decode_report']=decode
    plan['counts']['actual_wav_decoded']=len(assets)
    plan['gaps']=gaps
    if args.library_script:
        spec=importlib.util.spec_from_file_location('existing_segment_library',args.library_script)
        library=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(library)
        db=args.out/'pending-sfx-segments.sqlite'
        report=library.import_library(db,assetfile,segmentfile,rehash=True)
        plan['independent_schema_validation']={'library_script':{'path':str(args.library_script),'sha256':sha(args.library_script)},'db':{'path':str(db),'sha256':sha(db)},'report':report}
        plan['counts']['imported_assets']=report['imported_assets']
        plan['counts']['imported_segments']=report['imported_segments']
    path=args.out/'candidate-manifest.json'
    path.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'manifest':str(path),'sha256':sha(path),'counts':plan['counts'],'decode_report':decode,'gaps':len(gaps),'network_requests':0,'qualified':0}),flush=True)

if __name__=='__main__':
    main()
