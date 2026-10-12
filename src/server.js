require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '16kb' }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const MAX_OUTPUT_MB = Number(process.env.MAX_OUTPUT_MB || 100);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const TMP_DIR = path.join(os.tmpdir(), 'thenuva-video-api');

fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'video/mp4', 'video/quicktime', 'video/webm',
      'video/x-matroska', 'video/x-msvideo', 'application/octet-stream'
    ]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Upload a video file.'));
    }
    cb(null, true);
  }
});

function auth(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'API_KEY is not configured on the server'
    });
  }
  const supplied = String(req.get('x-api-key') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  next();
}

function runFfmpeg(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('FFmpeg timed out'));
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-2500)}`));
    });
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ success: true, service: 'THENUVA X MD Video API', status: 'ok' });
});

app.post('/api/convert', auth, upload.single('video'), async (req, res, next) => {
  let outputPath;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Attach a video file using multipart field name "video"'
      });
    }

    const quality = String(req.body.quality || '720p').toLowerCase();
    const profiles = {
      '360p': { width: 640, crf: '29', audio: '96k' },
      '480p': { width: 854, crf: '28', audio: '112k' },
      '720p': { width: 1280, crf: '27', audio: '128k' }
    };
    const profile = profiles[quality];
    if (!profile) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        success: false,
        error: 'quality must be 360p, 480p, or 720p'
      });
    }

    const jobId = crypto.randomBytes(12).toString('hex');
    outputPath = path.join(TMP_DIR, `${jobId}.mp4`);
    const filter = `scale='min(${profile.width},iw)':-2:force_original_aspect_ratio=decrease`;
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', req.file.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', profile.crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', profile.audio,
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',
      outputPath
    ]);

    const stat = await fsp.stat(outputPath);
    if (stat.size > MAX_OUTPUT_MB * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: `Converted video exceeds ${MAX_OUTPUT_MB} MB output limit`
      });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="thenuva-${jobId}.mp4"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outputPath);
    stream.on('error', next);
    stream.pipe(res);
    stream.on('close', cleanup);
    async function cleanup() {
      await Promise.all([
        fsp.unlink(req.file.path).catch(() => {}),
        fsp.unlink(outputPath).catch(() => {})
      ]);
    }
  } catch (err) {
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    if (outputPath) await fsp.unlink(outputPath).catch(() => {});
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `Upload exceeds ${MAX_UPLOAD_MB} MB limit`
    });
  }
  const message = err.message || 'Internal server error';
  console.error('[VIDEO API]', message);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`THENUVA X MD Video API listening on port ${PORT}`);
});
