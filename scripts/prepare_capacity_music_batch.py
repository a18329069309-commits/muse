"""Bounded diverse source intake for the existing independent pack builder.

Reads actual author catalogues and an existing MTG manifest. It neither invents
download addresses nor signs off listening, phrase boundaries or dramatic use.
Author metadata and reused research audio remain separately attributable.
"""
import argparse
from collections import Counter, defaultdict
import json
import sys
from pathlib import Path
import re
import urllib.parse

from independent_music_pack_library import digest_file, read_json, write_json


def parse_josh_page(text):
    chunks = []
    for raw in re.findall(r'self\.__next_f\.push\((.*?)\)</script>', text):
        try:
            chunks.extend(x for x in json.loads(raw) if isinstance(x, str))
        except (ValueError, TypeError):
            continue
    songs, clips, tags = {}, {}, defaultdict(set)
    def visit(value):
        if isinstance(value, dict):
            if 'song_id' in value and 'name' in value:
                songs[value['song_id']] = value
            if 'song_id' in value and 'url' in value:
                clips[(value['song_id'], value.get('type'))] = value
            if 'song_id' in value and 'tag' in value:
                tags[value['song_id']].add(value['tag'])
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    for line in ''.join(chunks).splitlines():
        try:
            visit(json.loads(line.split(':', 1)[1]))
        except (ValueError, IndexError):
            continue
    return songs, clips, tags


def choose_diverse(rows, limit, category, labels, identity, exclude=()):
    """Greedy coverage, deterministic tie breaks, not aesthetic ranking."""
    excluded = set(exclude)
    pending = [row for row in rows if identity(row) not in excluded]
    selected, categories, counts = [], Counter(), Counter()
    while pending and len(selected) < limit:
        def score(row):
            cues = set(labels(row))
            return (categories[category(row)], -sum(1 / (1 + counts[c]) for c in cues), str(identity(row)))
        row = min(pending, key=score)
        pending.remove(row)
        selected.append(row)
        categories[category(row)] += 1
        counts.update(set(labels(row)))
    return selected


def proposed_presets(labels):
    terms = ' '.join(str(x).lower() for x in labels)
    rules = {
        'sustained-danger': ['dark', 'suspense', 'horror', 'creepy', 'myster'],
        'humiliation-counteraction': ['action', 'intense', 'hard rock', 'angry', 'driving'],
        'betrayal-refusal': ['sad', 'loss', 'regret', 'bittersweet', 'dramatic'],
        'family-change': ['warm', 'tender', 'gentle', 'calm', 'relax'],
        'era-transition': ['medieval', 'folk', 'traditional', 'jazz', 'americana'],
        'relationship-resolution': ['love', 'romantic', 'ballad'],
        'free-departure': ['uplift', 'inspiration', 'bright', 'upbeat'],
        'agency-light-irony': ['groov', 'funk', 'light', 'bouncy', 'humor'],
    }
    return ['editorial/' + key for key, values in rules.items() if any(x in terms for x in values)]


