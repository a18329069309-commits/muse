"""Acquire public reference episodes or Apple previews without session credentials."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

PAGE_HOSTS = {'hongguoduanju.com', 'www.bilibili.com', 'www.douyin.com',
              'music.apple.com', 'itunes.apple.com'}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def fetch(url):
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urlopen(request, timeout=30) as response:
        return response.read(), response.status


class JsonLD(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('type') == 'application/ld+json':
            self.active = True
            self.parts = []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.blocks.append(json.loads(''.join(self.parts)))
            self.active = False


def public_video_urls(body):
    parser = JsonLD()
    parser.feed(body.decode('utf-8'))
    urls = []

    def visit(value):
        if isinstance(value, dict):
            kind = value.get('@type', [])
            if (kind == 'VideoObject' or isinstance(kind, list) and 'VideoObject' in kind) and value.get('contentUrl'):
                urls.append(value['contentUrl'])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for block in parser.blocks:
        visit(block)
    return list(dict.fromkeys(urls))


def inspect_file(path, runner=subprocess.run):
    process = runner(['ffprobe', '-v', 'error', '-show_entries',
                      'format=duration:stream=codec_name,codec_type,width,height,sample_rate,channels',
                      '-of', 'json', str(path)], capture_output=True, text=True, encoding='utf-8')
    if process.returncode:
        raise ValueError('ffprobe could not read acquired media')
    probe = json.loads(process.stdout)
    if not any(s.get('codec_type') == 'audio' for s in probe.get('streams', [])):
        raise ValueError('acquired media has no audio stream')
    duration = float(probe['format']['duration'])
    if duration <= 0:
        raise ValueError('acquired media duration is not positive')
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest(path),
            'duration_seconds': duration, 'probe': probe}


def acquire_reference_media(url, out, yt_dlp, max_attempts=2, fetcher=fetch, runner=subprocess.run):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in PAGE_HOSTS or parsed.username or parsed.password:
        raise ValueError('source must be an HTTPS public platform page without credentials')
    if any(k.lower() in {'cookie', 'session', 'access_token', 'token', 'api_key', 'authorization'}
           for k in parse_qs(parsed.query)):
        raise ValueError('session credentials are not accepted')
    if max_attempts not in (1, 2):
        raise ValueError('max_attempts must be 1 or 2')
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    version = runner([str(yt_dlp), '--version'], capture_output=True, text=True, encoding='utf-8')
    if version.returncode:
        raise ValueError('yt-dlp executable is not available')
    receipt = {'schema': 'public-reference-acquisition-v1', 'source_url': url,
               'anonymous_no_session_cookies': True, 'tool_version': version.stdout.strip(),
               'tool_sha256': digest(yt_dlp), 'series_complete': False,
               'listening_status': 'not_performed_by_acquisition', 'attempts': [], 'media': []}
    apple = parsed.hostname in ('music.apple.com', 'itunes.apple.com')
    query = parse_qs(parsed.query)
    selected_track = query.get('i', [None])[0]
    if apple:
        ids = re.findall(r'\d+', parsed.path)
        identifier = query.get('id', [ids[-1] if ids else None])[0]
        if not identifier:
            raise ValueError('Apple page must contain a numeric collection or track ID')
        metadata_url = f'https://itunes.apple.com/lookup?id={identifier}&entity=song&country=us'
    else:
        metadata_url = url
    for number in range(1, max_attempts + 1):
        attempt = {'number': number, 'metadata_url': metadata_url, 'media': []}
        try:
            body, status = fetcher(metadata_url)
            attempt.update({'http_status': status, 'metadata_sha256': hashlib.sha256(body).hexdigest()})
            if status != 200:
                raise ValueError(f'public page HTTP {status}')
            if apple:
                tracks = json.loads(body.decode('utf-8')).get('results', [])
                tracks = [t for t in tracks if t.get('previewUrl') and
                          (selected_track is None or str(t.get('trackId')) == selected_track)]
                if not tracks:
                    raise ValueError('official lookup returned no public preview')
                for track in tracks:
                    preview = track['previewUrl']
                    if urlsplit(preview).hostname != 'audio-ssl.itunes.apple.com' or '/AudioPreview' not in preview:
                        raise ValueError('preview is not on the official Apple audio host')
                    data, media_status = fetcher(preview)
                    if media_status != 200:
                        raise ValueError(f'public preview HTTP {media_status}')
                    path = out / f"track-{track['trackId']}-official-preview.m4a"
                    path.write_bytes(data)
                    record = inspect_file(path, runner)
                    record.update({'scope': 'official_public_preview_not_full_track',
                                   'track_id': track['trackId'], 'track_name': track.get('trackName'),
                                   'artist': track.get('artistName'), 'preview_url': preview,
                                   'full_track_duration_ms': track.get('trackTimeMillis'),
                                   'preview_full_track_start_seconds': None})
                    attempt['media'].append(record)
            else:
                urls = public_video_urls(body)
                if len(urls) > 1:
                    raise ValueError('page contains multiple videos; select an individual episode page')
                media_url = urls[0] if urls else url
                if urlsplit(media_url).scheme != 'https':
                    raise ValueError('public media URL must use HTTPS')
                command = [str(yt_dlp), '--ignore-config', '--no-playlist', '--socket-timeout', '20',
                           '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0',
                           '--newline', '--encoding', 'utf-8', '-f', 'best', '--referer', url,
                           '-o', str(out / f'attempt-{number}-public.%(ext)s'), media_url]
                process = runner(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
                log = out / f'attempt-{number}.log'
                log.write_text((process.stdout or '') + (process.stderr or ''), encoding='utf-8')
                attempt.update({'exit_code': process.returncode, 'log': str(log),
                                'entry': 'public_JSONLD_contentUrl' if urls else 'public_platform_page',
                                'public_media_host': urlsplit(media_url).hostname})
                if process.returncode:
                    raise ValueError('yt-dlp failed; see anonymous acquisition log')
                for path in sorted(out.glob(f'attempt-{number}-*')):
                    if path.suffix in ('.mp4', '.mkv', '.webm', '.m4a', '.flv', '.wav'):
                        attempt['media'].append(inspect_file(path, runner))
                if not attempt['media']:
                    raise ValueError('yt-dlp returned success without readable audio media')
                for record in attempt['media']:
                    record['scope'] = 'public_episode_or_clip_not_complete_series'
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            attempt['error'] = str(error)
        receipt['attempts'].append(attempt)
        if 'error' not in attempt:
            receipt['media'] = attempt['media']
            break
    receipt['status'] = 'acquired_pending_listening' if receipt['media'] else 'acquisition_failed'
    (out / 'acquisition-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--out', required=True, help='A new output directory; existing directories are rejected')
    parser.add_argument('--yt-dlp', required=True)
    parser.add_argument('--max-attempts', type=int, default=2, choices=(1, 2))
    args = parser.parse_args()
    result = acquire_reference_media(args.url, args.out, args.yt_dlp, args.max_attempts)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['media'] else 1)
