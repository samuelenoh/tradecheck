'use strict';
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

const T0 = Date.parse('2026-10-06T16:00:00Z');

async function boot() {
  const clock = { t: T0 };
  const net = makeHttp();
  const poller = new Poller({ http: net, now: () => clock.t, sleep: async () => {}, coins: ['BTC', 'ETH'], intervals: { spacingMs: 0 } });
  const app = createApp({ poller, noPersist: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return { app, poller, clock, net, base };
}
const getJSON = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json() }; };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test('JSON endpoints', async () => {
  const { app, base } = await boot();
  try {
    const coin = await getJSON(base + '/api/coin?coin=eth');
    assert.strictEqual(coin.status, 200);
    assert.strictEqual(coin.body.exchanges.bybit.market.mark, 2500);
    const tiers = coin.body.exchanges.bybit.tiers.tiers;
    assert.strictEqual(tiers[tiers.length - 1].cap, null, 'Infinity is sent as null');
    assert.strictEqual(coin.body.exchanges.binance.errors.tiers, 'needs_api_key');

    const health = await getJSON(base + '/api/health');
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.binanceTiers, false);

    const ev = await getJSON(base + '/api/events');
    assert.ok(ev.body.list.length >= 11);
    assert.ok(typeof ev.body.daysLeft === 'number');

    assert.strictEqual((await getJSON(base + '/api/coin?coin=bad!')).status, 400);
    assert.strictEqual((await getJSON(base + '/api/coin')).status, 400);
    assert.strictEqual((await getJSON(base + '/api/nope')).status, 404);
    assert.strictEqual((await getJSON(base + '/api/health', { method: 'POST' })).status, 405);
    const page = await fetch(base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Trade check/);
  } finally { app.close(); }
});

test('live stream pushes the first snapshot, then every update, then alerts', async () => {
  const { app, poller, clock, base } = await boot();
  let buf = '';
  const req = openStream(base + '/api/stream?coin=ETH', (res) => {
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    res.on('data', (d) => { buf += d.toString(); });
  });
  try {
    assert.ok(await until(() => /event: coin/.test(buf)), 'initial coin event');
    assert.match(buf, /event: events/);
    assert.match(buf, /event: health/);
    const count = () => (buf.match(/event: coin/g) || []).length;
    const before = count();
    clock.t += 17000;
    await poller.tick();
    assert.ok(await until(() => count() > before), 'update pushed after the poller refreshed');
    // a reminder reaches the stream
    clock.t = Date.parse('2026-10-14T12:10:00Z');
    poller.nextAlertAt = 0;
    await poller.tick();
    assert.ok(await until(() => /event: alert/.test(buf)), 'alert pushed');
    assert.match(buf, /US CPI inflation/);
    // the other coin's updates are not sent to this stream
    assert.strictEqual(/"coin":"BTC"/.test(buf), false);
  } finally { req.destroy(); app.close(); }
});

test('closing a stream removes it', async () => {
  const { app, base } = await boot();
  try {
    const req = openStream(base + '/api/stream?coin=BTC', () => {});
    assert.ok(await until(() => app.streams.size === 1));
    req.destroy();
    assert.ok(await until(() => app.streams.size === 0));
  } finally { app.close(); }
});
