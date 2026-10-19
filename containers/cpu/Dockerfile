# syntax=docker/dockerfile:1
# build-context: ..
# One image for video-finish, audio-beat-sync, audio-mix, and audio-master.
# Build with the containers/ directory as the context and this file as the dockerfile.
# CPU_APP selects the service. image-prep stays its own image.
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NUMBA_CACHE_DIR=/app/numba-cache \
    MPLCONFIGDIR=/tmp/mpl-cache \
    LIBROSA_CACHE_DIR=/tmp/librosa-cache \
    HF_HUB_OFFLINE=1 \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        libgomp1 \
        fonts-dejavu-core \
        fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY cpu/requirements.txt /tmp/cpu-requirements.txt
RUN pip install -r /tmp/cpu-requirements.txt

# Same numba warm as audio-beat-sync: the first /analyze must not pay the compile.
RUN find /usr/local/lib/python3.11/site-packages/librosa -name '*.py' -exec touch -d '@1700000000' {} + \
    && python -c "import librosa, numpy; librosa.beat.beat_track(y=numpy.zeros(22050, dtype='float32'), sr=22050); print('warm OK')" \
    && test -d /app/numba-cache && echo "numba cache baked: $(find /app/numba-cache -name '*.nbi' | wc -l) kernels"

COPY cpu/app.py /app/app.py
COPY video-finish /app/video-finish
COPY audio-beat-sync /app/audio-beat-sync
COPY audio-mix /app/audio-mix
COPY audio-master /app/audio-master

EXPOSE 8000
CMD ["python", "app.py"]
