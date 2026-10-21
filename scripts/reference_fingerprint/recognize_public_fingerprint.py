"""Obtain one public-recording identity candidate, without qualification or retries."""
import argparse
import wave
import asyncio
import base64
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from shazamio import Shazam
from shazamio.interfaces.client import HTTPClientInterface
import shazamio.api
import shazamio.converter
import shazamio.misc
import shazamio_core

adapter_spec = importlib.util.spec_from_file_location("flick_public_adapter", Path(__file__).with_name("flick_public_adapter.py"))
flick_public_adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(flick_public_adapter)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(file):
    digest = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bind(file):
    return {"path": str(Path(file).resolve()), "sha256": file_hash(file)}


def save(file, value):
    with Path(file).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return bind(file)


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def verify_thepaper_public_acquisition(spec):
    """Only the verified public-episode receipt format exercised by this route."""
    receipt = read(spec["public_source_provenance"]["path"])
    media = receipt.get("media") or {}
    source = spec["source"]
    if (receipt.get("status") != "acquired_verified"
            or media.get("full_decode_success") is not True
            or media.get("publication_verified_by_sha256") is not True):
        raise ValueError("verified_public_acquisition_required")
    if (not media.get("path") or Path(media["path"]).resolve() != Path(source["path"]).resolve()
            or media.get("sha256") != source["sha256"]):
        raise ValueError("public_acquisition_source_identity_mismatch")
    reference = spec.get("public_reference") or {}
    keys = ("work_id", "episode_number", "official_series_id", "official_episode_id")
    if any(not reference.get(key) or reference[key] != receipt.get(key) for key in keys):
        raise ValueError("public_acquisition_reference_identity_mismatch")
    series = str(receipt["official_series_id"])
    page = urlsplit(receipt.get("source_page", ""))
    public_media = urlsplit(receipt.get("public_media_url", ""))
    if (not series.isdecimal() or spec.get("public_source_url") != receipt.get("source_page")
            or page.scheme != "https" or page.hostname != "www.thepaper.cn"
            or page.path != "/series_" + series or page.query or page.fragment
            or page.username is not None or page.password is not None
            or public_media.scheme != "https" or public_media.hostname != "imgpai.thepaper.cn"
            or not public_media.path.startswith("/shortplay/video-out/")
            or public_media.username is not None or public_media.password is not None
            or public_media.fragment):
        raise ValueError("verified_official_public_source_required")


def verify_public_acquisition(spec):
    return flick_public_adapter.dispatch_public_acquisition(spec, verify_thepaper_public_acquisition)


class RecognitionStopped(Exception):
    pass


