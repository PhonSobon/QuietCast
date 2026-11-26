import logging
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .config import CORS_ORIGINS, DENOISER_URL, FFMPEG, MAX_UPLOAD_MB, THUMBS_DIR, TRANSCRIBER_URL, VIDEOS_DIR
from .db import connect, init_db, row_to_dict
from .media import (
    captions_path,
    convert_to_mp4,
    denoise_recording,
    denoise_then_transcribe,
    denoiser_health,
    make_thumbnail,
    remove_captions,
    transcribe_recording,
    transcriber_health,
)

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="QuietCast API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_TYPES = {"video/webm": ".webm", "video/mp4": ".mp4", "video/x-matroska": ".mkv"}
CHUNK = 1024 * 1024


class Recording(BaseModel):
    id: str
    title: str
    mime_type: str
    size_bytes: int
    duration_sec: float
    mode: str
    width: int | None
    height: int | None
    has_thumbnail: bool
    has_mp4: bool
    convert_status: str
    has_denoised: bool
    denoise_status: str
    denoise_error: str | None
    has_transcript: bool
    transcript_status: str
    transcript_error: str | None
    created_at: str


class RecordingUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


def _serialize(row: dict) -> Recording:
    return Recording(
        id=row["id"],
        title=row["title"],
        mime_type=row["mime_type"],
        size_bytes=row["size_bytes"],
        duration_sec=row["duration_sec"],
        mode=row["mode"],
        width=row["width"],
        height=row["height"],
        has_thumbnail=bool(row["has_thumbnail"]),
        has_mp4=bool(row["mp4_filename"]),
        convert_status=row["convert_status"],
        has_denoised=bool(row.get("denoised_filename")),
        denoise_status=row.get("denoise_status") or "none",
        denoise_error=row.get("denoise_error"),
        has_transcript=(row.get("transcript_status") or "none") == "done",
        transcript_status=row.get("transcript_status") or "none",
        transcript_error=row.get("transcript_error"),
        created_at=row["created_at"],
    )


def _get_row(rec_id: str) -> dict:
    with connect() as conn:
        row = row_to_dict(conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone())
    if not row:
        raise HTTPException(404, "Recording not found")
    return row


def _safe_name(title: str) -> str:
    return re.sub(r"[^\w\- ]+", "", title).strip().replace(" ", "_")[:80] or "recording"


@app.get("/api/health")
def health() -> dict:
    den = denoiser_health()
    tr = transcriber_health()
    return {
        "status": "ok",
        "ffmpeg": bool(FFMPEG),
        "denoiser": {"available": bool(den.get("ok")) and bool(FFMPEG), "device": den.get("device"), "error": den.get("error")},
        "transcriber": {"available": bool(tr.get("ok")) and bool(FFMPEG), "languages": tr.get("languages"), "error": tr.get("error")},
    }


def _start_denoise(rec_id: str, filename: str, background: BackgroundTasks) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE recordings SET denoise_status = 'processing', denoise_error = NULL WHERE id = ?", (rec_id,)
        )
    background.add_task(denoise_recording, rec_id, filename)


def _mark_transcribing(rec_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE recordings SET transcript_status = 'processing', transcript_error = NULL WHERE id = ?", (rec_id,)
        )


@app.get("/api/recordings", response_model=list[Recording])
def list_recordings(q: str | None = None) -> list[Recording]:
    sql, params = "SELECT * FROM recordings", []
    if q:
        sql += " WHERE title LIKE ? OR transcript_text LIKE ?"  # search inside transcripts too
        params += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY created_at DESC"
    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_serialize(dict(r)) for r in rows]


