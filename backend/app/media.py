"""ffmpeg helpers: thumbnails, MP4 conversion and AI noise removal."""
import logging
import subprocess
import tempfile
from pathlib import Path

import httpx

from .config import DENOISER_TIMEOUT_SEC, DENOISER_URL, FFMPEG, THUMBS_DIR, VIDEOS_DIR
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
