"""A local, OS-owned GPU slot. Lock files persist; PID files never grant ownership.

GPU work executes in the holder's Python process. CPU work takes no slot. This
coordinates configured local writers, not arbitrary external CUDA processes.
"""
import argparse
import contextlib
import functools
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import sys
import threading
import time
import uuid

REVISION = 'local-gpu-single-slot-v1'
# Match the JS helper. Multiple checkouts sharing a GPU must configure the same
# absolute SDR_GPU_SLOT_ROOT; the hash-bound config still has to match it.
SHARED_ROOT = os.environ.get('SDR_GPU_SLOT_ROOT',
                             str(Path(__file__).resolve().parents[1] / '.muse' / 'gpu-execution-slots'))
_thread_lock = threading.RLock()
_active = None


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def packed(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def checked_path(value):
    file = Path(value)
    if not file.is_absolute() or str(file).startswith(('\\\\', '//')) or file == file.parent:
        raise ValueError('gpu_slot_local_absolute_directory_required')
    for part in [*reversed(file.parents), file]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 1024:
            raise ValueError('gpu_slot_reparse_point_refused')
    return file


def fixed_volume(root):
    if os.name == 'nt':
        import ctypes
        function = ctypes.WinDLL('kernel32', use_last_error=True).GetDriveTypeW
        function.argtypes, function.restype = [ctypes.c_wchar_p], ctypes.c_uint
        if int(function(str(root.anchor))) != 3:
            raise ValueError('gpu_slot_fixed_local_volume_required')


def load_binding(binding):
    if binding is None:
        binding = slot_binding_from_environment()
    if not isinstance(binding, dict) or set(binding) != {'path', 'sha256'} or \
            not isinstance(binding['sha256'], str) or len(binding['sha256']) != 64:
        raise ValueError('gpu_slot_explicit_config_binding_required')
    file = checked_path(binding['path'])
    if digest(file) != binding['sha256']:
        raise ValueError('gpu_slot_config_sha_changed')
    config = json.loads(file.read_text('utf-8-sig'))
    if set(config) != {'revision', 'root', 'device', 'maximum_concurrency', 'acquire_timeout_ms'} or \
            config['revision'] != REVISION or config['device'] != 'cuda:0' or \
            type(config['maximum_concurrency']) is not int or config['maximum_concurrency'] != 1 or \
            type(config['acquire_timeout_ms']) is not int or not 1 <= config['acquire_timeout_ms'] <= 3600000:
        raise ValueError('gpu_slot_config_invalid')
    root = checked_path(config['root'])
    shared_root = checked_path(SHARED_ROOT)
    if os.path.normcase(os.path.abspath(root)) != os.path.normcase(os.path.abspath(shared_root)):
        raise ValueError('gpu_slot_shared_root_required')
    fixed_volume(root)
    return config, root


def slot_binding_from_environment():
    file, sha = os.environ.get('SDR_GPU_SLOT_CONFIG'), os.environ.get('SDR_GPU_SLOT_SHA256')
    return {'path': file, 'sha256': sha} if file is not None or sha is not None else None


def canonical_device(device):
    if device == 'cpu':
        return device
    if device not in ('cuda', 'cuda:0'):
        raise ValueError('gpu_slot_only_explicit_gpu_zero_supported')
    # Logical cuda:0 must denote the single physical GPU zero. Do not permit a
    # remapped device, UUID, multiple GPUs, auto placement, or a hidden GPU.
    if os.environ.get('CUDA_VISIBLE_DEVICES', '0') != '0':
        raise ValueError('gpu_slot_physical_gpu_identity_ambiguous')
    return 'cuda:0'


def slot_binding_from_args(args):
    path, sha = getattr(args, 'gpu_slot_config', None), getattr(args, 'gpu_slot_sha256', None)
    if path is None and sha is None:
        return slot_binding_from_environment()
    return {'path': str(path), 'sha256': sha}


def add_slot_arguments(parser):
    parser.add_argument('--gpu-slot-config')
    parser.add_argument('--gpu-slot-sha256')


def slot_binding_from_cli():
    parser = argparse.ArgumentParser(add_help=False)
    add_slot_arguments(parser)
    args, _ = parser.parse_known_args()
    return slot_binding_from_args(args)


def require_gpu_slot(device):
    if canonical_device(device) == 'cpu':
        return
    if _active is None or _active['pid'] != os.getpid() or _active['thread'] != threading.get_ident():
        raise ValueError('gpu_writer_requires_active_single_slot')


def current_gpu_slot_record():
    return dict(_active['record']) if _active is not None else None


def gpu_slot_guard(device, binding):
    """Guard a whole workload, including imports/load/forward, in this process."""
    def decorate(function):
        @functools.wraps(function)
        def guarded(*args, **kwargs):
            target = device(*args, **kwargs)
            if canonical_device(target) == 'cpu':
                return function(*args, **kwargs)
            with gpu_slot_scope(target, binding(*args, **kwargs), function.__module__ + '.' + function.__name__):
                return function(*args, **kwargs)
        return guarded
    return decorate


@contextlib.contextmanager
def gpu_slot_scope(device, binding, owner):
    global _active
    if canonical_device(device) == 'cpu':
        yield None
        return
    binding = binding if binding is not None else slot_binding_from_environment()
    config, root = load_binding(binding)
    os.environ.setdefault('CUDA_VISIBLE_DEVICES', '0')
    timeout = config['acquire_timeout_ms'] / 1000
    begun = time.monotonic()
    if not _thread_lock.acquire(timeout=timeout):
        raise ValueError('gpu_slot_busy_timeout')
    stream, acquired, record = None, False, None
    try:
        if _active is not None:
            if _active['pid'] != os.getpid() or _active['binding'] != binding or \
                    _active['thread'] != threading.get_ident():
                raise ValueError('gpu_slot_nested_identity_changed')
            yield _active['record']
            return
        if _retained:
            raise ValueError('gpu_slot_live_model_retained_until_process_exit')
        root.mkdir(parents=True, exist_ok=True)
        checked_path(root)
        allowed = {'gpu-0.lock', 'slot-owner.json', 'slot-state.json', 'slot-events.jsonl', 'slot-state.pending'}
        if not root.is_dir() or set(p.name for p in root.iterdir()) - allowed:
            raise ValueError('gpu_slot_unowned_directory_refused')
        for leaf in allowed:
            checked_path(root / leaf)
        stream = os.fdopen(os.open(root / 'gpu-0.lock', os.O_CREAT | os.O_RDWR, 0o600), 'r+b', buffering=0)
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
            except OSError as error:
                if error.errno not in (11, 13, 35, 36):
                    raise
                if time.monotonic() - begun >= timeout:
                    raise ValueError('gpu_slot_busy_timeout') from error
                time.sleep(.02)
        marker = {'revision': REVISION, 'root': str(root.absolute()), 'device': 'cuda:0', 'maximum_concurrency': 1}
        owner_file = root / 'slot-owner.json'
        if owner_file.exists():
            if owner_file.read_bytes() != packed(marker):
                raise ValueError('gpu_slot_owner_changed')
        else:
            with owner_file.open('xb') as output:
                output.write(packed(marker))
        state_file = root / 'slot-state.json'
        previous = json.loads(state_file.read_text('utf-8')) if state_file.exists() else None
        record = {'revision': REVISION, 'token': uuid.uuid4().hex, 'pid': os.getpid(), 'owner': owner,
                  'config': binding, 'device': 'cuda:0', 'maximum_concurrency': 1,
                  'started_at_unix_ns': time.time_ns(), 'status': 'held',
                  'recovered_unreleased_metadata': bool(previous and previous.get('status') in ('held', 'held_until_process_exit')),
                  'previous_token': previous.get('token') if previous else None,
                  'ownership_basis': 'current_process_os_byte_lock_not_pid_or_pathname',
                  'implementation': {'path': str(Path(__file__).resolve()), 'sha256': digest(__file__)},
                  'qualification_granted': False}
        _write_state(root, record)
        _active = {'pid': os.getpid(), 'thread': threading.get_ident(), 'binding': binding, 'record': record}
        try:
            yield record
        finally:
            # Imported loaders can retain CUDA tensors; never release ownership
            # while those tensors are live. Hold the slot until process exit.
            torch = sys.modules.get('torch')
            live, cleanup_error = False, None
            try:
                if torch is not None and torch.cuda.is_initialized():
                    torch.cuda.synchronize(0)
                    torch.cuda.empty_cache()
                    live = torch.cuda.memory_allocated(0) > 0
            except BaseException as error:
                # Unknown pending CUDA work is never permission to release.
                live, cleanup_error = True, error
            if live:
                _retain_until_exit(stream)
                stream, acquired = None, False
            record = {**record, 'finished_at_unix_ns': time.time_ns(),
                      'status': 'held_until_process_exit' if live else 'released'}
            _active = None
            _write_state(root, record)
            if cleanup_error is not None:
                raise ValueError('gpu_slot_cuda_cleanup_failed_lock_retained') from cleanup_error
    finally:
        if stream is not None:
            if acquired:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            stream.close()
        _thread_lock.release()


_retained = []


def _retain_until_exit(stream):
    # An open OS lock, not a finalizer/PID assertion, remains owned to process
    # exit if a caller retains a live model. Subsequent GPU calls must not run.
    _retained.append(stream)


def _write_state(root, record):
    pending = root / 'slot-state.pending'
    with pending.open('wb') as output:
        output.write(packed(record))
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending, root / 'slot-state.json')
    with (root / 'slot-events.jsonl').open('ab') as output:
        output.write(packed(record))
        output.flush()
        os.fsync(output.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_slot_arguments(parser)
    parser.add_argument('--target', required=True)
    parser.add_argument('--target-sha256', required=True)
    parser.add_argument('--device', choices=['cuda', 'cuda:0'], default='cuda:0')
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('target_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    binding = slot_binding_from_args(args)
    config, root = load_binding(binding)
    canonical_device(args.device)
    target = checked_path(args.target)
    if digest(target) != args.target_sha256:
        raise ValueError('gpu_slot_target_sha_changed')
    if args.check_only:
        print(json.dumps({'status': 'gpu_slot_command_ready', 'config': binding, 'root': str(root),
                          'target_sha256': args.target_sha256, 'gpu_forwards': 0, 'account_calls': 0}))
        return
    target_args = args.target_args[1:] if args.target_args[:1] == ['--'] else args.target_args
    with gpu_slot_scope(args.device, binding, str(target)):
        sys.path.insert(0, str(target.parent))
        sys.argv = [str(target), *target_args]
        # Use the same module instance for imports made by the runpy target.
        sys.modules['gpu_single_slot'] = sys.modules[__name__]
        runpy.run_path(str(target), run_name='__main__')


if __name__ == '__main__':
    main()
