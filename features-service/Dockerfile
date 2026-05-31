FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY src/ ./src/

# Create required directories (volumes will override at runtime)
RUN mkdir -p /app/config /app/data/parquet /app/logs

# Set environment variable so main.py can find the base dir
ENV APP_BASE_DIR=/app

# Expose REST API port
EXPOSE 8003

# Healthcheck via the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8003/health')" || exit 1

CMD ["python", "src/main.py"]
