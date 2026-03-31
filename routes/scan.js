// ─── Music Video filename parser ─────────────────────────────────────────────
// Handles formats:
//   Artist - Title.ext
//   Artist - Title (Year).ext
//   Artist - Title (YYYYMMDD).ext
//   YEAR - Artist - Title.ext
//   Artist - Title (Version) - Year.ext
function parseMusicVideoFilename(base) {
  let artist = null, title = null, year = null, version = null;
  
  // Strip common quality tags
  const clean = base.replace(/[\[(](1080p|720p|4k|hd|webdl|bluray|hdtv)[\])]/gi, '').trim();
  
  // Format: YYYY - Artist - Title
  let m = clean.match(/^(\d{4})\s*-\s*(.+?)\s*-\s*(.+)$/);
  if (m) { year = parseInt(m[1]); artist = m[2].trim(); title = cleanMVTitle(m[3]); return { artist, title, year, version }; }
  
  // Format: Artist - Title (Version) - YEAR  or  Artist - Title - YEAR
  m = clean.match(/^(.+?)\s*-\s*(.+?)\s*-\s*(\d{4})$/);
  if (m) {
    artist = m[1].trim();
    const mid = m[2].trim();
    year = parseInt(m[3]);
    // Check if mid contains a version in parens
    const vMatch = mid.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (vMatch) { title = vMatch[1].trim(); version = vMatch[2].trim(); }
    else title = mid;
    return { artist, title, year, version };
  }
  
  // Format: Artist - Title (Year) or Artist - Title (YYYYMMDD) or Artist - Title (MMDDYYYY)
  m = clean.match(/^(.+?)\s*-\s*(.+?)\s*\((\d{4,8})\)\s*$/);
  if (m) {
    artist = m[1].trim();
    const rawYear = m[3];
    year = parseInt(rawYear.slice(0, 4));
    if (year < 1900 || year > 2100) year = null;
    title = cleanMVTitle(m[2]);
    return { artist, title, year, version };
  }
  
  // Format: Artist - Title (Version)
  m = clean.match(/^(.+?)\s*-\s*(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    artist = m[1].trim();
    title  = m[2].trim();
    version = m[3].trim();
    // If version looks like a year, treat it as year
    if (/^\d{4}$/.test(version)) { year = parseInt(version); version = null; }
    return { artist, title, year, version };
  }
  
  // Simple: Artist - Title
  m = clean.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) { artist = m[1].trim(); title = cleanMVTitle(m[2]); return { artist, title, year, version }; }
  
  // Fallback: use whole string as title
  return { artist: null, title: clean, year: null, version: null };
}

function cleanMVTitle(s) {
  // Remove trailing year in parens if present
  return s.replace(/\s*\(\d{4,8}\)\s*$/, '').trim();
}

const express  = require('express');
const router   = require('express').Router();
const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 }   = require('uuid');
const { execFile }     = require('child_process');
const https    = require('https');
const db       = require('../db');
const axios    = require('axios');

// SSL bypass for corporate proxies / antivirus HTTPS interception
const httpsAgent = new https.Agent({ rejectUnauthorized: process.env.STRICT_SSL === 'true' });
const ax = axios.create({ httpsAgent });

// ─── Lightweight ffprobe check (reuses detection from media.js) ───────────────
function findBinary(name) {
  const candidates = [
    name,
    `C:\\ffmpeg\\bin\\${name}.exe`,
    `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`,
    `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`,
  ];
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      try { if (fs.existsSync(c)) return c; } catch {}
    } else return c;
  }
  return name;
}
const FFPROBE = findBinary('ffprobe');

function probeFileSync(filePath) {
  return new Promise(resolve => {
    // Include -show_format to get accurate duration from container
    execFile(FFPROBE, ['-v','quiet','-print_format','json','-show_streams','-show_format', filePath], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const video = streams.find(s => s.codec_type === 'video');
        const audio = streams.find(s => s.codec_type === 'audio');
        const videoCodec = (video?.codec_name || '').toLowerCase();
        const audioCodec = (audio?.codec_name || '').toLowerCase();
        const ext = path.extname(filePath).toLowerCase();
        const badContainer  = ['.mkv','.avi','.wmv','.ts','.m2ts','.flv','.ogv'].includes(ext);
        const badVideoCodec = ['hevc','h265','vp9','av1','mpeg2video','mpeg4','theora','wmv1','wmv2','wmv3','vc1','flv1'].includes(videoCodec);
        const badAudioCodec = ['dts','truehd','mlp','eac3','vorbis','wmav1','wmav2','wmapro'].includes(audioCodec);
        // Get accurate duration in minutes from format (most reliable source)
        const durationSecs = parseFloat(data.format?.duration || video?.duration || 0);
        const durationMins = durationSecs > 0 ? durationSecs / 60 : null;
        resolve({ videoCodec, audioCodec, needsTranscode: badContainer || badVideoCodec || badAudioCodec, durationMins });
      } catch { resolve(null); }
    });
  });
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.wmv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.m2ts', '.flv', '.ogv'];

