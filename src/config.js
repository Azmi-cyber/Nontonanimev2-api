try { require('dotenv').config(); } catch (_) {}

const parseProxy = (raw) => {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      raw,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch { return null; }
};

const list = [process.env.PROXY_URL, ...(process.env.PROXY_LIST || '').split(',')]
  .map((s) => (s || '').trim()).filter(Boolean);

module.exports = {
  BASE: (process.env.BASE_URL || 'https://animeinweb.com').replace(/\/$/, ''),
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  SECRET: process.env.PROXY_SECRET || 'change-me',
  API_KEY: process.env.API_KEY || '',
  DEBUG: process.env.DEBUG_ENDPOINT === '1',
  CACHE_TTL: Number(process.env.CACHE_TTL_SECONDS || 300) * 1000,
  CHROME_PATH: process.env.CHROME_PATH || '',
  proxies: list,
  browserProxy: parseProxy(process.env.PROXY_URL || list[0]),
  randomProxy: () => (list.length ? list[Math.floor(Math.random() * list.length)] : null),
};
