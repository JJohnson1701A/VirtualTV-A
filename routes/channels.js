const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const items = db.get('channels').value()
      .sort((a, b) => {
        if (a.is_system) return -1;  // EPG always first
        if (b.is_system) return 1;
        return (a.number || 0) - (b.number || 0);
      });
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const item = db.get('channels').find({ id: req.params.id }).value();
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    const { name, number } = req.body;
    const existing = db.get('channels').value();

    // Duplicate name check
    if (name && existing.some(c => (c.name || '').toLowerCase() === (name || '').toLowerCase())) {
      return res.status(409).json({ error: `A channel named "${name}" already exists.` });
    }
    // Duplicate number check
    if (number !== undefined && number !== '' && existing.some(c => String(c.number) === String(number))) {
      return res.status(409).json({ error: `Channel number ${number} is already in use.` });
    }

    const item = {
      id: uuidv4(), is_active: true,
      audience: [], assigned_movies: [], assigned_tv_shows: {}, assigned_music_videos: [],
      assigned_filler: [], assigned_podcasts: [], assigned_livestreams: [],
      epg_filler_weights: { promo: 33, trailer: 33, commercial: 34 },
      created_date: new Date().toISOString(), updated_date: new Date().toISOString(),
      ...req.body
    };
    db.get('channels').push(item).write();
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const existing = db.get('channels').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const others = db.get('channels').filter(c => c.id !== req.params.id).value();
    const { name, number } = req.body;

    if (name && others.some(c => (c.name || '').toLowerCase() === (name || '').toLowerCase())) {
      return res.status(409).json({ error: `A channel named "${name}" already exists.` });
    }
    if (number !== undefined && number !== '' && others.some(c => String(c.number) === String(number))) {
      return res.status(409).json({ error: `Channel number ${number} is already in use.` });
    }

    const updated = { ...existing, ...req.body, id: req.params.id, updated_date: new Date().toISOString() };
    db.get('channels').find({ id: req.params.id }).assign(updated).write();

    // ── Bidirectional Ident-Channel sync ──────────────────────────────────────
    // When channel.assigned_filler changes, sync linked_channel_id on filler records.
    const oldFiller = new Set(existing.assigned_filler || []);
    const newFiller = new Set(updated.assigned_filler  || []);

    // Added to this channel
    for (const fillerId of newFiller) {
      if (!oldFiller.has(fillerId)) {
        const f = db.get('media').find({ id: fillerId }).value();
        if (f && f.is_filler) {
          db.get('media').find({ id: fillerId }).assign({ linked_channel_id: req.params.id }).write();
        }
      }
    }
    // Removed from this channel
    for (const fillerId of oldFiller) {
      if (!newFiller.has(fillerId)) {
        const f = db.get('media').find({ id: fillerId }).value();
        if (f && f.is_filler && f.linked_channel_id === req.params.id) {
          db.get('media').find({ id: fillerId }).assign({ linked_channel_id: '' }).write();
        }
      }
    }

    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const existing = db.get('channels').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.is_system) return res.status(403).json({ error: 'System channels cannot be deleted.' });
    db.get('channels').remove({ id: req.params.id }).write();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
