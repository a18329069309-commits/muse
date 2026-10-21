"""Read-only, unique-unit preproduction audit; never signs corpus or sound readiness.

Running queues are sampled independently, so this is explicitly not a global
atomic snapshot. Preview events, research rows and actual recording files stay
separate. No models, network, playback or worker management are performed.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def bound(path):
    return {'path': str(Path(path).resolve()), 'sha256': digest(path)}


def checked(binding):
    if digest(binding['path']) != binding['sha256']:
        raise ValueError('audit_input_binding_changed')
    return read(binding['path'])


def sql_rows(path, table, columns):
    # Table and column names are fixed by this module, never interpolated user SQL.
    with sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True) as conn:
        conn.execute('BEGIN')
        result = conn.execute('SELECT '+columns+' FROM '+table).fetchall()
        conn.rollback()
        return result


def summarize_acquisitions(rows, verify_files=False):
    tuples = set(); files = {}; statuses = Counter(); gaps = []
    for key, status, raw in rows:
        if key in tuples:
            continue
        tuples.add(key); statuses[status] += 1
        payload = json.loads(raw) if isinstance(raw, str) else raw
        result_binding = payload.get('acquisition_result')
        if not result_binding:
            continue
        try:
            result = checked(result_binding)
            for recording in result.get('actual_recordings', []):
                source = recording['source']; sha = source['sha256']
                if not Path(source['path']).is_file():
                    raise ValueError('acquired_recording_missing')
                if verify_files and digest(source['path']) != sha:
                    raise ValueError('acquired_recording_changed')
                extent = recording.get('scope', result.get('independent_recording_scope', 'unknown'))
                prior = files.get(sha)
                if prior and prior['extent'] != extent:
                    raise ValueError('same_file_inconsistent_extent')
                files[sha] = {'source': source, 'extent': extent,
                              'fresh_sha_verified': verify_files}
        except (OSError, ValueError, KeyError) as error:
            gaps.append({'task_key': key, 'reason': str(error)})
    preview_count = sum('preview' in item['extent'] for item in files.values())
    # This reader does not approve new full-recording schemas or Ready assertions.
    return {'unique_task_keys': len(tuples), 'task_statuses': dict(statuses),
            'unique_independent_file_sha256': len(files), 'official_preview_files': preview_count,
            'other_recording_files_need_extent_specific_receipt': len(files)-preview_count,
            'fresh_recording_sha_verified': verify_files,
            'recording_gaps': gaps, 'file_inventory': list(files.values()),
            'full_recording_completion_signed_by_this_audit': False,
            'ready_packages_signed_by_this_audit': 0}


def summarize_candidate_rows(rows):
    unique = {}; malformed = []
    for identifier, status, raw in rows:
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
            if identifier in unique and unique[identifier] != (status, payload):
                raise ValueError('duplicate_candidate_conflicting_payload')
            unique[identifier] = (status, payload)
        except (ValueError, TypeError) as error:
            malformed.append({'candidate_id': identifier, 'reason': str(error)})
    values = [payload for _, payload in unique.values()]
    return {'unique_candidate_rows': len(unique),
            'statuses': dict(Counter(status for status, _ in unique.values())),
            'unique_work_ids': len({v['work_id'] for v in values if v.get('work_id')}),
            'unique_episode_versions': len({v['episode_id'] for v in values if v.get('episode_id')}),
            'unique_recording_sha256': len({v['recording']['sha256'] for v in values if v.get('recording', {}).get('sha256')}),
            'case_linkage_pending': sum(v.get('case_linkage_pending') is not False for v in values),
            'precise_occurrence_pending': sum(v.get('case_vs_fingerprint_clock_alignment') != 'verified' for v in values),
            'declared_ready_rows_not_qualification': sum(v.get('Ready') is True for v in values),
            'qualified_ready_packages_counted': 0, 'malformed_rows': malformed}


def audit(config):
    started = datetime.now(timezone.utc).isoformat()
    pointer = read(config['priority_pointer']); ledger = checked(pointer['coverage_ledger'])
    works = ledger['works']; all_count = sum(w['screenshot_episode_count'] for w in works)
    priority = sum(min(10, w['screenshot_episode_count']) for w in works)
    if len(works) != 115 or all_count != 8926 or priority != 1145:
        raise ValueError('complete_frozen_scope_required')
    slots = [s for w in works for s in w['slots']]
    if len(slots) != priority or len({s['target_id'] for s in slots}) != priority:
        raise ValueError('duplicate_or_missing_priority_slot')
    extant = sum(bool(s.get('primary_canonical_media')) and
                 Path(s['primary_canonical_media']['source_video']).is_file() for s in slots)
    policy = read(config['policy_path'])
    acquisitions = summarize_acquisitions(sql_rows(config['acquisition_db'], 'acquisitions',
                                                  'track_key,status,payload'), config.get('verify_recording_files', False))
    candidates = summarize_candidate_rows(sql_rows(config['candidate_db'], 'research_candidates',
                                                   'candidate_id,status,payload'))
    return {'schema_version': 1, 'kind': 'preproduction_unique_progress_audit',
            'captured_from_utc': started, 'captured_to_utc': datetime.now(timezone.utc).isoformat(),
            'source_snapshot_is_not_global_atomic': True,
            'scope': {'screenshot_works': len(works), 'all_episode_positions': all_count,
                      'priority_episode_positions': priority, 'later_episode_positions': all_count-priority,
                      'extra_scope_preserved': True, 'recording_long_term_target': 60000},
            'media': {'priority_canonical_files_extant': extant, 'priority_missing': priority-extant,
                      'fresh_full_media_hashes_this_audit': 0, 'alternate_files_not_credited': True},
            'independent_acquisition': acquisitions, 'research_candidates': candidates,
            'completion': {'timeline_processed': 'requires_episode_observation_receipts_not_fingerprint_counts',
                           'occurrence_census_verified': 'requires_actual_full_episode_sound_inventory',
                           'all_used_tracks_complete_episodes': None,
                           'all_used_tracks_count_status': 'not_signed_by_this_audit',
                           'preproduction_ready_signed': False, 'full_corpus_complete_signed': False},
            'new_user_trial_hold': policy['new_trial_hold']['status'],
            'input_bindings': [bound(config['priority_pointer']), pointer['coverage_ledger'], bound(config['policy_path'])],
            'process_changes': 0, 'network_requests': 0, 'model_calls': 0, 'new_user_trials': 0,
            'paid_calls': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = audit(read(args.config))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
    print(json.dumps({'status':'actual_unique_progress_audited',
                      'scope':result['scope'], 'media':result['media'],
                      'recordings':result['independent_acquisition']['unique_independent_file_sha256'],
                      'new_trial_hold':result['new_user_trial_hold'], 'output':str(args.out)}, ensure_ascii=False))
