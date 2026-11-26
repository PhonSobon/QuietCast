"""ffmpeg helpers: thumbnails, MP4 conversion and AI noise removal."""
import logging
import subprocess
import tempfile
from pathlib import Path

import httpx

import json

from .config import (
    CAPTIONS_DIR,
    DENOISER_TIMEOUT_SEC,
    DENOISER_URL,
    FFMPEG,
    THUMBS_DIR,
    TRANSCRIBER_TIMEOUT_SEC,
    TRANSCRIBER_URL,
    VIDEOS_DIR,
)
from .db import connect, row_to_dict

log = logging.getLogger("media")

# Fallback sample rate sent to the denoiser; the service advertises its preferred rate in /health
DEFAULT_DENOISE_SR = 16000
SUPPORTED_SR = {8000, 16000, 22050, 24000, 32000, 44100, 48000}


def _ffmpeg(args: list[str]) -> tuple[bool, str]:
    if not FFMPEG:
        return False, "ffmpeg is not installed"
    try:
        proc = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args],
            capture_output=True,
            timeout=60 * 60,
        )
        err = proc.stderr.decode(errors="ignore")[-500:]
        if proc.returncode != 0:
            log.warning("ffmpeg failed: %s", err)
        return proc.returncode == 0, err
    except Exception as exc:  # noqa: BLE001
        log.warning("ffmpeg error: %s", exc)
        return False, str(exc)


def _run(args: list[str]) -> bool:
    return _ffmpeg(args)[0]


def make_thumbnail(rec_id: str, filename: str) -> None:
    src = VIDEOS_DIR / filename
    dst = THUMBS_DIR / f"{rec_id}.jpg"
    # Grab a frame ~1s in; fall back to the first frame for very short clips
    ok = _run(["-ss", "1", "-i", str(src), "-frames:v", "1", "-vf", "scale=480:-2", str(dst)])
    if not ok or not dst.exists():
        ok = _run(["-i", str(src), "-frames:v", "1", "-vf", "scale=480:-2", str(dst)])
    if ok and dst.exists():
        with connect() as conn:
            conn.execute("UPDATE recordings SET has_thumbnail = 1 WHERE id = ?", (rec_id,))


def convert_to_mp4(rec_id: str, filename: str) -> None:
    """Convert to MP4. Uses the noise-removed version when one exists."""
    with connect() as conn:
        row = row_to_dict(conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone())
    if not row:
        return
    source = row["denoised_filename"] or filename
    src = VIDEOS_DIR / source
    out_name = f"{Path(filename).stem}.mp4"
    dst = VIDEOS_DIR / out_name
    ok = _run([
        "-i", str(src),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        # H.264 needs even dimensions
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        str(dst),
    ])
    with connect() as conn:
        if ok and dst.exists():
            conn.execute(
                "UPDATE recordings SET mp4_filename = ?, convert_status = 'done' WHERE id = ?",
                (out_name, rec_id),
            )
        else:
            conn.execute("UPDATE recordings SET convert_status = 'failed' WHERE id = ?", (rec_id,))


def denoiser_health() -> dict:
    """Ask the RE-USE denoiser service whether it is up and the model is loaded."""
    if not DENOISER_URL:
        return {"ok": False, "error": "Denoiser disabled (DENOISER_URL is empty)"}
    try:
        r = httpx.get(f"{DENOISER_URL}/health", timeout=3)
        r.raise_for_status()
        return r.json()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Denoiser service not reachable at {DENOISER_URL} ({type(exc).__name__})"}


def _set_denoise(rec_id: str, status: str, error: str | None = None, filename: str | None = None) -> None:
    with connect() as conn:
        if filename is not None:
            conn.execute(
                "UPDATE recordings SET denoise_status = ?, denoise_error = ?, denoised_filename = ? WHERE id = ?",
                (status, error, filename, rec_id),
            )
        else:
            conn.execute(
                "UPDATE recordings SET denoise_status = ?, denoise_error = ? WHERE id = ?",
                (status, error, rec_id),
            )


def denoise_recording(rec_id: str, filename: str) -> None:
    """
    Remove background noise from a recording's audio with NVIDIA RE-USE:
      1. extract the audio track (mono, 48 kHz WAV)
      2. send it to the denoiser service
      3. mux the cleaned audio back with the untouched video stream
    The original file is kept; the result is stored as <id>_denoised.<ext>.
    """
    src = VIDEOS_DIR / filename
    ext = src.suffix.lower()
    out_name = f"{src.stem}_denoised{ext}"
    dst = VIDEOS_DIR / out_name
    try:
        with tempfile.TemporaryDirectory() as tmp:
            noisy = Path(tmp) / "noisy.wav"
            clean = Path(tmp) / "clean.wav"

            sr = denoiser_health().get("sample_rate")
            sr = sr if sr in SUPPORTED_SR else DEFAULT_DENOISE_SR
            ok, err = _ffmpeg(["-i", str(src), "-vn", "-map", "0:a:0", "-ac", "1",
                               "-ar", str(sr), "-c:a", "pcm_s16le", str(noisy)])
            if not ok or not noisy.exists():
                no_audio = "matches no streams" in err or "does not contain any stream" in err
                raise RuntimeError("This recording has no audio track" if no_audio else f"Audio extraction failed: {err}")

            with noisy.open("rb") as f:
                r = httpx.post(
                    f"{DENOISER_URL}/enhance",
                    files={"file": ("audio.wav", f, "audio/wav")},
                    timeout=DENOISER_TIMEOUT_SEC,
                )
            if r.status_code != 200:
                try:
                    detail = r.json().get("detail", r.text)
                except Exception:  # noqa: BLE001
                    detail = r.text
                raise RuntimeError(f"Denoiser error ({r.status_code}): {detail}")
            clean.write_bytes(r.content)

            audio_codec = ["-c:a", "aac", "-b:a", "160k"] if ext == ".mp4" else ["-c:a", "libopus", "-b:a", "128k"]
            ok, err = _ffmpeg(["-i", str(src), "-i", str(clean),
                               "-map", "0:v:0?", "-map", "1:a:0", "-c:v", "copy", *audio_codec, str(dst)])
            if not ok or not dst.exists():
                raise RuntimeError(f"Muxing failed: {err}")
    except httpx.HTTPError as exc:
        dst.unlink(missing_ok=True)
        _set_denoise(rec_id, "failed", f"Cannot reach the denoiser service at {DENOISER_URL} ({type(exc).__name__})")
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("denoise failed for %s: %s", rec_id, exc)
        dst.unlink(missing_ok=True)
        _set_denoise(rec_id, "failed", str(exc)[:500])
        return

    # An MP4 made from the noisy original is now stale
    with connect() as conn:
        row = row_to_dict(conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone())
        if row and row["mp4_filename"] and row["mp4_filename"] != row["filename"]:
            (VIDEOS_DIR / row["mp4_filename"]).unlink(missing_ok=True)
            conn.execute(
                "UPDATE recordings SET mp4_filename = NULL, convert_status = 'none' WHERE id = ?", (rec_id,)
            )
    _set_denoise(rec_id, "done", None, out_name)


