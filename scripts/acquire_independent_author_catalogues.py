"""Select an initial bounded, diverse author catalogue; no invented download URLs.

Josh paths come from his live homepage/song pages; Incompetech filenames and
labels come from the saved official catalogue, not a search result. Full lyrics
are source text, never window verification. No private or paid endpoints.
"""
import argparse
import html
import json
import sys
from pathlib import Path
import re
import urllib.parse
import urllib.request

from independent_music_pack_library import digest_file, write_json


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'IndependentMusicPacks/1.0'}), timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError('author_page_over_limit')
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--incompetech-catalogue', required=True)
    parser.add_argument('--existing-catalogue', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(args.root).absolute(); root.mkdir(parents=True, exist_ok=True)
    pages = root / 'pages'; pages.mkdir(exist_ok=True)
    home = pages / 'josh-homepage.html'
    if not home.exists(): home.write_bytes(get('https://www.joshwoodward.com/'))
    song_paths = list(dict.fromkeys(re.findall(r'/song/[A-Za-z0-9_-]+', home.read_text(encoding='utf-8'))))
    chosen = [p for p in song_paths if p != '/song/TheBox'][:12]
    if len(chosen) < 12: raise ValueError('official_catalogue_has_insufficient_vocal_candidates')
    inputs, discoveries = [], []
    for song_path in chosen:
        key = song_path.rsplit('/', 1)[-1]
        file = pages / ('josh-' + key + '.html')
        if not file.exists(): file.write_bytes(get('https://www.joshwoodward.com' + song_path))
        text = file.read_text(encoding='utf-8').replace('\\/', '/')
        urls = list(dict.fromkeys(re.findall(r'(?:https://www.joshwoodward.com)?/mp3/[^"\'\\<> ]+\.mp3', text)))
        urls = ['https://www.joshwoodward.com' + url if url.startswith('/') else url for url in urls]
        full = next((url for url in urls if '-NoVox' not in url), None)
        if not full: raise ValueError('author_full_song_url_missing: ' + key)
        title = re.search(r'<title>(.*?)</title>', text)
        title = html.unescape(title.group(1)).split(' - ')[0] if title else key
        metadata = []
        for raw in re.findall(r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', text, re.S):
            try: metadata.append(json.loads(html.unescape(raw)))
            except json.JSONDecodeError: pass
        document = write_json(pages / ('josh-' + key + '.metadata.json'), {'schema_version': 1,
            'source_page': 'https://www.joshwoodward.com' + song_path,
            'source_page_sha256': digest_file(file), 'publisher_structured_metadata': metadata,
            'lyrics_status': 'publisher_text_not_auditory_or_timing_verification'})
        discoveries.append({'song_path': song_path, 'title': title, 'audio_urls': urls, 'metadata': document})
        inputs.append({'record_id': 'josh-woodward:' + key.lower() + ':full-song',
            'recording_family_id': 'josh-woodward:' + key.lower(), 'artist': 'Josh Woodward', 'title': title,
            'publisher_variant_label': 'Full Song', 'source_page': 'https://www.joshwoodward.com' + song_path,
            'download_url': full, 'requested_extent': 'publisher_full_recording',
            'publisher_metadata': document, 'vocal_language_hint': 'English',
            'lyrics_state': 'publisher_text_not_verified_in_window',
            'description': 'Author published song candidate; full sung mix, words and exact song-window suitability pending.',
            'preset_ids': ['editorial/relationship-resolution', 'editorial/free-departure', 'editorial/betrayal-refusal'],
            'conditions': ['lyric_semantics_and_dialogue_gap_must_be_checked'], 'exclusions': ['unknown_lyric_used_as_verified'],
            'sound_review': 'pending', 'usage_review': 'pending', 'origin': 'independent_library'})
    catalogue = json.loads(Path(args.incompetech_catalogue).read_text(encoding='utf-8-sig'))
    titles = ['Oppressive Gloom', 'The Descent', 'Unseen Horrors', 'Darkest Child', 'Movement Proposition',
              'Cipher', 'Cut and Run', 'Funkorama', 'Sneaky Snitch']
    selected = [next(row for row in catalogue if row['title'] == title) for title in titles]
    metadata_ref = write_json(pages / 'incompetech-selected-metadata.json', {'origin': 'official_catalogue_excerpt',
        'catalogue_sha256': digest_file(args.incompetech_catalogue), 'records': selected})
    for row in selected:
        bright = row['title'] in ('Cipher', 'Funkorama', 'Sneaky Snitch')
        inputs.append({'record_id': 'incompetech:' + row['isrc'], 'recording_family_id': 'incompetech:' + row['isrc'],
            'title': row['title'], 'artist': 'Kevin MacLeod', 'source_page': 'https://incompetech.com/music/royalty-free/',
            'download_url': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + urllib.parse.quote(row['filename']),
            'require_url_in_page': False, 'publisher_catalogue': metadata_ref,
            'publisher_description': row.get('description', ''), 'publisher_feel': row.get('feel'),
            'publisher_instruments': row.get('instruments'), 'publisher_bpm': row.get('bpm'),
            'publisher_variant_label': 'Score', 'requested_extent': 'publisher_full_recording',
            'preset_ids': ['editorial/agency-light-irony'] if bright else ['editorial/sustained-danger', 'editorial/humiliation-counteraction'],
            'conditions': ['editorial_match_requires_actual_dramatic_comparison'],
            'exclusions': ['comic_after_harm', 'danger_unresolved'] if bright else ['light_financial_autonomy'],
            'origin': 'independent_library', 'sound_review': 'pending', 'usage_review': 'pending'})
    write_json(root / 'catalogue-discovery.json', {'josh_homepage': {'path': str(home), 'sha256': digest_file(home)},
        'songs': discoveries, 'incompetech': metadata_ref, 'model_calls': 0, 'paid_calls': 0})
    config = {'schema_version': 1, 'mode': 'research', 'trial_review_policy': 'diagnostic_candidates',
        'python': sys.executable,
        'source_catalogues': [args.existing_catalogue], 'acquisition_inputs': inputs,
        'acquisition_dir': str(root / 'recordings'), 'output_dir': args.output_dir}
    write_json(args.output, config)
    print(json.dumps({'additional_recordings_requested': len(inputs), 'vocal_candidates_requested': len(chosen),
        'existing_recordings_reused': 10, 'families_target': 30, 'config': args.output}, ensure_ascii=False))


if __name__ == '__main__': main()
