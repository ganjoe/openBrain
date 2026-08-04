FROM node:22-slim

WORKDIR /app

# Install runtime dependencies first (cached layer)
COPY --from=runtime package.json runtime/package.json
COPY --from=runtime tsconfig.json runtime/tsconfig.json
RUN cd runtime && npm install

# Copy runtime source files
COPY --from=runtime *.ts runtime/

# Copy bot-specific files (bootstrapper + local package.json + tsconfig)
COPY package.json tsconfig.json ./
RUN npm install

COPY index.ts ./

# Run the bot via ts-node (defined in package.json scripts.start)
CMD ["npm", "start"]
