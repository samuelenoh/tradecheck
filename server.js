'use strict';
/*
 * Trade check server. Zero dependencies, Node 18+.
 *
 *   node server.js            then open http://127.0.0.1:8787
 *
 * It runs on its own: a background poller refreshes prices, funding, maintenance rates and the release
 * calendar on a schedule, keeps working through source failures, saves its state to disk, and pushes
 * every update to open pages over a live stream. See README.md for settings.
 *
 * Environment (all optional):
 *   PORT, HOST                      listen address (default 127.0.0.1:8787)
 *   DATA_DIR                        where state is saved (default ./data)
 *   COINS                           always-watched coins, comma separated
 *   BINANCE_API_KEY / _SECRET       read-only key, enables live Binance rates
 *   TELEGRAM_BOT_TOKEN / _CHAT_ID   enables Telegram alerts
 *   EXTRA_ICS                       JSON list of extra calendar feeds [{url,name,cat,kind,imp}]
 *   HTTP_USER_AGENT                 identify yourself to data providers (BLS asks for this)
 *   ACCESS_PASSWORD (+ ACCESS_USER) password-protects everything except /healthz (min 10 characters)
 *   TRUST_PROXY                     number of reverse proxies in front (hosting platforms: 1), for visitor IPs
 *   ALLOW_OPEN_WITH_KEY=1           allow a Binance key on a public address with no password (not advised)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./adapters');
const { Poller, DEFAULT_COINS } = require('./poller');
const { makeNotifier } = require('./notifier');

const MAX_STREAMS = 500;

function defaultHttp(userAgent) {
  const headers = { 'User-Agent': userAgent, Accept: '*/*' };
  async function get(url, extra) {
    const res = await fetch(url, { headers: Object.assign({}, headers, extra || {}), signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (!res.ok) {
      let m = 'HTTP ' + res.status;
      try { const j = JSON.parse(text); m = j.msg || j.retMsg || m; } catch (e) { /* not JSON */ }
      throw new Error(m);
    }
    return text;
  }
  return {
    text: (url, extra) => get(url, extra),
    json: async (url, extra) => { const t = await get(url, extra); try { return JSON.parse(t); } catch (e) { throw new Error('response was not JSON'); } },
  };
}

const logger = {
  info: (m) => console.log(new Date().toISOString() + ' ' + m),
  warn: (m) => console.warn(new Date().toISOString() + ' WARN ' + m),
  error: (m) => console.error(new Date().toISOString() + ' ERROR ' + m),
};

/* ---------- public-hosting safeguards ---------- */
function makeLimiter(max, windowMs, now) {
  const hits = new Map();
  return function check(key) {
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + windowMs }; hits.set(key, h); }
    h.count++;
    return { ok: h.count <= max, retryAfter: Math.max(1, Math.ceil((h.resetAt - t) / 1000)), count: h.count };
  };
}
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();

/* After too many wrong passwords a visitor is locked out completely for a while, even if the next guess is right. */
function makeFailureTracker(max, windowMs, now) {
  const fails = new Map();
  const live = (ip) => { const f = fails.get(ip); if (f && f.resetAt <= now()) { fails.delete(ip); return null; } return f || null; };
  return {
    locked: (ip) => { const f = live(ip); return !!f && f.count >= max; },
    retryAfter: (ip) => { const f = live(ip); return f ? Math.max(1, Math.ceil((f.resetAt - now()) / 1000)) : 1; },
    add: (ip) => {
      if (fails.size > 5000) for (const [k, v] of fails) if (v.resetAt <= now()) fails.delete(k);
      const f = live(ip) || { count: 0, resetAt: now() + windowMs }; f.count++; fails.set(ip, f);
    },
  };
}

