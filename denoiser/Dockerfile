# AI noise removal: NVIDIA NemotronLabs RE-USE on the CPU (no GPU needed)
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 NUMBA_CACHE_DIR=/tmp/numba-cache
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY mamba_cpu.py app.py download_model.py docker-entrypoint.sh ./

# ./model is mounted from the host (see docker-compose.yml); downloaded on first start if empty
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD python -c "import urllib.request,json; assert json.load(urllib.request.urlopen('http://localhost:8001/health', timeout=4))['ok']"
CMD ["sh", "docker-entrypoint.sh"]
