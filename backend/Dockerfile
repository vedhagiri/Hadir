FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Native-thread caps: prevent each OpenCV/ONNX/OpenBLAS call from
    # spawning a thread-pool the size of all vCPUs. With 21 cameras and
    # a single serialising _detect_lock, one detection runs at a time;
    # giving it 2–4 intra-op threads beats 24 (cache thrash). The Python-
    # side cv2/torch/ort caps are applied in main.py lifespan via
    # detection/thread_limits.py; these env vars reach the native libs
    # that read them at import time (before Python even starts caps).
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    NUMEXPR_NUM_THREADS=2

WORKDIR /app

# System deps:
# * build-essential / libpq-dev — psycopg compile path.
# * libpango-1.0-0, libpangoft2-1.0-0, libcairo2, libgdk-pixbuf-2.0-0,
#   libffi-dev, shared-mime-info, fonts-liberation — WeasyPrint
#   runtime (P17). WeasyPrint dlopen()s these via cffi at import; if
#   one is missing the import itself fails, not just rendering. The
#   ``fonts-liberation`` package ships a generic sans/serif fallback
#   so PDFs render cleanly on a host with no other fonts installed.
# Pinned to bookworm-slim for reproducibility.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libcairo2 \
        libgdk-pixbuf-2.0-0 \
        libffi-dev \
        shared-mime-info \
        fonts-liberation \
        ffmpeg \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --upgrade pip \
    && pip install ".[dev]"

COPY maugood ./maugood
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY scripts ./scripts
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 8000

CMD ["./entrypoint.sh"]