# ------------------------------------------------------------------ speech to text

def transcriber_health() -> dict:
    """Ask the Sota ASR transcriber service whether it is up and the model is loaded."""
    if not TRANSCRIBER_URL:
        return {"ok": False, "error": "Transcriber disabled (TRANSCRIBER_URL is empty)"}
    try:
        r = httpx.get(f"{TRANSCRIBER_URL}/health", timeout=3)
        r.raise_for_status()
        return r.json()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Transcriber service not reachable at {TRANSCRIBER_URL} ({type(exc).__name__})"}


def _ts(sec: float, sep: str) -> str:
    ms = int(round(max(0.0, sec) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def captions_path(rec_id: str, ext: str) -> Path:
    return CAPTIONS_DIR / f"{rec_id}.{ext}"


def _write_captions(rec_id: str, data: dict) -> None:
    caps = data.get("captions", [])
    srt = "".join(f"{i}\n{_ts(c['start'], ',')} --> {_ts(c['end'], ',')}\n{c['text']}\n\n" for i, c in enumerate(caps, 1))
    vtt = "WEBVTT\n\n" + "".join(f"{_ts(c['start'], '.')} --> {_ts(c['end'], '.')}\n{c['text']}\n\n" for c in caps)
    captions_path(rec_id, "srt").write_text(srt, encoding="utf-8")
    captions_path(rec_id, "vtt").write_text(vtt, encoding="utf-8")
    captions_path(rec_id, "txt").write_text(data.get("text", "") + "\n", encoding="utf-8")
    captions_path(rec_id, "json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _set_transcript(rec_id: str, status: str, error: str | None = None, text: str | None = None) -> None:
    with connect() as conn:
        if text is not None:
            conn.execute(
                "UPDATE recordings SET transcript_status = ?, transcript_error = ?, transcript_text = ? WHERE id = ?",
                (status, error, text, rec_id),
            )
        else:
            conn.execute(
                "UPDATE recordings SET transcript_status = ?, transcript_error = ? WHERE id = ?",
                (status, error, rec_id),
            )


def transcribe_recording(rec_id: str) -> None:
    """
    Speech to text with Sota ASR (Khmer, English, mixed):
      1. extract the audio (16 kHz mono WAV) - from the noise-removed version when available
      2. send it to the transcriber service
      3. save captions as .vtt / .srt / .txt / .json and the text for search
    """
    with connect() as conn:
        row = row_to_dict(conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone())
    if not row:
        return
    src = VIDEOS_DIR / (row["denoised_filename"] or row["filename"])
    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "speech.wav"
            ok, err = _ffmpeg(["-i", str(src), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000",
                               "-c:a", "pcm_s16le", str(wav)])
            if not ok or not wav.exists():
                no_audio = "matches no streams" in err or "does not contain any stream" in err
                raise RuntimeError("This recording has no audio track" if no_audio else f"Audio extraction failed: {err}")
            with wav.open("rb") as f:
                r = httpx.post(
                    f"{TRANSCRIBER_URL}/transcribe",
                    files={"file": ("speech.wav", f, "audio/wav")},
                    data={"words": "0", "max_width": "42"},
                    timeout=TRANSCRIBER_TIMEOUT_SEC,
                )
            if r.status_code != 200:
                try:
                    detail = r.json().get("detail", r.text)
                except Exception:  # noqa: BLE001
                    detail = r.text
                raise RuntimeError(f"Transcriber error ({r.status_code}): {detail}")
            data = r.json()
        _write_captions(rec_id, data)
    except httpx.HTTPError as exc:
        _set_transcript(rec_id, "failed", f"Cannot reach the transcriber service at {TRANSCRIBER_URL} ({type(exc).__name__})")
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("transcription failed for %s: %s", rec_id, exc)
        _set_transcript(rec_id, "failed", str(exc)[:500])
        return
    _set_transcript(rec_id, "done", None, data.get("text", ""))


def remove_captions(rec_id: str) -> None:
    for ext in ("srt", "vtt", "txt", "json"):
        captions_path(rec_id, ext).unlink(missing_ok=True)


def denoise_then_transcribe(rec_id: str, filename: str) -> None:
    """Clean the audio first, then transcribe the clean version (better accuracy)."""
    denoise_recording(rec_id, filename)
    transcribe_recording(rec_id)
