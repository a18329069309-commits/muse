"""An opt-in cache for ephemeral renderer PCM, never for published/evidence media.

The caller consumes PCM bytes over stdout. No permanent reader binds the cache
pathname. The OS byte lock is held while reading/evicting/committing owned files;
it is never deleted or reclaimed using PID-based pathname takeover.
"""
import array
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

REVISION = 'bounded-render-decode-cache-v1'
MAX_BYTES = 1073741824
MIN_FREE = 2147483648
DECODE_ARGS = ['-v', 'error', '-i', '<source>', '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1']
ROOT_FILES = {'cache-owner.json', 'index.json', 'cache.lock', 'entries'}


class DecodeFailure(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packed(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')


def file_sha(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def checked_path(file):
    file = Path(file)
    if not file.is_absolute() or str(file).startswith(('\\\\', '//')):
        raise ValueError('render_decode_cache_local_absolute_path_required')
    # lstat before resolve: resolving first would hide junction/symlink ownership.
    for part in [*reversed(file.parents), file]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024):
            raise ValueError('render_decode_cache_reparse_point_refused')
    return file


def windows_drive_type(file):
    """Classify the actual mounted volume; mapped drive letters are not local."""
    if os.name != 'nt':
        return None
    import ctypes
    get_drive_type = ctypes.WinDLL('kernel32', use_last_error=True).GetDriveTypeW
    get_drive_type.argtypes = [ctypes.c_wchar_p]
    get_drive_type.restype = ctypes.c_uint
    return int(get_drive_type(str(Path(file).anchor)))


def validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) - {'revision', 'root', 'max_bytes', 'min_free_bytes'}:
        raise ValueError('render_decode_cache_explicit_policy_required')
    maximum, minimum = policy.get('max_bytes', MAX_BYTES), policy.get('min_free_bytes', MIN_FREE)
    if policy.get('revision') != REVISION or type(maximum) is not int or not 4096 <= maximum <= MAX_BYTES or type(minimum) is not int or minimum < MIN_FREE:
        raise ValueError('render_decode_cache_capacity_policy_invalid')
    root = checked_path(policy.get('root', ''))
    if root == root.parent:
        raise ValueError('render_decode_cache_drive_root_refused')
    if os.name == 'nt' and windows_drive_type(root) != 3:  # DRIVE_FIXED
        raise ValueError('render_decode_cache_fixed_local_drive_required')
    return root, maximum, minimum


@contextlib.contextmanager
def exclusive_lock(file, timeout=2):
    checked_path(file)
    fd = os.open(file, os.O_CREAT | os.O_RDWR, 0o600)
    stream = os.fdopen(fd, 'r+b', buffering=0)
    acquired = False
    try:
        deadline = time.monotonic() + timeout
        while True:
            stream.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (OSError, BlockingIOError):
                if time.monotonic() >= deadline:
                    raise ValueError('render_decode_cache_active_lease_bypass')
                time.sleep(.02)
        yield
    finally:
        if acquired:
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def setup_root(root):
    checked_path(root)
    root.mkdir(parents=True, exist_ok=True)
    checked_path(root)
    if not root.is_dir() or set(p.name for p in root.iterdir()) - ROOT_FILES:
        raise ValueError('render_decode_cache_unowned_directory_refused')
    owner = {'kind': 'owned_ephemeral_renderer_pcm_cache', 'revision': REVISION, 'root': str(root.absolute()), 'evidence_or_delivery_storage': False}
    file = root / 'cache-owner.json'
    if not file.exists():
        try:
            with file.open('xb') as stream:
                stream.write(packed(owner))
        except FileExistsError:
            pass
    checked_path(file)
    if file.read_bytes() != packed(owner):
        raise ValueError('render_decode_cache_owner_changed')
    (root / 'entries').mkdir(exist_ok=True)
    checked_path(root / 'entries')


def read_index(root):
    index_file = checked_path(root / 'index.json')
    if not index_file.exists():
        if any((root / 'entries').iterdir()):
            raise ValueError('render_decode_cache_unindexed_files_require_reconciliation')
        return {}
    wrapper = json.loads(index_file.read_text('utf-8'))
    payload = wrapper.get('payload', {})
    if wrapper.get('sha256') != digest(packed(payload)) or payload.get('revision') != REVISION or not isinstance(payload.get('entries'), dict):
        raise ValueError('render_decode_cache_index_identity_changed')
    rows = payload['entries']
    expected = set()
    for key, row in rows.items():
        if len(key) != 64 or any(c not in 'abcdef0123456789' for c in key) or row.get('key') != key:
            raise ValueError('render_decode_cache_entry_identity_changed')
        expected.update({key + '.pcm', key + '.json'})
        for suffix in ('.pcm', '.json'):
            checked_path(root / 'entries' / (key + suffix))
    if set(p.name for p in (root / 'entries').iterdir()) != expected:
        raise ValueError('render_decode_cache_unindexed_files_require_reconciliation')
    return rows


def index_bytes(rows):
    payload = {'revision': REVISION, 'entries': rows}
    return packed({'payload': payload, 'sha256': digest(packed(payload))})


def write_index(root, rows):
    # Local explicit D cache only. S is never used here.
    temporary = root / 'index.pending'
    if temporary.exists():
        raise ValueError('render_decode_cache_partial_commit_requires_reconciliation')
    with temporary.open('xb') as stream:
        stream.write(index_bytes(rows))
    os.replace(temporary, root / 'index.json')


def read_entry(root, row):
    meta_file = checked_path(root / 'entries' / (row['key'] + '.json'))
    pcm_file = checked_path(root / 'entries' / (row['key'] + '.pcm'))
    metadata = meta_file.read_bytes()
    if digest(metadata) != row.get('metadata_sha256'):
        raise ValueError('render_decode_cache_metadata_sha_changed')
    meta = json.loads(metadata)
    if digest(packed(meta.get('identity', {}))) != row['key'] or meta.get('payload_sha256') != row.get('payload_sha256') or meta.get('payload_bytes') != row.get('payload_bytes'):
        raise ValueError('render_decode_cache_entry_identity_changed')
    data = pcm_file.read_bytes()
    if len(data) != row['payload_bytes'] or digest(data) != row['payload_sha256'] or len(data) != meta.get('decoded_samples', -1) * 8:
        raise ValueError('render_decode_cache_payload_sha_or_clock_changed')
    validate_pcm(data)
    return data, meta


def validate_pcm(data):
    if not data or len(data) % 8:
        raise DecodeFailure('renderer_decoded_audio_invalid_sample_length')
    samples = array.array('f')
    samples.frombytes(data)
    if sys.byteorder != 'little':
        samples.byteswap()
    if any(not math.isfinite(v) for v in samples):
        raise DecodeFailure('renderer_audio_non_finite_samples')


def cache_total(root):
    # Only these exact owned entries/files, no recursive drive/library traversal.
    return sum(p.stat().st_size for p in root.iterdir() if p.is_file()) + sum(p.stat().st_size for p in (root / 'entries').iterdir())


def decode_request(request, *, decode=None, free_bytes=None, lock_timeout=2):
    root, maximum, minimum = validate_policy(request.get('policy'))
    source = Path(request.get('source', {}).get('path', ''))
    claimed = request.get('source', {}).get('sha256')
    if not source.is_absolute() or not source.is_file() or len(claimed or '') != 64:
        raise ValueError('render_decode_cache_source_binding_required')
    if root == source or root in source.parents:
        raise ValueError('render_decode_cache_source_inside_cache_refused')
    before = file_sha(source)
    if before != claimed:
        raise ValueError('render_decode_cache_source_sha_changed')
    ffmpeg = shutil.which(request.get('ffmpeg_command', 'ffmpeg'))
    if not ffmpeg:
        raise ValueError('render_decode_cache_ffmpeg_runtime_unavailable')
    ffmpeg = str(Path(ffmpeg).absolute())
    runtime_sha = file_sha(ffmpeg)
    version = subprocess.run([ffmpeg, '-version'], check=True, capture_output=True, timeout=20).stdout.decode('utf-8', errors='replace')
    identity = {'source_sha256': before, 'source_decode_scope': 'entire_first_audio_stream', 'decoder': {'path': ffmpeg, 'sha256': runtime_sha, 'version': version},
                'arguments': DECODE_ARGS, 'sample_rate_hz': 48000, 'channels': 2, 'sample_format': 'f32le',
                'cache_revision': REVISION, 'cache_processor_sha256': file_sha(__file__)}
    key = digest(packed(identity))
    info = {'revision': REVISION, 'key': key, 'identity': identity, 'source': {'path': str(source), 'sha256': before},
            'qualification_granted': False, 'cache_cap_bytes': maximum, 'minimum_free_bytes': minimum, 'evicted_entries': [], 'original_or_evidence_files_deleted': 0}
    def available():
        parent = root
        while not parent.exists():
            parent = parent.parent
        return shutil.disk_usage(parent).free
    free = free_bytes or available
    if free() < minimum + 4096:
        # No cache directory/owner/index writes on initial low headroom. The
        # original renderer can still consume an already decoded in-memory PCM.
        data = decode([ffmpeg, *[a if a != '<source>' else str(source) for a in DECODE_ARGS]]) if decode is not None else None
        if data is None:
            completed = subprocess.run([ffmpeg, *[a if a != '<source>' else str(source) for a in DECODE_ARGS]], capture_output=True, timeout=600)
            if completed.returncode:
                raise DecodeFailure('renderer_ffmpeg_decode_failed')
            data = completed.stdout
        validate_pcm(data)
        if file_sha(source) != before or file_sha(ffmpeg) != runtime_sha:
            raise DecodeFailure('renderer_source_or_decoder_changed_during_decode')
        return data, {**info, 'status': 'cache_bypass', 'cache_gap': 'render_decode_cache_low_free_space',
                      'decoded_samples': len(data) // 8, 'source_range_seconds': [0, len(data) / 8 / 48000],
                      'payload_sha256': digest(data), 'payload_bytes': len(data), 'actual_decode_calls': 1}
    setup_root(root)
    try:
        with exclusive_lock(root / 'cache.lock', lock_timeout):
            rows = read_index(root)
            if key in rows:
                data, meta = read_entry(root, rows[key])
                if meta['identity'] != identity:
                    raise ValueError('render_decode_cache_entry_identity_changed')
                if file_sha(source) != before or file_sha(ffmpeg) != runtime_sha:
                    raise ValueError('render_decode_cache_input_changed_during_read')
                # Read hit is useful below the write headroom; no metadata touch.
                if free() >= minimum + len(index_bytes(rows)):
                    rows[key]['last_used_ns'] = time.time_ns()
                    write_index(root, rows)
                return data, {**info, 'status': 'cache_hit', 'decoded_samples': meta['decoded_samples'],
                              'source_range_seconds': [0, meta['decoded_samples'] / 48000], 'payload_sha256': meta['payload_sha256'],
                              'payload_bytes': len(data), 'actual_decode_calls': 0, 'cache_total_bytes': cache_total(root)}
    except ValueError as error:
        # An owned active lock is bypassed, never deleted; the cache cannot delay
        # a correct old renderer. Identity/tamper errors instead reach the caller.
        if str(error) != 'render_decode_cache_active_lease_bypass':
            raise
        lock_gap = str(error)
    else:
        lock_gap = None
    args = [a if a != '<source>' else str(source) for a in DECODE_ARGS]
    if decode is None:
        completed = subprocess.run([ffmpeg, *args], capture_output=True, timeout=600)
        if completed.returncode:
            raise DecodeFailure('renderer_ffmpeg_decode_failed')
        data = completed.stdout
    else:
        data = decode([ffmpeg, *args])
    validate_pcm(data)
    if file_sha(source) != before or file_sha(ffmpeg) != runtime_sha:
        raise DecodeFailure('renderer_source_or_decoder_changed_during_decode')
    samples = len(data) // 8
    info.update(decoded_samples=samples, source_range_seconds=[0, samples / 48000], payload_sha256=digest(data), payload_bytes=len(data), actual_decode_calls=1)
    metadata = {**info, 'decoded_samples': samples}
    metadata_bytes = packed(metadata)
    row = {'key': key, 'payload_bytes': len(data), 'payload_sha256': info['payload_sha256'], 'metadata_sha256': digest(metadata_bytes), 'last_used_ns': time.time_ns()}
    if lock_gap:
        return data, {**info, 'status': 'cache_bypass', 'cache_gap': lock_gap}
    if len(data) + len(metadata_bytes) + len(index_bytes({key: row})) + 2048 > maximum:
        return data, {**info, 'status': 'cache_bypass', 'cache_gap': 'render_decode_cache_single_item_exceeds_cap'}
    if free() < minimum + len(data) + len(metadata_bytes) + len(index_bytes({key: row})):
        return data, {**info, 'status': 'cache_bypass', 'cache_gap': 'render_decode_cache_low_free_space'}
    try:
        with exclusive_lock(root / 'cache.lock', lock_timeout):
            checked_path(root)
            rows = read_index(root)
            if key in rows:
                old, _ = read_entry(root, rows[key])
                if old != data:
                    raise ValueError('render_decode_cache_concurrent_decode_disagrees')
                return data, {**info, 'status': 'cache_concurrent_hit', 'cache_total_bytes': cache_total(root)}
            if free() < minimum + len(data) + len(metadata_bytes) + len(index_bytes({**rows, key: row})):
                return data, {**info, 'status': 'cache_bypass', 'cache_gap': 'render_decode_cache_low_free_space'}
            while rows and cache_total(root) + len(data) + len(metadata_bytes) + len(index_bytes({**rows, key: row})) > maximum:
                evict = min(rows, key=lambda k: rows[k]['last_used_ns'])
                _, old_meta = read_entry(root, rows[evict])
                # Only verified exact owned hash paths; no recursive remove.
                for suffix in ('.pcm', '.json'):
                    checked_path(root / 'entries' / (evict + suffix)).unlink()
                info['evicted_entries'].append({'key': evict, 'payload_sha256': old_meta['payload_sha256'], 'payload_bytes': old_meta['payload_bytes']})
                del rows[evict]
                write_index(root, rows)
            if cache_total(root) + len(data) + len(metadata_bytes) + len(index_bytes({**rows, key: row})) > maximum:
                return data, {**info, 'status': 'cache_bypass', 'cache_gap': 'render_decode_cache_metadata_capacity_gap'}
            payload_file = checked_path(root / 'entries' / (key + '.pcm'))
            meta_file = checked_path(root / 'entries' / (key + '.json'))
            with payload_file.open('xb') as stream:
                stream.write(data)
            with meta_file.open('xb') as stream:
                stream.write(metadata_bytes)
            rows[key] = row
            write_index(root, rows)
            if cache_total(root) > maximum or free() < minimum:
                raise ValueError('render_decode_cache_postcommit_capacity_requires_reconciliation')
            return data, {**info, 'status': 'cache_stored', 'cache_total_bytes': cache_total(root)}
    except (OSError, ValueError) as error:
        return data, {**info, 'status': 'cache_bypass', 'cache_gap': str(error)}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('render_decode_cache_request_too_large')
        request = json.loads(raw.decode('utf-8'))
        data, receipt = decode_request(request)
        sys.stderr.write(json.dumps(receipt, ensure_ascii=False) + '\n')
        sys.stdout.buffer.write(data)
    except Exception as error:
        sys.stderr.write(json.dumps({'status': 'cache_error', 'cache_gap': str(error), 'legacy_decode_fallback_allowed': not isinstance(error, DecodeFailure), 'qualification_granted': False}) + '\n')
        sys.exit(2)
