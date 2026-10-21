"""Inspect bound anonymous FlickReels sources; never download media or submit fingerprints."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def binding(file):
    file = Path(file).resolve()
    with file.open('rb') as stream:
        return {'path': str(file), 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def verified_read(reference):
    if not isinstance(reference, dict) or not isinstance(reference.get('path'), str) \
            or not re.fullmatch(r'[a-f0-9]{64}', reference.get('sha256', '')):
        raise ValueError('source_evidence_binding_required')
    if binding(reference['path'])['sha256'] != reference['sha256']:
        raise ValueError('source_evidence_hash_changed')
    return read(reference['path'])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_get(url, maximum_bytes=8 * 1024 * 1024):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.fragment or parts.port:
        raise ValueError('public_https_url_without_credentials_required')
    if parts.hostname != 'www.flickreels.net' and not (parts.hostname or '').endswith('.farsunpteltd.net'):
        raise ValueError('unexpected_public_host')
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0'}, method='GET')
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=20) as response:
        raw = response.read(maximum_bytes + 1)
        if len(raw) > maximum_bytes:
            raise ValueError('public_response_size_limit')
        return raw, {'url_host': parts.hostname, 'url_sha256': digest(url.encode()),
            'status': response.status, 'body_sha256': digest(raw), 'bytes': len(raw),
            'content_type': response.headers.get('Content-Type', '').split(';')[0],
            'cookies_sent': False, 'authorization_sent': False, 'login_used': False,
            'session_reused': False, 'proxy_environment_used': False, 'redirect_followed': False}


def nuxt_catalog(html):
    scripts = re.findall(r'<script([^>]*)>(.*?)</script>', html, re.S)
    array = json.loads(next(body for attrs, body in scripts if '__NUXT_DATA__' in attrs))

    def decode(value, seen=None):
        seen = set() if seen is None else seen
        if isinstance(value, int):
            if value < 0 or value in seen:
                return None
            seen = seen | {value}
            value = array[value]
        if isinstance(value, dict):
            return {key: decode(child, seen) for key, child in value.items()}
        if isinstance(value, list):
            return [decode(child, seen) for child in value]
        return value

    catalog = next(decode(item) for item in array if isinstance(item, dict)
                   and 'start_pay_num' in item and 'playlet_id' in item)
    videos = [json.loads(body) for attrs, body in scripts if 'application/ld+json' in attrs]
    video = next(item for item in videos if isinstance(item, dict)
                 and item.get('@type') == 'VideoObject' and item.get('contentUrl'))
    return catalog, video


def validate_task(task):
    if not isinstance(task, dict) or any(not isinstance(task.get(key), str) or not task[key].strip()
            for key in ('task_id', 'title', 'work_id', 'episode_id')) \
            or len(task.get('acquisition_receipts', [])) != 1:
        raise ValueError('exact_source_task_required')
    receipt_reference = task['acquisition_receipts'][0]
    receipt = verified_read(receipt_reference)
    case = verified_read(task.get('source_case'))
    source = task.get('reference_video') or {}
    if not source.get('path') or binding(source['path'])['sha256'] != source.get('sha256'):
        raise ValueError('actual_local_source_sha_mismatch')
    media = receipt.get('media') or {}
    page = urlsplit(receipt.get('source_page', ''))
    match = re.fullmatch(r'/tc/playlist/[^/]+/([1-9][0-9]*)/episode-([1-9][0-9]*)', page.path)
    if page.scheme != 'https' or page.hostname != 'www.flickreels.net' or page.username or page.password \
            or page.port or page.query or page.fragment or not match:
        raise ValueError('flick_exact_public_page_required')
    series, number = match.group(1), int(match.group(2))
    chapter = str(receipt.get('source_episode_id', ''))
    if not chapter.isdecimal() or receipt.get('episode_number') != number \
            or receipt.get('source_uid') != f'flickreels:{series}:{chapter}' \
            or f'/flickreels-tc-{series}/episode-{number:03}/' not in task['episode_id']:
        raise ValueError('flick_native_reference_identity_mismatch')
    if receipt.get('status') != 'acquired_verified' or media.get('full_decode_success') is not True \
            or receipt.get('public_jsonld_content_url_used') is not True or receipt.get('fresh_is_lock') != 0 \
            or not isinstance(receipt.get('free_start_pay_num'), int) or number >= receipt['free_start_pay_num']:
        raise ValueError('flick_verified_anonymous_acquisition_required')
    if media.get('sha256') != source['sha256'] or not media.get('path') \
            or Path(media['path']).resolve() != Path(source['path']).resolve():
        raise ValueError('flick_source_identity_mismatch')
    if case.get('work', {}).get('work_id') != task['work_id'] \
            or case.get('episode', {}).get('episode_id') != task['episode_id'] \
            or case.get('episode', {}).get('work_id') != task['work_id'] \
            or case.get('episode', {}).get('source_video', {}).get('sha256') != source['sha256']:
        raise ValueError('flick_registered_case_identity_mismatch')
    return receipt_reference, receipt, source


def actual_probe(source):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
        'stream=index,codec_type,width,height,start_time,duration:format=duration', '-of', 'json', source],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return json.loads(result.stdout)


def check_fresh(receipt, fetch=public_get):
    started = time.monotonic()
    result = {'status': 'pending', 'network_get_attempts': 0, 'network_gets': 0}

    def get(url, limit=8 * 1024 * 1024):
        if result['network_get_attempts'] >= 3:
            raise ValueError('per_source_three_get_limit')
        result['network_get_attempts'] += 1
        raw, facts = fetch(url, limit)
        result['network_gets'] += 1
        return raw, facts

    try:
        raw, result['page_request'] = get(receipt['source_page'])
        catalog, video = nuxt_catalog(raw.decode('utf-8'))
        chapter = next(item for item in catalog['list'] if int(item['chapter_num']) == receipt['episode_number'])
        result['catalog'] = {'series_id': str(catalog['playlet_id']), 'declared_episode_count': int(catalog['upload_num']),
            'public_before_episode': int(catalog['start_pay_num']), 'episode_number': int(chapter['chapter_num']),
            'source_episode_id': str(chapter['chapter_id']), 'is_lock': chapter['is_lock']}
        content_url = video['contentUrl']
        result['video_jsonld'] = {'type': video.get('@type'), 'content_host': urlsplit(content_url).hostname,
            'content_url_sha256': digest(content_url.encode()), 'duration': video.get('duration'),
            'name_sha256': digest(str(video.get('name', '')).encode())}
        if chapter['is_lock'] != 0 or receipt['episode_number'] >= int(catalog['start_pay_num']):
            result['status'] = 'not_currently_anonymous_unlocked'
            return result
        if str(chapter['chapter_id']) != str(receipt['source_episode_id']) \
                or str(catalog['playlet_id']) != receipt['source_uid'].split(':')[1]:
            result['status'] = 'source_episode_identity_changed'
            return result
        body, result['playlist_request'] = get(content_url, 1024 * 1024)
        playlist = body.decode('utf-8')
        if '#EXT-X-STREAM-INF' in playlist:
            child = next(line.strip() for line in playlist.splitlines() if line.strip() and not line.startswith('#'))
            body, result['selected_playlist_request'] = get(urljoin(content_url, child), 1024 * 1024)
            playlist = body.decode('utf-8')
        if '#EXT-X-STREAM-INF' in playlist:
            raise ValueError('nested_master_playlist_not_supported')
        durations = [float(value) for value in re.findall(r'^#EXTINF:([0-9.]+)', playlist, re.M)]
        result['playlist'] = {'duration_seconds': sum(durations), 'segment_count': len(durations),
            'endlist': '#EXT-X-ENDLIST' in playlist, 'body_sha256': digest(body)}
        if not result['playlist']['endlist'] or len(durations) != receipt.get('segment_count') \
                or digest(body) != receipt.get('hls_sha256') \
                or abs(sum(durations) - float(receipt.get('hls_duration_seconds', 0))) > .01:
            result['status'] = 'fresh_public_playlist_receipt_mismatch'
            return result
        result['status'] = 'fresh_anonymous_catalog_and_playlist_checked'
        return result
    except Exception as error:
        # Never save arbitrary exception messages containing opaque signed URLs.
        result['status'] = 'fresh_public_check_failed'
        result['error_type'] = type(error).__name__
        if hasattr(error, 'code') and isinstance(error.code, int):
            result['http_status'] = error.code
        return result
    finally:
        result['wall_seconds'] = time.monotonic() - started


def inspect_sources(queue_file, output_directory, *, task_id=None, fetch=public_get, probe=actual_probe):
    queue_file = Path(queue_file).resolve()
    queue_binding = binding(queue_file)
    queue = verified_read(queue_binding)
    if not isinstance(queue.get('tasks'), list) or not queue['tasks'] \
            or len({row.get('task_id') for row in queue['tasks']}) != len(queue['tasks']):
        raise ValueError('unique_source_tasks_required')
    tasks = queue['tasks']
    if task_id is not None:
        tasks = [row for row in tasks if row.get('task_id') == task_id]
        if len(tasks) != 1:
            raise ValueError('selected_source_task_not_found')
    created_at = datetime.now(timezone.utc).isoformat()
    out = Path(output_directory).resolve()
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    for task in tasks:
        row = {key: task.get(key) for key in ('task_id', 'title', 'work_id', 'episode_id', 'source_case')}
        try:
            receipt_reference, receipt, source = validate_task(task)
            row.update(original_acquisition_receipt=receipt_reference, source=binding(source['path']),
                source_uid=receipt['source_uid'], receipt_episode_number=receipt['episode_number'],
                receipt_source_episode_id=str(receipt['source_episode_id']),
                source_page_host=urlsplit(receipt['source_page']).hostname,
                source_page_url_sha256=digest(receipt['source_page'].encode()),
                actual_probe=probe(source['path']))
            duration = float(row['actual_probe']['format']['duration'])
            if abs(duration - float(receipt['media'].get('duration_seconds', 0))) > .05:
                raise ValueError('flick_media_duration_mismatch')
            row['fresh_check'] = check_fresh(receipt, fetch)
            row.update(original_receipt_after_check=binding(receipt_reference['path']),
                source_after_check=binding(source['path']), no_authentication_or_session=True,
                opaque_urls_printed_or_persisted=False)
            playlist = row['fresh_check'].get('playlist')
            if playlist and abs(duration - float(playlist['duration_seconds'])) > .25:
                row['fresh_check']['status'] = 'flick_media_duration_mismatch'
            if row['source_after_check']['sha256'] != source['sha256'] \
                    or row['original_receipt_after_check']['sha256'] != receipt_reference['sha256']:
                row['fresh_check']['status'] = 'source_or_original_receipt_changed_during_inspection'
        except Exception as error:
            row['fresh_check'] = {'status': 'source_validation_failed', 'error_type': type(error).__name__,
                'network_get_attempts': row.get('fresh_check', {}).get('network_get_attempts', 0),
                'network_gets': row.get('fresh_check', {}).get('network_gets', 0)}
        rows.append(row)
    if binding(queue_file)['sha256'] != queue_binding['sha256']:
        raise ValueError('source_queue_changed_during_inspection')
    record = {'schema_version': 1, 'created_at': created_at,
        'inspection_script': binding(__file__), 'tasks': rows, 'source_queue': queue_binding,
        'execution_kind': 'actual_anonymous_public_inspection' if fetch is public_get and probe is actual_probe
                          else 'injected_offline_test',
        'raw_signed_urls_saved': False, 'media_downloaded': False, 'shazam_posts': 0,
        'private_media_uploads': 0, 'paid_calls': 0, 'old_receipts_modified': False, 'new_models': 0,
        'qualification_granted': False, 'per_source_maximum_gets': 3}
    file = out / 'public-source-inspection.json'
    with file.open('x', encoding='utf-8') as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return binding(file), record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--queue', required=True, type=Path)
    parser.add_argument('--task-id', help='Inspect exactly one registered task; missing task is refused before HTTP.')
    parser.add_argument('--out', required=True, type=Path, help='New evidence directory; existing output is refused.')
    args = parser.parse_args()
    artifact, record = inspect_sources(args.queue, args.out, task_id=args.task_id)
    print(json.dumps({'artifact': artifact, 'results': [{'task_id': row['task_id'],
        'status': row['fresh_check']['status'], 'network_get_attempts': row['fresh_check']['network_get_attempts'],
        'network_gets': row['fresh_check']['network_gets']} for row in record['tasks']],
        'shazam_posts': 0, 'media_downloaded': False, 'qualification_granted': False}, ensure_ascii=True))


if __name__ == '__main__':
    main()
