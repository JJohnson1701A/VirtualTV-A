/**
 * channelExport.js — Export/Import channels as a self-contained ZIP
 * Uses only Node.js built-ins (no archiver/unzipper dependency needed).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('../db');

const IMAGES_DIR = path.join(__dirname, '../public/images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── Minimal ZIP builder (pure Node built-ins) ────────────────────────────────
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function crc32(buf) {
  if (!crc32._table) {
    crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32._table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crc32._table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const localHeaders = [];
  const centralEntries = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf-8');
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(crc), u32le(size), u32le(size),
      u16le(nameBytes.length), u16le(0),
      nameBytes, data,
    ]);

    centralEntries.push({ nameBytes, crc, size, offset });
    offset += local.length;
    localHeaders.push(local);
  }

  const centralDir = Buffer.concat(centralEntries.map(({ nameBytes, crc, size, offset }) =>
    Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      u16le(20), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(crc), u32le(size), u32le(size),
      u16le(nameBytes.length), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(0), u32le(offset), nameBytes,
    ])
  ));

  const eocd = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    u16le(0), u16le(0),
    u16le(files.length), u16le(files.length),
    u32le(centralDir.length), u32le(offset),
    u16le(0),
  ]);

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

// ─── Minimal ZIP parser (pure Node built-ins) ─────────────────────────────────
function parseZip(buf) {
  const files = {};
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocdPos = i; break;
    }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file');

  const entryCount   = buf.readUInt16LE(eocdPos + 8);
  const centralStart = buf.readUInt32LE(eocdPos + 16);

  let pos = centralStart;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014B50) throw new Error('Bad central directory entry');
    const nameLen    = buf.readUInt16LE(pos + 28);
    const extraLen   = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
    pos += 46 + nameLen + extraLen + commentLen;

    const lp = localOffset;
    if (buf.readUInt32LE(lp) !== 0x04034B50) throw new Error('Bad local file header');
    const lNameLen  = buf.readUInt16LE(lp + 26);
    const lExtraLen = buf.readUInt16LE(lp + 28);
    const compSize  = buf.readUInt32LE(lp + 18);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    files[name] = buf.slice(dataStart, dataStart + compSize);
  }
  return files;
}

// ─── Multer for import uploads ────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ─── EXPORT ───────────────────────────────────────────────────────────────────
router.post('/export', (req, res) => {
  try {
    const { channelIds } = req.body;
    let channels = db.get('channels').value();
    if (channelIds && channelIds.length > 0) {
      channels = channels.filter(ch => channelIds.includes(ch.id));
    }
    if (channels.length === 0) return res.status(400).json({ error: 'No channels to export' });

    const zipFiles = [];
    const imagesSeen = new Set();

    const exportChannels = channels.map(ch => {
      const out = { ...ch };
      for (const field of ['logo_url', 'overlay_url']) {
        const val = ch[field];
        if (val && val.startsWith('/images/')) {
          const filename = path.basename(val);
          const fullPath = path.join(IMAGES_DIR, filename);
          if (fs.existsSync(fullPath) && !imagesSeen.has(filename)) {
            imagesSeen.add(filename);
            zipFiles.push({ name: `images/${filename}`, data: fs.readFileSync(fullPath) });
          }
          out[field] = `images/${filename}`;
        }
      }
      return out;
    });

    const manifest = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      channel_count: channels.length,
      channels: exportChannels,
    };
    zipFiles.unshift({ name: 'channels.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8') });

    const zipBuf = buildZip(zipFiles);
    const safeName = channels.length === 1
      ? (channels[0].name || 'channel').replace(/[^a-z0-9]/gi, '_')
      : 'virtual_tv_channels';
    const filename = `${safeName}_export_${Date.now()}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', zipBuf.length);
    res.end(zipBuf);
  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── IMPORT ───────────────────────────────────────────────────────────────────
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const zipFiles = parseZip(req.file.buffer);

    if (!zipFiles['channels.json']) {
      return res.status(400).json({ error: 'Invalid export file: missing channels.json' });
    }
    const manifest = JSON.parse(zipFiles['channels.json'].toString('utf-8'));
    if (!manifest.channels || !Array.isArray(manifest.channels)) {
      return res.status(400).json({ error: 'Invalid channels.json format' });
    }

    // Save images with new unique names
    const savedImages = {};
    for (const [zipPath, data] of Object.entries(zipFiles)) {
      if (!zipPath.startsWith('images/')) continue;
      const ext = path.extname(path.basename(zipPath)) || '.png';
      const newFilename = `imported_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`;
      fs.writeFileSync(path.join(IMAGES_DIR, newFilename), data);
      savedImages[zipPath] = `/images/${newFilename}`;
    }

    // Import channels, skip duplicates
    const existing = db.get('channels').value();
    const existingNames   = new Set(existing.map(c => (c.name || '').toLowerCase()));
    const existingNumbers = new Set(existing.map(c => String(c.number)));
    const results = { imported: [], skipped: [], errors: [] };

    for (const ch of manifest.channels) {
      const nameKey   = (ch.name || '').toLowerCase();
      const numberKey = String(ch.number || '');

      if (existingNames.has(nameKey)) {
        results.skipped.push({ name: ch.name, reason: `Channel name "${ch.name}" already exists` });
        continue;
      }
      if (numberKey && existingNumbers.has(numberKey)) {
        results.skipped.push({ name: ch.name, reason: `Channel number ${ch.number} already in use` });
        continue;
      }

      try {
        const newChannel = {
          ...ch,
          id: uuidv4(),
          logo_url:    ch.logo_url    ? (savedImages[ch.logo_url]    || ch.logo_url)    : ch.logo_url,
          overlay_url: ch.overlay_url ? (savedImages[ch.overlay_url] || ch.overlay_url) : ch.overlay_url,
          imported_at: new Date().toISOString(),
        };
        db.get('channels').push(newChannel).write();
        existingNames.add(nameKey);
        if (numberKey) existingNumbers.add(numberKey);
        results.imported.push({ name: ch.name, id: newChannel.id });
      } catch (err) {
        results.errors.push({ name: ch.name, reason: err.message });
      }
    }

    res.json({
      success: true,
      imported: results.imported.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      details: results,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
