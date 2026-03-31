/**
 * chapterbreaks.js — Chapter Breaks Database
 *
 * Endpoints:
 *   GET  /api/chapter-breaks/stats   → counts of items with/without chapters
 *   GET  /api/chapter-breaks/export  → downloads the human-readable text file
 *   POST /api/chapter-breaks/import  → uploads text file, matches by hash, applies chapters
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const fs      = require('fs');
const multer  = require('multer');
const db      = require('../db');

// ── multer: accept upload into memory (file is text, always small) ────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a short, stable hash for a media item.
 * TV  : showName + season + episode + durationMins + fileSize
 * Movie: title   + year   + durationMins + fileSize
 * We use SHA-256 and take the first 18 hex chars — plenty of collision resistance
 * for a personal library.
 */
function computeHash(item) {
  let raw;
  if (item.media_type === 'tv_show') {
    raw = [
      (item.show_name  || item.title || '').toLowerCase().trim(),
      String(item.season_number  || 0),
      String(item.episode_number || 0),
      String(Math.round((item.duration_minutes || 0) * 100)),  // 2 decimal precision
      String(item.file_size || 0),
    ].join('|');
  } else {
    // movie (and anything else)
    raw = [
      (item.title || '').toLowerCase().trim(),
      String(item.year || ''),
      String(Math.round((item.duration_minutes || 0) * 100)),
      String(item.file_size || 0),
    ].join('|');
  }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 18);
}

/**
 * Format duration_minutes → HH:MM:SS
 */
