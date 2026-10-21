"""Measure a real music candidate and propose source windows, not artistic approval.

Uses an existing Beat This checkpoint on CPU. No model downloads or training.
The windows compare measured energy; predicted downbeats are not phrase boundaries.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import soundfile as sf


def window_candidates(audio, rate, starts, length, profile):
    if profile not in ('driving', 'rising', 'restrained'):
        raise ValueError('Unknown energy profile')
    if not np.isfinite(length) or length <= 0 or length > len(audio) / rate:
        raise ValueError('Requested window must fit the actual audio')
    candidates = []
    count = round(length * rate)
    if count < 1:
        raise ValueError('Requested window must contain at least one sample')
    for start in sorted(set([0.0] + [round(float(x), 6) for x in starts])):
        if not np.isfinite(start) or start < 0:
            continue
        first = round(start * rate)
        if first + count > len(audio):
            continue
        segment = audio[first:first + count].astype(np.float64)
        block_size = max(1, round(rate * .5))
        block_db = [float(10 * np.log10(max(1e-12, np.mean(part * part))))
                    for part in (segment[i:i + block_size] for i in range(0, count, block_size))]
        third = max(1, len(block_db) // 3)
        early, late = float(np.mean(block_db[:third])), float(np.mean(block_db[-third:]))
        mean_db = float(10 * np.log10(max(1e-12, np.mean(segment * segment))))
        peak = float(np.max(np.abs(segment)))
        # Silence cannot become an attractive quiet cue, nor an artificial rising intro.
        if mean_db < -65:
            continue
        audible_fraction = sum(x > -50 for x in block_db) / len(block_db)
        if profile == 'driving':
            score = mean_db + 10 * audible_fraction - max(0, early - late - 4)
        elif profile == 'rising':
            if early <= -50 or audible_fraction < .85:
                continue
            score = late - early + .2 * mean_db + 10 * audible_fraction
        else:
            score = -mean_db + 10 * audible_fraction - max(0, -45 - mean_db) * 3
        candidates.append({'source_in_seconds': first / rate, 'source_out_seconds': (first + count) / rate,
                           'rms_dbfs': mean_db, 'peak_linear': peak,
                           'early_rms_dbfs': early, 'late_rms_dbfs': late,
                           'energy_change_db': late - early, 'audible_fraction': audible_fraction,
                           'score': score, 'score_type': 'measured_energy_only',
                           'start_basis': 'file_start' if first == 0 else 'predicted_downbeat',
                           'listening_status': 'pending'})
    return sorted(candidates, key=lambda item: item['score'], reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('audio', type=Path)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--length', type=float, required=True)
    parser.add_argument('--profile', choices=['driving', 'rising', 'restrained'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError('Use a new report path')
    if not args.checkpoint.is_file():
        raise ValueError('Existing local Beat This checkpoint required; no download fallback')
    started = time.perf_counter()
    audio, rate = sf.read(args.audio, dtype='float32', always_2d=True)
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Audio must contain finite samples')
    # Validate before importing the inference runtime.
    window_candidates(audio, rate, [], args.length, args.profile)
    import torch
    from beat_this.inference import Audio2Beats
    torch.set_num_threads(2)
    model = Audio2Beats(checkpoint_path=str(args.checkpoint), device='cpu', dbn=False, float16=False)
    beats, downbeats = model(audio, rate)
    candidates = window_candidates(audio, rate, downbeats, args.length, args.profile)
    with args.audio.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    report = {'source': str(args.audio.resolve()), 'source_sha256': digest,
              'sample_rate': rate, 'channels': audio.shape[1], 'duration_seconds': len(audio) / rate,
              'checkpoint': str(args.checkpoint.resolve()),
              'checkpoint_sha256': hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
              'beat_model': 'Beat This small0, CPU', 'profile': args.profile,
              'requested_length_seconds': args.length,
              'beats_seconds': np.asarray(beats).tolist(), 'downbeats_seconds': np.asarray(downbeats).tolist(),
              'candidate_windows': candidates[:8], 'wall_seconds': time.perf_counter() - started,
              'phrase_boundaries': 'not_verified', 'artistic_approval': False,
              'scope': 'Acoustic source-window shortlist; compare actual music before approving a score'}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({'report': str(args.out), 'candidate_count': len(candidates),
                      'wall_seconds': report['wall_seconds']}))


if __name__ == '__main__':
    main()
