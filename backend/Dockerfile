FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps required by psycopg and (later) OpenCV/InsightFace.
# Kept minimal for P1; pinned to bookworm-slim for reproducibility.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --upgrade pip \
    && pip install ".[dev]"

COPY hadir ./hadir

EXPOSE 8000

CMD ["uvicorn", "hadir.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
