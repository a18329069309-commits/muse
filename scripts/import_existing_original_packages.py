"""Make existing reviewed original windows visible in a new standard consumer snapshot.

No music discovery, models, new reviews, target edits, or qualification changes occur.
Each imported window is revalidated by the existing reviewed-material publisher.
"""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

import case_preset_store as store
import case_text_recall
import publish_reviewed_materials as publisher
import segment_library
from registered_library_connection import readonly_registered_library


def read(reference):
    checked = store.file_binding(reference, Path('.'))
    return json.loads(Path(checked['path']).read_text(encoding='utf-8-sig'))


def backup(source, destination):
    with closing(store.readonly(source)) as current, closing(sqlite3.connect(destination)) as target:
        current.backup(target)


def preset_story(value):
    # The existing publisher attaches material refs; those are not changes to the case's story.
    return {**value, 'steps': [{key: item for key, item in step.items()
        if key not in ('music_pack_ids', 'window_refs', 'sound_pack_ids', 'member_refs')}
        for step in value.get('steps', [])]}


def archived_identity(reference, restorations):
    replacement = next((row['restored'] for row in restorations if row['historical'] == reference), None)
    if replacement is None:
        return reference
    old, new = read(reference), read(replacement)
    if (new.get('historical_identity_before_archive_restoration') != reference
        or not new.get('archive_reference_restoration')
        or any(new.get(key) != value for key, value in old.items() if key != 'identification_result')):
        raise ValueError('existing_original_archive_restoration_cannot_change_identity_facts')
    # The strict current original-recording validator rechecks the restored files below.
    return replacement


def collect_input(item, base_cases):
    publication, config = read(item['publication']), read(item['publisher_config'])
    if publication.get('kind') != 'frozen_offline_human_reviewed_materials':
        raise ValueError('existing_reviewed_publication_required')
    source_library = publication['library_db']
    store.file_binding(source_library, Path('.'))
    store.file_binding(publication['cases_db'], Path('.'))
    configured_library = publisher.binding(Path(item['publisher_config']['path']).parent / config['library_db'])
    if source_library != configured_library:
        raise ValueError('existing_publication_library_config_mismatch')
    reviews, assets, segments = [], {}, {}
    with closing(store.readonly(publication['cases_db']['path'])) as published, closing(store.readonly(base_cases)) as base:
        library_input = source_library if Path(source_library['path']).suffix.lower() == '.json' else source_library['path']
        with closing(readonly_registered_library(library_input)) as library:
            for review in config.get('reviews', []):
                if review.get('kind', 'music') != 'music' or review.get('source_relation') not in (
                        'reviewed_reference_match', 'reviewed_same_recording_window'):
                    raise ValueError('existing_verified_original_window_required')
                receipt = next((row for row in publication['reviews'] if row['case_id'] == review['case_id']
                    and row['pack_id'] == review['pack_id'] and row['window_id'] == review['window_id']), None)
                window_row = published.execute('SELECT p.status,p.source_sha256,w.record_json FROM packs p '
                    'JOIN windows w USING(pack_id) WHERE p.pack_id=? AND w.window_id=?',
                    (review['pack_id'], review['window_id'])).fetchone()
                if not receipt or not window_row:
                    raise ValueError('existing_publication_window_missing')
                window = json.loads(window_row[2])
                if (window_row[0] != 'approved' or window['segment_id'] != review['segment_id']
                    or receipt['review_record'] != review['review_record']
                    or receipt['source_range'] != review['source_range'] or window['source_range'] != review['source_range']
                    or window.get('source_relation') != review['source_relation']
                    or window.get('original_recording_evidence') != review.get('original_recording_evidence')):
                    raise ValueError('existing_publication_review_mapping_mismatch')
                old_case = published.execute('SELECT record_json FROM cases WHERE case_id=?', (review['case_id'],)).fetchone()
                new_case = base.execute('SELECT record_json FROM cases WHERE case_id=?', (review['case_id'],)).fetchone()
                if not old_case or not new_case:
                    raise ValueError('existing_original_reference_case_missing_from_base')
                old, new = json.loads(old_case[0]), json.loads(new_case[0])
                if any(old.get(key) != new.get(key) for key in ('episode_id', 'source_range', 'conditions',
                        'description', 'story_sequence')) or preset_story(old.get('development_preset', {})) != preset_story(new.get('development_preset', {})):
                    raise ValueError('existing_original_reference_case_definition_changed')
                found = library.execute('SELECT * FROM segments WHERE segment_id=?', (review['segment_id'],)).fetchone()
                if not found or found['asset_id'] != review['asset_id'] or found['source_sha256'] != window_row[1]:
                    raise ValueError('existing_original_registered_window_mismatch')
                segment, asset = json.loads(found['record_json']), json.loads(library.execute(
                    'SELECT record_json FROM assets WHERE asset_id=?', (review['asset_id'],)).fetchone()[0])
                publisher.human_review(review['review_record'], Path('.'), found['source_sha256'],
                                       review['source_range'], review['case_id'], 'music')
                restored = archived_identity(review['original_recording_evidence'], item.get('identity_archive_restorations', []))
                identity_item = {**review, 'original_recording_evidence': restored,
                    'human_review_record': review['review_record'],
                    'library_allowed_source_range': [found['start_s'], found['end_s']]}
                episode = json.loads(base.execute('SELECT record_json FROM episodes WHERE episode_id=?', (new['episode_id'],)).fetchone()[0])
                publisher.music_source_identity(identity_item, new, episode, found['source_sha256'], review['source_range'], Path('.'))
                assets[asset['asset_id']] = asset
                segments[segment['segment_id']] = segment
                reviews.append({**review, 'original_recording_evidence': restored})
    if not reviews or len(reviews) != publication['published_counts']['music_windows']:
        raise ValueError('existing_original_publication_reviews_incomplete')
    return reviews, assets, segments


