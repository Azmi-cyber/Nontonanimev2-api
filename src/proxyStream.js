const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const cfg = require('./config');
const { verifyToken, signToken } = require('./utils/helpers');

const agentFor = (proxy) => {
  if (!proxy) return undefined;
  return /^socks/i.test(proxy) ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
};

const isM3u8 = (url, ct) => /mpegurl/i.test(ct || '') || /\.m3u8(\?|$)/i.test(url);

function rewriteM3u8(text, baseUrl, referer, selfBase) {
  const wrap = (u) => {
    try { return `${selfBase}/proxy?t=${signToken(new URL(u, baseUrl).href, referer)}`; } catch { return u; }
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(line.trim());
  }).join('\n');
}

async function handleProxy(req, res, selfBase) {
  const data = verifyToken(req.query.t);
  if (!data) return res.status(403).json({ success: false, error: 'Token proxy tidak valid' });

  const headers = {
    'User-Agent': cfg.UA,
    Referer: data.r,
    Origin: new URL(data.r).origin,
    Accept: req.headers.accept || '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const agent = agentFor(cfg.randomProxy());
  try {
    const up = await axios.get(data.u, {
      responseType: 'stream', headers, httpAgent: agent, httpsAgent: agent, proxy: false,
      maxRedirects: 5, validateStatus: () => true, timeout: 25000,
    });
    const ct = up.headers['content-type'] || '';
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');

    if (isM3u8(data.u, ct) && up.status < 400) {
      const chunks = [];
      for await (const c of up.data) chunks.push(c);
      const finalUrl = up.request?.res?.responseUrl || data.u;
      const body = rewriteM3u8(Buffer.concat(chunks).toString('utf8'), finalUrl, data.r, selfBase);
      res.status(200).set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store');
      return res.send(body);
    }

    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (up.headers[h]) res.set(h, up.headers[h]);
    }
    res.set('Cache-Control', /^image\//.test(ct) ? 'public, max-age=86400' : 'public, max-age=300');
    up.data.on('error', () => res.destroy());
    req.on('close', () => up.data.destroy());
    up.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, error: 'Gagal mengambil sumber: ' + e.message });
  }
}

module.exports = { handleProxy };