function createApp(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let extra = [];
  try { extra = env.EXTRA_ICS ? JSON.parse(env.EXTRA_ICS) : []; } catch (e) { logger.warn('EXTRA_ICS is not valid JSON; ignoring'); }
  const dataDir = env.DATA_DIR || path.join(__dirname, 'data');
  const now = o.now || Date.now;

  // access control and visitor limits, for running on a public address
  const host = o.host || env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const authPass = env.ACCESS_PASSWORD || '';
  const authUser = env.ACCESS_USER || 'trader';
  const hasBinanceKey = !!(env.BINANCE_API_KEY && env.BINANCE_API_SECRET);
  if (authPass && authPass.length < 10) throw new Error('ACCESS_PASSWORD must be at least 10 characters');
  if (hasBinanceKey && !loopback && !authPass && env.ALLOW_OPEN_WITH_KEY !== '1') {
    throw new Error('Refusing to start: a Binance API key is set but the server is reachable from the network with no ACCESS_PASSWORD. Set ACCESS_PASSWORD (or ALLOW_OPEN_WITH_KEY=1 if you really want this).');
  }
  const trustHops = Math.max(0, parseInt(env.TRUST_PROXY || '0', 10) || 0);
  const apiLimiter = makeLimiter(o.apiPerMinute || 120, 60e3, now);
  const failures = makeFailureTracker(o.maxPasswordFailures || 10, 10 * 60e3, now);   // wrong passwords per visitor per 10 minutes
  const maxStreamsPerIp = o.maxStreamsPerIp || 5;
  const wantUser = sha(authUser), wantPass = sha(authPass);
  function clientIp(req) {
    const sock = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!trustHops) return sock;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const i = xff.length - trustHops;     // the entry added by the nearest trusted proxy; anything left of it can be forged
    return i >= 0 ? xff[i] : (xff[0] || sock);
  }
  function passwordOk(req) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8'), i = decoded.indexOf(':');
    if (i < 0) return false;
    const u = crypto.timingSafeEqual(sha(decoded.slice(0, i)), wantUser), p = crypto.timingSafeEqual(sha(decoded.slice(i + 1)), wantPass);
    return u && p;
  }

  const poller = o.poller || new Poller({
    http: o.http || defaultHttp(env.HTTP_USER_AGENT || 'tradecheck/1.0 (self-hosted market data viewer)'),
    log: o.log || logger,
    persistPath: o.noPersist ? null : path.join(dataDir, 'state.json'),
    binanceKey: env.BINANCE_API_KEY, binanceSecret: env.BINANCE_API_SECRET,
    notifier: makeNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }),
    coins: env.COINS ? env.COINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_COINS,
    extraIcs: extra,
    intervals: o.intervals,
  });

  const maxStreams = o.maxStreams || MAX_STREAMS;
  const streams = new Set(); // { res, coin }
  const replacer = (k, v) => (v === Infinity ? null : v);
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body, replacer));
  };
  const sse = (res, event, data) => {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data, replacer) + '\n\n');
  };
  const cleanCoin = (c) => { c = String(c || '').toUpperCase(); return A.COIN_RE.test(c) ? c : null; };

  poller.on('coin', (coin) => {
    for (const s of [...streams]) if (s.coin === coin) { try { sse(s.res, 'coin', poller.getCoin(coin)); } catch (e) { streams.delete(s); } }
  });
  poller.on('events', () => {
    const ev = poller.getEvents();
    for (const s of [...streams]) { try { sse(s.res, 'events', ev); } catch (e) { streams.delete(s); } }
  });
  poller.on('alert', (a) => {
    for (const s of [...streams]) { try { sse(s.res, 'alert', a); } catch (e) { streams.delete(s); } }
  });

  const heartbeat = setInterval(() => {
    const h = poller.health();
    for (const s of [...streams]) {
      try { s.res.write(': keep-alive\n\n'); sse(s.res, 'health', { degraded: h.degraded, healthy: h.healthy, binanceTiers: h.binanceTiers }); }
      catch (e) { streams.delete(s); }
    }
  }, o.heartbeatMs || 20000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      // liveness probe for hosting platforms: no password, no data, always cheap
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

      const ip = clientIp(req);
      if (authPass) {
        if (failures.locked(ip)) { res.writeHead(429, { 'Retry-After': String(failures.retryAfter(ip)), 'Content-Type': 'text/plain' }); return res.end('Too many wrong passwords. Try again later.'); }
        if (!passwordOk(req)) {
          if (req.headers.authorization) failures.add(ip);
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Trade check", charset="UTF-8"', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          return res.end('Password required');
        }
      }
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/stream') {
        const r = apiLimiter(ip);
        if (!r.ok) { res.writeHead(429, { 'Retry-After': String(r.retryAfter), 'Content-Type': 'application/json' }); return res.end('{"error":"too many requests; slow down"}'); }
      }

      if (url.pathname === '/api/health') return json(res, 200, poller.health());
      if (url.pathname === '/api/events') return json(res, 200, poller.getEvents());

      if (url.pathname === '/api/coin') {
        const coin = cleanCoin(url.searchParams.get('coin'));
        if (!coin) return json(res, 400, { error: 'bad coin' });
        try { return json(res, 200, await poller.ensure(coin, 8000)); }
        catch (e) { if (e.code === 'TOO_MANY') return json(res, 429, { error: e.message }); throw e; }
      }

      if (url.pathname === '/api/stream') {
        const coin = cleanCoin(url.searchParams.get('coin'));
        if (!coin) return json(res, 400, { error: 'bad coin' });
        if (streams.size >= maxStreams) return json(res, 503, { error: 'too many open streams' });
        let mine = 0; for (const s of streams) if (s.ip === ip) mine++;
        if (mine >= maxStreamsPerIp) return json(res, 429, { error: 'too many open streams from your address' });
        try { poller.watch(coin); } catch (e) { if (e.code === 'TOO_MANY') return json(res, 429, { error: e.message }); throw e; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        const client = { res, coin, ip };
        streams.add(client);
        req.on('close', () => streams.delete(client));
        const h = poller.health();
        sse(res, 'events', poller.getEvents());
        sse(res, 'health', { degraded: h.degraded, healthy: h.healthy, binanceTiers: h.binanceTiers });
        sse(res, 'coin', await poller.ensure(coin, 8000));
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        // The page is one file with an inline script. A per-response nonce lets that script run while
        // blocking any script or event handler injected through data, as a second layer behind escaping.
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<script>', '<script nonce="' + nonce + '">');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(html);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      logger.error('request failed: ' + (e && e.message));
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  return {
    server, poller, streams,
    close() {
      clearInterval(heartbeat); poller.stop();
      for (const s of streams) { try { s.res.end(); } catch (e) { /* closing */ } }
      server.close();
    },
  };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8787;
  const HOST = process.env.HOST || '127.0.0.1';
  const app = createApp({ host: HOST });
  app.server.listen(PORT, HOST, () => {
    logger.info('Trade check running at http://' + HOST + ':' + PORT);
    logger.info(app.poller.key && app.poller.secret ? 'Binance rates: live (read-only key found)' : 'Binance rates: off (set BINANCE_API_KEY and BINANCE_API_SECRET to enable). Bybit and OKX rates are public.');
    logger.info(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'Telegram alerts: on' : 'Telegram alerts: off');
    logger.info(process.env.ACCESS_PASSWORD ? 'Password protection: on' : (['127.0.0.1', 'localhost', '::1'].includes(HOST) ? 'Password protection: off (local only)' : 'Password protection: OFF and reachable from the network. Anyone with the address can use this server. Set ACCESS_PASSWORD to restrict it.'));
    app.poller.start();
  });
  // keep running through unexpected errors; the container or service manager restarts us if we ever exit
  process.on('uncaughtException', (e) => logger.error('uncaught: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => logger.error('unhandled rejection: ' + ((e && e.stack) || e)));
  const stop = () => { logger.info('shutting down, saving state'); app.close(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createApp, defaultHttp };