def verify_consumer(publication, imported, out):
    """Exercise existing recall and case routing; this is not a new target-fit verdict."""
    cases, library = publication['cases_db'], publication['library_db']
    checked = []
    with closing(store.readonly(cases['path'])) as db:
        for index, item in enumerate(imported):
            raw = db.execute('SELECT record_json FROM cases WHERE case_id=?', (item['case_id'],)).fetchone()[0]
            case = json.loads(raw)
            episode = json.loads(db.execute('SELECT record_json FROM episodes WHERE episode_id=?', (case['episode_id'],)).fetchone()[0])
            case_binding = {'database': cases, 'case_id': item['case_id'], 'record_sha256': hashlib.sha256(raw.encode()).hexdigest()}
            cue = {'cue_id': 'existing-reference-consumer-probe', 'function': case['conditions']['narrative_function'],
                   'case_conditions': case['conditions'], 'story_sequence': case['story_sequence']}
            pool = publisher.write_new(out / f'consumer-pool-{index}.json', {'schema_version': 1,
                'source_video_sha256': episode['source_video']['sha256'], 'case_db': cases,
                'cues': [{'cue_id': cue['cue_id'], 'candidate_cases': [case_binding]}], 'production_approval': False})
            request = {'schema_version': 2, 'source_video_sha256': episode['source_video']['sha256'],
                'store_sha256': cases['sha256'], 'usage_scope': 'research_noncommercial', 'limit': 20, 'cues': [cue]}
            recalled = case_text_recall.recall(cases['path'], request, out / 'consumer-fts.sqlite', pool)
            exported = recalled['cues'][0]['candidates'][0]
            routes = store.query_store(cases['path'], {**request, 'limit': 50}, library['path'])
            match = next((candidate for route in routes['routes'] if route['case_ids'] == [item['case_id']]
                and route['music_pack_id'] == item['pack_id'] for candidate in route['source_candidates']
                if candidate['segment_id'] == item['segment_id']), None)
            if (exported['reference_case_binding'] != case_binding or not match
                or match['source_range'] != item['source_range']
                or match['original_recording_evidence'] != item['original_recording_evidence']
                or match['human_review_record'] != item['review_record']
                or match['applicability']['source_integrity_verified'] is not True
                or match['applicability']['pack_listening_record_checked'] is not True):
                raise ValueError('existing_original_consumer_roundtrip_failed')
            checked.append({'reference_case_binding': exported['reference_case_binding'], 'candidate': match,
                'target_applicability_assessed': False, 'new_selection_performed': False})
    return publisher.write_new(out / 'consumer-verification.json', {'schema_version': 1,
        'status': 'existing_reference_packages_returned_by_actual_consumers', 'checked': checked,
        'new_global_approved_windows': 0, 'qualification_granted': False, 'production_approval': False})


