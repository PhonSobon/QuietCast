#!/bin/sh
# Download the model into the mounted ./model folder on first start, then run the service.
if [ ! -f model/model.safetensors ]; then
  echo "RE-USE model not found in ./model - downloading (about 39 MB)..."
  python download_model.py || echo "Model download failed; the service will report it in /health."
fi
exec uvicorn app:app --host 0.0.0.0 --port 8001
