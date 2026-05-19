FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code and config
COPY . .

# Run the bot and the sync script
CMD ["/app/start_bot.sh"]
