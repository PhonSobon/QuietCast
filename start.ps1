# Starts the AI denoiser, the speech-to-text service, the FastAPI backend and the Next.js frontend.
$root = $PSScriptRoot

# ---- AI denoiser (NVIDIA RE-USE on CPU) ----
$denoiser = Join-Path $root "denoiser"
$dpy = Join-Path $denoiser ".venv\Scripts\python.exe"
if (-not (Test-Path $dpy)) {
    Write-Host "Setting up the AI denoiser environment (one time, ~1 GB)..."
    python -m venv (Join-Path $denoiser ".venv")
    & $dpy -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    & $dpy -m pip install -r (Join-Path $denoiser "requirements.txt")
}
if (-not (Test-Path (Join-Path $denoiser "model\model.safetensors"))) {
    Write-Host "Downloading the RE-USE model into denoiser\model ..."
    & $dpy (Join-Path $denoiser "download_model.py")
}

# ---- speech to text (Sota ASR Khmer, ONNX) ----
$transcriber = Join-Path $root "transcriber"
$tpy = Join-Path $transcriber ".venv\Scripts\python.exe"
if (-not (Test-Path $tpy)) {
    Write-Host "Setting up the speech-to-text environment (one time)..."
    python -m venv (Join-Path $transcriber ".venv")
    & $tpy -m pip install -r (Join-Path $transcriber "requirements.txt")
}
if (-not (Test-Path (Join-Path $transcriber "model\encoder.int8.onnx"))) {
    Write-Host "Downloading the Khmer speech-to-text model into transcriber\model (needs HF_TOKEN in .env) ..."
    & $tpy (Join-Path $transcriber "download_model.py")
}

# ---- backend ----
$backend = Join-Path $root "backend"
if (-not (Test-Path (Join-Path $backend ".venv"))) {
    Write-Host "Creating backend virtual environment..."
    python -m venv (Join-Path $backend ".venv")
    & (Join-Path $backend ".venv\Scripts\python.exe") -m pip install -r (Join-Path $backend "requirements.txt")
}

# ---- frontend ----
$frontend = Join-Path $root "frontend"
if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Host "Installing frontend dependencies..."
    Push-Location $frontend; npm install; Pop-Location
}

Start-Process powershell -WorkingDirectory $denoiser -ArgumentList "-NoExit", "-Command", ".\.venv\Scripts\python.exe -m uvicorn app:app --port 8001"
if (Test-Path (Join-Path $transcriber "model\encoder.int8.onnx")) {
    Start-Process powershell -WorkingDirectory $transcriber -ArgumentList "-NoExit", "-Command", ".\.venv\Scripts\python.exe -m uvicorn app:app --port 8002"
} else {
    Write-Host "Speech to text is off: add HF_TOKEN to .env and run start.ps1 again." -ForegroundColor Yellow
}
Start-Process powershell -WorkingDirectory $backend -ArgumentList "-NoExit", "-Command", ".\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000"
Start-Process powershell -WorkingDirectory $frontend -ArgumentList "-NoExit", "-Command", "npm run dev"

Write-Host "AI denoiser: http://localhost:8001/health"
Write-Host "Subtitles:   http://localhost:8002/health"
Write-Host "Backend:     http://localhost:8000/docs"
Write-Host "Frontend:    http://localhost:3000"
