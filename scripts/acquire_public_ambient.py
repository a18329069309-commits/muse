"""Acquire explicitly linked author ambient recordings with technical receipts.

Publisher environmental labels do not certify absence of dialogue or noise.
No human review or auditory event anchor is manufactured by this adapter.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import html
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

from independent_music_pack_library import digest_file, probe_audio, read_json, write_json
from acquire_publisher_songbook import fetch_saved


def acquire(config):
    inputs = config['inputs']
    if len(inputs) > 500:
        raise ValueError('ambient_acquisition_batch_over_500')
    root = Path(config['media_root']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    def get(item):
        key = re.sub(r'[^a-zA-Z0-9._-]', '-', item['record_id'])
        page = root / (key + '.page.html')
        receipt = root / (key + '.receipt.json')
        try:
            if not item['download_url'].startswith('https://') or not item['source_page'].startswith('https://'):
                raise ValueError('ambient_https_required')
            suffix = Path(urllib.parse.urlsplit(item['download_url']).path).suffix.lower()
            if suffix not in ('.ogg', '.wav', '.mp3', '.flac'):
                raise ValueError('ambient_explicit_audio_file_required')
            destination = root / (key + suffix)
            if receipt.exists():
                prior = read_json(receipt)
                if not destination.is_file() or digest_file(destination) != prior['source_sha256']:
                    raise ValueError('ambient_acquisition_cache_sha_changed')
                return {**prior, 'cache_reused': True}, None
            text = html.unescape(fetch_saved(item['source_page'], page))
            links = [urllib.parse.urljoin(item['source_page'], url) for url in re.findall(r'href="([^"]+)"', text)]
            if item['download_url'] not in links:
                raise ValueError('ambient_download_not_explicitly_linked')
            if destination.exists():
                raise ValueError('ambient_unfinished_file_preserved')
            request = urllib.request.Request(item['download_url'], headers={'User-Agent': 'IndependentMusicPacks/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response, destination.open('xb') as output:
                expected = response.headers.get('Content-Length')
                total = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    total += len(chunk)
                    if total > 40 * 1024 * 1024:
                        raise ValueError('ambient_download_over_limit')
                    output.write(chunk)
            if expected and int(expected) != total:
                raise ValueError('ambient_download_incomplete')
            facts = probe_audio(destination)
            row = {**item, **facts, 'asset_id': item['record_id'], 'asset_kind': 'ambient',
                'path': str(destination), 'local_path': str(destination), 'source_sha256': facts['sha256'],
                'source_page_evidence': {'path': str(page), 'sha256': digest_file(page)},
                'listening_status': 'pending', 'sound_review': 'pending', 'usage_review': 'pending',
                'anchor_candidates': {}, 'human_review_record': None,
                'narrative_functions': [], 'production_approval': False,
                'commercial_use': item.get('commercial_use', False)}
            write_json(receipt, row)
            return row, None
        except Exception as error:
            gap = {'record_id': item['record_id'], 'error': type(error).__name__ + ': ' + str(error)}
            write_json(root / (key + '.failure.json'), gap)
            return None, gap
    assets, gaps = [], []
    # All current sources share a domain; bounded two-file concurrency.
    with ThreadPoolExecutor(max_workers=2) as pool:
        for row, gap in pool.map(get, inputs):
            if row: assets.append(row)
            if gap: gaps.append(gap)
    out = Path(config['output_dir']).resolve()
    return {'source_catalogue': write_json(out / 'ambient-catalogue.json', {'assets': assets}),
        'recordings_acquired': len(assets), 'gaps': gaps,
        'sound_approved': 0, 'usage_approved': 0, 'model_calls': 0, 'paid_calls': 0}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args(); result = acquire(read_json(args.config)); write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
