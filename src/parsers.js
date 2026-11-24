const cheerio = require('cheerio');
const { BASE, } = require('./config');
const { clean, abs, unNextImage, compact, pick, toNum, walk } = require('./utils/helpers');
const { MEDIA_RE } = require('./browser');

const TITLE_K = ['title', 'name', 'judul', 'nama', 'anime_title', 'animeName'];
const IMG_K = ['poster', 'image', 'cover', 'thumbnail', 'thumb', 'img', 'gambar', 'poster_url', 'image_url', 'cover_url', 'posterUrl'];
const SYN_K = ['synopsis', 'sinopsis', 'description', 'deskripsi', 'overview', 'sinopsis_anime'];
const NUM_K = ['episode', 'eps', 'ep', 'number', 'no', 'episode_number', 'episodeNumber', 'nomor', 'urutan', 'index'];
const BAD_PATH = /recommend|related|similar|popular|populer|rekomendasi|trending|latest|terbaru|schedule|jadwal/i;

const idOf = (o) => { const v = pick(o, ['id', 'anime_id', 'animeId', 'mal_id', 'slug']); return v === null ? null : String(v); };

// ---------- ANIME CARD ----------
const looksAnime = (o) => o && typeof o === 'object' && !Array.isArray(o) && idOf(o) && pick(o, TITLE_K);

function normalizeAnime(o) {
  const id = idOf(o);
  const genres = Array.isArray(o.genres || o.genre)
    ? (o.genres || o.genre).map((g) => (typeof g === 'string' ? g : pick(g, ['name', 'title', 'nama']))).filter(Boolean) : undefined;
  return compact({
    id,
    title: clean(pick(o, TITLE_K)),
    poster: unNextImage(pick(o, IMG_K)),
    type: pick(o, ['type', 'tipe', 'format']),
    status: pick(o, ['status']),
    score: toNum(pick(o, ['score', 'rating', 'skor'])),
    year: toNum(pick(o, ['year', 'tahun', 'release_year'])),
    totalEpisodes: toNum(pick(o, ['total_episodes', 'totalEpisodes', 'episodes_count', 'episode_count', 'jumlah_episode'])),
    genres,
    url: /^\d+$/.test(id) ? `${BASE}/anime/${id}` : undefined,
  });
}

function findAnimeList(payloads) {
  let best = [];
  for (const { data } of payloads) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      if (BAD_PATH.test(path.join('/'))) return;
      const ok = node.filter(looksAnime);
      if (ok.length >= Math.max(1, node.length * 0.8) && ok.length > best.length) best = ok;
    });
  }
  return best.map(normalizeAnime);
}

function domAnimeCards(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/anime/"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/anime\/(\d+)/);
    if (!m || seen.has(m[1])) return;
    const img = $(a).find('img').first();
    const title = clean(img.attr('alt') || $(a).attr('title') || $(a).find('h1,h2,h3,h4,p,span').first().text() || $(a).text());
    const src = img.attr('src') || img.attr('data-src');
    seen.set(m[1], compact({ id: m[1], title, poster: unNextImage(src), url: `${BASE}/anime/${m[1]}` }));
  });
  return [...seen.values()].filter((x) => x.title);
}

function parseSearch(page) {
  const fromJson = findAnimeList(page.json);
  const items = fromJson.length ? fromJson : domAnimeCards(page.html);
  return { source: fromJson.length ? 'json' : 'dom', items };
}


// ---------- HOME ----------
const prettyName = (s) => String(s).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function parseHome(page) {
  const sections = [];
  const seen = new Set();
  for (const { url, data } of page.json) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      const ok = node.filter(looksAnime);
      if (!ok.length || ok.length < node.length * 0.8) return;
      const sig = ok.map(idOf).join(',');
      if (seen.has(sig)) return;
      seen.add(sig);
      const key = [...path].reverse().find((k) => typeof k === 'string' && !/^(data|result|results|items|list|props|pageProps)$/i.test(k));
      let name = key ? prettyName(key) : prettyName((new URL(url).pathname.split('/').filter(Boolean).pop()) || 'Anime');
      sections.push({ name, total: ok.length, items: ok.map(normalizeAnime) });
    });
  }
  if (sections.length) return { source: 'json', sections };
  const items = domAnimeCards(page.html);
  return { source: 'dom', sections: items.length ? [{ name: 'Anime', total: items.length, items }] : [] };
}

// ---------- DETAIL ----------
function findDetailObject(payloads, id) {
  let found = null;
  for (const { data } of payloads) {
    walk(data, (node) => {
      if (found || !looksAnime(node)) return;
      if (idOf(node) === String(id)) found = node;
    });
    if (found) break;
  }
  return found;
}

// ---------- EPISODE (dipilih dengan skor supaya tidak tertukar dgn rekomendasi) ----------
const epLike = (o) => o && typeof o === 'object' && !Array.isArray(o)
  && (pick(o, NUM_K) !== null || /\b(ep(isode)?|eps)\s*\.?\s*\d+/i.test(String(pick(o, TITLE_K) || '')));

