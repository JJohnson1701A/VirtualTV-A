/**
 * server/routes/watch.js
 * 
 * Timeline engine — given a channel and the current wall-clock time, compute:
 *   - Which schedule rule is currently airing
 *   - The full segment timeline for that slot (media segments + filler segments)
 *   - Which segment is active RIGHT NOW and how far into it we are
 * 
 * GET /api/watch/now?channel_id=X[&now=ISO_STRING]
 * Returns: { rule, channel, timeline, activeSegment, activeSeekSecs, slotElapsedSecs, slotTotalSecs }
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse "HH:MM:SS.mmm" or "HH:MM:SS" → seconds (float)
function parseTimecode(tc) {
  if (!tc || typeof tc !== 'string') return null;
  tc = tc.trim();
  const m = tc.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const frac = m[4] ? parseFloat('0.' + m[4]) : 0;
  return h * 3600 + min * 60 + sec + frac;
}

// Parse comma-delimited chapter breaks string → sorted array of seconds
function parseChapterBreaks(str) {
  if (!str) return [];
  return str
    .split(',')
    .map(s => parseTimecode(s.trim()))
    .filter(v => v !== null && v > 0)
    .sort((a, b) => a - b);
}

// Minutes → seconds
function minsToSecs(m) { return (m || 0) * 60; }

// Round up to next 30-min boundary in seconds
function roundUpToHalfHourSecs(secs) {
  const half = 1800;
  return Math.ceil(secs / half) * half;
}

// Get today's slot start as a Date, given a schedule rule and a reference 'now'
// Handles recurring rules (weekly, weekdays, daily, once, annual)
function getSlotStartDate(rule, now) {
  // 'now' is a JS Date
  // rule.start_date is YYYY-MM-DD, rule.start_time is HH:MM
  if (!rule.start_time) return null;

  const [sh, sm] = rule.start_time.split(':').map(Number);

  const tryDate = (dateStr) => {
    if (!dateStr) return null;
    const [y, mo, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, mo - 1, d, sh, sm, 0, 0);
    return dt;
  };

  const occurrence = rule.occurrence || 'weekly';
  const durationMs = minsToSecs(rule.duration_minutes || 30) * 1000;

  if (occurrence === 'once') {
    const dt = tryDate(rule.start_date || rule.date);
    if (!dt) return null;
    const end = new Date(dt.getTime() + durationMs);
    if (now >= dt && now < end) return dt;
    return null;
  }

  // For recurring, find the most recent occurrence on or before now
  // that hasn't ended yet
  const DOW_MAP = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };

  // Build candidate date for today's wall-clock day
  const todaySlot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0, 0);

  const dayMatches = (dt) => {
    const dow = dt.getDay(); // 0=Sun
    if (occurrence === 'daily')    return true;
    if (occurrence === 'weekdays') return dow >= 1 && dow <= 5;
    if (occurrence === 'weekends') return dow === 0 || dow === 6;
    if (occurrence === 'weekly') {
      // rule.day_of_week may be a number (0=Sun…6=Sat) or a string like 'monday'
      let target;
      if (typeof rule.day_of_week === 'number') {
        target = rule.day_of_week;
      } else if (typeof rule.day_of_week === 'string') {
        target = DOW_MAP[rule.day_of_week.toLowerCase()];
      }
      return target !== undefined ? dow === target : true;
    }
    if (occurrence === 'annual') {
      // Same month+day every year
      const anchor = tryDate(rule.start_date);
      if (!anchor) return false;
      return dt.getMonth() === anchor.getMonth() && dt.getDate() === anchor.getDate();
    }
    return false;
  };

  // Check today and yesterday (handles slot spanning midnight)
  for (let daysBack = 0; daysBack <= 1; daysBack++) {
    const candidate = new Date(todaySlot.getTime() - daysBack * 86400000);
    const end = new Date(candidate.getTime() + durationMs);
    if (dayMatches(candidate) && now >= candidate && now < end) {
      return candidate;
    }
  }

  return null; // nothing airing right now on this channel
}

// ─── Filler pool resolution ───────────────────────────────────────────────────
function resolveFillerOrder(channel) {
  // filler_order and filler_cooldown apply to all channels, not just EPG
  return {
    fillerOrder: channel?.epg_filler_order || channel?.filler_order || 'shuffle',
    cooldown:    channel?.epg_filler_cooldown ?? channel?.filler_cooldown ?? 3,
  };
}

function resolveFillerPool(rule, channel) {
  const source = rule.filler_source || 'channel';
  const allMedia = db.get('media').value();

  let pool = [];

  if (source === 'none') return [];

  // Channel filler
  const channelFiller = () => {
    const ch = db.get('channels').find({ id: channel.id }).value();
    if (!ch) return [];
    const ids = ch.assigned_filler || [];
    return allMedia.filter(m => m.is_filler && ids.includes(m.id));
  };

  // Block filler — filler assigned to the block itself
  const blockFiller = () => {
    // rule.media_id is the block ID for block rules
    const blockRecord = db.has('blocks').value()
      ? db.get('blocks').find({ id: rule.media_id }).value()
      : null;
    if (!blockRecord) return [];
    const ids = blockRecord.assigned_filler || [];
    return allMedia.filter(f => f.is_filler && ids.includes(f.id));
  };

  // Media-item (episode/movie) filler — via assigned_filler on the media record
  const mediaFiller = () => {
    const m = allMedia.find(m2 => m2.id === rule.media_id);
    if (!m) return [];
    const ids = m.assigned_filler || [];
    return allMedia.filter(f => f.is_filler && ids.includes(f.id));
  };

  // Any filler in DB
  const anyFiller = () => allMedia.filter(m => m.is_filler);

  if (source === 'channel')       pool = channelFiller();
  if (source === 'block')         pool = blockFiller();
  if (source === 'block_channel') pool = [...blockFiller(), ...channelFiller()];
  if (source === 'media')         pool = mediaFiller();
  if (source === 'media_channel') pool = [...mediaFiller(), ...channelFiller()];
  if (source === 'any')           pool = anyFiller();

  // Deduplicate by id
  const seen = new Set();
  return pool.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
}



// ─── Block (TGIF/SNICK style) timeline builder ───────────────────────────────
// A block has slots[] — each slot is a TV show with episodes, played in sequence.
// e.g. TGIF: [Full House 30min] [Perfect Strangers 30min]
// Each week, the next episode advances. Episodes cycle or stop per slot.order.
// Filler fills chapter-break gaps within each show AND the padding between shows.
function buildBlockTimeline(rule, channel, block) {
  const slotDurSecs  = minsToSecs(rule.duration_minutes || 60);
  const fillerPool    = resolveFillerPool(rule, channel);
  const { fillerOrder, cooldown } = resolveFillerOrder(channel);
  const blockFillStyle = block.fill_style || 'intermixed';
  const slots        = block.slots || [];

  if (slots.length === 0) return buildFillerOnly(rule, channel, slotDurSecs);

  // Get break templates from channel type settings
  const settings    = db.get('settings').value();
  const ctSettings  = (settings?.channelTypeSettings || {})[channel.channel_type] || {};
  const nowHour     = new Date().getHours();
  const DAYPART_RANGES = [
    ['early_morning',5,9],['daytime_morning',9,12],['daytime_afternoon',12,15],
    ['after_school',15,17],['early_fringe',17,19],['early_prime',19,20],
    ['primetime',20,22],['late_prime',22,23],['late_night',23,24],['overnight',0,5],
  ];
  const activeDaypart = DAYPART_RANGES.find(([,s,e])=>nowHour>=s&&nowHour<e)?.[0]||'primetime';
  const dpSettings        = ctSettings.dayparts?.[activeDaypart] || {};
  const breakTemplate     = dpSettings.breakTemplate?.length      ? dpSettings.breakTemplate     : null;
  const finalBreakTemplate= dpSettings.finalBreakTemplate?.length ? dpSettings.finalBreakTemplate: breakTemplate;

  // How many times has this block aired since start_date?
  const startDateStr = rule.start_date || rule.date;
  const occurrence   = rule.occurrence || 'weekly';
  let airingCount    = 0;
  if (startDateStr) {
    const [sy,sm,sd] = startDateStr.split('-').map(Number);
    const startDate  = new Date(sy, sm-1, sd, 0, 0, 0);
    const now        = new Date();
    if (occurrence === 'weekly') {
      airingCount = Math.max(0, Math.floor((now - startDate) / (7*86400000)));
    } else if (occurrence === 'weekdays' || occurrence === 'daily') {
      airingCount = Math.max(0, Math.floor((now - startDate) / 86400000));
    }
  }
  console.log(`[watch] Block "${block.title}" airingCount=${airingCount} slots=${slots.length}`);

  const segments = [];
  let cursor     = 0;

  // Each slot occupies a fixed portion of the block duration (evenly divided or by runtime)
  // We calculate the time budget per slot from the block's total duration / number of slots
  const slotBudgetSecs = slotDurSecs / slots.length;

  // Derive a deterministic seed per slot from the slot start time
  // so the same filler plays in the same order on every /now call within a slot
  const slotSeedBase = (() => {
    if (!startDateStr) return Date.now();
    const [y,mo,d] = startDateStr.split('-').map(Number);
    const baseEpoch = new Date(y, mo-1, d).getTime();
    return baseEpoch + airingCount * 86400000;
  })();

  for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
    const slot      = slots[slotIdx];
    const isLastSlot = slotIdx === slots.length - 1;
    const mediaIds  = slot.media_ids || [];
    if (!mediaIds.length) { cursor += slotBudgetSecs; continue; }

    // Which episode plays this airing?
    const epIdx  = airingCount % mediaIds.length;
    const mediaId = mediaIds[epIdx];
    const mediaRecord = mediaId ? db.get('media').find({ id: mediaId }).value() : null;
    if (!mediaId || !mediaRecord) { cursor += slotBudgetSecs; continue; }

    const mediaDurSecs  = minsToSecs(mediaRecord.duration_minutes || mediaRecord.runtime || slot.runtime_minutes || 22);
    const chapterBreaks = parseChapterBreaks(mediaRecord.chapter_breaks);
    const label         = slot.show_name || mediaRecord.show_name || mediaRecord.title || 'Show';

    // Time budget for this slot: bounded by remaining total time
    const slotBudget = Math.min(slotBudgetSecs, slotDurSecs - cursor);
    const fillerBudget = Math.max(0, slotBudget - mediaDurSecs);

    if (blockFillStyle === 'intermixed' && chapterBreaks.length > 0 && fillerPool.length > 0) {
      // ── Intermixed: split episode at chapter breaks, insert filler after each break ──
      const numBreakSlots = chapterBreaks.length + 1; // number of filler opportunities
      const fillerPerBreak = fillerBudget > 0 ? fillerBudget / numBreakSlots : 0;
      const breakpoints    = [...chapterBreaks, mediaDurSecs];
      let mediaSeekCursor  = 0;

      for (let bi = 0; bi < breakpoints.length; bi++) {
        const breakAt = breakpoints[bi];
        const segDur  = breakAt - mediaSeekCursor;
        if (segDur > 0.01) {
          segments.push({
            type: 'media', startSecs: cursor, durationSecs: segDur,
            mediaId, seekToSecs: mediaSeekCursor,
            label: label + (chapterBreaks.length > 0 ? ` (pt ${bi+1})` : ''),
          });
          cursor += segDur;
        }
        mediaSeekCursor = breakAt;

        // Filler after this media chunk
        if (fillerPerBreak > 0.5) {
          const isLastBreak = bi === breakpoints.length - 1;
          const tmpl = isLastBreak ? finalBreakTemplate : breakTemplate;
          const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerPerBreak, numBreakSlots, tmpl, fillerOrder, cooldown, slotSeedBase + slotIdx * 1000 + bi);
          for (const f of fillerSegs) {
            if (cursor >= slotDurSecs) break;
            segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
              mediaId:f.mediaId, seekToSecs:0, label:f.label });
            cursor += f.durationSecs;
          }
        }
      }

    } else if (blockFillStyle === 'beginning' && fillerPool.length > 0) {
      // Filler first, then episode
      if (fillerBudget > 0.5) {
        const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerBudget, 1, breakTemplate, fillerOrder, cooldown, slotSeedBase + slotIdx * 1000);
        for (const f of fillerSegs) {
          segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
            mediaId:f.mediaId, seekToSecs:0, label:f.label });
          cursor += f.durationSecs;
        }
      }
      segments.push({ type:'media', startSecs:cursor, durationSecs:mediaDurSecs,
        mediaId, seekToSecs:0, label });
      cursor += mediaDurSecs;

    } else {
      // 'end', 'none', or intermixed with no chapter breaks: episode first, filler after
      segments.push({ type:'media', startSecs:cursor, durationSecs:mediaDurSecs,
        mediaId, seekToSecs:0, label });
      cursor += mediaDurSecs;

      if ((blockFillStyle === 'intermixed' || blockFillStyle === 'end') && fillerBudget > 0.5 && fillerPool.length > 0) {
        const tmpl = isLastSlot ? finalBreakTemplate : breakTemplate;
        const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerBudget, 1, tmpl, fillerOrder, cooldown, slotSeedBase + slotIdx * 1000 + 500);
        for (const f of fillerSegs) {
          if (cursor >= slotDurSecs) break;
          segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
            mediaId:f.mediaId, seekToSecs:0, label:f.label });
          cursor += f.durationSecs;
        }
      }
    }
  }

  // Any remaining time at the end → filler
  if (cursor < slotDurSecs - 0.5 && fillerPool.length > 0) {
    const remaining  = slotDurSecs - cursor;
    const fillerSegs = distributeFillerIntoSegments(fillerPool, remaining, 1, finalBreakTemplate, fillerOrder, cooldown, slotSeedBase + 9999);
    for (const f of fillerSegs) {
      segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
        mediaId:f.mediaId, seekToSecs:0, label:f.label });
      cursor += f.durationSecs;
    }
  }

  if (segments.length === 0) return buildFillerOnly(rule, channel, slotDurSecs);
  return segments;
}

// ─── MV Block timeline builder ────────────────────────────────────────────────
// Builds a timeline from a Music Video Block record.
// Applies selection rules, ordering, cooldown, and fill_frequency.
function buildMvBlockTimeline(rule, channel, mvBlock) {
  const slotDurSecs  = minsToSecs(rule.duration_minutes || 60);
  const fillStyle    = mvBlock.fill_style    || 'intermixed';
  const fillFreq     = Math.max(1, mvBlock.fill_frequency || 3); // videos between filler breaks
  const fillerPool   = resolveFillerPool(rule, channel);
  const { fillerOrder, cooldown } = resolveFillerOrder(channel);
  const mvSeed = (() => {
    const dateStr = rule.start_date || rule.date;
    if (!dateStr) return 0;
    const [y,mo,d] = dateStr.split('-').map(Number);
    return new Date(y, mo-1, d).getTime();
  })();

  // ── Resolve ordered playlist from the block's selection engine ───────────
  const allMedia = db.get('media').value();
  const assignedIds = new Set(mvBlock.media_ids || []);

  let pool = allMedia.filter(m => assignedIds.has(m.id) && m.media_type === 'music_video');

  // Apply selection rule filters
  const sr = mvBlock.selection_rules || {};
  if (sr.genres_include?.length)  pool = pool.filter(m => sr.genres_include.includes(m.genre));
  if (sr.genres_exclude?.length)  pool = pool.filter(m => !sr.genres_exclude.includes(m.genre));
  if (sr.artists_include?.length) pool = pool.filter(m => sr.artists_include.includes(m.artist_name));
  if (sr.artists_exclude?.length) pool = pool.filter(m => !sr.artists_exclude.includes(m.artist_name));
  if (sr.explicit_exclude)        pool = pool.filter(m => !m.explicit);
  const minPop = sr.min_popularity ?? 1;
  const maxPop = sr.max_popularity ?? 5;
  pool = pool.filter(m => {
    const s = parseFloat(m.score) || 0;
    let tier = 1;
    if (s >= 80) tier = 5; else if (s >= 60) tier = 4;
    else if (s >= 40) tier = 3; else if (s >= 20) tier = 2;
    return tier >= minPop && tier <= maxPop;
  });

  if (pool.length === 0) {
    // Fallback: use all assigned videos ignoring filters
    pool = allMedia.filter(m => assignedIds.has(m.id) && m.media_type === 'music_video');
  }
  if (pool.length === 0) return buildFillerOnly(rule, channel, slotDurSecs);

  // Order the pool
  const order = mvBlock.order || 'weighted_shuffle';
  const popWeight = (sr.popularity_weight ?? 50) / 100;
  let playlist = applyMvOrder(pool, order, popWeight);

  // Apply cooldown
  const cd = mvBlock.cooldown || {};
  if (cd.artist_enabled || cd.video_enabled || cd.genre_enabled) {
    playlist = applyMvCooldown(playlist, cd);
  }

  // ── Build segments from playlist, cycling if needed to fill slot ─────────
  const segments = [];
  let cursor = 0;
  let videosSinceBreak = 0;
  let playlistIdx = 0;

  while (cursor < slotDurSecs - 0.5) {
    if (playlistIdx >= playlist.length) playlistIdx = 0; // loop playlist

    const mv = playlist[playlistIdx++];
    // Prefer probed duration (duration_minutes set by ffprobe/scan) over manual runtime entry.
    // Add a tiny 0.5s buffer to prevent cutting off the last frames due to float precision.
    const rawRuntime = mv.duration_minutes || mv.runtime || 4;
    const mvDur = minsToSecs(rawRuntime) + 0.5;
    if (cursor >= slotDurSecs) break; // slot is full, stop adding videos

    // Use full video duration — never clamp mid-video.
    // The slot may overrun slightly but that's correct TV behaviour (video plays to end).
    segments.push({
      type: 'media',
      startSecs: cursor,
      durationSecs: mvDur,
      mediaId: mv.id,
      seekToSecs: 0,
      label: `${mv.artist_name || ''} — ${mv.title || mv.file_name}`,
    });
    cursor += mvDur;
    videosSinceBreak++;

    // Insert filler break after fillFreq videos (if intermixed and there's filler)
    if (fillStyle === 'intermixed' && videosSinceBreak >= fillFreq && fillerPool.length > 0) {
      const remainingSlot = slotDurSecs - cursor;
      const breakBudget   = Math.min(remainingSlot, 180); // up to 3 min of filler per break
      if (breakBudget > 10) {
        const fillerSegs = distributeFillerIntoSegments(fillerPool, breakBudget, 1, null, fillerOrder, cooldown, mvSeed + playlistIdx);
        for (const f of fillerSegs) {
          if (cursor >= slotDurSecs) break;
          segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
            mediaId:f.mediaId, seekToSecs:0, label:f.label });
          cursor += f.durationSecs;
        }
      }
      videosSinceBreak = 0;
    }
  }

  // If fill_style === 'end', add remaining filler after all videos
  if (fillStyle === 'end' && cursor < slotDurSecs && fillerPool.length > 0) {
    const remaining = slotDurSecs - cursor;
    const fillerSegs = distributeFillerIntoSegments(fillerPool, remaining, 1, null, fillerOrder, cooldown, mvSeed);
    for (const f of fillerSegs) {
      segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
        mediaId:f.mediaId, seekToSecs:0, label:f.label });
      cursor += f.durationSecs;
    }
  }

  return segments;
}

function applyMvOrder(pool, order, popWeight) {
  if (order === 'shuffle')              return shuffleArr([...pool]);
  if (order === 'ascending')            return [...pool].sort((a,b) => (parseFloat(a.score)||0)-(parseFloat(b.score)||0));
  if (order === 'descending')           return [...pool].sort((a,b) => (parseFloat(b.score)||0)-(parseFloat(a.score)||0));
  if (order === 'chronological')        return [...pool].sort((a,b) => (a.year||9999)-(b.year||9999));
  if (order === 'reverse_chronological') return [...pool].sort((a,b) => (b.year||0)-(a.year||0));
  // weighted_shuffle (default)
  return weightedShuffleArr(pool, popWeight);
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function weightedShuffleArr(pool, popWeight) {
  const totalScore = pool.reduce((s,m) => s + (parseFloat(m.score)||1), 0);
  const result = [];
  const remaining = [...pool];
  while (remaining.length > 0) {
    const weights = remaining.map(m => {
      const norm = totalScore > 0 ? (parseFloat(m.score)||1)/totalScore : 1/remaining.length;
      return (1-popWeight)*(1/remaining.length) + popWeight*norm;
    });
    const total = weights.reduce((s,w) => s+w, 0);
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

function applyMvCooldown(playlist, cd) {
  const aW = cd.artist_enabled ? (cd.artist_cooldown||3) : 0;
  const vW = cd.video_enabled  ? (cd.video_cooldown||5)  : 0;
  const gW = cd.genre_enabled  ? (cd.genre_cooldown||2)  : 0;
  const result = [], skipped = [];
  const rA = [], rV = [], rG = [];
  for (const m of playlist) {
    if ((aW>0 && rA.slice(-aW).includes(m.artist_name)) ||
        (vW>0 && rV.slice(-vW).includes(m.id)) ||
        (gW>0 && rG.slice(-gW).includes(m.genre))) {
      skipped.push(m);
    } else {
      result.push(m);
      rA.push(m.artist_name); rV.push(m.id); rG.push(m.genre);
    }
  }
  return [...result, ...skipped];
}

// ─── Seeded RNG — deterministic shuffle per slot ──────────────────────────────
// Uses the slot start time (ms epoch) as a seed so the same slot always produces
// the same filler order. This prevents filler from restarting when re-entering.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Timeline builder ─────────────────────────────────────────────────────────
// Returns array of segments:
//   { type:'media'|'filler', startSecs, durationSecs, mediaId, seekToSecs, label }
// where startSecs is seconds from slot start.

function buildTimeline(rule, channel) {
  const slotDurSecs = minsToSecs(rule.duration_minutes || 30);

  // Check if this rule points to a Music Video Block
  // Check if this rule points to a regular Block (TGIF, SNICK, etc.)
  if (rule.media_type === 'block') {
    const block = db.has('blocks').value()
      ? db.get('blocks').find({ id: rule.media_id }).value()
      : null;
    if (block) {
      console.log(`[watch] Block: "${block.title}" (${(block.slots||[]).length} slots)`);
      return buildBlockTimeline(rule, channel, block);
    }
    console.warn(`[watch] block rule has no matching block: ${rule.media_id}`);
    return buildFillerOnly(rule, channel, minsToSecs(rule.duration_minutes || 60));
  }

  if (rule.media_type === 'mv_block') {
    const mvBlock = db.has('mv_blocks').value()
      ? db.get('mv_blocks').find({ id: rule.media_id }).value()
      : null;
    if (mvBlock) {
      console.log(`[watch] MV Block: "${mvBlock.title}" (${(mvBlock.media_ids||[]).length} videos)`);
      return buildMvBlockTimeline(rule, channel, mvBlock);
    }
    console.warn(`[watch] mv_block rule has no matching block: ${rule.media_id}`);
    return buildFillerOnly(rule, channel, slotDurSecs);
  }

  // Resolve the primary media item
  const mediaRecord = db.get('media').find({ id: rule.media_id }).value();
  if (!mediaRecord) {
    // No media — fill entire slot with filler
    return buildFillerOnly(rule, channel, slotDurSecs);
  }

  const mediaDurSecs = minsToSecs(
    mediaRecord.runtime || mediaRecord.duration_minutes || 22
  );

  const chapterBreaks = parseChapterBreaks(mediaRecord.chapter_breaks);
  const fillStyle = rule.fill_style || 'intermixed';
  const fillerPool = resolveFillerPool(rule, channel);
  const { fillerOrder, cooldown } = resolveFillerOrder(channel);
  // Seed from slot start — same slot always builds same filler order
  const slotSeedBase = (() => {
    const dateStr = rule.start_date || rule.date;
    if (!dateStr) return 0;
    const [y,mo,d] = dateStr.split('-').map(Number);
    return new Date(y, mo-1, d).getTime();
  })();

  // Get break templates from channel type settings (if configured)
  const settings = db.get('settings').value();
  const ctSettings = (settings?.channelTypeSettings || {})[channel.channel_type] || {};
  // Determine which daypart is active for current time
  const nowHour = new Date().getHours();
  const DAYPART_RANGES = [
    ['early_morning', 5, 9], ['daytime_morning', 9, 12], ['daytime_afternoon', 12, 15],
    ['after_school', 15, 17], ['early_fringe', 17, 19], ['early_prime', 19, 20],
    ['primetime', 20, 22], ['late_prime', 22, 23], ['late_night', 23, 24], ['overnight', 0, 5],
  ];
  const activeDaypart = DAYPART_RANGES.find(([, s, e]) => nowHour >= s && nowHour < e)?.[0] || 'primetime';
  const dpSettings = ctSettings.dayparts?.[activeDaypart] || {};
  const breakTemplate      = dpSettings.breakTemplate?.length      ? dpSettings.breakTemplate      : null;
  const finalBreakTemplate = dpSettings.finalBreakTemplate?.length ? dpSettings.finalBreakTemplate : breakTemplate;
  const nextShowPromo      = !!dpSettings.nextShowPromo;

  // Total filler time available
  const fillerTotalSecs = Math.max(0, slotDurSecs - mediaDurSecs);

  const segments = [];

  if (fillStyle === 'beginning') {
    // All filler first, then media
    const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerTotalSecs, 1, breakTemplate, fillerOrder, cooldown, slotSeedBase + 1);
    let cursor = 0;
    for (const f of fillerSegs) {
      segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
        mediaId:f.mediaId, seekToSecs:0, label: f.label });
      cursor += f.durationSecs;
    }
    segments.push({ type:'media', startSecs:cursor, durationSecs:mediaDurSecs,
      mediaId:mediaRecord.id, seekToSecs:0, label: mediaRecord.title });

  } else if (fillStyle === 'end') {
    // Media first, then all filler
    segments.push({ type:'media', startSecs:0, durationSecs:mediaDurSecs,
      mediaId:mediaRecord.id, seekToSecs:0, label: mediaRecord.title });
    const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerTotalSecs, 1, finalBreakTemplate, fillerOrder, cooldown, slotSeedBase + 2);
    let cursor = mediaDurSecs;
    for (const f of fillerSegs) {
      segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
        mediaId:f.mediaId, seekToSecs:0, label: f.label });
      cursor += f.durationSecs;
    }

  } else {
    // 'intermixed' — distribute filler evenly across chapter breaks
    // Breaks divide the media into segments: [0 → break1], [break1 → break2], …, [lastBreak → end]
    // Each media segment is followed by a filler block
    // Number of filler slots = number of chapter breaks + 1 (after media end)
    const numSlots = chapterBreaks.length + 1;
    const fillerPerSlot = fillerTotalSecs > 0 ? fillerTotalSecs / numSlots : 0;

    let cursor = 0;
    let mediaSeekCursor = 0; // position in the source media file

    const breakpoints = [...chapterBreaks, mediaDurSecs]; // add media end

    for (let i = 0; i < breakpoints.length; i++) {
      const breakAt = breakpoints[i];
      const segDur = breakAt - mediaSeekCursor;

      if (segDur > 0.01) {
        segments.push({
          type: 'media',
          startSecs: cursor,
          durationSecs: segDur,
          mediaId: mediaRecord.id,
          seekToSecs: mediaSeekCursor,
          label: mediaRecord.title + (chapterBreaks.length > 0 ? ` (part ${i+1})` : ''),
        });
        cursor += segDur;
      }
      mediaSeekCursor = breakAt;

      // Filler block after this media segment
      if (fillerPerSlot > 0.5) {
        const isLastBreak = i === breakpoints.length - 1;
        const tmpl = isLastBreak ? finalBreakTemplate : breakTemplate;
        const fillerSegs = distributeFillerIntoSegments(fillerPool, fillerPerSlot, numSlots, tmpl, fillerOrder, cooldown, slotSeedBase + 100 + i);
        for (const f of fillerSegs) {
          segments.push({ type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
            mediaId:f.mediaId, seekToSecs:0, label:f.label });
          cursor += f.durationSecs;
        }
      }
    }
  }

  return segments;
}

// Pick filler items matching a filler_type, or any if no match.
function pickFillerByType(pool, fillerType) {
  if (!fillerType) return pool;
  const typed = pool.filter(f => (f.filler_type || '').toLowerCase() === fillerType.toLowerCase());
  return typed.length ? typed : pool; // fall back to any if no match
}

// Fisher-Yates shuffle (in-place)
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Fill a slot of totalSecs from pool, optionally following a breakTemplate sequence.
// breakTemplate: array of filler_type strings e.g. ['Commercial','Ident-Channel','Commercial']
// fillerOrder: 'shuffle' (no repeats until pool exhausted) | 'random' (may repeat)
// cooldown: number of items before same item can repeat
// Returns array of { mediaId, durationSecs, label }
function distributeFillerIntoSegments(pool, totalSecs, _numSlots, breakTemplate, fillerOrder, cooldown, seed) {
  if (!pool.length || totalSecs < 1) {
    if (totalSecs >= 1) return [{ mediaId: null, durationSecs: totalSecs, label: '(dead air)' }];
    return [];
  }

  const order    = fillerOrder || 'shuffle';
  const cdWindow = Math.max(1, cooldown || 3);

  // Build a shuffled working copy for shuffle mode — use seeded RNG for determinism
  const rng = seed != null ? seededRng(seed) : Math.random.bind(Math);
  let shuffled = [...pool];
  if (order === 'shuffle') shuffled = seededShuffle(pool, seed != null ? seededRng(seed) : () => Math.random());
  let shuffleIdx = 0;

  const result      = [];
  const recentIds   = []; // cooldown tracking
  let remaining     = totalSecs;
  let templateIdx   = 0;
  let safetyCount   = 0;
  const maxItems    = pool.length * 20;

  while (remaining > 0.5 && safetyCount++ < maxItems) {
    // Determine filler type from break template
    let fillerType = null;
    if (breakTemplate && breakTemplate.length > 0) {
      const tIdx = Math.min(templateIdx, breakTemplate.length - 1);
      fillerType = breakTemplate[tIdx];
      templateIdx++;
    }

    const candidates = pickFillerByType(pool, fillerType);

    let chosen = null;
    if (order === 'shuffle') {
      // Advance through shuffled list, respecting cooldown
      let attempts = 0;
      while (attempts < shuffled.length) {
        const candidate = shuffled[shuffleIdx % shuffled.length];
        shuffleIdx++;
        if (shuffleIdx >= shuffled.length) {
          // Exhausted pool — reshuffle for next pass
          shuffled = seededShuffle(shuffled, rng);
          shuffleIdx = 0;
        }
        // Check cooldown
        if (!recentIds.slice(-cdWindow).includes(candidate.id)) {
          chosen = candidate;
          break;
        }
        attempts++;
      }
      if (!chosen) chosen = shuffled[Math.floor(Math.random() * shuffled.length)];
    } else {
      // Random — just pick randomly, try to respect cooldown
      let attempts = 0;
      const localCandidates = candidates.length ? candidates : pool;
      do {
        chosen = localCandidates[Math.floor(rng() * localCandidates.length)];
        attempts++;
      } while (recentIds.slice(-cdWindow).includes(chosen.id) && attempts < cdWindow * 2);
    }

    if (!chosen) break;

    const dur = Math.min(
      minsToSecs(chosen.duration_minutes || chosen.runtime || 0.5),
      remaining
    );
    if (dur < 0.1) break;

    result.push({ mediaId: chosen.id, durationSecs: dur, label: chosen.title || 'Filler' });
    recentIds.push(chosen.id);
    remaining -= dur;
  }

  return result;
}

// Build a filler-only timeline (no primary media scheduled or media not found)
function buildFillerOnly(rule, channel, slotDurSecs) {
  const fillerPool = resolveFillerPool(rule, channel);
  const { fillerOrder, cooldown } = resolveFillerOrder(channel);
  const seed = (() => {
    const dateStr = rule?.start_date || rule?.date;
    if (!dateStr) return Date.now() % 1000000;
    const [y,mo,d] = dateStr.split('-').map(Number);
    return new Date(y, mo-1, d).getTime();
  })();
  const segs = distributeFillerIntoSegments(fillerPool, slotDurSecs, 1, null, fillerOrder, cooldown, seed);
  let cursor = 0;
  return segs.map(f => {
    const seg = { type:'filler', startSecs:cursor, durationSecs:f.durationSecs,
      mediaId:f.mediaId, seekToSecs:0, label:f.label };
    cursor += f.durationSecs;
    return seg;
  });
}

// ─── Debug route — returns full timeline breakdown ───────────────────────────
// GET /api/watch/debug?channel_id=X  — shows timeline, chapter breaks, filler
router.get('/debug', (req, res) => {
  try {
    const { channel_id } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const now = req.query.now ? new Date(req.query.now) : new Date();
    const channel = db.get('channels').find({ id: channel_id }).value();
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const allRules = db.get('schedule').filter({ channel_id }).value();
    let activeRule = null, slotStart = null;
    for (const rule of allRules) {
      const start = getSlotStartDate(rule, now);
      if (start) { activeRule = rule; slotStart = start; break; }
    }
    if (!activeRule) return res.json({ airing: false, message: 'Nothing scheduled' });

    const mediaRecord = db.get('media').find({ id: activeRule.media_id }).value();
    const chapterBreaks = parseChapterBreaks(mediaRecord?.chapter_breaks);
    const slotElapsedSecs = (now.getTime() - slotStart.getTime()) / 1000;
    const timeline = buildTimeline(activeRule, channel);
    const fillerPool = resolveFillerPool(activeRule, channel);

    res.json({
      rule: { id: activeRule.id, start_time: activeRule.start_time, duration_minutes: activeRule.duration_minutes, fill_style: activeRule.fill_style },
      slotStart: slotStart.toISOString(),
      slotElapsedSecs: slotElapsedSecs.toFixed(1),
      media: mediaRecord ? {
        id: mediaRecord.id, title: mediaRecord.title,
        runtime: mediaRecord.runtime || mediaRecord.duration_minutes,
        chapter_breaks: mediaRecord.chapter_breaks || '(none)',
        chapter_breaks_parsed: chapterBreaks,
      } : null,
      filler_pool_count: fillerPool.length,
      filler_pool: fillerPool.map(f => ({ id: f.id, title: f.title, filler_type: f.filler_type, duration: f.duration_minutes || f.runtime })),
      timeline,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Route ────────────────────────────────────────────────────────────────────
router.get('/now', (req, res) => {
  try {
    const { channel_id } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    const nowParam = req.query.now;
    const now = nowParam ? new Date(nowParam) : new Date();

    const channel = db.get('channels').find({ id: channel_id }).value();
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Find all schedule rules for this channel
    const allRules = db.get('schedule')
      .filter({ channel_id })
      .value();

    // Find which rule is currently airing
    let activeRule = null;
    let slotStart  = null;

    for (const rule of allRules) {
      const start = getSlotStartDate(rule, now);
      if (start) { activeRule = rule; slotStart = start; break; }
    }

    if (!activeRule) {
      return res.json({ airing: false, channel, message: 'Nothing scheduled right now' });
    }

    const slotElapsedSecs = (now.getTime() - slotStart.getTime()) / 1000;
    const slotTotalSecs   = minsToSecs(activeRule.duration_minutes || 30);

    // Build the timeline
    const timeline = buildTimeline(activeRule, channel);

    // Debug logging — helps diagnose seek issues
    console.log(`[watch/now] channel=${channel.name} slotElapsed=${slotElapsedSecs.toFixed(1)}s slotTotal=${slotTotalSecs}s`);
    console.log(`[watch/now] timeline segments:`);
    timeline.forEach((s, i) => {
      const end = s.startSecs + s.durationSecs;
      console.log(`  [${i}] ${s.type.padEnd(6)} start=${s.startSecs.toFixed(1)}s dur=${s.durationSecs.toFixed(1)}s seekTo=${s.seekToSecs.toFixed(1)}s end=${end.toFixed(1)}s  ${s.label||''}`);
    });

    // Find active segment
    let activeSegment = null;
    let activeSeekSecs = 0;

    for (const seg of timeline) {
      const segEnd = seg.startSecs + seg.durationSecs;
      if (slotElapsedSecs >= seg.startSecs && slotElapsedSecs < segEnd) {
        activeSegment  = seg;
        activeSeekSecs = slotElapsedSecs - seg.startSecs + seg.seekToSecs;
        break;
      }
    }

    // If past end of timeline (slot overrun), use last segment at its end
    if (!activeSegment && timeline.length > 0) {
      activeSegment  = timeline[timeline.length - 1];
      activeSeekSecs = activeSegment.seekToSecs + activeSegment.durationSecs;
    }

    console.log(`[watch/now] active segment: ${activeSegment ? `${activeSegment.type} seekTo=${activeSeekSecs.toFixed(1)}s mediaId=${activeSegment.mediaId}` : 'NONE'}`);

    // Resolve media record for active segment
    const activeMedia = activeSegment?.mediaId
      ? db.get('media').find({ id: activeSegment.mediaId }).value()
      : null;

    // Also resolve the primary media for the rule (for OSD display)
    // For MV block rules, primaryMedia comes from the active segment's media
    let primaryMedia = db.get('media').find({ id: activeRule.media_id }).value();
    if (!primaryMedia && (activeRule.media_type === 'mv_block' || activeRule.media_type === 'block')) {
      // For block rules, primaryMedia is the currently-playing segment's media
      primaryMedia = activeMedia || null;
    }

    res.json({
      airing: true,
      channel,
      rule: activeRule,
      slotStart:        slotStart.toISOString(),
      slotElapsedSecs,
      slotTotalSecs,
      timeline,
      activeSegment,
      activeSeekSecs,
      activeMedia:      activeMedia || null,
      primaryMedia:     primaryMedia || null,
    });

  } catch (err) {
    console.error('Watch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/watch/channels — all channels sorted by number (EPG/TWC included in rotation)
router.get('/channels', (req, res) => {
  try {
    const allChannels = db.get('channels').value();
    const channels    = [...allChannels].sort((a, b) => (a.number || 0) - (b.number || 0));
    const schedule    = db.get('schedule').value();
    const now         = new Date();

    const result = channels.map(ch => {
      // System channels (EPG, TWC) are always "airing" — they have their own display logic
      if (ch.is_system) {
        return { ...ch, nowAiring: true, isEpg: ch.id === 'system-epg-channel', isTwc: ch.id === 'system-twc-channel' };
      }
      const rules = schedule.filter(r => r.channel_id === ch.id);
      let nowAiring = false;
      for (const rule of rules) {
        const start = getSlotStartDate(rule, now);
        if (start) { nowAiring = true; break; }
      }
      return { ...ch, nowAiring };
    });

    res.json(result);
  } catch (err) {
    console.error('Watch /channels error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
