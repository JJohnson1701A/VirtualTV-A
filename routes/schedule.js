const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const { channel_id } = req.query;
    let items = db.get('schedule').value();
    if (channel_id) items = items.filter(s => s.channel_id === channel_id);
    items = [...items].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    const item = { id: uuidv4(), is_recurring: false, duration_minutes: 60, created_date: new Date().toISOString(), ...req.body };
    db.get('schedule').push(item).write();
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const existing = db.get('schedule').find({ id: req.params.id }).value();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updated = { ...existing, ...req.body, id: req.params.id };
    db.get('schedule').find({ id: req.params.id }).assign(updated).write();
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/channel/:channelId', (req, res) => {
  try {
    db.get('schedule').remove({ channel_id: req.params.channelId }).write();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    db.get('schedule').remove({ id: req.params.id }).write();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
