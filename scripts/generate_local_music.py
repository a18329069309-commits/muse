"""Generate one local ACE Turbo candidate; success never means approved scoring.

Run with the installed ACE Python runtime. --validate-only uses the standard
library only. This entry point deliberately does not install or download models.
"""
import argparse
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time


def generation_kwargs(request):
    """Validate the explicit vocal policy before any model import or allocation."""
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")
    if request.get("craft_mode") != "fine":
        raise ValueError("Generation requires craft_mode=fine; fast mode uses the library only")
    allowed = {"craft_mode", "vocal_mode", "caption", "duration_seconds", "seed",
               "lyrics", "vocal_language", "bpm", "keyscale", "timesignature",
               "cue_id", "source_video_sha256", "structure_tags", "task_type",
               "reference_audio", "src_audio", "audio_cover_strength"}
    if set(request) - allowed:
        raise ValueError("Unsupported request fields: " + ", ".join(sorted(set(request) - allowed)))
    caption = request.get("caption")
    if not isinstance(caption, str) or not 1 <= len(caption.strip()) <= 512:
        raise ValueError("caption must contain 1–512 characters")
    duration = request.get("duration_seconds")
    if type(duration) not in (int, float) or not math.isfinite(duration) or not 10 <= duration <= 120:
        raise ValueError("duration_seconds must be finite and between 10 and 120 for a candidate")
    seed = request.get("seed")
    if type(seed) is not int or not 0 <= seed <= 4294967295:
        raise ValueError("seed must be an integer between 0 and 4294967295")
    bpm = request.get("bpm")
    if bpm is not None and (type(bpm) is not int or not 30 <= bpm <= 300):
        raise ValueError("bpm must be an integer between 30 and 300, or null")
    mode, lyrics = request.get("vocal_mode"), request.get("lyrics", "")
    if not isinstance(lyrics, str) or len(lyrics) > 4096:
        raise ValueError("lyrics must be a string of at most 4096 characters")
    language = request.get("vocal_language", "unknown")
    structure = request.get("structure_tags", "")
    if not isinstance(structure, str) or (structure and not re.fullmatch(r"(?:\s*\[[^\[\]\r\n]{1,80}\]\s*){1,8}", structure)):
        raise ValueError("structure_tags must contain only 1–8 concise bracketed section tags")
    if mode == "instrumental":
        if lyrics.strip() or language != "unknown":
            raise ValueError("instrumental requests must omit lyrics and vocal_language")
        lyrics = "[Instrumental]" + ("\n\n" + structure if structure else "")
    elif mode == "lyrics":
        if structure:
            raise ValueError("For lyrics mode, place section tags directly in lyrics")
        if not re.sub(r"\[[^]]*\]", "", lyrics).strip():
            raise ValueError("lyrics mode requires actual words, not only section tags")
        if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("lyrics mode requires an explicit vocal_language code, e.g. en or zh")
    else:
        raise ValueError("vocal_mode must explicitly be instrumental or lyrics")
    key = request.get("keyscale", "")
    meter = request.get("timesignature", "")
    if not isinstance(key, str) or len(key) > 24 or meter not in ("", "2", "3", "4", "6"):
        raise ValueError("Invalid keyscale or timesignature (use '', '2', '3', '4', or '6')")
    source_hash = request.get("source_video_sha256")
    if source_hash is not None and (not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash)):
        raise ValueError("source_video_sha256 must be a lowercase SHA-256 digest")
    task = request.get("task_type", "text2music")
    if task not in ("text2music", "cover"):
        raise ValueError("This local runner supports only text2music and cover")
    if task == "cover" and not request.get("src_audio"):
        raise ValueError("cover requires a local src_audio file")
    if task != "cover" and ("src_audio" in request or "audio_cover_strength" in request):
        raise ValueError("src_audio and audio_cover_strength are only valid for cover")
    strength = request.get("audio_cover_strength", 1.0)
    if type(strength) not in (int, float) or not math.isfinite(strength) or not 0 <= strength <= 1:
        raise ValueError("audio_cover_strength must be finite and between 0 and 1")
    audio_paths = {}
    for field in ("reference_audio", "src_audio"):
        if field in request:
            value = request[field]
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise ValueError(field + " must be an absolute local file path")
            audio_paths[field] = value
    return dict(caption=caption, lyrics=lyrics, instrumental=mode == "instrumental",
                vocal_language=language, duration=duration, seed=seed, bpm=bpm,
                keyscale=key, timesignature=meter, task_type=task, **audio_paths,
                audio_cover_strength=strength,
                instruction=("Generate audio semantic tokens based on the given conditions:" if task == "cover"
                             else "Fill the audio semantic mask based on the given conditions:"),
                inference_steps=8, thinking=False, use_cot_metas=False,
                use_cot_caption=False, use_cot_language=False, use_cot_lyrics=False)


