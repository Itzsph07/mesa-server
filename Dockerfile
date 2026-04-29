# Use official Node.js image
FROM node:20-slim

# Create app directory
WORKDIR /app

# Install FFmpeg with full codec support
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    libavcodec-extra \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installation
RUN ffmpeg -version

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose the port
EXPOSE 5000

# Start the app
CMD ["npm", "start"]
