# Speech to text: Sota ASR Khmer (ONNX Runtime, CPU)
# The model is never copied into the image (its license forbids redistribution);
# it is mounted from ./model and downloaded with your HF_TOKEN on first start.
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app.py download_model.py docker-entrypoint.sh ./

EXPOSE 8002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request,json; assert json.load(urllib.request.urlopen('http://localhost:8002/health', timeout=4))['ok']"
CMD ["sh", "docker-entrypoint.sh"]
