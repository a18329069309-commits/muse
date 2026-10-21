"""Launch one suspended Windows child in a private kill-on-close Job Object.

The job handle is never inherited. Killing this wrapper closes the last handle
and terminates only this task's descendants, even if they detach their stdio.
No process enumeration, image-name matching, or global termination is used.
"""
import ctypes
from ctypes import wintypes as w
import os
import subprocess
import sys
import time


def main(argv):
    if os.name != 'nt' or not argv or argv[0] != '--' or len(argv) < 2:
        raise ValueError('owned_process_tree_windows_command_required')
    import msvcrt
    absolute = os.environ.get('SDR_EPISODE_DEADLINE_AT_MS')
    expired = lambda: absolute is not None and int(absolute) <= int(time.time() * 1000)
    if expired():
        return 124
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p

    class BasicLimits(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', w.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', w.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount', 'WriteOperationCount',
            'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', IoCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    class StartupInfo(ctypes.Structure):
        _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR), ('lpTitle', w.LPWSTR),
                    ('dwX', w.DWORD), ('dwY', w.DWORD), ('dwXSize', w.DWORD), ('dwYSize', w.DWORD),
                    ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD),
                    ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD),
                    ('lpReserved2', pointer), ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE), ('hStdError', w.HANDLE)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [('hProcess', w.HANDLE), ('hThread', w.HANDLE), ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD)]

    signatures = {
        'CreateJobObjectW': ([pointer, w.LPCWSTR], w.HANDLE),
        'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, pointer, w.DWORD], w.BOOL),
        'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
        'CreateProcessW': ([w.LPCWSTR, w.LPWSTR, pointer, pointer, w.BOOL, w.DWORD, pointer,
                            w.LPCWSTR, ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)], w.BOOL),
        'ResumeThread': ([w.HANDLE], w.DWORD),
        'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
        'GetExitCodeProcess': ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
        'TerminateProcess': ([w.HANDLE, w.UINT], w.BOOL),
        'CloseHandle': ([w.HANDLE], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        getattr(kernel, name).argtypes, getattr(kernel, name).restype = args, result

    def checked(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    job = checked(kernel.CreateJobObjectW(None, None))
    process = ProcessInfo()
    assigned = False
    try:
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        startup = StartupInfo()
        startup.cb, startup.dwFlags, startup.wShowWindow = ctypes.sizeof(startup), 0x101, 0  # STARTF_USESTDHANDLES | USESHOWWINDOW
        handles = [msvcrt.get_osfhandle(stream.fileno()) for stream in (sys.stdin, sys.stdout, sys.stderr)]
        for handle in handles:
            os.set_handle_inheritable(handle, True)
        startup.hStdInput, startup.hStdOutput, startup.hStdError = handles
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv[1:]))
        # A suspended child cannot launch another process before assignment.
        checked(kernel.CreateProcessW(None, command, None, None, True, 0x08000004, None, None,
                                      ctypes.byref(startup), ctypes.byref(process)))
        checked(kernel.AssignProcessToJobObject(job, process.hProcess))
        assigned = True
        if expired():
            return 124
        if kernel.ResumeThread(process.hThread) == 0xffffffff:
            raise ctypes.WinError(ctypes.get_last_error())
        wait_ms = 0xffffffff if absolute is None else max(0, min(0xfffffffe, int(absolute) - int(time.time() * 1000)))
        outcome = kernel.WaitForSingleObject(process.hProcess, wait_ms)
        if outcome == 258:  # WAIT_TIMEOUT; closing only this private job kills its tree.
            return 124
        if outcome != 0:
            raise ctypes.WinError(ctypes.get_last_error())
        exit_code = w.DWORD()
        checked(kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)))
        return exit_code.value
    finally:
        # Assignment failure is fail-closed while the target is still suspended.
        if process.hProcess and not assigned:
            kernel.TerminateProcess(process.hProcess, 126)
        kernel.CloseHandle(job)
        if process.hThread:
            kernel.CloseHandle(process.hThread)
        if process.hProcess:
            kernel.CloseHandle(process.hProcess)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print('owned_process_tree_failed: ' + str(error), file=sys.stderr)
        sys.exit(126)
