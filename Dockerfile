# Use an official lightweight Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

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