function fmtDuration(mins) {
  if (!mins) return '00:00:00';
  const totalSecs = Math.round(mins * 60);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

/**
 * Format a single media item → one export line
 */
function formatLine(item, hash) {
  const chapters = (item.chapter_breaks || '').trim() || '00:00:00.000';
  const dur      = fmtDuration(item.duration_minutes);

  if (item.media_type === 'tv_show') {
    const show = item.show_name || item.title || 'Unknown Show';
    const s    = String(item.season_number  || 0).padStart(2, '0');
    const e    = String(item.episode_number || 0).padStart(2, '0');
    const ep   = item.title || 'Unknown Episode';
    return `TV - ${show} - S${s}E${e} - ${ep} (${dur}) - Hash: ${hash}; chapters: ${chapters}`;
  } else {
    const title = item.title || 'Unknown';
    const year  = item.year  ? ` (${item.year})` : '';
    return `Movie: ${title}${year} - ${dur} - Hash: ${hash}; chapters: ${chapters}`;
  }
}

/**
 * Parse one line of the export file.
 * Returns { hash, chapters } or null if line can't be parsed.
 */
function parseLine(line) {
  // Find hash and chapters sections
  const hashMatch     = line.match(/Hash:\s*([0-9a-f]+)/i);
  const chaptersMatch = line.match(/chapters:\s*(.+)$/i);
  if (!hashMatch) return null;
  return {
    hash:     hashMatch[1].trim(),
    chapters: chaptersMatch ? chaptersMatch[1].trim() : '',
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/chapter-breaks/stats
 * Returns counts for the Settings UI panel.
 */
router.get('/stats', (req, res) => {
  try {
    const all = db.get('media').value().filter(
      m => m.media_type === 'tv_show' || m.media_type === 'movie'
    );

    // ── movies ──
    const movies       = all.filter(m => m.media_type === 'movie');
    const moviesWith   = movies.filter(m => m.chapter_breaks && m.chapter_breaks.trim()).length;
    const moviesWithout = movies.length - moviesWith;

    // ── TV episodes ──
    const episodes       = all.filter(m => m.media_type === 'tv_show');
    const epsWith        = episodes.filter(m => m.chapter_breaks && m.chapter_breaks.trim());
    const epsWithout     = episodes.filter(m => !m.chapter_breaks || !m.chapter_breaks.trim());

    // Count distinct series
    const seriesWith    = new Set(epsWith.map(e => e.show_name || e.title)).size;
    const seriesWithout = new Set(epsWithout.map(e => e.show_name || e.title)).size;

    res.json({
      movies:   { with: moviesWith,   without: moviesWithout },
      episodes: { with: epsWith.length, without: epsWithout.length },
      series:   { with: seriesWith,   without: seriesWithout },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chapter-breaks/export
 * Streams the chapter breaks text file as a download.
 */
router.get('/export', (req, res) => {
  try {
    const all = db.get('media').value().filter(
      m => (m.media_type === 'tv_show' || m.media_type === 'movie') && !m.is_filler
    );

    // Sort: TV first (by show/season/episode), then movies (by title)
    const tvEps  = all.filter(m => m.media_type === 'tv_show').sort((a, b) => {
      const showCmp = (a.show_name||'').localeCompare(b.show_name||'');
      if (showCmp !== 0) return showCmp;
      if ((a.season_number||0) !== (b.season_number||0)) return (a.season_number||0) - (b.season_number||0);
      return (a.episode_number||0) - (b.episode_number||0);
    });
    const movieItems = all.filter(m => m.media_type === 'movie').sort((a, b) =>
      (a.title||'').localeCompare(b.title||'')
    );

    const header = [
      '# Virtual TV — Chapter Breaks Database',
      '# Generated: ' + new Date().toISOString(),
      '# Format:',
      '#   TV - <Show> - S##E## - <Title> (<duration>) - Hash: <hash>; chapters: <timestamps,...>',
      '#   Movie: <Title> (<year>) - <duration> - Hash: <hash>; chapters: <timestamps,...>',
      '#',
      '# To add chapter breaks: edit the timestamps after "chapters:"',
      '# Timestamps: HH:MM:SS.mmm  (comma-separated)',
      '# Items without chapters use: 00:00:00.000',
      '#',
    ].join('\n');

    const tvLines    = tvEps.map(m => formatLine(m, computeHash(m)));
    const movieLines = movieItems.map(m => formatLine(m, computeHash(m)));

    const body = [
      tvLines.length    ? '# ── TV Episodes ─────────────────────────────────────────────────────────────\n' + tvLines.join('\n')    : '',
      movieLines.length ? '\n# ── Movies ──────────────────────────────────────────────────────────────────\n' + movieLines.join('\n') : '',
    ].filter(Boolean).join('\n');

    const content = header + '\n' + body + '\n';

    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chapter-breaks-${date}.txt"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chapter-breaks/import
 * Accepts a text file upload (field name: "file").
 * Parses each line, builds a hash→chapters map, then patches matching media items.
 * Returns { matched, updated, skipped }.
 */
router.post('/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text  = req.file.buffer.toString('utf-8');
    const lines = text.split('\n');

    // Build hash → chapters map from file
    const fileMap = new Map(); // hash → chapters string
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parsed = parseLine(trimmed);
      if (!parsed) continue;
      // Only import if chapters are non-trivial (not just the placeholder)
      if (parsed.chapters && parsed.chapters !== '00:00:00.000') {
        fileMap.set(parsed.hash, parsed.chapters);
      }
    }

    if (fileMap.size === 0) {
      return res.json({ matched: 0, updated: 0, skipped: 0,
        message: 'No chapter data found in file (all entries had 00:00:00.000 or file was empty).' });
    }

    // Build hash → media id map from current DB
    const all = db.get('media').value().filter(
      m => m.media_type === 'tv_show' || m.media_type === 'movie'
    );

    let matched = 0, updated = 0, skipped = 0;

    for (const item of all) {
      const hash = computeHash(item);
      if (!fileMap.has(hash)) { skipped++; continue; }
      matched++;
      const newChapters = fileMap.get(hash);
      // Only update if actually changed
      if ((item.chapter_breaks || '').trim() === newChapters.trim()) {
        console.log(`[chapter-breaks] skip (unchanged): ${item.title} hash=${hash}`);
        skipped++;
        continue;
      }
      console.log(`[chapter-breaks] updating: ${item.title} hash=${hash} chapters="${newChapters}"`);
      // Mutate the in-memory record directly (lowdb v1 stores live references)
      item.chapter_breaks = newChapters;
      item.updated_date   = new Date().toISOString();
      updated++;
    }

    // Single write flush after all mutations
    if (updated > 0) {
      db.write();
      console.log(`[chapter-breaks] wrote ${updated} updates to disk`);
    }

    res.json({
      matched,
      updated,
      skipped: all.length - matched,
      total_in_file: fileMap.size,
      message: `Matched ${matched} items, updated ${updated} with new chapter data.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chapter-breaks/debug
 * Returns hashes for all media so you can verify matching.
 * Remove or protect this endpoint in production.
 */
router.get('/debug', (req, res) => {
  const all = db.get('media').value().filter(
    m => (m.media_type === 'tv_show' || m.media_type === 'movie') && !m.is_filler
  );
  res.json(all.map(m => ({
    id:              m.id,
    title:           m.title,
    media_type:      m.media_type,
    show_name:       m.show_name,
    season_number:   m.season_number,
    episode_number:  m.episode_number,
    year:            m.year,
    duration_minutes:m.duration_minutes,
    file_size:       m.file_size,
    chapter_breaks:  m.chapter_breaks,
    hash:            computeHash(m),
    line:            formatLine(m, computeHash(m)),
  })));
});

module.exports = router;
