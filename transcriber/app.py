"""
Speech-to-text service (Khmer, English and mixed) using Sota-ASR-Khmer-26M-ONNX
(https://huggingface.co/muyleanging/Sota-ASR-Khmer-26M-ONNX).

Runs on the CPU with ONNX Runtime (int8). The model folder (./model) is downloaded once
with download_model.py, which needs a Hugging Face token (HF_TOKEN). Nothing is fetched
at runtime.

License note: the model is a preview release for personal use, evaluation and research
only. Do not redistribute the weights or use them commercially without the author's
written permission (see model/LICENSE).

API
  GET  /health      -> {"ok", "model", "error"}
  POST /transcribe  -> multipart "file" (WAV/FLAC, any rate) + form fields
                       words (int, 0 = sentence lines), max_width (int), fast (bool)
                    <- {"text", "seconds", "took", "captions": [{"start","end","text"}], "words": [...]}
"""
import io
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

HERE = Path(__file__).resolve().parent
MODEL_DIR = Path(os.getenv("MODEL_DIR", HERE / "model"))
SR = 16000
REQUIRED = ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.json", "sota_infer.py", "sota_subs.py"]

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("transcriber")

subs = None  # the model's sota_subs module
load_error: str | None = None
lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global subs, load_error
    try:
        missing = [f for f in REQUIRED if not (MODEL_DIR / f).exists()]
        if missing:
            raise RuntimeError(f"Model files missing in {MODEL_DIR}: {', '.join(missing)}. "
                               "Run: python download_model.py (needs HF_TOKEN)")
        sys.path.insert(0, str(MODEL_DIR))
        import sota_subs  # type: ignore  # from the model repository

        sota_subs.use_model("v4b")  # loads the ONNX sessions
        subs = sota_subs
        # warm-up
        subs.transcribe(np.zeros(SR, dtype=np.float32), best=False)
        log.info("Sota ASR loaded from %s", MODEL_DIR)
    except Exception as exc:  # noqa: BLE001 - surface through /health
        load_error = f"{type(exc).__name__}: {exc}"
        log.exception("Failed to load Sota ASR")
    yield


app = FastAPI(title="QuietCast Transcriber (Sota ASR Khmer)", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ok": subs is not None,
        "model": "muyleanging/Sota-ASR-Khmer-26M-ONNX",
        "languages": ["km", "en"],
        "sample_rate": SR,
        "error": load_error,
    }


@app.post("/transcribe")
def transcribe(
    file: UploadFile = File(...),
    words: int = Form(0),
    max_width: int = Form(42),
    fast: bool = Form(False),
) -> dict:
    if subs is None:
        raise HTTPException(503, f"Model not loaded: {load_error}")
    try:
        wav, sr = sf.read(io.BytesIO(file.file.read()), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Cannot read audio: {exc}") from exc
    wav = wav.mean(axis=1)
    if sr != SR:
        wav = soxr.resample(wav, sr, SR).astype(np.float32)
    if len(wav) < SR // 10:
        return {"text": "", "seconds": round(len(wav) / SR, 2), "took": 0.0, "captions": [], "words": []}

    t0 = time.perf_counter()
    with lock:
        toks = subs.transcribe(wav, best=not fast)
        word_list = subs.to_words(toks)
        caps = subs.captions(word_list, max(0, words), max(10, max_width))
    took = time.perf_counter() - t0
    secs = len(wav) / SR
    log.info("Transcribed %.1fs of audio in %.2fs", secs, took)
    return {
        "text": "".join(t["t"] for t in toks).strip(),
        "seconds": round(secs, 2),
        "took": round(took, 3),
        "captions": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in caps],
        "words": [{"w": w["w"], "s": w["s"], "e": w["e"]} for w in word_list],
    }