from gpu_single_slot import gpu_slot_guard, add_slot_arguments, slot_binding_from_args


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    add_slot_arguments(result)
    result.add_argument("request", type=Path)
    result.add_argument("--repo", type=Path, required=True)
    result.add_argument("--checkpoints", type=Path, required=True)
    result.add_argument("--checkpoint", required=True, choices=["acestep-v15-turbo"])
    result.add_argument("--out", type=Path, required=True)
    result.add_argument("--validate-only", action="store_true")
    return result


def preflight(args):
    request = json.loads(args.request.read_text(encoding="utf-8-sig"))
    params = generation_kwargs(request)
    for field in ("reference_audio", "src_audio"):
        if field in params:
            info = probe_audio(Path(params[field]))
            if field == "src_audio" and abs(info["duration_seconds"] - params["duration"]) > .05:
                raise ValueError("Cover duration must match the pre-cut src_audio; upstream locks duration to the source")
    if not (args.repo / "acestep/inference.py").is_file():
        raise ValueError("Local ACE repository is missing")
    required = [f"{args.checkpoint}/{name}" for name in
                ("model.safetensors", "config.json", "silence_latent.pt")]
    required += ["vae/config.json", "vae/diffusion_pytorch_model.safetensors"]
    required += [f"Qwen3-Embedding-0.6B/{name}" for name in
                 ("config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json")]
    files = [args.checkpoints / name for name in required]
    missing = [str(p) for p in files if not p.is_file() or p.stat().st_size == 0]
    if missing:
        raise ValueError("Missing local components; downloads are disabled: " + ", ".join(missing))
    verify_checkpoint_code(args.repo, args.checkpoints, args.checkpoint)
    if args.out.exists():
        raise ValueError("Output folder must be new; existing results are never overwritten")
    return request, params, files


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_audio(path):
    if not path.is_file():
        raise ValueError("Conditioning audio file is missing: " + str(path))
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                             "stream=sample_rate,channels,duration:format=duration", "-of", "json", str(path)],
                            capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Cannot decode conditioning audio: " + str(path))
    value = json.loads(result.stdout)
    if not value.get("streams"):
        raise ValueError("Conditioning file has no audio stream")
    stream = value["streams"][0]
    duration = float(stream.get("duration", value.get("format", {}).get("duration", 0)))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Conditioning audio has no usable duration")
    return dict(path=str(path.resolve()), duration_seconds=duration,
                sample_rate=int(stream["sample_rate"]), channels=stream["channels"])


def verify_checkpoint_code(repo, checkpoints, checkpoint):
    """Match the installed Turbo sync targets without modifying shared weights."""
    sources = sorted(p for p in (repo / "acestep/models/turbo").glob("*.py") if p.name != "__init__.py")
    if not sources:
        raise ValueError("Local Turbo model source files are missing")
    mismatches = [p.name for p in sources if not (checkpoints / checkpoint / p.name).is_file()
                  or sha256(p) != sha256(checkpoints / checkpoint / p.name)]
    if mismatches:
        raise ValueError("Checkpoint code differs from local source; automatic sync is disabled: " + ", ".join(mismatches))


def source_identity(repo):
    """A ZIP deployment has no Git metadata; actual Python content is primary."""
    sources = {p.relative_to(repo).as_posix(): sha256(p) for p in sorted((repo / "acestep").rglob("*.py"))}
    commit = None
    if (repo / ".git").exists():
        try:
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo,
                                             text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            pass
    return dict(git_commit=commit, source_tree_sha256=hashlib.sha256(
        json.dumps(sources, sort_keys=True).encode("utf-8")).hexdigest(), source_file_count=len(sources))


