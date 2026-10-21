"""Pinned, local audio-only Omni research probe; no artistic qualification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

from specialist_audio_observer import bind_input, sha256, save
from gpu_single_slot import gpu_slot_guard, require_gpu_slot


PROMPT = ('Listen only to the supplied audio. Return one JSON object with keys '
          'speech, singing, music, silence (each true, false, or null if uncertain), '
          'transcript (only words actually audible, empty string if none or uncertain), '
          'description (brief audible evidence). Distinguish spoken speech from singing. '
          'Do not guess words or use external information. Silence means no audible sound.')
FIELDS = ('speech', 'singing', 'music', 'silence')
SYSTEM_PROMPT = ('You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, '
                 'capable of perceiving auditory and visual inputs, as well as generating text and speech.')


def audio_messages():
    # Pinned 4.52.3 checks content[0]["text"] before rendering the template.
    return [{'role': 'system', 'content': [{'type': 'text', 'text': SYSTEM_PROMPT}]},
            {'role': 'user', 'content': [{'type': 'audio', 'audio': 'local-audio'},
                                         {'type': 'text', 'text': PROMPT}]}]


def parse_prediction(raw):
    text = raw.strip()
    if text.startswith('```json\n') and text.endswith('\n```'):
        text = text[8:-4].strip()
    value = json.loads(text)
    if not isinstance(value, dict) or any(k not in value for k in FIELDS + ('transcript', 'description')):
        raise ValueError('Missing observation fields')
    if any(value[k] is not None and type(value[k]) is not bool for k in FIELDS):
        raise ValueError('Activity fields require boolean or null')
    if not all(isinstance(value[k], str) for k in ('transcript', 'description')):
        raise ValueError('Transcript and evidence require strings')
    return {key: value[key] for key in FIELDS + ('transcript', 'description')}


def prepare_job(job, out):
    """Bind an existing crop, or extract a source-only request without changing it."""
    if job.get('input_file'):
        return job
    import soundfile as sf
    source = Path(job['source_file']).resolve()
    if sha256(source) != job['source_sha256']:
        raise ValueError('Source hash mismatch.')
    start, end = job['source_window_seconds']
    info = sf.info(source)
    if not 0 <= start < end <= info.frames / info.samplerate + 1 / info.samplerate:
        raise ValueError('Source-only request exceeds audio bounds.')
    audio, rate = sf.read(source, start=round(start * info.samplerate),
                          stop=round(end * info.samplerate), dtype='float32', always_2d=True)
    audio *= job.get('gain_applied', 1.0)
    path = out / (re.sub(r'[^a-zA-Z0-9_-]', '_', job['id']) + '-input.wav')
    sf.write(path, audio, rate, subtype='FLOAT')
    return {**job, 'input_file': str(path), 'input_sha256': sha256(path)}


def score_calibration(rows, labels):
    """Labels are external evidence, never inserted into the model prompt."""
    matches = []
    silence_failure = False
    for row in rows:
        prediction = row.get('prediction', {})
        if row.get('exact_zero_pcm') and (prediction.get('transcript', '').strip()
                or any(prediction.get(k) is True for k in ('speech', 'singing', 'music'))):
            silence_failure = True
        label = labels.get(row['id'])
        if row.get('status') == 'failed' or not prediction or not label or not label.get('truth_evidence') or not row.get('forward_calls', 0) \
                or not row.get('audio_encoder_forward_calls', 0):
            continue
        expected = label.get('expected', {})
        match = bool(expected) and all(prediction.get(k) == v for k, v in expected.items())
        matches.append({'id': row['id'], 'passed': match, 'truth_evidence': label['truth_evidence']})
    count = len(matches)
    passed = sum(x['passed'] for x in matches)
    unique = len({r.get('model_input_pcm_sha256') for r in rows if r.get('model_input_pcm_sha256')})
    complete = count == len(rows) == unique == 16 and all(r.get('forward_calls', 0) > 0
        and r.get('audio_encoder_forward_calls', 0) > 0 for r in rows)
    return {'required_examples': 16, 'scored_examples': count, 'passed_examples': passed,
            'accuracy': passed / count if count else None, 'unique_pcm_examples': unique,
            'unscored_examples': len(rows) - count,
            'silence_hallucination': silence_failure,
            'passed': complete and passed / 16 >= 0.9 and not silence_failure,
            'qualified': False, 'artistic_approval': False, 'rows': matches}


@gpu_slot_guard(lambda config: 'cuda:0', lambda config: config.get('gpu_slot'))
def run(config):
    for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[key] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    out = Path(config['output_dir']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    report = {'schema_version': 1, 'backend': 'qwen2_5_omni_3b_author', 'status': 'starting',
              'model_revision': config['model_revision'], 'model_path': config['model_path'],
              'observer_script_sha256': sha256(__file__),
              'qualified': False, 'artistic_approval': False, 'lyrics_verified': False,
              'research_only': True, 'training': False, 'paid_calls': 0, 'uploads': 0,
              'prompt': PROMPT, 'prompt_sha256': hashlib.sha256(PROMPT.encode()).hexdigest(),
              'jobs': []}
    save(out / 'receipt.json', report)
    begun = time.perf_counter()
    try:
        import numpy as np
        import torch
        import transformers
        from transformers import Qwen2_5OmniConfig, Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor
        report.update(torch_version=torch.__version__, transformers_version=transformers.__version__,
                      python_version=sys.version, python_executable=sys.executable,
                      torch_import_path=torch.__file__, transformers_import_path=transformers.__file__)
        if transformers.__version__ != '4.52.3':
            raise ValueError('This adapter requires the pinned Transformers 4.52.3 API.')
        labels = json.loads(Path(config['labels_file']).read_text(encoding='utf-8')) if config.get('labels_file') else {}
        if labels:
            report['labels_sha256'] = sha256(config['labels_file'])
        for label in labels.values():
            if label.get('annotation_file') and sha256(label['annotation_file']) != label['annotation_sha256']:
                raise ValueError('External author annotation identity mismatch')
        model_path = Path(config['model_path']).resolve()
        processor = Qwen2_5OmniProcessor.from_pretrained(model_path, local_files_only=True, token=False)
        prompt_text = processor.apply_chat_template(audio_messages(), add_generation_prompt=True, tokenize=False)
        if isinstance(prompt_text, list) and len(prompt_text) == 1:
            prompt_text = prompt_text[0]
        if not isinstance(prompt_text, str):
            raise ValueError('Audio-only probe requires exactly one rendered conversation.')
        report['rendered_prompt_sha256'] = hashlib.sha256(prompt_text.encode()).hexdigest()
        receipt = json.loads(Path(config['model_manifest']).read_text(encoding='utf-8'))
        if receipt['status'] != 'author_hashes_verified' or receipt['revision'] != config['model_revision']:
            raise ValueError('Author checkpoint has not been verified')
        report['model_manifest_sha256'] = sha256(config['model_manifest'])
        report['model_files'] = receipt['files']
        for entry in receipt['files']:
            path = model_path / entry['file']
            if sha256(path) != entry['sha256']:
                raise ValueError('Local model identity mismatch')
        report['status'] = 'loading_verified_model'
        save(out / 'receipt.json', report)
        if not config.get('gpu_queue_reservation'):
            raise ValueError('Explicit coordinated GPU reservation required')
        report['gpu_queue_reservation'] = config['gpu_queue_reservation']
        torch.cuda.reset_peak_memory_stats()
        model_config = Qwen2_5OmniConfig.from_pretrained(model_path, local_files_only=True, token=False)
        model_config.enable_audio_output = False
        require_gpu_slot('cuda:0')
        model = Qwen2_5OmniForConditionalGeneration.from_pretrained(model_path,
            config=model_config, torch_dtype=torch.bfloat16, device_map='auto',
            max_memory={0: config.get('gpu_max_memory', '4GiB'), 'cpu': '13GiB'},
            attn_implementation='sdpa', local_files_only=True, token=False).eval()
        model.disable_talker()
        report.update(load_seconds=round(time.perf_counter() - begun, 3),
                      device_map=model.hf_device_map, talker_disabled=not model.has_talker,
                      input_route='soundfile_mono_float32_numpy', audio_only=True)
        report['status'] = 'running_probe'
        save(out / 'receipt.json', report)
        counters = {'thinker': 0, 'audio_encoder': 0}
        def thinker_hook(module, args, output):
            counters['thinker'] += 1
        def audio_hook(module, args, output):
            counters['audio_encoder'] += 1
        model.thinker.register_forward_hook(thinker_hook)
        model.thinker.audio_tower.register_forward_hook(audio_hook)
        for job in config['jobs']:
            started = time.perf_counter()
            before = counters.copy()
            row = {'id': job['id'], 'qualified': False}
            try:
                audio, rate, row = bind_input(prepare_job(job, out))
                if rate != 16000:
                    import math
                    from scipy.signal import resample_poly
                    common = math.gcd(rate, 16000)
                    audio = resample_poly(audio, 16000 // common, rate // common).astype(np.float32)
                row.update(segment_id=job.get('segment_id', job['id']),
                           source_range=job['source_window_seconds'],
                           gain_applied=job.get('gain_applied', 1.0),
                           model_input_sample_rate_hz=16000,
                           model_input_pcm_sha256=hashlib.sha256(audio.astype('<f4').tobytes()).hexdigest())
                inputs = processor(text=prompt_text, audio=[audio], sampling_rate=16000,
                                   return_tensors='pt', padding=True)
                inputs = inputs.to('cuda:0').to(torch.bfloat16)
                row['model_input_shapes'] = {k: list(v.shape) for k, v in inputs.items()}
                row['valid_audio_feature_frames'] = int(inputs['feature_attention_mask'].sum().item())
                with torch.inference_mode():
                    generated = model.generate(**inputs, return_audio=False,
                        thinker_max_new_tokens=config.get('max_new_tokens', 256),
                        thinker_max_time=120,
                        thinker_do_sample=False)
                new_tokens = generated[:, inputs['input_ids'].shape[1]:]
                row['raw_output'] = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
                row['prediction'] = parse_prediction(row['raw_output'])
                row['status'] = 'research_prediction'
            except Exception as exc:
                row.update(status='failed', error_type=type(exc).__name__, error=str(exc))
            row.update(forward_calls=counters['thinker']-before['thinker'],
                       audio_encoder_forward_calls=counters['audio_encoder']-before['audio_encoder'],
                       seconds=round(time.perf_counter()-started, 3), qualified=False,
                       artistic_approval=False, lyrics_verified=False,
                       model_revision=config['model_revision'],
                       backend=report['backend'], model_manifest_sha256=report['model_manifest_sha256'],
                       observer_script_sha256=report['observer_script_sha256'],
                       runtime_version=report['transformers_version'],
                       evidence_status='unqualified_research_prediction')
            row['actual_audio_processed'] = row['forward_calls'] > 0 and row['audio_encoder_forward_calls'] > 0
            raw_path = out / (re.sub(r'[^a-zA-Z0-9_-]', '_', job['id']) + '-raw.json')
            save(raw_path, row)
            row['files'] = [{'path': str(raw_path), 'sha256': sha256(raw_path)}]
            report['jobs'].append(row)
            save(out / 'receipt.json', report)
            if row['status'] == 'failed' or (config.get('stop_on_hallucination', False) and row.get('exact_zero_pcm') and
                    (row['prediction']['transcript'].strip() or any(row['prediction'][k] is True
                     for k in ('speech', 'singing', 'music')))):
                report['status'] = 'stopped_failed_probe'
                break
        else:
            report['status'] = 'research_probe_complete'
        if labels:
            report['calibration'] = score_calibration(report['jobs'], labels)
        else:
            report['calibration'] = {'status': 'not_requested', 'qualified': False, 'artistic_approval': False}
        report['gpu_peak_allocated_bytes'] = torch.cuda.max_memory_allocated()
    except Exception as exc:
        report.update(status='failed', error_type=type(exc).__name__, error=str(exc))
    finally:
        report['wall_seconds'] = round(time.perf_counter() - begun, 3)
        save(out / 'receipt.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    result = run(json.loads(Path(args.config).read_text(encoding='utf-8')))
    print(json.dumps({'status': result['status'], 'qualified': False,
                      'wall_seconds': result['wall_seconds']}))
