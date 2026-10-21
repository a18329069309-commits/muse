"""Freeze a separate SFX semantic map using the existing CLAP encoder.

Representative vectors are candidate ranking, never full-window sound facts.
The original diagnostic sound publication and all qualifications remain intact.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from build_independent_clap_index import build as build_index, checked_json
from clap_segment_features import digest, json_digest
from gpu_single_slot import gpu_slot_guard, slot_binding_from_args, add_slot_arguments

REVISION = 'frozen-sfx-clap-representatives-v1'


def save_once(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if file.exists():
        if file.read_bytes() != data:
            raise ValueError('Immutable SFX artifact changed: ' + str(file))
    else:
        with file.open('xb') as stream:
            stream.write(data)
    return {'path': str(file.resolve()), 'sha256': hashlib.sha256(data).hexdigest()}


def project_sound_windows(publication, assets, segments):
    if publication.get('kind') != 'diagnostic_sound_library' or \
            publication.get('status') != 'diagnostic_only_not_approved_sound_pack' or \
            publication.get('human_audition_performed') is not False or \
            publication.get('professional_audio_review_qualified') is not False:
        raise ValueError('Exact diagnostic sound publication required')
    by_asset = {a['asset_id']: a for a in assets}
    if len(by_asset) != len(assets) or len({s['segment_id'] for s in segments}) != len(segments) or not segments:
        raise ValueError('Sound asset/window identities must be unique and nonempty')
    projected = []
    for s in segments:
        a = by_asset.get(s['asset_id'])
        r = s.get('source_range')
        if not a or a.get('asset_kind') not in ('sfx', 'ambience', 'ambient') or \
                s.get('source_sha256') != a.get('source_sha256') or a.get('full_decode_verified') is not True or \
                a.get('production_approval') is not False or not isinstance(r, list) or len(r) != 2 or \
                any(isinstance(x, bool) or not isinstance(x, (int, float)) for x in r) or not 0 <= r[0] < r[1] or \
                r[1] > a.get('duration_seconds', -1) or not a.get('recording_family_id') or \
                not a.get('pcm_proxy', {}).get('receipt'):
            raise ValueError('Exact sound SHA, decoded clock, range and PCM receipt required')
        source = a.get('local_path') or a.get('path')
        if not source or not Path(source).is_absolute():
            raise ValueError('Registered local PCM source required')
        projected.append({**s, 'path': source, 'local_path': source,
                          'recording_family_id': a['recording_family_id'],
                          **({'clap_representative_range': list(r)} if r[1] - r[0] <= 10 else {}),
                          'qualification_granted': False, 'artistic_approval': False})
    return projected


@gpu_slot_guard(lambda args: args.device, slot_binding_from_args)
def build(args):
    start = time.perf_counter()
    original = {'path': str(Path(args.publication).resolve()), 'sha256': args.publication_sha256}
    publication = checked_json(original)
    if digest(publication['library']['path']) != publication['library']['sha256']:
        raise ValueError('Frozen sound SQLite identity changed')
    assets = checked_json(publication['assets'])['assets']
    windows = project_sound_windows(publication, assets, checked_json(publication['segments'])['segments'])
    root = Path(args.out).resolve()
    producer = {'path': str(Path(__file__).resolve()), 'sha256': digest(__file__)}
    identity = json_digest({'publication': original, 'producer': producer})
    metadata = root / 'source-mapping' / identity[:20]
    segments = save_once(metadata / 'segments.json', {'segments': windows})
    derived = save_once(metadata / 'publication.json', {
        'kind': 'diagnostic_sound_clap_mapping_source', 'revision': REVISION,
        'sound_publication': original, 'library': publication['library'], 'assets': publication['assets'],
        'segments': segments, 'windows': windows, 'producer': producer,
        'sound_facts_qualified': False, 'cleanliness_approved': False, 'usage_approved': False,
        'artistic_approval': False, 'professional_audio_review_qualified': False,
    })
    params = argparse.Namespace(**vars(args))
    params.publication, params.publication_sha256 = derived['path'], derived['sha256']
    params.out = str(root / 'representatives')
    built = build_index(params)
    if args.plan_only or args.probe_limit:
        return {'revision': REVISION, 'sound_publication': original, 'source_mapping': derived,
                'representative_result': built, 'qualified': False}
    snapshot = checked_json(built)
    mapping = checked_json(snapshot['mapping'])
    if len(mapping['records']) != len(windows) or {r['segment_id'] for r in mapping['records']} != {w['segment_id'] for w in windows}:
        raise ValueError('SFX mapping must cover every frozen recording window')
    wrapper = {
        'kind': 'frozen_sfx_clap_snapshot_v1', 'revision': REVISION,
        'sound_publication': original, 'library': publication['library'],
        'source_mapping': derived, 'index_snapshot': {'path': built['path'], 'sha256': built['sha256']},
        'encoded_windows': built['encoded_windows'], 'distinct_recordings': len({w['source_sha256'] for w in windows}),
        'recording_families': len({w['recording_family_id'] for w in windows}),
        'new_encoded_windows': built['new_encoded_windows'], 'reused_encoded_windows': built['reused_encoded_windows'],
        'representative_max_seconds': 10, 'whole_window_sound_facts': False,
        'producer': producer, 'sound_facts_qualified': False, 'cleanliness_approved': False,
        'usage_approved': False, 'artistic_approval': False, 'professional_audio_review_qualified': False,
        'elapsed_seconds': time.perf_counter() - start,
    }
    frozen_id = json_digest(wrapper)
    binding = save_once(root / 'snapshots' / frozen_id[:20] / 'snapshot.json', wrapper)
    save_once(root / ('build-result-' + frozen_id[:20] + '.json'), {**binding,
        'encoded_windows': wrapper['encoded_windows'], 'reused': wrapper['reused_encoded_windows'],
        'new': wrapper['new_encoded_windows'], 'elapsed_seconds': wrapper['elapsed_seconds'], 'qualified': False})
    return {**binding, 'encoded_windows': wrapper['encoded_windows'],
            'new': wrapper['new_encoded_windows'], 'reused': wrapper['reused_encoded_windows'],
            'elapsed_seconds': wrapper['elapsed_seconds'], 'qualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('publication', 'publication-sha256', 'reuse-index', 'reuse-index-sha256',
                  'reuse-audio-sha256', 'weights', 'out'):
        parser.add_argument('--' + field, required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    add_slot_arguments(parser)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--decode-workers', type=int, choices=[1, 2], default=1)
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--probe-limit', type=int, default=0)
    parser.add_argument('--shared-encoded-cache')
    parser.add_argument('--cache-only', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 8 or args.probe_limit < 0:
        raise ValueError('Bounded encoder batch required')
    print(json.dumps(build(args)), flush=True)
