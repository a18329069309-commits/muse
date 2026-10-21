"""CPU-only, input-bound rhythm/energy measurements; never listening approval."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

import numpy as np

from measure_music_asset import window_candidates
from specialist_audio_observer import bind_input, sha256


def measured_features(audio, rate, beats=(), downbeats=()):
    import librosa
    duration = len(audio) / rate
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Nonempty finite audio required.')
    hop = 256
    spectrum = np.abs(librosa.stft(audio, n_fft=1024, hop_length=hop))
    centroid = librosa.feature.spectral_centroid(S=spectrum, sr=rate)[0]
    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spectrum), sr=rate, hop_length=hop)
    onset_times = librosa.onset.onset_detect(onset_envelope=onset, sr=rate, hop_length=hop, units='time')
    beat_times = sorted(float(x) for x in beats if np.isfinite(x) and 0 <= x < duration)
    downbeat_times = sorted(float(x) for x in downbeats if np.isfinite(x) and 0 <= x < duration)
    intervals = np.diff(beat_times)
    block = max(1, round(rate * .5))
    envelope = [{'relative_start_seconds': i / rate, 'relative_end_seconds': min(i + block, len(audio)) / rate,
                 'rms_dbfs': float(10 * np.log10(max(1e-12, np.mean(audio[i:i + block].astype(np.float64) ** 2))))}
                for i in range(0, len(audio), block)]
    changes = [{'relative_seconds': envelope[i]['relative_start_seconds'],
                'rms_change_db': envelope[i]['rms_dbfs'] - envelope[i - 1]['rms_dbfs']}
               for i in range(1, len(envelope))]
    # A large energy discontinuity is a candidate only, never a named section/phrase.
    changes = sorted(changes, key=lambda x: abs(x['rms_change_db']), reverse=True)[:3]
    measured = window_candidates(audio, rate, [], duration, 'driving')
    return {'duration_seconds': duration, 'sample_rate_hz': rate,
            'exact_zero_pcm': bool(not np.any(audio)),
            'whole_window_energy': measured[0] if measured else None,
            'rms_envelope_half_second': envelope,
            'energy_change_candidates': sorted(changes, key=lambda x: x['relative_seconds']),
            'beats_relative_seconds': beat_times, 'downbeats_relative_seconds': downbeat_times,
            'median_interbeat_bpm_candidate': float(60 / np.median(intervals)) if len(intervals) >= 2 else None,
            'interbeat_coefficient_of_variation': float(np.std(intervals) / np.mean(intervals)) if len(intervals) else None,
            'onset_relative_seconds': [float(x) for x in onset_times if 0 <= x < duration],
            'onset_count_per_second': float(sum(0 <= x < duration for x in onset_times) / duration),
            'spectral_centroid_median_hz': float(np.median(centroid)),
            'phrase_boundaries_verified': False, 'named_sections_verified': False,
            'instrument_labels_verified': False, 'lyrics_verified': False,
            'scope': 'Short-window acoustic and predicted beat candidates; no whole-song structure or aesthetic judgment',
            'artistic_approval': False, 'production_approval': False}


def run(config):
    import torch
    from beat_this.inference import Audio2Beats
    checkpoint = Path(config['checkpoint']).resolve()
    if not checkpoint.is_file() or sha256(checkpoint) != config['checkpoint_sha256']:
        raise ValueError('Existing checkpoint hash required; no download fallback.')
    out = Path(config['output_dir']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    begun = time.perf_counter()
    torch.set_num_threads(2)
    model = Audio2Beats(checkpoint_path=str(checkpoint), device='cpu', dbn=False, float16=False)
    forwards = [0]
    hook = model.model.register_forward_hook(lambda *_: forwards.__setitem__(0, forwards[0] + 1))
    versions = {name: importlib.metadata.version(name) for name in ('beat-this', 'librosa', 'numpy', 'torch')}
    script = {'path': str(Path(__file__).resolve()), 'sha256': sha256(__file__)}
    revision = hashlib.sha256(json.dumps([versions, script['sha256'], config['checkpoint_sha256']]).encode()).hexdigest()
    receipt = {'schema_version': 1, 'backend': 'beat_this_librosa_cpu', 'model_revision': revision,
               'versions': versions, 'script_binding': script,
               'checkpoint_binding': {'path': str(checkpoint), 'sha256': config['checkpoint_sha256']},
               'device': 'cpu', 'qualified': False, 'artistic_approval': False, 'production_approval': False,
               'model_downloads': 0, 'uploads': 0, 'paid_calls': 0, 'jobs': []}
    try:
        for job in config['jobs']:
            started, before = time.perf_counter(), forwards[0]
            try:
                audio, rate, binding = bind_input(job)
                beats, downbeats = model(audio, rate)
                features = measured_features(audio, rate, beats, downbeats)
                count = forwards[0] - before
                if count <= 0:
                    raise ValueError('Actual Beat This forward required.')
                raw = {**binding, 'status': 'measured', 'backend': receipt['backend'], 'model_revision': revision,
                       'features': features, 'actual_audio_processed': True, 'forward_calls': count,
                       'wall_seconds': time.perf_counter() - started, 'device': 'cpu',
                       'qualified': False, 'artistic_approval': False, 'production_approval': False}
                file = out / (job['id'] + '-features.json')
                file.write_text(json.dumps(raw, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
                receipt['jobs'].append({'id': job['id'], 'status': 'measured', 'raw_receipt': str(file),
                                        'raw_sha256': sha256(file), 'forward_calls': count})
            except Exception as error:
                receipt['jobs'].append({'id': job['id'], 'status': 'failed',
                                        'error': type(error).__name__ + ': ' + str(error),
                                        'forward_calls': forwards[0] - before})
        receipt['status'] = 'completed_unqualified' if all(x['status'] == 'measured' for x in receipt['jobs']) else 'partial_failure'
    finally:
        hook.remove()
        receipt['wall_seconds'] = time.perf_counter() - begun
        receipt['actual_forward_calls'] = forwards[0]
        (out / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'status': receipt['status'], 'jobs': len(receipt['jobs']), 'forwards': forwards[0],
                      'wall_seconds': receipt['wall_seconds'], 'receipt': str(out / 'receipt.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    run(json.loads(parser.parse_args().config.read_text(encoding='utf-8-sig')))
