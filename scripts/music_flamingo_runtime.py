"""Offline Music Flamingo observations with lazy GPU loading; no selection authority."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
from gpu_single_slot import require_gpu_slot


def _sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


class MusicFlamingoObserver:
    def __init__(self, weights, deps, gpu_memory_gib=4.8, max_new_tokens=256, max_job_seconds=45):
        self.weights, self.deps = Path(weights).resolve(), Path(deps).resolve()
        if (not 0 < gpu_memory_gib <= 4.8 or type(max_new_tokens) is not int
                or not 1 <= max_new_tokens <= 256 or not 0 < max_job_seconds <= 45):
            raise ValueError("observation budget exceeds the validated bounded route")
        self.gpu_memory_gib, self.max_new_tokens, self.max_job_seconds = gpu_memory_gib, max_new_tokens, max_job_seconds
        config = json.loads((self.weights / "config.json").read_text("utf-8-sig"))
        if config.get("model_type") != "musicflamingo":
            raise ValueError("expected Music Flamingo configuration")
        manifest_path = self.weights.parent / "download-record.json"
        manifest = json.loads(manifest_path.read_text("utf-8-sig"))
        weight_record = next(item for item in manifest["files"] if item["file"] == "model.safetensors")
        verified_started = time.monotonic()
        actual_checkpoint_sha = _sha(self.weights / "model.safetensors")
        if (actual_checkpoint_sha != weight_record["sha256"]
                or actual_checkpoint_sha != weight_record["expected_lfs_sha256"]
                or (self.weights / "model.safetensors").stat().st_size != weight_record["size"]):
            raise ValueError("checkpoint differs from the recorded official LFS identity")
        self.checkpoint_verification_seconds = time.monotonic() - verified_started
        for item in manifest["files"]:
            if item["file"] != "model.safetensors" and _sha(self.weights / item["file"]) != item["sha256"]:
                raise ValueError("local processor/configuration file identity changed")
        sys.path.insert(0, str(self.deps))
        imported = sys.modules.get("transformers")
        if imported and not Path(imported.__file__).resolve().is_relative_to(self.deps):
            raise ValueError("another Transformers runtime was already imported")
        versions = {name: importlib.metadata.version(name)
                    for name in ("transformers", "torch", "accelerate", "bitsandbytes", "tokenizers", "safetensors")}
        if versions["transformers"] != "5.18.0":
            raise ValueError("the validated observer requires isolated Transformers 5.18.0")
        self.binding = {"provider": "MusicFlamingoObserver", "model_id": manifest["model_id"],
                        "hf_revision": manifest["revision"], "checkpoint_sha256": actual_checkpoint_sha,
                        "checkpoint_sha256_basis": "current full file rehash matches recorded official LFS SHA",
                        "download_record_sha256": _sha(manifest_path),
                        "config_sha256": _sha(self.weights / "config.json"),
                        "processor_files_sha256": {item["file"]: item["sha256"] for item in manifest["files"]
                                                   if item["file"] != "model.safetensors"},
                        "runtime_versions": versions, "runtime_source_sha256": _sha(__file__),
                        "precision": "NF4 language decoder / CPU FP32 encoder / CPU lm_head / BF16 projector",
                        "generation": {"max_new_tokens": max_new_tokens, "max_job_seconds": max_job_seconds,
                                       "do_sample": False, "use_cache": True},
                        "gpu_memory_gib": gpu_memory_gib, "input_sampling_rate_hz": 16000,
                        "maximum_input_seconds": 30, "observation_scope": "unverified raw audio observations"}
        self._model = self._processor = None
        self._encoder_forwards, self._head_forwards = [], []

    def _load(self):
        require_gpu_slot('cuda:0')
        if self._model is not None:
            return
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false",
                          HF_HOME=str(self.weights.parent / "offline-cache"))
        import bitsandbytes
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig, MusicFlamingoForConditionalGeneration
        from accelerate.hooks import AlignDevicesHook, add_hook_to_module, remove_hook_from_module
        torch.set_num_threads(4)
        if torch.get_num_interop_threads() != 1:
            torch.set_num_interop_threads(1)
        if not torch.cuda.is_available():
            raise ValueError("the validated observation route requires CUDA")
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        cap_bytes = min(int(self.gpu_memory_gib * 1024 ** 3), free_bytes - int(.75 * 1024 ** 3))
        if cap_bytes <= 0:
            raise ValueError("insufficient free GPU memory for the bounded route")
        torch.cuda.set_per_process_memory_fraction(cap_bytes / total_bytes)
        processor = AutoProcessor.from_pretrained(self.weights, local_files_only=True, token=False)
        if processor.feature_extractor.sampling_rate != 16000:
            raise ValueError("processor sampling rate differs from the binding")
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                                  bnb_4bit_compute_dtype=torch.bfloat16, llm_int8_enable_fp32_cpu_offload=True,
                                  llm_int8_skip_modules=["model.audio_tower", "model.multi_modal_projector", "lm_head"])
        model = MusicFlamingoForConditionalGeneration.from_pretrained(
            self.weights, local_files_only=True, token=False, dtype=torch.bfloat16,
            quantization_config=quant, device_map={"model.audio_tower": "cpu", "model.language_model": 0,
            "model.multi_modal_projector": 0, "model.pos_emb": "cpu", "lm_head": "cpu"},
            offload_folder=str(self.weights.parent / "offload"), attn_implementation="sdpa").eval()
        quant_names = [name for name, module in model.named_modules() if isinstance(module, bitsandbytes.nn.Linear4bit)]
        if not quant_names or any(not name.startswith("model.language_model.layers.") for name in quant_names):
            raise ValueError("NF4 must preserve the non-quantized audio encoder/projector/head")
        tower, head = model.model.audio_tower, model.lm_head
        remove_hook_from_module(tower, recurse=True)
        tower.float()
        add_hook_to_module(tower, AlignDevicesHook(execution_device="cpu", offload=False))
        remove_hook_from_module(head, recurse=True)
        if any(parameter.is_meta for parameter in head.parameters()):
            raise ValueError("CPU lm_head parameters remain meta")
        head.to("cpu")
        original_head = head.forward

        def cpu_head(hidden_states, *args, **kwargs):
            parameter = next(head.parameters())
            if parameter.device.type != "cpu" or hidden_states.device.type != "cpu":
                raise ValueError("lm_head must actually execute on CPU")
            hidden_states = hidden_states.to(dtype=parameter.dtype)
            output = original_head(hidden_states, *args, **kwargs)
            self._head_forwards.append({"weight_device": str(parameter.device), "weight_dtype": str(parameter.dtype),
                                        "hidden_device": str(hidden_states.device), "hidden_dtype": str(hidden_states.dtype),
                                        "output_device": str(output.device), "output_dtype": str(output.dtype)})
            return output

        head.forward = cpu_head
        add_hook_to_module(head, AlignDevicesHook(execution_device="cpu", offload=False, io_same_device=True))
        model.model.multi_modal_projector.register_forward_pre_hook(
            lambda module, values: (values[0].to(torch.bfloat16), *values[1:]))

        def encoder_evidence(module, values, result):
            state = result.last_hidden_state
            self._encoder_forwards.append({"shape": list(state.shape), "dtype": str(state.dtype),
                                           "device": str(state.device), "finite": bool(torch.isfinite(state).all())})

        tower.register_forward_hook(encoder_evidence)
        self._model, self._processor = model, processor
        self._load_evidence = {"gpu_name": torch.cuda.get_device_name(), "nf4_module_count": len(quant_names),
                               "own_torch_allocator_cap_bytes": cap_bytes,
                               "gpu_cap_scope": "this process PyTorch allocator; other services unchanged"}

    def observe(self, wave, prompt):
        import numpy as np
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("a nonempty neutral observation prompt is required")
        wave = np.asarray(wave, dtype="<f4")
        if wave.ndim != 1 or not 0 < wave.size <= 30 * 16000 or not np.isfinite(wave).all():
            raise ValueError("complete finite mono 16k PCM of at most 30 seconds is required")
        self._load()
        import torch
        self._encoder_forwards, self._head_forwards = [], []
        conversation = [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "audio"}]}]
        rendered = self._processor.apply_chat_template(conversation, tokenize=False, add_generation_prompt=True)
        features = self._processor(text=rendered, audio=wave, sampling_rate=16000, return_tensors="pt")
        frames = features["input_features_mask"].sum(-1).to(torch.long)
        _, post_lengths = self._model.model.audio_tower._get_feat_extract_output_lengths(frames)
        tokens = int((features["input_ids"] == self._model.config.audio_token_id).sum())
        if tokens <= 0 or tokens != int(post_lengths.sum()):
            raise ValueError("audio feature frames and expanded tokens differ")
        for key, value in features.items():
            if hasattr(value, "to"):
                features[key] = value.to("cpu" if key in ("input_features", "input_features_mask") else "cuda:0")
        features["input_features"] = features["input_features"].float()
        began = time.monotonic()
        with torch.inference_mode():
            output = self._model.generate(**features, max_new_tokens=self.max_new_tokens,
                                         max_time=self.max_job_seconds, do_sample=False, use_cache=True)
        seconds = time.monotonic() - began
        generated = output[:, features["input_ids"].shape[1]:]
        raw = self._processor.batch_decode(generated, skip_special_tokens=True)[0]
        if not self._encoder_forwards or not all(item["finite"] for item in self._encoder_forwards):
            raise ValueError("finite actual encoder forward was not proven")
        if not self._head_forwards or not all(item["output_device"] == "cpu" for item in self._head_forwards):
            raise ValueError("actual CPU head forward was not proven")
        eos = self._model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        last = int(generated[0, -1]) if generated.shape[1] else None
        return {"raw_observation": raw,
                "execution": {**self._load_evidence, "actual_audio_processed": True,
                              "processor_pcm_sha256": hashlib.sha256(wave.tobytes()).hexdigest(),
                              "actual_audio_tokens": tokens, "actual_valid_mel_frames": frames.tolist(),
                              "encoder_forward_count": len(self._encoder_forwards), "encoder_forwards": self._encoder_forwards,
                              "head_forward_count": len(self._head_forwards), "head_forwards": self._head_forwards},
                "generation_termination": {"generated_token_count": int(generated.shape[1]), "last_token_id": last,
                                           "configured_eos_token_ids": eos, "last_token_is_configured_eos": last in eos,
                                           "max_tokens_reached": generated.shape[1] >= self.max_new_tokens,
                                           "max_time_threshold_reached": seconds >= self.max_job_seconds,
                                           "generation_seconds": seconds}}
