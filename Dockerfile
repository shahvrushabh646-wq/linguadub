FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip ca-certificates && pip3 install --break-system-packages yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8787
CMD ["node","server/index.js"]
