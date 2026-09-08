# LinguaDub — YouTube Language Changer

Full-stack AI dubbing starter. Paste a YouTube URL you own or are authorized to process, choose a target language, and generate a dubbed MP4 while preserving the original video visuals.

## Included
- React + Vite responsive UI
- Express background-job API
- YouTube ingestion via yt-dlp
- Authorized video upload API
- FFmpeg audio extraction and MP4 muxing
- OpenAI transcription, translation and text-to-speech
- MP4 playback and download
- Dockerfile with FFmpeg + yt-dlp

## Run locally
1. Node 22+ and FFmpeg are required. Install yt-dlp if using YouTube URLs.
2. `npm install`
3. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
4. Terminal A: `npm run server`
5. Terminal B: `npm run dev`
6. Open the Vite URL.

The frontend uses `/api` by default and can be pointed to another backend with `VITE_API_URL`.

## Docker
`docker build -t linguadub .`

`docker run --rm -p 8787:8787 --env-file .env linguadub`

## API
- `GET /api/health`
- `POST /api/dub` JSON `{ "url": "...", "targetLanguage": "Gujarati" }`
- `POST /api/dub/upload` multipart form: `video` + `targetLanguage`
- `GET /api/dub/:jobId`

## Production notes
- The job map is in-memory; use a queue/database and object storage for production.
- Add authentication, rate limits, stronger file validation, signed downloads and automatic cleanup before public launch.
- Long videos may take longer than one minute.
- AI/API usage can incur provider charges.
- Use only videos you own or are authorized to download/process, and follow the source platform's terms. Do not bypass DRM or access controls.
