"""Reuse real recordings and official publisher catalogues in bounded batches.

This is offline acquisition/technical adaptation. Publisher voice/lyrics labels,
editorial hypotheses and PCM measurements remain distinct from actual audition.
No credentials, model calls or invented reference-drama identities are used.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import threading
import urllib.parse

from independent_music_pack_library import (acquire_inputs, build, checked_binding,
    digest_file, read_json, write_json)

_ARCHIVAL_LOCKS = {}


def publisher_catalogue_from_saved_page(file):
    """Parse the author's public Next.js data, never infer an MP3 filename."""
    text = Path(file).read_text(encoding='utf-8')
    flight = ''.join(json.loads(match[1]) for match in re.finditer(
        r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', text))
    values = {}
    references = {}
    for match in re.finditer(r'(?m)^([a-z0-9]+):(?=[\[{])', flight):
        try:
            references['$' + match[1]] = json.JSONDecoder().raw_decode(flight[match.end():])[0]
        except json.JSONDecodeError:
            continue
    for field in ('songStubs', 'clipStubs', 'tagStubs', 'taggedSongs'):
        match = re.search('"' + field + '":', flight)
        if not match:
            continue
        values[field] = json.JSONDecoder().raw_decode(flight[match.end():].lstrip())[0]
    if not values.get('songStubs') or not values.get('clipStubs'):
        raise ValueError('official_josh_catalogue_data_missing')
    clips = {row['song_id']: row['url'] for row in values['clipStubs']
             if row.get('type') == 'Primary' and row.get('url', '').endswith('.mp3')}
    tags = defaultdict(list)
    for row in values.get('tagStubs', values.get('taggedSongs', [])):
        tags[row['song_id']].append(row['tag'])
    result = []
    for row in values['songStubs']:
        if isinstance(row, str):
            row = references.get(row)
        if not isinstance(row, dict):
            raise ValueError('official_josh_song_reference_missing')
        key = row['song_id']
        if key not in clips or row.get('is_production') == 1:
            continue
        result.append({**row, 'audio_url': urllib.parse.urljoin('https://www.joshwoodward.com/', clips[key]),
            'tags': sorted(set(tags[key]))})
    return sorted(result, key=lambda row: row['song_id'])


def archival_copy(row, media_root):
    """Preserve original; create/check content-addressed archival bytes on S."""
    file = Path(row.get('path', row.get('local_path', '')))
    expected = row.get('sha256', row.get('source_sha256'))
    if not file.is_file():
        return None, {'record_id': row.get('record_id'), 'gap': 'source_missing', 'path': str(file)}
    sha = digest_file(file)
    if expected and expected != sha:
        raise ValueError('archival_source_sha_changed: ' + str(file))
    root = Path(media_root).resolve()
    destination = root / 'recordings' / sha[:2] / (sha + file.suffix.lower())
    if not destination.resolve().is_relative_to(root):
        raise ValueError('archival_destination_outside_root')
    destination.parent.mkdir(parents=True, exist_ok=True)
    lock = _ARCHIVAL_LOCKS.setdefault(str(destination), threading.Lock())
    with lock:
        if destination.exists():
            if digest_file(destination) != sha:
                raise ValueError('archival_existing_recording_changed')
            reused = True
        else:
            with file.open('rb') as source, destination.open('xb') as output:
                shutil.copyfileobj(source, output, 4 * 1024 * 1024)
            if digest_file(destination) != sha:
                raise ValueError('archival_copy_sha_mismatch')
            reused = False
    return {**row, 'path': str(destination), 'local_path': str(destination),
        'sha256': sha, 'source_sha256': sha,
        'archival_source': {'path': str(file), 'sha256': sha},
        'archival_copy': {'path': str(destination), 'sha256': sha, 'cache_reused': reused}}, None


def select_reusable(old_rows, baseline_hashes, target):
    """All publisher voice candidates first; balance remaining artists/genres."""
    rows = [row for row in old_rows if row.get('asset_kind') == 'music'
        and row.get('source_collection') == 'mtg-jamendo-raw_30s-audio-low'
        and row.get('source_sha256') not in baseline_hashes and not row.get('content_rejected')]
    selected, seen, artist_counts = [], set(), Counter()
    vocal = [row for row in rows if 'instrument---voice' in row.get('source_tags', [])]
    for row in sorted(vocal, key=lambda item: str(item.get('source_track_id', item.get('asset_id')))):
        if len(selected) >= target:
            break
        sha = row.get('source_sha256')
        if sha not in seen:
            selected.append(row); seen.add(sha); artist_counts[row.get('creator')] += 1
    remaining = [row for row in rows if row.get('source_sha256') not in seen]
    remaining.sort(key=lambda row: (artist_counts[row.get('creator')],
        hashlib.sha256(str(row.get('source_track_id', row.get('asset_id'))).encode()).hexdigest()))
    by_artist = defaultdict(list)
    for row in remaining:
        by_artist[row.get('creator', 'unknown')].append(row)
    while len(selected) < target and by_artist:
        for artist in sorted(by_artist, key=lambda artist: (artist_counts[artist], str(artist))):
            row = by_artist[artist].pop(0)
            sha = row.get('source_sha256')
            if sha not in seen:
                selected.append(row); seen.add(sha); artist_counts[artist] += 1
            if not by_artist[artist]:
                del by_artist[artist]
            if len(selected) >= target:
                break
    return selected


def prepare(config):
    root, media = Path(config['output_dir']).resolve(), Path(config['media_root']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    publication_file, publication_sha = checked_binding(config['baseline_publication'])
    publication = read_json(publication_file)
    assets_file, _ = checked_binding(publication['assets'])
    baseline = read_json(assets_file)['assets']
    windows = defaultdict(list)
    for row in publication['windows']:
        windows[row['source_sha256']].append(row['source_range'])
    base_hashes = {row['source_sha256'] for row in baseline}
    for row in baseline:
        row['source_windows'] = sorted(windows[row['source_sha256']])
        row['record_id'] = row.get('record_id', row.get('asset_id'))
        row['recording_family_id'] = row.get('family_id')
    old_file, old_sha = checked_binding(config['existing_catalogue'])
    old_rows = read_json(old_file)['assets']
    new_reused = select_reusable(old_rows, base_hashes, config.get('reuse_target', 1000) - len(baseline))
    records = []
    for row in new_reused:
        tags = row.get('source_tags', [])
        records.append({**row, 'record_id': row.get('source_track_id', row.get('asset_id')),
            'recording_family_id': row.get('family_id', row.get('source_family', row.get('asset_id'))),
            'publisher_tags': tags, 'publisher_vocal_hint': 'instrument---voice' in tags,
            'publisher_variant_label': 'Publisher voice-labelled recording' if 'instrument---voice' in tags else 'Publisher recording',
            'description': 'MTG-Jamendo publisher tags: ' + ', '.join(tags),
            'origin': 'independent_library', 'usage_scope': 'diagnostic_research',
            'requested_extent': 'existing_complete_recording_official_checksum_pending_reverification',
            'preset_ids': [], 'sound_review': 'pending', 'usage_review': 'pending',
            'source_catalogue_evidence': {'path': str(old_file), 'sha256': old_sha}})
    staged, gaps = [], []
    resume_refs = config.get('resume_archival_catalogues', [])
    if resume_refs:
        for binding in resume_refs:
            cached, _ = checked_binding(binding)
            staged.extend(read_json(cached)['records'])
        expected_hashes = {row.get('source_sha256', row.get('sha256')) for row in [*baseline, *records]}
        if {row['source_sha256'] for row in staged} != expected_hashes:
            raise ValueError('archival_catalogue_resume_identity_differs')
        # The subsequent freeze always hashes the actual archived files. Here
        # only the completed archival stage is resumed from pinned receipts.
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            for row, gap in pool.map(lambda row: archival_copy(row, media), [*baseline, *records]):
                if gap:
                    gaps.append(gap)
                else:
                    staged.append(row)
    refs = []
    for offset in range(0, len(staged), 500):
        refs.append(write_json(root / 'catalogues' / ('reused-batch-' + str(offset // 500 + 1) + '.json'),
            {'kind': 'existing_recordings_sha_verified_archival_copy', 'records': staged[offset:offset + 500],
             'basis': 'publisher_labels_not_actual_sound_approval'}))
    page, page_sha = checked_binding(config['josh_source_page'])
    songs = publisher_catalogue_from_saved_page(page)
    existing_urls = {row.get('download_url') for row in baseline}
    existing_song_ids = {row.get('record_id', '').split(':')[1] for row in baseline
        if str(row.get('record_id', '')).startswith('josh-woodward:')}
    songs = [row for row in songs if row['audio_url'] not in existing_urls
        and 'catalogue-' + str(row['song_id']) not in existing_song_ids]
    songs = songs[:config.get('new_full_song_limit', 100)]
    metadata_ref = write_json(root / 'josh-publisher-catalogue.json', {
        'source_page': 'https://www.joshwoodward.com/',
        'source_page_evidence': {'path': str(page), 'sha256': page_sha},
        'records': songs, 'basis': 'official_publisher_full_song_candidates_not_word_or_window_verification'})
    inputs = []
    for row in songs:
        inputs.append({'record_id': 'josh-woodward:catalogue-' + str(row['song_id']) + ':full-song',
            'recording_family_id': 'josh-woodward:catalogue-' + str(row['song_id']),
            'artist': 'Josh Woodward', 'title': row['name'], 'publisher_variant_label': 'Full Song',
            'source_page': 'https://www.joshwoodward.com/', 'download_url': row['audio_url'],
            'publisher_metadata': metadata_ref, 'publisher_tags': row.get('tags', []),
            'publisher_bpm': row.get('bpm'), 'vocal_language_hint': 'English',
            'requested_extent': 'publisher_full_recording', 'origin': 'independent_library',
            'description': 'Publisher song metadata; actual voice, words and phrase boundaries pending. '
                + ', '.join(row.get('tags', [])), 'preset_ids': [],
            'conditions': ['actual_lyric_semantics_and_dialogue_competition_must_be_checked'],
            'exclusions': ['unverified_lyrics_as_verified'], 'sound_review': 'pending', 'usage_review': 'pending'})
    initial = {'mode': 'research', 'trial_review_policy': 'diagnostic_candidates',
        'output_dir': str(root / 'music-packs'), 'source_catalogues': refs,
        'technical_cache_dir': str(root / 'technical-cache'), 'decode_workers': 2}
    request = write_json(root / 'acquisition-inputs.json', {'records': inputs,
        'acquisition_dir': str(media / 'publisher-acquisition')})
    build_ref = write_json(root / 'initial-build-config.json', initial)
    receipt = {'kind': 'generic_library_prepare_actual_execution', 'recorded_at': datetime.now(timezone.utc).isoformat(),
        'baseline_publication': {'path': str(publication_file), 'sha256': publication_sha},
        'existing_catalogue': {'path': str(old_file), 'sha256': old_sha},
        'old_catalogue_assets': len(old_rows), 'baseline_recordings_preserved': len(baseline),
        'archival_recordings_staged': len(staged), 'new_song_acquisitions_requested': len(inputs),
        'catalogues': refs, 'build_config': build_ref, 'acquisition_request': request, 'gaps': gaps,
        'human_reviews_created': 0, 'model_calls': 0, 'paid_calls': 0}
    write_json(root / 'prepare-receipt.json', receipt)
    return receipt


def acquire(config):
    root = Path(config['output_dir']).resolve()
    request = read_json(root / 'acquisition-inputs.json')
    rows = acquire_inputs(request['records'], request['acquisition_dir'])
    good = [row for row in rows if row.get('status') == 'acquired_and_full_decode_passed_not_sound_or_usage_approved']
    ref = write_json(root / 'catalogues' / 'new-author-acquired.json', {'records': rows})
    config = read_json(root / 'initial-build-config.json')
    config['source_catalogues'].append(ref)
    final_config = write_json(root / 'final-build-config.json', config)
    result = {'requested': len(rows), 'downloaded_and_decoded': len(good),
        'failures': [row for row in rows if row not in good], 'catalogue': ref,
        'build_config': final_config, 'model_calls': 0, 'paid_calls': 0,
        'meaning': 'Full Song publisher candidate, not qualified actual lyrics or dramatic use'}
    write_json(root / 'acquisition-receipt.json', result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'acquire', 'freeze'])
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = read_json(args.config)
    if args.action == 'prepare':
        result = prepare(config)
    elif args.action == 'acquire':
        result = acquire(config)
    else:
        result = build(config)
        write_json(Path(config['output_dir']).parent / 'freeze-result.json', result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
