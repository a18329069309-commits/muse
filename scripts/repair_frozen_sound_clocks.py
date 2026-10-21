"""Publish new sound windows from actual decoded PCM clocks, preserving old freezes.

Only known, source-bound decoded-tail errors are repaired. Source audio is unchanged;
this is a technical window repair and grants no hearing, cleanliness or use approval.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import subprocess

from independent_music_pack_library import checked_binding, digest_file, read_json, write_json
from segment_library import SCHEMA, search_words


def decode(path, rate, start=None, end=None):
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-vn', '-ac', '1']
    if start is not None:
        command += ['-af', f'aresample={rate},atrim=start_sample={round(start * rate)}:'
                    f'end_sample={round(end * rate)},asetpts=PTS-STARTPTS']
    command += ['-ar', str(rate), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']
    result = subprocess.run(command, capture_output=True, timeout=45, check=True)
    if result.stderr or len(result.stdout) % 2 or not result.stdout:
        raise ValueError('decoded_clock_repair_invalid_pcm_or_decoder_warning')
    return {'command': command, 'samples': len(result.stdout) // 2, 'sample_rate': rate,
            'pcm_sha256': hashlib.sha256(result.stdout).hexdigest(), 'exit_code': result.returncode}


def repair(config):
    old_publication_file, old_publication_sha = checked_binding(config['publication'])
    old = read_json(old_publication_file)
    old_db_file, old_db_sha = checked_binding(old['library'])
    report_file, report_sha = checked_binding(config['decoded_clock_report'])
    report = read_json(report_file)
    if report.get('kind') != 'actual_full_native_decode_compared_to_original_declared_window':
        raise ValueError('bound_full_decode_clock_report_required')
    database = sqlite3.connect(f'file:{old_db_file.as_posix()}?mode=ro', uri=True)
    try:
        assets = [json.loads(row[0]) for row in database.execute('SELECT record_json FROM assets')]
        segments = [json.loads(row[0]) for row in database.execute('SELECT record_json FROM segments')]
        old_asset_rows = {row[0]: row for row in database.execute('SELECT * FROM assets')}
        old_segment_rows = {row[0]: row for row in database.execute('SELECT * FROM segments')}
    finally:
        database.close()
    by_asset = {row['asset_id']: row for row in assets}
    report_rows = {row['segment_id']: row for row in report['rows']
                   if row['library']['sha256'] == old_db_sha}
    if len(report_rows) != len(segments):
        raise ValueError('clock_report_complete_library_identity_required')

    def fix(segment):
        evidence = report_rows.get(segment['segment_id'])
        asset = by_asset[segment['asset_id']]
        old_range = [segment['source_start_seconds'], segment['source_end_seconds']]
        if (not evidence or evidence['source_file']['sha256'] != segment['source_sha256']
                or evidence['source_range'] != old_range or not evidence['source_file_unchanged']):
            raise ValueError('clock_report_window_or_source_identity_changed')
        if evidence['status'] == 'decoded_clock_valid':
            return segment, None
        if evidence['status'] != 'invalid_decoded_tail' or not evidence['declared_window_exceeds_native_tail']:
            raise ValueError('unsupported_sound_clock_failure')
        source = Path(asset['local_path'])
        if digest_file(source) != segment['source_sha256']:
            raise ValueError('sound_source_sha_changed')
        native = decode(source, evidence['native_full_decode_rate'])
        if (native['samples'] != evidence['native_full_decode_samples']
                or native['pcm_sha256'] != evidence['decoded_pcm_sha256']):
            raise ValueError('native_decode_changed_since_bound_report')
        end = native['samples'] / native['sample_rate']
        if not (old_range[0] < end < old_range[1]):
            raise ValueError('actual_decoded_tail_not_inside_original_window')
        checks = [decode(source, rate, old_range[0], end) for rate in (16000, 48000)]
        for check in checks:
            expected = round(end * check['sample_rate']) - round(old_range[0] * check['sample_rate'])
            if check['samples'] != expected:
                raise ValueError('repaired_window_not_exact_at_consumer_clock')
        if digest_file(source) != segment['source_sha256']:
            raise ValueError('sound_source_changed_during_clock_repair')
        replacement_id = segment['segment_id'] + '/decoded-' + hashlib.sha256(
            json.dumps({'range': [old_range[0], end], 'source': segment['source_sha256']},
                       sort_keys=True).encode()).hexdigest()[:16]
        measurement = {'source_sha256': segment['source_sha256'], 'old_segment_id': segment['segment_id'],
            'new_segment_id': replacement_id, 'old_source_range': old_range,
            'new_source_range': [old_range[0], end], 'native_full_decode': native,
            'consumer_decode_checks': checks, 'source_bytes_unchanged': True,
            'sound_approval_granted': False, 'usage_approval_granted': False}
        fixed = {**segment, 'segment_id': replacement_id, 'source_end_seconds': end,
                 'source_range': [old_range[0], end], 'supersedes_segment_id': segment['segment_id'],
                 'decoded_clock_repair': measurement, 'production_approval': False}
        if fixed.get('source_anchor_seconds') is not None and not old_range[0] <= fixed['source_anchor_seconds'] < end:
            raise ValueError('existing_anchor_outside_repaired_source_window')
        return fixed, measurement

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(fix, segments))
    fixed_segments = [row[0] for row in results]
    repairs = [row[1] for row in results if row[1] is not None]
    repaired_by_source = {row['source_sha256']: row for row in repairs}
    fixed_assets = []
    for asset in assets:
        evidence = repaired_by_source.get(asset['source_sha256'])
        fixed_assets.append(asset if evidence is None else {**asset,
            'duration_seconds': evidence['new_source_range'][1],
            'decoded_duration_basis': 'native_complete_pcm_sample_count',
            'previous_declared_duration_seconds': asset['duration_seconds'],
            'decoded_clock_repair_source': evidence['old_segment_id']})
    version = hashlib.sha256(json.dumps({'parent': old_publication_sha, 'report': report_sha,
        'implementation': digest_file(__file__), 'repairs': repairs}, sort_keys=True).encode()).hexdigest()
    root = Path(config['output_dir']).resolve() / version[:20]
    root.mkdir(parents=True, exist_ok=True)
    output = root / 'publication.json'
    if output.exists():
        current = read_json(output); checked_binding(current['library'])
        return {'publication': {'path': str(output), 'sha256': digest_file(output)}, 'library': current['library'],
                'counts': current['counts'], 'reused': True}
    new_db = root / 'segments.sqlite'
    db = sqlite3.connect(new_db)
    try:
        for statement in SCHEMA: db.execute(statement)
        for asset in fixed_assets:
            values = list(old_asset_rows[asset['asset_id']])
            if asset['source_sha256'] in repaired_by_source:
                values[6] = asset['duration_seconds']; values[-1] = json.dumps(asset, ensure_ascii=False)
            db.execute('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', values)
        new_by_asset = {row['asset_id']: row for row in fixed_assets}
        for previous, segment in zip(segments, fixed_segments):
            values = list(old_segment_rows[previous['segment_id']])
            if segment['segment_id'] != previous['segment_id']:
                values[0] = segment['segment_id']; values[4] = segment['source_end_seconds']
                values[-1] = json.dumps(segment, ensure_ascii=False)
            db.execute('INSERT INTO segments VALUES(?,?,?,?,?,?,?,?)', values)
            db.execute('INSERT INTO segment_text VALUES(?,?)',
                       (segment['segment_id'], search_words(new_by_asset[segment['asset_id']], segment)))
            db.executemany('INSERT INTO functions VALUES(?,?)',
                           [(segment['segment_id'], label) for label in set(segment.get('narrative_functions', []))])
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('repaired_sound_library_integrity_failed')
    finally:
        db.close()
    counts = {**old['counts'], 'decoded_clock_repaired_windows': len(repairs),
              'unchanged_windows': len(segments) - len(repairs)}
    publication = {**old, 'publication_id': 'diagnostic-sound-decoded-clock/' + version,
        'library': {'path': str(new_db), 'sha256': digest_file(new_db)},
        'assets': write_json(root / 'assets.json', {'assets': fixed_assets}),
        'segments': write_json(root / 'segments.json', {'segments': fixed_segments}), 'counts': counts,
        'parent_publication': config['publication'], 'decoded_clock_report': config['decoded_clock_report'],
        'clock_repair_receipts': write_json(root / 'clock-repairs.json', {'repairs': repairs}),
        'source_audio_modified': False, 'hearing_or_use_approval_granted': False}
    binding = write_json(output, publication)
    if digest_file(old_db_file) != old_db_sha or digest_file(old_publication_file) != old_publication_sha:
        raise ValueError('parent_frozen_sound_library_changed')
    return {'publication': binding, 'library': publication['library'], 'counts': counts,
            'new_model_calls': 0, 'source_audio_modified': False, 'reused': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    result = repair(read_json(arguments.config)); write_json(arguments.output, result)
    print(json.dumps(result, ensure_ascii=False))
