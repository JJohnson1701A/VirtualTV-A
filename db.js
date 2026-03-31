/**
 * db.js — JSON file database using lowdb
 * Stores all data in server/db/virtual-tv.json
 * No native compilation needed — works on any Node version.
 */

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

const { v4: uuidv4 } = require('uuid');

// Ensure db directory exists
const DB_DIR = path.join(__dirname, 'db');
fs.mkdirSync(DB_DIR, { recursive: true });

const adapter = new FileSync(path.join(DB_DIR, 'virtual-tv.json'));
const db = low(adapter);

// Default structure
db.defaults({
  media: [],
  channels: [],
  schedule: [],
  blocks: [],
  marathons: [],
  mv_blocks: [],
  settings: {
    theme: 'dark',
    accentColor: 'purple',
    rememberLastChannel: true,
    defaultChannelId: null,
    mediaRoot: process.env.MEDIA_ROOT || './media_test',
    safeHarborEnabled: true,
    safeHarborStart: '22:00',
    safeHarborEnd: '06:00',
    osd: {
      timeTillFade: 3,
      channel: { showNumber: true, showName: true, position: 'top-left' },
      media: { showTitle: true, showEpisode: true, showTimeSlot: true, position: 'bottom-left' }
    }
  }
}).write();

// Seed the EPG system channel if it doesn't exist yet
const EPG_CHANNEL_ID = 'system-epg-channel';
const hasEpg = db.get('channels').find({ id: EPG_CHANNEL_ID }).value();
if (!hasEpg) {
  db.get('channels').push({
    id: EPG_CHANNEL_ID,
    is_system: true,
    name: 'EPG',
    number: 0,
    channel_type: 'On-Demand/Playlist Channel',
    category: 'mixed',
    logo_url: '/epg-logo.png',
    overlay_url: '',
    overlay_position: 'bottom-right',
    overlay_opacity: 40,
    overlay_size: 150,
    default_language: 'English',
    sign_off: false,
    sign_off_time: '02:00',
    sign_on_time: '06:00',
    rating_content_warning: false,
    assigned_media: [],
    assigned_seasons: {},
    auto_scheduler_audience: [],
    auto_scheduler_audience_exclude: [],
    epg_filler_weights: { promo: 50, trailer: 30, commercial: 20 },
    epg_style:     '80s',
    epg_aspect:    '4:3',
    epg_font:      'PxPlus_IBM_CGA',
    epg_text_size: 16,
    content_warning_filter: { include: [], exclude: [] },
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  }).write();
}

// Seed the Weather Channel (TWC) system channel if it doesn't exist yet
const TWC_CHANNEL_ID = 'system-twc-channel';
const hasTwc = db.get('channels').find({ id: TWC_CHANNEL_ID }).value();
if (!hasTwc) {
  db.get('channels').push({
    id: TWC_CHANNEL_ID,
    is_system: true,
    name: 'TWC',
    number: 1,
    channel_type: 'News/Information Channel',
    category: 'news',
    logo_url: '',
    overlay_url: '',
    overlay_position: 'bottom-right',
    overlay_opacity: 40,
    overlay_size: 150,
    default_language: 'English',
    sign_off: false,
    sign_off_time: '02:00',
    sign_on_time: '06:00',
    rating_content_warning: false,
    assigned_media: [],
    assigned_seasons: {},
    auto_scheduler_audience: [],
    auto_scheduler_audience_exclude: [],
    epg_filler_weights: { promo: 0, trailer: 0, commercial: 0 },
    content_warning_filter: { include: [], exclude: [] },
    // TWC-specific: zipcode for local weather lookup
    twc_zipcode: '',
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  }).write();
}

module.exports = db;
