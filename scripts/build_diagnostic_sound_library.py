"""Freeze actual existing sound effects without inventing auditory anchors."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

from independent_music_pack_library import checked_binding, digest_file, read_json, write_json
from local_sound_pcm_adaptation import adapt
from prepare_generic_music_library import archival_copy
from segment_library import SCHEMA, commercial_use, search_words


def build(config):
    source, sha = checked_binding(config['source_catalogue'])
    rows = [row for row in read_json(source)['assets'] if row.get('asset_kind') in ('sfx', 'ambient')]
    valid, gaps = [], []
    def check(row):
        try:
            if config.get('source_mode') == 'readonly_original':
                copied = row
            else:
                copied, gap = archival_copy(row, config['media_root'])
                if gap:
                    return None, gap
            adapted = adapt(copied, config)
        except ValueError as error:
            if 'sha_changed' in str(error) or 'cache_changed' in str(error):
                raise
            return None, {'asset_id': row.get('asset_id'), 'gap': str(error)}
        except OSError as error:
            return None, {'asset_id': row.get('asset_id'), 'gap': 'sound_source_unreadable', 'detail': str(error)}
        except subprocess.CalledProcessError as error:
            return None, {'asset_id': row.get('asset_id'), 'gap': 'sound_source_decode_failed',
                'detail': str(error.stderr or error)[-1000:]}
        return adapted, None
    with ThreadPoolExecutor(max_workers=2) as pool:
        for row, gap in pool.map(check, rows):
            if gap:
                gaps.append(gap)
            else:
                valid.append(row)
    version = hashlib.sha256(json.dumps({'source': sha, 'builder': digest_file(__file__),
        'pcm_adapter': digest_file(Path(__file__).parent / 'local_sound_pcm_adaptation.py'),
        'source_mode': config.get('source_mode', 'archival_copy'),
        'recordings': [row['source_sha256'] for row in valid]}, sort_keys=True).encode()).hexdigest()
    root = Path(config['output_dir']).resolve() / version[:20]
    root.mkdir(parents=True, exist_ok=True)
    database = root / 'segments.sqlite'
    publication_file = root / 'publication.json'
    if publication_file.exists():
        publication = read_json(publication_file); checked_binding(publication['library'])
        return {'publication': {'path': str(publication_file), 'sha256': digest_file(publication_file)},
            'library': publication['library'], 'counts': publication['counts'], 'gaps': gaps}
    assets, segments, seen = [], [], set()
    for row in valid:
        sha = row['source_sha256']
        if sha in seen:
            continue
        seen.add(sha)
        asset = {**row, 'asset_id': 'diagnostic-sound/' + sha[:24],
            'family_id': row.get('source_family', 'recording/' + sha),
            'local_path': row['path'], 'listening_status': 'pending',
            'sound_review': 'pending', 'usage_review': 'pending', 'production_approval': False}
        anchors = row.get('anchor_candidates', {})
        profile = row['measured_profile']
        segment = {'segment_id': 'diagnostic-sound-window/' + sha[:24],
            'asset_id': asset['asset_id'], 'source_sha256': sha, 'source_start_seconds': 0,
            'source_end_seconds': row['duration_seconds'], 'source_range': [0, row['duration_seconds']],
            'listening_status': 'pending', 'phase': 'unknown', 'asset_kind': asset['asset_kind'],
            'narrative_functions': row.get('narrative_functions', []),
            'description': row.get('title', '') + ' Publisher filename/event label; actual cleanliness and anchor pending.',
            'anchor_candidates': anchors, 'source_anchor_seconds': None,
            'measured_anchor_candidates': profile['transient_candidates'],
            'sound_class_candidate': row['sound_class_candidate'],
            'sound_class_basis': row['sound_class_basis'],
            'actual_clock': row['actual_clock'], 'measured_profile': profile,
            'anchor_review_status': 'unverified_measured_candidates_only',
            'cleanliness': 'unknown', 'production_approval': False}
        assets.append(asset); segments.append(segment)
    db = sqlite3.connect(database)
    try:
        for statement in SCHEMA: db.execute(statement)
        by_asset = {row['asset_id']: row for row in assets}
        for row in assets:
            db.execute('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (row['asset_id'], row['source_sha256'], row['family_id'], row['local_path'], row['bytes'], row['mtime_ns'],
                 row['duration_seconds'], row['sample_rate_hz'], row['channels'], int(commercial_use(row)), 0, 0,
                 json.dumps(row, ensure_ascii=False)))
        for row in segments:
            db.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)',
                (row['segment_id'], row['asset_id'], row['source_sha256'], row['source_start_seconds'],
                 row['source_end_seconds'], 'unknown', 'pending', json.dumps(row, ensure_ascii=False)))
            db.execute('INSERT INTO segment_text VALUES(?,?)',
                (row['segment_id'], search_words(by_asset[row['asset_id']], row)))
            db.executemany('INSERT INTO functions VALUES(?,?)',
                [(row['segment_id'], label) for label in set(row['narrative_functions'])])
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('diagnostic_sound_sqlite_integrity_failed')
    finally:
        db.close()
    counts = {'recording_files': len(assets), 'source_windows': len(segments),
        'sound_approved_windows': 0, 'usage_approved_windows': 0, 'auditory_anchor_approved_windows': 0}
    library = {'path': str(database), 'sha256': digest_file(database)}
    publication = {'kind': 'diagnostic_sound_library', 'publication_id': 'diagnostic-sound/' + version,
        'library': library, 'assets': write_json(root / 'assets.json', {'assets': assets}),
        'segments': write_json(root / 'segments.json', {'segments': segments}), 'counts': counts,
        'source_catalogue': config['source_catalogue'], 'gaps': gaps,
        'source_mode': config.get('source_mode', 'archival_copy'),
        'human_audition_performed': False, 'professional_audio_review_qualified': False,
        'status': 'diagnostic_only_not_approved_sound_pack'}
    return {'publication': write_json(publication_file, publication), 'library': library,
            'counts': counts, 'gaps': gaps, 'model_calls': 0, 'paid_calls': 0}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args(); result = build(read_json(args.config)); write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
