"""API tests. Run from the backend folder: pytest"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

# Isolated storage, and no denoiser, before the app is imported
_TMP = tempfile.mkdtemp(prefix="recorder-test-")
os.environ["STORAGE_DIR"] = _TMP
os.environ["DENOISER_URL"] = "http://127.0.0.1:9"  # nothing listens here

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastapi.testclient import TestClient  # noqa: E402

from app.config import FFMPEG  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(scope="module")
def sample_webm() -> bytes:
    if not FFMPEG:
        pytest.skip("ffmpeg not installed")
    out = Path(_TMP) / "sample.webm"
    subprocess.run(
        [FFMPEG, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15",
         "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libvpx", "-c:a", "libopus", str(out)],
        check=True,
    )
    return out.read_bytes()


def _upload(client, data: bytes, **form):
    fields = {"title": "Test clip", "duration_sec": "2", "mode": "screen", **form}
    return client.post("/api/recordings", files={"file": ("a.webm", data, "video/webm;codecs=vp8,opus")}, data=fields)


def test_health_reports_denoiser_unavailable(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["denoiser"]["available"] is False


def test_rejects_non_video(client):
    r = client.post("/api/recordings", files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 415


def test_rejects_empty_file(client):
    r = client.post("/api/recordings", files={"file": ("a.webm", b"", "video/webm")})
    assert r.status_code == 400


def test_upload_list_rename_stream_delete(client, sample_webm):
    rec = _upload(client, sample_webm).json()
    rid = rec["id"]
    assert rec["mime_type"] == "video/webm" and rec["size_bytes"] == len(sample_webm)

    assert any(r["id"] == rid for r in client.get("/api/recordings?q=Test").json())
    assert client.get("/api/recordings?q=nomatch").json() == []

    assert client.patch(f"/api/recordings/{rid}", json={"title": "Renamed"}).json()["title"] == "Renamed"

    r = client.get(f"/api/recordings/{rid}/file", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100

    r = client.get(f"/api/recordings/{rid}/file?download=true")
    assert "attachment" in r.headers["content-disposition"] and "Renamed" in r.headers["content-disposition"]

    assert client.get(f"/api/recordings/{rid}/thumbnail").status_code == 200  # made by background task

    assert client.delete(f"/api/recordings/{rid}").status_code == 204
    assert client.get(f"/api/recordings/{rid}").status_code == 404
    assert list((Path(_TMP) / "videos").iterdir()) == []


def test_convert_to_mp4(client, sample_webm):
    rid = _upload(client, sample_webm).json()["id"]
    client.post(f"/api/recordings/{rid}/convert")
    for _ in range(60):
        rec = client.get(f"/api/recordings/{rid}").json()
        if rec["convert_status"] != "processing":
            break
        time.sleep(0.5)
    assert rec["convert_status"] == "done" and rec["has_mp4"]
    r = client.get(f"/api/recordings/{rid}/file?format=mp4")
    assert r.headers["content-type"] == "video/mp4"


def test_denoise_fails_cleanly_without_service(client, sample_webm):
    rid = _upload(client, sample_webm, denoise="true").json()["id"]
    rec = client.get(f"/api/recordings/{rid}").json()
    assert rec["denoise_status"] == "failed"
    assert "denoiser" in rec["denoise_error"].lower()
    assert client.get(f"/api/recordings/{rid}/file?format=denoised").status_code == 404