// ─── TMDB helpers (mirrored from metadata.js so scan can auto-fetch) ─────────
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w500';
const _TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1Y2RhMDBjN2M4NzBhODk2YzdhYTc3NzVlYmZmNGQ5OCIsIm5iZiI6MTc3MzI4MTA1NS42NjYsInN1YiI6IjY5YjIxZjFmZTI3NzI1MGI2N2E3NmE5NiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.GOz6jmqlFUGyAXfY4VsHnyERfot-U4Ufjl-nTenbTvE';
const _TMDB_API_KEY    = process.env.TMDB_API_KEY    || '5cda00c7c870a896c7aa7775ebff4d98';
function tmdbAuth() {
  if (_TMDB_READ_TOKEN && _TMDB_READ_TOKEN !== 'your_tmdb_token_here')
    return { headers: { Authorization: 'Bearer ' + _TMDB_READ_TOKEN } };
  if (_TMDB_API_KEY && _TMDB_API_KEY !== 'your_tmdb_key_here')
    return { params: { api_key: _TMDB_API_KEY } };
  return null;
}
function withTmdb(extra) {
  const auth = tmdbAuth();
  if (!auth) return extra || {};
  const m = { ...(extra || {}) };
  if (auth.headers) m.headers = { ...(m.headers || {}), ...auth.headers };
  if (auth.params)  m.params  = { ...(m.params  || {}), ...auth.params  };
  return m;
}
const GENRE_MAP = {
  'Action':'Action','Adventure':'Adventure','Animation':'Animation','Comedy':'Comedy',
  'Crime':'Crime','Documentary':'Documentary','Drama':'Drama','Family':'Family',
  'Fantasy':'Fantasy','History':'Historical','Horror':'Horror','Music':'Musical',
  'Mystery':'Mystery','Romance':'Romance','Science Fiction':'Science Fiction',
  'TV Movie':'Drama','Thriller':'Thriller','War':'War','Western':'Western',
};
function mapGenres(g) { return (g||[]).map(x => GENRE_MAP[x.name]||x.name).filter((v,i,a)=>a.indexOf(v)===i); }
function extractRating(releaseDates) {
  if (!releaseDates?.results) return null;
  const us = releaseDates.results.find(r => r.iso_3166_1 === 'US');
  if (!us) return null;
  const sorted = [...(us.release_dates||[])].sort((a,b)=>[3,4,5,6,1,2].indexOf(a.type)-[3,4,5,6,1,2].indexOf(b.type));
  for (const rd of sorted) if (rd.certification?.trim()) return rd.certification.trim();
  return null;
}
function extractCredits(credits) {
  const director = (credits?.crew||[]).filter(p=>p.job==='Director').map(p=>p.name).join(', ')||null;
  const cast = (credits?.cast||[]).slice(0,8).map(p=>p.name).join(', ')||null;
  return { director, cast };
}
async function tmdbFetchMovie(title, year) {
  try {
    const auth = tmdbAuth();
    if (!auth) return null;
    const sr = await ax.get(`${TMDB_BASE}/search/movie`,
      withTmdb({ params: { query: title, year: year||undefined, language: 'en-US', include_adult: false } }));
    const results = sr.data.results || [];
    if (!results.length) return null;
    const best = year ? results.find(x => x.release_date?.startsWith(String(year))) || results[0] : results[0];
    const dr = await ax.get(`${TMDB_BASE}/movie/${best.id}`,
      withTmdb({ params: { language: 'en-US', append_to_response: 'credits,release_dates' } }));
    const d = dr.data;
    const { director, cast } = extractCredits(d.credits);
    return {
      title:            d.title,
      synopsis:         d.overview || null,
      tagline:          d.tagline  || null,
      year:             d.release_date ? parseInt(d.release_date.split('-')[0]) : (year || null),
      release_date:     d.release_date || null,
      runtime:          d.runtime || null,
      genre:            mapGenres(d.genres),
      rating:           extractRating(d.release_dates),
      director,
      cast,
      poster_url:       d.poster_path   ? `${TMDB_IMG}${d.poster_path}`   : null,
      backdrop_url:     d.backdrop_path ? `${TMDB_IMG}${d.backdrop_path}` : null,
      tmdb_id:          String(d.id),
      imdb_id:          d.imdb_id || null,
      media_type:       'movie',
      metadata_fetched: true,
    };
  } catch (err) {
    console.warn('TMDB auto-fetch failed for "' + title + '":', err.message);
    return null;
  }
}

// ─── Quality / release-group tag stripper for movie titles ───────────────────
// Removes things like "1080p", "BluRay", "x264", "[GROUP]", etc. from the end
const QUALITY_TAGS = [
  '4k', '2160p', '1080p', '1080i', '720p', '720i', '480p', '576p',
  'uhd', 'hdr', 'hdr10', 'dv', 'dolby.vision',
  'bluray', 'blu-ray', 'bdrip', 'bdrip', 'bdremux', 'brrip',
  'webrip', 'web-rip', 'web-dl', 'webdl', 'hdrip',
  'hdtv', 'pdtv', 'dvdrip', 'dvdscr', 'dvd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'xvid', 'divx', 'avc',
  'aac', 'ac3', 'dts', 'truehd', 'atmos', 'flac', 'mp3',
  'extended', 'theatrical', 'remastered', 'unrated', 'proper', 'repack',
  // Common release groups / scene tags (stripped from end of filename)
  'yify', 'yts', 'rarbg', 'eztv', 'ettv', 'fgt', 'sparks', 'geckos',
  'ion10', 'tigole', 'qxr', 'cm', 'ntb', 'mixed', 'sample', 'extras',
  'retail', 'remux', 'encode', 'internal', 'limited', 'nordic',
  // Multi-audio / language tags
  'multi', 'dubbed', 'subbed', 'english', 'french', 'spanish', 'german',
];

function stripQualityTags(str) {
  // Remove bracketed/parenthesized quality markers: [1080p], (BluRay), etc.
  str = str.replace(/[\[(][^\])]*(1080|720|4k|2160|bluray|webrip|hdtv|x264|x265|hevc)[^\])]*[\])]/gi, '');
  // Remove standalone quality tokens from the end of the string
  const parts = str.split(/[\s._-]+/);
  while (parts.length > 0) {
    const last = parts[parts.length - 1].toLowerCase();
    if (QUALITY_TAGS.indexOf(last) !== -1 || /^\d{3,4}p$/i.test(last)) {
      parts.pop();
    } else {
      break;
    }
  }
  return parts.join(' ').trim();
}

// ─── TV show filename parser ─────────────────────────────────────────────────
//
// Supported formats (all separators: space, dash, dot, underscore, or mix):
//
//  Standard season/episode:
//    Show Name - S05E01 - Episode Title
//    Show Name (2005) - S05E01 - Episode Title
//    Show.Name.S05E01.Episode.Title
//    Show Name S05E01 Episode Title
//    ShowName_S05E01_EpisodeTitle
//
//  Alt 1x01 format:
//    Show Name - 5x01 - Episode Title
//    Show.Name.5x01.Episode.Title
//
//  Multi-episode (treated as first episode):
//    Show Name - S01E01E02 - Title          (contiguous, no dash)
//    Show Name - S01E01-E02 - Title         (dash between)
//
//  Date-based episodes:
//    Show Name - 2011-11-15 - Episode Title (YYYY-MM-DD)
//    Show Name - 15-11-2011 - Episode Title (DD-MM-YYYY)
//
//  Absolute episode number (anime/some shows):
//    Show Name - 101 - Episode Title        (3-digit = season 1, ep 01)
//    Show Name - 1001 - Episode Title       (4-digit = season 10, ep 01)
//
//  Specials (season 00):
//    Show Name - S00E01 - Title

