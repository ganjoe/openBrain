FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY *.py ./

EXPOSE 8791

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8791", "--log-level", "info"]
