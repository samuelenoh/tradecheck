'use strict';
/* Safeguards for running on a public address: password, visitor limits, probe endpoint, safe start, region hints. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
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
const PASS = 'correct-horse-battery';
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');

async function boot(app = {}, env = {}, pollerOpts = {}) {
  const poller = new Poller(Object.assign({ http: makeHttp(), coins: ['BTC'], intervals: { spacingMs: 0 }, sleep: async () => {}, log: quiet }, pollerOpts));
  const a = createApp(Object.assign({ poller, noPersist: true, env }, app));
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  return { app: a, poller, base: 'http://127.0.0.1:' + a.server.address().port };
}
const get = async (url, headers) => { const r = await fetch(url, { headers }); return { status: r.status, headers: r.headers, text: await r.text() }; };

test('/healthz needs no password and reveals nothing', async () => {
  const { app, base } = await boot({}, { ACCESS_PASSWORD: PASS });
  try {
    const r = await get(base + '/healthz');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.text, '{"ok":true}');
    const h = await fetch(base + '/healthz', { method: 'HEAD' }); assert.strictEqual(h.status, 200);
    assert.strictEqual((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
  } finally { app.close(); }
});

test('with a password set, everything else requires it', async () => {
  const { app, base } = await boot({}, { ACCESS_PASSWORD: PASS });
  try {
    for (const u of ['/', '/api/health', '/api/events', '/api/coin?coin=BTC']) {
      const r = await get(base + u);
      assert.strictEqual(r.status, 401, u);
      assert.match(r.headers.get('www-authenticate'), /^Basic realm=/);
      assert.ok(!r.text.includes('Trade check'), 'the page is not leaked');
    }
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('trader', 'wrong-password-1') })).status, 401);
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('someone', PASS) })).status, 401, 'wrong user');
    assert.strictEqual((await get(base + '/api/health', { Authorization: 'Bearer abc' })).status, 401);
    assert.strictEqual((await get(base + '/api/health', { Authorization: 'Basic !!!notbase64' })).status, 401);
    assert.strictEqual((await get(base + '/api/health', { Authorization: 'Basic ' + Buffer.from('nocolon').toString('base64') })).status, 401);
    const ok = await get(base + '/', { Authorization: basic('trader', PASS) });
    assert.strictEqual(ok.status, 200); assert.match(ok.text, /Trade check/);
    assert.strictEqual((await get(base + '/api/coin?coin=BTC', { Authorization: basic('trader', PASS) })).status, 200);
  } finally { app.close(); }
});

test('the live stream also requires the password', async () => {
  const { app, base } = await boot({}, { ACCESS_PASSWORD: PASS });
  try {
    assert.strictEqual((await get(base + '/api/stream?coin=BTC')).status, 401);
    let first = '';
    await new Promise((resolve) => {
      const req = openStream(base + '/api/stream?coin=BTC', { headers: { Authorization: basic('trader', PASS) } }, (res) => { first = res.headers['content-type']; req.destroy(); resolve(); });
    });
    assert.strictEqual(first, 'text/event-stream');
  } finally { app.close(); }
});

test('a custom user name works, and a short password is refused at start-up', async () => {
  const { app, base } = await boot({}, { ACCESS_PASSWORD: PASS, ACCESS_USER: 'alice' });
  try {
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('alice', PASS) })).status, 200);
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('trader', PASS) })).status, 401);
  } finally { app.close(); }
  assert.throws(() => createApp({ noPersist: true, env: { ACCESS_PASSWORD: 'short' }, poller: new Poller({ http: makeHttp(), coins: ['BTC'], log: quiet }) }), /at least 10 characters/);
});

test('repeated wrong passwords lock a visitor out completely, even for the right password', async () => {
  const clock = { t: Date.parse('2026-10-06T16:00:00Z') };
  const { app, base } = await boot({ now: () => clock.t, maxPasswordFailures: 4 }, { ACCESS_PASSWORD: PASS });
  try {
    for (let i = 0; i < 4; i++) assert.strictEqual((await get(base + '/api/health', { Authorization: basic('trader', 'guess-number-' + i) })).status, 401);
    const locked = await get(base + '/api/health', { Authorization: basic('trader', PASS) });
    assert.strictEqual(locked.status, 429, 'the correct password is refused while locked out');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('trader', 'another-guess-xx') })).status, 429);
    clock.t += 10 * 60e3 + 1000;
    assert.strictEqual((await get(base + '/api/health', { Authorization: basic('trader', PASS) })).status, 200, 'unlocked after the window');
  } finally { app.close(); }
});

test('API requests are limited per visitor and recover after a minute', async () => {
  const clock = { t: Date.parse('2026-10-06T16:00:00Z') };
  const { app, base } = await boot({ now: () => clock.t, apiPerMinute: 5 });
  try {
    const codes = []; for (let i = 0; i < 7; i++) codes.push((await get(base + '/api/events')).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    const limited = await get(base + '/api/events'); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.strictEqual((await get(base + '/')).status, 200, 'the page itself is not rate limited');
    assert.strictEqual((await get(base + '/healthz')).status, 200, 'the probe is never rate limited');
    clock.t += 61000;
    assert.strictEqual((await get(base + '/api/events')).status, 200);
  } finally { app.close(); }
});

test('behind a proxy, visitors are told apart by the address the proxy appended, not by forged ones', async () => {
  const { app, base } = await boot({ apiPerMinute: 2 }, { TRUST_PROXY: '1' });
  try {
    const hit = (xff) => get(base + '/api/events', { 'X-Forwarded-For': xff }).then((r) => r.status);
    assert.strictEqual(await hit('9.9.9.9, 5.5.5.5'), 200);
    assert.strictEqual(await hit('1.1.1.1, 5.5.5.5'), 200);
    assert.strictEqual(await hit('2.2.2.2, 5.5.5.5'), 429, 'changing the forged address does not help');
    assert.strictEqual(await hit('6.6.6.6'), 200, 'a different real visitor has their own allowance');
  } finally { app.close(); }
  const open = await boot({ apiPerMinute: 2 }, {});
  try {
    const hit = (xff) => get(open.base + '/api/events', { 'X-Forwarded-For': xff }).then((r) => r.status);
    assert.deepStrictEqual([await hit('1.1.1.1'), await hit('2.2.2.2'), await hit('3.3.3.3')], [200, 200, 429], 'without TRUST_PROXY the header is ignored');
  } finally { open.app.close(); }
});

test('one visitor cannot hold more than a few live streams', async () => {
  const { app, base } = await boot({ maxStreamsPerIp: 2 });
  try {
    const open = [1, 2].map(() => openStream(base + '/api/stream?coin=BTC', (r) => r.resume()));
    const t0 = Date.now(); while (app.streams.size < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual((await get(base + '/api/stream?coin=BTC')).status, 429);
    open.forEach((r) => r.destroy());
  } finally { app.close(); }
});

test('a Binance key is never exposed on an open public address by accident', () => {
  const mk = (env, host) => () => createApp({ host, noPersist: true, env, poller: new Poller({ http: makeHttp(), coins: ['BTC'], log: quiet }) });
  const key = { BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' };
  assert.throws(mk(key, '0.0.0.0'), /Refusing to start/);
  assert.doesNotThrow(mk(key, '127.0.0.1'), 'fine when only this machine can reach it');
  assert.doesNotThrow(mk(Object.assign({ ACCESS_PASSWORD: PASS }, key), '0.0.0.0'), 'fine with a password');
  assert.doesNotThrow(mk(Object.assign({ ALLOW_OPEN_WITH_KEY: '1' }, key), '0.0.0.0'), 'explicit override');
  assert.doesNotThrow(mk({}, '0.0.0.0'), 'public-data-only servers may be open');
});

test('health explains when an exchange refuses the server\'s region', async () => {
  const net = makeHttp({ fail: { 'fapi/v1/premiumIndex': "Service unavailable from a restricted location according to 'b. Eligibility'", 'v5/market/tickers': 'HTTP 403' } });
  const p = new Poller({ http: net, coins: ['BTC'], intervals: { spacingMs: 0 }, sleep: async () => {}, log: quiet });
  await p.tick();
  const d = p.health().degraded.join(' | ');
  assert.match(d, /binance: the exchange refused this server's location.*Frankfurt/);
  assert.match(d, /bybit: access was denied \(HTTP 403\).*region is blocked/);
  const ok = new Poller({ http: makeHttp({ fail: { 'v5/market/tickers': 'HTTP 500' } }), coins: ['BTC'], intervals: { spacingMs: 0 }, sleep: async () => {}, log: quiet });
  await ok.tick();
  assert.ok(!/region|location/.test(ok.health().degraded.join(' ')), 'an ordinary 500 does not claim a region block');
});