function parseTvFilename(base) {
  // Normalise: collapse runs of separators into a single space for simpler matching,
  // but keep a copy of the original for show-name cleanup.
  // We match against the raw base so dots/underscores in show names stay intact.

  const SEP = '[\\s._-]';         // one separator character
  const SEPS = '[\\s._-]+';       // one or more separators

  // ── Helper: clean up a raw show-name token ──────────────────────────────────
  function cleanShow(raw) {
    return raw
      .replace(/[._]/g, ' ')           // dots/underscores → space
      .replace(/\s*-\s*$/, '')         // trailing dash
      .replace(/\s*\(\s*\)/, '')       // empty parens
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ── Helper: clean up a raw episode-title token ──────────────────────────────
  function cleanTitle(raw) {
    // Strip trailing quality tags
    raw = stripQualityTags(raw);
    return raw
      .replace(/[._]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ── Pattern group 1: standard SxxExx ──────────────────────────────────────
  // Capture: (show)(year?)(season)(ep)(ep2?)(title?)
  // Regex is intentionally verbose so it handles all separator variants.
  const sxex = new RegExp(
    '^(.+?)' +                                   // show name (non-greedy)
    '(?:' + SEPS + '\\((\\d{4})\\))?' +          // optional (YYYY)
    SEPS +
    '[Ss](\\d{1,2})' +                           // S05
    '[Ee](\\d{1,3})' +                           // E01
    '(?:[-_]?[Ee](\\d{1,3}))?' +                 // optional E02 (multi-ep)
    '(?:' + SEPS + '(.+))?$'                     // optional title
  );

  var m = base.match(sxex);
  if (m) {
    var showRaw   = m[1];
    var yearStr   = m[2] || null;
    var seasonNum = parseInt(m[3], 10);
    var epNum     = parseInt(m[4], 10);
    // m[5] = second episode number (multi-ep), ignored for storage
    var titleRaw  = m[6] || '';

    var showName = cleanShow(showRaw);
    // If year was embedded in the show name string (e.g. "Show Name (2005)")
    // extract it if we didn't catch it via the optional group
    if (!yearStr) {
      var yearInShow = showName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
      if (yearInShow) { showName = yearInShow[1].trim(); yearStr = yearInShow[2]; }
    }

    var title = cleanTitle(titleRaw) ||
                showName + ' S' + String(seasonNum).padStart(2,'0') + 'E' + String(epNum).padStart(2,'0');

    return {
      media_type:     'tv_show',
      show_name:      showName,
      title:          title,
      season_number:  seasonNum,
      episode_number: epNum,
      season:         seasonNum,
      episode:        epNum,
      year:           yearStr ? parseInt(yearStr, 10) : null,
    };
  }

  // ── Pattern group 2: alt NxNN format (e.g. 5x01) ──────────────────────────
  const nxnn = new RegExp(
    '^(.+?)' +
    SEPS +
    '(\\d{1,2})x(\\d{1,3})' +
    '(?:' + SEPS + '(.+))?$'
  );
  m = base.match(nxnn);
  if (m) {
    var showName  = cleanShow(m[1]);
    var seasonNum = parseInt(m[2], 10);
    var epNum     = parseInt(m[3], 10);
    var title     = cleanTitle(m[4] || '') ||
                    showName + ' S' + String(seasonNum).padStart(2,'0') + 'E' + String(epNum).padStart(2,'0');
    return {
      media_type: 'tv_show', show_name: showName, title: title,
      season_number: seasonNum, episode_number: epNum,
      season: seasonNum, episode: epNum, year: null,
    };
  }

  // ── Pattern group 3: date-based YYYY-MM-DD or DD-MM-YYYY ──────────────────
  const datePat = /^(.+?)[\s._-]+(\d{4})-(\d{2})-(\d{2})(?:[\s._-]+(.+))?$/;
  const datePat2 = /^(.+?)[\s._-]+(\d{2})-(\d{2})-(\d{4})(?:[\s._-]+(.+))?$/;

  m = base.match(datePat);
  if (m) {
    var showName = cleanShow(m[1]);
    var airdate  = m[2] + '-' + m[3] + '-' + m[4]; // YYYY-MM-DD
    var title    = cleanTitle(m[5] || '') || (showName + ' ' + airdate);
    return {
      media_type: 'tv_show', show_name: showName, title: title,
      season_number: null, episode_number: null,
      season: null, episode: null,
      airdate: airdate, year: parseInt(m[2], 10),
    };
  }
  m = base.match(datePat2);
  if (m) {
    var showName = cleanShow(m[1]);
    var airdate  = m[4] + '-' + m[3] + '-' + m[2]; // normalise to YYYY-MM-DD
    var title    = cleanTitle(m[5] || '') || (showName + ' ' + airdate);
    return {
      media_type: 'tv_show', show_name: showName, title: title,
      season_number: null, episode_number: null,
      season: null, episode: null,
      airdate: airdate, year: parseInt(m[4], 10),
    };
  }

  // ── Pattern group 4: absolute episode number (3-4 digits, anime style) ────
  // e.g. "Naruto - 047 - Title" or "Show - 1002 - Title"
  // Only triggered when surrounded by separators to avoid matching years.
  // Explicitly exclude 4-digit numbers in the year range 1888–2099.
  const absPat = /^(.+?)[\s._-]+(\d{3,4})[\s._-]+(.+)$/;
  m = base.match(absPat);
  if (m) {
    var absNum   = parseInt(m[2], 10);
    // Don't treat a plausible year (1888–2099) as an episode number
    if (!(absNum >= 1888 && absNum <= 2099)) {
      // Decompose: last 2 digits = episode, leading digits = season
      var epNum     = absNum % 100;
      var seasonNum = Math.floor(absNum / 100) || 1;
      var showName  = cleanShow(m[1]);
      var title     = cleanTitle(m[3]);
      if (title) { // Only treat as TV if we got an episode title
        return {
          media_type: 'tv_show', show_name: showName, title: title,
          season_number: seasonNum, episode_number: epNum,
          season: seasonNum, episode: epNum, year: null,
        };
      }
    }
  }

  return null; // not a TV file
}

// ─── Movie filename parser ───────────────────────────────────────────────────
//
// Supported formats:
//   Movie Name (1999).mkv
//   Movie Name (1999) - Optional Info.mkv
//   Movie Name (1999) {edition-Director's Cut}.mkv
//   Movie Name (1999) {tmdb-12345}.mkv
//   Movie Name (1999) {imdb-tt1234567}.mkv
//   Movie.Name.1999.mkv                        (dots, bare year)
//   Movie_Name_1999.mkv                        (underscores)
//   Movie Name 1999.mkv                        (spaces)
//   Movie Name 1999 1080p BluRay x264.mkv      (quality tags stripped)

function parseMovieFilename(base) {
  // Strip common edition / ID tags before we look for the year
  var clean = base
    .replace(/\{edition-[^}]+\}/gi, '')      // {edition-Director's Cut}
    .replace(/\{tmdb-\d+\}/gi, '')           // {tmdb-12345}
    .replace(/\{imdb-tt\d+\}/gi, '')         // {imdb-tt1234567}
    .replace(/\{[^}]+\}/g, '')               // any other {tag}
    .trim();

  clean = stripQualityTags(clean);

  // Normalise separators (dots/underscores → spaces) for matching
  var norm = clean.replace(/[._]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Try "(YYYY)" parenthesised year first — most reliable
  var m = norm.match(/^(.+?)\s*\((\d{4})\)\s*(.*)$/);
  if (m) {
    var title = m[1].trim();
    var year  = parseInt(m[2], 10);
    // m[3] might be "- Optional Info" — ignore it for the title
    return { media_type: 'movie', title: title, year: year };
  }

  // Bare year: "Movie Name 1999 ..." — year must be 1888–2099
  m = norm.match(/^(.+?)\s+((?:18|19|20)\d{2})\b(.*)$/);
  if (m) {
    var title = m[1].trim();
    var year  = parseInt(m[2], 10);
    return { media_type: 'movie', title: title, year: year };
  }

  // No year found — still a movie, just no year
  return { media_type: 'movie', title: norm || clean, year: null };
}

// ─── Master parseFilename ────────────────────────────────────────────────────
function parseFilename(filePath, modeHint) {
  var base = path.basename(filePath, path.extname(filePath));
  if (modeHint !== 'movie') {
    var tv = parseTvFilename(base);
    if (tv) return tv;
  }
  return parseMovieFilename(base);
}

// ─── Directory scanner ───────────────────────────────────────────────────────
function scanDirectory(dirPath, results) {
  if (!results) results = [];
  try {
    var entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var entry    = entries[i];
      var fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath, results);
      } else if (entry.isFile()) {
        var ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.indexOf(ext) !== -1) results.push(fullPath);
      }
    }
  } catch (err) {
    console.warn('Cannot read ' + dirPath + ':', err.message);
  }
  return results;
}

