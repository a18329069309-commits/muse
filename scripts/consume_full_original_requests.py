"""Single-writer consumer for immutable full-recording manifests.

Tasks are admitted by the existing full-acquisition helper, not by this runner.
No new film, source-identification upload or Ready promotion is performed.
An unknown child outcome is reconciled from its receipt and never blindly sent
again. Open manifests can be appended via a bound pointer while the runner waits.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

_spec=importlib.util.spec_from_file_location('discovery',Path(__file__).with_name('run_original_discovery.py'))
d=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(d)


def admit_task(task, python, helper):
    if task.get('requested_extent')!='full_recording' or not task.get('task_key'):
        raise ValueError('full_recording_task_required')
    request=d.checked(task['input'])
    if request.get('requested_extent')!='full_recording':
        raise ValueError('full_recording_input_extent_mismatch')
    argv=task['command']
    if not isinstance(argv,list) or len(argv)<6 or not all(isinstance(v,str) for v in argv):
        raise ValueError('structured_full_acquisition_command_required')
    command=argv[1:]
    if command and command[0]=='-B':command=command[1:]
    if len(command)!=5 or Path(argv[0]).resolve()!=Path(python).resolve() or Path(command[0]).resolve()!=Path(helper).resolve():
        raise ValueError('only_bound_full_acquisition_helper_allowed')
    if command[1]!='--input' or command[3]!='--out' \
            or Path(command[2]).resolve()!=Path(task['input']['path']).resolve() \
            or Path(command[4]).resolve()!=Path(task['output_dir']).resolve():
        raise ValueError('full_acquisition_command_binding_mismatch')
    return request


def existing_result(task):
    file=Path(task['output_dir'])/'full-recording-state.json'
    if not file.is_file():return None
    state=d.read(file)
    if state.get('task_key')!=task['task_key'] or state.get('input',{}).get('sha256')!=task['input']['sha256']:
        raise ValueError('full_helper_state_binding_mismatch')
    if not state.get('result'):return None
    result=d.checked(state['result'])
    return {'status':result.get('status','result_status_missing'),'result':state['result'],
            'result_reconciled':True,'full_recording_acquired':result.get('full_recording_acquired') is True}


def process_task(task, states, python, helper, run=subprocess.run, timeout=360):
    admit_task(task,python,helper)
    key=task['task_key']; input_sha=task['input']['sha256']
    prior=states.execute('SELECT input_sha,status,payload FROM full_tasks WHERE task_key=?',(key,)).fetchone()
    if prior and prior[0]!=input_sha:
        raise ValueError('immutable_full_task_input_changed')
    if prior:
        payload=json.loads(prior[2])
        # An existing response is data to reconcile, never permission to repeat HTTP.
        if payload.get('result'):
            d.checked(payload['result'])
        elif existing_result(task):
            payload.update(existing_result(task))
            states.execute('UPDATE full_tasks SET status=?,payload=? WHERE task_key=?',
                           (payload['status'],json.dumps(payload,ensure_ascii=False),key));states.commit()
        return {**payload,'reused_without_new_process':True}
    recovered=existing_result(task)
    if recovered:
        payload={'task_key':key,'input':task['input'],'requested_extent':'full_recording',
                 **recovered,'automatic_replay_allowed':False,'Ready':False,'reused_without_new_process':True}
        states.execute('INSERT INTO full_tasks VALUES(?,?,?,?)',(key,input_sha,payload['status'],json.dumps(payload)));states.commit()
        return payload
    payload={'task_key':key,'input':task['input'],'requested_extent':'full_recording',
             'status':'running','started_at_utc':datetime.now(timezone.utc).isoformat(),
             'automatic_replay_allowed':False,'Ready':False}
    states.execute('INSERT INTO full_tasks VALUES(?,?,?,?)',(key,input_sha,'running',json.dumps(payload)));states.commit()
    try:
        child=run(task['command'],capture_output=True,text=True,encoding='utf-8',timeout=timeout,
                  env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        payload.update(status='child_returned',exit_code=child.returncode,
                       actual_acquisition_consumer_executed=True,
                       stdout_excerpt=child.stdout[-2000:],stderr_excerpt=child.stderr[-1000:])
    except subprocess.TimeoutExpired:
        payload.update(status='unknown_acquisition_outcome',actual_acquisition_consumer_executed=True)
    except OSError as error:
        payload.update(status='consumer_launch_gap',error_type=type(error).__name__)
    out=Path(task['output_dir'])
    receipt_name=task.get('result_filename','full-recording-acquisition-result.json')
    if Path(receipt_name).name!=receipt_name:raise ValueError('result_filename_must_be_basename')
    receipt=out/receipt_name
    recovered=existing_result(task)
    if recovered:
        payload.update(recovered)
    elif receipt.is_file():
        result=d.read(receipt);payload.update(status=result.get('status','result_status_missing'),
                                             result=d.bind(receipt),result_reconciled=True)
    else:
        payload['status']='unknown_acquisition_outcome' if payload.get('actual_acquisition_consumer_executed') else payload['status']
    payload['finished_at_utc']=datetime.now(timezone.utc).isoformat()
    states.execute('UPDATE full_tasks SET status=?,payload=? WHERE task_key=?',
                   (payload['status'],json.dumps(payload,ensure_ascii=False),key));states.commit()
    return payload


def run_queue(config,once=False):
    python=config['python'];helper=Path(__file__).with_name('acquire_full_original_recording.py')
    if config.get('helper'):
        if Path(config['helper']['path']).resolve()!=helper.resolve():raise ValueError('wrong_full_acquisition_helper')
        if d.digest(helper)!=config['helper']['sha256']:raise ValueError('full_acquisition_helper_changed')
    root=Path(config['state_root']);root.mkdir(parents=True,exist_ok=True)
    if (root/'rate-limit-stop.json').is_file():
        raise RuntimeError('full_acquisition_rate_limit_requires_explicit_resume')
    lock,token=d.lock(root)
    states=sqlite3.connect(root/'full-acquisition-consumer.sqlite')
    states.execute('CREATE TABLE IF NOT EXISTS full_tasks(task_key TEXT PRIMARY KEY,input_sha TEXT,status TEXT,payload TEXT)');states.commit()
    summary={'schema_version':1,'runner_pid':os.getpid(),'status':'running','Ready':False,
             'new_user_trials':0,'paid_calls':0,'private_uploads':0}
    try:
        while True:
            if (root/'stop-request.json').is_file():summary['status']='explicit_stop_saved';break
            if config.get('manifest_pointer'):
                pointer=d.read(config['manifest_pointer'])
                manifest=d.checked(pointer.get('manifest') or pointer['queue'])
            else:manifest=d.checked(config['manifest'])
            if manifest.get('requested_extent') not in (None,'full_recording'):
                raise ValueError('full_manifest_extent_mismatch')
            for task in manifest.get('tasks',[]):
                try:summary['last_result']=process_task(task,states,python,helper)
                except (ValueError,KeyError,OSError) as error:
                    summary['last_result']={'task_key':task.get('task_key'),'status':'task_admission_gap','reason':str(error),'Ready':False}
                if summary['last_result'].get('status')=='rate_limited_requires_explicit_resume':
                    d.save(root/'rate-limit-stop.json',{'task_key':task.get('task_key'),'explicit_resume_required':True})
                    summary['status']='rate_limited_requires_explicit_resume';break
            summary['unique_full_tasks']=states.execute('SELECT count(*) FROM full_tasks').fetchone()[0]
            summary['task_statuses']=dict(states.execute('SELECT status,count(*) FROM full_tasks GROUP BY status'))
            summary['full_source_gaps']=len(manifest.get('full_source_gaps',[]))
            if summary['status']=='rate_limited_requires_explicit_resume':break
            summary['status']='bounded_pass_finished' if once else 'open_queue_waiting_with_gaps'
            d.save(root/'run-status.json',summary)
            if once or manifest.get('closed') is True:break
            time.sleep(config.get('poll_seconds',15))
        d.save(root/'run-status.json',summary)
        return summary
    finally:
        states.close()
        if lock.is_file() and d.read(lock).get('token')==token:lock.unlink()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',type=Path,required=True);parser.add_argument('--once',action='store_true')
    args=parser.parse_args();print(json.dumps(run_queue(d.read(args.config),args.once),ensure_ascii=False))
