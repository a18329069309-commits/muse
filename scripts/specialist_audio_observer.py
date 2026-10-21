"""Offline pretrained ASR, transcript alignment and sound-event probes.

Each route records source identity, real forward calls and raw predictions.
Alignment consumes supplied text; it never verifies that text was audible.
This tool never downloads models or issues artistic/observation qualification.
"""
import argparse
import csv
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import time
import sys
import types


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validate_window(start, end, duration, rate):
    if any(type(x) not in (int, float) or not math.isfinite(x) for x in (start, end, duration)):
        raise ValueError('Source window must contain finite numbers.')
    if start < 0 or end <= start or abs(end - start - duration) > 1 / rate + 1e-8:
        raise ValueError('Source window and actual input samples disagree.')


def alignment_scope(units, duration):
    valid = bool(units)
    for unit in units:
        start, end = unit['start_time'], unit['end_time']
        if not all(type(x) in (int, float) and math.isfinite(x) for x in (start, end)):
            valid = False
        elif not 0 <= start < end <= duration + 0.1:
            valid = False
    return {'timestamps_in_input_bounds': valid, 'provided_text_aligned': True,
            'audible_text_verified': False, 'lyrics_verified': False, 'qualified': False}


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def bind_input(job):
    import numpy as np
    import soundfile as sf
    path, source = Path(job['input_file']).resolve(), Path(job['source_file']).resolve()
    if not path.is_file() or not source.is_file():
        raise ValueError('Local input and source must exist.')
    if sha256(path) != job['input_sha256'] or sha256(source) != job['source_sha256']:
        raise ValueError('Input or source hash mismatch.')
    audio, rate = sf.read(path, dtype='float32', always_2d=True)
    if len(audio) == 0 or not np.isfinite(audio).all():
        raise ValueError('Input requires nonempty finite audio.')
    mono = np.ascontiguousarray(audio.mean(axis=1), dtype='<f4')
    duration = len(mono) / rate
    start, end = job['source_window_seconds']
    validate_window(start, end, duration, rate)
    record = {'id': job['id'], 'source_file': str(source), 'source_sha256': job['source_sha256'],
              'source_window_seconds': [start, end], 'input_file': str(path),
              'input_sha256': job['input_sha256'], 'sample_rate_hz': rate,
              'channels_read': audio.shape[1], 'duration_seconds': duration,
              'mono_float32_pcm_sha256': hashlib.sha256(mono.tobytes()).hexdigest(),
              'exact_zero_pcm': bool(not np.any(mono)), 'qualified': False}
    return mono, rate, record


from gpu_single_slot import gpu_slot_guard, current_gpu_slot_record


