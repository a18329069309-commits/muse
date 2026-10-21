"""Acquire one explicit pinned shard, then import up to 500 genuinely new files.

Resume acquisition in the same batch directory; completed source receipts remain
unchanged. A next batch always writes a new library snapshot. No paid API calls.
"""
import argparse
import json
from pathlib import Path

import acquire_mtg_shards as acquire
import prepare_mtg_batch as prepare
from clap_segment_features import digest


def select_new_records(records, old_assets, metadata, licenses, limit=500):
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('batch_limit_from_1_to_500_required')
    old_ids = {a['asset_id'] for a in old_assets}
    seen = {a['source_sha256'] for a in old_assets}
    chosen = []
    for record in sorted(records, key=lambda r:r['source_track_id']):
        identifier, sha = record['source_track_id'], record['source_sha256']
        if (f'mtg-full-low-{identifier}' in old_ids or sha in seen
                or identifier not in metadata or identifier not in licenses):
            continue
        chosen.append(record);seen.add(sha)
        if len(chosen) == limit:
            break
    return chosen


def extend(shard, batch, base, source_db, out, limit=500, revision='cafd8e20c265ed84f1e61f1c875327971f43a62f'):
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('batch_limit_from_1_to_500_required')
    batch, base, source_db, out = map(Path,(batch,base,source_db,out))
    if out.exists():
        raise ValueError('fresh_library_snapshot_required')
    receipt = batch/'acquisition-report.json'
    if not receipt.exists():
        report = acquire.acquire([shard], batch, revision)
        if not report['complete']:
            raise ValueError('acquisition_incomplete_resume_same_batch_directory')
    full = json.loads(receipt.read_text(encoding='utf-8'))
    if not full.get('complete') or full.get('failures') or full['official_revision'] != revision:
        raise ValueError('complete_pinned_acquisition_required')
    if full['requested_archives'] != [f'raw_30s_audio-low-{int(shard):02d}.tar']:
        raise ValueError('completed_receipt_is_not_requested_shard')
    catalog = json.loads((base/'catalog-assets.json').read_text(encoding='utf-8'))
    metadata = prepare.source_records(source_db)
    licenses = prepare.read_licenses(batch/'provenance/audio_licenses.txt')
    chosen = select_new_records(full['records'],catalog['assets'],metadata,licenses,limit)
    if not chosen:
        raise ValueError('no_new_unique_source_files_in_this_shard')
    selected = {**full, 'records':chosen, 'selection_scope':'bounded_new_unique_source_files',
                'full_acquisition_receipt':str(receipt.resolve()),
                'full_acquisition_receipt_sha256':digest(receipt),
                'selected_unique_sources':len(chosen),
                'acquired_files_outside_selected_batch':len(full['records'])-len(chosen)}
    selection = batch/f'acquisition-selected-{limit}.json'
    if selection.exists():
        if json.loads(selection.read_text(encoding='utf-8')) != selected:
            raise ValueError('selection_receipt_exists_for_different_base')
    else:
        selection.write_text(json.dumps(selected,ensure_ascii=False,indent=2),encoding='utf-8')
    result = prepare.prepare_batch(selection,source_db,base/'segments.sqlite',base/'catalog-assets.json',
                                   base/'segments.json',out,workers=6)
    progress = {'schema':'bounded-music-library-expansion-v1','selected_sources':len(chosen),
                'acquired_audio_files':len(full['records']),'verified_new_unique_source_files':result['new_file_hashes_not_in_base'],
                'music_asset_ids':result['music_asset_ids'],'music_unique_source_hashes':result['music_unique_file_hashes'],
                'verified_distinct_compositions':'unknown','target_60000_distinct_works_achieved':False,
                'next_batch_policy':'explicit_next_shard; base=this_output; fresh_output_directory',
                'catalog_rows_are_not_local_audio_count':True,'library':str(out.resolve()),
                'production_approval':False,'generation_calls':0,'fees':0}
    (out/'expansion-progress.json').write_text(json.dumps(progress,ensure_ascii=False,indent=2),encoding='utf-8')
    return progress


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shard',required=True)
    for name in ('batch','base','source-db','out'):
        parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--limit',default=500,type=int)
    args=parser.parse_args()
    print(json.dumps(extend(args.shard,args.batch,args.base,args.source_db,args.out,args.limit)),flush=True)


if __name__=='__main__':main()
