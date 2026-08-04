FROM node:22-slim

# Install Playwright system dependencies
RUN npx playwright install-deps chromium

WORKDIR /app

# Install npm dependencies (cached layer)
COPY package.json ./
RUN npm install

# Install Playwright browser binary
RUN npx playwright install chromium

# Copy source
COPY tsconfig.json sources.yaml ./
COPY lib/ lib/
COPY index.ts ./

# Create reports directory
RUN mkdir -p /data/reports

EXPOSE 8797

CMD ["npm", "start"]