def bounded_catalogue_duration(value, max_seconds=600):
    """Reject known oversized score entries before transfer; decode still checks."""
    try:
        fields = [int(x) for x in str(value).split(':')]
        if len(fields) != 3 or any(x < 0 for x in fields) or fields[1] >= 60 or fields[2] >= 60:
            return False
        return 0 < fields[0] * 3600 + fields[1] * 60 + fields[2] <= max_seconds
    except (ValueError, TypeError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pages', required=True)
    parser.add_argument('--existing-publication', required=True)
    parser.add_argument('--legacy-catalogue', required=True)
    parser.add_argument('--audio-root', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--josh-count', type=int, default=40)
    parser.add_argument('--score-count', type=int, default=60)
    parser.add_argument('--reuse-count', type=int, default=100)
    args = parser.parse_args()
    if any(x < 0 or x > 500 for x in (args.josh_count, args.score_count, args.reuse_count)):
        raise ValueError('bounded_nonnegative_batch_required')
    pages = Path(args.pages).absolute()
    output = Path(args.output_dir).absolute(); output.mkdir(parents=True, exist_ok=True)
    publication = read_json(args.existing_publication)
    old_assets = read_json(publication['assets']['path'])['assets']
    legacy = read_json(args.legacy_catalogue)['assets']
    existing_urls = {row.get('download_url') for row in old_assets + legacy}
    existing_families = {row.get('family_id', row.get('recording_family_id')) for row in old_assets}
    existing_shas = {row.get('source_sha256', row.get('sha256')) for row in old_assets}
    author_page = pages / 'josh-homepage.html'
    songs, clips, tags = parse_josh_page(author_page.read_text(encoding='utf-8'))
    josh = []
    for key, row in songs.items():
        clip = clips.get((key, 'Primary'))
        if not clip or row.get('is_production') or (key, 'Instrumental') not in clips:
            continue
        url = urllib.parse.urljoin('https://www.joshwoodward.com/', clip['url'])
        if not url.startswith('https://www.joshwoodward.com/mp3/') or url in existing_urls:
            continue
        josh.append({**row, 'audio_url': url, 'tags': sorted(tags[key])})
    josh = choose_diverse(josh, args.josh_count, lambda x:x.get('genre', 'unknown'), lambda x:x['tags'], lambda x:x['song_id'])
    josh_meta = write_json(output / 'josh-selected-publisher-metadata.json', {
        'kind': 'publisher_catalogue_excerpt_not_auditory_verification',
        'source_page': 'https://www.joshwoodward.com/',
        'source_page_evidence': {'path': str(author_page), 'sha256': digest_file(author_page)},
        'available_song_records': len(songs), 'records': josh})
    acquisition = []
    for row in josh:
        labels = [row.get('genre') or 'unknown', *row['tags']]
        acquisition.append({'record_id': 'josh-woodward:catalogue-' + str(row['song_id']) + ':full-song',
            'recording_family_id': 'josh-woodward:catalogue-' + str(row['song_id']),
            'title': row['name'], 'artist': 'Josh Woodward', 'publisher_variant_label': 'Full Song',
            'source_page': 'https://www.joshwoodward.com/', 'download_url': row['audio_url'],
            'publisher_metadata': josh_meta, 'publisher_tags': labels, 'vocal_language_hint': 'English',
            'description': 'Publisher metadata: ' + ', '.join(labels) + '. Words, sound and suitability pending.',
            'requested_extent': 'publisher_full_recording', 'preset_ids': proposed_presets(labels),
            'preset_association_basis': 'publisher_metadata_editorial_hypothesis_not_usage_approval',
            'conditions': ['actual_lyrics_and_dialogue_competition_must_be_checked'],
            'exclusions': ['unverified_lyrics_as_verified'], 'origin': 'independent_library',
            'usage_scope': 'diagnostic_research_pending_sound_and_use_review',
            'sound_review': 'pending', 'usage_review': 'pending'})
    catalogue = read_json(pages / 'incompetech-pieces.json')
    scores = []
    for row in catalogue:
        if not row.get('isrc') or not row.get('filename') or not bounded_catalogue_duration(row.get('length')):
            continue
        url = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + urllib.parse.quote(row['filename'])
        if url in existing_urls or 'incompetech:' + row['isrc'] in existing_families:
            continue
        scores.append({**row, 'audio_url': url})
    scores = choose_diverse(scores, args.score_count, lambda x:x.get('genre', 'unknown'),
        lambda x:re.split(r',\s*', (x.get('feel') or '') + ', ' + (x.get('instruments') or '')), lambda x:x['isrc'])
    score_meta = write_json(output / 'incompetech-selected-publisher-metadata.json', {
        'kind': 'publisher_catalogue_excerpt_not_auditory_verification',
        'source_page': 'https://incompetech.com/music/royalty-free/pieces.json',
        'catalogue_sha256': digest_file(pages / 'incompetech-pieces.json'), 'records': scores})
    for row in scores:
        labels = [row.get('feel') or '', row.get('instruments') or '']
        acquisition.append({'record_id': 'incompetech:' + row['isrc'], 'recording_family_id': 'incompetech:' + row['isrc'],
            'title': row['title'], 'artist': 'Kevin MacLeod', 'publisher_variant_label': 'Score',
            'source_page': 'https://incompetech.com/music/royalty-free/', 'download_url': row['audio_url'],
            'require_url_in_page': False, 'publisher_catalogue': score_meta,
            'publisher_description': row.get('description', ''), 'publisher_feel': row.get('feel'),
            'publisher_instruments': row.get('instruments'), 'publisher_bpm': row.get('bpm'),
            'description': 'Publisher metadata: ' + ', '.join(labels),
            'requested_extent': 'publisher_full_recording', 'preset_ids': proposed_presets(labels),
            'preset_association_basis': 'publisher_metadata_editorial_hypothesis_not_usage_approval',
            'conditions': ['actual_sound_and_plot_fit_must_be_checked'],
            'origin': 'independent_library', 'usage_scope': 'diagnostic_research_pending_sound_and_use_review',
            'sound_review': 'pending', 'usage_review': 'pending'})
    reusable = [row for row in legacy if row.get('source_collection', '').startswith('mtg-jamendo')
        and row.get('source_sha256') not in existing_shas
        and Path(row.get('local_path', '')).is_file()
        and 90 <= float(row.get('duration_seconds', 0)) <= 480]
    reused = choose_diverse(reusable, args.reuse_count, lambda x:x.get('source_artist_id'),
        lambda x:x.get('source_tags', []), lambda x:x.get('source_track_id'))
    for row in reused:
        row['record_id'] = row.get('source_track_id', row['asset_id'])
        row['recording_family_id'] = row['family_id']
        row['origin'] = 'independent_library'
        row['artist'] = row.get('creator')
        row['requested_extent'] = 'existing_full_recording_low_bitrate_mono'
        row['description'] = 'Existing MTG research audio; publisher tags: ' + ', '.join(row.get('source_tags', []))
        row['preset_ids'] = proposed_presets(row.get('source_tags', []))
        row['preset_association_basis'] = 'publisher_metadata_editorial_hypothesis_not_usage_approval'
        row['usage_scope'] = 'research_noncommercial'
        row['commercial_use_allowed'] = False
        row['sound_review'] = row['usage_review'] = 'pending'
    reused_ref = write_json(output / 'reused-research-catalogue.json', {'records': reused,
        'source_catalogue': {'path': str(Path(args.legacy_catalogue).absolute()), 'sha256': digest_file(args.legacy_catalogue)},
        'new_downloads': 0, 'usage_scope': 'research_noncommercial'})
    config = {'schema_version': 1, 'mode': 'research', 'trial_review_policy': 'diagnostic_candidates',
        'python': sys.executable,
        'source_catalogues': [publication['assets'], reused_ref], 'acquisition_inputs': acquisition,
        'acquisition_dir': str(Path(args.audio_root).absolute() / 'recordings'),
        'output_dir': str(output / 'music-packs'), 'timeout_ms': 25 * 60 * 1000}
    config_ref = write_json(output / 'build-config.json', config)
    receipt = {'existing_independent_recordings': len(old_assets), 'new_downloads_requested': len(acquisition),
        'new_author_vocal_candidates_requested': len(josh), 'new_score_candidates_requested': len(scores),
        'existing_research_recordings_selected_for_reuse': len(reused),
        'reused_distinct_artists': len({x.get('source_artist_id') for x in reused}),
        'publisher_metadata_only': True, 'new_approved_windows': 0, 'config': config_ref}
    write_json(output / 'intake-receipt.json', receipt)
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
