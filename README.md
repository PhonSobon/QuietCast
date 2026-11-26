# QuietCast

> Record your screen and camera, then clean up the sound with AI. Runs on your own computer, no GPU needed.

Record your **screen**, your **camera**, or **both** (camera bubble on top of the screen) with
microphone and system audio, right in the browser. Then download the video or save it to a
library on the server.

```
QuietCast/
├── frontend/   Next.js 16 + React 19 + Tailwind: recording UI and library
├── backend/    FastAPI + SQLite: storage, streaming, thumbnails, MP4 conversion (ffmpeg)
└── denoiser/   AI noise removal: NVIDIA NemotronLabs RE-USE running on the CPU
    └── model/  the downloaded model (weights + code + license), kept locally
```

## AI noise removal (NVIDIA RE-USE, CPU)

[NVIDIA-NemotronLabs-RE-USE](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE) is a universal
speech-enhancement model. It removes background noise, echo/reverb, clipping and poor-microphone sound.

- **No GPU needed.** The model's Mamba layers normally need the CUDA-only `mamba_ssm` package.
  `denoiser/mamba_cpu.py` re-implements that layer for the CPU with the same weight names, so NVIDIA's
  checkpoint loads unchanged. The sequential "selective scan" runs in a fused, multi-threaded Numba kernel.
- **Local model.** `denoiser/model/` holds everything (~39 MB). Nothing is downloaded at runtime.
  Re-download with `python denoiser/download_model.py`.
- **How it's used.** Turn on *Remove background noise (AI)* on the record page, or tick it when saving.
  You can also press *Remove noise* on any video in the library. The backend extracts the audio, the
  denoiser cleans it, and the clean audio is put back next to the original video (video is not re-encoded).
  The original is kept, and you can switch between *Original* and *Noise removed* in the player.
- **Speed/quality.** `SAMPLE_RATE` (default `16000`) sets the processing rate. Measured on an
  Intel Core Ultra 7 155H laptop CPU:

  | `SAMPLE_RATE` | Processing time per minute of audio |
  |---|---|
  | 16000 (default) | ~2.3 min |
  | 48000 (full-band) | ~6.4 min |

  Noise removal runs in the background, so you can keep recording while it works.
- **Why not ONNX Runtime?** ONNX has no operator for Mamba's selective scan. Exporting it unrolls
  thousands of time steps into a huge graph that runs slower, not faster. Instead, the scan is a fused
  SIMD kernel (Numba) and the projections use PyTorch's oneDNN/MKL matmuls. Its output matches the
  exact float32 computation to ~97 dB SNR. `python denoiser/mamba_cpu.py` runs the correctness self-test.
- License: the model is under the OpenMDW-1.1 license (`denoiser/model/LICENSE`).

## Features

**Recording (runs in the browser)**
- Modes: Screen, Camera, or Screen + Camera
- Camera bubble: 4 corner positions, 3 sizes, circle / rounded / square, mirror. You can move or hide it *while recording*
- Audio: choose a microphone (with a live level meter), noise suppression, and system/tab audio, mixed together
- Quality 720p / 1080p / 1440p at 30 or 60 fps; WebM or MP4 (when the browser supports it)
- Choose what to share: entire screen, a window, or a browser tab
- Countdown (3/5/10 s), pause/resume, auto-stop timer, and the timer shown in the tab title
- Stops automatically when you click the browser's "Stop sharing" button
- Settings are remembered between visits

**After recording**
- Preview, rename, download to your computer, or upload to the library (with a progress bar)
- Optional auto-save to the library

**Library (backend)**
- Grid of recordings with thumbnails, search, play, rename, delete, copy link
- Convert WebM to MP4 (H.264/AAC) on the server for maximum compatibility

## Requirements

- Node.js 20+ and Python 3.10+
- [ffmpeg](https://ffmpeg.org/) on your PATH (optional; needed for thumbnails and MP4 conversion)
- A desktop browser: Chrome or Edge recommended. Firefox works; Safari has limited screen/audio support.

## Run it

**Backend** (http://localhost:8000, API docs at http://localhost:8000/docs):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**AI denoiser** (http://localhost:8001/health), optional:

```powershell
cd denoiser
python -m venv .venv
.\.venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
python download_model.py          # only if denoiser/model is missing
uvicorn app:app --port 8001
```

**Frontend** (http://localhost:3000):

```powershell
cd frontend
npm install
npm run dev
```

On Windows you can instead run `start.ps1` from the project root, which sets everything up and opens all three servers.

## Configuration

| Where | Variable | Default | Purpose |
|---|---|---|---|
| frontend `.env.local` | `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend URL |
| backend env | `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed frontend origins |
| backend env | `STORAGE_DIR` | `backend/storage` | Where videos, thumbnails and the SQLite DB live |
| backend env | `MAX_UPLOAD_MB` | `4096` | Max upload size |
| backend env | `FFMPEG_PATH` | auto-detected | Path to ffmpeg |
| backend env | `DENOISER_URL` | `http://localhost:8001` | AI denoiser service (empty string disables it) |
| denoiser env | `SAMPLE_RATE` | `16000` | Processing rate (8000–48000). Higher is better quality but slower |
| denoiser env | `THREADS` | CPU cores − 1 | CPU threads |
| denoiser env | `CHUNK_SECONDS` / `OVERLAP_SECONDS` | `8` / `0.5` | Chunking for long audio |
| denoiser env | `MODEL_DIR` | `denoiser/model` | Where the model lives |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Status + whether ffmpeg is available |
| GET | `/api/recordings?q=` | List / search recordings |
| POST | `/api/recordings` | Upload (multipart: `file`, `title`, `duration_sec`, `mode`, `width`, `height`) |
| GET | `/api/recordings/{id}` | Metadata |
| PATCH | `/api/recordings/{id}` | Rename `{ "title": "..." }` |
| DELETE | `/api/recordings/{id}` | Delete recording and its files |
| GET | `/api/recordings/{id}/file?format=original\|mp4&download=true` | Stream (supports Range) or download |
| GET | `/api/recordings/{id}/thumbnail` | JPEG thumbnail |
| POST | `/api/recordings/{id}/convert` | Start MP4 conversion in the background (uses the clean audio if available) |
| POST | `/api/recordings/{id}/denoise` | Start AI noise removal in the background |

Upload also accepts `denoise=true` to start noise removal right away, and `/file?format=denoised` serves the clean version.

## Notes

- Browsers only allow screen/camera capture on **localhost or HTTPS**. To deploy, serve both apps over HTTPS
  and set `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` to match.
- The API has **no authentication** yet. Add it before exposing the backend to the internet.
- Full *system* audio capture is only available in Chrome/Edge on Windows and ChromeOS. Elsewhere you can
  share a browser tab's audio.