@gpu_slot_guard(lambda config: config.get('device', 'cpu'), lambda config: config.get('gpu_slot'))
def run(config):
    sys.dont_write_bytecode = True
    for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[key] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    import numpy as np
    import torch
    backend = config['backend']
    if backend not in ('qwen3_asr', 'qwen3_forced_aligner', 'panns_sed'):
        raise ValueError('Unknown specialist backend.')
    device = config.get('device', 'cpu')
    if not re.fullmatch(r'cpu|cuda(?::\d+)?', device):
        raise ValueError('Invalid device.')
    out = Path(config['output_dir']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    model_path = Path(config['model_path']).resolve()
    weights = model_path if backend == 'panns_sed' else model_path / 'model.safetensors'
    if not weights.is_file() or sha256(weights) != config['model_sha256']:
        raise ValueError('Existing local model identity does not match.')
    report = {'schema_version': 1, 'backend': backend, 'model_revision': config['model_revision'],
              'model_path': str(model_path), 'model_sha256': config['model_sha256'],
              'qualified': False, 'artistic_approval': False, 'lyrics_verified': False,
              'paid_calls': 0, 'uploads': 0, 'training': False, 'model_downloads_by_observer': 0,
              'device': device, 'torch_version': torch.__version__, 'jobs': []}
    if device != 'cpu':
        report['gpu_slot_execution'] = current_gpu_slot_record()
    begun = time.perf_counter()
    try:
        if device.startswith('cuda'):
            torch.cuda.set_device(torch.device(device))
            torch.cuda.init()
            torch.cuda.reset_peak_memory_stats(torch.device(device))
        if backend == 'panns_sed':
            # The upstream package __init__ downloads labels into Path.home().
            # Load only its model module and explicit, existing local CSV.
            package = types.ModuleType('panns_inference')
            package.__path__ = [str(importlib.metadata.distribution('panns-inference').locate_file('panns_inference'))]
            sys.modules['panns_inference'] = package
            Cnn14_DecisionLevelMax = importlib.import_module('panns_inference.models').Cnn14_DecisionLevelMax
            labels_path = Path(config['labels_file']).resolve()
            with labels_path.open(encoding='utf-8') as stream:
                labels = [row[2] for row in list(csv.reader(stream))[1:]]
            report['labels_file'] = str(labels_path)
            report['labels_sha256'] = sha256(labels_path)
            model = Cnn14_DecisionLevelMax(sample_rate=32000, window_size=1024,
                hop_size=320, mel_bins=64, fmin=50, fmax=14000, classes_num=len(labels))
            model.load_state_dict(torch.load(weights, map_location='cpu', weights_only=True)['model'])
            model = model.to(device).eval()
            report['time_resolution'] = {'emitted_hop_seconds': 0.01,
                'native_prediction_step_seconds': 0.32, 'upsampling': 'nearest',
                'exact_event_onset_verified': False}
        else:
            import transformers
            from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification
            report['transformers_version'] = transformers.__version__
            processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, token=False)
            cls = AutoModelForMultimodalLM if backend == 'qwen3_asr' else AutoModelForTokenClassification
            dtype = torch.bfloat16 if device.startswith('cuda') else torch.float32
            model = cls.from_pretrained(model_path, local_files_only=True, token=False,
                dtype=dtype, attn_implementation='sdpa').to(device).eval()
            report['time_resolution'] = {'scope': 'utterance_window' if backend == 'qwen3_asr' else 'provided_text_units',
                'timestamp_quantum_seconds': processor.timestamp_segment_time / 1000 if backend == 'qwen3_forced_aligner' else None,
                'word_timestamps_from_asr': False}
        report['load_seconds'] = round(time.perf_counter() - begun, 4)
        report['input_route'] = 'soundfile_mono_float32_numpy'
        report['numpy_route_source'] = 'https://github.com/huggingface/transformers/blob/v5.18.0/src/transformers/audio_utils.py#L221'
        forward_count = [0]
        def forward_hook(module, inputs):
            forward_count[0] += 1
        model.register_forward_pre_hook(forward_hook)
        for job in config['jobs']:
            started = time.perf_counter()
            before = forward_count[0]
            try:
                audio, rate, result = bind_input(job)
                target_rate = 32000 if backend == 'panns_sed' else 16000
                if rate != target_rate:
                    from scipy.signal import resample_poly
                    common = math.gcd(rate, target_rate)
                    audio = resample_poly(audio, target_rate // common, rate // common).astype(np.float32)
                result['model_input_sample_rate_hz'] = target_rate
                result['model_input_pcm_sha256'] = hashlib.sha256(audio.astype('<f4').tobytes()).hexdigest()
                result['input_route'] = 'soundfile_mono_float32_numpy'
                if backend == 'qwen3_asr':
                    inputs = processor.apply_transcription_request(audio=audio).to(device, model.dtype)
                    with torch.inference_mode():
                        generated = model.generate(**inputs, max_new_tokens=config.get('max_new_tokens', 128), do_sample=False)
                    generated = generated[:, inputs['input_ids'].shape[1]:]
                    result.update(raw_output=processor.decode(generated[0]),
                                  parsed=processor.decode(generated[0], return_format='parsed'),
                                  transcription_is_unverified_prediction=True)
                elif backend == 'qwen3_forced_aligner':
                    text = job['provided_transcript']
                    if not isinstance(text, str) or not text.strip():
                        raise ValueError('Alignment needs supplied text, not a lyric verification request.')
                    inputs, word_lists = processor.prepare_forced_aligner_inputs(audio=audio,
                        transcript=text, language=job.get('language', 'Chinese'))
                    inputs = inputs.to(device, model.dtype)
                    with torch.inference_mode():
                        outputs = model(**inputs)
                    units = processor.decode_forced_alignment(logits=outputs.logits,
                        input_ids=inputs['input_ids'], word_lists=word_lists,
                        timestamp_token_id=model.config.timestamp_token_id)[0]
                    result.update(provided_transcript=text, units=units,
                                  alignment_scope=alignment_scope(units, result['duration_seconds']))
                else:
                    with torch.inference_mode():
                        outputs = model(torch.from_numpy(audio[None, :]).to(device))
                    matrix = outputs['framewise_output'][0].cpu().numpy()
                    clips = outputs['clipwise_output'][0].cpu().numpy()
                    array_root = Path(config['array_dir']).resolve()
                    array_root.mkdir(parents=True, exist_ok=True)
                    array_path = array_root / (job['id'] + '-scores.npz')
                    np.savez_compressed(array_path, framewise=matrix, clipwise=clips)
                    result.update(scores_file=str(array_path), scores_sha256=sha256(array_path),
                        frame_count=len(matrix), class_count=len(labels),
                        top_labels=[{'label': labels[int(i)], 'probability': float(clips[i])}
                                    for i in np.argsort(clips)[-10:][::-1]],
                        human_activity_scores={name: float(clips[labels.index(name)])
                                               for name in ('Speech', 'Singing', 'Music', 'Silence')},
                        event_onsets_verified=False)
                if device.startswith('cuda'):
                    torch.cuda.synchronize(device)
                result.update(status='predicted', forward_calls=forward_count[0] - before,
                              elapsed_seconds=round(time.perf_counter() - started, 4))
                path = out / (job['id'] + '-raw.json')
                save(path, result)
                report['jobs'].append({'id': job['id'], 'status': 'predicted',
                    'raw_receipt': str(path), 'raw_sha256': sha256(path),
                    'forward_calls': result['forward_calls'], 'elapsed_seconds': result['elapsed_seconds']})
            except Exception as error:
                report['jobs'].append({'id': job['id'], 'status': 'failed',
                    'error_type': type(error).__name__, 'error': str(error),
                    'elapsed_seconds': round(time.perf_counter() - started, 4)})
            save(out / 'progress.json', report)
            print(json.dumps({'backend': backend, 'id': job['id'], 'status': report['jobs'][-1]['status']}), flush=True)
        report['status'] = 'completed_unqualified'
    except Exception as error:
        report.update(status='route_failed', error_type=type(error).__name__, error=str(error))
    report['wall_seconds'] = round(time.perf_counter() - begun, 4)
    report['completed_jobs'] = sum(x['status'] == 'predicted' for x in report['jobs'])
    report['requested_jobs'] = len(config['jobs'])
    if device.startswith('cuda'):
        report['gpu_peak_allocated_mib'] = torch.cuda.max_memory_allocated(device) / 1024**2
        report['gpu_peak_reserved_mib'] = torch.cuda.max_memory_reserved(device) / 1024**2
    save(out / 'receipt.json', report)
    print(json.dumps({k: report[k] for k in ('backend', 'status', 'completed_jobs', 'requested_jobs', 'wall_seconds', 'qualified')}), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    run(json.loads(parser.parse_args().config.read_text(encoding='utf-8')))
