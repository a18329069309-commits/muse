"""Bind existing first-ten native media to just-in-time anonymous inspection.

This prepares actual source tasks, not public-source qualification or a download.
Research and heldout manifests are separate and retain the entire frozen scope.
"""
import argparse
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit

spec=importlib.util.spec_from_file_location('discovery',Path(__file__).with_name('run_original_discovery.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)


def build(pointer, decode_binding, output, split='research'):
    ledger=d.checked(pointer['coverage_ledger']);d.checked(decode_binding)
    works=ledger['works']
    if len(works)!=115 or sum(w['screenshot_episode_count'] for w in works)!=8926 \
            or sum(len(w['slots']) for w in works)!=1145:
        raise ValueError('full_scope_required')
    if split not in ('research','heldout'):raise ValueError('isolated_split_required')
    out=Path(output);out.mkdir(parents=True,exist_ok=False);tasks=[];gaps=[]
    for work in works:
        if work['split_preserved']!=split:continue
        for slot in work['slots']:
            media=slot.get('primary_canonical_media')
            if not media or media.get('source_platform')!='hongguo':continue
            try:
                source=Path(media['source_video']);receipt_path=source.parent/'source-receipt.json'
                receipt=d.read(receipt_path)
                if media.get('orientation')!='vertical' or media.get('confirmed_catalogue_episode') is not True:
                    raise ValueError('canonical_portrait_reference_required')
                if receipt.get('source_video',{}).get('sha256')!=media['source_sha256']:
                    raise ValueError('native_original_receipt_source_changed')
                series=str(media['platform_series_id']);parts=urlsplit(receipt['source_page']).path.strip('/').split('/')
                vid=parts[2] if len(parts)==3 else None
                request={'schema_version':1,'source_kind':'public_research_video',
                    'source':{'path':str(source),'sha256':media['source_sha256']},
                    'public_source_url':receipt['source_page'],'public_source_provenance':d.bind(receipt_path),
                    'full_decode_provenance':decode_binding,
                    'public_reference':{'platform':'hongguo','work_id':work['work_id'],'episode_id':media['episode_id'],
                        'series_id':series,'episode_number':slot['episode_number'],'source_episode_id':vid},
                    'split':split,'current_public_qualification':'pending_actual_anonymous_inspection',
                    'strict_screenshot_cut_coverage_granted':False,'music_identity_verified':False,'Ready':False}
                path=out/(media['source_sha256'][:20]+'-native-input.json');d.save(path,request)
                tasks.append({'target_id':slot['target_id'],'specification':d.bind(path),
                              'split':split,'public_source_qualification_pending':True})
            except (OSError,KeyError,ValueError) as error:
                gaps.append({'target_id':slot['target_id'],'reason':str(error)})
    queue={'schema_version':1,'kind':'historical_hongguo_first10_inspection_queue','split':split,
           'tasks':tasks,'source_preparation_gaps':gaps,'scope':{'works':115,'priority_positions':1145,
               'all_positions':8926,'later_positions':7781},'source_qualification_granted':False,
           'requests_per_fresh_source_check_max':2,'fingerprint_posts_in_this_builder':0,
           'new_trials':0,'downloads':0,'model_calls':0,'Ready_packages':0,'paid_calls':0}
    target=out/'hongguo-native-queue.json';d.save(target,queue)
    return {'queue':d.bind(target),'prepared_tasks':len(tasks),'preparation_gaps':len(gaps),'split':split,
            'actual_public_source_qualification_still_required':True}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--priority-pointer',type=Path,required=True)
    p.add_argument('--full-decode-evidence',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--split',choices=['research','heldout'],default='research');a=p.parse_args()
    print(json.dumps(build(d.read(a.priority_pointer),d.bind(a.full_decode_evidence),a.out,a.split),ensure_ascii=True))
