"""Acquire an exact public Apple recording preview from a bound fingerprint lead.

No HTTP at import. A preview is independent audio, never verified drama use,
cleanliness, a whole recording, or a Ready package. Caller owns job deduplication.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def bind(file):
    return {'path': str(Path(file).resolve()), 'sha256': digest(file)}


def read(file):
    return json.loads(Path(file).read_text('utf-8-sig'))


def checked(reference):
    if not isinstance(reference, dict) or not isinstance(reference.get('path'), str) \
            or not re.fullmatch(r'[a-f0-9]{64}', reference.get('sha256', '')):
        raise ValueError('bound_candidate_evidence_required')
    if digest(reference['path']) != reference['sha256']:
        raise ValueError('bound_candidate_evidence_changed')
    return read(reference['path'])


def same_file(a, b):
    return a.get('sha256') == b.get('sha256') and Path(a['path']).resolve() == Path(b['path']).resolve()


def normalized(value):
    return re.sub(r'\s+', ' ', str(value).strip().casefold())


def isrc(value):
    return re.sub(r'[^A-Z0-9]', '', str(value).upper())


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_get(url, limit):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in {'itunes.apple.com', 'audio-ssl.itunes.apple.com'} \
            or parts.username or parts.password or parts.port or parts.fragment:
        raise ValueError('supported_anonymous_official_apple_url_required')
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0'}, method='GET')
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=25) as response:
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('official_response_size_limit')
        length = response.headers.get('Content-Length')
        if length is not None and int(length) != len(raw):
            raise ValueError('official_response_content_length_mismatch')
        return raw, {'host': parts.hostname, 'url_sha256': hashlib.sha256(url.encode()).hexdigest(),
            'response_status': response.status, 'body_sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
            'cookies_sent': False, 'authorization_sent': False, 'login_used': False, 'paid_request': False,
            'proxy_environment_used': False, 'redirect_followed': False}


def decode_audio(file):
    commands = [
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels:format=duration', '-of', 'json', str(file)],
        ['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(file), '-map', '0:a:0', '-vn', '-sn', '-dn', '-f', 'null', '-'],
    ]
    receipts = []
    probe = None
    for index, command in enumerate(commands):
        process = subprocess.run(command, capture_output=True, check=False, timeout=120)
        receipts.append({'argv': command, 'exit_code': process.returncode,
            'binary': bind(shutil.which(command[0])),
            'stdout_sha256': hashlib.sha256(process.stdout).hexdigest(),
            'stderr_sha256': hashlib.sha256(process.stderr).hexdigest(), 'actual_subprocess_executed': True})
        if process.returncode:
            raise ValueError('independent_candidate_audio_decode_failed')
        if index == 0:
            probe = json.loads(process.stdout)
    if not any(stream.get('codec_type') == 'audio' for stream in probe.get('streams', [])) \
            or float(probe.get('format', {}).get('duration', 0)) <= 0:
        raise ValueError('independent_candidate_audio_extent_missing')
    return {'probe': probe, 'full_file_decode_success': True, 'decode_executions': receipts}


def prepare(spec_file):
    specification = bind(spec_file); spec = checked(specification)
    if spec.get('schema_version') != 1:
        raise ValueError('candidate_acquisition_schema_required')
    metadata = checked(spec['candidate_metadata']); recognition = checked(spec['recognition_receipt'])
    if recognition.get('status') != 'candidate_unverified' or recognition.get('http_status') != 200 \
            or recognition.get('http_requests') != 1 \
            or not same_file(recognition.get('candidate_evidence', {}), spec['candidate_metadata']):
        raise ValueError('actual_named_recognition_candidate_required')
    actual_input = checked(recognition['input']); response = checked(recognition['response'])
    raw = checked(response['raw_response']); candidate = metadata.get('candidate') or {}
    track = raw.get('track') or {}
    if metadata.get('input_sha256') != recognition['input']['sha256'] \
            or metadata.get('raw_response_sha256') != response['raw_response']['sha256'] \
            or response.get('input_sha256') != recognition['input']['sha256'] \
            or normalized(candidate.get('title')) != normalized(track.get('title')) \
            or normalized(candidate.get('subtitle')) != normalized(track.get('subtitle')) \
            or str(candidate.get('key')) != str(track.get('key')):
        raise ValueError('recognition_candidate_causal_binding_mismatch')
    if not candidate.get('title') or not candidate.get('subtitle') \
            or not re.fullmatch(r'[A-Z]{2}[A-Z0-9]{3}[0-9]{7}', isrc(candidate.get('isrc', ''))) \
            or isrc(candidate['isrc']) != isrc(track.get('isrc', '')):
        raise ValueError('named_candidate_title_artist_isrc_required')
    provenance = actual_input.get('public_source_provenance')
    if actual_input.get('source_kind') not in {'public_research_video', 'official_public_recording'} \
            or actual_input.get('source_media_uploaded') is not False:
        raise ValueError('bound_public_recognition_source_required')
    checked(provenance)
    source = actual_input.get('source') or {}
    if not source.get('path') or digest(source['path']) != source.get('sha256'):
        raise ValueError('actual_reference_source_changed')
    if actual_input.get('input_audio') and digest(actual_input['input_audio']['path']) != actual_input['input_audio']['sha256']:
        raise ValueError('actual_fingerprint_input_audio_changed')
    case_ids = []
    if spec.get('source_case'):
        case = checked(spec['source_case']); episode = case.get('episode') or {}; work = case.get('work') or {}
        if episode.get('source_video', {}).get('sha256') != source['sha256'] \
                or work.get('work_id') != actual_input.get('public_reference', {}).get('work_id') \
                or episode.get('work_id') != work.get('work_id'):
            raise ValueError('actual_source_case_binding_mismatch')
        if case.get('case', {}).get('case_id'):
            case_ids = [case['case']['case_id']]
        elif case.get('case_id'):
            case_ids = [case['case_id']]
    ids = {str(action['id']) for action in track.get('hub', {}).get('actions', [])
           if action.get('name') == 'apple' and str(action.get('id', '')).isdecimal()}
    if len(ids) > 1:
        raise ValueError('ambiguous_official_apple_recording_ids')
    return {'spec': spec, 'specification': specification, 'candidate': candidate, 'actual_input': actual_input,
        'raw_response': response['raw_response'], 'apple_track_id': next(iter(ids), None), 'case_ids': case_ids}


def matches_entry(entry, prepared):
    candidate = prepared['candidate']
    if normalized(entry.get('trackName')) != normalized(candidate['title']) \
            or normalized(entry.get('artistName')) != normalized(candidate['subtitle']):
        return False
    if prepared['apple_track_id'] and str(entry.get('trackId')) != prepared['apple_track_id']:
        return False
    official_isrc = entry.get('isrc') or entry.get('ISRC')
    return not official_isrc or isrc(official_isrc) == isrc(candidate['isrc'])


def reuse_acquisition(reuse, prepared, decoder):
    artifact = reuse.get('artifact') or reuse.get('acquisition')
    acquisition = checked(artifact); requested = reuse.get('source')
    if not requested or digest(requested['path']) != requested.get('sha256'):
        raise ValueError('reused_independent_source_changed')
    old_candidate_binding = acquisition.get('recognition_candidate') or acquisition.get('candidate_metadata')
    old_candidate = checked(old_candidate_binding).get('candidate') or {}
    candidate = prepared['candidate']
    if normalized(old_candidate.get('title')) != normalized(candidate['title']) \
            or normalized(old_candidate.get('subtitle')) != normalized(candidate['subtitle']) \
            or isrc(old_candidate.get('isrc')) != isrc(candidate['isrc']):
        raise ValueError('reused_recording_title_artist_isrc_mismatch')
    recordings = [row for row in acquisition.get('actual_recordings', [])
                  if row.get('source', {}).get('sha256') == requested['sha256']]
    if len(recordings) != 1 or not matches_entry(recordings[0].get('official_entry') or {}, prepared):
        raise ValueError('reused_official_recording_provenance_mismatch')
    recording = recordings[0]
    if recording.get('scope') != 'official_public_preview_only' \
            or recording.get('preview_url_host') != 'audio-ssl.itunes.apple.com':
        raise ValueError('reused_public_preview_provenance_required')
    decode = decoder(requested['path'])
    if digest(requested['path']) != requested['sha256']:
        raise ValueError('reused_independent_source_changed')
    return {**recording, **decode, 'source': requested, 'reused_existing_acquisition': artifact,
        'mirror_original_binding': recording['source'],
        'byte_identical_stored_mirror': not same_file(recording['source'], requested),
        'cleanliness_listened': False, 'source_match_verified': False, 'full_track_start_seconds': None}


def acquire(spec_file, output_directory, *, reuse_override=None, fetch=public_get, decoder=decode_audio):
    prepared = prepare(spec_file); spec = prepared['spec']; candidate = prepared['candidate']
    out = Path(output_directory).resolve(); out.mkdir(parents=True, exist_ok=False)
    result = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
        'producer': bind(__file__), 'checked_candidate': True,
        'input_specification': prepared['specification'], 'recognition_candidate': spec['candidate_metadata'],
        'recognition_receipt': spec['recognition_receipt'], 'public_reference_source': prepared['actual_input']['source'],
        'public_source_provenance': prepared['actual_input']['public_source_provenance'],
        'source_episode_id': prepared['actual_input'].get('source_episode_id') or prepared['actual_input'].get('public_reference', {}).get('episode_id'),
        'reference_window_seconds': prepared['actual_input'].get('window_seconds'),
        'source_case': spec.get('source_case'), 'case_ids': prepared['case_ids'],
        'case_linkage_pending': not bool(prepared['case_ids']),
        'title': candidate['title'], 'artist': candidate['subtitle'], 'candidate_isrc': isrc(candidate['isrc']),
        'shazam_key': str(candidate['key']), 'apple_track_id': prepared['apple_track_id'],
        'requests': [], 'actual_recordings': [], 'candidate_unverified': True,
        'status': 'official_candidate_acquisition_gap', 'source_match_verified': False,
        'source_cleanliness': 'unassessed', 'actual_audio_listened': False, 'lyrics_verified': False,
        'music_pack_created': False, 'ready_packages': 0, 'production_approval': False,
        'full_recording_available': False, 'full_recording_unavailable': True,
        'full_recording_status': 'unavailable_in_anonymous_apple_preview_route',
        'official_catalogue_isrc_verified': False, 'paid_calls': 0, 'models_called': 0, 'private_uploads': 0,
        'new_media_transfers': 0, 'old_artifacts_modified': False,
        'execution_kind': 'actual_public_acquisition' if fetch is public_get and decoder is decode_audio else 'injected_offline_test'}
    try:
        reuse = reuse_override or spec.get('reuse_existing_acquisition')
        if reuse:
            result['actual_recordings'] = [reuse_acquisition(reuse, prepared, decoder)]
            result['status'] = 'existing_official_preview_revalidated_unverified'
            result['reused_without_http'] = True
        else:
            query = {'id': prepared['apple_track_id'], 'entity': 'song', 'country': 'US'} if prepared['apple_track_id'] else {
                'term': candidate['subtitle'] + ' ' + candidate['title'], 'entity': 'song', 'media': 'music', 'country': 'US', 'limit': 50}
            endpoint = 'https://itunes.apple.com/' + ('lookup?' if prepared['apple_track_id'] else 'search?') + urlencode(query)
            raw, request = fetch(endpoint, 2 * 1024 * 1024)
            result['requests'].append({'purpose': 'official_music_catalog_lookup', **request})
            document = json.loads(raw); metadata_file = out / 'official-catalog-response.json'
            metadata_file.write_bytes(raw); result['official_metadata'] = bind(metadata_file)
            rows = document.get('results', []); matches = [row for row in rows if matches_entry(row, prepared)]
            result['exact_match_count'] = len(matches)
            if len(matches) != 1:
                result['status'] = 'exact_title_version_artist_isrc_catalogue_gap'
            else:
                entry = matches[0]; preview = entry.get('previewUrl')
                if not preview or urlsplit(preview).hostname != 'audio-ssl.itunes.apple.com':
                    result['status'] = 'exact_catalogue_entry_without_supported_public_preview'
                else:
                    audio, request = fetch(preview, 8 * 1024 * 1024)
                    result['requests'].append({'purpose': 'official_public_audio_preview', **request})
                    file = out / ('apple-' + str(entry['trackId']) + '-official-preview.m4a')
                    with file.open('xb') as stream:
                        stream.write(audio)
                    result['new_media_transfers'] = 1
                    source = bind(file); decoded = decoder(file)
                    if digest(file) != source['sha256']:
                        raise ValueError('independent_source_changed_during_decode')
                    official_isrc = entry.get('isrc') or entry.get('ISRC')
                    result['official_catalogue_isrc_verified'] = bool(official_isrc)
                    result['actual_recordings'] = [{**decoded, 'source': source, 'official_entry': {
                        key: entry.get(key) for key in ['trackId', 'trackName', 'artistName', 'collectionId', 'collectionName',
                        'trackViewUrl', 'releaseDate', 'trackTimeMillis', 'primaryGenreName', 'isrc', 'ISRC']},
                        'preview_url_host': urlsplit(preview).hostname,
                        'preview_url_sha256': hashlib.sha256(preview.encode()).hexdigest(),
                        'scope': 'official_public_preview_only', 'full_track_start_seconds': None,
                        'source_match_verified': False, 'cleanliness_listened': False}]
                    result['status'] = 'official_preview_acquired_unverified'
        for recording in result['actual_recordings']:
            duration = float(recording['probe']['format']['duration'])
            recording['available_source_range_seconds'] = [0, duration]
            recording['full_recording_available'] = False
        if result['actual_recordings'] and not result['official_catalogue_isrc_verified']:
            result['pending'] = ['official_catalogue_isrc_absent_or_not_independently_verified',
                'strict_reference_to_recording_identity', 'full_original_recording_acquisition', 'actual_cleanliness_and_phrase_review']
        checked(prepared['specification']); checked(spec['candidate_metadata']); checked(spec['recognition_receipt'])
        checked(prepared['actual_input']['public_source_provenance'])
        if digest(prepared['actual_input']['source']['path']) != prepared['actual_input']['source']['sha256']:
            raise ValueError('actual_reference_source_changed')
    except Exception as error:
        result['status'] = 'official_candidate_acquisition_gap'; result['error_type'] = type(error).__name__
        if isinstance(error, ValueError) and re.fullmatch(r'[a-z0-9_]+', str(error)):
            result['gap'] = str(error)
        if hasattr(error, 'code') and isinstance(error.code, int):
            result['http_status'] = error.code
        result['actual_recordings'] = []
    result['acquired_independent_recording'] = bool(result['actual_recordings'])
    result['independent_recording_scope'] = 'preview_only' if result['actual_recordings'] else 'not_acquired'
    artifact = out / 'official-acquisition-result.json'
    with artifact.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
    return bind(artifact), result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--reuse-existing-acquisition', type=Path, help='JSON with bound artifact and source; revalidate without HTTP or copying.')
    args = parser.parse_args()
    reuse = read(args.reuse_existing_acquisition) if args.reuse_existing_acquisition else None
    artifact, result = acquire(args.input, args.out, reuse_override=reuse)
    print(json.dumps({'artifact': artifact, 'status': result['status'], 'actual_recordings': len(result['actual_recordings']),
        'new_media_transfers': result['new_media_transfers'], 'http_requests': len(result['requests']),
        'case_linkage_pending': result['case_linkage_pending'], 'full_recording_available': False,
        'ready_packages': 0, 'production_approval': False}, ensure_ascii=True))


if __name__ == '__main__':
    main()
