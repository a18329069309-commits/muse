"""Resumable anonymous official catalog research; never fetches media."""
import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

BASE = "https://hongguoduanju.com"
INDEX = BASE + "/sitemap/hongguoduanju/index.xml"
IMPORTANT = BASE + "/seo-important.xml"
THRESHOLD = 2_000_000
OFFICIAL_HOSTS = {"hongguoduanju.com", "www.hongguoduanju.com"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def official_page(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in OFFICIAL_HOSTS
            or parsed.username or parsed.password or parsed.fragment):
        raise ValueError("official_https_page_required")
    if parsed.query and not re.fullmatch(r"series_id=\d+", parsed.query):
        raise ValueError("only_public_series_id_query_allowed")
    return url


def router_page(body):
    text = body.decode("utf-8")
    marker = "_ROUTER_DATA = "
    start = text.find(marker)
    if start < 0:
        raise ValueError("official_router_data_missing")
    data, _ = json.JSONDecoder().raw_decode(text, start + len(marker))
    return next((v for v in data.get("loaderData", {}).values() if isinstance(v, dict)), {})


def integer(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+", value):
        return int(value)
    return None


def parse_card(body, series_id, retrieved_at):
    page = router_page(body)
    detail, social = page.get("seriesDetail", {}), page.get("seriesSocialInfo", {})
    if str(detail.get("series_id")) != series_id or not detail.get("series_name"):
        raise ValueError("official_series_identity_missing_or_mismatched")
    favorite = integer(social.get("series_favorite_count"))
    return {
        "series_id": series_id, "work_id": "hongguo-series-" + series_id,
        "title": detail["series_name"], "source_url": BASE + "/detail?series_id=" + series_id,
        "source_authority": "official_operator_website", "retrieved_at": retrieved_at,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "favorite_count_raw": social.get("series_favorite_count"), "favorite_count": favorite,
        "favorite_statistic_date": None, "favorite_date_basis": "retrieval_time_only_no_statistic_timestamp",
        "threshold_status": "unknown" if favorite is None else "exceeds" if favorite > THRESHOLD else "not_exceeds",
        "favorite_evidence_type": "current_official_card",
        "episode_count": integer(detail.get("episode_cnt")),
        "web_accessible_episode_count": integer(detail.get("accessible_episode_cnt")),
        "tags": detail.get("tags", []), "synopsis": detail.get("series_intro"),
        "heat_is_not_favorite": True, "media_status": "metadata_only",
        "sound_observation_status": "not_observed", "series_complete": False,
    }


def parse_sitemap(body):
    root = ET.fromstring(body)
    rows = []
    for entry in root:
        values = {child.tag.split("}")[-1]: child.text for child in entry}
        if values.get("loc"):
            rows.append({"url": official_page(values["loc"]), "lastmod": values.get("lastmod")})
    return root.tag.split("}")[-1], rows


def retry_after(value, current=None):
    if not value:
        return 30.0
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - (current or time.time()))
        except (TypeError, ValueError, OverflowError):
            return 30.0


def request(url):
    official_page(url)
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; public-catalog-research/1.0)"})
    with urlopen(req, timeout=30) as response:
        official_page(response.geturl())
        return response.read(), response.status


class RateLimited(Exception):
    pass


