FROM denoland/deno:latest

WORKDIR /app

COPY router.ts .

EXPOSE 11434

CMD ["run", "--allow-net", "--allow-env", "router.ts"]
