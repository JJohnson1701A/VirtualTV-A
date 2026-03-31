const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const https   = require('https');
const db      = require('../db');

// ─── SSL / proxy bypass ───────────────────────────────────────────────────────
// Some environments (corporate networks, antivirus like Zscaler) intercept HTTPS
// and present a self-signed certificate that Node.js rejects by default.
// We create an axios instance that tolerates this, and also set the global
// NODE_TLS_REJECT_UNAUTHORIZED env var as a fallback.
// If you are on a trusted network and want strict SSL, set STRICT_SSL=true in .env
const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.STRICT_SSL === 'true',
});
const ax = axios.create({ httpsAgent });

// ─── TMDB ─────────────────────────────────────────────────────────────────────
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w500';

// Fallbacks ensure keys work even if .env isn't loaded from correct CWD
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1Y2RhMDBjN2M4NzBhODk2YzdhYTc3NzVlYmZmNGQ5OCIsIm5iZiI6MTc3MzI4MTA1NS42NjYsInN1YiI6IjY5YjIxZjFmZTI3NzI1MGI2N2E3NmE5NiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.GOz6jmqlFUGyAXfY4VsHnyERfot-U4Ufjl-nTenbTvE';
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '5cda00c7c870a896c7aa7775ebff4d98';

function tmdbAuth() {
  if (TMDB_READ_TOKEN && TMDB_READ_TOKEN !== 'your_tmdb_token_here')
    return { headers: { Authorization: 'Bearer ' + TMDB_READ_TOKEN } };
  if (TMDB_API_KEY && TMDB_API_KEY !== 'your_tmdb_key_here')
    return { params: { api_key: TMDB_API_KEY } };
  return null;
}
function tmdbConfigured() { return !!tmdbAuth(); }
function withAuth(extra) {
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
function mapGenres(g) {
  return (g||[]).map(x => GENRE_MAP[x.name]||x.name).filter((v,i,a)=>a.indexOf(v)===i);
}
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

// ─── TVDB v4 ──────────────────────────────────────────────────────────────────
const TVDB_BASE    = 'https://api4.thetvdb.com/v4';
const TVDB_API_KEY = process.env.TVDB_API_KEY || '6d08b945-5747-42df-89c2-8892a5059f68';

let _tvdbToken    = null;
let _tvdbTokenExp = 0;

async function tvdbToken() {
  if (_tvdbToken && Date.now() < _tvdbTokenExp) return _tvdbToken;
  const r = await ax.post(`${TVDB_BASE}/login`, { apikey: TVDB_API_KEY });
  _tvdbToken    = r.data.data.token;
  _tvdbTokenExp = Date.now() + 23 * 60 * 60 * 1000; // 23-hour TTL (token valid 24h)
  return _tvdbToken;
}

async function tvdbGet(path, params) {
  const token = await tvdbToken();
  const r = await ax.get(`${TVDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: params || {},
  });
  return r.data.data;
}

function tvdbConfigured() { return !!(TVDB_API_KEY && TVDB_API_KEY !== 'your_tvdb_key_here'); }

// ─── TVDB: full episode metadata ──────────────────────────────────────────────
async function fetchTVMetadataTVDB(showName, seasonNum, episodeNum, tvdbId, seriesYear) {
  if (!tvdbConfigured()) return null;
  try {
    // 1. Resolve series ID
    let seriesId = tvdbId ? parseInt(tvdbId) : null;
    if (!seriesId) {
      const results = await tvdbGet('/search', { query: showName, type: 'series' });
      if (!results?.length) return null;
      // If we have a year, try to match it — avoids picking the wrong show
      // e.g. "Brother's Keeper II" instead of "Brother's Keeper (1998)"
      let best = results[0];
      if (seriesYear) {
        const yearMatch = results.find(r => {
          const y = r.first_air_time ? parseInt(r.first_air_time.split('-')[0]) : null;
          return y === seriesYear;
        });
        if (yearMatch) best = yearMatch;
      }
      seriesId = best.tvdb_id || best.id;
      if (!seriesId) return null;
    }

    // 2. Series extended (genres, ratings, cast, first aired)
    const seriesExt = await tvdbGet(`/series/${seriesId}/extended`, { meta: 'translations', short: false });

    const genres = (seriesExt.genres || []).map(g => g.name).filter(Boolean);
    const usRating = (seriesExt.contentRatings || []).find(r => r.country === 'usa')?.name || null;
    const seriesCast = (seriesExt.characters || [])
      .filter(c => c.type === 1 || c.type === 3)
      .sort((a, b) => (a.sort || 99) - (b.sort || 99))
      .slice(0, 8).map(c => c.personName).filter(Boolean).join(', ') || null;
    const firstAired  = seriesExt.firstAired || null;
    const seriesYear  = firstAired ? parseInt(firstAired.split('-')[0]) : null;
    const posterUrl   = seriesExt.image || null;
    const seriesOverview = seriesExt.translations?.overviewTranslations?.find(t => t.language === 'eng')?.overview
      || seriesExt.overview || null;

    // 3. Specific episode
    let epTitle = null, epOverview = null, epAirdate = null, epRuntime = null;
    let epRating = null, epDirector = null, epCast = null;
    let epNumber = episodeNum, epSeason = seasonNum;

    if (seasonNum != null && episodeNum != null) {
      try {
        const epSearch = await tvdbGet(`/series/${seriesId}/episodes/default`, {
          season: seasonNum, episodeNumber: episodeNum,
        });
        const ep = epSearch?.episodes?.[0];
        if (ep) {
          epTitle   = ep.name     || null;
          epOverview = ep.overview || null;
          epAirdate = ep.aired    || null;
          epRuntime = ep.runtime  || null;
          epNumber  = ep.number   || episodeNum;
          epSeason  = ep.seasonNumber || seasonNum;

          // Episode extended — directors, guest stars, better overview
          try {
            const epExt = await tvdbGet(`/episodes/${ep.id}/extended`, { meta: 'translations' });
            epDirector = (epExt.characters || [])
              .filter(c => c.type === 2).map(c => c.personName).filter(Boolean).join(', ') || null;
            epCast = (epExt.characters || [])
              .filter(c => c.type === 1 || c.type === 3)
              .sort((a, b) => (a.sort || 99) - (b.sort || 99))
              .slice(0, 8).map(c => c.personName).filter(Boolean).join(', ') || null;
            epRating = (epExt.contentRatings || []).find(r => r.country === 'usa')?.name || null;
            epOverview = epExt.translations?.overviewTranslations?.find(t => t.language === 'eng')?.overview
              || epExt.overview || epOverview;
          } catch (_) { /* episode extended is optional */ }
        }
      } catch (_) { /* episode lookup is optional */ }
    }

    return {
      show_name:        seriesExt.name,
      title:            epTitle || (seasonNum != null && episodeNum != null
                          ? `${seriesExt.name} S${String(seasonNum).padStart(2,'0')}E${String(episodeNum).padStart(2,'0')}`
                          : seriesExt.name),
      synopsis:         epOverview || seriesOverview,
      year:             seriesYear,
      release_date:     firstAired,
      runtime:          epRuntime,
      genre:            genres,
      rating:           epRating || usRating,
      director:         epDirector,
      cast:             epCast || seriesCast,
      airdate:          epAirdate,
      season_number:    epSeason,
      episode_number:   epNumber,
      poster_url:       posterUrl,
      tvdb_id:          String(seriesId),
      media_type:       'tv_show',
      metadata_fetched: true,
    };
  } catch (err) {
    console.error('TVDB fetch error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

// ─── TMDB TV fallback ─────────────────────────────────────────────────────────
async function fetchTVMetadataTMDB(showName, season, episode, tmdbId) {
  if (!tmdbConfigured()) return null;
  try {
    let showId = tmdbId;
    if (!showId) {
      const r = await ax.get(`${TMDB_BASE}/search/tv`,
        withAuth({ params: { query: showName, language: 'en-US' } }));
      const results = r.data.results || [];
      if (!results.length) {
        // Try with 'the' stripped from beginning
        const stripped = showName.replace(/^the\s+/i, '');
        if (stripped !== showName) {
          const r2 = await ax.get(`${TMDB_BASE}/search/tv`,
            withAuth({ params: { query: stripped, language: 'en-US' } }));
          if ((r2.data.results||[]).length) {
            showId = r2.data.results[0].id;
          }
        }
        if (!showId) return null;
      } else {
        showId = results[0].id;
      }
    }
    const sr = await ax.get(`${TMDB_BASE}/tv/${showId}`,
      withAuth({ params: { language: 'en-US', append_to_response: 'credits' } }));
    const show = sr.data;
    const { cast } = extractCredits(show.credits);
    let epData = {};
    if (season != null && episode != null) {
      try {
        const er = await ax.get(`${TMDB_BASE}/tv/${showId}/season/${season}/episode/${episode}`,
          withAuth({ params: { language: 'en-US', append_to_response: 'credits' } }));
        const epCreds = extractCredits(er.data.credits);
        epData = { title: er.data.name, synopsis: er.data.overview, airdate: er.data.air_date,
                   runtime: er.data.runtime || null, director: epCreds.director, cast: epCreds.cast };
      } catch(_) {}
    }
    return {
      show_name:        show.name,
      title:            epData.title || `${show.name} S${String(season||1).padStart(2,'0')}E${String(episode||1).padStart(2,'0')}`,
      synopsis:         epData.synopsis || show.overview || null,
      year:             show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : null,
      release_date:     show.first_air_date || null,
      runtime:          epData.runtime || null,
      genre:            mapGenres(show.genres),
      rating:           null,
      director:         epData.director || null,
      cast:             epData.cast || cast,
      airdate:          epData.airdate || null,
      poster_url:       show.poster_path   ? `${TMDB_IMG}${show.poster_path}`   : null,
      backdrop_url:     show.backdrop_path ? `${TMDB_IMG}${show.backdrop_path}` : null,
      tmdb_id:          String(show.id),
      media_type:       'tv_show',
      metadata_fetched: true,
    };
  } catch(err) { console.error('TMDB TV error:', err.message); return null; }
}

// ─── TV: TVDB first, TMDB fallback ───────────────────────────────────────────
async function fetchTVMetadata(showName, season, episode, tmdbId, tvdbId, seriesYear) {
  if (tvdbConfigured()) {
    const data = await fetchTVMetadataTVDB(showName, season, episode, tvdbId || null, seriesYear || null);
    if (data) return data;
  }
  return fetchTVMetadataTMDB(showName, season, episode, tmdbId || null);
}

// ─── TMDB movie ───────────────────────────────────────────────────────────────
async function fetchMovieMetadata(title, year, tmdbId) {
  if (!tmdbConfigured()) return null;
  try {
    let movieId = tmdbId;
    if (!movieId) {
      // Search with year first, then without if no results
      let results = [];
      if (year) {
        const r = await ax.get(`${TMDB_BASE}/search/movie`,
          withAuth({ params: { query: title, year, language: 'en-US', include_adult: false } }));
        results = r.data.results || [];
      }
      // If no results with year, try without year (handles year-off-by-one issues)
      if (!results.length) {
        const r2 = await ax.get(`${TMDB_BASE}/search/movie`,
          withAuth({ params: { query: title, language: 'en-US', include_adult: false } }));
        results = r2.data.results || [];
      }
      if (!results.length) return null;
      const best = year
        ? results.find(x => x.release_date?.startsWith(String(year)))
          || results.find(x => x.release_date?.startsWith(String(year - 1)))
          || results.find(x => x.release_date?.startsWith(String(year + 1)))
          || results[0]
        : results[0];
      movieId = best.id;
    }
    const dr = await ax.get(`${TMDB_BASE}/movie/${movieId}`,
      withAuth({ params: { language: 'en-US', append_to_response: 'credits,release_dates' } }));
    const d = dr.data;
    const { director, cast } = extractCredits(d.credits);
    return {
      title:            d.title,
      synopsis:         d.overview||null,
      tagline:          d.tagline||null,
      year:             d.release_date ? parseInt(d.release_date.split('-')[0]) : (year||null),
      release_date:     d.release_date||null,
      runtime:          d.runtime||null,
      genre:            mapGenres(d.genres),
      rating:           extractRating(d.release_dates),
      director,
      cast,
      poster_url:       d.poster_path   ? `${TMDB_IMG}${d.poster_path}`   : null,
      backdrop_url:     d.backdrop_path ? `${TMDB_IMG}${d.backdrop_path}` : null,
      tmdb_id:          String(d.id),
      imdb_id:          d.imdb_id||null,
      media_type:       'movie',
      metadata_fetched: true,
    };
  } catch(err) {
    console.error('TMDB movie fetch error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/fetch/:id', async (req, res) => {
  try {
    const media = db.get('media').find({ id: req.params.id }).value();
    if (!media) {
      // Debug: show what IDs exist to help diagnose mismatches
      const allIds = db.get('media').value().map(m => m.id).slice(0, 5);
      console.error(`[metadata] fetch/:id not found: ${req.params.id}. Sample IDs: ${allIds.join(', ')}`);
      return res.status(404).json({ error: `Media not found: ${req.params.id}` });
    }

    let data = null;
    const year = media.year ? parseInt(media.year) : null;

    if (media.media_type === 'music_video') {
      // Auto-fetch from IMVDb using artist + title
      const artist = media.artist_name || media.title;
      const title  = media.artist_name ? media.title : null;
      if (artist) {
        try {
          const q = title ? `${artist} ${title}` : artist;
          console.log(`[metadata] MV fetch: "${q}"`);
          const sr = await ax.get('https://imvdb.com/api/v1/search/videos', {
            params: { q }, headers: { 'IMVDB-APP-KEY': IMVDB_KEY },
          });
          const results = sr.data.results || [];
          // Find best match by artist + title
          const best = results.find(v => {
            const va = (v.artists?.[0]?.name||'').toLowerCase();
            const vt = (v.song_title||'').toLowerCase();
            return va.includes(artist.toLowerCase()) || artist.toLowerCase().includes(va);
          }) || results[0];
          if (best) {
            const slug = best.url?.replace(/^https?:\/\/imvdb\.com\/video\//, '') || '';
            if (slug) {
              const vr = await ax.get(`https://imvdb.com/api/v1/video/${slug}`, {
                params: { include: 'credits' }, headers: { 'IMVDB-APP-KEY': IMVDB_KEY },
              });
              const v = vr.data;
              const directors = (v.credits||[]).filter(c=>c.credit_type==='Director').map(c=>c.entity_name).join(', ')||null;
              data = {
                song_title:   v.song_title,
                title:        v.song_title,
                artist_name:  v.artists?.map(a=>a.name).join(', ') || media.artist_name,
                year:         v.year || media.year,
                directors,
                poster_url:   v.image?.o || v.image?.l || media.poster_url || null,
                imvdb_id:     slug,
                media_type:   'music_video',
                metadata_fetched: true,
              };
            }
          }
        } catch(mvErr) { console.error('[imvdb auto-fetch]', mvErr.message); }
      }
    } else if (media.media_type === 'tv_show') {
      const showName = media.show_name || media.title;
      const season   = media.season_number ?? media.season ?? null;
      const episode  = media.episode_number ?? media.episode ?? null;
      const seriesYear = media.year ? parseInt(media.year) : null;
      console.log(`[metadata] TV fetch: "${showName}" S${season}E${episode} year=${seriesYear||'?'} (tvdb:${media.tvdb_id||'?'} tmdb:${media.tmdb_id||'?'})`);
      data = await fetchTVMetadata(showName, season != null ? parseInt(season) : null,
        episode != null ? parseInt(episode) : null, media.tmdb_id || null, media.tvdb_id || null, seriesYear);
    } else {
      // Try as movie first
      console.log(`[metadata] Movie fetch: "${media.title}" (${year||'?'}) (tmdb:${media.tmdb_id||'?'})`);
      data = await fetchMovieMetadata(media.title, year, media.tmdb_id || null);

      // If no result and year is off, retry without year constraint
      if (!data && year) {
        console.log(`[metadata] Retrying without year: "${media.title}"`);
        data = await fetchMovieMetadata(media.title, null, null);
      }

      // Fall back to TV search if movie not found
      if (!data && media.show_name) {
        console.log(`[metadata] Falling back to TV search: "${media.show_name}"`);
        data = await fetchTVMetadata(media.show_name,
          media.season_number ?? media.season ?? null,
          media.episode_number ?? media.episode ?? null,
          null, media.tvdb_id || null);
      }
    }

    if (!data) return res.status(404).json({ error: 'No metadata found', id: req.params.id });
    const updated = { ...media, ...data, updated_date: new Date().toISOString() };
    db.get('media').find({ id: req.params.id }).assign(updated).write();
    res.json(updated);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/fetch-all', async (req, res) => {
  try {
    const unfetched = db.get('media').filter(m => !m.metadata_fetched && !m.is_filler).value();
    res.json({ queued: unfetched.length, message: 'Use POST /fetch/:id for individual items' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/metadata/search?q=...&type=movie|tv&year=...
router.get('/search', async (req, res) => {
  try {
    const { q, type = 'movie', year } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    if (type === 'tv' && tvdbConfigured()) {
      const results = await tvdbGet('/search', { query: q, type: 'series' });
      return res.json((results || []).slice(0, 10).map(x => ({
        tvdb_id:    String(x.tvdb_id || x.id),
        title:      x.name,
        year:       x.first_air_time ? x.first_air_time.split('-')[0] : null,
        poster_url: x.image_url || x.thumbnail || null,
        synopsis:   x.overviews?.eng || x.overview || null,
        type:       'tv',
      })));
    }

    if (!tmdbConfigured()) return res.status(503).json({ error: 'No metadata source configured' });
    const endpoint = type === 'tv' ? '/search/tv' : '/search/movie';
    const r = await ax.get(`${TMDB_BASE}${endpoint}`,
      withAuth({ params: { query: q, year: year||undefined, language: 'en-US' } }));
    res.json((r.data.results||[]).slice(0,10).map(x => ({
      tmdb_id:    String(x.id),
      title:      x.title || x.name,
      year:       (x.release_date || x.first_air_date || '').split('-')[0],
      poster_url: x.poster_path ? `${TMDB_IMG}${x.poster_path}` : null,
      synopsis:   x.overview,
      type,
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/metadata/tmdb/movie/:tmdbId
router.get('/tmdb/movie/:tmdbId', async (req, res) => {
  try {
    if (!tmdbConfigured()) return res.status(503).json({ error: 'TMDB not configured' });
    const data = await fetchMovieMetadata(null, null, req.params.tmdbId);
    if (!data) return res.status(404).json({ error: 'Not found on TMDB' });
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/metadata/tmdb/tv/:tmdbId
router.get('/tmdb/tv/:tmdbId', async (req, res) => {
  try {
    if (!tmdbConfigured()) return res.status(503).json({ error: 'TMDB not configured' });
    const { season, episode } = req.query;
    const data = await fetchTVMetadataTMDB(null, season ? parseInt(season) : null, episode ? parseInt(episode) : null, req.params.tmdbId);
    if (!data) return res.status(404).json({ error: 'Not found on TMDB' });
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/metadata/tvdb/series/:tvdbId?season=N&episode=N
router.get('/tvdb/series/:tvdbId', async (req, res) => {
  try {
    if (!tvdbConfigured()) return res.status(503).json({ error: 'TVDB not configured' });
    const { season, episode } = req.query;
    const data = await fetchTVMetadataTVDB(null,
      season  ? parseInt(season)  : null,
      episode ? parseInt(episode) : null,
      req.params.tvdbId);
    if (!data) return res.status(404).json({ error: 'Not found on TVDB' });
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/metadata/tvdb/fetch-series/:tvdbId
// Fetches ALL episodes for a series from TVDB and updates every matching DB record.
// The client calls this when user enters a TVDB ID in TVShowEditorDialog.
router.post('/tvdb/fetch-series/:tvdbId', async (req, res) => {
  try {
    if (!tvdbConfigured()) return res.status(503).json({ error: 'TVDB not configured' });
    const tvdbId = req.params.tvdbId;
    const { show_name } = req.body; // optional hint for which episodes to update

    // 1. Fetch series info
    const seriesId = parseInt(tvdbId);
    const seriesExt = await tvdbGet(`/series/${seriesId}/extended`, { meta: 'translations', short: false });
    const genres    = (seriesExt.genres || []).map(g => g.name).filter(Boolean);
    const usRating  = (seriesExt.contentRatings || []).find(r => r.country === 'usa')?.name || null;
    const seriesCast = (seriesExt.characters || [])
      .filter(c => c.type === 1 || c.type === 3)
      .sort((a, b) => (a.sort || 99) - (b.sort || 99))
      .slice(0, 8).map(c => c.personName).filter(Boolean).join(', ') || null;
    const firstAired = seriesExt.firstAired || null;
    const seriesYear = firstAired ? parseInt(firstAired.split('-')[0]) : null;
    const posterUrl  = seriesExt.image || null;
    const seriesOverview = seriesExt.translations?.overviewTranslations
      ?.find(t => t.language === 'eng')?.overview || seriesExt.overview || null;
    const showNameFromTVDB = seriesExt.name;

    // 2. Fetch all episodes (paginated — TVDB returns 500 per page)
    let allEpisodes = [];
    let page = 0;
    while (true) {
      const epPage = await tvdbGet(`/series/${seriesId}/episodes/default`, { page });
      const eps = epPage?.episodes || [];
      allEpisodes = allEpisodes.concat(eps);
      if (eps.length < 500) break;
      page++;
      if (page > 20) break; // safety cap
    }

    // 3. Find all DB records for this show
    const targetName = show_name || showNameFromTVDB;
    const dbEpisodes = db.get('media').value().filter(m =>
      m.media_type === 'tv_show' && !m.is_filler &&
      (m.show_name === targetName ||
       m.show_name === show_name ||
       m.tvdb_id === String(seriesId))
    );

    let updated = 0, notFound = 0;
    for (const dbEp of dbEpisodes) {
      const sNum = dbEp.season_number ?? dbEp.season ?? null;
      const eNum = dbEp.episode_number ?? dbEp.episode ?? null;
      if (sNum == null || eNum == null) { notFound++; continue; }

      // Find matching TVDB episode
      const tvdbEp = allEpisodes.find(e =>
        e.seasonNumber === sNum && e.number === eNum
      );

      const patch = {
        show_name:        showNameFromTVDB,
        tvdb_id:          String(seriesId),
        year:             seriesYear,
        release_date:     firstAired,
        genre:            genres,
        rating:           usRating,
        cast:             seriesCast,
        poster_url:       posterUrl,
        synopsis:         seriesOverview,
        metadata_fetched: true,
        updated_date:     new Date().toISOString(),
      };

      if (tvdbEp) {
        if (tvdbEp.name)    patch.title    = tvdbEp.name;
        if (tvdbEp.overview) patch.synopsis = tvdbEp.overview;
        if (tvdbEp.aired)   patch.airdate  = tvdbEp.aired;
        if (tvdbEp.runtime) patch.runtime  = tvdbEp.runtime;
      }

      db.get('media').find({ id: dbEp.id }).assign(patch).write();
      updated++;
    }

    console.log(`[tvdb/fetch-series] ${showNameFromTVDB}: ${updated} episodes updated, ${notFound} skipped`);
    res.json({
      show_name:    showNameFromTVDB,
      tvdb_id:      String(seriesId),
      year:         seriesYear,
      poster_url:   posterUrl,
      genres,
      rating:       usRating,
      cast:         seriesCast,
      synopsis:     seriesOverview,
      total_tvdb_episodes: allEpisodes.length,
      db_episodes_updated: updated,
      db_episodes_skipped: notFound,
    });
  } catch(err) {
    console.error('[tvdb/fetch-series] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── IMVDb routes ─────────────────────────────────────────────────────────────
const IMVDB_KEY = process.env.IMVDB_API_KEY || 'j4CaT3QMN7Hy9jzFgwHMGI6ZEftg1w4hxeOTZ3Rb';

// GET /api/metadata/imvdb/search?q=...
router.get('/imvdb/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const r = await ax.get('https://imvdb.com/api/v1/search/videos', {
      params: { q },
      headers: { 'IMVDB-APP-KEY': IMVDB_KEY },
    });
    const results = (r.data.results || []).slice(0, 10).map(v => ({
      song_title:  v.song_title,
      artist_name: v.artists?.map(a => a.name).join(', ') || '',
      year:        v.year,
      image_url:   v.image?.o || v.image?.l || null,
      url:         v.url,
      imvdb_id:    v.url ? v.url.replace('https://imvdb.com/video/', '') : null,
    }));
    res.json({ results });
  } catch(err) {
    console.error('[imvdb/search]', err.response?.status, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metadata/imvdb/video?url=...
router.get('/imvdb/video', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    // Derive slug: https://imvdb.com/video/the-b-52s-1/love-shack -> the-b-52s-1/love-shack
    const slug = url.replace(/^https?:\/\/imvdb\.com\/video\//, '');
    const r = await ax.get(`https://imvdb.com/api/v1/video/${slug}`, {
      params: { include: 'sources,bts,featured_artists,credits' },
      headers: { 'IMVDB-APP-KEY': IMVDB_KEY },
    });
    const v = r.data;
    const directors = (v.credits || [])
      .filter(c => c.credit_type === 'Director')
      .map(c => c.entity_name).join(', ') || null;
    const label = (v.credits || [])
      .filter(c => c.credit_type === 'Production Company')
      .map(c => c.entity_name)[0] || null;
    res.json({
      song_title:   v.song_title,
      artist_name:  v.artists?.map(a => a.name).join(', ') || '',
      year:         v.year,
      directors,
      record_label: label,
      image_url:    v.image?.o || v.image?.l || null,
      imvdb_id:     slug,
    });
  } catch(err) {
    console.error('[imvdb/video]', err.response?.status, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metadata/status
router.get('/status', (req, res) => {
  res.json({
    tmdb_configured: tmdbConfigured(),
    tvdb_configured: tvdbConfigured(),
    tmdb_auth_type:  (process.env.TMDB_READ_TOKEN && process.env.TMDB_READ_TOKEN !== 'your_tmdb_token_here')
      ? 'bearer_token' : 'api_key',
  });
});

module.exports = router;
