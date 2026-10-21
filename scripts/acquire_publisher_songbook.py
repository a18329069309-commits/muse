"""Collect explicitly published song recordings and lyric evidence, not voice tags.

This source adapter only follows real author songbook/page links. Published
words are retrieval evidence, never approved singing boundaries or dramatic use.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import html
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

from independent_music_pack_library import acquire_inputs, digest_file, read_json, write_json


def fetch_saved(url, file):
    file = Path(file)
    if not file.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'IndependentMusicPacks/1.0'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError('publisher_page_over_limit')
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(body)
    return file.read_text(encoding='utf-8')


def text_only(value):
    return html.unescape(re.sub('<[^>]+>', ' ', value)).strip()


def songbook_links(text):
    content = text[text.find('All of my songs'):]
    links = []
    seen = set()
    pattern = r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
    matches = list(re.finditer(pattern, content, re.S))
    for index, match in enumerate(matches):
        url = urllib.parse.urljoin('https://www.davidrovics.com/', html.unescape(match[1]))
        if '/songbook/' not in url or url.rstrip('/') == 'https://www.davidrovics.com/songbook' or url in seen:
            continue
        seen.add(url)
        end = matches[index + 1].start() if index + 1 < len(matches) else match.end() + 500
        description = text_only(content[match.end():end])[:1000]
        links.append({'source_page': url, 'title': text_only(match[2]),
            'publisher_description': description})
    return links


def song_record_from_page(item, text, evidence):
    content = text.split('class="entry-content"', 1)[-1]
    if not re.search(r'<audio(?:\s|>)', content):
        raise ValueError('no_explicit_author_audio_element')
    match = re.search(r'<source\s+[^>]*src="([^"]+)"', content, re.S)
    if not match:
        raise ValueError('no_explicit_author_audio_url')
    url = html.unescape(match[1]).split('?', 1)[0]
    if not url.startswith('https://www.davidrovics.com/') or not url.endswith('.mp3'):
        raise ValueError('not_author_mp3_download')
    after_audio = content.split('</audio>', 1)[-1]
    paragraphs = re.findall(r'<p\b[^>]*>(.*?)</p>', after_audio, re.S)
    # Song lines are explicitly laid out with line breaks; prose commentary,
    # widgets and biography cannot satisfy the published-lyrics requirement.
    verses = [paragraph for paragraph in paragraphs if re.search(r'<br\s*/?>', paragraph, re.I)]
    words = sum(len(re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)?", text_only(verse))) for verse in verses)
    if words < 30:
        raise ValueError('no_substantial_publisher_lyric_lines')
    key = urllib.parse.urlsplit(item['source_page']).path.strip('/').replace('/', '-')
    return {'record_id': 'david-rovics/' + key, 'recording_family_id': 'david-rovics/' + key,
        'artist': 'David Rovics', 'title': item['title'], 'publisher_variant_label': 'Full Song',
        'publisher_lyrics_presence_basis': 'explicit_author_lyric_lines_with_song_recording',
        'publisher_lyric_word_count': words, 'publisher_lyric_page_evidence': evidence,
        'publisher_description': item['publisher_description'],
        'publisher_tags': ['English', 'Song', 'Published lyrics'],
        'vocal_language_hint': 'English', 'source_page': item['source_page'], 'download_url': url,
        'requested_extent': 'publisher_full_recording', 'origin': 'independent_library',
        'preset_ids': [], 'description': 'Author song and lyric evidence; actual singing, wording, phrase and use unreviewed. ' + item['publisher_description'],
        'conditions': ['actual_lyric_semantics_and_dialogue_competition_must_be_checked'],
        'exclusions': ['specific_publisher_subject_cannot_be_ignored', 'unverified_lyrics_as_verified'],
        'sound_review': 'pending', 'usage_review': 'pending', 'lyrics_alignment_status': 'not_checked',
        'commercial_use_status': 'not_approved_by_this_adapter'}


def collect(config):
    root = Path(config['output_dir']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    index_file = root / 'songbook-index.html'
    index_text = fetch_saved('https://www.davidrovics.com/songbook/', index_file)
    items = songbook_links(index_text)
    preference = re.compile(r'love|hope|friend|\bkids\b|child|campfire|bicycle|humor|funny|memory|simple|singing|musician|nature|music|suburb|family|earth spins', re.I)
    # Prefer broadly described songs first. This is an acquisition order, not
    # an endorsement of the lyrics for any future short-drama scene.
    items.sort(key=lambda row: (not bool(preference.search(row['publisher_description'])), row['title']))
    limit = min(int(config.get('maximum_page_candidates', 100)), 500)
    failures = []
    def inspect(item):
        slug = urllib.parse.urlsplit(item['source_page']).path.strip('/').replace('/', '-')
        page_file = root / 'pages' / (slug + '.html')
        try:
            text = fetch_saved(item['source_page'], page_file)
            record = song_record_from_page(item, text,
                {'path': str(page_file), 'sha256': digest_file(page_file)})
            return record, None
        except Exception as error:
            return None, {'source_page': item['source_page'], 'error': type(error).__name__ + ': ' + str(error)}
    verified = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for row, gap in pool.map(inspect, items[:limit]):
            if row: verified.append(row)
            if gap: failures.append(gap)
    count = min(int(config.get('target_recordings', 48)), 500)
    request = verified[:count]
    request_binding = write_json(root / 'acquisition-request.json', {'inputs': request,
        'index_evidence': {'path': str(index_file), 'sha256': digest_file(index_file)},
        'candidate_pages': len(items), 'checked_pages': min(len(items), limit), 'page_gaps': failures})
    results = acquire_inputs(request, config['media_root'])
    good = [row for row in results if row['status'] != 'acquisition_gap']
    bad = [row for row in results if row['status'] == 'acquisition_gap']
    return {'catalogue': write_json(root / 'acquired-catalogue.json', {'records': good}),
        'request': request_binding, 'recordings_requested': len(request), 'recordings_acquired': len(good),
        'publisher_lyrical_candidates': len(good), 'page_gaps': failures, 'acquisition_gaps': bad,
        'sound_approved': 0, 'usage_approved': 0, 'complete_lyric_boundaries_approved': 0,
        'model_calls': 0, 'paid_calls': 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = collect(read_json(args.config)); write_json(args.output, result)
    print(json.dumps({key: value for key, value in result.items() if key not in ('page_gaps', 'acquisition_gaps')}, ensure_ascii=False))


if __name__ == '__main__': main()
