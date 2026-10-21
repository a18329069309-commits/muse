"""Exact source clocks from bound strict decode evidence, never listening approval."""
import argparse
from contextlib import closing
import json
import math
from pathlib import Path
import sqlite3

from independent_recording_checks import (PCM_RATE, _decoder_identity,
    _verify_unchanged, bounded_source_identity, cached_recording_checks,
    digest_file, read_json, technical_processor_sha256)


def bound_json(binding):
    file = Path(binding['path'])
    if not file.is_absolute() or digest_file(file) != binding['sha256']:
        raise ValueError('actual_pcm_clock_binding_changed')
    return read_json(file)


def frozen_clock(publication_binding, source_sha, runtime):
    publication = bound_json(publication_binding)
    library = publication['library']
    if not Path(library['path']).is_absolute() or digest_file(library['path']) != library['sha256']:
        raise ValueError('actual_pcm_clock_library_changed')
    with closing(sqlite3.connect(Path(library['path']).resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        records = connection.execute('SELECT record_json FROM assets WHERE source_sha256=?', (source_sha,)).fetchall()
    if not records:
        return None
    identities = [json.loads(row[0]) for row in records]
    clocks = []
    for identity in identities:
        decoded = identity.get('full_decode')
        if not decoded:
            return None  # Legacy libraries have no reusable strict PCM evidence.
        samples = identity.get('duration_samples')
        observation = bound_json(identity['technical_observation'])
        provenance = identity.get('technical_cache_provenance', {})
        if (identity.get('sha256') != source_sha or identity.get('source_sha256') != source_sha
                or not isinstance(samples, int) or isinstance(samples, bool) or samples <= 0
                or identity.get('timeline_sample_rate_hz') != PCM_RATE
                or identity.get('duration_seconds') != samples / PCM_RATE
                or decoded.get('exit_code') != 0 or decoded.get('strict_errors') is not True
                or decoded.get('clock_basis') != 'actual_decoded_pcm_samples'
                or decoded.get('decoded_samples') != samples
                or decoded.get('decoded_sample_rate_hz') != PCM_RATE
                or decoded.get('pcm_format') != 'f32le_mono'
                or decoded.get('runtime') != runtime
                or provenance.get('evidence_processor_sha256') != technical_processor_sha256()
                or observation.get('kind') != 'decoded_pcm_rms'
                or observation.get('input_sha256') != source_sha
                or observation.get('decoded_samples') != samples
                or observation.get('decoded_sample_rate') != PCM_RATE
                or len(observation.get('rms_dbfs', [])) != math.ceil(samples / PCM_RATE)
                or any(not math.isfinite(value) for value in observation.get('rms_dbfs', []))
                or any(observation.get(key) is not False for key in
                       ('sound_facts_qualified', 'phrase_boundaries_verified', 'lyrics_verified'))):
            raise ValueError('actual_pcm_clock_frozen_decode_evidence_invalid')
        clocks.append(identity)
    if any(row['duration_samples'] != clocks[0]['duration_samples'] for row in clocks):
        raise ValueError('actual_pcm_clock_frozen_decode_conflict')
    # Recheck frozen files after reading; a race cannot substitute another clock.
    bound_json(publication_binding)
    if digest_file(library['path']) != library['sha256']:
        raise ValueError('actual_pcm_clock_library_changed')
    return clocks[0]


def measure_clock(source, claimed, cache_dir, publication=None):
    before = bounded_source_identity(source)
    if before['sha256'] != claimed:
        raise ValueError('actual_pcm_clock_source_changed')
    runtime = _decoder_identity()
    identity = frozen_clock(publication, claimed, runtime) if publication else None
    if identity:
        _verify_unchanged(source, before)
        reuse = 'bound_frozen_full_pcm_decode'
        hit = True
    else:
        identity, _, hit = cached_recording_checks(source, claimed, cache_dir, source_identity=before)
        reuse = 'content_identity_full_pcm_cache' if hit else 'actual_complete_ffmpeg_decode'
    return {'schema_version': 1, 'revision': 'actual-pcm-source-clock-v1',
        'source': {'path': str(Path(source).absolute()), 'sha256': claimed},
        'source_identity': before, 'decoded_samples': identity['duration_samples'],
        'sample_rate_hz': PCM_RATE, 'clock_basis': 'actual_decoded_pcm_samples',
        'container_duration_seconds': identity.get('container_duration_seconds'),
        'full_decode': identity['full_decode'], 'technical_cache_provenance': identity['technical_cache_provenance'],
        'publication_binding': publication, 'cache_directory': str(Path(cache_dir).absolute()),
        'cache_hit': hit, 'evidence_origin': reuse, 'new_full_decodes': int(not hit),
        'processor_sha256': technical_processor_sha256(), 'helper_sha256': digest_file(__file__),
        'sound_facts_qualified': False, 'phrase_boundaries_verified': False,
        'lyrics_verified': False, 'qualification_granted': False, 'production_approval': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--publication')
    parser.add_argument('--publication-sha256')
    arguments = parser.parse_args()
    publication = ({'path': arguments.publication, 'sha256': arguments.publication_sha256}
                   if arguments.publication else None)
    print(json.dumps(measure_clock(arguments.source, arguments.sha256, arguments.cache_dir, publication),
                     ensure_ascii=False))
