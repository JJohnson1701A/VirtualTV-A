/**
 * server/routes/mvblocks.js
 * Music Video Blocks — CRUD + selection engine
 */
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// Ensure collection exists
function ensureCollection() {
  if (!db.has('mv_blocks').value()) {
    db.set('mv_blocks', []).write();
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  ensureCollection();
  res.json(db.get('mv_blocks').value());
});

router.get('/:id', (req, res) => {
  ensureCollection();
  const b = db.get('mv_blocks').find({ id: req.params.id }).value();
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

router.post('/', (req, res) => {
  ensureCollection();
  const block = {
    id:              uuidv4(),
    created_date:    new Date().toISOString(),
    updated_date:    new Date().toISOString(),
    ...req.body,
  };
  db.get('mv_blocks').push(block).write();
  res.json(block);
});

router.put('/:id', (req, res) => {
  ensureCollection();
  const existing = db.get('mv_blocks').find({ id: req.params.id }).value();
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = { ...existing, ...req.body, id: req.params.id, updated_date: new Date().toISOString() };
  db.get('mv_blocks').find({ id: req.params.id }).assign(updated).write();
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  ensureCollection();
  db.get('mv_blocks').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ── Selection engine: compute playlist for a block ────────────────────────────
// POST /api/mv-blocks/:id/playlist  — returns ordered array of media IDs
router.post('/:id/playlist', (req, res) => {
  ensureCollection();
  const block = db.get('mv_blocks').find({ id: req.params.id }).value();
  if (!block) return res.status(404).json({ error: 'Not found' });

  const allMedia = db.get('media').value();
  const assignedIds = new Set(block.media_ids || []);

  // Start from assigned videos
  let pool = allMedia.filter(m => assignedIds.has(m.id) && m.media_type === 'music_video');

  // Apply selection rules filters
  const rules = block.selection_rules || {};

  if (rules.genres_include?.length)
    pool = pool.filter(m => rules.genres_include.includes(m.genre));
  if (rules.genres_exclude?.length)
    pool = pool.filter(m => !rules.genres_exclude.includes(m.genre));
  if (rules.artists_include?.length)
    pool = pool.filter(m => rules.artists_include.includes(m.artist_name));
  if (rules.artists_exclude?.length)
    pool = pool.filter(m => !rules.artists_exclude.includes(m.artist_name));
  if (rules.decades_include?.length)
    pool = pool.filter(m => { const d = m.year ? `${Math.floor(m.year/10)*10}s` : ''; return rules.decades_include.includes(d); });
  if (rules.moods_include?.length)
    pool = pool.filter(m => rules.moods_include.includes(m.mood));
  if (rules.ratings_include?.length)
    pool = pool.filter(m => rules.ratings_include.includes(m.rating));
  if (rules.explicit_exclude)
    pool = pool.filter(m => !m.explicit);

  const minPop = rules.min_popularity ?? 1;
  const maxPop = rules.max_popularity ?? 5;
  pool = pool.filter(m => {
    const tier = scoreTier(m.score);
    return tier >= minPop && tier <= maxPop;
  });

  if (pool.length === 0) return res.json({ playlist: [], count: 0 });

  // Order
  const order = block.order || 'weighted_shuffle';
  const popWeight = (rules.popularity_weight ?? 50) / 100;
  let playlist = [];

  if (order === 'weighted_shuffle' || order === 'artist_spotlight' || order === 'curated_rotation') {
    playlist = weightedShuffle(pool, popWeight);
  } else if (order === 'shuffle') {
    playlist = shuffle([...pool]);
  } else if (order === 'ascending') {
    playlist = [...pool].sort((a, b) => (a.score || 0) - (b.score || 0));
  } else if (order === 'descending') {
    playlist = [...pool].sort((a, b) => (b.score || 0) - (a.score || 0));
  } else if (order === 'chronological') {
    playlist = [...pool].sort((a, b) => (a.year || 9999) - (b.year || 9999));
  } else if (order === 'reverse_chronological') {
    playlist = [...pool].sort((a, b) => (b.year || 0) - (a.year || 0));
  } else {
    playlist = shuffle([...pool]);
  }

  // Apply cooldown
  const cooldown = block.cooldown || {};
  if (cooldown.artist_enabled || cooldown.video_enabled || cooldown.genre_enabled) {
    playlist = applyCooldown(playlist, cooldown);
  }

  res.json({ playlist: playlist.map(m => m.id), count: playlist.length });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function scoreTier(score) {
  const s = parseFloat(score) || 0;
  if (s >= 80) return 5;
  if (s >= 60) return 4;
  if (s >= 40) return 3;
  if (s >= 20) return 2;
  return 1;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weightedShuffle(pool, popWeight) {
  // Weighted random selection without replacement
  // Each video's weight = (1 - popWeight) * 1 + popWeight * (score / totalScore)
  const totalScore = pool.reduce((s, m) => s + (parseFloat(m.score) || 1), 0);
  const result = [];
  const remaining = [...pool];

  while (remaining.length > 0) {
    const weights = remaining.map(m => {
      const normScore = totalScore > 0 ? (parseFloat(m.score) || 1) / totalScore : 1 / remaining.length;
      return (1 - popWeight) * (1 / remaining.length) + popWeight * normScore;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * total;
    let chosen = remaining.length - 1;
    for (let i = 0; i < weights.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { chosen = i; break; }
    }
    result.push(remaining[chosen]);
    remaining.splice(chosen, 1);
  }
  return result;
}

function applyCooldown(playlist, cooldown) {
  const artistWindow   = cooldown.artist_enabled  ? (cooldown.artist_cooldown  || 3) : 0;
  const videoWindow    = cooldown.video_enabled   ? (cooldown.video_cooldown   || 5) : 0;
  const genreWindow    = cooldown.genre_enabled   ? (cooldown.genre_cooldown   || 2) : 0;

  const result = [];
  const recentArtists = [];
  const recentVideos  = [];
  const recentGenres  = [];
  const skipped = [];

  for (const m of playlist) {
    const inArtistCooldown = artistWindow > 0 && recentArtists.slice(-artistWindow).includes(m.artist_name);
    const inVideoCooldown  = videoWindow  > 0 && recentVideos.slice(-videoWindow).includes(m.id);
    const inGenreCooldown  = genreWindow  > 0 && recentGenres.slice(-genreWindow).includes(m.genre);
    if (inArtistCooldown || inVideoCooldown || inGenreCooldown) {
      skipped.push(m);
    } else {
      result.push(m);
      recentArtists.push(m.artist_name);
      recentVideos.push(m.id);
      recentGenres.push(m.genre);
    }
  }
  // Append skipped items at end (cooldown was best-effort)
  return [...result, ...skipped];
}

module.exports = router;
