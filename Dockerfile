# Use Node.js 22 Debian slim (better native module support than Alpine)
FROM node:22-slim

# Create app directory
WORKDIR /usr/src/app

# Install system dependencies
# - python3, make, g++ for building native modules
# - libopus0, libopus-dev for @discordjs/opus
# - libsodium for encryption
# - ffmpeg for audio processing
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libopus0 \
    libopus-dev \
    libsodium23 \
    libsodium-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install app dependencies (use package-lock.json when available)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Cloud Run sets PORT; default to 8080
ENV NODE_ENV=production
ENV PORT=8080

# Expose the port the app listens on
EXPOSE 8080

# Start the bot
CMD ["node", "src/index.js"]
