"""Copy a library snapshot and add pinned whole-track human voice evidence only."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import re
import shutil
import sqlite3
import urllib.request

from clap_segment_features import digest

REVISION = 'cafd8e20c265ed84f1e61f1c875327971f43a62f'
ANNOTATION_SHA256 = '466cbb888fe906f3db22b9e6f63b1694e6a38a8613fb67d9d52149e1cc6decd3'
URL = ('https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/' + REVISION
       + '/derived/music-classification-annotations/music-classification-annotations-raw.tsv')


def track_id(value):
    match = re.fullmatch(r'(?:track_)?0*(\d+)', str(value))
    return int(match[1]) if match else None


def read_unanimous(path):
    result = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines()[1:]:
        columns = line.split('\t')
        identifier = track_id(columns[0])
        if identifier is None or identifier in result:
            raise ValueError('invalid_or_duplicate_annotation_track_id')
        for tag in columns[5:]:
            if tag.startswith('voice_instrumental---'):
                labels = tag.partition('---')[2].split(',')
                if len(labels) == 3 and len(set(labels)) == 1 and labels[0] in ('voice', 'instrumental'):
                    result[identifier] = labels[0]
    return result


def import_annotations(base, out, annotations=None):
    base, out = Path(base).resolve(), Path(out).resolve()
    if out.exists() or out == base:
        raise ValueError('fresh_snapshot_directory_required')
    inputs = {name: digest(base / name) for name in
              ('catalog-assets.json', 'segments.json', 'segments.sqlite')}
    out.mkdir(parents=True)
    target = out / 'mtg-human-annotations-raw.tsv'
    if annotations is None:
        request = urllib.request.Request(URL, headers={'User-Agent': 'ShortDramaSound-pinned-metadata-import'})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(16 * 1024 ** 2 + 1)
        if len(data) > 16 * 1024 ** 2:
            raise ValueError('annotation_file_exceeds_bound')
        target.write_bytes(data)
    else:
        shutil.copyfile(annotations, target)
    if digest(target) != ANNOTATION_SHA256:
        raise ValueError('pinned_human_annotation_sha256_mismatch')
    labels = read_unanimous(target)
    catalog = json.loads((base / 'catalog-assets.json').read_text(encoding='utf-8-sig'))
    counts = Counter()
    evidence = {}
    for asset in catalog['assets']:
        if not str(asset.get('asset_id', '')).startswith('mtg-full-low-'):
            continue
        identifier = track_id(asset.get('source_track_id'))
        if identifier not in labels:
            continue
        item = {'label': labels[identifier], 'scope': 'whole_recording',
                'annotators': 3, 'agreement': 3, 'source_track_id': identifier,
                'revision': REVISION, 'annotation_file_sha256': ANNOTATION_SHA256,
                'annotation_source_url': URL,
                'annotation_local_path': str(target),
                'limitation': 'voice_is_not_sung_or_lyric_window; no_language_or_scene_approval'}
        asset['fulltrack_voice_annotation'] = item
        evidence[asset['asset_id']] = item
        counts[item['label']] += 1
    (out / 'catalog-assets.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copyfile(base / 'segments.json', out / 'segments.json')
    with closing(sqlite3.connect(base.as_uri() + '/segments.sqlite?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(out / 'segments.sqlite')) as destination:
            source.backup(destination)
            for asset_id, annotation in evidence.items():
                row = destination.execute('SELECT record_json FROM assets WHERE asset_id=?', (asset_id,)).fetchone()
                if row is None:
                    raise ValueError('catalog_asset_missing_from_database')
                record = json.loads(row[0])
                record['fulltrack_voice_annotation'] = annotation
                destination.execute('UPDATE assets SET record_json=? WHERE asset_id=?',
                                    (json.dumps(record, ensure_ascii=False), asset_id))
            destination.commit()
    if inputs != {name: digest(base / name) for name in inputs}:
        raise ValueError('base_snapshot_changed_during_import')
    report = {'schema': 'whole-track-human-annotation-import-v1', 'base': str(base), 'out': str(out),
              'input_hashes': inputs, 'revision': REVISION, 'annotation_sha256': ANNOTATION_SHA256,
              'matched_asset_ids': len(evidence), 'labels': dict(counts),
              'segment_records_modified': 0, 'vocal_presence_fields_modified': 0,
              'artistic_approval_fields_modified': 0, 'audio_files_read': 0,
              'scope': 'human_whole_recording_evidence_only', 'production_approval': False}
    (out / 'human-annotation-import-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--annotations', type=Path)
    args = parser.parse_args()
    print(json.dumps(import_annotations(args.base, args.out, args.annotations)), flush=True)


if __name__ == '__main__':
    main()
