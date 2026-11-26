import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", BASE_DIR / "storage"))
VIDEOS_DIR = STORAGE_DIR / "videos"
THUMBS_DIR = STORAGE_DIR / "thumbnails"
DB_PATH = STORAGE_DIR / "recordings.db"

# Comma-separated list of allowed frontend origins
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "4096"))
FFMPEG = os.getenv("FFMPEG_PATH") or shutil.which("ffmpeg")

# AI noise removal service (NVIDIA NemotronLabs RE-USE, see ../denoiser). Empty string disables it.
DENOISER_URL = os.getenv("DENOISER_URL", "http://localhost:8001").rstrip("/")
DENOISER_TIMEOUT_SEC = float(os.getenv("DENOISER_TIMEOUT_SEC", "3600"))

for d in (VIDEOS_DIR, THUMBS_DIR):
    d.mkdir(parents=True, exist_ok=True)
