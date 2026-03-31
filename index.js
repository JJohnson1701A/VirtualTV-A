require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

// ─── Static Files ─────────────────────────────────────────────────────────────
// Serve fonts, uploaded images, etc.
app.use('/fonts', express.static(path.join(__dirname, 'public/fonts')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Serve EPG ticker text file
app.get('/api/epg-ticker', (req, res) => {
  const tickerPath = path.join(__dirname, 'epg-ticker.txt');
  const fs = require('fs');
  if (fs.existsSync(tickerPath)) {
    res.type('text/plain').send(fs.readFileSync(tickerPath, 'utf8'));
  } else {
    res.type('text/plain').send('VIRTUAL TV — YOUR PERSONAL BROADCAST EXPERIENCE');
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/media', require('./routes/media'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/channels', require('./routes/channelExport'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/metadata', require('./routes/metadata'));
const blocksRouter = require('./routes/blocks');
app.use('/api', blocksRouter);
app.use('/api/mv-blocks', require('./routes/mvblocks'));
app.use('/api/watch', require('./routes/watch'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/chapter-breaks', require('./routes/chapterbreaks'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const tmdbToken  = !!(process.env.TMDB_READ_TOKEN && process.env.TMDB_READ_TOKEN !== 'your_tmdb_token_here');
  const tmdbApiKey = !!(process.env.TMDB_API_KEY    && process.env.TMDB_API_KEY    !== 'your_tmdb_key_here');
  res.json({ 
    status: 'ok', 
    version: '1.0.0',
    media_root: process.env.MEDIA_ROOT || './media_test',
    tmdb_configured: tmdbToken || tmdbApiKey,
    tmdb_auth_type:  tmdbToken ? 'bearer_token' : tmdbApiKey ? 'api_key' : 'none',
    tvdb_configured: !!(process.env.TVDB_API_KEY && process.env.TVDB_API_KEY !== 'your_tvdb_key_here'),
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Virtual TV Server running at http://localhost:${PORT}`);
  console.log(`📁 Media root: ${process.env.MEDIA_ROOT || './media_test'}`);
  console.log(`🔑 TMDB: ${process.env.TMDB_API_KEY && process.env.TMDB_API_KEY !== 'your_tmdb_key_here' ? '✅ configured' : '⚠️  not configured'}`);
  console.log(`🔑 TVDB: ${process.env.TVDB_API_KEY && process.env.TVDB_API_KEY !== 'your_tvdb_key_here' ? '✅ configured' : '⚠️  not configured'}\n`);
});

module.exports = app;