// ─── POST /api/scan ──────────────────────────────────────────────────────────
router.post('/', async function(req, res) {
  try {
    var rootPath  = req.body.folder_path || process.env.MEDIA_ROOT || './media_test';
    var scanMode  = req.body.scan_mode || 'auto'; // 'auto' | 'movie' | 'tv' | 'music_video'

    if (!fs.existsSync(rootPath)) {
      return res.status(400).json({ error: 'Folder not found: ' + rootPath });
    }

    var videoFiles = scanDirectory(rootPath);

    // Build two lookup maps from the existing media records (non-filler only):
    //   normPath  → record   (normalised, lowercased file_path)
    //   fileName  → record   (lowercased basename)
    // This catches duplicates even when:
    //   - The path casing differs (Windows)
    //   - Backslash vs forward-slash differences
    //   - The file was moved or the root folder changed
    var existingByPath = {};
    var existingByName = {};
    db.get('media').value().forEach(function(r) {
      if (r.is_filler) return; // filler handled separately
      if (r.file_path) existingByPath[path.normalize(r.file_path).toLowerCase()] = r;
      if (r.file_name) existingByName[r.file_name.toLowerCase()] = r;
    });

    var inserted = [], pathUpdated = 0;

    for (var i = 0; i < videoFiles.length; i++) {
      var filePath   = videoFiles[i];
      var normLower  = path.normalize(filePath).toLowerCase();
      var fileNameLc = path.basename(filePath).toLowerCase();

      // 1. Exact path match (normalised + lowercased)
      var existingRecord = existingByPath[normLower];

      // 2. Filename match — file may have moved or path separator differs
      if (!existingRecord) existingRecord = existingByName[fileNameLc];

      if (existingRecord) {
        // Already in library. Update path if changed, and update media_type
        // if re-scanning with an explicit mode (so unknown items get properly typed).
        const updates = {};
        if (existingRecord.file_path !== filePath) {
          updates.file_path = filePath;
          pathUpdated++;
        }
        if (scanMode === 'music_video' && existingRecord.media_type !== 'music_video') {
          const mvP = parseMusicVideoFilename(path.basename(filePath, path.extname(filePath)));
          updates.media_type  = 'music_video';
          updates.artist_name = existingRecord.artist_name || mvP.artist || existingRecord.title;
          updates.title       = existingRecord.title || mvP.title;
          if (mvP.year) updates.year = mvP.year;
          if (mvP.version) updates.mv_version = mvP.version;
          const fparts = filePath.replace(/\\/g,'/').split('/');
          if (fparts.length >= 3 && !existingRecord.album_title) updates.album_title = fparts[fparts.length-2];
        } else if (scanMode === 'movie' && existingRecord.media_type === 'unknown') {
          updates.media_type = 'movie';
        } else if (scanMode === 'tv' && existingRecord.media_type === 'unknown') {
          updates.media_type = 'tv_show';
        }
        if (Object.keys(updates).length > 0) {
          updates.updated_date = new Date().toISOString();
          db.get('media').find({ id: existingRecord.id }).assign(updates).write();
        }
        continue; // skip new record creation — already imported
      }

      var id     = uuidv4();
      var parsed = parseFilename(filePath, scanMode);

      // If the user told us exactly what type this folder contains, trust them.
      // This catches movies without years (would be 'unknown' otherwise) and
      // TV rips that don't have S##E## in the filename.
      if (scanMode === 'movie') {
        parsed.media_type = 'movie';
      } else if (scanMode === 'tv') {
        parsed.media_type = 'tv_show';
        if (!parsed.show_name) parsed.show_name = parsed.title;
      } else if (scanMode === 'music_video') {
        // Parse music video filename: Artist - Title, Artist - Title (Year), etc.
        const mvParsed = parseMusicVideoFilename(path.basename(filePath, path.extname(filePath)));
        parsed.media_type  = 'music_video';
        parsed.artist_name = mvParsed.artist || parsed.title;
        parsed.title       = mvParsed.title  || path.basename(filePath);
        parsed.year        = mvParsed.year   || parsed.year;
        parsed.mv_version  = mvParsed.version || null;
        // Try to get album from parent folder (album folder)
        const parts = filePath.replace(/\\/g, '/').split('/');
        if (parts.length >= 3) {
          parsed.album_title = parts[parts.length - 2]; // immediate parent = album folder
          // grandparent = artist folder — use as artist if not already set
          if (!parsed.artist_name) parsed.artist_name = parts[parts.length - 3];
        }
      }

      // ── Folder-name fallback for movies ────────────────────────────────────
      // The parent folder often has a cleaner name like "A Beautiful Mind (2001)".
      // Use it to fill in missing title/year, or to override if the filename
      // parser produced something clearly wrong (no year found in filename).
      if (parsed.media_type === 'movie' || (!parsed.media_type && scanMode !== 'tv')) {
        var folderName = path.basename(path.dirname(filePath));
        var folderParsed = parseMovieFilename(folderName);
        if (folderParsed && folderParsed.title) {
          // Use folder title if filename has no year but folder does (strong signal)
          if (!parsed.year && folderParsed.year) {
            parsed.title = folderParsed.title;
            parsed.year  = folderParsed.year;
          }
          // Use folder title if it's shorter/cleaner (folder names rarely have quality tags)
          if (folderParsed.year && parsed.year === folderParsed.year) {
            parsed.title = folderParsed.title;
          }
        }
      }

      var record   = {
        id:             id,
        title:          parsed.title || path.basename(filePath),
        file_path:      filePath,
        file_url:       '/api/media/stream/' + id,
        file_name:      path.basename(filePath),
        media_type:     parsed.media_type || 'unknown',
        show_name:      parsed.show_name  || null,
        season_number:  parsed.season_number  != null ? parsed.season_number  : null,
        episode_number: parsed.episode_number != null ? parsed.episode_number : null,
        season:         parsed.season         != null ? parsed.season         : null,
        episode:        parsed.episode        != null ? parsed.episode        : null,
        airdate:        parsed.airdate        || null,
        year:           parsed.year           || null,
        release_date:   parsed.year ? (parsed.year + '-01-01') : null,
        is_filler:      false,
        metadata_fetched: false,
        created_date:   new Date().toISOString(),
        updated_date:   new Date().toISOString(),
        // Music video fields
        ...(parsed.media_type === 'music_video' ? {
          artist_name: parsed.artist_name || null,
          album_title: parsed.album_title || null,
          mv_version:  parsed.mv_version  || null,
        } : {}),
      };
      db.get('media').push(record).write();
      inserted.push(record);

      // ── Background codec probe ────────────────────────────────────────────────
      // Non-blocking — tags the record with needs_transcode for the stream route
      probeFileSync(filePath).then(probed => {
        if (probed) {
          const patch = {
            needs_transcode: probed.needsTranscode,
            video_codec:     probed.videoCodec,
            audio_codec:     probed.audioCodec,
          };
          // Store accurate file duration — overrides manually-entered runtime
          if (probed.durationMins) patch.duration_minutes = probed.durationMins;
          db.get('media').find({ id: record.id }).assign(patch).write();
        }
      }).catch(() => {});

      // ── Auto-fetch TMDB metadata for movies ──────────────────────────────────
      if (record.media_type === 'movie' && record.title && tmdbAuth()) {
        try {
          const meta = await tmdbFetchMovie(record.title, record.year);
          if (meta) {
            const enriched = {
              ...record, ...meta,
              id:           record.id,
              file_path:    record.file_path,
              file_name:    record.file_name,
              file_url:     record.file_url,
              created_date: record.created_date,
              updated_date: new Date().toISOString(),
            };
            db.get('media').find({ id: record.id }).assign(enriched).write();
            // Patch the inserted array entry so the response reflects enriched data
            inserted[inserted.length - 1] = enriched;
            existingByPath[path.normalize(filePath).toLowerCase()] = enriched;
            existingByName[fileNameLc] = enriched;
          }
        } catch (_) { /* TMDB failure never blocks the scan */ }
      }
      // Keep lookups current so duplicate filenames within the same scan batch are caught
      // (use the last entry in inserted[] which may have been enriched by TMDB above)
      var finalRecord = inserted[inserted.length - 1];
      existingByPath[path.normalize(filePath).toLowerCase()] = finalRecord;
      existingByName[fileNameLc] = finalRecord;
    }

    res.json({
      scanned:          videoFiles.length,
      new_files:        inserted.length,
      already_imported: videoFiles.length - inserted.length - pathUpdated,
      path_updated:     pathUpdated,
      inserted:         inserted.map(function(r) {
        return { id: r.id, title: r.title, media_type: r.media_type, file_name: r.file_name };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/scan/folders ───────────────────────────────────────────────────
router.get('/folders', function(req, res) {
  try {
    var rootPath = process.env.MEDIA_ROOT || './media_test';
    var folders  = [];
    if (fs.existsSync(rootPath)) {
      fs.readdirSync(rootPath, { withFileTypes: true }).forEach(function(e) {
        if (e.isDirectory()) folders.push({ name: e.name, path: path.join(rootPath, e.name) });
      });
    }
    res.json({ media_root: rootPath, subfolders: folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/scan/test  (dev helper — remove in prod if desired) ─────────────
router.get('/test', function(req, res) {
  var samples = [
    // TV — standard
    'Mystery Science Theater 3000 - S05E01 - Warrior of the Lost World.mkv',
    'Band of Brothers (2001) - s01e01 - Currahee.mkv',
    'The.Simpsons.S04E12.Marge.vs.the.Monorail.mkv',
    'Seinfeld_S09E03_The_Serenity_Now.avi',
    'Doctor Who (2005) s02e01 New Earth.mp4',
    // TV — alt format
    'Grey\'s Anatomy 1x01 A Hard Day\'s Night.avi',
    // TV — multi-episode
    'Friends - S02E01E02 - The One With Ross\' New Girlfriend.mkv',
    'The Office - S03E01-E02 - Gay Witch Hunt.mkv',
    // TV — date-based
    'The Daily Show - 2023-03-15 - March 15 2023.mkv',
    'Some News Show - 15-03-2023 - Episode.mkv',
    // TV — specials (season 0)
    'Doctor Who - S00E01 - The Christmas Invasion.mkv',
    // TV — absolute episode (anime)
    'Naruto - 047 - The Fourth Hokage.mkv',
    // Movies — standard
    'The Matrix (1999).mkv',
    'Blade Runner (1982) {edition-Director\'s Cut}.mkv',
    'Blade.Runner.1982.mkv',
    'Pulp Fiction 1994 1080p BluRay x264.mkv',
    'Avengers Endgame (2019) {tmdb-299534}.mkv',
    'Some Movie (2020) - Extended Cut.mkv',
  ];
  var results = samples.map(function(f) {
    return { file: f, parsed: parseFilename(f) };
  });
  res.json(results);
});

// ─── Filler filename parser ───────────────────────────────────────────────────
// Handles these naming patterns (and mixes thereof):
//
//  YYYY - Product.ext                 → year=YYYY, title/product=Product
//  Product - YYYY.ext                 → year=YYYY, title/product=Product
//  Type - Product - YYYY.ext          → type=Type, year=YYYY, product=Product
//  Type - Product - MMDDYYYY.ext      → type=Type, airdate, product=Product
//  Type - Product - YYYYMMDD.ext
//  Type - Product - DDMMYYYY.ext
//  Type.Product.YYYY.ext              → dot-separated variant
//  1995 - Sister Sister promo.ext     → year from front, type from trailing word
//  Promo - The Brian Benben Show - 1998.ext
//  Ident-Channel - PBS - 02121997.ext
//  Ident-Station - A&E - 05-22-1996.ext
//
// Returns: { fillerType, title, product, year, airdate }
// Any field may be null if not determinable.

var FILLER_TYPE_ALIASES = {
  'commercial':        'Commercial',
  'bumper':            'Bumper In',
  'bumperin':          'Bumper In',
  'bumper-in':         'Bumper In',
  'bumperout':         'Bumper Out',
  'bumper-out':        'Bumper Out',
  'ratingsnotice':     'Ratings Notice',
  'ratings-notice':    'Ratings Notice',
  'ratingsnotices':    'Ratings Notice',
  'ratings notice':    'Ratings Notice',
  'stationid':         'Station ID',
  'station-id':        'Station ID',
  'station id':        'Station ID',
  'blockmarathonid':   'Block-Marathon ID',
  'block-marathon-id': 'Block-Marathon ID',
  'promo':             'Promo',
  'promotion':         'Promo',
  'trailer':           'Trailer',
  'psa':               'PSA',
  'emergencyalert':    'Emergency Alert',
  'emergency-alert':   'Emergency Alert',
  'emergency alert':   'Emergency Alert',
  'ident-channel':     'Ident-Channel',
  'ident-station':     'Ident-Channel',   // alias
  'identchannel':      'Ident-Channel',
  'identstation':      'Ident-Channel',
  'ident-movie':       'Ident-Movie',
  'identmovie':        'Ident-Movie',
  'ident-tv':          'Ident-TV Show',
  'identtv':           'Ident-TV Show',
  'ident-tvshow':      'Ident-TV Show',
  'interstitial':      'Interstitial',
};

function resolveFillerType(raw) {
  if (!raw) return null;
  return FILLER_TYPE_ALIASES[raw.toLowerCase().trim()] || null;
}

// Try to parse a date string that may be MMDDYYYY, DDMMYYYY, YYYYMMDD, MM-DD-YYYY etc.
// Returns ISO string or null.
function parseAirdate(s) {
  if (!s) return null;
  // Strip dashes/slashes to get compact form
  var compact = s.replace(/[-/]/g, '');
  if (!/^\d{8}$/.test(compact)) return null;

  // YYYYMMDD
  var y1 = compact.slice(0,4), m1 = compact.slice(4,6), d1 = compact.slice(6,8);
  if (parseInt(y1) >= 1900 && parseInt(m1) >= 1 && parseInt(m1) <= 12 && parseInt(d1) >= 1 && parseInt(d1) <= 31) {
    return y1 + '-' + m1 + '-' + d1;
  }
  // MMDDYYYY
  var m2 = compact.slice(0,2), d2 = compact.slice(2,4), y2 = compact.slice(4,8);
  if (parseInt(y2) >= 1900 && parseInt(m2) >= 1 && parseInt(m2) <= 12 && parseInt(d2) >= 1 && parseInt(d2) <= 31) {
    return y2 + '-' + m2 + '-' + d2;
  }
  // DDMMYYYY
  var d3 = compact.slice(0,2), m3 = compact.slice(2,4), y3 = compact.slice(4,8);
  if (parseInt(y3) >= 1900 && parseInt(m3) >= 1 && parseInt(m3) <= 12 && parseInt(d3) >= 1 && parseInt(d3) <= 31) {
    return y3 + '-' + m3 + '-' + d3;
  }
  return null;
}

function parseFillerFilename(base) {
  // Normalise: replace underscores with spaces, collapse multiple spaces
  var norm = base.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();

  var fillerType = null, title = null, product = null, year = null, airdate = null;

  // ── Dot-separated: Type.Product.YYYY  (first segment is a known filler type) ──
  var dotParts = norm.split('.');
  if (dotParts.length >= 2) {
    var maybeType = resolveFillerType(dotParts[0].trim());
    if (maybeType) {
      fillerType = maybeType;
      var rest = dotParts.slice(1);
      var lastPart = rest[rest.length - 1].trim();
      var yearMatch = lastPart.match(/^(\d{4})$/);
      var dateMatch = !yearMatch && lastPart.match(/^\d{6,8}$/);
      if (yearMatch) {
        year    = parseInt(lastPart);
        product = rest.slice(0, -1).join(' ').trim() || null;
      } else if (dateMatch) {
        airdate = parseAirdate(lastPart);
        if (airdate) year = parseInt(airdate.slice(0, 4));
        product = rest.slice(0, -1).join(' ').trim() || null;
      } else {
        product = rest.join(' ').trim() || null;
      }
      title = buildIdentTitle(fillerType, product) || product;
      return { fillerType, title, product, year, airdate };
    }
  }

  // ── Dash-separated: split ONLY on ' - ' (space–dash–space) so that
  //    hyphenated type names like 'Ident-Channel' are preserved intact. ──────────
  var segs = norm.split(' - ');

  // Check if first segment is a known filler type keyword
  var firstType = resolveFillerType(segs[0].trim());

  if (firstType && segs.length >= 2) {
    fillerType = firstType;
    var last    = segs[segs.length - 1].trim();
    // Is the last segment a 4-digit year or an 8-digit date?
    var yearOnly = last.match(/^(\d{4})$/);
    var dateOnly = !yearOnly && (last.match(/^\d{6,8}$/) || last.match(/^\d{2}[-\/]\d{2}[-\/]\d{4}$/) || last.match(/^\d{4}[-\/]\d{2}[-\/]\d{2}$/));
    if ((yearOnly || dateOnly) && segs.length >= 3) {
      if (yearOnly) year = parseInt(last);
      if (dateOnly) { airdate = parseAirdate(last); if (airdate) year = parseInt(airdate.slice(0, 4)); }
      product = segs.slice(1, -1).join(' - ').trim() || null;
    } else {
      product = segs.slice(1).join(' - ').trim() || null;
    }
    title = buildIdentTitle(fillerType, product) || product;
    return { fillerType, title, product, year, airdate };
  }

  // ── YYYY - Product [optional trailing type word]  e.g. "1995 - Sister Sister promo" ──
  var yearFirst = segs[0].trim().match(/^(\d{4})$/);
  if (yearFirst && segs.length >= 2) {
    year = parseInt(yearFirst[1]);
    var body  = segs.slice(1).join(' - ').trim();
    var words = body.split(/\s+/);
    var lastWordType = resolveFillerType(words[words.length - 1]);
    if (lastWordType) {
      fillerType = lastWordType;
      product    = words.slice(0, -1).join(' ').trim() || null;
    } else {
      product = body || null;
    }
    title = buildIdentTitle(fillerType, product) || product;
    return { fillerType, title, product, year, airdate };
  }

  // ── Product - YYYY   (no type in filename — folder provides it) ──────────────
  var lastSeg     = segs[segs.length - 1].trim();
  var trailingYr  = lastSeg.match(/^(\d{4})$/);
  if (trailingYr && segs.length >= 2) {
    year    = parseInt(lastSeg);
    product = segs.slice(0, -1).join(' - ').trim() || null;
    title   = product;
    return { fillerType: null, title, product, year, airdate };
  }

  // Fallback: whole normalised name is the title
  return { fillerType: null, title: norm || null, product: null, year: null, airdate: null };
}

// Derive a human-friendly title for Ident types.
// "Ident-Channel" + "PBS"  →  "PBS Channel Ident"
// "Ident-Movie"   + "Alien" → "Alien Movie Ident"
// "Ident-TV Show" + "Seinfeld" → "Seinfeld TV Show Ident"
// For non-Ident types, return null (caller falls back to product name).
function buildIdentTitle(fillerType, product) {
  if (!product) return null;
  if (fillerType === 'Ident-Channel') return product + ' Channel Ident';
  if (fillerType === 'Ident-Movie')   return product + ' Movie Ident';
  if (fillerType === 'Ident-TV Show') return product + ' TV Show Ident';
  return null;
}

// ─── Channel-name resolver (for Ident-Channel auto-wire) ─────────────────────
// Finds a channel whose name matches the product string (case-insensitive).
function resolveChannelByName(name) {
  if (!name) return null;
  var norm = name.toLowerCase().trim();
  var channels = db.get('channels').value();
  // Exact match first
  var exact = channels.find(c => (c.name || '').toLowerCase().trim() === norm);
  if (exact) return exact;
  // Partial match (channel name contains product or vice versa)
  return channels.find(c => {
    var cn = (c.name || '').toLowerCase().trim();
    return cn.includes(norm) || norm.includes(cn);
  }) || null;
}

// Add a filler ID to a channel's assigned_filler, and remove from old channel.
function syncFillerToChannel(fillerId, oldChannelId, newChannelId) {
  if (oldChannelId && oldChannelId !== newChannelId) {
    var oldCh = db.get('channels').find({ id: oldChannelId }).value();
    if (oldCh) {
      var af = (oldCh.assigned_filler || []).filter(id => id !== fillerId);
      db.get('channels').find({ id: oldChannelId }).assign({ assigned_filler: af }).write();
    }
  }
  if (newChannelId) {
    var newCh = db.get('channels').find({ id: newChannelId }).value();
    if (newCh) {
      var af2 = newCh.assigned_filler || [];
      if (!af2.includes(fillerId)) {
        db.get('channels').find({ id: newChannelId }).assign({ assigned_filler: [...af2, fillerId] }).write();
      }
    }
  }
}

// ─── Filler folder → filler_type mapping ─────────────────────────────────────
// Matches folder names (case-insensitive, singular or plural) to canonical types.
const FILLER_FOLDER_MAP = [
  { type: 'Commercial',        patterns: ['commercial', 'commercials'] },
  { type: 'Bumper In',         patterns: ['bumper in', 'bumpers in', 'bumper-in', 'bumperin'] },
  { type: 'Bumper Out',        patterns: ['bumper out', 'bumpers out', 'bumper-out', 'bumperout'] },
  { type: 'Ratings Notice',    patterns: ['ratings notice', 'ratings notices', 'rating notice', 'rating notices'] },
  { type: 'Station ID',        patterns: ['station id', 'station ids', 'stationid', 'stationids'] },
  { type: 'Block-Marathon ID', patterns: ['block-marathon id', 'block marathon id', 'block-marathon ids', 'marathon id', 'marathon ids'] },
  { type: 'Promo',             patterns: ['promo', 'promos', 'promotion', 'promotions'] },
  { type: 'Trailer',           patterns: ['trailer', 'trailers'] },
  { type: 'PSA',               patterns: ['psa', 'psas', 'public service announcement', 'public service announcements'] },
  { type: 'Emergency Alert',   patterns: ['emergency alert', 'emergency alerts'] },
  { type: 'Ident-Channel',     patterns: ['ident-channel', 'ident channel', 'channel ident', 'channel idents'] },
  { type: 'Ident-Movie',       patterns: ['ident-movie', 'ident movie', 'movie ident', 'movie idents'] },
  { type: 'Ident-TV Show',     patterns: ['ident-tv show', 'ident tv show', 'tv show ident', 'tv ident', 'tv idents'] },
  { type: 'Interstitial',      patterns: ['interstitial', 'interstitials'] },
];

function folderNameToFillerType(folderName) {
  var lower = folderName.toLowerCase().trim();
  for (var i = 0; i < FILLER_FOLDER_MAP.length; i++) {
    var entry = FILLER_FOLDER_MAP[i];
    for (var j = 0; j < entry.patterns.length; j++) {
      if (lower === entry.patterns[j]) return entry.type;
    }
  }
  return null; // unrecognised folder — leave as generic filler
}

// ─── POST /api/scan/filler ───────────────────────────────────────────────────
// Scans a root filler folder. Sub-folders are matched to filler_type by name.
// Files in the root (not in a sub-folder) get no filler_type (generic).
// Duplicates: matched by file_name. If a filler record with the same file_name
// already exists, its file_path is updated rather than creating a new entry.
router.post('/filler', function(req, res) {
  try {
    var rootPath = req.body.folder_path;
    if (!rootPath) return res.status(400).json({ error: 'folder_path is required' });
    // Normalise: strip trailing slash/backslash for reliable comparison
    var normRoot = path.normalize(rootPath.replace(/[/\\]+$/, ''));
    if (!fs.existsSync(normRoot)) return res.status(400).json({ error: 'Folder not found: ' + rootPath });

    // Build a map of file_name → existing record for duplicate detection.
    // Include ALL media records (not just is_filler:true) so that a file previously
    // imported via the regular scan route is still recognised as a duplicate.
    var allMedia = db.get('media').value();
    var byFileName = {};
    allMedia.forEach(function(r) {
      if (r.file_name) byFileName[r.file_name.toLowerCase()] = r;
    });

    var videoFiles = scanDirectory(normRoot);
    var inserted = [], updated = [], skipped = [];

    videoFiles.forEach(function(filePath) {
      var fileName   = path.basename(filePath);
      var fileNameLc = fileName.toLowerCase();

      // Determine filler_type from the immediate parent folder name.
      // normalise both sides so Windows backslash differences don't break the compare.
      var parentDir     = path.normalize(path.dirname(filePath));
      var parentName    = path.basename(parentDir);
      var isInSubfolder = parentDir.toLowerCase() !== normRoot.toLowerCase();
      var fillerType    = isInSubfolder ? folderNameToFillerType(parentName) : null;

      // Duplicate check by file_name
      var existing = byFileName[fileNameLc];

      if (existing) {
        // Same filename already in library — update path, convert to filler, apply parsed metadata
        var base2        = path.basename(filePath, path.extname(filePath));
        var parsed2      = parseFillerFilename(base2);
        var resolvedType2 = parsed2.fillerType || fillerType || existing.filler_type || '';

        var changes = {
          file_path:   filePath,
          file_name:   fileName,
          is_filler:   true,
          media_type:  'filler',
          filler_type: resolvedType2,
          updated_date: new Date().toISOString(),
        };
        if (parsed2.product && !existing.product) changes.product = parsed2.product;
        if (parsed2.year    && !existing.year)    changes.year    = parsed2.year;
        if (parsed2.airdate && !existing.airdate) changes.airdate = parsed2.airdate;
        if (parsed2.title && (!existing.title || existing.title === existing.file_name)) changes.title = parsed2.title;

        // Auto-wire Ident-Channel to channel by name
        if (resolvedType2 === 'Ident-Channel' && parsed2.product && !existing.linked_channel_id) {
          var matchedCh2 = resolveChannelByName(parsed2.product);
          if (matchedCh2) {
            changes.linked_channel_id = matchedCh2.id;
            syncFillerToChannel(existing.id, null, matchedCh2.id);
          }
        }

        db.get('media').find({ id: existing.id }).assign(changes).write();
        updated.push({ id: existing.id, title: changes.title || existing.title, file_name: fileName, filler_type: resolvedType2 });
        byFileName[fileNameLc] = Object.assign({}, existing, changes);
      } else {
        // New file — parse filename for rich metadata
        var base     = path.basename(filePath, path.extname(filePath));
        var parsed   = parseFillerFilename(base);

        // Folder type wins if filename didn't give us one
        var resolvedType = parsed.fillerType || fillerType || '';

        // Auto-resolve linked_channel_id by channel name match for Ident-Channel
        var linkedChannelId = null;
        if (resolvedType === 'Ident-Channel' && parsed.product) {
          var matchedCh = resolveChannelByName(parsed.product);
          if (matchedCh) linkedChannelId = matchedCh.id;
        }

        var id = uuidv4();
        var record = {
          id:               id,
          title:            parsed.title || base.replace(/[._-]/g, ' ').trim(),
          product:          parsed.product || null,
          file_path:        filePath,
          file_url:         '/api/media/stream/' + id,
          file_name:        fileName,
          media_type:       'filler',
          is_filler:        true,
          filler_type:      resolvedType,
          year:             parsed.year    || null,
          airdate:          parsed.airdate || null,
          linked_channel_id: linkedChannelId || '',
          metadata_fetched: false,
          content_warnings: [],
          channel_assignment: {},
          created_date:     new Date().toISOString(),
          updated_date:     new Date().toISOString(),
        };
        db.get('media').push(record).write();

        // Sync channel.assigned_filler to include this new Ident filler
        if (linkedChannelId) syncFillerToChannel(id, null, linkedChannelId);

        inserted.push({ id: record.id, title: record.title, file_name: fileName, filler_type: record.filler_type });
        byFileName[fileNameLc] = record;
      }
    });

    res.json({
      scanned:  videoFiles.length,
      inserted: inserted.length,
      updated:  updated.length,
      skipped:  skipped.length,
      details:  { inserted, updated },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
