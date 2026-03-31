/**
 * routes/blocks.js
 * CRUD for Programming Blocks and Marathons.
 * Also handles: marathon TXT scan, JSON import/export.
 */
const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const db       = require('../db');

// ─── Helper ───────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

// ═══════════════════════════════════════════════════════════════════════════════
//  BLOCKS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/blocks', (req, res) => {
  try {
    res.json(db.get('blocks').value() || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/blocks/:id', (req, res) => {
  try {
    const item = db.get('blocks').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Block not found' });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/blocks', (req, res) => {
  try {
    const block = {
      id: uuidv4(),
      created_date: now(),
      type: 'block',
      title: '',
      channel_id: null,
      occurrence: 'weekly',
      start_date: null,
      start_time: '20:00',
      duration_minutes: 120,
      filler_source: 'channel',
      fill_style: 'intermixed',
      // branding
      logo_url: '',
      overlay_url: '',
      overlay_position: 'bottom-right',
      overlay_opacity: 40,
      overlay_size: 150,
      // media slots: [{ media_id, order, follow_up_show_name, playback_order }]
      assigned_filler: [],
      slots: [],
      ...req.body,
    };
    db.get('blocks').push(block).write();
    res.status(201).json(block);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/blocks/:id', (req, res) => {
  try {
    const existing = db.get('blocks').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Block not found' });
    const updated = { ...existing, ...req.body, id: req.params.id, updated_date: now() };
    db.get('blocks').find({ id: req.params.id }).assign(updated).write();
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/blocks/:id', (req, res) => {
  try {
    db.get('blocks').remove({ id: req.params.id }).write();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export a single block as JSON
router.get('/blocks/:id/export', (req, res) => {
  try {
    const item = db.get('blocks').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Block not found' });
    const payload = { ...item, _export_version: 1, _export_type: 'block' };
    const filename = `block_${item.title.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import a block from JSON body
router.post('/blocks/import', (req, res) => {
  try {
    const data = req.body;
    if (!data || data._export_type !== 'block') return res.status(400).json({ error: 'Invalid block import file' });
    const { _export_version, _export_type, id: _oldId, ...rest } = data;
    const block = { ...rest, id: uuidv4(), created_date: now(), updated_date: now() };
    db.get('blocks').push(block).write();
    res.status(201).json(block);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MARATHONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/marathons', (req, res) => {
  try {
    res.json(db.get('marathons').value() || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marathons/:id', (req, res) => {
  try {
    const item = db.get('marathons').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Marathon not found' });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marathons', (req, res) => {
  try {
    const marathon = {
      id: uuidv4(),
      created_date: now(),
      type: 'marathon',
      title: '',
      channel_id: null,
      occurrence: 'once',
      start_date: null,
      start_time: '12:00',
      duration_minutes: 360,
      filler_source: 'channel',
      fill_style: 'end',
      order: 'chronological',
      repeat: 'restart',
      // branding
      logo_url: '',
      overlay_url: '',
      overlay_position: 'bottom-right',
      overlay_opacity: 40,
      overlay_size: 150,
      // ordered list of media IDs to play
      assigned_filler: [],
      media_ids: [],
      source_file: null,
      ...req.body,
    };
    db.get('marathons').push(marathon).write();
    res.status(201).json(marathon);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marathons/:id', (req, res) => {
  try {
    const existing = db.get('marathons').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Marathon not found' });
    const updated = { ...existing, ...req.body, id: req.params.id, updated_date: now() };
    db.get('marathons').find({ id: req.params.id }).assign(updated).write();
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/marathons/:id', (req, res) => {
  try {
    db.get('marathons').remove({ id: req.params.id }).write();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export a single marathon as JSON
router.get('/marathons/:id/export', (req, res) => {
  try {
    const item = db.get('marathons').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Marathon not found' });
    const payload = { ...item, _export_version: 1, _export_type: 'marathon' };
    const filename = `marathon_${item.title.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export a marathon as a plain-text .txt file (shareable format)
router.get('/marathons/:id/export-txt', (req, res) => {
  try {
    const item = db.get('marathons').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Marathon not found' });

    const allMedia = db.get('media').value();
    const mediaById = Object.fromEntries(allMedia.map(m => [m.id, m]));

    const lines = [`Title: ${item.title}`];
    for (const mId of (item.media_ids || [])) {
      const m = mediaById[mId];
      if (m) lines.push(m.file_name || m.title || mId);
    }

    const filename = `marathon_${item.title.replace(/[^a-z0-9]/gi, '_')}.txt`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import marathon from JSON body
router.post('/marathons/import', (req, res) => {
  try {
    const data = req.body;
    if (!data || data._export_type !== 'marathon') return res.status(400).json({ error: 'Invalid marathon import file' });
    const { _export_version, _export_type, id: _oldId, ...rest } = data;
    const marathon = { ...rest, id: uuidv4(), created_date: now(), updated_date: now() };
    db.get('marathons').push(marathon).write();
    res.status(201).json(marathon);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import marathon from plain-text body (same format as .txt export / shareable format)
// POST /api/marathons/import-txt  with Content-Type text/plain body
router.post('/marathons/import-txt', (req, res) => {
  try {
    let raw = '';
    // Body may come as text/plain parsed by express.text(), or as { text } JSON
    if (typeof req.body === 'string') {
      raw = req.body;
    } else if (req.body && typeof req.body.text === 'string') {
      raw = req.body.text;
    } else {
      return res.status(400).json({ error: 'No text body received' });
    }

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: 'Empty file' });

    let title = 'Imported Marathon';
    const fileLines = [];
    for (const line of lines) {
      if (/^title:/i.test(line)) {
        title = line.slice(6).trim();
      } else {
        fileLines.push(line);
      }
    }

    const allMedia = db.get('media').value();
    const byFileName = {};
    for (const m of allMedia) {
      if (m.file_name) byFileName[m.file_name.toLowerCase()] = m;
    }

    const mediaIds = [];
    const unmatched = [];
    for (const line of fileLines) {
      const key = line.toLowerCase();
      const baseName = require('path').basename(line).toLowerCase();
      const match = byFileName[key] || byFileName[baseName];
      if (match) mediaIds.push(match.id);
      else unmatched.push(line);
    }

    // Check if a marathon with this title already exists — reuse it to preserve existing schedule rules
    const existing = db.get('marathons').find({ title }).value();
    let marathon;
    if (existing) {
      marathon = { ...existing, media_ids: mediaIds, updated_date: now() };
      db.get('marathons').find({ id: existing.id }).assign(marathon).write();
    } else {
      marathon = {
        id: uuidv4(),
        created_date: now(),
        type: 'marathon',
        title,
        channel_id: null,
        occurrence: 'once',
        start_date: null,
        start_time: '12:00',
        duration_minutes: 360,
        filler_source: 'marathon',
        fill_style: 'end',
        order: 'fixed',
        repeat: 'end',
        logo_url: '', overlay_url: '', overlay_position: 'bottom-right',
        overlay_opacity: 40, overlay_size: 150,
        media_ids: mediaIds,
        source_file: null,
      };
      db.get('marathons').push(marathon).write();
    }

    res.status(201).json({
      marathon,
      matched: mediaIds.length,
      unmatched: unmatched.length,
      unmatched_files: unmatched,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Marathon TXT Scanner ────────────────────────────────────────────────────
// POST /api/marathons/scan  { folder_path: "C:\\Media\\Marathons" }
// Reads .txt files and tries to match file names to existing media records.
router.post('/marathons/scan', (req, res) => {
  try {
    const { folder_path } = req.body;
    if (!folder_path) return res.status(400).json({ error: 'folder_path required' });

    if (!fs.existsSync(folder_path)) {
      return res.status(404).json({ error: `Folder not found: ${folder_path}` });
    }

    const allMedia = db.get('media').value();
    // Build lookup: file_name.toLowerCase() → media record
    const byFileName = {};
    for (const m of allMedia) {
      if (m.file_name) byFileName[m.file_name.toLowerCase()] = m;
    }

    const txtFiles = fs.readdirSync(folder_path).filter(f => f.toLowerCase().endsWith('.txt'));
    const results = [];

    for (const txtFile of txtFiles) {
      const fullPath = path.join(folder_path, txtFile);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      let title = path.basename(txtFile, '.txt');
      const mediaIds = [];
      const unmatched = [];

      for (const line of lines) {
        if (line.toLowerCase().startsWith('title:')) {
          title = line.slice(6).trim();
          continue;
        }
        // Try to match by file_name (case-insensitive)
        const match = byFileName[line.toLowerCase()];
        if (match) {
          mediaIds.push(match.id);
        } else {
          // Try basename only (in case the line includes path separators)
          const baseName = path.basename(line).toLowerCase();
          const baseMatch = byFileName[baseName];
          if (baseMatch) {
            mediaIds.push(baseMatch.id);
          } else {
            unmatched.push(line);
          }
        }
      }

      // Check if a marathon with this source_file already exists
      const existing = db.get('marathons').find({ source_file: fullPath }).value();
      let marathon;
      if (existing) {
        marathon = { ...existing, title, media_ids: mediaIds, updated_date: now() };
        db.get('marathons').find({ source_file: fullPath }).assign(marathon).write();
      } else {
        marathon = {
          id: uuidv4(),
          created_date: now(),
          type: 'marathon',
          title,
          channel_id: null,
          occurrence: 'once',
          start_date: null,
          start_time: '12:00',
          duration_minutes: 360,
          filler_source: 'channel',
          fill_style: 'end',
          order: 'fixed',
          repeat: 'end',
          logo_url: '', overlay_url: '', overlay_position: 'bottom-right',
          overlay_opacity: 40, overlay_size: 150,
          media_ids: mediaIds,
          source_file: fullPath,
        };
        db.get('marathons').push(marathon).write();
      }

      results.push({ title, matched: mediaIds.length, unmatched: unmatched.length, marathon_id: marathon.id });
    }

    res.json({ scanned: txtFiles.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