def block_downloads(module, checkpoint):
    def denied(*args, **kwargs):
        raise RuntimeError("Automatic model downloads are disabled")
    # The upstream main-model check includes an unused 5Hz LM. Limit this
    # process to the three actual components; never fabricate missing weights.
    module.MAIN_MODEL_COMPONENTS = [checkpoint, "vae", "Qwen3-Embedding-0.6B"]
    for name in ("download_main_model", "download_submodel", "download_vae", "_smart_download"):
        setattr(module, name, denied)
    def deny_sync(*args, **kwargs):
        raise RuntimeError("Automatic checkpoint code sync is disabled; use matching local source and weights")
    module._sync_model_code_files = deny_sync


def dcw_health(requested, resolved_enabled, cache=None):
    """Report real imports and observed transforms; never infer audio quality."""
    versions, errors = {}, {}
    for package in ("pytorch-wavelets", "PyWavelets", "setuptools"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    for name in ("pytorch_wavelets", "pywt"):
        try:
            importlib.import_module(name)
        except Exception as error:
            errors[name] = {"type": type(error).__name__, "message": str(error)}
    status = "disabled" if not resolved_enabled else ("degraded" if errors else "ready_not_yet_observed")
    result = dict(requested_enabled=requested, resolved_enabled=resolved_enabled,
                  package_versions=versions, import_errors=errors, status=status,
                  artistic_approval=False)
    if cache is not None:
        count = len(getattr(cache, "_cache", {}))
        failed = bool(getattr(cache, "_import_failed", False))
        result.update(loader_import_failed=failed, transform_cache_entries=count,
                      actual_transform_constructed=count > 0)
        if resolved_enabled:
            result["status"] = "active_transform_observed" if count and not failed and not errors else "degraded"
    return result


@gpu_slot_guard(lambda args, request, kwargs, files: 'cuda:0',
                lambda args, request, kwargs, files: slot_binding_from_args(args))
def run(args, request, kwargs, files):
    args.out.mkdir(parents=True, exist_ok=False)
    began = time.perf_counter()
    record = dict(status="initializing", request=request, runtime_python=sys.executable,
                  repo=str(args.repo.resolve()), checkpoints=str(args.checkpoints.resolve()),
                  checkpoint=args.checkpoint, lm="disabled_not_deployed", network="offline",
                  requested_params=kwargs, audible_review="not_performed",
                  artistic_status="needs_audition", timing_alignment="not_validated",
                  files=[], timings_seconds={})

    def save():
        record["timings_seconds"]["total"] = time.perf_counter() - began
        (args.out / "generation-record.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    save()
    try:
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                          HF_HUB_DISABLE_IMPLICIT_TOKEN="1", HF_HUB_DISABLE_TELEMETRY="1",
                          TOKENIZERS_PARALLELISM="false",
                          ACESTEP_CHECKPOINTS_DIR=str(args.checkpoints.resolve()))
        sys.path.insert(0, str(args.repo.resolve()))
        import numpy as np
        import soundfile as sf
        import torch
        from loguru import logger
        from acestep import model_downloader
        block_downloads(model_downloader, args.checkpoint)
        from acestep.handler import AceStepHandler
        from acestep.inference import GenerationConfig, GenerationParams, generate_music
        logger.remove()
        logger.add(sys.stderr, level="WARNING")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; no implicit CPU or cloud fallback")
        record.update(torch=torch.__version__, cuda=torch.version.cuda,
                      gpu=torch.cuda.get_device_name(0), **source_identity(args.repo))
        record["local_artifacts"] = [{"path": str(p.resolve()), "bytes": p.stat().st_size,
                                      "sha256": sha256(p)} for p in files]
        record["conditioning_audio"] = {field: dict(probe_audio(Path(kwargs[field])), sha256=sha256(Path(kwargs[field])))
                                        for field in ("reference_audio", "src_audio") if field in kwargs}
        params = GenerationParams(**kwargs)
        config = GenerationConfig(batch_size=1, audio_format="wav32", use_random_seed=False, seeds=[params.seed])
        record.update(generation_params=params.to_dict(), generation_config=config.to_dict())
        handler = AceStepHandler()
        started = time.perf_counter()
        status, ok = handler.initialize_service(
            project_root=str(args.repo.resolve()), config_path=args.checkpoint, device="cuda",
            use_flash_attention=False, compile_model=False, offload_to_cpu=True,
            offload_dit_to_cpu=True, quantization="int8_weight_only", use_mlx_dit=False,
            vae_checkpoint="official")
        record["timings_seconds"]["initialization"] = time.perf_counter() - started
        record.update(initialization_status=status, actual_quantization=handler.quantization,
                      initialization_params=getattr(handler, "last_init_params", {}))
        if not ok or handler.quantization != "int8_weight_only":
            raise RuntimeError("CUDA INT8 initialization failed; see initialization_status")
        quantized = 0
        for name, layer in handler.model.named_modules():
            if isinstance(layer, torch.nn.Linear) and name.startswith("decoder."):
                impl = getattr(layer.weight, "tensor_impl", None)
                if type(layer.weight).__module__.startswith("torchao.") and impl is not None:
                    quantized += int(impl.get_plain()[0].dtype == torch.int8)
        record["verified_int8_decoder_linear_count"] = quantized
        if not quantized:
            raise RuntimeError("Requested INT8 has no verified quantized decoder weights")
        record["checkpoint_code_sha256"] = {p.name: sha256(p) for p in (args.checkpoints / args.checkpoint).glob("*.py")}
        dcw_enabled = handler._resolve_dcw_enabled(params.dcw_enabled)
        record["dcw_before_generation"] = dcw_health(params.dcw_enabled, dcw_enabled)
        record["status"] = "generating"
        save()
        random.seed(params.seed)
        np.random.seed(params.seed)
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        result = generate_music(handler, None, params, config, save_dir=str(args.out.resolve()))
        record["timings_seconds"]["generation"] = time.perf_counter() - started
        from acestep.models.common.dcw_loader import WAVELET_CACHE
        record["dcw_after_generation"] = dcw_health(params.dcw_enabled, dcw_enabled, WAVELET_CACHE)
        record["runtime_health"] = "degraded" if record["dcw_after_generation"]["status"] == "degraded" else "healthy"
        record.update(backend_success=result.success, backend_error=result.error,
                      peak_torch_allocated_bytes=torch.cuda.max_memory_allocated(),
                      peak_torch_reserved_bytes=torch.cuda.max_memory_reserved())
        for audio in result.audios:
            path = Path(audio.get("path") or "")
            if not path.is_file():
                raise RuntimeError("Backend returned a missing audio file")
            data, rate = sf.read(path, always_2d=True)
            finite = bool(np.isfinite(data).all())
            rms = float(np.sqrt(np.mean(data**2))) if len(data) and finite else None
            peak = float(np.abs(data).max()) if len(data) and finite else None
            duration = len(data) / rate
            record["files"].append(dict(path=str(path.resolve()), sha256=sha256(path),
                sample_rate=rate, channels=data.shape[1], frames=len(data), duration_seconds=duration,
                all_finite=finite, rms=rms, peak=peak,
                technical_valid=bool(finite and rms and rms > 1e-5 and peak <= 1 and data.shape[1] == 2 and abs(duration - params.duration) <= .5)))
        if not result.success or not record["files"] or not all(f["technical_valid"] for f in record["files"]):
            raise RuntimeError("Generation failed technical validation; see backend and file records")
        record["status"] = ("candidate_generated_degraded_needs_audition" if record["runtime_health"] == "degraded"
                            else "candidate_generated_needs_audition")
        save()
        return 0
    except Exception as error:
        record.update(failed_at=record["status"], status="failed", error_type=type(error).__name__, error=str(error))
        save()
        return 1


def main():
    args = parser().parse_args()
    try:
        request, kwargs, files = preflight(args)
    except (ValueError, OSError) as error:
        print(json.dumps({"status": "rejected_before_model_load", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    if args.validate_only:
        print(json.dumps({"status": "validated_not_generated", "generation_kwargs": kwargs}, ensure_ascii=False))
        return 0
    code = run(args, request, kwargs, files)
    print(json.dumps({"exit_code": code, "record": str((args.out / "generation-record.json").resolve())}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
