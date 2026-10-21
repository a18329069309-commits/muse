"""Thin handoff supervisor for the existing single-writer discovery runner.

Waits for the active writer instead of interrupting it. Each immutable config is
dispatched once; exhaustion retains gaps and waits for a new config pointer.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

spec=importlib.util.spec_from_file_location('discovery',Path(__file__).with_name('run_original_discovery.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)


def writer_active(cache):
    path=Path(cache)/'discovery.lock.json'
    if not path.is_file():return False
    owner=d.read(path)
    if not isinstance(owner.get('pid'),int):raise ValueError('discovery_writer_identity_unknown')
    return d.alive(owner['pid'])


def supervise(config,once=False):
    directory=Path(config['state_directory']);directory.mkdir(parents=True,exist_ok=True)
    lock,token=d.lock(directory)
    state_file=directory/'supervisor-state.json'
    state=d.read(state_file) if state_file.is_file() else {'schema_version':1,'dispatched_configs':{},'full_corpus_complete':False}
    state.update(pid=os.getpid(),new_user_trials=0,paid_calls=0,existing_workers_stopped=0)
    try:
        while True:
            if (directory/'stop-request.json').is_file():state['status']='explicit_stop_preserved';break
            pointer=d.read(config['config_pointer']);binding=pointer['config'];job=d.checked(binding)
            sha=binding['sha256']
            if writer_active(job['cache_root']):
                state['status']='waiting_existing_discovery_writer'
            elif (Path(job['state_root'])/'rate-limit-stop.json').is_file():
                state['status']='respecting_fingerprint_rate_limit_stop'
            elif sha in state['dispatched_configs']:
                state['status']='available_queue_finished_with_gaps_waiting_new_config'
            else:
                # Persist before child launch. Unknown launch outcomes do not trigger another dispatch.
                state['status']='dispatching_new_verified_config'
                state['dispatched_configs'][sha]={'config':binding,'status':'submitted_outcome_not_yet_known'}
                d.save(state_file,state)
                argv=[job['python'],'-B',str(Path(__file__).with_name('run_original_discovery.py')),
                      '--config',binding['path']]
                with (directory/(sha[:16]+'.stdout.log')).open('x',encoding='utf-8') as stdout, \
                     (directory/(sha[:16]+'.stderr.log')).open('x',encoding='utf-8') as stderr:
                    child=subprocess.run(argv,stdout=stdout,stderr=stderr,
                        env={**os.environ,'PYTHONIOENCODING':'utf-8'})
                state['dispatched_configs'][sha].update(exit_code=child.returncode,
                    status='returned_gaps_retained' if child.returncode==0 else 'executor_failed_needs_targeted_recovery')
                state['status']='available_queue_finished_with_gaps'
            d.save(state_file,state)
            if once:break
            time.sleep(config.get('poll_seconds',30))
        d.save(state_file,state);return state
    finally:
        if lock.is_file() and d.read(lock).get('token')==token:lock.unlink()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=Path,required=True);p.add_argument('--once',action='store_true')
    a=p.parse_args();print(json.dumps(supervise(d.read(a.config),a.once),ensure_ascii=True))
