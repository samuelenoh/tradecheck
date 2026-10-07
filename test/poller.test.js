'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Poller } = require('../poller');
const { makeHttp } = require('./helpers');

const T0 = Date.parse('2026-10-06T16:00:00Z');
const BLS = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261014T083000', 'SUMMARY:Consumer Price Index for September 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20270112T083000', 'SUMMARY:Consumer Price Index for December 2026', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

// Retry jitter is random by design; pin it so timing-sensitive tests are exact.
Math.random = () => 0.5;

function make(over) {
  const clock = { t: T0 };
  const net = makeHttp(over && over.net);
  const events = [];
  const p = new Poller(Object.assign({
    http: net, now: () => clock.t, sleep: async () => {}, coins: ['BTC', 'ETH'],
    intervals: { spacingMs: 0 },
  }, over && over.opts));
  p.on('alert', (a) => events.push(a));
  const advance = async (ms) => { clock.t += ms; await p.tick(); };
  return { p, clock, net, advance, alerts: events };
}

test('first tick fills every watched coin on every exchange', async () => {
  const { p } = make();
  await p.tick();
  for (const coin of ['BTC', 'ETH']) {
    const c = p.getCoin(coin);
    for (const ex of ['binance', 'bybit', 'okx']) assert.ok(c.exchanges[ex].market, coin + ' ' + ex + ' market');
    assert.ok(c.exchanges.bybit.tiers && c.exchanges.okx.tiers, coin + ' tiers');
  }
  assert.strictEqual(p.getCoin('ETH').exchanges.bybit.market.mark, 2500);
  // OKX sizes: 1000 contracts x 0.1 = 100 coins
  assert.strictEqual(p.getCoin('ETH').exchanges.okx.tiers.tiers[0].cap, 100);
});

test('Binance tiers without a key are expected, not a failure', async () => {
  const { p } = make();
  await p.tick();
  const b = p.getCoin('BTC').exchanges.binance;
  assert.strictEqual(b.tiers, null);
  assert.strictEqual(b.errors.tiers, 'needs_api_key');
  assert.strictEqual(p.jobs.get('tiers|binance|BTC').fails, 0);
  assert.strictEqual(p.health().jobs.find((j) => j.id === 'tiers|binance').needsKey, true);
});

test('with a key, Binance tiers load', async () => {
  const { p, net } = make({ opts: { binanceKey: 'k', binanceSecret: 's' } });
  await p.tick();
  const t = p.getCoin('BTC').exchanges.binance.tiers;
  assert.strictEqual(t.tiers[0].mmr, 0.005);
  assert.strictEqual(t.tiers[1].cum, 500);
  assert.ok(net.state.calls.some((u) => u.includes('leverageBracket') && /signature=[0-9a-f]{64}/.test(u)));
});

test('failures back off, keep the last good data, and recover', async () => {
  const { p, net, advance } = make();
  await p.tick();
  const before = p.getCoin('BTC').exchanges.bybit.market.mark;
  net.state.fail['v5/market/tickers'] = true;
  await advance(16000);
  let c = p.getCoin('BTC').exchanges.bybit;
  assert.strictEqual(c.market.mark, before, 'keeps last good value');
  assert.match(c.errors.market, /HTTP 500/);
  const job = p.jobs.get('market|bybit|BTC');
  assert.strictEqual(job.fails, 1);
  const gap1 = job.nextAt - (T0 + 16000);
  await advance(gap1 + 1);
  assert.strictEqual(job.fails, 2);
  assert.ok(job.nextAt - p.now() > gap1 - 1000, 'backoff grows');
  net.state.fail['v5/market/tickers'] = false;
  await advance(job.nextAt - p.now() + 1);
  assert.strictEqual(job.fails, 0);
  assert.strictEqual(p.getCoin('BTC').exchanges.bybit.errors.market, null);
});

test('data is marked stale once it gets old', async () => {
  const { p, clock } = make();
  await p.tick();
  assert.strictEqual(p.getCoin('BTC').exchanges.bybit.marketStale, false);
  clock.t += 60000;
  assert.strictEqual(p.getCoin('BTC').exchanges.bybit.marketStale, true);
  clock.t += 3.5 * 3600e3;
  assert.strictEqual(p.getCoin('BTC').exchanges.bybit.tiersStale, true);
});

test('bad data is rejected and absurd funding is dropped', async () => {
  const { p, net, advance } = make();
  await p.tick();
  net.state.funding = 9; // 900% per interval
  await advance(17000);
  const b = p.getCoin('BTC').exchanges.bybit;
  assert.ok(Number.isNaN(b.market.funding));
  assert.ok(b.flags.includes('m:funding_out_of_range'));
  net.state.prices.BTC = 0;
  net.state.funding = 0.0001;
  await advance(17000);
  assert.match(p.getCoin('BTC').exchanges.bybit.errors.market, /invalid mark price/);
});

test('exchanges that disagree on price are flagged', async () => {
  const { p, net } = make();
  net.state.okxMultiplier = 1000; // e.g. a 1000x contract listed under the same symbol
  await p.tick();
  const s = p.getCoin('BTC').spread;
  assert.strictEqual(s.mismatch, true);
  assert.ok(s.pct > 900);
});

