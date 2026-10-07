'use strict';
/* The server under hostile or odd requests. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { createApp } = require('../server');
const { Poller } = require('../poller');
const { makeHttp } = require('./helpers');

/* Open a raw HTTP stream; ignore the expected "socket hang up" when the test closes it early. */
function openStream(url, optsOrCb, maybeCb) {
  const req = maybeCb ? http.get(url, optsOrCb, maybeCb) : http.get(url, optsOrCb);
  req.on('error', () => {});
  return req;
}

const quiet = { info() {}, warn() {}, error() {} };
async function boot(opts) {
  const poller = new Poller(Object.assign({ http: makeHttp(), coins: ['BTC'], intervals: { spacingMs: 0 }, sleep: async () => {}, log: quiet }, opts && opts.poller));
  const app = createApp(Object.assign({ poller, noPersist: true }, opts && opts.app));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, poller, base: 'http://127.0.0.1:' + app.server.address().port, port: app.server.address().port };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const raw = (port, req) => new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => s.write(req)); let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => res(b)); s.on('error', () => res(b)); setTimeout(() => s.destroy(), 1500); });

test('files outside the page cannot be read', async () => {
  const { app, base } = await boot();
  try {
    for (const [u, leak] of [['/../server.js', 'require('], ['/%2e%2e/%2e%2e/etc/passwd', 'root:'], ['/public/index.html', '<html'], ['/data/state.json', '"coins"'], ['/poller.js', 'class Poller'], ['/.env', '=']]) {
      const r = await fetch(base + u); const t = await r.text();
      assert.strictEqual(r.status, 404, u); assert.ok(!t.includes(leak), u);
    }
  } finally { app.close(); }
});

test('bad input is refused with a 4xx, never a crash', async () => {
  const { app, base, port } = await boot();
  try {
    for (const u of ['/api/coin?coin=%E0%A4%A', '/api/coin?coin=BTC%0d%0aX-Evil:1', '/api/coin?coin=' + 'A'.repeat(5000), "/api/coin?coin=BTC';DROP", '/api/coin?coin=', '/api/stream?coin=bad!']) {
      assert.strictEqual((await fetch(base + u)).status, 400, u);
    }
    for (const m of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await fetch(base + '/api/health', { method: m })).status, 405, m);
    assert.ok([404, 414, 431].includes((await fetch(base + '/' + 'a'.repeat(20000))).status));
    assert.match(await raw(port, 'GARBAGE\r\n\r\n'), /400/);
    assert.strictEqual((await fetch(base + '/api/health')).status, 200, 'still serving afterwards');
  } finally { app.close(); }
});

test('the page is served with a strict Content-Security-Policy and a fresh nonce each time', async () => {
  const { app, base } = await boot();
  try {
    const a = await fetch(base + '/'); const html = await a.text(); const csp = a.headers.get('content-security-policy');
    const nonce = csp.match(/nonce-([A-Za-z0-9+/=]+)/)[1];
    assert.ok(html.includes('<script nonce="' + nonce + '">'));
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.strictEqual(a.headers.get('x-content-type-options'), 'nosniff');
    const b = await fetch(base + '/'); await b.text();
    assert.notStrictEqual(b.headers.get('content-security-policy').match(/nonce-([^']+)/)[1], nonce);
  } finally { app.close(); }
});

test('stream limit, cleanup, heartbeat and the custom-coin limit', async () => {
  const { app, base } = await boot({ app: { maxStreams: 2, heartbeatMs: 100 }, poller: { intervals: { spacingMs: 0, maxCustomCoins: 2 } } });
  try {
    const open = [openStream(base + '/api/stream?coin=BTC', (r) => r.resume()), openStream(base + '/api/stream?coin=BTC', (r) => r.resume())];
    assert.ok(await until(() => app.streams.size === 2));
    assert.strictEqual((await fetch(base + '/api/stream?coin=BTC')).status, 503);
    open[0].destroy();
    assert.ok(await until(() => app.streams.size === 1), 'closed stream is freed');
    let buf = ''; const hb = openStream(base + '/api/stream?coin=BTC', (r) => r.on('data', (d) => { buf += d; }));
    assert.ok(await until(() => /: keep-alive/.test(buf) && /event: health/.test(buf)), 'heartbeat');
    hb.destroy(); open[1].destroy();
    const codes = []; for (const c of ['AAA', 'BBB', 'CCC']) codes.push((await fetch(base + '/api/coin?coin=' + c)).status);
    assert.deepStrictEqual(codes, [200, 200, 429]);
    assert.strictEqual((await fetch(base + '/api/stream?coin=DDD')).status, 429);
  } finally { app.close(); }
});
