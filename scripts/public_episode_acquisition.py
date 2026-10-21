"""Acquire public The Paper episodes with resumable, bounded, verified downloads."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

SCHEMA = "public-episode-acquisition-v1"
LOCK = threading.Lock()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def public_url(url, hosts=("www.thepaper.cn", "imgpai.thepaper.cn", "api.thepaper.cn")):
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in hosts or p.username or p.password or p.query or p.fragment:
        raise ValueError("nonpublic_or_credential_url_rejected")
    return url


def fetch(url, body=None):
    public_url(url)
    data = None if body is None else json.dumps(body).encode()
    req = Request(url, data=data, headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"})
    with urlopen(req, timeout=40) as response:
        return response.read()


def parse_series(html):
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        raise ValueError("series_metadata_missing")
    return json.loads(match.group(1))["props"]["pageProps"]["detailData"]


def episode_rows(detail, work):
    info = detail["contentDetail"]
    programs = detail["programList"]
    expected = int(work["screenshot_episode_count"])
    if info["name"] != work["title"] or info["programNum"] != expected or len(programs) != expected:
        raise ValueError("identity_or_episode_count_mismatch")
    if sorted(int(p["index"]) for p in programs) != list(range(1, expected + 1)):
        raise ValueError("episode_ordinals_incomplete")
    if info.get("paywalled") or any(p.get("paywalled") for p in programs):
        raise ValueError("paywalled_series_rejected")
    urls = [public_url(p["videos"]["url"]) for p in programs]
    if len(set(urls)) != expected:
        raise ValueError("duplicate_episode_urls")
    return [dict(work_id=work["work_id"], title=work["title"], episode_number=int(p["index"]),
                 official_series_id=str(info["contId"]), official_episode_id=str(p["contId"]),
                 source_page=f'https://www.thepaper.cn/series_{info["contId"]}',
                 public_media_url=public_url(p["videos"]["url"]),
                 advertised_duration_seconds=p["videos"].get("durationNum"),
                 source_metadata_sha256=json_hash(p), status="pending", attempts=[])
            for p in programs]


def playlist_facts(body):
    if "#EXT-X-ENDLIST" not in body:
        raise ValueError("playlist_not_complete")
    if any("#EXT-X-KEY" in line and "METHOD=NONE" not in line for line in body.splitlines()):
        raise ValueError("encrypted_playlist_not_supported")
    durations = [float(n) for n in re.findall(r"#EXTINF:([0-9.]+)", body)]
    if not durations:
        raise ValueError("playlist_has_no_segments")
    return {"hls_duration_seconds": sum(durations), "segment_count": len(durations),
            "hls_sha256": hashlib.sha256(body.encode()).hexdigest()}


def verify_media(path, expected_duration, ffprobe, ffmpeg, runner=subprocess.run):
    result = runner([str(ffprobe), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    if result.returncode:
        raise ValueError("ffprobe_failed")
    probe = json.loads(result.stdout)
    kinds = {s["codec_type"] for s in probe.get("streams", [])}
    if not {"audio", "video"}.issubset(kinds):
        raise ValueError("required_audio_or_video_missing")
    duration = float(probe["format"]["duration"])
    if abs(duration - expected_duration) > max(2.0, expected_duration * 0.02):
        raise ValueError("duration_mismatch")
    decoded = runner([str(ffmpeg), "-nostdin", "-v", "error", "-xerror", "-i", str(path),
                      "-map", "0:v:0", "-map", "0:a:0", "-threads", "2", "-f", "null", "-"],
                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=max(180, expected_duration * 3))
    if decoded.returncode or decoded.stderr.strip():
        raise ValueError("full_decode_failed")
    return {"path": str(path), "bytes": Path(path).stat().st_size, "sha256": digest(path),
            "duration_seconds": duration, "full_decode_success": True,
            "streams": [{k: s[k] for k in ("codec_type", "codec_name", "width", "height", "sample_rate", "channels") if k in s}
                        for s in probe["streams"]]}


def safe_error(error):
    if isinstance(error, ValueError):
        return str(error)
    return type(error).__name__


def acquire_one(row, media_root, yt_dlp, ffprobe, ffmpeg, save, staging_root=None, backend="yt-dlp"):
    destination = Path(media_root) / row["work_id"] / f'episode-{row["episode_number"]:03d}'
    directory = (Path(staging_root) / row["work_id"] / f'episode-{row["episode_number"]:03d}') if staging_root else destination
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "episode.mp4"
    published = destination / "episode.mp4"
    if row.get("status") == "acquired_verified" and published.exists():
        if digest(published) == row.get("media", {}).get("sha256"):
            return
        row["status"] = "source_changed"
    interrupted = bool(row["attempts"] and row["attempts"][-1].get("status") == "running")
    if len(row["attempts"]) >= 2 and not interrupted:
        row["status"] = "failed_exhausted"
        save()
        return
    while len(row["attempts"]) < 2 or interrupted:
        if interrupted:
            item = row["attempts"][-1]
            attempt = item["number"]
            item.setdefault("resumed_at", []).append(time.time())
            interrupted = False
        else:
            attempt = len(row["attempts"]) + 1
            item = {"number": attempt, "started_at": time.time(), "status": "running",
                    "repair": None if attempt == 1 else "local_staging_for_network_filesystem_rename_and_timeout90_single_fragment"}
            item["backend"] = backend
            row["attempts"].append(item)
        row["status"] = "acquiring"
        save()
        try:
            source = public_url(row["public_media_url"])
            hls = fetch(source).decode("utf-8")
            facts = playlist_facts(hls)
            advertised = row.get("advertised_duration_seconds")
            if advertised and abs(facts["hls_duration_seconds"] - advertised) > max(3.0, advertised * 0.03):
                raise ValueError("playlist_duration_disagrees_with_official_metadata")
            (directory / f"playlist-attempt-{attempt}.m3u8").write_text(hls, encoding="utf-8")
            if attempt == 2 and target.exists():
                target.rename(directory / "invalid-attempt-1.mp4")
            if not target.exists():
                command = [str(yt_dlp), "--ignore-config", "--no-playlist", "--continue",
                           "--hls-prefer-native", "--abort-on-unavailable-fragments", "--retries", "0",
                           "--fragment-retries", "0", "--socket-timeout", "25" if attempt == 1 else "90",
                           "--concurrent-fragments", "2" if attempt == 1 else "1",
                           "--no-progress", "--no-warnings", "--no-colors", "--remux-video", "mp4",
                           "--ffmpeg-location", str(Path(ffmpeg).parent), "-o", str(target), source]
                if attempt == 2 and "HTTP Error 416" in row["attempts"][0].get("failure_markers", []):
                    command[command.index("--continue")] = "--no-continue"
                    item["repair"] = "fresh_transfer_after_http416_incompatible_fragment_resume"
                if backend == "ffmpeg":
                    command = [str(ffmpeg), "-nostdin", "-v", "error", "-xerror", "-y", "-rw_timeout", "90000000",
                               "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", str(target)]
                    item["method"] = "alternate_ffmpeg"
                result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                        errors="replace", timeout=max(1200, facts["hls_duration_seconds"] * 6))
                safe_log = re.sub(r'https?://[^\s]+', '<PUBLIC_URL>', result.stdout + result.stderr)
                (directory / f"downloader-attempt-{attempt}.log").write_text(safe_log, encoding="utf-8")
                # Inputs are credential-free public URLs. Keep only diagnosis markers in receipts.
                item["downloader_exit_code"] = result.returncode
                item["failure_markers"] = sorted(set(re.findall(r"HTTP Error \d{3}|timed out|fragment not found|Unable to download", result.stdout + result.stderr)))
                if result.returncode or not target.exists() or (backend == "ffmpeg" and result.stderr.strip()):
                    raise ValueError("download_failed")
            row["media"] = verify_media(target, facts["hls_duration_seconds"], ffprobe, ffmpeg)
            if target != published:
                destination.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(target, published)
                if digest(published) != row["media"]["sha256"]:
                    raise ValueError("published_copy_hash_mismatch")
                row["media"]["path"] = str(published)
                row["media"]["publication_verified_by_sha256"] = True
            row.update(facts)
            row["status"] = "acquired_verified"
            row["actual_audio_observed"] = False
            row["actual_video_observed"] = False
            row["distillation_status"] = "not_performed"
            item["status"] = "passed"
            item["finished_at"] = time.time()
            atomic_json(directory / "acquisition-receipt.json", row)
            if target != published:
                shutil.copyfile(directory / "acquisition-receipt.json", destination / "acquisition-receipt.json")
                target.unlink()
            save()
            print(json.dumps({"work_id": row["work_id"], "episode": row["episode_number"], "status": row["status"],
                              "path": str(published)}, ensure_ascii=False), flush=True)
            return
        except (ValueError, OSError, subprocess.SubprocessError, KeyError, json.JSONDecodeError) as error:
            item["status"] = "failed"
            item["failure"] = safe_error(error)
            item["finished_at"] = time.time()
            row["status"] = "failed_retryable" if attempt < 2 else "failed_exhausted"
            atomic_json(directory / "acquisition-receipt.json", row)
            save()
    print(json.dumps({"work_id": row["work_id"], "episode": row["episode_number"], "status": row["status"]}), flush=True)


def run(manifest_path, media_root, yt_dlp, ffprobe, ffmpeg, workers=2, only=None, backend="yt-dlp"):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    def save():
        with LOCK:
            statuses = [r["status"] for r in manifest["episodes"]]
            manifest["counts"] = {s: statuses.count(s) for s in sorted(set(statuses))}
            for work in manifest["works"]:
                members = [r for r in manifest["episodes"] if r["work_id"] == work["work_id"]]
                work["media_verified_count"] = sum(r["status"] == "acquired_verified" for r in members)
                work["all_episodes_media_verified"] = work["media_verified_count"] == work["expected_episodes"]
            manifest["updated_at"] = time.time()
            manifest["worker_pid"] = os.getpid()
            atomic_json(manifest_path, manifest)
    selected = [r for r in manifest["episodes"] if only is None or f'{r["work_id"]}:{r["episode_number"]}' in only]
    save()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        stage_name = "staging" if backend == "yt-dlp" else "staging-alternate-ffmpeg"
        futures = [pool.submit(acquire_one, r, media_root, yt_dlp, ffprobe, ffmpeg, save, manifest_path.parent / stage_name, backend) for r in selected]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    save()
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--media-root", required=True)
    parser.add_argument("--yt-dlp", required=True)
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--workers", type=int, choices=(1, 2), default=2)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--backend", choices=("yt-dlp", "ffmpeg"), default="yt-dlp")
    args = parser.parse_args()
    run(args.manifest, args.media_root, args.yt_dlp, args.ffprobe, args.ffmpeg, args.workers, args.only, args.backend)