class Collector:
    def __init__(self, output, interval=1.0, fetcher=request, sleeper=time.sleep):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.output / "hongguo-catalog.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS requests(url TEXT PRIMARY KEY,kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
          checked_at TEXT,error TEXT,result_json TEXT);
        CREATE TABLE IF NOT EXISTS series(series_id TEXT PRIMARY KEY,priority INTEGER NOT NULL DEFAULT 2,
          record_json TEXT);
        CREATE TABLE IF NOT EXISTS provenance(series_id TEXT,sitemap_url TEXT,lastmod TEXT,
          PRIMARY KEY(series_id,sitemap_url));
        CREATE TABLE IF NOT EXISTS known_works(work_id TEXT PRIMARY KEY,record_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',series_id TEXT);
        CREATE TABLE IF NOT EXISTS history(series_id TEXT,evidence_hash TEXT,evidence_json TEXT,
          PRIMARY KEY(series_id,evidence_hash));
        """)
        self.interval, self.fetcher, self.sleeper = max(0.1, interval), fetcher, sleeper
        self.last_request = 0.0

    def close(self):
        self.db.close()

    def fetch_parsed(self, url, kind, parser):
        official_page(url)
        self.db.execute("INSERT OR IGNORE INTO requests(url,kind) VALUES(?,?)", (url, kind))
        self.db.commit()
        row = self.db.execute("SELECT * FROM requests WHERE url=?", (url,)).fetchone()
        if row["status"] == "done":
            return json.loads(row["result_json"])
        while row["attempts"] < 2:
            self.sleeper(max(0, self.interval - (time.monotonic() - self.last_request)))
            checked_at = now()
            self.db.execute("UPDATE requests SET attempts=attempts+1,checked_at=?,status='running' WHERE url=?", (checked_at, url))
            self.db.commit()
            try:
                self.last_request = time.monotonic()
                body, status = self.fetcher(url)
                if status != 200:
                    raise ValueError("http_" + str(status))
                result = parser(body, checked_at)
                self.db.execute("UPDATE requests SET status='done',error=NULL,result_json=? WHERE url=?", (dump(result), url))
                self.db.commit()
                return result
            except HTTPError as error:
                reason = "http_" + str(error.code)
                limited = error.code == 429
                delay = retry_after(error.headers.get("Retry-After")) if limited else self.interval
            except (URLError, TimeoutError, OSError):
                reason, limited, delay = "network_failure", False, self.interval
            except (ValueError, KeyError, ET.ParseError, UnicodeError):
                reason, limited, delay = "invalid_official_response", False, self.interval
            row = self.db.execute("SELECT * FROM requests WHERE url=?", (url,)).fetchone()
            self.db.execute("UPDATE requests SET status=?,error=? WHERE url=?",
                            ("stopped" if row["attempts"] >= 2 else "pending", reason, url))
            self.db.commit()
            if limited and (delay > 60 or row["attempts"] >= 2):
                raise RateLimited("official_rate_limit_stop")
            if row["attempts"] < 2:
                self.sleeper(delay)
        return None

    def add_series(self, series_id, priority=2):
        if not re.fullmatch(r"\d+", str(series_id)):
            raise ValueError("numeric_series_id_required")
        self.db.execute("INSERT INTO series(series_id,priority) VALUES(?,?) ON CONFLICT(series_id) DO UPDATE SET priority=min(priority,excluded.priority)", (series_id, priority))

    def enumerate(self):
        def parser(body, _):
            kind, entries = parse_sitemap(body)
            return {"kind": kind, "entries": entries, "sha256": hashlib.sha256(body).hexdigest()}
        index = self.fetch_parsed(INDEX, "sitemap_index", parser)
        if not index or index["kind"] != "sitemapindex":
            return
        children = [entry["url"] for entry in index["entries"]] + [IMPORTANT]
        for url in children:
            completed = self.db.execute("SELECT 1 FROM requests WHERE url=? AND status='done'", (url,)).fetchone()
            if completed and self.db.execute("SELECT 1 FROM provenance WHERE sitemap_url=? LIMIT 1", (url,)).fetchone():
                continue
            result = self.fetch_parsed(url, "sitemap", parser)
            if result is None:
                continue
            for entry in result["entries"]:
                match = re.fullmatch(r"https://(?:www\.)?hongguoduanju.com/detail\?series_id=(\d+)", entry["url"])
                if match:
                    series_id = match[1]
                    self.add_series(series_id, 1 if url == IMPORTANT else 2)
                    self.db.execute("INSERT OR IGNORE INTO provenance VALUES(?,?,?)", (series_id, url, entry["lastmod"]))
            self.db.commit()
            self.save_progress()
            print(dump({"event": "sitemap_enumerated", "source": url, "url_count": len(result["entries"]),
                        "indexed_unique_series_so_far": self.db.execute("SELECT count(DISTINCT series_id) FROM provenance").fetchone()[0]}), flush=True)

    def register_known(self, filename):
        document = json.loads(Path(filename).read_text(encoding="utf-8-sig"))
        for work in document.get("works", []):
            if not work.get("work_id") or not work.get("title") or not work.get("official_source"):
                raise ValueError("known_work_requires_title_id_and_official_attribution")
            self.db.execute("INSERT OR IGNORE INTO known_works(work_id,record_json) VALUES(?,?)", (work["work_id"], dump(work)))
            source_url = work["official_source"].get("url", "")
            match = re.search(r"https://(?:www\.)?hongguoduanju.com/(?:player/|detail\?series_id=)(\d+)", source_url)
            if match:
                self.add_series(match[1], 0)
                self.db.execute("UPDATE known_works SET status='matched',series_id=? WHERE work_id=?", (match[1], work["work_id"]))
        self.db.commit()

    def resolve_known(self):
        for row in self.db.execute("SELECT * FROM known_works WHERE status IN ('pending','ambiguous')").fetchall():
            work = json.loads(row["record_json"])
            titles = {work["title"], *work.get("aliases", [])}
            url = BASE + "/search/" + quote(work["title"], safe="")
            def parser(body, checked_at):
                matches = []
                for item in router_page(body).get("searchList", []):
                    data = item.get("video_data", {})
                    if item.get("name") in titles and re.fullmatch(r"\d+", str(data.get("series_id", ""))):
                        matches.append({"series_id": str(data["series_id"]), "title": item["name"]})
                return {"matches": list({m["series_id"]: m for m in matches}.values()), "retrieved_at": checked_at,
                        "body_sha256": hashlib.sha256(body).hexdigest()}
            result = self.fetch_parsed(url, "known_title_search", parser)
            matches = result["matches"] if result else []
            series_id = matches[0]["series_id"] if len(matches) == 1 else None
            status = "matched" if series_id else "ambiguous" if matches else "unknown"
            self.db.execute("UPDATE known_works SET status=?,series_id=?,record_json=? WHERE work_id=?",
                            (status, series_id, dump({**work, "title_candidate_matches": matches}), row["work_id"]))
            for candidate in matches:
                self.add_series(candidate["series_id"], 0)
            self.db.commit()
            self.save_progress()

    def add_history(self, filename):
        document = json.loads(Path(filename).read_text(encoding="utf-8-sig"))
        for item in document.get("favorite_evidence", []):
            if (item.get("source_authority") != "official" or integer(item.get("favorite_count_raw")) is None
                    or not item.get("evidence_date") or not item.get("source_url") or not item.get("evidence_file")):
                raise ValueError("historical_favorite_requires_official_raw_count_date_and_bound_evidence_file")
            evidence_file = Path(item["evidence_file"]["path"])
            actual = hashlib.sha256(evidence_file.read_bytes()).hexdigest()
            if actual != item["evidence_file"].get("sha256"):
                raise ValueError("historical_evidence_file_changed")
            series_id = str(item["series_id"])
            self.add_series(series_id, 0)
            self.db.execute("INSERT OR IGNORE INTO history VALUES(?,?,?)", (series_id, hashlib.sha256(dump(item).encode()).hexdigest(), dump(item)))
        self.db.commit()

    def collect_cards(self, limit=500):
        rows = self.db.execute("SELECT s.series_id FROM series s LEFT JOIN requests r ON r.url=?||s.series_id WHERE s.record_json IS NULL AND (r.status='done' OR coalesce(r.attempts,0)<2) ORDER BY s.priority,s.series_id LIMIT ?", (BASE + "/detail?series_id=", limit)).fetchall()
        for index, row in enumerate(rows, 1):
            series_id = row["series_id"]
            result = self.fetch_parsed(BASE + "/detail?series_id=" + series_id, "card", lambda body, checked_at: parse_card(body, series_id, checked_at))
            if result:
                self.db.execute("UPDATE series SET record_json=? WHERE series_id=?", (dump(result), series_id))
                self.db.commit()
            if index % 25 == 0 or index == len(rows):
                self.save_progress()
                print(dump({"event": "card_batch_progress", "processed_in_batch": index, "batch_size": len(rows)}), flush=True)

    def save_progress(self):
        save(self.output / "hongguo-progress.json", {"generated_at": now(),
             "sitemap_shards_enumerated": self.db.execute("SELECT count(*) FROM requests WHERE kind='sitemap' AND status='done' AND url!=?", (IMPORTANT,)).fetchone()[0],
             "indexed_unique_series": self.db.execute("SELECT count(DISTINCT series_id) FROM provenance").fetchone()[0],
             "known_title_statuses": dict(self.db.execute("SELECT status,count(*) FROM known_works GROUP BY status")),
             "card_requests_done": self.db.execute("SELECT count(*) FROM series WHERE record_json IS NOT NULL").fetchone()[0],
             "all_favorite_cards_filtered": False, "media_downloaded_by_collector": False})

    def export(self):
        counts = {"indexed_unique_series": self.db.execute("SELECT count(DISTINCT series_id) FROM provenance").fetchone()[0],
                  "candidate_unique_series": self.db.execute("SELECT count(*) FROM series").fetchone()[0],
                  "known_works": self.db.execute("SELECT count(*) FROM known_works").fetchone()[0]}
        counts["known_title_statuses"] = dict(self.db.execute("SELECT status,count(*) FROM known_works GROUP BY status"))
        known_candidates = set()
        with (self.output / "tinghuadao-verified-scope.jsonl").open("w", encoding="utf-8") as known_scope:
            for row in self.db.execute("SELECT * FROM known_works ORDER BY work_id"):
                work = json.loads(row["record_json"])
                candidates = work.get("title_candidate_matches", [])
                if row["series_id"]:
                    known_candidates.add(row["series_id"])
                known_candidates.update(candidate["series_id"] for candidate in candidates)
                known_scope.write(dump({**work, "membership_basis": "verified_tinghuadao_catalog",
                    "hongguo_title_match_status": row["status"], "hongguo_series_id": row["series_id"],
                    "title_match_is_not_ownership_verification": True}) + "\n")
        checked_ids = {row[0] for row in self.db.execute("SELECT series_id FROM series WHERE record_json IS NOT NULL")}
        counts["known_title_candidate_ids"] = len(known_candidates)
        counts["known_title_candidates_checked"] = len(known_candidates & checked_ids)
        index_row = self.db.execute("SELECT result_json FROM requests WHERE url=? AND status='done'", (INDEX,)).fetchone()
        expected = len(json.loads(index_row[0])["entries"]) if index_row else None
        completed = self.db.execute("SELECT count(*) FROM requests WHERE kind='sitemap' AND status='done' AND url!=?", (IMPORTANT,)).fetchone()[0]
        counts.update({"sitemap_shards_expected": expected, "sitemap_shards_enumerated": completed,
                       "card_requests_done": 0, "current_favorite_exceeds_threshold": 0,
                       "current_favorite_unknown": 0, "current_favorite_not_exceeds": 0,
                       "historical_only_members": 0, "scope_members": 0})
        history = {}
        for row in self.db.execute("SELECT * FROM history"):
            evidence = json.loads(row["evidence_json"])
            if integer(evidence["favorite_count_raw"]) > THRESHOLD:
                history.setdefault(row["series_id"], []).append(evidence)
        with (self.output / "hongguo-public-id-coverage.jsonl").open("w", encoding="utf-8") as ids, (self.output / "hongguo-scope-members.jsonl").open("w", encoding="utf-8") as members, (self.output / "hongguo-pending.jsonl").open("w", encoding="utf-8") as pending:
            for row in self.db.execute("SELECT * FROM series ORDER BY priority,series_id"):
                record = json.loads(row["record_json"]) if row["record_json"] else None
                series_id, url = row["series_id"], BASE + "/detail?series_id=" + row["series_id"]
                req = self.db.execute("SELECT status,attempts,error FROM requests WHERE url=?", (url,)).fetchone()
                provenance = [dict(p) for p in self.db.execute("SELECT sitemap_url,lastmod FROM provenance WHERE series_id=?", (series_id,))]
                ids.write(dump({"series_id": series_id, "source_url": url, "provenance": provenance,
                                "favorite_status": record["threshold_status"] if record else "not_checked"}) + "\n")
                if record:
                    counts["card_requests_done"] += 1
                    counts[{"exceeds": "current_favorite_exceeds_threshold", "unknown": "current_favorite_unknown", "not_exceeds": "current_favorite_not_exceeds"}[record["threshold_status"]]] += 1
                if (record and record["threshold_status"] == "exceeds") or series_id in history:
                    member = {**(record or {"series_id": series_id, "source_url": url, "title": history[series_id][0].get("title"), "media_status": "metadata_only"}),
                              "membership_basis": "current_official_favorite" if record and record["threshold_status"] == "exceeds" else "historical_official_favorite",
                              "historical_favorite_evidence": history.get(series_id, [])}
                    members.write(dump(member) + "\n")
                    counts["scope_members"] += 1
                    counts["historical_only_members"] += int(member["membership_basis"] == "historical_official_favorite")
                if not record or record["threshold_status"] == "unknown":
                    pending.write(dump({"series_id": series_id, "source_url": url, "stage": "official_favorite_verification",
                                        "status": req["status"] if req else "pending", "attempts": req["attempts"] if req else 0,
                                        "reason": req["error"] if req and req["error"] else "favorite_missing" if record else "not_checked"}) + "\n")
        counts["favorite_cards_not_checked"] = counts["candidate_unique_series"] - counts["card_requests_done"]
        manifest = {"schema_version": 1, "generated_at": now(), "scope": "official_public_index_plus_verified_tinghuadao_and_historical_evidence",
                    "threshold": {"field": "series_favorite_count", "operator": ">", "value": THRESHOLD, "heat_not_used": True},
                    "scope_members_count_basis": "hongguo_favorite_threshold_members_only_known_tinghuadao_count_is_separate",
                    "counts": counts, "sitemap_enumeration_complete": expected is not None and completed == expected,
                    "all_favorite_cards_filtered": expected is not None and completed == expected
                    and counts["candidate_unique_series"] > 0 and counts["favorite_cards_not_checked"] == 0 and counts["current_favorite_unknown"] == 0,
                    "app_full_catalog_proven": False, "all_media_complete": False, "anonymous_no_cookies": True,
                    "files": {"database": str(self.output / "hongguo-catalog.sqlite"), "ids": str(self.output / "hongguo-public-id-coverage.jsonl"),
                              "members": str(self.output / "hongguo-scope-members.jsonl"), "pending": str(self.output / "hongguo-pending.jsonl")}}
        manifest["files"]["verified_tinghuadao"] = str(self.output / "tinghuadao-verified-scope.jsonl")
        save(self.output / "hongguo-manifest.json", manifest)
        save(self.output / "tinghuadao-title-mapping.json", {"generated_at": now(), "works": [{**json.loads(r["record_json"]), "hongguo_match_status": r["status"], "hongguo_series_id": r["series_id"]} for r in self.db.execute("SELECT * FROM known_works ORDER BY work_id")]})
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--known-works")
    parser.add_argument("--history")
    parser.add_argument("--cards-limit", type=int, default=500)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--stage", choices=("all", "enumerate", "resolve", "cards"), default="all")
    args = parser.parse_args()
    if args.cards_limit < 0:
        parser.error("cards-limit must be nonnegative")
    collector = Collector(args.output, args.interval)
    try:
        if args.known_works:
            collector.register_known(args.known_works)
        if args.history:
            collector.add_history(args.history)
        try:
            if not args.offline:
                if args.stage in ("all", "enumerate"):
                    collector.enumerate()
                if args.stage in ("all", "resolve"):
                    collector.resolve_known()
                if args.stage in ("all", "cards"):
                    collector.collect_cards(args.cards_limit)
        except RateLimited:
            print(dump({"event": "stopped", "reason": "official_rate_limit_stop"}), flush=True)
        finally:
            result = collector.export()
        print(dump(result), flush=True)
    finally:
        collector.close()


if __name__ == "__main__":
    main()
