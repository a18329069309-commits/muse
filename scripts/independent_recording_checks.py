"""Bounded, hash-bound technical checks; never grants sound/use qualification."""
from array import array
from contextlib import contextmanager
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

PCM_RATE = 48000
CACHE_SCHEMA_VERSION = 2
_RUNTIME_CACHE = {}
_RUNTIME_LOCK = threading.Lock()


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_json(path, value, *, require_atomic=False):
    """Prefer atomic replace; immutable receipts support create-only shares.

    Cache callers require atomic replace. On a share which specifically denies
    rename, new immutable evidence can be copied exclusively and checked before
    returning its binding; an existing destination is never overwritten there.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.replace(temporary, path)
        except PermissionError:
            if require_atomic or path.exists():
                raise
            expected = digest_file(temporary)
            with open(temporary, 'rb') as source, path.open('xb') as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)
                destination.flush()
                os.fsync(destination.fileno())
            if digest_file(path) != expected:
                raise OSError('music_packs_immutable_json_commit_hash_mismatch')
    finally:
        if os.path.exists(temporary):
            try:
                os.unlink(temporary)
            except PermissionError:
                # Some archival SMB shares deny deletion as well as rename.
                # Retain staged evidence; cleanup cannot invalidate a verified
                # final binding or hide the original failed commit exception.
                pass
    return {'path': str(path.absolute()), 'sha256': digest_file(path)}


def technical_processor_sha256():
    return _LOADED_PROCESSOR_SHA256


# Bind the executing code at import, not a file that may be upgraded mid-run.
_LOADED_PROCESSOR_SHA256 = digest_file(__file__)


def _source_identity(file):
    file = Path(file)
    before = file.stat()
    if not file.is_file() or before.st_size <= 0:
        raise ValueError('music_packs_invalid_audio')
    sha = digest_file(file)
    after = file.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('music_packs_recording_changed_during_check')
    return {'sha256': sha, 'bytes': before.st_size, 'mtime_ns': before.st_mtime_ns}


def bounded_source_identity(file, timeout=60):
    """A disposable reader bounds both stat and SHA reads on lost SMB shares."""
    command = [sys.executable, '-X', 'utf8', str(Path(__file__).resolve()), '_hash_source', str(file)]
    process = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    if process.returncode:
        error = process.stderr.strip()
        if error.startswith('FileNotFoundError:'):
            raise FileNotFoundError('music_packs_recording_not_available: ' + error[-500:])
        for reason in ('recording_changed_during_check', 'invalid_audio'):
            if 'music_packs_' + reason in error:
                raise ValueError('music_packs_' + reason)
        raise OSError('music_packs_source_read_failed: ' + error[-500:])
    identity = json.loads(process.stdout)
    if (not re.fullmatch(r'[0-9a-f]{64}', identity.get('sha256', ''))
            or identity.get('bytes', 0) <= 0 or not isinstance(identity.get('mtime_ns'), int)):
        raise ValueError('music_packs_source_identity_invalid')
    return identity


def _decoder_identity():
    paths = [shutil.which(name) for name in ('ffmpeg', 'ffprobe')]
    if not all(paths):
        raise OSError('music_packs_ffmpeg_and_ffprobe_required')
    key = tuple((str(Path(path).resolve()), Path(path).stat().st_size,
                 Path(path).stat().st_mtime_ns) for path in paths)
    with _RUNTIME_LOCK:
        if key not in _RUNTIME_CACHE:
            tools = {}
            for name, (path, size, modified) in zip(('ffmpeg', 'ffprobe'), key):
                process = subprocess.run([path, '-version'], capture_output=True, text=True,
                    encoding='utf-8', check=True, timeout=10)
                tools[name] = {'path': path, 'sha256': digest_file(path),
                    'version': process.stdout.splitlines()[0], 'bytes': size, 'mtime_ns': modified}
            _RUNTIME_CACHE[key] = tools
        return _RUNTIME_CACHE[key]


def _pcm_rms(block):
    pcm = array('f')
    pcm.frombytes(block)
    if sys.byteorder != 'little':
        pcm.byteswap()
    mean_square = math.fsum(value * value for value in pcm) / len(pcm)
    if not math.isfinite(mean_square):
        raise ValueError('music_packs_invalid_pcm_values')
    return 20 * math.log10(max(math.sqrt(mean_square), 1e-9))


def _decode_pcm(file, decoder, timeout):
    """One strict full decode supplies actual duration and one-second RMS."""
    command = [decoder, '-nostdin', '-v', 'error', '-xerror', '-i', str(file),
        '-map', '0:a:0', '-ac', '1', '-ar', str(PCM_RATE), '-f', 'f32le', '-']
    expired = threading.Event()
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        def expire():
            if process.poll() is None:
                expired.set()
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        timer = threading.Timer(timeout, expire)
        timer.daemon = True
        timer.start()
        samples, rms, carry = 0, [], b''
        try:
            # Retain at most one second of PCM, even for a long recording.
            while True:
                block = process.stdout.read(PCM_RATE * 4 - len(carry))
                if not block:
                    break
                carry += block
                if len(carry) == PCM_RATE * 4:
                    rms.append(_pcm_rms(carry))
                    samples += PCM_RATE
                    carry = b''
            if len(carry) % 4:
                raise ValueError('music_packs_invalid_pcm_length')
            if carry:
                rms.append(_pcm_rms(carry))
                samples += len(carry) // 4
            code = process.wait()
            if expired.is_set():
                raise subprocess.TimeoutExpired(command, timeout)
            if code:
                errors.seek(0)
                detail = errors.read().decode('utf-8', errors='replace')
                raise ValueError('music_packs_full_decode_failed: ' + detail[-500:])
            if not samples:
                raise ValueError('music_packs_invalid_audio')
            return samples, rms
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()


def _probe_and_decode(file, identity, runtime, probe_timeout=30, decode_timeout=180):
    process = subprocess.run([runtime['ffprobe']['path'], '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', str(file)],
        capture_output=True, text=True, encoding='utf-8', check=True, timeout=probe_timeout)
    info = json.loads(process.stdout)
    streams = info.get('streams', [])
    if not streams:
        raise ValueError('music_packs_no_audio_stream')
    try:
        sample_rate = int(streams[0]['sample_rate'])
        channels = int(streams[0]['channels'])
    except (KeyError, ValueError, TypeError):
        raise ValueError('music_packs_invalid_audio_stream') from None
    if sample_rate <= 0 or channels <= 0:
        raise ValueError('music_packs_invalid_audio')
    samples, rms = _decode_pcm(file, runtime['ffmpeg']['path'], decode_timeout)
    result = {**identity, 'duration_seconds': samples / PCM_RATE,
        'duration_samples': samples, 'timeline_sample_rate_hz': PCM_RATE,
        'sample_rate_hz': sample_rate, 'channels': channels,
        'full_decode': {'exit_code': 0, 'decoder': 'ffmpeg', 'strict_errors': True,
            'clock_basis': 'actual_decoded_pcm_samples', 'decoded_samples': samples,
            'decoded_sample_rate_hz': PCM_RATE, 'pcm_format': 'f32le_mono', 'runtime': runtime}}
    try:
        duration = float(info.get('format', {}).get('duration'))
        if math.isfinite(duration) and duration > 0:
            result['container_duration_seconds'] = duration
    except (ValueError, TypeError):
        pass
    observation = {'kind': 'decoded_pcm_rms', 'input_sha256': identity['sha256'],
        'time_resolution_seconds': 1, 'rms_dbfs': rms,
        'decoded_samples': samples, 'decoded_sample_rate': PCM_RATE,
        'sound_facts_qualified': False, 'phrase_boundaries_verified': False, 'lyrics_verified': False}
    return result, observation


def _verify_unchanged(file, before, timeout=60):
    after = bounded_source_identity(file, timeout)
    if any(after[key] != before[key] for key in ('sha256', 'bytes', 'mtime_ns')):
        raise ValueError('music_packs_recording_changed_during_check')
    return after


def probe_audio(file, expected_sha256=None):
    """Compatible public identity API, now using the actual decoded sample clock."""
    file = Path(file)
    before = bounded_source_identity(file)
    if expected_sha256 and expected_sha256 != before['sha256']:
        raise ValueError('music_packs_recording_sha_changed')
    identity, _ = _probe_and_decode(file, before, _decoder_identity())
    _verify_unchanged(file, before)
    return identity


def technical_observation(file, duration):
    """Compatibility wrapper; library builds use the combined check instead."""
    try:
        before = bounded_source_identity(file)
        _, observation = _probe_and_decode(Path(file), before, _decoder_identity())
        _verify_unchanged(file, before)
        return observation
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        return {'kind': 'technical_observation_gap', 'error': str(error), 'sound_facts_qualified': False}


@contextmanager
def _identity_lock(cache, timeout):
    """Kernel locks serialize writers and release automatically after a crash.

    Keep the sidecar file: unlinking it can give concurrent POSIX writers
    separate inodes and break mutual exclusion.
    """
    lock = cache.with_suffix('.lock')
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    stream = lock.open('a+b')
    if lock.stat().st_size == 0:
        stream.write(b'\0')
        stream.flush()
    if os.name == 'nt':
        import msvcrt
        def change_lock(acquire):
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK if acquire else msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        def change_lock(acquire):
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB if acquire else fcntl.LOCK_UN)
    acquired = False
    try:
        while not acquired:
            try:
                change_lock(True)
                acquired = True
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError('music_packs_technical_cache_lock_timeout')
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        try:
            if acquired:
                change_lock(False)
        finally:
            stream.close()


def cached_recording_checks(file, claimed, cache_directory=None, *, source_identity=None,
                            hash_timeout=60, probe_timeout=30, decode_timeout=180,
                            cache_lock_timeout=240, compatible_processor_sha256s=()):
    """Rehash source before/after; only reuse this decoder/processor's evidence."""
    file = Path(file)
    before = source_identity or bounded_source_identity(file, hash_timeout)
    sha = before['sha256']
    if claimed and claimed != sha:
        raise ValueError('music_packs_recording_sha_changed')
    revision = technical_processor_sha256()
    runtime = _decoder_identity()
    cache = Path(cache_directory) / (sha + '.json') if cache_directory else None

    def check_locked():
        if cache and cache.is_file():
            wrapper = read_json(cache)
            payload = wrapper.get('payload', {})
            checksum = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            if (wrapper.get('payload_sha256') != checksum or payload.get('source_sha256') != sha):
                raise ValueError('music_packs_technical_cache_changed')
            original_processor = payload.get('processor_sha256')
            if (original_processor in (revision, *compatible_processor_sha256s)
                    and payload.get('cache_schema_version') == CACHE_SCHEMA_VERSION
                    and payload.get('decoder_runtime') == runtime):
                identity = payload['identity']
                observation = payload['observation']
                if (identity.get('sha256') != sha or identity.get('full_decode', {}).get('exit_code') != 0
                        or observation.get('input_sha256') != sha
                        or identity.get('duration_samples') != observation.get('decoded_samples')
                        or identity.get('timeline_sample_rate_hz') != PCM_RATE
                        or observation.get('decoded_sample_rate') != PCM_RATE
                        or observation.get('kind') != 'decoded_pcm_rms'
                        or any(observation.get(name) is not False for name in
                            ('sound_facts_qualified', 'phrase_boundaries_verified', 'lyrics_verified'))
                        or identity.get('duration_samples', 0) <= 0
                        or identity.get('duration_seconds') != identity['duration_samples'] / PCM_RATE
                        or len(observation.get('rms_dbfs', [])) != math.ceil(identity['duration_samples'] / PCM_RATE)
                        or any(not math.isfinite(value) for value in observation.get('rms_dbfs', []))):
                    raise ValueError('music_packs_technical_cache_changed')
                _verify_unchanged(file, before, hash_timeout)
                return {**identity, **before, 'technical_cache_provenance': {
                    'evidence_processor_sha256': original_processor,
                    'validation_processor_sha256': revision,
                    'compatible_revision_explicitly_allowed': original_processor != revision}}, observation, True
        identity, observation = _probe_and_decode(file, before, runtime, probe_timeout, decode_timeout)
        _verify_unchanged(file, before, hash_timeout)
        identity = {**identity, 'technical_cache_provenance': {
            'evidence_processor_sha256': revision, 'validation_processor_sha256': revision,
            'compatible_revision_explicitly_allowed': False}}
        if cache:
            payload = {'source_sha256': sha, 'processor_sha256': revision,
                'cache_schema_version': CACHE_SCHEMA_VERSION, 'decoder_runtime': runtime,
                'identity': identity, 'observation': observation}
            write_json(cache, {'payload': payload,
                'payload_sha256': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()},
                require_atomic=True)
        return identity, observation, False

    if cache:
        with _identity_lock(cache, cache_lock_timeout):
            return check_locked()
    return check_locked()


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '_hash_source':
        raise SystemExit('internal hash reader requires an explicit source path')
    try:
        print(json.dumps(_source_identity(sys.argv[2])))
    except (OSError, ValueError) as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        raise SystemExit(1)
