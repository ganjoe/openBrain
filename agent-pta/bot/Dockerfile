FROM node:22-slim

WORKDIR /app

# Install runtime dependencies first (cached layer)
COPY --from=runtime package.json runtime/package.json
COPY --from=runtime tsconfig.json runtime/tsconfig.json
RUN cd runtime && npm install

# Copy runtime source files
COPY --from=runtime *.ts runtime/

# Copy bot-specific files
COPY package.json tsconfig.json ./
RUN npm install

COPY index.ts ibkr_sync.ts start_bot.sh ./
RUN chmod +x /app/start_bot.sh

# Run the bot and the sync script
CMD ["/app/start_bot.sh"]
