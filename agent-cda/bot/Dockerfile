FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code and config
COPY . .

# Run the bot
CMD ["npm", "start"]
