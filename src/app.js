const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cfg = require('./config');
const { fetchPage } = require('./browser');
const { parseHome, parseSearch, parseDetail, extractStreams } = require('./parsers');
const { handleProxy } = require('./proxyStream');
const docs = require('./docs');
const { proxyUrl, origin, compact, cache } = require('./utils/helpers');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.set('json spaces', 2); // JSON rapi (pretty print)
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const ok = (res, data, meta) => res.json({ success: true, data, ...(meta ? { meta } : {}) });
const fail = (res, code, msg) => res.status(code).json({ success: false, error: msg });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); fail(res, 502, e.message || 'Scraping gagal'); });

// API key (opsional)
const guard = (req, res, next) => {
  if (!cfg.API_KEY) return next();
  const k = req.get('x-api-key') || req.query.apikey;
  return k === cfg.API_KEY ? next() : fail(res, 401, 'API key tidak valid');
};

const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await fn();
  cache.set(key, v);
  return v;
};

const onlyTarget = (u) => { try { return new URL(u).origin === new URL(cfg.BASE).origin; } catch { return false; } };

app.get('/', (req, res) => res.type('html').send(docs(origin(req))));
app.get('/health', (_, res) => ok(res, { status: 'ok', proxy: !!cfg.browserProxy, time: new Date().toISOString() }));
app.get('/proxy', (req, res) => handleProxy(req, res, origin(req)));

// ---------- /home (scrape beranda animeinweb) ----------
app.get('/home', guard, wrap(async (req, res) => {
  const { sections, source } = await cached('h:' + cfg.BASE, async () => parseHome(await fetchPage(cfg.BASE + '/')));
  const out = sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, poster: proxyUrl(req, i.poster) })) }));
  ok(res, { total: out.length, sections: out }, { source });
}));

// ---------- /search ----------
app.get('/search', guard, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, 'Parameter q wajib diisi');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const url = `${cfg.BASE}/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;

  const { items, source } = await cached('s:' + url, async () => parseSearch(await fetchPage(url)));
  const results = items.map((i) => ({ ...i, poster: proxyUrl(req, i.poster) }));
  ok(res, { query: q, page, total: results.length, results }, { source });
}));

// ---------- /nonton ----------
async function resolveEpisode(pageUrl) {
  return cached('e:' + pageUrl, async () => {
    const pg = await fetchPage(pageUrl, { tryPlay: true });
    return extractStreams(pg);
  });
}

const wrapStreams = (req, streams, referer) => streams.map((s) => ({ type: s.type, url: proxyUrl(req, s.url, referer) }));

app.get('/nonton', guard, wrap(async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[\w-]+$/.test(id)) return fail(res, 400, 'Parameter id tidak valid');

  const url = `${cfg.BASE}/anime/${id}`;
  const detail = await cached('d:' + url, async () => parseDetail(await fetchPage(url), id));
  if (!detail.meta.title && !detail.episodes.length) return fail(res, 404, 'Anime tidak ditemukan / halaman gagal dimuat (kemungkinan terblokir)');

  const doResolve = req.query.resolve === '1' || req.query.resolve === 'true';
  const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 3));
  const wantEp = req.query.ep ? Number(req.query.ep) : null;
  const targets = new Set();
  if (doResolve) {
    const pool = wantEp !== null ? detail.episodes.filter((e) => e.number === wantEp) : detail.episodes.slice(0, limit);
    pool.forEach((e) => targets.add(e));
  }

  const episodes = [];
  for (const e of detail.episodes) {
    const { _direct, _animeId, ...rest } = e;
    const item = { ...rest };
    if (item.thumbnail) item.thumbnail = proxyUrl(req, item.thumbnail);
    if (item.pageUrl) item.resolveUrl = `${origin(req)}/episode?url=${encodeURIComponent(item.pageUrl)}${cfg.API_KEY ? '&apikey=' + encodeURIComponent(cfg.API_KEY) : ''}`;

    if (_direct && _direct.length) {
      item.streams = wrapStreams(req, _direct.map((u) => ({ type: /\.m3u8/i.test(u) ? 'hls' : 'mp4', url: u })));
    } else if (targets.has(e) && e.pageUrl) {
      try {
        const r = await resolveEpisode(e.pageUrl);
        item.streams = wrapStreams(req, r.streams, e.pageUrl);
        if (r.embeds.length) item.embeds = r.embeds;
      } catch (err) { item.streamError = err.message; }
    }
    episodes.push(compact(item));
  }

  const anime = { ...detail.meta, poster: proxyUrl(req, detail.meta.poster) };
  ok(res, { anime, totalEpisodes: episodes.length, episodes }, { source: detail.source });
}));

// ---------- /episode ----------
app.get('/episode', guard, wrap(async (req, res) => {
  const u = String(req.query.url || '');
  if (!onlyTarget(u)) return fail(res, 400, 'url harus berasal dari ' + cfg.BASE);
  const r = await resolveEpisode(u);
  ok(res, { pageUrl: u, streams: wrapStreams(req, r.streams, u), embeds: r.embeds });
}));

// ---------- /debug (matikan di produksi) ----------
app.get('/debug', guard, wrap(async (req, res) => {
  if (!cfg.DEBUG) return fail(res, 404, 'Not found');
  const u = String(req.query.url || cfg.BASE);
  if (!onlyTarget(u)) return fail(res, 400, 'url harus berasal dari ' + cfg.BASE);
  const pg = await fetchPage(u, { tryPlay: req.query.play === '1' });
  ok(res, {
    finalUrl: pg.finalUrl,
    htmlLength: pg.html.length,
    title: (pg.html.match(/<title>([^<]*)/i) || [])[1],
    json: pg.json.map((j) => ({ url: j.url, preview: JSON.stringify(j.data).slice(0, 400) })),
    media: pg.media, iframes: pg.iframes,
  });
}));

app.use((_, res) => fail(res, 404, 'Endpoint tidak ditemukan. Lihat /home'));

module.exports = app;
