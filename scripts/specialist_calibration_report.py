"""Research-only activity and transcription checks against frozen external labels."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ACTIVITY_LABELS = {'speech': 'Speech', 'singing': 'Singing', 'music': 'Music', 'silence': 'Silence'}


def binding(path):
    path = Path(path)
    return {'path': str(path.resolve()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def checked(file):
    if binding(file['path'])['sha256'] != file['sha256']:
        raise ValueError('calibration_evidence_changed')
    return json.loads(Path(file['path']).read_text(encoding='utf-8-sig'))


def normalized_words(text):
    return ''.join(c for c in re.sub(r'<[^>]*>', '', text) if c.isalnum())


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def score_rows(rows, labels, threshold=.5):
    """PANN's fixed .5 operating point is not tuned using these labels.

    ASR's word output cannot classify spoken versus sung words. Empty output
    is evaluated only for explicitly labelled silent/instrumental negatives.
    Unknown ground-truth music fields stay unscored.
    """
    scored, lexical_negatives, field_rows = [], [], {name: [] for name in ACTIVITY_LABELS}
    for row in rows:
        label = labels.get(row['id'])
        if not label or not label.get('truth_evidence'):
            raise ValueError('external_calibration_truth_required')
        if not row.get('asr_forward_calls', 0) or not row.get('panns_forward_calls', 0):
            raise ValueError('actual_specialist_forward_required')
        scores = row['human_activity_scores']
        if any(name not in scores for name in ACTIVITY_LABELS.values()):
            raise ValueError('activity_score_missing')
        prediction = {name: scores[category] >= threshold for name, category in ACTIVITY_LABELS.items()}
        expected = {name: value for name, value in label['expected'].items() if name in ACTIVITY_LABELS}
        matches = {name: prediction[name] == truth for name, truth in expected.items()}
        for name, correct in matches.items():
            field_rows[name].append(correct)
        word_check = None
        if label['expected'].get('transcript') == '':
            word_check = not row['transcription'].strip()
            lexical_negatives.append({'id': row['id'], 'passed': word_check})
        scored.append({'id': row['id'], 'activity_prediction': prediction,
            'actual_activity_scores': scores, 'expected_activities': expected,
            'field_matches': matches, 'activity_example_passed': all(matches.values()),
            'asr_predicted_transcription': row['transcription'], 'no_word_negative_passed': word_check,
            'truth_evidence': label['truth_evidence'], 'new_project_human_audition': False,
            'exact_phrase_and_artistic_judgment_verified': False})
    return {'operating_threshold': threshold, 'threshold_tuned_on_this_set': False,
        'activity_examples': len(scored), 'activity_examples_passed': sum(r['activity_example_passed'] for r in scored),
        'activity_example_accuracy': sum(r['activity_example_passed'] for r in scored) / len(scored) if scored else None,
        'per_field_accuracy': {name: {'labelled_examples': len(values), 'passed': sum(values),
            'accuracy': sum(values) / len(values) if values else None} for name, values in field_rows.items()},
        'asr_no_word_negatives': lexical_negatives, 'rows': scored,
        'qualified': False, 'formal_listening_qualification': False}


def run(preparation_path, asr_path, panns_path, output):
    preparation = checked(binding(preparation_path))
    labels = checked(preparation['ground_truth_labels'])
    runs = {backend: checked(binding(file)) for backend, file in [('qwen3_asr', asr_path), ('panns_sed', panns_path)]}
    raw = {}
    for backend, receipt in runs.items():
        if receipt['status'] != 'completed_unqualified' or receipt['qualified'] is not False or receipt['device'] != 'cpu':
            raise ValueError('actual_completed_cpu_research_runs_required')
        raw[backend] = {}
        for job in receipt['jobs']:
            if job['status'] != 'predicted':
                continue
            value = checked({'path': job['raw_receipt'], 'sha256': job['raw_sha256']})
            if value['forward_calls'] != job['forward_calls']:
                raise ValueError('specialist_forward_evidence_changed')
            raw[backend][job['id']] = value
    rows, word_metrics = [], []
    for job in preparation['jobs']:
        a, p = raw['qwen3_asr'][job['id']], raw['panns_sed'][job['id']]
        if any(value['source_sha256'] != job['source_sha256'] or value['input_sha256'] != job['input_sha256']
               or value['source_window_seconds'] != job['source_window_seconds'] for value in (a, p)):
            raise ValueError('calibration_source_window_changed')
        text = a['parsed']['transcription']
        rows.append({'id': job['id'], 'asr_forward_calls': a['forward_calls'],
                     'panns_forward_calls': p['forward_calls'], 'transcription': text,
                     'human_activity_scores': p['human_activity_scores']})
        # Full author files have the exact same source/input identity.
        # Cropped controls are excluded from whole-file transcript CER.
        if job['source_sha256'] == job['input_sha256'] and labels[job['id']].get('reference_transcript'):
            reference = normalized_words(labels[job['id']]['reference_transcript'])
            predicted = normalized_words(text)
            distance = edit_distance(reference, predicted)
            word_metrics.append({'id': job['id'], 'reference_characters': len(reference),
                'character_errors': distance, 'character_error_rate': distance / len(reference) if reference else None,
                'reference_kind': 'external_author_full_file_annotation', 'new_human_audition': False})
    report = score_rows(rows, labels)
    report.update(preparation=binding(preparation_path),
        receipts=[binding(asr_path), binding(panns_path)],
        labels=preparation['ground_truth_labels'], actual_input_examples=len(rows),
        actual_forward_counts={backend: sum(j['forward_calls'] for j in receipt['jobs']) for backend, receipt in runs.items()},
        machine_wall_seconds={backend: receipt['wall_seconds'] for backend, receipt in runs.items()},
        transcription_metrics=word_metrics,
        coverage=preparation['covered_examples'], missing_categories=preparation['missing_categories'],
        status='research_calibration_completed_not_formal_hearing',
        qualified=False, lyrics_verified=False, artistic_approval=False, gpu_calls=0, paid_calls=0)
    Path(output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('preparation', 'asr', 'panns', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    result = run(args.preparation, args.asr, args.panns, args.output)
    print(json.dumps({name: result[name] for name in ('activity_examples', 'activity_examples_passed',
        'activity_example_accuracy', 'per_field_accuracy', 'asr_no_word_negatives', 'qualified')}))
