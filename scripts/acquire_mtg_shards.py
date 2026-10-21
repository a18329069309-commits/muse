"""Download explicit pinned MTG audio-low shards into an independent batch."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

BASE = 'https://cdn.freesound.org/mtg-jamendo/raw_30s/audio-low/'
RESERVE = 10 * 1024 ** 3
TIMEOUT = 30
TRANSFER_TIMEOUT = 15 * 60
HTTP_BACKEND = 'urllib'
SOURCE_FILES = [('README.md', 'README.md'), ('scripts/download/download.py', 'official-download.py'),
    ('audio_licenses.txt', 'audio_licenses.txt'),
    ('data/raw_30s_cleantags_50artists.tsv', 'raw_30s_cleantags_50artists.tsv'),
    ('data/download/raw_30s_audio-low_sha256_tars.txt', 'raw_30s_audio-low_sha256_tars.txt'),
    ('data/download/raw_30s_audio-low_sha256_tracks.txt', 'raw_30s_audio-low_sha256_tracks.txt')]


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 ** 2), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def publish_verified_partial(partial, target, expected):
    """Some write-enabled SMB shares forbid rename/delete; publish by verified copy."""
    partial, target = Path(partial), Path(target)
    if (partial.is_symlink() or target.is_symlink() or target.exists()
            or partial.resolve().parent != target.resolve().parent
            or partial.name not in {target.name + '.part', target.name + '.extract-part'}
            or digest(partial) != expected):
        raise ValueError('invalid verified publication')
    size = partial.stat().st_size
    try:
        partial.rename(target)
        return 'rename'
    except PermissionError:
        # Exclusive creation never overwrites an existing source or other job.
        with partial.open('rb') as incoming, target.open('xb') as output:
            shutil.copyfileobj(incoming, output, 4 * 1024 ** 2)
        if target.stat().st_size != size or digest(target) != expected:
            raise ValueError('copied publication failed verification')
        # Reclaim only our redundant partial after the final bytes are verified.
        # Truncation works on shares which disallow deleting directory entries.
        with partial.open('wb'):
            pass
        return 'verified_copy_partial_reclaimed'


def validate_job(shards, out, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('revision must be a pinned lowercase 40-character Git SHA')
    if not shards or any(not re.fullmatch(r'\d{1,2}', str(s)) for s in shards):
        raise ValueError('shards must be an explicit nonempty list from 00 to 99')
    ids = [int(s) for s in shards]
    if any(s > 99 for s in ids) or len(set(ids)) != len(ids):
        raise ValueError('shards must be unique integers from 00 to 99')
    root = Path(out).resolve()
    if root == Path(root.anchor) or root.is_file():
        raise ValueError('out must be an independent batch directory')
    job = {'revision': revision, 'shards': sorted(f'{s:02d}' for s in ids), 'distribution': 'raw_30s/audio-low'}
    if root.exists() and any(root.iterdir()):
        if not (root / 'job.json').is_file() or json.loads((root / 'job.json').read_text(encoding='utf-8')) != job:
            raise ValueError('existing out is not this pinned batch; refusing overwrite')
        if (root / 'acquisition-report.json').exists():
            raise ValueError('completed batch report exists; refusing overwrite')
    if any(not (root / name).resolve().is_relative_to(root) for name in ('provenance', 'archives', 'audio', 'runs')):
        raise ValueError('batch subdirectory escapes out')
    return root, job


class CurlResponse:
    """Use existing Windows curl TLS, retaining the same verified Range contract."""
    def __init__(self, url, headers):
        handle = tempfile.NamedTemporaryFile(prefix='mtg-public-headers-', suffix='.txt', delete=False)
        self.header_file = Path(handle.name)
        handle.close()
        command = ['curl.exe', '--silent', '--show-error', '--fail', '--connect-timeout', str(TIMEOUT),
                   '--max-time', str(TRANSFER_TIMEOUT), '--speed-time', str(TIMEOUT), '--speed-limit', '1',
                   '--dump-header', str(self.header_file)]
        for key, value in headers.items():
            command += ['--header', key + ': ' + value]
        self.process = subprocess.Popen(command + [url], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        started = time.monotonic()
        while True:
            text = self.header_file.read_text(encoding='iso-8859-1')
            blocks = [part for part in re.split(r'\r?\n\r?\n', text)[:-1] if part.startswith('HTTP/')]
            if blocks and 'Connection established' not in blocks[-1].splitlines()[0]:
                lines = blocks[-1].splitlines()
                self.status = int(lines[0].split()[1])
                from email.message import Message
                self.headers = Message()
                for line in lines[1:]:
                    if ':' in line:
                        name, value = line.split(':', 1)
                        self.headers[name] = value.strip()
                break
            if self.process.poll() is not None or time.monotonic() - started > TIMEOUT:
                self.close()
                raise OSError('curl did not return a complete public HTTP header')
            time.sleep(.05)

    def read(self, count):
        data = self.process.stdout.read(count)
        if not data and self.process.poll() not in (None, 0):
            raise OSError('curl public transfer failed with exit ' + str(self.process.returncode))
        return data

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=TIMEOUT)
        self.process.stdout.close()
        self.process.stderr.close()
        self.header_file.unlink(missing_ok=True)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def request(url, headers=None):
    request_headers = {'User-Agent': 'Codex-public-audio-library-research',
                       'Accept-Encoding': 'identity', **(headers or {})}
    if HTTP_BACKEND == 'curl':
        return CurlResponse(url, request_headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers={
        **request_headers}), timeout=TIMEOUT)


def prepare_sources(root, revision, emit):
    base = f'https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/{revision}/'
    def fetch(item):
        source, name = item
        with request(base + source) as response:
            if response.status != 200:
                raise ValueError('metadata response is not HTTP 200')
            data = response.read(128 * 1024 ** 2 + 1)
        if len(data) > 128 * 1024 ** 2:
            raise ValueError('metadata exceeds size bound')
        sha = hashlib.sha256(data).hexdigest()
        target = root / 'provenance' / name
        if target.exists():
            if digest(target) != sha:
                raise ValueError('existing pinned metadata differs; refusing overwrite')
        else:
            with target.open('xb') as stream:
                stream.write(data)
        result = {'url': base + source, 'path': str(target), 'bytes': len(data), 'sha256': sha}
        emit({'metadata_verified': name, 'bytes': len(data)})
        return result
    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(fetch, SOURCE_FILES))


def reuse_pinned_sources(root, revision, receipt, emit):
    """Reuse exact already-verified official metadata, avoiding repeated network fetches."""
    report = json.loads(Path(receipt).read_text(encoding='utf-8-sig'))
    if report.get('complete') is not True or report.get('failures') or report.get('official_revision') != revision:
        raise ValueError('complete pinned metadata receipt required')
    evidence = {'path': str(Path(receipt).resolve()), 'sha256': digest(receipt)}
    base = f'https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/{revision}/'
    result = []
    for relative, name in SOURCE_FILES:
        rows = [r for r in report.get('source_metadata', []) if r.get('url') == base + relative]
        if len(rows) != 1 or not re.fullmatch(r'[a-f0-9]{64}', rows[0].get('sha256', '')):
            raise ValueError('pinned metadata source identity missing')
        source, target, expected = Path(rows[0]['path']), root / 'provenance' / name, rows[0]['sha256']
        if source.is_symlink() or digest(source) != expected or target.is_symlink():
            raise ValueError('pinned metadata bytes changed')
        if target.exists():
            if digest(target) != expected:
                raise ValueError('existing pinned metadata differs')
        else:
            with source.open('rb') as incoming, target.open('xb') as output:
                shutil.copyfileobj(incoming, output, 4 * 1024 ** 2)
            if digest(target) != expected:
                raise ValueError('reused metadata copy differs')
        result.append({**rows[0], 'path': str(target.resolve()), 'reused_from': evidence})
        emit({'metadata_reused': name, 'bytes': target.stat().st_size})
    return result


def checksum_map(path):
    result = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        sha, name = line.split(maxsplit=1)
        if not re.fullmatch(r'[0-9a-f]{64}', sha) or name in result:
            raise ValueError('invalid or repeated publisher checksum')
        result[name] = sha
    return result


def probe_archive(name):
    with request(BASE + name, {'Range': 'bytes=0-0'}) as response:
        match = re.fullmatch(r'bytes 0-0/(\d+)', response.headers.get('Content-Range', ''))
        etag = response.headers.get('ETag')
        if response.status != 206 or not match or not etag or int(match[1]) < 1 or len(response.read(2)) != 1:
            raise ValueError('invalid source byte probe')
    return {'bytes': int(match[1]), 'etag': etag, 'source_url': BASE + name}


def download_archive(root, name, expected, probe, emit):
    started = time.monotonic()
    final, partial = root / 'archives' / name, root / 'archives' / (name + '.part')
    if any(p.is_symlink() for p in (final, partial, partial.with_name(partial.name + '.json'))):
        raise ValueError('linked archive or partial is not allowed')
    total, etag = probe['bytes'], probe['etag']
    result = {'name': name, 'source_url': BASE + name, 'bytes': total, 'etag': etag}
    if final.exists():
        if final.stat().st_size != total or digest(final) != expected:
            raise ValueError('existing archive differs from publisher checksum')
        return {**result, 'sha256': expected, 'official_sha256_verified': True, 'reused': True,
            'network_bytes_this_run': 0, 'seconds': time.monotonic() - started}
    state = partial.with_name(partial.name + '.json')
    identity = {'url': BASE + name, 'sha256': expected, 'bytes': total, 'etag': etag}
    if state.exists():
        if json.loads(state.read_text(encoding='utf-8')) != identity:
            raise ValueError('partial source identity differs; refusing resume')
    elif partial.exists():
        raise ValueError('partial has no verified source identity')
    else:
        write_json(state, identity)
    network_bytes = 0
    for attempt in range(1, 3):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > total:
            raise ValueError('partial exceeds declared source length')
        if offset == total:
            break
        try:
            with request(BASE + name, {'Range': f'bytes={offset}-', 'If-Range': etag}) as response:
                if response.status != 206 or response.headers.get('ETag') != etag or response.headers.get('Content-Range') != f'bytes {offset}-{total - 1}/{total}':
                    raise ValueError('HTTP range or ETag differs; refusing append')
                last_log = time.monotonic()
                with partial.open('ab' if partial.exists() else 'xb') as output:
                    while True:
                        block = response.read(4 * 1024 ** 2)
                        if not block:
                            break
                        if offset + len(block) > total:
                            raise ValueError('response exceeds declared length')
                        output.write(block)
                        offset += len(block)
                        network_bytes += len(block)
                        if time.monotonic() - last_log >= 15:
                            emit({'archive': name, 'downloaded_bytes': offset, 'total_bytes': total, 'attempt': attempt})
                            last_log = time.monotonic()
                if offset != total:
                    raise OSError('incomplete source response')
            break
        except (OSError, urllib.error.URLError) as error:
            emit({'archive': name, 'attempt': attempt, 'error_type': type(error).__name__, 'retry_pending': attempt < 2})
            if attempt == 2:
                raise
    if digest(partial) != expected:
        raise ValueError('publisher archive SHA256 mismatch; refusing extraction')
    publication = publish_verified_partial(partial, final, expected)
    result.update(sha256=expected, official_sha256_verified=True, reused=False,
        publication_method=publication, network_bytes_this_run=network_bytes, seconds=time.monotonic() - started)
    emit({'archive_verified': name, 'bytes': total, 'seconds': result['seconds']})
    return result


def member_target(audio, name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError('unsafe archive member path')
    target = (audio / Path(*path.parts)).resolve()
    if not target.is_relative_to(audio.resolve()):
        raise ValueError('archive member escapes audio directory')
    return target


def safe_extract(root, archive, checksums, emit):
    started = time.monotonic()
    audio = root / 'audio'
    if not audio.resolve().is_relative_to(root.resolve()):
        raise ValueError('audio directory escapes batch root')
    records = []
    with tarfile.open(root / 'archives' / archive['name'], 'r:') as source:
        members = source.getmembers()
        if shutil.disk_usage(root).free < RESERVE + sum(m.size for m in members if m.isfile()):
            raise ValueError('insufficient extraction space plus reserve')
        for member in members:
            target = member_target(audio, member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile() or not re.fullmatch(r'\d{2}/\d+\.low\.mp3', member.name) or member.name not in checksums:
                raise ValueError('unexpected or linked archive member')
            target.parent.mkdir(parents=True, exist_ok=True)
            reused = target.exists()
            if not reused:
                partial = target.with_name(target.name + '.extract-part')
                if partial.is_symlink():
                    raise ValueError('linked extraction partial is not allowed')
                offset = partial.stat().st_size if partial.exists() else 0
                if offset > member.size:
                    raise ValueError('extraction partial exceeds member size')
                with source.extractfile(member) as incoming, partial.open('ab' if partial.exists() else 'xb') as output:
                    incoming.seek(offset)
                    shutil.copyfileobj(incoming, output, 4 * 1024 ** 2)
                actual = digest(partial)
                if partial.stat().st_size != member.size or actual != checksums[member.name]:
                    raise ValueError('individual publisher media SHA256 mismatch')
                publish_verified_partial(partial, target, checksums[member.name])
            else:
                actual = digest(target)
            if target.stat().st_size != member.size or actual != checksums[member.name]:
                raise ValueError('existing media differs from publisher checksum')
            records.append({'path': str(target), 'source_archive': archive['name'], 'source_archive_sha256': archive['sha256'],
                'official_member_path': member.name, 'source_track_id': int(Path(member.name).name.split('.')[0]),
                'source_sha256': checksums[member.name], 'file_size_bytes': member.size,
                'individual_official_sha256_verified': True, 'previous_verified_extraction_reused': reused,
                'listening_status': 'pending', 'license_join': 'pending', 'artistic_approval': False})
    result = {'archive': archive['name'], 'actual_audio_files': len(records),
        'actual_audio_bytes': sum(r['file_size_bytes'] for r in records), 'seconds': time.monotonic() - started, 'records': records}
    emit({k: v for k, v in result.items() if k != 'records'})
    return result


def acquire(shards, out, revision, metadata_receipt=None, http_backend='urllib'):
    global HTTP_BACKEND
    if http_backend not in ('urllib', 'curl'):
        raise ValueError('unknown public HTTP backend')
    HTTP_BACKEND = http_backend
    root, job = validate_job(shards, out, revision)
    root.mkdir(parents=True, exist_ok=True)
    if not (root / 'job.json').exists():
        write_json(root / 'job.json', job)
    for name in ('provenance', 'archives', 'audio'):
        (root / name).mkdir(exist_ok=True)
    run = root / 'runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    run.mkdir(parents=True)
    lock = threading.Lock()
    def emit(value):
        line = json.dumps({'utc': datetime.now(timezone.utc).isoformat(), **value}, ensure_ascii=False)
        with lock, (run / 'events.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(line + '\n')
            print(line, flush=True)
    started = time.monotonic()
    report = {'official_revision': revision, 'source': 'https://github.com/MTG/mtg-jamendo-dataset',
        'archive_source': BASE, 'http_backend': http_backend,
        'network_attempt_seconds_limit': TRANSFER_TIMEOUT if http_backend == 'curl' else None,
        'pid': os.getpid(), 'run_directory': str(run), 'requested_archives':
        [f'raw_30s_audio-low-{s}.tar' for s in job['shards']], 'archive_results': [], 'extractions': [], 'failures': [],
        'usage_scope': 'research_noncommercial', 'source_metadata_join': 'pending', 'listening_status': 'pending',
        'artistic_approval': False, 'production_approved': False, 'file_decode': 'not_performed_in_acquisition_step',
        'uploads': 0, 'fees': 0, 'generation_calls': 0}
    emit({'batch_started': str(root), 'pid': os.getpid(), 'run_directory': str(run)})
    try:
        report['source_metadata'] = reuse_pinned_sources(root, revision, metadata_receipt, emit) if metadata_receipt else prepare_sources(root, revision, emit)
        archives = checksum_map(root / 'provenance/raw_30s_audio-low_sha256_tars.txt')
        tracks = checksum_map(root / 'provenance/raw_30s_audio-low_sha256_tracks.txt')
        with ThreadPoolExecutor(max_workers=2) as pool:
            probes = dict(zip(report['requested_archives'], pool.map(probe_archive, report['requested_archives'])))
        total = sum(p['bytes'] for p in probes.values())
        free = shutil.disk_usage(root).free
        report['space_preflight'] = {'available_bytes': free, 'archive_bytes': total,
            'archive_plus_extract_plus_reserve_required_bytes': 2 * total + RESERVE, 'reserve_bytes': RESERVE}
        if free < 2 * total + RESERVE:
            raise ValueError('insufficient double archive/extraction budget plus 10GiB reserve')
        emit({'space_preflight_passed': report['space_preflight']})
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(download_archive, root, name, archives[name], probes[name], emit): name for name in probes}
            for future in as_completed(futures):
                try:
                    report['archive_results'].append(future.result())
                except Exception as error:
                    report['failures'].append({'archive': futures[future], 'phase': 'download', 'type': type(error).__name__, 'error': str(error)})
        for archive in sorted(report['archive_results'], key=lambda a: a['name']):
            try:
                report['extractions'].append(safe_extract(root, archive, tracks, emit))
            except Exception as error:
                report['failures'].append({'archive': archive['name'], 'phase': 'extraction', 'type': type(error).__name__, 'error': str(error)})
    except Exception as error:
        report['failures'].append({'phase': 'preflight_or_metadata', 'type': type(error).__name__, 'error': str(error)})
    records = [r for extraction in report['extractions'] for r in extraction['records']]
    report.update(actual_downloaded_archives=len(report['archive_results']), actual_audio_files=len(records),
        actual_unique_file_sha256=len({r['source_sha256'] for r in records}),
        actual_audio_bytes=sum(r['file_size_bytes'] for r in records), records=records,
        actual_archive_bytes=sum(a['bytes'] for a in report['archive_results']),
        network_archive_bytes_this_run=sum(a['network_bytes_this_run'] for a in report['archive_results']),
        seconds=time.monotonic() - started, free_bytes_after=shutil.disk_usage(root).free)
    report['complete'] = not report['failures'] and len(report['extractions']) == len(job['shards'])
    write_json(run / 'report.json', report)
    if report['complete']:
        write_json(root / 'acquisition-report.json', report)
    emit({'batch_complete': report['complete'], 'report_path': str(run / 'report.json'),
        **{k: report[k] for k in ('actual_audio_files', 'actual_unique_file_sha256', 'actual_audio_bytes', 'seconds', 'failures')}})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shards', nargs='+', required=True, help='Explicit unique shard IDs 00–99')
    parser.add_argument('--out', type=Path, required=True, help='Independent batch directory; failed same batch can resume')
    parser.add_argument('--revision', required=True, help='Pinned official 40-character Git commit SHA')
    args = parser.parse_args()
    try:
        result = acquire(args.shards, args.out, args.revision)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
