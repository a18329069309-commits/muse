"""Read FMA/MTG source tags from SQLite; metadata discovery never qualifies audio."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import time


def _schema_matches(db, source):
    required = {
        "fma": {"source_tracks": {"source_track_id", "metadata_sha256", "title", "artist", "album",
                                 "license_text", "license_class", "duration_seconds"},
                "genres": {"genre_id", "title", "parent_id"},
                "track_genres": {"source_track_id", "genre_id", "listed_all"}},
        "mtg": {"source_tracks": {"source_track_id", "metadata_sha256", "source_artist_id", "source_album_id",
                                  "source_archive_path", "duration_seconds", "audio_download_status"},
                "tags": {"tag", "tag_kind", "tag_value"}, "track_tags": {"source_track_id", "tag"}},
    }
    return all(columns <= {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
               for table, columns in required[source].items())


def _search_one(source, path, tags, limit):
    started = time.perf_counter()
    result = {"source": source, "status": "source_unavailable", "matched_metadata_tracks": 0,
              "candidates": [], "source_catalog_only": True, "metadata_reparsed": False}
    if not path.is_file():
        return {**result, "reason": "database_missing"}
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            if not _schema_matches(db, source):
                return {**result, "reason": "unrecognized_schema"}
            predicates, parameters, tag_semantics = [], [], "exact_official_source_tag"
            for tag in tags:
                if source == "mtg":
                    predicates.append("t.source_track_id IN (SELECT source_track_id FROM track_tags WHERE tag=?)")
                    parameters.append(tag)
                else:
                    kind, _, value = tag.partition("---")
                    if kind != "genre":
                        return {**result, "status": "source_tag_unavailable", "reason": "fma_has_only_official_genres"}
                    genre = db.execute("SELECT genre_id FROM genres WHERE title=? COLLATE NOCASE", (value,)).fetchone()
                    if genre is None:
                        predicates.append("0")
                        continue
                    predicates.append("""t.source_track_id IN (
                        WITH RECURSIVE subtree(genre_id) AS (SELECT ? UNION
                          SELECT g.genre_id FROM genres g JOIN subtree s ON g.parent_id=s.genre_id)
                        SELECT r.source_track_id FROM subtree s JOIN track_genres r
                          ON r.genre_id=s.genre_id AND r.listed_all=1)""")
                    parameters.append(genre["genre_id"])
                    tag_semantics = "official_genre_and_descendants; title_case_insensitive"
            predicate = " WHERE " + " AND ".join(predicates) if predicates else ""
            count = db.execute("SELECT count(*) FROM source_tracks t" + predicate, parameters).fetchone()[0]
            fields = ("source_track_id,metadata_sha256,title,artist,album,duration_seconds,license_text,license_class"
                      if source == "fma" else "source_track_id,metadata_sha256,source_artist_id,source_album_id,"
                      "source_archive_path,duration_seconds")
            candidates = []
            for row in db.execute("SELECT " + fields + " FROM source_tracks t" + predicate
                                  + " ORDER BY source_track_id LIMIT ?", [*parameters, limit]):
                candidate = dict(row)
                track_id = candidate["source_track_id"]
                if source == "fma":
                    source_tags = ["genre---" + row[0] for row in db.execute(
                        "SELECT g.title FROM genres g JOIN track_genres r ON r.genre_id=g.genre_id "
                        "WHERE r.source_track_id=? AND r.listed_all=1 ORDER BY g.title", (track_id,))]
                else:
                    source_tags = [row[0] for row in db.execute(
                        "SELECT tag FROM track_tags WHERE source_track_id=? ORDER BY tag", (track_id,))]
                candidate.update({"source": source, "catalog_candidate_id": f"{source}:{track_id}",
                    "source_tags": source_tags, "scope": "source_catalog_only",
                    "audio_download_status": "not_downloaded", "local_audio_path": None,
                    "audition": "not_performed", "clap_embedding": "not_performed",
                    "qualification_state": "metadata_discovered", "role_tag_status": "not_audio_semantic_annotated",
                    "artistic_approval": False})
                if source == "fma":
                    candidate["license_class_scope"] = "historical_commercial_screen_not_research_exclusion"
                else:
                    candidate["recording_license_status"] = "source_verification_pending"
                candidates.append(candidate)
            result.update({"status": "catalog_results", "matched_metadata_tracks": count,
                           "candidates": candidates, "tag_semantics": tag_semantics,
                           "query_ms": (time.perf_counter() - started) * 1000})
            return result
    except sqlite3.Error:
        return {**result, "reason": "database_unreadable"}


def search_source_catalog(sources, tags=None, limit=5):
    """Return source metadata only. Tags are ANDed; limit applies to each source."""
    if not isinstance(sources, dict) or not sources or any(name not in {"fma", "mtg"} for name in sources):
        raise ValueError("sources must be a nonempty mapping of fma/mtg to SQLite paths")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    tags = [] if tags is None else tags
    if not isinstance(tags, (list, tuple)) or any(not isinstance(tag, str) or "---" not in tag
            or not tag.partition("---")[2] or tag.partition("---")[0] not in {"genre", "instrument", "mood/theme"}
            for tag in tags):
        raise ValueError("tags must be official source tags such as genre---electronic or mood/theme---epic")
    return {"schema_version": 1, "usage_scope": "research_noncommercial", "scope": "source_catalog_only",
        "requested_source_tags": list(tags), "limit_per_source": limit,
        "audio_download_status": "not_downloaded", "automatic_downloads": 0,
        "audio_audition": "not_performed", "artistic_approval": False,
        "role_tag_status": "not_audio_semantic_annotated", "metadata_reparsed": False,
        "license_policy": "source metadata attribute; research does not exclude NC by default",
        "results": [_search_one(name, Path(path), tags, limit) for name, path in sources.items()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fma-db", help="Existing FMA discovery SQLite")
    parser.add_argument("--mtg-db", help="Existing MTG discovery SQLite")
    parser.add_argument("--tag", action="append", default=[], help="Official tag, e.g. mood/theme---energetic; AND")
    parser.add_argument("--limit", type=int, default=5, help="Maximum metadata candidates per source")
    arguments = parser.parse_args()
    sources = {name: path for name, path in (("fma", arguments.fma_db), ("mtg", arguments.mtg_db)) if path}
    try:
        print(json.dumps(search_source_catalog(sources, arguments.tag, arguments.limit), ensure_ascii=False, indent=2))
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
