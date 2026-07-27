FROM denoland/deno:latest

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY deno.json ./
RUN deno install

# Copy application code
COPY index.ts ./
COPY stdio.ts ./
COPY tools.ts ./
COPY drawio_generator.ts ./
COPY google_drive.ts ./

EXPOSE 8796

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