function findEpisodeArray(payloads) {
  let best = null; let bestScore = 0;
  for (const { data } of payloads) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      const p = path.join('/');
      if (BAD_PATH.test(p)) return;
      const ratio = node.filter(epLike).length / node.length;
      if (ratio < 0.8) return;
      // daftar kartu anime lain (punya id+poster+judul tanpa nomor episode) bukan episode
      if (node.every((x) => looksAnime(x) && pick(x, IMG_K) && pick(x, NUM_K) === null)) return;
      let score = ratio * 10 + Math.log(node.length + 1);
      if (/episode|eps|chapter/i.test(String(path[path.length - 1] || ''))) score += 6;
      if (/episode|eps/i.test(p)) score += 2;
      if (score > bestScore) { best = node; bestScore = score; }
    });
  }
  return best;
}

const MEDIA_IN_TEXT = /https?:\\?\/\\?\/[^"'\s\\<>]+?\.(?:m3u8|mp4|mpd)(?:\?[^"'\s\\<>]*)?/gi;
const findMediaInText = (s) => [...new Set((String(s).match(MEDIA_IN_TEXT) || []).map((u) => u.replace(/\\\//g, '/')))];

function normalizeEpisode(o, animeId) {
  const title = clean(pick(o, TITLE_K));
  const number = toNum(pick(o, NUM_K)) ?? toNum((title || '').match(/\d+(\.\d+)?/)?.[0]);
  const link = pick(o, ['url', 'link', 'href', 'path', 'slug_url', 'watch_url']);
  const epId = pick(o, ['id', 'episode_id', 'episodeId', 'slug']);
  const direct = findMediaInText(JSON.stringify(o));
  return compact({
    number,
    title,
    id: epId === null ? undefined : String(epId),
    thumbnail: unNextImage(pick(o, IMG_K)),
    date: pick(o, ['date', 'released_at', 'release_date', 'created_at', 'tanggal', 'updated_at']),
    pageUrl: link ? abs(link) : undefined,
    _direct: direct,
    _animeId: animeId,
  });
}

function domEpisodes(html, animeId) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/(episode|eps|watch|nonton|play)/i.test(href)) return;
    if (/\/anime\/\d+\/?$/.test(href)) return;
    const u = abs(href);
    if (!u || seen.has(u)) return;
    const txt = clean($(a).text());
    const num = toNum((txt.match(/(?:ep(?:isode)?|eps)\s*\.?\s*(\d+(\.\d+)?)/i) || href.match(/(?:episode|eps|ep)[-_/=]?(\d+(\.\d+)?)/i) || [])[1]);
    if (num === null) return;
    seen.set(u, compact({ number: num, title: txt || `Episode ${num}`, pageUrl: u, _animeId: animeId }));
  });
  return [...seen.values()];
}

function parseDetail(page, id) {
  const $ = cheerio.load(page.html);
  const obj = findDetailObject(page.json, id);
  const base = obj ? normalizeAnime(obj) : {};

  let rawEps = findEpisodeArray(page.json);
  let source = 'json';
  let episodes;
  if (rawEps) episodes = rawEps.map((e) => normalizeEpisode(e, id));
  else { episodes = domEpisodes(page.html, id); source = 'dom'; }

  // dedupe + urut
  const uniq = new Map();
  for (const e of episodes) uniq.set(e.number ?? e.id ?? e.pageUrl, e);
  episodes = [...uniq.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const meta = compact({
    id: String(id),
    title: base.title || clean($('meta[property="og:title"]').attr('content') || $('h1').first().text()),
    synopsis: clean(pick(obj, SYN_K) || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content')),
    poster: base.poster || unNextImage($('meta[property="og:image"]').attr('content')),
    type: base.type, status: base.status, score: base.score, year: base.year, genres: base.genres,
    totalEpisodes: base.totalEpisodes || episodes.length || undefined,
    url: `${BASE}/anime/${id}`,
  });
  return { meta, episodes, source };
}

// ---------- STREAM ----------
const rank = (u) => (/\.m3u8/i.test(u) ? 0 : /\.mp4/i.test(u) ? 1 : 2);
const typeOf = (u) => (/\.m3u8/i.test(u) ? 'hls' : /\.mpd/i.test(u) ? 'dash' : 'mp4');

function extractStreams(page) {
  const urls = new Set(page.media.filter((u) => MEDIA_RE.test(u)));
  for (const j of page.json) findMediaInText(JSON.stringify(j.data)).forEach((u) => urls.add(u));
  findMediaInText(page.html).forEach((u) => urls.add(u));
  const streams = [...urls].sort((a, b) => rank(a) - rank(b)).map((url) => ({ type: typeOf(url), url }));
  const embeds = [...new Set(page.iframes.filter((u) => !/^about:|recaptcha|turnstile|challenge/i.test(u)))];
  return { streams, embeds };
}

module.exports = { parseHome, parseSearch, parseDetail, extractStreams, findMediaInText };
