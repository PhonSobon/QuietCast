#!/bin/sh
# Download the model into the mounted ./model folder on first start (needs HF_TOKEN), then run the service.
if [ ! -f model/encoder.int8.onnx ]; then
  echo "Sota ASR model not found in ./model - downloading with HF_TOKEN..."
  python download_model.py || echo "Model download failed (is HF_TOKEN set in .env?). Subtitles stay off; see /health."
fi
exec uvicorn app:app --host 0.0.0.0 --port 8002
