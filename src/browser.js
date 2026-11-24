const cfg = require('./config');

let browserPromise = null;
let active = 0;
const queue = [];
const MAX_PAGES = 2;

const acquire = () => new Promise((res) => { if (active < MAX_PAGES) { active++; res(); } else queue.push(res); });
const release = () => { const n = queue.shift(); if (n) n(); else active--; };

async function launch() {
  const pptr = require('puppeteer-core');

  let executablePath = cfg.CHROME_PATH;
  let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--lang=id-ID'];
  let headless = 'new';

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = require('@sparticuz/chromium');
    executablePath = await chromium.executablePath();
    args = [...chromium.args, '--lang=id-ID'];
    headless = chromium.headless;
  } else if (!executablePath) {
    try { executablePath = require('puppeteer').executablePath(); }
    catch { throw new Error('Chrome tidak ditemukan. Install "puppeteer" atau set CHROME_PATH.'); }
  }

  const p = cfg.browserProxy;
  if (p) args.push(`--proxy-server=${p.protocol}://${p.host}:${p.port}`);

  return pptr.launch({ executablePath, args, headless, defaultViewport: { width: 1366, height: 768 } });
}

async function getBrowser() {
  if (browserPromise) {
    try { const b = await browserPromise; if (b.connected ?? b.isConnected()) return b; } catch {}
    browserPromise = null;
  }
  browserPromise = launch();
  return browserPromise;
}


// Patch anti-deteksi manual (pengganti puppeteer-extra-plugin-stealth, aman untuk bundler serverless)
const STEALTH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  window.chrome = window.chrome || { runtime: {}, loadTimes() {}, csi() {}, app: {} };
  const q = window.navigator.permissions && window.navigator.permissions.query;
  if (q) window.navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(window.navigator.permissions, p));
  const patchGL = (proto) => {
    const g = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return g.call(this, p);
    };
  };
  try { patchGL(WebGLRenderingContext.prototype); patchGL(WebGL2RenderingContext.prototype); } catch (_) {}
};

const MEDIA_RE = /\.(m3u8|mp4|mpd|webm)(\?|#|$)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Buka halaman dengan Chromium stealth + proxy, tembus challenge Cloudflare,
 * lalu kembalikan HTML, semua respons JSON (XHR/fetch), URL media & iframe.
 */
async function fetchPage(url, { timeout = 30000, tryPlay = false } = {}) {
  await acquire();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    const out = { url, finalUrl: url, html: '', json: [], media: [], iframes: [] };

    const p = cfg.browserProxy;
    if (p && p.username) await page.authenticate({ username: p.username, password: p.password });
    await page.evaluateOnNewDocument(STEALTH);
    await page.setUserAgent(cfg.UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType(); const u = req.url();
      if (MEDIA_RE.test(u)) out.media.push(u);
      if (t === 'image' || t === 'font' || t === 'media') return req.abort().catch(() => {});
      req.continue().catch(() => {});
    });
    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        out.json.push({ url: res.url(), data: await res.json() });
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Tunggu challenge Cloudflare selesai (maks ~25 dtk)
    for (let i = 0; i < 25; i++) {
      const title = (await page.title().catch(() => '')) || '';
      const html = await page.content().catch(() => '');
      const blocked = /just a moment|attention required|checking your browser/i.test(title) || /cf-challenge|challenge-platform|cf-turnstile/i.test(html);
      if (!blocked) break;
      await sleep(1000);
    }

    await page.waitForNetworkIdle({ idleTime: 900, timeout: 12000 }).catch(() => {});

    if (tryPlay) {
      await page.evaluate(() => {
        const el = document.querySelector('video') || document.querySelector('[class*="play" i], button[aria-label*="play" i]');
        if (el) { try { el.click(); el.play && el.play(); } catch (_) {} }
      }).catch(() => {});
      await sleep(2500);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
    }

    out.iframes = await page.$$eval('iframe[src]', (a) => a.map((x) => x.src)).catch(() => []);
    out.finalUrl = page.url();
    out.html = await page.content();
    return out;
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

module.exports = { fetchPage, MEDIA_RE };
