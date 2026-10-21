"""Validate a publicly acquired FlickReels episode without sending a fingerprint.

The receipt remains unchanged. Fresh anonymous evidence and the bound source task
are checked separately; no ThePaper flags or IDs are invented.
"""
import argparse
import hashlib
import json
import pathlib
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


def read(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def file_hash(file):
    with pathlib.Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verified_read(reference):
    if not isinstance(reference, dict) or not re.fullmatch(r'[a-f0-9]{64}', reference.get('sha256', '')):
        raise ValueError('flick_evidence_binding_required')
    if file_hash(reference['path']) != reference['sha256']:
        raise ValueError('flick_evidence_hash_changed')
    return read(reference['path'])


def same_binding(a, b):
    return a.get('sha256') == b.get('sha256') and pathlib.Path(a['path']).resolve() == pathlib.Path(b['path']).resolve()


def public_page_parts(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname != 'www.flickreels.net' or parts.username or parts.password \
            or parts.port or parts.query or parts.fragment:
        raise ValueError('flick_exact_public_page_required')
    match = re.fullmatch(r'/tc/playlist/[^/]+/([1-9][0-9]*)/episode-([1-9][0-9]*)', parts.path)
    if not match:
        raise ValueError('flick_episode_page_path_required')
    return match.group(1), int(match.group(2))


def verify_flick_public_acquisition(spec, *, now=None):
    queue = verified_read(spec.get('source_task_binding'))
    task = next((row for row in queue['tasks'] if row['task_id'] == spec.get('source_task_id')), None)
    if not task or len(task.get('acquisition_receipts', [])) != 1:
        raise ValueError('flick_exact_source_task_required')
    receipt_reference = spec.get('public_source_provenance')
    if not receipt_reference or not same_binding(receipt_reference, task['acquisition_receipts'][0]):
        raise ValueError('flick_registered_receipt_required')
    receipt = verified_read(receipt_reference)
    if spec.get('source_kind') != 'public_research_video' or spec.get('public_source_url') != receipt.get('source_page'):
        raise ValueError('flick_source_type_or_url_mismatch')
    series, episode = public_page_parts(receipt['source_page'])
    chapter = str(receipt.get('source_episode_id', ''))
    reference = spec.get('public_reference') or {}
    expected = {'platform': 'flickreels', 'work_id': task['work_id'], 'episode_id': task['episode_id'],
                'series_id': series, 'source_episode_id': chapter, 'episode_number': episode}
    if reference != expected or not chapter.isdecimal() or receipt.get('episode_number') != episode \
            or receipt.get('source_uid') != f'flickreels:{series}:{chapter}':
        raise ValueError('flick_native_reference_identity_mismatch')
    media = receipt.get('media') or {}
    if receipt.get('status') != 'acquired_verified' or media.get('full_decode_success') is not True \
            or receipt.get('public_jsonld_content_url_used') is not True or receipt.get('fresh_is_lock') != 0 \
            or not isinstance(receipt.get('free_start_pay_num'), int) or episode >= receipt['free_start_pay_num']:
        raise ValueError('flick_verified_anonymous_acquisition_required')
    source = spec.get('source') or {}
    if source.get('sha256') != media.get('sha256') or source.get('sha256') != task['reference_video']['sha256'] \
            or not source.get('path') or pathlib.Path(source['path']).resolve() != pathlib.Path(media['path']).resolve():
        raise ValueError('flick_source_identity_mismatch')
    if spec.get('source_case_binding') and not same_binding(spec['source_case_binding'], task['source_case']):
        raise ValueError('flick_declared_case_binding_mismatch')
    case = verified_read(task['source_case'])
    if case['work']['work_id'] != task['work_id'] or case['episode']['episode_id'] != task['episode_id'] \
            or case['episode']['work_id'] != task['work_id'] or case['episode']['source_video']['sha256'] != source['sha256'] \
            or f'/flickreels-tc-{series}/episode-{episode:03}/' not in task['episode_id']:
        raise ValueError('flick_registered_case_identity_mismatch')
    inspection = verified_read(spec.get('public_source_inspection'))
    if not same_binding(inspection['source_queue'], spec['source_task_binding']):
        raise ValueError('flick_inspection_queue_mismatch')
    producer = inspection.get('inspection_script') or {}
    if producer.get('sha256') != file_hash(producer['path']):
        raise ValueError('flick_inspection_producer_changed')
    age = ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(inspection['created_at'])).total_seconds()
    if not 0 <= age <= 3600:
        raise ValueError('flick_fresh_anonymous_evidence_required')
    checked = next((row for row in inspection['tasks'] if row['task_id'] == task['task_id']), None)
    if not checked or checked['source']['sha256'] != source['sha256'] \
            or not same_binding(checked['original_acquisition_receipt'], receipt_reference) \
            or checked['source_after_check']['sha256'] != source['sha256'] \
            or checked['original_receipt_after_check']['sha256'] != receipt_reference['sha256']:
        raise ValueError('flick_inspected_source_binding_mismatch')
    fresh = checked['fresh_check']
    catalog = fresh.get('catalog') or {}
    playlist = fresh.get('playlist') or {}
    if fresh.get('status') != 'fresh_anonymous_catalog_and_playlist_checked' or catalog.get('series_id') != series \
            or catalog.get('episode_number') != episode or catalog.get('source_episode_id') != chapter \
            or catalog.get('is_lock') != 0 or episode >= catalog.get('public_before_episode', 0) \
            or playlist.get('endlist') is not True or playlist.get('segment_count') != receipt.get('segment_count') \
            or playlist.get('body_sha256') != receipt.get('hls_sha256'):
        raise ValueError('flick_fresh_catalog_or_playlist_mismatch')
    requests = [fresh.get(name) for name in ['page_request', 'playlist_request', 'selected_playlist_request'] if fresh.get(name)]
    if len(requests) != fresh.get('network_gets') or any(request.get('status') != 200
            or any(request.get(key) is not False for key in ['cookies_sent', 'authorization_sent', 'login_used',
                'session_reused', 'proxy_environment_used', 'redirect_followed']) for request in requests):
        raise ValueError('flick_anonymous_request_evidence_required')
    if requests[0].get('url_host') != 'www.flickreels.net' \
            or requests[0].get('url_sha256') != hashlib.sha256(receipt['source_page'].encode()).hexdigest() \
            or any(not (request.get('url_host') or '').endswith('.farsunpteltd.net') for request in requests[1:]):
        raise ValueError('flick_verified_public_media_host_required')
    actual_duration = float(checked['actual_probe']['format']['duration'])
    if abs(actual_duration - float(media.get('duration_seconds', 0))) > 0.05 \
            or abs(actual_duration - float(playlist.get('duration_seconds', 0))) > 0.25 \
            or abs(float(receipt.get('hls_duration_seconds', 0)) - float(playlist.get('duration_seconds', 0))) > 0.01:
        raise ValueError('flick_media_duration_mismatch')
    if file_hash(source['path']) != source['sha256']:
        raise ValueError('flick_actual_media_sha_changed')
    return {'status': 'verified_public_flick_episode_source', 'task_id': task['task_id'],
            'source_sha256': source['sha256'], 'series_id': series, 'source_episode_id': chapter,
            'episode_number': episode, 'receipt_sha256': receipt_reference['sha256'],
            'inspection_sha256': spec['public_source_inspection']['sha256'],
            'network_posts': 0, 'music_identity_verified': False, 'qualification_granted': False}


def dispatch_public_acquisition(spec, existing_thepaper_verifier):
    """Reuse the existing fingerprint entry's validation seam only."""
    host = urlsplit(spec.get('public_source_url', '')).hostname
    if host == 'www.flickreels.net':
        return verify_flick_public_acquisition(spec)
    if host == 'www.thepaper.cn':
        return existing_thepaper_verifier(spec)
    if host == 'hongguoduanju.com':
        return verify_hongguo_public_acquisition(spec)
    raise ValueError('unsupported_public_source_provider')


def _hongguo_native_source(spec):
    """Read original Hongguo evidence plus its independent full-decode supplement."""
    receipt = verified_read(spec.get('public_source_provenance'))
    source = spec.get('source') or {}
    reference = spec.get('public_reference') or {}
    if spec.get('source_kind') != 'public_research_video' or reference.get('platform') != 'hongguo':
        raise ValueError('hongguo_native_public_source_required')
    series = str(reference.get('series_id', ''))
    episode = reference.get('episode_number')
    if not series.isdecimal() or not isinstance(episode, int) or isinstance(episode, bool) or episode < 1:
        raise ValueError('hongguo_native_episode_identity_required')
    page = urlsplit(receipt.get('source_page', ''))
    match = re.fullmatch(r'/player/([1-9][0-9]*)(?:/([1-9][0-9]*))?', page.path)
    if page.scheme != 'https' or page.hostname != 'hongguoduanju.com' or page.username or page.password \
            or page.port or page.query or page.fragment or not match or match.group(1) != series \
            or spec.get('public_source_url') != receipt.get('source_page'):
        raise ValueError('hongguo_exact_public_player_required')
    if str(receipt.get('series_id')) != series or receipt.get('episode') != episode \
            or receipt.get('work_id') != reference.get('work_id') \
            or not reference.get('episode_id', '').startswith(f"{reference.get('work_id')}/hongguo-{series}/episode-{episode:03}/"):
        raise ValueError('hongguo_source_reference_identity_mismatch')
    if episode > 1 and not match.group(2):
        raise ValueError('hongguo_explicit_player_vid_required')
    if match.group(2) and reference.get('source_episode_id') and match.group(2) != str(reference['source_episode_id']):
        raise ValueError('hongguo_native_vid_mismatch')
    if receipt.get('access') != 'anonymous_public_JSONLD' or receipt.get('archive_copy_verified') is not True \
            or receipt.get('signed_media_url_saved') is not False \
            or not (receipt.get('media_host') or '').endswith('.qznovelvod.com'):
        raise ValueError('hongguo_original_anonymous_receipt_required')
    if not source.get('path') or not same_binding(source, receipt.get('source_video') or {}) \
            or file_hash(source['path']) != source.get('sha256'):
        raise ValueError('hongguo_actual_source_identity_mismatch')
    if not reference['episode_id'].endswith('/' + source['sha256'][:12]):
        raise ValueError('hongguo_registered_source_episode_mismatch')
    validation = verified_read(spec.get('full_decode_provenance'))
    if validation.get('schema') != 'archived-public-media-validation-v1':
        raise ValueError('hongguo_native_decode_supplement_required')
    key = f"{reference['work_id']}:{series}:{episode}:{source['sha256']}"
    decoded = validation.get('entries', {}).get(key) or {}
    media = decoded.get('media') or {}
    if decoded.get('status') != 'acquired_verified' or decoded.get('platform') != 'hongguo' \
            or decoded.get('work_id') != reference['work_id'] or str(decoded.get('platform_series_id')) != series \
            or decoded.get('episode_number') != episode or decoded.get('sha256') != source['sha256'] \
            or decoded.get('full_decode_success') is not True or media.get('full_decode_success') is not True \
            or not same_binding(media, source) or decoded.get('duration_reference') != 'public_jsonld' \
            or abs(float(media.get('duration_seconds', 0)) - float(receipt.get('jsonld_duration_seconds', 0))) > 3:
        raise ValueError('hongguo_bound_full_decode_required')
    return receipt, reference, media, match.group(2)


def _hongguo_router(body):
    text = body.decode('utf-8'); marker = '_ROUTER_DATA = '; begin = text.find(marker)
    if begin < 0:
        raise ValueError('hongguo_official_router_data_missing')
    value, _ = json.JSONDecoder().raw_decode(text, begin + len(marker))
    return next((row for row in value.get('loaderData', {}).values() if isinstance(row, dict)), {})


class _HongguoNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _hongguo_metadata_get(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname != 'hongguoduanju.com' or parts.username or parts.password \
            or parts.port or parts.fragment \
            or not (parts.path == '/detail' and re.fullmatch(r'series_id=[1-9][0-9]*', parts.query)
                    or re.fullmatch(r'/player/[1-9][0-9]*(?:/[1-9][0-9]*)?', parts.path) and not parts.query):
        raise ValueError('hongguo_metadata_page_only')
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0'}, method='GET')
    with build_opener(ProxyHandler({}), _HongguoNoRedirect()).open(request, timeout=25) as response:
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise ValueError('hongguo_metadata_size_limit')
        if response.status != 200:
            raise ValueError('hongguo_metadata_http_status')
        return body, {'url_host': parts.hostname, 'url_sha256': hashlib.sha256(url.encode()).hexdigest(),
            'status': response.status, 'body_sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body),
            'cookies_sent': False, 'authorization_sent': False, 'login_used': False, 'session_reused': False,
            'proxy_environment_used': False, 'redirect_followed': False}


def inspect_hongguo_public_source(input_file, output_directory, *, fetch=_hongguo_metadata_get):
    """At most two official metadata GETs; no media GET, source modification or fingerprint POST."""
    specification = {'path': str(pathlib.Path(input_file).resolve()), 'sha256': file_hash(input_file)}
    spec = verified_read(specification)
    receipt, reference, media, path_vid = _hongguo_native_source(spec)
    out = pathlib.Path(output_directory); out.mkdir(parents=True, exist_ok=False)
    inspection = {'schema_version': 1, 'kind': 'hongguo_native_public_source_inspection_v1',
        'created_at': datetime.now(timezone.utc).isoformat(), 'inspection_script': {
            'path': str(pathlib.Path(__file__).resolve()), 'sha256': file_hash(__file__)},
        'source_specification': specification, 'source': spec['source'],
        'original_acquisition_receipt': spec['public_source_provenance'],
        'full_decode_provenance': spec['full_decode_provenance'], 'network_get_attempts': 0, 'network_gets': 0,
        'media_downloaded': False, 'network_posts': 0, 'raw_signed_urls_saved': False,
        'qualification_granted': False, 'music_identity_verified': False,
        'execution_kind': 'actual_anonymous_official_metadata' if fetch is _hongguo_metadata_get else 'injected_offline_test'}
    try:
        series, episode = reference['series_id'], reference['episode_number']
        detail_url = 'https://hongguoduanju.com/detail?series_id=' + series
        inspection['network_get_attempts'] += 1
        raw, inspection['detail_request'] = fetch(detail_url); inspection['network_gets'] += 1
        detail = _hongguo_router(raw).get('seriesDetail') or {}
        count, available = int(detail.get('episode_cnt', 0)), int(detail.get('accessible_episode_cnt', 0))
        vids = [str(value) for value in detail.get('vid_list', [])]
        if str(detail.get('series_id')) != series or detail.get('series_name') != receipt['title'] \
                or not 1 <= episode <= min(count, available, len(vids)):
            raise ValueError('hongguo_current_public_episode_not_admitted')
        vid = vids[episode - 1]
        if not vid.isdecimal() or path_vid and path_vid != vid \
                or reference.get('source_episode_id') and str(reference['source_episode_id']) != vid:
            raise ValueError('hongguo_current_native_vid_mismatch')
        inspection['detail'] = {'series_id': series, 'title': detail['series_name'], 'episode_count': count,
            'accessible_episode_count': available, 'episode_number': episode, 'source_episode_id': vid}
        inspection['network_get_attempts'] += 1
        raw, inspection['player_request'] = fetch(receipt['source_page']); inspection['network_gets'] += 1
        blocks = [json.loads(body) for body in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', raw.decode('utf-8'), re.S)]
        video = next((row for row in blocks if row.get('@type') == 'VideoObject'), None)
        if not video or video.get('name') != receipt['title'] + ' 第' + str(episode) + '集':
            raise ValueError('hongguo_current_player_identity_mismatch')
        match = re.fullmatch(r'PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?', str(video.get('duration', '')))
        if not match:
            raise ValueError('hongguo_current_player_duration_required')
        duration = sum(float(value or 0) * factor for value, factor in zip(match.groups(), [3600, 60, 1]))
        content = urlsplit(video.get('contentUrl', ''))
        url_hash = hashlib.sha256(video.get('contentUrl', '').encode()).hexdigest()
        inspection['player'] = {'name': video['name'], 'duration_seconds': duration,
            'content_host': content.hostname, 'content_url_sha256': url_hash,
            'content_path_sha256': hashlib.sha256(content.path.encode()).hexdigest(),
            'content_query_present': bool(content.query)}
        inspection['binding_checks'] = {
            'current_content_host_matches_legacy': content.hostname == receipt.get('media_host'),
            'current_signed_media_url_hash_matches_legacy': url_hash == receipt.get('media_url_sha256'),
            'player_duration_matches_original_jsonld': abs(duration - float(receipt['jsonld_duration_seconds'])) <= .01,
            'player_duration_matches_decoded_source': abs(duration - float(media['duration_seconds'])) <= 3,
            'native_series_and_episode_ordinal_checked': True, 'native_current_public_vid_checked': True}
        # Legacy Hongguo receipts stored the signed URL hash, not a stable asset
        # URL. CDN/signature changes do not identify a different episode. This
        # admission is scoped to the unchanged historical public file; it makes
        # no byte-equivalence claim about today's remote asset or its cut.
        if content.scheme != 'https' or content.username or content.password or content.port or content.fragment \
                or not (content.hostname or '').endswith('.qznovelvod.com') \
                or abs(duration - float(receipt['jsonld_duration_seconds'])) > .01 \
                or abs(duration - float(media['duration_seconds'])) > 3:
            raise ValueError('hongguo_current_public_media_binding_changed')
        inspection['native_reference'] = {**reference, 'source_episode_id': vid}
        inspection['source_admission_scope'] = 'unchanged_historically_public_file_with_current_native_public_episode_metadata'
        inspection['current_remote_bytes_equivalence_verified'] = False
        inspection['strict_screenshot_cut_coverage_granted'] = False
        inspection['status'] = 'fresh_anonymous_hongguo_detail_and_player_checked'
    except Exception as error:
        inspection['status'] = 'hongguo_public_source_gap'; inspection['error_type'] = type(error).__name__
        if isinstance(error, ValueError) and re.fullmatch(r'[a-z0-9_]+', str(error)):
            inspection['gap'] = str(error)
        if hasattr(error, 'code') and isinstance(error.code, int):
            inspection['http_status'] = error.code
    inspection['source_after_check'] = {'path': spec['source']['path'], 'sha256': file_hash(spec['source']['path'])}
    inspection['original_receipt_after_check'] = {'path': spec['public_source_provenance']['path'], 'sha256': file_hash(spec['public_source_provenance']['path'])}
    if inspection['source_after_check']['sha256'] != spec['source']['sha256'] \
            or inspection['original_receipt_after_check']['sha256'] != spec['public_source_provenance']['sha256']:
        inspection['status'] = 'hongguo_public_source_gap'; inspection['gap'] = 'hongguo_input_changed_during_inspection'
    file = out / 'public-source-inspection.json'
    with file.open('x', encoding='utf-8') as stream:
        json.dump(inspection, stream, ensure_ascii=False, indent=2); stream.write('\n')
    return {'path': str(file.resolve()), 'sha256': file_hash(file)}, inspection


def verify_hongguo_public_acquisition(spec, *, now=None):
    receipt, reference, media, path_vid = _hongguo_native_source(spec)
    inspection = verified_read(spec.get('public_source_inspection'))
    producer = inspection.get('inspection_script') or {}
    if inspection.get('kind') != 'hongguo_native_public_source_inspection_v1' \
            or inspection.get('status') != 'fresh_anonymous_hongguo_detail_and_player_checked' \
            or producer.get('sha256') != file_hash(__file__) \
            or pathlib.Path(producer.get('path', '')).resolve() != pathlib.Path(__file__).resolve():
        raise ValueError('hongguo_actual_native_inspection_required')
    age = ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(inspection['created_at'])).total_seconds()
    if not 0 <= age <= 3600:
        raise ValueError('hongguo_fresh_anonymous_evidence_required')
    if not same_binding(inspection['source'], spec['source']) \
            or not same_binding(inspection['source_after_check'], spec['source']) \
            or not same_binding(inspection['original_acquisition_receipt'], spec['public_source_provenance']) \
            or not same_binding(inspection['original_receipt_after_check'], spec['public_source_provenance']) \
            or not same_binding(inspection['full_decode_provenance'], spec['full_decode_provenance']) \
            or inspection.get('native_reference') != reference:
        raise ValueError('hongguo_inspected_native_identity_mismatch')
    detail, player = inspection.get('detail') or {}, inspection.get('player') or {}
    vid = str(reference.get('source_episode_id', ''))
    if not vid.isdecimal() or path_vid and vid != path_vid \
            or detail.get('series_id') != reference['series_id'] or detail.get('title') != receipt['title'] \
            or detail.get('episode_number') != reference['episode_number'] or detail.get('source_episode_id') != vid \
            or reference['episode_number'] > min(detail.get('episode_count', 0), detail.get('accessible_episode_count', 0)) \
            or player.get('name') != receipt['title'] + ' 第' + str(reference['episode_number']) + '集' \
            or not (player.get('content_host') or '').endswith('.qznovelvod.com') \
            or not re.fullmatch(r'[a-f0-9]{64}', player.get('content_url_sha256', '')) \
            or abs(float(player.get('duration_seconds', 0)) - float(receipt['jsonld_duration_seconds'])) > .01 \
            or abs(float(player.get('duration_seconds', 0)) - float(media['duration_seconds'])) > 3:
        raise ValueError('hongguo_fresh_native_metadata_mismatch')
    if inspection.get('source_admission_scope') != 'unchanged_historically_public_file_with_current_native_public_episode_metadata' \
            or inspection.get('current_remote_bytes_equivalence_verified') is not False \
            or inspection.get('strict_screenshot_cut_coverage_granted') is not False:
        raise ValueError('hongguo_historical_source_scope_required')
    requests = [inspection.get('detail_request') or {}, inspection.get('player_request') or {}]
    urls = ['https://hongguoduanju.com/detail?series_id=' + reference['series_id'], receipt['source_page']]
    if inspection.get('network_get_attempts') != 2 or inspection.get('network_gets') != 2 \
            or inspection.get('media_downloaded') is not False or inspection.get('network_posts') != 0:
        raise ValueError('hongguo_bounded_metadata_inspection_required')
    for request, url in zip(requests, urls):
        if request.get('status') != 200 or request.get('url_host') != 'hongguoduanju.com' \
                or request.get('url_sha256') != hashlib.sha256(url.encode()).hexdigest() \
                or not re.fullmatch(r'[a-f0-9]{64}', request.get('body_sha256', '')) \
                or any(request.get(key) is not False for key in ['cookies_sent', 'authorization_sent', 'login_used',
                    'session_reused', 'proxy_environment_used', 'redirect_followed']):
            raise ValueError('hongguo_anonymous_request_evidence_required')
    return {'status': 'verified_public_hongguo_episode_source', 'source_sha256': spec['source']['sha256'],
        'series_id': reference['series_id'], 'source_episode_id': vid, 'episode_number': reference['episode_number'],
        'receipt_sha256': spec['public_source_provenance']['sha256'],
        'full_decode_provenance_sha256': spec['full_decode_provenance']['sha256'],
        'inspection_sha256': spec['public_source_inspection']['sha256'],
        'source_admission_scope': inspection['source_admission_scope'],
        'current_remote_bytes_equivalence_verified': False, 'strict_screenshot_cut_coverage_granted': False,
        'network_posts': 0, 'music_identity_verified': False, 'qualification_granted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Native Hongguo public metadata source inspection; no audio submission.')
    parser.add_argument('--hongguo-input', required=True)
    parser.add_argument('--out', required=True)
    arguments = parser.parse_args()
    artifact, report = inspect_hongguo_public_source(arguments.hongguo_input, arguments.out)
    print(json.dumps({'artifact': artifact, 'status': report['status'], 'gap': report.get('gap'),
        'native_reference': report.get('native_reference'), 'network_gets': report['network_gets'],
        'network_posts': 0, 'media_downloaded': False, 'qualification_granted': False}, ensure_ascii=True))
