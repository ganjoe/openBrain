FROM denoland/deno:latest

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY deno.json ./
RUN deno install

# Copy application code
COPY index.ts ./
COPY tools/ ./tools/

EXPOSE 8790

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