class SinglePost(HTTPClientInterface):
    """No RetryClient, redirect, proxy environment, SDK retry or second HTTP request."""
    def __init__(self, directory, input_binding=None):
        self.directory = directory
        self.calls = 0
        self.http_status = None
        self.submission = None
        self.response = None
        self.input_binding = input_binding
        self.raw_response = None

    async def request(self, method, url, *args, **kwargs):
        if self.calls or method.upper() != "POST":
            raise RecognitionStopped("one_post_limit")
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.hostname != "amp.shazam.com":
            raise RecognitionStopped("unexpected_endpoint")
        payload = kwargs["json"]
        signature = payload["signature"]["uri"]
        signature_path = self.directory / "fingerprint-uri.txt"
        signature_path.write_text(signature, encoding="utf-8")
        # The compact signature is evidence; no raw video or PCM is sent.
        fingerprint = base64.b64decode(signature.split(",", 1)[1], validate=True)
        fingerprint_path = self.directory / "fingerprint.bin"
        fingerprint_path.write_bytes(fingerprint)
        payload_path = self.directory / 'http-request-payload.json'
        payload_path.write_bytes(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode())
        self.submission = save(self.directory / "submission.json", {
            'schema_version': 2, 'input': self.input_binding,
            'input_sha256': self.input_binding['sha256'] if self.input_binding else None,
            'request_payload': bind(payload_path),
            "service": "Shazam", "method": "POST", "endpoint_origin": "https://amp.shazam.com",
            "endpoint_path_template": "/discovery/v5/{language}/{country}/{device}/-/tag/{uuid}/{uuid}",
            "query_parameter_names": sorted(key.split("=", 1)[0] for key in parts.query.split("&")),
            "signature_uri": bind(signature_path), "fingerprint_binary": bind(fingerprint_path),
            "signature_samplems": payload["signature"].get("samplems"),
            "payload_sha256": sha(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()),
            "payload_keys": sorted(payload), "header_names": sorted(kwargs.get("headers", {})),
            "authorization_header_present": any(key.lower() == "authorization" for key in kwargs.get("headers", {})),
            "body_contains_raw_media": False, "client_uuid_values_recorded": False,
            "automatic_retries": 0, "per_sample_http_limit": 1, "proxy_environment_used": False,
        })
        self.calls += 1
        started = time.monotonic()
        timeout = aiohttp.ClientTimeout(total=35, connect=15)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            async with session.post(url, json=payload, headers=kwargs.get("headers"), allow_redirects=False) as response:
                self.http_status = response.status
                raw = await response.read()
                raw_path = self.directory / 'http-raw-response.json'
                with raw_path.open('xb') as stream:
                    stream.write(raw)
                self.raw_response = bind(raw_path)
                self.response = save(self.directory / "http-response-metadata.json", {
                    'schema_version': 2, 'raw_response': self.raw_response,
                    'input_sha256': self.input_binding['sha256'] if self.input_binding else None,
                    'request_payload': bind(payload_path),
                    "status": response.status, "content_type": response.headers.get("Content-Type"),
                    "bytes": len(raw), "raw_response_sha256": sha(raw),
                    "wall_seconds": time.monotonic() - started,
                })
                if response.status == 429:
                    raise RecognitionStopped("rate_limited_stop_all")
                if response.status != 200:
                    raise RecognitionStopped("http_status_" + str(response.status))
                return json.loads(raw)


def summarize_response(response, input_sha256=None, raw_response_sha256=None):
    track = response.get("track") or {}
    return {
        'input_sha256': input_sha256, 'raw_response_sha256': raw_response_sha256,
        "response_keys": sorted(response),
        "matches": [{key: row[key] for key in ("id", "offset", "timeskew", "frequencyskew") if key in row}
                    for row in response.get("matches", [])],
        "candidate": {key: track[key] for key in ("key", "title", "subtitle", "url", "isrc", "genres") if key in track} or None,
        "recording_metadata": [{"title": row.get("title"), "text": row.get("text")}
                               for section in track.get("sections", []) if section.get("type") == "SONG"
                               for row in section.get("metadata", [])],
        "candidate_status": "candidate_unverified" if track else "no_candidate",
        "source_match_verified": False, "lyrics_verified": False,
        "music_candidate_qualified": False, "production_approval": False,
    }



