"""Report actual frozen-library coverage without declaring auditory readiness."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sqlite3

from independent_music_pack_library import checked_binding, read_json, write_json

NEEDS = [
    ('ongoing-danger', ['dark', 'suspense', 'dramatic'], False),
    ('approaching-threat', ['dark', 'ambient', 'tense'], False),
    ('danger-information', ['mysterious', 'dark', 'dramatic'], False),
    ('action-advance', ['action', 'energetic', 'rock'], False),
    ('humiliation-consequence', ['dramatic', 'dark', 'emotional'], False),
    ('decision-to-resist', ['dramatic', 'energetic', 'rock'], False),
    ('counteraction-unresolved', ['action', 'dramatic', 'energetic'], False),
    ('counteraction-success', ['epic', 'energetic', 'uplifting'], False),
    ('betrayal-hurt', ['sad', 'emotional', 'dark'], False),
    ('refusal-agency', ['energetic', 'dramatic', 'rock'], False),
    ('regret', ['sad', 'piano', 'emotional'], False),
    ('family-recognition', ['emotional', 'acoustic', 'piano'], False),
    ('family-acceptance', ['warm', 'acoustic', 'emotional'], False),
    ('companionship', ['relaxing', 'acoustic', 'piano'], False),
    ('era-displacement', ['classical', 'folk', 'acoustic'], False),
    ('new-era-texture', ['folk', 'jazz', 'acoustic'], False),
    ('guarded-closeness', ['emotional', 'acoustic', 'piano'], False),
    ('mutual-choice', ['romantic', 'emotional', 'uplifting'], False),
    ('constraint-release', ['uplifting', 'energetic', 'happy'], False),
    ('free-departure', ['uplifting', 'rock', 'energetic'], False),
    ('financial-agency', ['funk', 'groove', 'energetic'], False),
    ('light-irony', ['funk', 'groove', 'happy'], False),
    ('revenge-entrance', ['epic', 'dramatic', 'energetic'], False),
    ('unknown-supernatural', ['ambient', 'dark', 'electronic'], False),
    ('lyric-family-relation', ['love', 'family', 'emotional'], True),
    ('lyric-free-departure', ['freedom', 'hope', 'uplifting'], True),
    ('lyric-betrayal-refusal', ['loss', 'regret', 'dark'], True),
    ('lyric-romantic-choice', ['love', 'romantic', 'emotional'], True),
    ('lyric-counteraction', ['politics', 'hard', 'rock'], True),
    ('lyric-agency', ['fun', 'funk', 'rock'], True),
    ('lyric-era-memory', ['folk', 'acoustic', 'country'], True),
    ('lyric-self-resolve', ['hope', 'uplifting', 'rock'], True),
]


def audit(binding):
    file, sha = checked_binding(binding)
    publication = read_json(file)
    checked_binding(publication['library'])
    assets_file, _ = checked_binding(publication['assets'])
    assets = read_json(assets_file)['assets']
    counts = publication['counts']
    descriptions = {row['source_sha256']: ' '.join((str(row.get('publisher_tags', row.get('source_tags', []))),
        str(row.get('publisher_description', '')), str(row.get('description', '')))).lower() for row in assets}
    rows = []
    for key, keywords, requires_words in NEEDS:
        candidates = [row for row in assets if any(word in descriptions[row['source_sha256']] for word in keywords)
            and (not requires_words or row.get('publisher_variant_label') == 'Full Song')]
        families = set(row['family_id'] for row in candidates)
        rows.append({'need_id': key, 'publisher_keyword_candidates': len(candidates),
            'different_recording_families': len(families), 'requires_complete_words': requires_words,
            'candidate_breadth_threshold': 2 if requires_words else 5,
            'candidate_breadth_met': len(families) >= (2 if requires_words else 5),
            'qualified_usable_materials': 0,
            'qualification_gap': 'sound, phrase, lyric semantics and dramatic usage not yet independently reviewed',
            'basis': 'publisher_metadata_retrieval_hypothesis_not_conflict_or_sound_acceptance'})
    with sqlite3.connect(publication['library']['path']) as database:
        integrity = database.execute('PRAGMA integrity_check').fetchone()[0]
        stored_assets = database.execute('SELECT COUNT(*) FROM assets').fetchone()[0]
        stored_windows = database.execute('SELECT COUNT(*) FROM segments').fetchone()[0]
    return {'kind': 'music_pack_readiness_actual_audit', 'publication': {'path': str(file), 'sha256': sha},
        'counts': counts, 'sqlite_integrity': integrity,
        'stored_asset_count_matches': stored_assets == counts['recording_files'],
        'stored_window_count_matches': stored_windows == counts['source_windows'],
        'source_groups': dict(Counter(row.get('source_collection', row.get('artist', 'unknown')) for row in assets)),
        'all_recordings_decoded': all(row.get('full_decode', {}).get('exit_code') == 0 for row in assets),
        'review_claims': {'sound_approved_windows': 0, 'usage_approved_windows': 0,
            'qualified_lyrics_windows': 0, 'production_approved_packs': 0},
        'needs': rows, 'publisher_breadth_met': sum(row['candidate_breadth_met'] for row in rows),
        'material_acceptance_passed': False,
        'gaps': ['independent actual sound/cleanliness review', 'complete lyrics and phrase boundaries',
            'dramatic usage and forbidden contexts', 'popular short-drama original-song acquisition remains separate'],
        'model_calls': 0, 'paid_calls': 0}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--publication', required=True); parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', required=True); args = parser.parse_args()
    result = audit({'path': args.publication, 'sha256': args.sha256}); write_json(args.output, result)
    print(json.dumps({'counts': result['counts'], 'publisher_breadth_met': result['publisher_breadth_met'],
        'material_acceptance_passed': result['material_acceptance_passed']}, ensure_ascii=False))


if __name__ == '__main__': main()