def import_packages(config):
    if config.get('schema_version') != 1 or not config.get('inputs'):
        raise ValueError('existing_original_import_config_required')
    cases = store.file_binding(config['base_cases_db'], Path('.'))
    library = store.file_binding(config['base_library_db'], Path('.'))
    if Path(library['path']).suffix.lower() != '.sqlite':
        raise ValueError('standard_frozen_base_library_required')
    reviews, assets, segments = [], {}, {}
    if config.get('source_clock_evidence'):
        read(config['source_clock_evidence'])
    for item in config['inputs']:
        rows, new_assets, new_segments = collect_input(item, cases['path'])
        reviews.extend(rows); assets.update(new_assets); segments.update(new_segments)
    if len({(row['pack_id'], row['window_id']) for row in reviews}) != len(reviews):
        raise ValueError('duplicate_existing_original_window')
    out = Path(config['output_dir']).resolve(); out.mkdir(parents=True, exist_ok=False)
    merged = out / 'segments.sqlite'; backup(library['path'], merged)
    catalog = publisher.write_new(out / 'imported-assets.json', {'assets': list(assets.values())})
    windows = publisher.write_new(out / 'imported-segments.json', {'segments': list(segments.values())})
    imported = segment_library.import_library(merged, catalog['path'], windows['path'], rehash=True)
    publish_config = {'schema_version': 1, 'base_cases_db': cases['path'], 'library_db': str(merged),
        'output_dir': str(out / 'reviewed-publication'), 'reviews': reviews}
    publisher.write_new(out / 'publisher-config.json', publish_config)
    publication = publisher.publish(publish_config)
    verified = verify_consumer(publication, reviews, out)
    gaps = []
    if config.get('pending_inventory'):
        pending = read(config['pending_inventory'])
        known = {row['source_sha256'] for row in assets.values()}
        gaps = [{'source': row['source'], 'status': 'no_importable_reviewed_reference_package_supplied',
                 'original_identity_validated_by_this_import': False, 'Ready': False}
                for row in pending['recordings'] if row['source']['sha256'] not in known]
    if publisher.binding(cases['path']) != cases or publisher.binding(library['path']) != library:
        raise ValueError('existing_original_import_base_changed')
    for item in config['inputs']:
        read(item['publication']); read(item['publisher_config'])
    receipt = {'schema_version': 1, 'status': 'existing_original_reference_packages_registered_for_generic_consumer',
        'bases': {'cases_db': cases, 'library_db': library}, 'inputs': config['inputs'],
        'publication': publication['publication'], 'consumer': publication['consumer'],
        'consumer_verification': verified, 'library_import': imported, 'gaps': gaps,
        'source_clock_evidence': config.get('source_clock_evidence'),
        'source_clock_equivalence_granted_by_import': False,
        'existing_reviewed_windows_reconnected': len(reviews), 'new_global_approved_windows': 0,
        'recording_source_windows_expanded': False, 'current_target_approved': False,
        'model_calls': 0, 'new_human_reviews': 0, 'production_approval': False}
    publisher.write_new(out / 'import-receipt.json', receipt)
    publisher.write_new(out / 'profile-delta.json', {'consumer_publication': publication['publication'],
        'cases': publication['consumer']['cases'], 'library': publication['consumer']['library'],
        'profile_updated_by_import': False, 'new_global_approved_windows': 0})
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    result = import_packages(json.loads(args.config.read_text(encoding='utf-8-sig')))
    print(json.dumps({'status': result['status'], 'publication': result['publication'],
                      'existing_reviewed_windows_reconnected': result['existing_reviewed_windows_reconnected'],
                      'new_global_approved_windows': 0, 'remaining_inventory_gaps': len(result['gaps'])}))
