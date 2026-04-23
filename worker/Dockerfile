FROM python:3.11-slim

# System deps for LightGBM + scikit-learn (no GPU required)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for layer caching
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY worker/ /app/worker/

# Model artifacts — mounted at runtime via Fly.io volume, not baked into image.
# Directory structure expected at startup:
#   /app/worker/models/{moneyline,run_line,totals}/artifacts/model.pkl
# If artifacts are absent, the worker starts but /predict returns 503 for that market.
RUN mkdir -p /app/worker/models/moneyline/artifacts \
             /app/worker/models/run_line/artifacts \
             /app/worker/models/totals/artifacts

# Non-root user for security
RUN useradd -m -u 1000 worker
USER worker

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Fly.io expects the process to listen on PORT (default 8080)
EXPOSE 8080

CMD ["uvicorn", "worker.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
