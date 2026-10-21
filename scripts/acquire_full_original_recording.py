"""Acquire/reuse one complete normal official recording, never approve its use.

CLI: python -B acquire_full_original_recording.py --input INPUT.json --out LOCAL_JOB
Reconcile unknown output without network: add --reconcile-only.
No HTTP or subprocess at import. Apple previews and their running consumer are
separate. A full-entry file is not a clean master, matched drama recording, or Ready.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid
from urllib.parse import parse_qs, urlsplit


RESULT = 'full-recording-acquisition-result.json'
STATE = 'full-recording-state.json'
MEDIA_EXTENSIONS = {'.webm', '.m4a', '.opus', '.mp3', '.mp4', '.mkv', '.flac', '.wav', '.ogg'}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def bind(path):
    return {'path': str(Path(path).resolve()), 'sha256': digest(path)}


def read(path):
    return json.loads(Path(path).read_text('utf-8-sig'))


def checked(binding):
    if not isinstance(binding, dict) or not isinstance(binding.get('path'), str) or not re.fullmatch(r'[a-f0-9]{64}', binding.get('sha256', '')):
        raise ValueError('actual_file_binding_required')
    if digest(binding['path']) != binding['sha256']:
        raise ValueError('bound_full_recording_input_changed')
    return read(binding['path'])


def write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return bind(path)


def save_state(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def normal_youtube_page(url):
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    if (parts.scheme != 'https' or parts.hostname != 'www.youtube.com' or parts.path != '/watch'
            or parts.username or parts.password or parts.port or parts.fragment or set(query) != {'v'}
            or len(query['v']) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{11}', query['v'][0])):
        raise ValueError('normal_official_youtube_single_recording_page_required')
    return query['v'][0]


def validate_metadata(metadata, request, page):
    video_id = normal_youtube_page(page)
    expected = request['expected']
    if (metadata.get('id') != video_id or metadata.get('webpage_url') != page
            or metadata.get('channel_id') != expected['channel_id']
            or metadata.get('title') != expected['title']
            or expected.get('release_date') and metadata.get('release_date') != expected['release_date']):
        raise ValueError('official_entry_version_or_channel_mismatch')
    if expected.get('metadata_artist_credit') and metadata.get('artist') != expected['metadata_artist_credit']:
        raise ValueError('official_metadata_artist_credit_mismatch')
    if (metadata.get('availability') != 'public' or metadata.get('is_live') is True
            or metadata.get('was_live') is True or metadata.get('live_status') not in (None, 'not_live')
            or metadata.get('has_drm') is True or any(row.get('has_drm') is True for row in metadata.get('formats', []))):
        raise ValueError('normal_public_nonlive_nonDRM_recording_required')
    duration = metadata.get('duration')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 1 <= duration <= 7200:
        raise ValueError('bounded_complete_official_entry_duration_required')
    if (metadata.get('section_start') is not None or metadata.get('section_end') is not None
            or re.search(r'\b(preview|teaser|trailer|snippet)\b|预览|預覽|预告|預告', metadata['title'], re.I)):
        raise ValueError('preview_or_excerpt_is_not_full_recording')
    if expected.get('recording_version') and expected['recording_version'] not in metadata['title']:
        raise ValueError('requested_recording_version_not_in_official_entry')
    return float(duration)


def verified_official_artist_entry(metadata, source, verification, spec):
    """Verify public release provenance; this grants neither rights nor original identity."""
    basis = verification.get('basis', {})
    media_type = basis.get('media_type')
    markers = {'official_audio':r'\bofficial\s+audio\b',
               'official_music_video':r'\bofficial\s+music\s+video\b',
               'official_visualizer':r'\bofficial\s+visualizer\b'}
    description = metadata.get('description', '')
    if (verification.get('normal_public_access') is not True or verification.get('official_artist_label_source') is not True
            or verification.get('normal_page_url') != source['page_url'] or verification.get('metadata') != source['metadata']
            or verification.get('channel_id') != metadata['channel_id'] or metadata.get('channel_is_verified') is not True
            or basis.get('kind') != 'actual_verified_channel_explicit_release_and_independent_primary_site'
            or media_type not in markers or not re.search(markers[media_type], metadata['title'], re.I)
            or re.search(r'\b(vlog|advertisement|commercial|live|shorts?)\b|廣告|广告',metadata['title'],re.I)
            or metadata['duration'] < 60
            or basis.get('metadata_description_sha256') != hashlib.sha256(description.encode()).hexdigest()
            or not basis.get('release_statement') or basis['release_statement'] not in description
            or not basis.get('performer_credit') or basis['performer_credit'] not in metadata['title']+description):
        raise ValueError('actual_verified_official_entry_release_metadata_required')
    if media_type == 'official_audio' and (not basis.get('vocal_credit') or basis['vocal_credit'] not in description
                                          or not basis.get('production_credit') or basis['production_credit'] not in description):
        raise ValueError('official_audio_actual_vocal_and_production_credit_required')
    primary = verification.get('primary_page', {})
    primary_receipt = checked(primary.get('http_execution'))
    channel = verification.get('linked_channel_page', {})
    channel_receipt = checked(channel.get('http_execution'))
    for page,receipt in ((primary,primary_receipt),(channel,channel_receipt)):
        body = page.get('response_body', {})
        if (urlsplit(page.get('url','')).scheme != 'https' or receipt.get('operation') != 'actual_normal_public_artist_metadata_http'
                or receipt.get('requested_url') != page['url'] or receipt.get('status_code') != 200
                or receipt.get('actual_http_request_executed') is not True or receipt.get('audio_downloads') != 0
                or receipt.get('response_body') != body or not body.get('path') or digest(body['path']) != body.get('sha256')):
            raise ValueError('actual_bound_official_primary_and_channel_http_required')
    primary_body = Path(primary['response_body']['path']).read_text('utf-8-sig')
    channel_body = Path(channel['response_body']['path']).read_text('utf-8-sig')
    channel_url = urlsplit(channel['url'])
    # Some artist sites still use YouTube's historical bare vanity URL. It is
    # accepted only with the same independently fetched canonical channel ID
    # check below; a slug alone is never official-source evidence.
    legacy_vanity = (re.fullmatch(r'/[A-Za-z0-9_.-]{1,100}', channel_url.path)
                     and channel_url.path.casefold() not in
                     ('/watch','/playlist','/shorts','/feed','/results','/embed','/about'))
    if (primary.get('site_role') != 'official_artist_or_label_site' or not primary.get('artist_or_label')
            or channel_url.hostname not in ('youtube.com','www.youtube.com')
            or not (re.fullmatch(r'/(?:channel/UC[A-Za-z0-9_-]{22}|c/[^/?]+|user/[^/?]+|@[^/?]+)',channel_url.path) or legacy_vanity)
            or channel_url.query or channel_url.fragment or channel['url'] not in primary_body
            or not re.search(r'<meta\s+property=["\']og:url["\']\s+content=["\']https://www\.youtube\.com/channel/'+re.escape(metadata['channel_id'])+r'["\']',channel_body)):
        raise ValueError('official_primary_site_channel_id_relation_not_verified')
    # The complete normal MV/visualizer can be collected without claiming its album version.
    if (media_type != 'official_audio' or verification.get('duration_comparison',{}).get('same_requested_release_version') is False):
        if spec.get('research_context',{}).get('candidate_version_relation') != 'different_or_unverified_catalogue_variant':
            raise ValueError('official_non_audio_or_distinct_version_must_keep_catalogue_gap')


def validated_page_refetch_runtime(spec, metadata, task_key):
    """One explicit normal-page retry, bound to an actual prior failed job.

    This is a transfer diagnosis, not proof that JavaScript caused the failure.
    Existing Node/EJS is enabled without cookies, remote components or new tools.
    """
    repair = spec['targeted_repair']
    previous = checked(repair.get('previous_failure'))
    original = checked(previous['input'])
    original_metadata = checked(original['official_source']['metadata'])
    download = previous.get('download_execution', {})
    stderr = download.get('stderr') or {}
    if not stderr.get('path') or digest(stderr['path']) != stderr.get('sha256'):
        raise ValueError('actual_bound_failed_download_diagnostic_required')
    diagnostic = Path(stderr['path']).read_text('utf-8-sig')
    if (previous.get('task_key') != task_key or previous.get('status') != 'failed_full_acquisition'
            or previous.get('attempts_total') != 1 or download.get('exit_code') in (None, 0)
            or not re.search(r'403|JavaScript|\bJS runtime\b|n challenge', diagnostic, re.I)
            or not repair.get('reason', '').strip() or spec.get('reuse_existing')
            or original['expected'] != spec['expected']
            or original['official_source']['page_url'] != spec['official_source']['page_url']
            or any(original_metadata.get(key) != metadata.get(key) for key in
                   ('id','title','channel_id','artist','album','duration','release_date'))
            or original.get('research_context', {}).get('candidate_version_relation') !=
               spec.get('research_context', {}).get('candidate_version_relation')):
        raise ValueError('one_same_official_recording_page_refetch_repair_required')
    argv = download.get('argv', [])
    if ('--load-info-json' not in argv or '--js-runtimes' in argv
            or any(flag in argv for flag in ('--cookies','--cookies-from-browser','--username','--password','--remote-components'))):
        raise ValueError('prior_bound_metadata_download_without_explicit_runtime_required')
    runtime = repair.get('existing_js_runtime') or {}
    version = runtime.get('version', '')
    if (not runtime.get('path') or not re.fullmatch(r'[a-f0-9]{64}', runtime.get('sha256', ''))
            or digest(runtime['path']) != runtime['sha256'] or not re.fullmatch(r'v\d+\.\d+\.\d+', version)
            or int(version[1:].split('.')[0]) < 22):
        raise ValueError('bound_existing_node22_or_newer_required')
    execution = checked(spec['official_source'].get('metadata_execution'))
    if (execution.get('operation') != 'actual_public_ytdlp_metadata_only'
            or execution.get('status') != 'metadata_obtained' or execution.get('exit_code') != 0
            or execution.get('metadata') != spec['official_source']['metadata']
            or execution.get('normal_page_url') != spec['official_source']['page_url']
            or execution.get('javascript_runtime') != runtime):
        raise ValueError('existing_runtime_must_match_actual_official_metadata_execution')
    return runtime


def prepare(input_path):
    spec_binding = bind(input_path)
    spec = checked(spec_binding)
    if spec.get('schema_version') != 1 or spec.get('requested_extent') != 'full_recording':
        raise ValueError('explicit_full_recording_request_required')
    queue = checked(spec['first10_queue'])
    stats = queue['statistics']
    if tuple(stats.get(key) for key in ('screenshot_works', 'first10_full_episode_targets', 'screenshot_display_episode_positions')) != (115, 1145, 8926):
        raise ValueError('bound115_first10_1145_fullrange8926_scope_required')
    targets = queue.get('targets', [])
    work_counts = {row['work_id']:row['screenshot_episode_count'] for row in targets}
    if (len(targets)!=1145 or len(work_counts)!=115 or sum(work_counts.values())!=8926
            or any({row['episode_number'] for row in targets if row['work_id']==wid} != set(range(1,min(10,count)+1)) for wid,count in work_counts.items())):
        raise ValueError('actual_first10_scope_rows_mismatch')
    policy = checked(spec['project_policy'])
    if policy.get('new_trial_hold', {}).get('offline_research_allowed') is not True:
        raise ValueError('public_original_preproduction_research_not_allowed')
    source = spec.get('official_source', {})
    if source.get('provider') != 'youtube' or not source.get('metadata') or not source.get('verification'):
        raise ValueError('verified_normal_official_full_source_required')
    metadata = checked(source['metadata'])
    duration = validate_metadata(metadata, spec, source['page_url'])
    verification = checked(source['verification'])
    if verification.get('status') == 'acquisition_attempt_passed':
        if (verification.get('source_url') != source['page_url'] or verification.get('exit_code') != 0
                or not verification.get('official_public_basis') or verification.get('paid_calls') != 0):
            raise ValueError('prior_actual_official_acquisition_provenance_required')
    elif verification.get('schema') == 'normal_official_artist_label_source_verification_v1':
        description = metadata.get('description', '')
        basis = verification.get('basis', {})
        if (verification.get('normal_public_access') is not True or verification.get('official_artist_label_source') is not True
                or verification.get('page_url') != source['page_url'] or verification.get('metadata') != source['metadata']
                or verification.get('channel_id') != metadata['channel_id'] or not verification.get('observed_at')
                or basis.get('kind') != 'provider_generated_music_release' or not basis.get('provided_by')
                or 'Provided to YouTube by ' + basis['provided_by'] not in description
                or 'Auto-generated by YouTube.' not in description):
            raise ValueError('actual_official_release_metadata_verification_required')
    elif verification.get('schema') == 'normal_official_artist_label_channel_verification_v1':
        primary = verification.get('primary_page', {})
        body = primary.get('response_body') or {}
        video_id = metadata['id']
        if (verification.get('normal_public_access') is not True or verification.get('official_artist_label_source') is not True
                or verification.get('page_url')!=source['page_url'] or verification.get('metadata')!=source['metadata']
                or verification.get('channel_id')!=metadata['channel_id'] or not verification.get('observed_at')
                or primary.get('site_role')!='official_artist_or_label_site'
                or urlsplit(primary.get('url','')).scheme!='https' or not primary.get('artist_or_label')
                or not body.get('path') or digest(body['path'])!=body.get('sha256')):
            raise ValueError('independent_official_artist_label_page_evidence_required')
        primary_text = Path(body['path']).read_text('utf-8-sig')
        if not any(link in primary_text for link in ('youtube.com/watch?v='+video_id,'youtu.be/'+video_id,'youtube.com/embed/'+video_id)):
            raise ValueError('official_primary_page_does_not_link_this_recording_entry')
    elif verification.get('schema') == 'normal_verified_artist_channel_release_evidence_v1':
        basis=verification.get('basis',{});description=metadata.get('description','')
        if (verification.get('normal_public_access') is not True or verification.get('official_artist_label_source') is not True
                or verification.get('normal_page_url')!=source['page_url'] or verification.get('metadata')!=source['metadata']
                or verification.get('channel_id')!=metadata['channel_id'] or metadata.get('channel_is_verified') is not True
                or basis.get('kind')!='actual_verified_artist_channel_explicit_release_metadata'
                or basis.get('metadata_description_sha256')!=hashlib.sha256(description.encode()).hexdigest()
                or not basis.get('release_statement') or basis['release_statement'] not in description
                or not basis.get('rights_notice') or basis['rights_notice'] not in description
                or not basis.get('producer_credit') or basis['producer_credit'].casefold()!=metadata.get('channel','').casefold()):
            raise ValueError('actual_verified_artist_channel_and_explicit_release_credits_required')
        if (verification.get('duration_comparison',{}).get('same_requested_release_version') is False
                and spec.get('research_context',{}).get('candidate_version_relation')!='different_or_unverified_catalogue_variant'):
            raise ValueError('official_mv_variant_must_not_close_original_catalogue_version')
    elif verification.get('schema') == 'normal_verified_artist_official_entry_release_v1':
        verified_official_artist_entry(metadata, source, verification, spec)
    else:
        raise ValueError('full_url_is_only_a_lead_without_official_verification')
    tool = spec['yt_dlp']
    if digest(tool['path']) != tool['sha256']:
        raise ValueError('bound_existing_ytdlp_changed')
    proxy = ''
    if spec.get('network_route'):
        route = checked(spec['network_route']);parts=urlsplit(route.get('uri',''))
        if (route.get('schema')!='existing_os_anonymous_loopback_network_route_v1' or route.get('credentials_present') is not False
                or route.get('new_proxy_service_started') is not False or parts.scheme!='http'
                or parts.hostname not in ('127.0.0.1','localhost','::1') or not parts.port
                or parts.username or parts.password or parts.path not in ('','/') or parts.query or parts.fragment):
            raise ValueError('bound_existing_anonymous_loopback_route_required')
        proxy = route['uri']
    if source.get('download_from_bound_fresh_metadata'):
        execution = checked(source['metadata_execution'])
        age = (datetime.now(timezone.utc)-datetime.fromisoformat(execution['created_at_utc'])).total_seconds()
        if (execution.get('operation')!='actual_public_ytdlp_metadata_only' or execution.get('status')!='metadata_obtained'
                or execution.get('exit_code')!=0 or execution.get('metadata')!=source['metadata']
                or execution.get('normal_page_url')!=source['page_url'] or execution.get('tool')!=tool
                or not 0<=age<=3600 or execution.get('audio_downloads')!=0):
            raise ValueError('actual_recent_normal_official_metadata_execution_required')
        if any(str(key).lower() in ('cookie','authorization') for key in metadata.get('http_headers',{})) or metadata.get('cookies'):
            raise ValueError('session_credentials_in_metadata_not_allowed')
    identity = {'requested_extent': 'full_recording', 'provider': 'youtube', 'page_id': metadata['id'],
                'title': metadata['title'], 'channel_id': metadata['channel_id'],
                'recording_version': spec['expected'].get('recording_version'), 'isrc_candidate': spec['expected'].get('isrc')}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    repair=spec.get('targeted_repair')
    attempts=1
    repair_runtime=None
    if repair and repair.get('changed_approach')=='refetch_official_page_with_existing_js_runtime':
        repair_runtime=validated_page_refetch_runtime(spec,metadata,key)
        attempts=2
    if repair and repair.get('changed_approach')=='verified_local_staging_then_append_only_publication':
        previous=checked(repair['previous_failure']);checked(previous['input'])
        stderr_binding=previous.get('download_execution',{}).get('stderr') or {}
        if not stderr_binding.get('path') or digest(stderr_binding['path'])!=stderr_binding.get('sha256'):
            raise ValueError('actual_storage_write_failure_receipt_required')
        stderr=Path(stderr_binding['path']).read_text('utf-8-sig')
        if (previous.get('task_key')!=key or previous.get('attempts_total')!=1
                or previous.get('status')!='failed_full_acquisition' or not repair.get('reason','').strip()
                or 'Cannot write video metadata to JSON file' not in stderr or 'S:' not in stderr):
            raise ValueError('one_diagnosed_shared_storage_publication_repair_required')
        key=hashlib.sha256(json.dumps({'base_task_key':key,'repair':'local_staging_append_publication_v1',
                                     'previous_failure_sha256':repair['previous_failure']['sha256']},sort_keys=True).encode()).hexdigest()
        attempts=2
    if spec.get('task_key') and spec['task_key'] != key:
        raise ValueError('full_recording_task_key_mismatch')
    return {'spec': spec, 'input': spec_binding, 'metadata': metadata, 'duration': duration, 'task_key': key, 'proxy':proxy,'attempts':attempts,
            'page_refetch_runtime':repair_runtime,
            'verified_release_media_type':verification.get('basis',{}).get('media_type'),
            'scope': {'screenshot_works':115,'first10_targets':1145,'screenshot_episode_positions':8926,
                      'later_fullrange_preserved':True,'heldout_isolated':True,'project_trial_hold_status':policy['new_trial_hold']['status']}}


def decode_full_audio(path, runner=subprocess.run):
    executions = []
    commands = [
        ['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name,sample_rate,channels,start_time,duration:format=duration','-of','json',str(path)],
        ['ffmpeg','-nostdin','-v','error','-xerror','-i',str(path),'-map','0:a:0','-vn','-sn','-dn','-af','asetpts=PTS-STARTPTS',
         '-ac','1','-ar','16000','-c:a','pcm_s16le','-f','s16le','pipe:1'],
    ]
    probe = None
    for number, command in enumerate(commands):
        binary = shutil.which(command[0])
        if not binary:
            raise ValueError('existing_ffmpeg_or_ffprobe_unavailable')
        process = runner(command, capture_output=True, timeout=300)
        executions.append({'argv':command,'binary':bind(binary),'exit_code':process.returncode,
                           'stdout_sha256':hashlib.sha256(process.stdout).hexdigest(),'stderr_sha256':hashlib.sha256(process.stderr).hexdigest(),
                           'actual_subprocess_executed':True})
        if process.returncode:
            raise ValueError('actual_full_recording_decode_failed')
        if number == 0:
            probe = json.loads(process.stdout)
            if not any(stream.get('codec_type') == 'audio' for stream in probe.get('streams', [])):
                raise ValueError('official_file_has_no_audio')
        else:
            if not process.stdout or len(process.stdout) % 2:
                raise ValueError('full_decoded_pcm_sample_extent_missing')
            samples = len(process.stdout)//2
            pcm_sha = hashlib.sha256(process.stdout).hexdigest()
    return {'full_file_decode_success':True,'probe':probe,'decode_executions':executions,
            'decoded_pcm':{'protocol':'actual_ffmpeg_complete_file_pcm16le_16000_mono','sample_count':samples,'sample_rate':16000,
                           'sha256':pcm_sha,'duration_seconds':samples/16000,'clock':'decoded_audio_zero_start_samples'},
            'duration_seconds':samples/16000,'container_duration_seconds':float(probe['format']['duration'])}


def verify_complete_file(prepared, source, decoder, metadata=None):
    if digest(source['path']) != source['sha256']:
        raise ValueError('independent_full_recording_source_changed')
    decoded = decoder(Path(source['path']))
    duration = decoded['duration_seconds']
    expected_duration = validate_metadata(metadata or prepared['metadata'], prepared['spec'], prepared['spec']['official_source']['page_url'])
    if (not decoded.get('full_file_decode_success') or not math.isfinite(duration) or duration <= 0
            or abs(duration-expected_duration) > max(1.5, expected_duration*.01)):
        raise ValueError('decoded_file_is_partial_or_preview_not_complete_official_entry')
    if digest(source['path']) != source['sha256']:
        raise ValueError('full_recording_changed_during_decode')
    return {'source':source,'scope':'complete_official_public_recording','requested_extent':'full_recording',
            'available_source_range_seconds':[0,duration],'full_entry_extent_verified':True,
            'official_source':prepared['spec']['official_source'],'artist_credit_scope':'official metadata credits only, not a performer conclusion',
            'media_type':prepared.get('verified_release_media_type'),
            'catalogue_version_relation':prepared['spec'].get('research_context',{}).get('candidate_version_relation'),
            'rights_authorization_verified':False,
            'isrc_independently_verified':False,'actual_audio_processed':True,'actual_audio_listened':False,**decoded}


def reuse_full(prepared, decoder):
    reuse = prepared['spec']['reuse_existing']
    previous = checked(reuse['acquisition_receipt'])
    if previous.get('status') == 'acquisition_attempt_passed':
        original = previous.get('recording')
        if previous.get('source_url') != prepared['spec']['official_source']['page_url'] or previous.get('exit_code') != 0:
            raise ValueError('reuse_prior_normal_official_page_mismatch')
    elif previous.get('full_recording_acquired') is True and previous.get('requested_extent') == 'full_recording':
        original = next((row['source'] for row in previous.get('actual_recordings', []) if row['source']['sha256']==reuse['source']['sha256']), None)
        if previous.get('official_source') != prepared['spec']['official_source']:
            raise ValueError('reuse_official_recording_metadata_mismatch')
    else:
        raise ValueError('existing_preview_is_not_a_full_recording')
    if not original or original['sha256'] != reuse['source']['sha256']:
        raise ValueError('stored_mirror_does_not_bind_prior_complete_recording')
    record = verify_complete_file(prepared, reuse['source'], decoder)
    record.update(prior_acquisition_receipt=reuse['acquisition_receipt'],mirror_original_binding=original,
                  byte_identical_stored_mirror=Path(original['path']).resolve()!=Path(reuse['source']['path']).resolve())
    return record


def output_file(prepared, state, decoder):
    directory = Path(state['media_directory'])
    files = [file for file in directory.glob('complete.*') if file.suffix in MEDIA_EXTENSIONS]
    info = directory/'complete.info.json'
    if len(files) != 1 or not info.is_file():
        return None
    metadata = read(info)
    current_duration = validate_metadata(metadata,prepared['spec'],prepared['spec']['official_source']['page_url'])
    if abs(current_duration-prepared['duration']) > max(1.5,prepared['duration']*.01):
        raise ValueError('official_entry_duration_changed_since_bound_metadata')
    record = verify_complete_file(prepared, bind(files[0]), decoder, metadata)
    record['actual_download_metadata'] = bind(info)
    return record


def publish_complete_recording(prepared,state,record,out):
    """Append a verified encoded file to S; no remote rename/delete is required."""
    local=Path(record['source']['path']).resolve()
    if not local.is_relative_to(out/'media-staging'):
        raise ValueError('owned_local_recording_staging_required')
    destination=Path(prepared['spec']['recording_output_root'])/prepared['task_key'][:24]/('attempt-'+str(state['attempts']))
    destination.mkdir(parents=True,exist_ok=True)
    audio=destination/('complete'+local.suffix)
    if audio.exists():
        if digest(audio)!=record['source']['sha256']:
            raise ValueError('existing_publication_file_conflict_no_overwrite')
    else:
        with local.open('rb') as source,audio.open('xb') as target:
            shutil.copyfileobj(source,target,1024*1024)
    if digest(audio)!=record['source']['sha256']:
        raise ValueError('append_only_recording_publication_sha_mismatch')
    record['encoded_local_staging_binding']=record['source']
    record['source']=bind(audio)
    record['append_only_publication']={'source_sha_verified':True,'remote_atomic_replace_used':False,
                                     'actual_metadata_kept_locally':record['actual_download_metadata']}
    # Only remove this job's exact encoded cache after the verified permanent copy.
    local.unlink()
    record['encoded_local_staging_retained']=False
    state['published_source']=record['source']
    return record


def acquire(input_path, out, reconcile_only=False, runner=subprocess.run, decoder=decode_full_audio):
    prepared = prepare(input_path)
    out = Path(out).resolve()
    if str(out).startswith('\\\\') or (os.name=='nt' and __import__('ctypes').windll.kernel32.GetDriveTypeW(str(out.anchor))==4):
        raise ValueError('local_small_job_state_required_media_may_be_on_S')
    out.mkdir(parents=True, exist_ok=True)
    lock = out/'full-recording.lock'
    token = uuid.uuid4().hex
    try:
        claim = lock.open('x',encoding='utf-8')
    except FileExistsError:
        raise ValueError('full_recording_job_already_owned_do_not_override_lock')
    with claim:
        json.dump({'pid':os.getpid(),'token':token,'task_key':prepared['task_key'],'started_at':now()},claim)
    state_path = out/STATE
    try:
        state = read(state_path) if state_path.is_file() else None
        if state and state['task_key'] != prepared['task_key']:
            raise ValueError('full_recording_job_identity_changed')
        repair = prepared['spec'].get('targeted_repair')
        page_refetch=bool(prepared.get('page_refetch_runtime'))
        if page_refetch and not state:
            raise ValueError('original_failed_job_state_required_for_page_refetch')
        if page_refetch and state['input']==prepared['input'] and state.get('attempts')==2 and state.get('result'):
            # Replaying this exact repaired input returns its immutable result;
            # it does not download again or reanalyse a successful recording.
            return state['result'], checked(state['result'])
        if state and state['input'] != prepared['input']:
            if (not repair or state.get('attempts') != 1 or state['status'] not in ('failed_full_acquisition','full_recording_input_gap')
                    or repair.get('previous_failure') != state.get('result') or not repair.get('reason','').strip()
                    or not (page_refetch or repair.get('changed_approach')=='validated_existing_full_recording_reuse' and prepared['spec'].get('reuse_existing'))):
                raise ValueError('explicit_one_targeted_repair_or_original_input_required')
            previous_failure = checked(repair['previous_failure'])
            checked(previous_failure['input'])
            if previous_failure.get('task_key') != prepared['task_key']:
                raise ValueError('targeted_repair_original_task_mismatch')
            state = {**state,'input':prepared['input'],'attempts':2,'status':'targeted_repair_prepared','previous_failure':repair['previous_failure']}
        result = {'schema_version':1,'requested_extent':'full_recording','task_key':prepared['task_key'],'input':prepared['input'],
                  'official_source':prepared['spec']['official_source'],'scope_preserved':prepared['scope'],'created_at_utc':now(),
                  'execution_kind':'actual_local_tools' if runner is subprocess.run and decoder is decode_full_audio else 'injected_offline_test',
                  'actual_recordings':[],'full_recording_acquired':False,'new_media_transfers':0,'network_acquisition_attempts_this_call':0,
                  'source_match_verified':False,'strict_original_identity_verified':False,'cleanliness_verified':False,'lyrics_verified':False,
                  'actual_audio_listened':False,'Ready':False,'ready_packages':0,'reference_music_budget_credit':False,
                  'production_approval':False,'paid_calls':0,'private_uploads':0,'models_called':0,'new_user_film_trials':0,
                  'automatic_replay_allowed':False}
        if state and state.get('status') in ('running_download','unknown_acquisition_outcome','unknown_outcome_requires_explicit_review'):
            result['reconciliation_only'] = True
            record = output_file(prepared,state,decoder)
            if record:
                if Path(record['source']['path']).resolve().is_relative_to(out/'media-staging'):
                    record=publish_complete_recording(prepared,state,record,out)
                result.update(status='completed_full_recording_reconciled_without_network',actual_recordings=[record],full_recording_acquired=True)
            else:
                result.update(status='unknown_outcome_requires_explicit_review',gap='no_complete_owned_file_to_reconcile; no automatic resubmission')
        elif state and state.get('result') and not repair:
            previous = checked(state['result'])
            if previous.get('full_recording_acquired') is True:
                record = verify_complete_file(prepared,previous['actual_recordings'][0]['source'],decoder)
                result.update(status='cached_full_recording_rehashed_and_decoded_without_network',actual_recordings=[record],full_recording_acquired=True)
            else:
                return state['result'], previous
        elif prepared['spec'].get('reuse_existing'):
            try:
                record = reuse_full(prepared,decoder)
                result.update(status='existing_complete_official_recording_revalidated',actual_recordings=[record],full_recording_acquired=True)
            except (ValueError,OSError,subprocess.SubprocessError) as error:
                result.update(status='full_recording_input_gap',gap=str(error))
        elif reconcile_only:
            result.update(status='no_prior_full_recording_attempt_to_reconcile',gap='reconciliation never starts a download')
        else:
            gib=1024**3
            cache_bytes=sum(file.stat().st_size for file in out.parent.glob('*/media-staging/**/*') if file.is_file())
            free_bytes=shutil.disk_usage(out).free
            if cache_bytes>=gib or free_bytes<3*gib:
                result.update(status='storage_budget_gap',gap='encoded staging cap1GiB and reserved free2GiB required',
                              encoded_staging_bytes=cache_bytes,free_bytes=free_bytes)
                result['attempts_total']=(state or {}).get('attempts',prepared['attempts'])
                result['finished_at_utc']=now()
                artifact=write_new(out/('storage-budget-gap-'+uuid.uuid4().hex+'.json'),result)
                save_state(state_path,{'task_key':prepared['task_key'],'input':prepared['input'],'attempts':result['attempts_total'],
                                       'status':result['status'],'result':artifact,'updated_at_utc':now()})
                return artifact,result
            media = out/'media-staging'/('attempt-'+str(prepared['attempts']))
            media.mkdir(parents=True,exist_ok=False)
            state = {'task_key':prepared['task_key'],'input':prepared['input'],'attempts':prepared['attempts'],'status':'running_download',
                     'media_directory':str(media),'started_at_utc':now()}
            save_state(state_path,state)
            command = [prepared['spec']['yt_dlp']['path'],'--ignore-config','--no-playlist','--no-cache-dir','--proxy',prepared['proxy'],
                       '--socket-timeout','20','--retries','0','--fragment-retries','0','--extractor-retries','0',
                       '--newline','--encoding','utf-8','--max-filesize','1G','--write-info-json','-f','bestaudio',
                       '-o',str(media/'complete.%(ext)s')]
            if page_refetch:
                command[1:1]=['--js-runtimes','node:'+prepared['page_refetch_runtime']['path']]
                command += [prepared['spec']['official_source']['page_url']]
            elif prepared['spec']['official_source'].get('download_from_bound_fresh_metadata'):
                command += ['--load-info-json',prepared['spec']['official_source']['metadata']['path']]
            else:
                command += [prepared['spec']['official_source']['page_url']]
            result['network_acquisition_attempts_this_call'] = 1
            result['local_staging_budget']={'encoded_cap_bytes':gib,'reserved_free_bytes':2*gib,
                                            'existing_encoded_staging_bytes':cache_bytes,'free_bytes_before':free_bytes}
            try:
                process = runner(command,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=300)
                prefix='download-attempt-2' if page_refetch else 'download'
                for name,data in [(prefix+'.stdout.log',process.stdout or ''),(prefix+'.stderr.log',process.stderr or '')]:
                    (out/name).write_text(data,encoding='utf-8')
                result['download_execution'] = {'argv':command,'tool':prepared['spec']['yt_dlp'],'exit_code':process.returncode,
                    'stdout':bind(out/(prefix+'.stdout.log')),'stderr':bind(out/(prefix+'.stderr.log')),
                    'session_credentials_supplied':False,'browser_cookies_supplied':False,'session_cookie_file_supplied':False,
                    'authorization_supplied':False,'login_used':False,'proxy_disabled_by_argv':not bool(prepared['proxy']),
                    'network_route':prepared['spec'].get('network_route'),'download_uses_bound_recent_metadata':bool(prepared['spec']['official_source'].get('download_from_bound_fresh_metadata')) and not page_refetch,
                    **({'normal_official_page_refetched':True,'existing_js_runtime':prepared['page_refetch_runtime'],
                        'previous_failed_attempt':repair['previous_failure'],'JS_root_cause_proven':False} if page_refetch else {}),
                    'automatic_retries':0}
                if process.returncode:
                    result.update(status='failed_full_acquisition',gap='normal_official_full_entry_acquisition_failed; bounded attempt retained')
                    if re.search(r'(?<!\d)429(?!\d)|Too Many Requests',process.stderr or '',re.I):
                        result.update(status='rate_limited_requires_explicit_resume',global_cooldown_required=True)
                else:
                    record = output_file(prepared,state,decoder)
                    if not record:
                        raise ValueError('tool_success_without_complete_owned_recording')
                    record = publish_complete_recording(prepared,state,record,out)
                    result.update(status='complete_official_recording_acquired_unreviewed',actual_recordings=[record],full_recording_acquired=True,new_media_transfers=1)
            except subprocess.TimeoutExpired:
                result.update(status='unknown_acquisition_outcome',transfer_outcome_unknown=True,
                              gap='download_timeout; inspect owned output without automatic replay')
            except (ValueError,OSError,subprocess.SubprocessError) as error:
                result.update(status='failed_full_acquisition',gap=str(error))
        # Immutable results; only this local small state pointer moves.
        result['attempts_total'] = (state or {}).get('attempts',1)
        result['finished_at_utc'] = now()
        result_name = RESULT if not (out/RESULT).exists() else 'full-recording-result-'+uuid.uuid4().hex+'.json'
        binding = write_new(out/result_name,result)
        state = {**(state or {}),'task_key':prepared['task_key'],'input':prepared['input'],'attempts':result['attempts_total'],
                 'status':result['status'],'result':binding,'updated_at_utc':now()}
        save_state(state_path,state)
        return binding,result
    finally:
        if lock.is_file() and read(lock).get('token')==token:
            lock.unlink()


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True,help='Local small job state; recording_output_root may be S:')
    parser.add_argument('--reconcile-only',action='store_true')
    args = parser.parse_args()
    artifact,result = acquire(args.input,args.out,args.reconcile_only)
    print(json.dumps({'artifact':artifact,'status':result['status'],'task_key':result['task_key'],'requested_extent':'full_recording',
                      'actual_recordings':len(result['actual_recordings']),'new_media_transfers':result['new_media_transfers'],
                      'full_recording_acquired':result['full_recording_acquired'],'Ready':False,'paid_calls':0},ensure_ascii=False))
