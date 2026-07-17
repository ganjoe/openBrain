FROM denoland/deno:latest

# yt-dlp for YouTube VTT downloads (Phase 2: + ffmpeg for Whisper/Frames)
RUN apt-get update && apt-get install -y python3 pipx && pipx install yt-dlp && apt-get clean
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY deno.json ./
RUN deno install

# Copy application code
COPY index.ts ./
COPY tools/ ./tools/

EXPOSE 8787

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-run", "--allow-write=/data", "index.ts"]
