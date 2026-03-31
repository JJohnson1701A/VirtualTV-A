const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');
const { spawn, execFile } = require('child_process');
const db      = require('../db');

// ─── FFmpeg / FFprobe detection ───────────────────────────────────────────────
function findBinary(name) {
  const candidates = [
    name,
    `C:\\ffmpeg\\bin\\${name}.exe`,
    `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`,
    `C:\\Program Files (x86)\\ffmpeg\\bin\\${name}.exe`,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    } else {
      return c; // bare name — resolved via PATH
    }
  }
  return name;
}

const FFMPEG  = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

let _ffmpegAvailable = null;
function ffmpegAvailable() {
  if (_ffmpegAvailable !== null) return Promise.resolve(_ffmpegAvailable);
  return new Promise(resolve => {
    execFile(FFPROBE, ['-version'], { timeout: 5000 }, (err) => {
      _ffmpegAvailable = !err;
      if (err) console.warn('⚠️  ffprobe not found — transcoding disabled. Install FFmpeg to enable HEVC/MKV support.');
      else     console.log('✅ FFmpeg detected — HEVC/MKV transcoding enabled.');
      resolve(_ffmpegAvailable);
    });
  });
}
ffmpegAvailable(); // warm up on startup

// ─── Codec detection ──────────────────────────────────────────────────────────
function probeFile(filePath) {
  return new Promise((resolve) => {
    const args = ['-v','quiet','-print_format','json','-show_streams','-show_format', filePath];
    execFile(FFPROBE, args, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        // ffprobe failed — use extension as fallback so MKV/AVI still get transcoded
        const ext = path.extname(filePath).toLowerCase();
        const needsTranscode = ['.mkv','.avi','.wmv','.ts','.m2ts','.flv','.ogv'].includes(ext);
        console.log(`[probe] ffprobe error, ext fallback: ${path.basename(filePath)} → transcode=${needsTranscode}`);
        return resolve({ videoCodec: null, audioCodec: null, needsTranscode, durationMins: null });
      }
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const video = streams.find(s => s.codec_type === 'video');
        const audio = streams.find(s => s.codec_type === 'audio');
        const videoCodec = (video?.codec_name || '').toLowerCase();
        const audioCodec = (audio?.codec_name || '').toLowerCase();
        const ext = path.extname(filePath).toLowerCase();

        const badContainer  = ['.mkv','.avi','.wmv','.ts','.m2ts','.flv','.ogv'].includes(ext);
        const badVideoCodec = ['hevc','h265','vp9','av1','mpeg2video','mpeg4',
                               'theora','wmv1','wmv2','wmv3','vc1','flv1'].includes(videoCodec);
        const badAudioCodec = ['dts','truehd','mlp','eac3','opus','vorbis',
                               'wmav1','wmav2','wmapro'].includes(audioCodec);

        const durationSecs = parseFloat(data.format?.duration || video?.duration || 0);
        const durationMins = durationSecs > 0 ? durationSecs / 60 : null;
        resolve({ videoCodec, audioCodec, needsTranscode: badContainer || badVideoCodec || badAudioCodec, durationMins });
      } catch {
        const ext = path.extname(filePath).toLowerCase();
        const needsTranscode = ['.mkv','.avi','.wmv','.ts','.m2ts','.flv','.ogv'].includes(ext);
        resolve({ videoCodec: null, audioCodec: null, needsTranscode, durationMins: null });
      }
    });
  });
}

// ─── Transcoded stream via ffmpeg → H.264/AAC/MP4 ────────────────────────────
function streamTranscoded(filePath, res, seekToSecs = 0) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seekToSecs > 0) args.push('-ss', String(seekToSecs));
  args.push(
    '-i', filePath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-maxrate', '8M', '-bufsize', '16M',
    '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  );

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Transcoding', 'true');
  res.status(200);

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.error('[ffmpeg]', m); });
  ff.on('error', err => {
    console.error('[ffmpeg spawn error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'FFmpeg error: ' + err.message });
    else res.destroy();
  });
  ff.on('close', () => res.end());
  res.on('close', () => ff.kill('SIGKILL'));
}

