"""
AI noise-removal service using NVIDIA NemotronLabs RE-USE, running on the CPU.
Model: https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE (OpenMDW-1.1 license)

RE-USE is a universal speech-enhancement model: it removes background noise,
reverberation, clipping, codec artefacts and low-quality-mic coloration.

The model (code + weights) lives in ./model (downloaded once with download_model.py);
nothing is fetched at runtime. The CUDA-only `mamba_ssm` dependency is replaced by a
CPU implementation (mamba_cpu.py), so no GPU is needed.

API
  GET  /health   -> {"ok", "device", "sample_rate", "error"}
  POST /enhance  -> multipart "file" (WAV/FLAC, 8-48 kHz) -> enhanced mono WAV
"""
import io
import json
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numba
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from safetensors.torch import load_file

from mamba_cpu import install_shim

HERE = Path(__file__).resolve().parent
MODEL_DIR = Path(os.getenv("MODEL_DIR", HERE / "model"))
# Rate the backend should send. Compute grows with the sample rate; 16 kHz is the usual
# speech rate and much faster on CPU. Set 48000 for full-band quality.
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "16000"))
# Training clips are <10 s, so long audio is processed in chunks joined with a crossfade.
CHUNK_SECONDS = float(os.getenv("CHUNK_SECONDS", "8"))
OVERLAP_SECONDS = float(os.getenv("OVERLAP_SECONDS", "0.5"))
THREADS = int(os.getenv("THREADS", "0")) or max(1, (os.cpu_count() or 2) - 1)
SUPPORTED_SR = {8000, 16000, 22050, 24000, 32000, 44100, 48000}

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("denoiser")


def _make_even(value: float) -> int:
    value = int(round(value))
    return value if value % 2 == 0 else value + 1


class Enhancer:
    def __init__(self) -> None:
        if not (MODEL_DIR / "model.safetensors").exists():
            raise RuntimeError(f"Model not found in {MODEL_DIR}. Run: python download_model.py")
        torch.set_num_threads(THREADS)
        numba.set_num_threads(min(THREADS, numba.config.NUMBA_NUM_THREADS))
        install_shim()  # `from mamba_ssm import Mamba` -> CPU implementation
        sys.path.insert(0, str(MODEL_DIR))
        # These modules come from the model repository (./model)
        from models.generator_SEMamba_time_d4 import SEMamba  # type: ignore
        from models.stfts import mag_phase_istft, mag_phase_stft  # type: ignore

        self._stft, self._istft = mag_phase_stft, mag_phase_istft
        self.cfg = json.loads((MODEL_DIR / "config.json").read_text(encoding="utf-8"))
        model = SEMamba(self.cfg)
        model.load_state_dict(load_file(str(MODEL_DIR / "model.safetensors")), strict=True)
        self.model = model.eval()
        self.lock = threading.Lock()
        log.info("RE-USE loaded on CPU (%d threads) from %s", THREADS, MODEL_DIR)
        self._warmup()

    def _warmup(self) -> None:
        """Compile the Numba kernel once at startup instead of on the first request."""
        t = time.perf_counter()
        self.enhance(np.zeros(SAMPLE_RATE // 2, dtype=np.float32), SAMPLE_RATE)
        log.info("Warm-up done in %.1fs", time.perf_counter() - t)

    def _stft_sizes(self, sr: int) -> tuple[int, int, int]:
        s = self.cfg["stft_cfg"]
        base = s["sampling_rate"]
        return (
            _make_even(s["n_fft"] * sr // base),
            _make_even(s["hop_size"] * sr // base),
            _make_even(s["win_size"] * sr // base),
        )

    def _enhance_segment(self, seg: torch.Tensor, sr: int) -> torch.Tensor:
        """seg: [1, L] -> enhanced [1, L] (same steps as the official inference.py)."""
        n_fft, hop, win = self._stft_sizes(sr)
        cf = self.cfg["model_cfg"]["compress_factor"]
        length = seg.shape[1]
        if length < n_fft * 2:  # STFT reflect-padding needs a minimum length
            seg = torch.nn.functional.pad(seg, (0, n_fft * 2 - length))
        mag, pha, _ = self._stft(seg, n_fft=n_fft, hop_size=hop, win_size=win,
                                 compress_factor=cf, center=True, addeps=False)
        amp_g, pha_g, _ = self.model(mag, pha)
        # Remove the "strange sweep artifact" (from the official script)
        m = torch.expm1(torch.relu(amp_g))
        zero_portion = torch.sum(m == 0, 1) / m.shape[1]
        amp_g[:, :, (zero_portion > 0.5)[0]] = 0
        out = self._istft(amp_g, pha_g, n_fft, hop, win, cf)
        if out.shape[1] < seg.shape[1]:
            out = torch.nn.functional.pad(out, (0, seg.shape[1] - out.shape[1]), value=1e-8)
        return out[:, :length]

    @torch.inference_mode()
    def enhance(self, audio: np.ndarray, sr: int) -> np.ndarray:
        """audio: mono float32 [N] -> enhanced mono float32 [N]."""
        x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))[None]
        n = x.shape[1]
        chunk = int(CHUNK_SECONDS * sr)
        with self.lock:
            if n <= chunk:
                y = self._enhance_segment(x, sr)
            else:
                # Overlapping chunks, joined with linear crossfades (weights normalised)
                overlap = min(int(OVERLAP_SECONDS * sr), chunk // 2)
                step = chunk - overlap
                ramp = torch.linspace(1e-3, 1.0, max(overlap, 1))
                window = torch.ones(chunk)
                if overlap:
                    window[:overlap] = ramp
                    window[-overlap:] = ramp.flip(0)
                y = torch.zeros_like(x)
                wsum = torch.zeros_like(x)
                start = 0
                while True:
                    start = min(start, n - chunk)
                    seg = self._enhance_segment(x[:, start:start + chunk], sr)
                    y[:, start:start + chunk] += seg * window
                    wsum[:, start:start + chunk] += window
                    if start + chunk >= n:
                        break
                    start += step
                y = y / wsum
        return np.clip(y[0].numpy(), -1.0, 1.0)


enhancer: Enhancer | None = None
load_error: str | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global enhancer, load_error
    try:
        enhancer = Enhancer()
    except Exception as exc:  # noqa: BLE001 - surface any load failure through /health
        load_error = f"{type(exc).__name__}: {exc}"
        log.exception("Failed to load RE-USE")
    yield


app = FastAPI(title="RE-USE Denoiser (CPU)", version="2.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ok": enhancer is not None,
        "model": "nvidia/NVIDIA-NemotronLabs-RE-USE",
        "device": f"CPU ({THREADS} threads)" if enhancer else None,
        "sample_rate": SAMPLE_RATE,
        "error": load_error,
    }


@app.post("/enhance")
def enhance(file: UploadFile = File(...)) -> Response:
    if enhancer is None:
        raise HTTPException(503, f"Model not loaded: {load_error}")
    try:
        audio, sr = sf.read(io.BytesIO(file.file.read()), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Cannot read audio: {exc}") from exc
    if sr not in SUPPORTED_SR:
        raise HTTPException(400, f"Unsupported sample rate {sr}. Use one of {sorted(SUPPORTED_SR)}.")
    if audio.shape[0] == 0:
        raise HTTPException(400, "Empty audio")
    t = time.perf_counter()
    out = enhancer.enhance(audio.mean(axis=1), sr)  # single-channel speech enhancement
    secs = len(out) / sr
    log.info("Enhanced %.1fs of audio in %.1fs", secs, time.perf_counter() - t)
    buf = io.BytesIO()
    sf.write(buf, out, sr, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")