async def recognize_public_candidate(spec_file, output, consent=False):
    if consent is not True:
        raise ValueError("explicit_public_fingerprint_consent_required")
    spec = read(spec_file)
    source, window = spec["source"], spec["window_seconds"]
    provenance = spec["public_source_provenance"]
    if spec.get("source_kind") not in {"official_public_recording", "public_research_video"}:
        raise ValueError("public_research_source_required")
    if urlsplit(spec.get("public_source_url", "")).scheme != "https":
        raise ValueError("public_source_url_required")
    if (len(window) != 2 or any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in window)
            or not 0 <= window[0] < window[1]
            or not 1 - 1e-9 <= window[1] - window[0] <= 10 + 1e-9):
        raise ValueError("one_to_ten_second_window_required")
    for binding in (source, provenance):
        if file_hash(binding["path"]) != binding["sha256"]:
            raise ValueError("input_binding_changed")
    verify_public_acquisition(spec)
    out = Path(output)
    out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(__file__, out / Path(__file__).name)
    shutil.copyfile(flick_public_adapter.__file__, out / "flick_public_adapter.py")
    clip = out / "fingerprint-input.wav"
    args = ["ffmpeg", "-nostdin", "-v", "error", "-n", "-ss", str(window[0]), "-i", source["path"],
            "-t", str(window[1] - window[0]), "-map", "0:a:0", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", str(clip)]
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError("audio_preparation_failed")
    with wave.open(str(clip), "rb") as audio:
        if abs(audio.getnframes() / audio.getframerate() - (window[1] - window[0])) > .002:
            raise ValueError("source_window_truncated")
    input_binding = save(out / "input.json", {"specification": bind(spec_file), **spec,
        "input_audio": bind(clip), "ffmpeg_argv": args, "ffmpeg_stderr_sha256": sha(result.stderr),
        "preparation": "mono 16k PCM original-mix analysis derivative; no separation",
        "public_fingerprint_submission_authorized": True, "source_media_uploaded": False})
    modules = (shazamio.api, shazamio.converter, shazamio.misc, shazamio_core, flick_public_adapter)
    files = [Path(module.__file__) for module in modules]
    files += list(Path(shazamio_core.__file__).parent.glob("*.pyd"))
    files += list(Path(shazamio_core.__file__).parent.glob("*.so"))
    runtime_binding = save(out / "runtime.json", {"python": sys.executable,
        'python_binary': bind(sys.executable),
        'ffmpeg_binary': bind(shutil.which('ffmpeg')),
        "packages": {name: metadata.version(name) for name in ("shazamio", "shazamio-core", "aiohttp")},
        "sdk_source_bindings": [bind(file) for file in files], "runner": bind(out / Path(__file__).name),
        "new_models": 0, "gpt_cli_calls": 0, "paid_api_calls": 0})
    client = SinglePost(out, input_binding)
    started = time.monotonic()
    receipt = {"input": input_binding, "runtime": runtime_binding,
        "started_at": datetime.now(timezone.utc).isoformat(), "scope": "recording_identity_candidate_only",
        "automatic_retries": 0, "repairs_used": 0, "source_match_verified": False,
        "lyrics_verified": False, "qualification_granted": False, "music_pack_approved": False}
    try:
        response = await asyncio.wait_for(Shazam(http_client=client,
            segment_duration_seconds=10).recognize(str(clip)), timeout=45)
        candidate = summarize_response(response, input_binding['sha256'], client.raw_response['sha256'])
        receipt["candidate_evidence"] = save(out / "candidate-metadata.json", candidate)
        receipt["status"] = candidate["candidate_status"]
    except RecognitionStopped as error:
        receipt["status"] = str(error)
    except Exception as error:
        receipt["status"] = "fingerprint_failed" if not client.calls else "transport_or_response_failed"
        receipt["error_type"] = type(error).__name__
    if file_hash(source["path"]) != source["sha256"] or file_hash(provenance["path"]) != provenance["sha256"]:
        receipt["status"] = "input_changed_during_recognition"
    receipt.update(http_requests=client.calls, http_status=client.http_status, submission=client.submission,
                   response=client.response, wall_seconds=time.monotonic() - started)
    save(out / "receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Bound public source and 1-10 second window JSON.")
    parser.add_argument("--out", required=True, help="New evidence directory; existing output is refused.")
    parser.add_argument("--consent-to-external-fingerprint-submission", action="store_true",
                        help="Use only when the user already authorized this public fingerprint submission.")
    args = parser.parse_args()
    receipt = asyncio.run(recognize_public_candidate(args.input, args.out,
        args.consent_to_external_fingerprint_submission))
    print(json.dumps({key: receipt.get(key) for key in
        ("status", "http_requests", "http_status", "wall_seconds", "qualification_granted")}, ensure_ascii=False))


if __name__ == "__main__":
    main()