// ─── Direct stream for browser-native files (supports byte-range / seeking) ──
function streamDirect(filePath, res, req) {
  const stat      = fs.statSync(filePath);
  const fileSize  = stat.size;
  const range     = req.headers.range;
  const ext       = path.extname(filePath).toLowerCase();
  const mime      = { '.mp4':'video/mp4', '.m4v':'video/mp4', '.webm':'video/webm',
                      '.mov':'video/quicktime', '.mkv':'video/x-matroska',
                      '.avi':'video/x-msvideo', '.wmv':'video/x-ms-wmv' };
  const contentType = mime[ext] || 'video/mp4';

  if (range) {
    const [s, e]    = range.replace(/bytes=/,'').split('-');
    const start     = parseInt(s, 10);
    const end       = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ─── GET /api/media/stream/:id ────────────────────────────────────────────────
router.get('/stream/:id', async (req, res) => {
  try {
    const item = db.get('media').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Not found' });

    const filePath = item.file_path;
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'File not found on disk: ' + filePath });

    const seekToSecs = parseFloat(req.query.seek || '0') || 0;
    const available  = await ffmpegAvailable();

    // Use cached probe result, or probe now if missing
    let needsTranscode = item.needs_transcode;
    if (needsTranscode === undefined || needsTranscode === null) {
      if (available) {
        const probed = await probeFile(filePath);
        needsTranscode = probed.needsTranscode;
        const patch = {
          needs_transcode: needsTranscode,
          video_codec:     probed.videoCodec,
          audio_codec:     probed.audioCodec,
        };
        if (probed.durationMins && !item.duration_minutes) patch.duration_minutes = probed.durationMins;
        db.get('media').find({ id: item.id }).assign(patch).write();
      } else {
        // No ffprobe — use extension as a fast fallback
        // MKV/AVI/WMV always need transcoding; MP4/WebM usually don't
        const ext = path.extname(filePath).toLowerCase();
        needsTranscode = ['.mkv','.avi','.wmv','.ts','.m2ts','.flv','.ogv'].includes(ext);
        console.log(`[stream] no ffprobe — guessing transcode=${needsTranscode} from ext ${ext}`);
      }
    }

    if (needsTranscode && available) {
      console.log(`[transcode] ${path.basename(filePath)}${seekToSecs ? ` seek=${seekToSecs}s` : ''}`);
      streamTranscoded(filePath, res, seekToSecs);
    } else if (needsTranscode && !available) {
      // FFmpeg not found — attempt direct stream and hope the browser can handle it
      // (Chrome can play some MKVs natively with VP8/VP9/AV1 video + Vorbis/Opus audio)
      console.warn(`[stream] ${path.basename(filePath)} needs transcode but FFmpeg not available — streaming direct`);
      streamDirect(filePath, res, req);
    } else {
      streamDirect(filePath, res, req);
    }
  } catch (err) {
    console.error('[stream error]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/media/ffmpeg-status ────────────────────────────────────────────
router.get('/ffmpeg-status', async (req, res) => {
  const available = await ffmpegAvailable();
  res.json({ available, ffmpeg: FFMPEG, ffprobe: FFPROBE });
});

// ─── POST /api/media/probe-all — background probe entire library ──────────────
router.post('/probe-all', async (req, res) => {
  try {
    const available = await ffmpegAvailable();
    if (!available) return res.status(503).json({ error: 'FFmpeg not available' });
    // Probe files missing transcode flag OR missing accurate duration
    const unprobed = db.get('media').value().filter(m =>
      m.file_path && (m.needs_transcode === undefined || !m.duration_minutes)
    );
    res.json({ queued: unprobed.length, message: `Probing ${unprobed.length} files in background…` });
    (async () => {
      let done = 0;
      for (const item of unprobed) {
        try {
          if (!fs.existsSync(item.file_path)) continue;
          const probed = await probeFile(item.file_path);
          const patch = {
            needs_transcode: probed.needsTranscode,
            video_codec:     probed.videoCodec,
            audio_codec:     probed.audioCodec,
          };
          if (probed.durationMins) patch.duration_minutes = probed.durationMins;
          db.get('media').find({ id: item.id }).assign(patch).write();
          if (++done % 20 === 0) console.log(`[probe-all] ${done}/${unprobed.length}`);
        } catch { /* skip */ }
      }
      console.log(`[probe-all] done — ${done} files probed`);
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Standard CRUD ────────────────────────────────────────────────────────────
router.post('/batch-delete', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
    ids.forEach(id => db.get('media').remove({ id }).write());
    res.json({ success: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  try {
    const { type, is_filler, limit, sort = '-created_date' } = req.query;
    let items = db.get('media').value();
    if (type) items = items.filter(m => m.media_type === type);
    if (is_filler !== undefined) items = items.filter(m => Boolean(m.is_filler) === (is_filler === 'true'));
    const field = sort.startsWith('-') ? sort.slice(1) : sort;
    const dir   = sort.startsWith('-') ? -1 : 1;
    items = [...items].sort((a,b) => { const av=a[field]||'',bv=b[field]||''; return av<bv?-dir:av>bv?dir:0; });
    if (limit) items = items.slice(0, parseInt(limit));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const item = db.get('media').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    const item = { id: uuidv4(), created_date: new Date().toISOString(), updated_date: new Date().toISOString(), metadata_fetched: false, ...req.body };
    db.get('media').push(item).write();
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const existing = db.get('media').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updated = { ...existing, ...req.body, id: req.params.id, updated_date: new Date().toISOString() };
    db.get('media').find({ id: req.params.id }).assign(updated).write();
    // Bidirectional Ident-Channel sync
    if (updated.is_filler || updated.filler_type === 'Ident-Channel') {
      const oldId = existing.linked_channel_id || null;
      const newId = updated.linked_channel_id  || null;
      if (oldId !== newId) {
        if (oldId) {
          const ch = db.get('channels').find({ id: oldId }).value();
          if (ch) db.get('channels').find({ id: oldId }).assign({ assigned_filler: (ch.assigned_filler||[]).filter(i=>i!==req.params.id) }).write();
        }
        if (newId) {
          const ch = db.get('channels').find({ id: newId }).value();
          if (ch && !(ch.assigned_filler||[]).includes(req.params.id))
            db.get('channels').find({ id: newId }).assign({ assigned_filler: [...(ch.assigned_filler||[]), req.params.id] }).write();
        }
      }
    }
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    if (!db.get('media').find({ id: req.params.id }).value()) return res.status(404).json({ error: 'Not found' });
    db.get('media').remove({ id: req.params.id }).write();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