test('events: live feed replaces baseline entries; failures fall back to the built-in schedule', async () => {
  const { p, net } = make({ net: { blsText: BLS } });
  await p.tick();
  let ev = p.getEvents();
  const cpi = ev.list.filter((e) => e.kind === 'cpi' && e.at === Date.parse('2026-10-14T12:30:00Z'));
  assert.strictEqual(cpi.length, 1);
  assert.strictEqual(cpi[0].src, 'bls-feed');
  assert.ok(ev.list.some((e) => e.at === Date.parse('2027-01-12T13:30:00Z')), 'future live release is added');
  assert.ok(ev.list.some((e) => e.kind === 'fomc' && e.src === 'built-in'));
  assert.strictEqual(ev.sources['bls-feed'].ok, true);

  const f = make({ net: { blsText: null } }); // feed 404s
  await f.p.tick();
  ev = f.p.getEvents();
  assert.strictEqual(ev.sources['bls-feed'].ok, false);
  assert.ok(ev.list.length >= 11, 'built-in schedule still served');
  assert.ok(f.p.health().degraded.some((d) => /BLS calendar feed/.test(d)));
  void net;
});

test('schedule coverage is monitored', async () => {
  const { p, clock } = make();
  assert.strictEqual(p.getEvents().needsUpdate, false); // ~65 days left on 6 Oct 2026
  clock.t = Date.parse('2026-12-01T00:00:00Z');
  const e = p.getEvents();
  assert.strictEqual(e.needsUpdate, true);
  assert.ok(p.health().degraded.some((d) => /schedule ends/.test(d)));
});

test('reminders fire once for upcoming high-impact releases and reach the notifier', async () => {
  const sent = [];
  const { p, clock, alerts } = make({ opts: { notifier: { notify: async (t) => sent.push(t) } } });
  clock.t = Date.parse('2026-10-14T12:05:00Z'); // 25 min before CPI
  p.nextAlertAt = 0;
  await p.tick();
  const ev = alerts.filter((a) => a.type === 'event');
  assert.strictEqual(ev.length, 1);
  assert.match(ev[0].text, /US CPI inflation.*25 min/);
  assert.strictEqual(sent.filter((t) => /US CPI/.test(t)).length, 1);
  clock.t += 61000; p.nextAlertAt = 0; await p.tick();
  assert.strictEqual(alerts.filter((a) => a.type === 'event').length, 1, 'no duplicate');
});

test('a source failing repeatedly raises one alert per source, then a recovery notice', async () => {
  const { p, net, clock, alerts } = make();
  await p.tick();
  net.state.fail['v5/market/tickers'] = true;
  for (let i = 0; i < 8; i++) { clock.t += 5 * 60e3 + 2000; p.nextAlertAt = 0; await p.tick(); }
  const fails = alerts.filter((a) => a.type === 'health' && /failing: market\|bybit/.test(a.text));
  assert.strictEqual(fails.length, 1, 'one message for the whole source, not one per coin');
  assert.match(fails[0].text, /2 of 2 jobs/);
  net.state.fail['v5/market/tickers'] = false;
  clock.t += 5 * 60e3 + 2000; p.nextAlertAt = 0; await p.tick();
  clock.t += 61000; p.nextAlertAt = 0; await p.tick();
  assert.ok(alerts.some((a) => /recovered: market\|bybit/.test(a.text)));
});

test('a flapping source cannot flood the alert channel', async () => {
  const { p, net, clock, alerts } = make();
  await p.tick();
  const step = async () => { clock.t += 20000; p.nextAlertAt = 0; await p.tick(); };
  for (let cycle = 0; cycle < 10; cycle++) {
    net.state.fail['v5/market/tickers'] = true;
    for (let i = 0; i < 27; i++) await step();      // about 9 minutes down
    net.state.fail['v5/market/tickers'] = false;
    for (let i = 0; i < 15; i++) await step();      // about 5 minutes up
  }
  const failTimes = [];
  alerts.forEach((a) => { if (/failing: market\|bybit/.test(a.text)) failTimes.push(a.at); });
  assert.ok(failTimes.length >= 2, 'the source did fail repeatedly (' + failTimes.length + ' alerts)');
  for (let i = 1; i < failTimes.length; i++) {
    assert.ok(failTimes[i] - failTimes[i - 1] >= 15 * 60e3, 'failure alerts at least 15 minutes apart');
  }
});

test('state survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const file = path.join(dir, 'state.json');
  const a = make({ opts: { persistPath: file } });
  await a.p.tick();
  a.p.stop();
  assert.ok(fs.existsSync(file));
  const b = make({ opts: { persistPath: file }, net: { fail: { '': true } } }); // network completely down
  const c = b.p.getCoin('ETH');
  assert.strictEqual(c.exchanges.bybit.market.mark, 2500);
  const tiers = c.exchanges.bybit.tiers.tiers;
  assert.strictEqual(tiers[tiers.length - 1].cap, Infinity, 'Infinity restored after JSON round trip');
  fs.rmSync(dir, { recursive: true });
});

test('idle custom coins are dropped, default coins stay', async () => {
  const { p, clock } = make();
  p.watch('ARB');
  await p.tick();
  assert.ok(p.getCoin('ARB').exchanges.bybit.market);
  clock.t += 31 * 60e3;
  await p.tick();
  assert.ok(![...p.jobs.keys()].some((k) => k.endsWith('|ARB')));
  assert.ok([...p.jobs.keys()].some((k) => k.endsWith('|BTC')));
});

test('ensure() fetches a brand-new coin on demand', async () => {
  const { p } = make();
  await p.tick();
  const c = await p.ensure('ARB', 2000);
  assert.strictEqual(c.exchanges.okx.market.mark, 1);
  assert.throws(() => p.watch('bad coin!'));
});

test('health summarises sources', async () => {
  const { p } = make();
  await p.tick();
  const h = p.health();
  assert.strictEqual(h.ok, true);
  assert.ok(h.jobs.some((j) => j.id === 'market|okx' && j.failing === 0 && j.lastOk > 0));
  assert.deepStrictEqual(h.coins.sort(), ['BTC', 'ETH']);
});