@app.post("/api/recordings", response_model=Recording, status_code=201)
async def upload_recording(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form("Untitled recording"),
    duration_sec: float = Form(0),
    mode: Literal["screen", "camera", "screen_camera"] = Form("screen"),
    width: int | None = Form(None),
    height: int | None = Form(None),
    denoise: bool = Form(False),
    transcribe: bool = Form(False),
) -> Recording:
    mime = (file.content_type or "").split(";")[0].strip().lower()
    if mime not in ALLOWED_TYPES:
        raise HTTPException(415, f"Unsupported file type: {file.content_type}")

    rec_id = uuid.uuid4().hex
    filename = f"{rec_id}{ALLOWED_TYPES[mime]}"
    dst = VIDEOS_DIR / filename
    limit = MAX_UPLOAD_MB * CHUNK
    size = 0
    try:
        with dst.open("wb") as out:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB limit")
                out.write(chunk)
    except BaseException:
        dst.unlink(missing_ok=True)
        raise
    if size == 0:
        dst.unlink(missing_ok=True)
        raise HTTPException(400, "Empty file")

    row = {
        "id": rec_id,
        "title": title.strip()[:200] or "Untitled recording",
        "filename": filename,
        "mime_type": mime,
        "size_bytes": size,
        "duration_sec": max(0.0, duration_sec),
        "mode": mode,
        "width": width,
        "height": height,
        "has_thumbnail": 0,
        "mp4_filename": filename if mime == "video/mp4" else None,
        "convert_status": "done" if mime == "video/mp4" else "none",
        "denoise_status": "none",
        "transcript_status": "none",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    with connect() as conn:
        conn.execute(f"INSERT INTO recordings ({cols}) VALUES ({marks})", tuple(row.values()))
    background.add_task(make_thumbnail, rec_id, filename)
    want_denoise = denoise and bool(DENOISER_URL) and bool(FFMPEG)
    want_transcript = transcribe and bool(TRANSCRIBER_URL) and bool(FFMPEG)
    if want_denoise and want_transcript:
        # transcribe the clean audio once noise removal is done
        with connect() as conn:
            conn.execute("UPDATE recordings SET denoise_status = 'processing' WHERE id = ?", (rec_id,))
        _mark_transcribing(rec_id)
        background.add_task(denoise_then_transcribe, rec_id, filename)
        row["denoise_status"] = row["transcript_status"] = "processing"
    elif want_denoise:
        _start_denoise(rec_id, filename, background)
        row["denoise_status"] = "processing"
    elif want_transcript:
        _mark_transcribing(rec_id)
        background.add_task(transcribe_recording, rec_id)
        row["transcript_status"] = "processing"
    return _serialize(row)


@app.get("/api/recordings/{rec_id}", response_model=Recording)
def get_recording(rec_id: str) -> Recording:
    return _serialize(_get_row(rec_id))


@app.patch("/api/recordings/{rec_id}", response_model=Recording)
def update_recording(rec_id: str, body: RecordingUpdate) -> Recording:
    _get_row(rec_id)
    with connect() as conn:
        conn.execute("UPDATE recordings SET title = ? WHERE id = ?", (body.title.strip(), rec_id))
    return _serialize(_get_row(rec_id))


@app.delete("/api/recordings/{rec_id}", status_code=204)
def delete_recording(rec_id: str) -> None:
    row = _get_row(rec_id)
    (VIDEOS_DIR / row["filename"]).unlink(missing_ok=True)
    for extra in (row["mp4_filename"], row["denoised_filename"]):
        if extra:
            (VIDEOS_DIR / extra).unlink(missing_ok=True)
    (THUMBS_DIR / f"{rec_id}.jpg").unlink(missing_ok=True)
    remove_captions(rec_id)
    with connect() as conn:
        conn.execute("DELETE FROM recordings WHERE id = ?", (rec_id,))


@app.get("/api/recordings/{rec_id}/file")
def get_file(
    rec_id: str, format: Literal["original", "mp4", "denoised"] = "original", download: bool = False
):
    row = _get_row(rec_id)
    suffix = ""
    if format == "denoised":
        if not row["denoised_filename"]:
            raise HTTPException(404, "No noise-removed version yet")
        name, mime, suffix = row["denoised_filename"], row["mime_type"], "_clean"
    elif format == "mp4":
        if not row["mp4_filename"]:
            raise HTTPException(404, "MP4 version not available - convert it first")
        name, mime = row["mp4_filename"], "video/mp4"
    else:
        name, mime = row["filename"], row["mime_type"]
    path = VIDEOS_DIR / name
    if not path.exists():
        raise HTTPException(404, "File missing on disk")
    return FileResponse(
        path,
        media_type=mime,
        filename=f"{_safe_name(row['title'])}{suffix}{path.suffix}",
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/api/recordings/{rec_id}/thumbnail")
def get_thumbnail(rec_id: str):
    path = THUMBS_DIR / f"{rec_id}.jpg"
    if not path.exists():
        raise HTTPException(404, "No thumbnail")
    return FileResponse(path, media_type="image/jpeg")


@app.post("/api/recordings/{rec_id}/convert", response_model=Recording)
def convert(rec_id: str, background: BackgroundTasks) -> Recording:
    if not FFMPEG:
        raise HTTPException(501, "ffmpeg is not installed on the server")
    row = _get_row(rec_id)
    if row["mp4_filename"] or row["convert_status"] == "processing":
        return _serialize(row)
    with connect() as conn:
        conn.execute("UPDATE recordings SET convert_status = 'processing' WHERE id = ?", (rec_id,))
    background.add_task(convert_to_mp4, rec_id, row["filename"])
    return _serialize(_get_row(rec_id))


@app.post("/api/recordings/{rec_id}/denoise", response_model=Recording)
def denoise(rec_id: str, background: BackgroundTasks) -> Recording:
    """Remove background noise with NVIDIA NemotronLabs RE-USE (runs in the background)."""
    if not FFMPEG:
        raise HTTPException(501, "ffmpeg is not installed on the server")
    if not DENOISER_URL:
        raise HTTPException(501, "AI noise removal is disabled (DENOISER_URL is empty)")
    row = _get_row(rec_id)
    if row["denoise_status"] == "processing":
        return _serialize(row)
    _start_denoise(rec_id, row["filename"], background)
    return _serialize(_get_row(rec_id))


@app.post("/api/recordings/{rec_id}/transcribe", response_model=Recording)
def transcribe(rec_id: str, background: BackgroundTasks) -> Recording:
    """Speech to text (Khmer, English, mixed) with Sota ASR; makes subtitles. Runs in the background."""
    if not FFMPEG:
        raise HTTPException(501, "ffmpeg is not installed on the server")
    if not TRANSCRIBER_URL:
        raise HTTPException(501, "Speech to text is disabled (TRANSCRIBER_URL is empty)")
    row = _get_row(rec_id)
    if row["transcript_status"] == "processing":
        return _serialize(row)
    _mark_transcribing(rec_id)
    background.add_task(transcribe_recording, rec_id)
    return _serialize(_get_row(rec_id))


@app.get("/api/recordings/{rec_id}/transcript")
def get_transcript(rec_id: str):
    """Full transcript: text, caption lines with times, and word timings."""
    _get_row(rec_id)
    path = captions_path(rec_id, "json")
    if not path.exists():
        raise HTTPException(404, "No transcript yet")
    return FileResponse(path, media_type="application/json")


@app.get("/api/recordings/{rec_id}/captions")
def get_captions(rec_id: str, format: Literal["vtt", "srt", "txt"] = "vtt", download: bool = False):
    """Subtitles as WebVTT (for the player), SRT (for YouTube / editors) or plain text."""
    row = _get_row(rec_id)
    path = captions_path(rec_id, format)
    if not path.exists():
        raise HTTPException(404, "No subtitles yet")
    media = {"vtt": "text/vtt", "srt": "application/x-subrip", "txt": "text/plain"}[format]
    return FileResponse(
        path,
        media_type=f"{media}; charset=utf-8",
        filename=f"{_safe_name(row['title'])}.{format}",
        content_disposition_type="attachment" if download else "inline",
    )
