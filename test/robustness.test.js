'use strict';
/* Regression tests for problems found while stress-testing: hung sources, coin floods, bad files, calendar maths. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../adapters');
const B = require('../baseline');
const { Poller } = require('../poller');
const { makeNotifier } = require('../notifier');
const { makeHttp } = require('./helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {} };
const mk = (o) => new Poller(Object.assign({ http: makeHttp(), coins: ['BTC'], intervals: { spacingMs: 0 }, sleep: async () => {}, log: quiet }, o));

test('one hung source does not stop the others from updating', async () => {
  const net = makeHttp(); const real = net.json;
  net.json = async (u) => (u.includes('bybit.com') ? new Promise(() => {}) : real(u));
  const p = mk({ http: net, sleep: wait, intervals: { spacingMs: 0, marketMs: 150, jobTimeoutMs: 250, tickMs: 50 } });
  p.start();
  await wait(1800);
  p.stop();
  const c = p.getCoin('BTC').exchanges;
  assert.ok(Date.now() - c.binance.marketAt < 1200, 'Binance still fresh');
  assert.ok(Date.now() - c.okx.marketAt < 1200, 'OKX still fresh');
  assert.strictEqual(c.bybit.market, null);
  assert.match(c.bybit.errors.market, /timed out/);
});

test('custom coins are capped so nobody can flood the exchanges', () => {
  const p = mk({ intervals: { spacingMs: 0, maxCustomCoins: 3 } });
  const ok = []; let refused = 0;
  for (const c of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) { try { p.watch(c); ok.push(c); } catch (e) { assert.strictEqual(e.code, 'TOO_MANY'); refused++; } }
  assert.deepStrictEqual(ok, ['AAA', 'BBB', 'CCC']);
  assert.strictEqual(refused, 2);
  assert.doesNotThrow(() => p.watch('AAA'), 'a coin already watched can be requested again');
  assert.doesNotThrow(() => p.watch('BTC'), 'default coins are never refused');
  assert.ok(p.jobs.size <= (1 + 3) * 6 + 1);
});

test('a corrupted state file is ignored and replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')); const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, '{"coins": {"BTC": {"binance": {');
  const warns = [];
  const p = mk({ persistPath: f, log: { info() {}, warn: (m) => warns.push(m), error() {} } });
  await p.tick(); p.stop();
  assert.ok(warns.some((m) => /unreadable/.test(m)));
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).coins.BTC);
  fs.rmSync(dir, { recursive: true });
});

test('an unwritable data folder warns once and the poller keeps running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')); const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
  const warns = [];
  const p = mk({ persistPath: path.join(blocker, 'sub', 'state.json'), log: { info() {}, warn: (m) => warns.push(m), error() {} } });
  await p.tick(); p.stop(); p.stop();
  assert.strictEqual(warns.filter((m) => /could not save/.test(m)).length, 1);
  assert.ok(p.getCoin('BTC').exchanges.okx.market);
  fs.rmSync(dir, { recursive: true });
});

test('saved state keeps default coins and drops custom ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')); const f = path.join(dir, 's.json');
  const a = mk({ persistPath: f }); a.watch('ARB'); await a.tick(); a.stop();
  const b = mk({ persistPath: f, http: makeHttp({ fail: { '': true } }) });
  assert.ok(b.getCoin('BTC').exchanges.bybit.market);
  assert.strictEqual(b.getCoin('ARB').exchanges.bybit.market, null);
  fs.rmSync(dir, { recursive: true });
});

test('health reports stale data straight away and failing sources as retrying', async () => {
  const clock = { t: Date.parse('2026-10-06T16:00:00Z') };
  const net = makeHttp();
  const p = mk({ http: net, now: () => clock.t });
  await p.tick();
  assert.deepStrictEqual(p.health().degraded.filter((d) => /stale/.test(d)), []);
  net.state.fail['v5/market/tickers'] = true;
  clock.t += 60000; await p.tick();
  const h = p.health();
  assert.ok(h.degraded.some((d) => /market\|bybit: prices are stale/.test(d)));
  assert.ok(h.jobs.find((j) => j.id === 'market|bybit').retrying >= 1);
});

test('failure alerts are one per source and at least 15 minutes apart', async () => {
  // Retry jitter is random by design; fix it so the timing below is exact and the test cannot be flaky.
  const realRandom = Math.random; Math.random = () => 0.5;
  try {
    const clock = { t: Date.parse('2026-10-06T16:00:00Z') }; const net = makeHttp(); const alerts = [];
    const p = mk({ http: net, now: () => clock.t, coins: ['BTC', 'ETH', 'SOL'] });
    p.on('alert', (a) => alerts.push(a));
    await p.tick();
    const step = async () => { clock.t += 20000; p.nextAlertAt = 0; await p.tick(); };
    for (let cycle = 0; cycle < 8; cycle++) {
      net.state.fail['v5/market/tickers'] = true; for (let i = 0; i < 40; i++) await step();   // about 13 minutes down
      net.state.fail['v5/market/tickers'] = false; for (let i = 0; i < 20; i++) await step();  // about 7 minutes up
    }
    const fails = alerts.filter((a) => /failing: market\|bybit/.test(a.text));
    assert.ok(fails.length >= 4, 'the source failed repeatedly, so it should have alerted (' + fails.length + ')');
    fails.forEach((a) => assert.match(a.text, /3 of 3 jobs/, 'one message covers every coin'));
    for (let i = 1; i < fails.length; i++) assert.ok(fails[i].at - fails[i - 1].at >= 15 * 60e3, 'failure alerts at least 15 minutes apart');
    assert.ok(alerts.some((a) => /recovered: market\|bybit/.test(a.text)), 'and it announced recovery');
  } finally { Math.random = realRandom; }
});

test('a broken notifier is logged and does not stop the poller', async () => {
  const warns = [];
  const p = mk({ notifier: { notify: async () => { throw new Error('telegram down'); } }, now: () => Date.parse('2026-10-14T12:10:00Z'), log: { info() {}, warn: (m) => warns.push(m), error() {} } });
  p.nextAlertAt = 0; await p.tick();
  assert.ok(warns.some((m) => /notifier failed/.test(m)));
  assert.ok(p.getCoin('BTC').exchanges.bybit.market);
});

test('the Telegram notifier is shaped correctly and never leaks its token', async () => {
  const calls = [];
  const n = makeNotifier({ token: 'SECRET123', chatId: '42', fetch: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200 }; } });
  await n.notify('hello'); await n.notify('x'.repeat(9000));
  assert.strictEqual(calls[0].url, 'https://api.telegram.org/botSECRET123/sendMessage');
  assert.deepStrictEqual(calls[0].body, { chat_id: '42', text: 'hello' });
  assert.strictEqual(calls[1].body.text.length, 3500);
  const bad = makeNotifier({ token: 'SECRET123', chatId: '42', fetch: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => bad.notify('a'), (e) => /401/.test(e.message) && !/SECRET123/.test(e.message));
  assert.strictEqual(makeNotifier({}), null);
  assert.strictEqual(makeNotifier({ token: 'a' }), null);
});

test('an extra calendar feed from EXTRA_ICS is read and merged', async () => {
  const net = makeHttp({ blsText: null }); const real = net.text;
  net.text = async (u) => (u === 'https://example.test/fed.ics'
    ? ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20270127T140000', 'SUMMARY:FOMC decision', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') : real(u));
  const p = mk({ http: net, extraIcs: [{ url: 'https://example.test/fed.ics', name: 'fed-feed', cat: 'Fed', kind: 'fomc', imp: 'High' }] });
  await p.tick();
  const ev = p.getEvents();
  const got = ev.list.find((e) => e.src === 'fed-feed');
  assert.strictEqual(new Date(got.at).toISOString(), '2027-01-27T19:00:00.000Z');
  assert.strictEqual(ev.sources['fed-feed'].ok, true);
  assert.strictEqual(ev.sources['bls-feed'].ok, false);
});

test('calendar maths survives daylight-saving changes and bad input', () => {
  const u = (Y, M, D, h, mi) => new Date(A.zonedToUtc(Y, M - 1, D, h, mi, 0, 'America/New_York')).toISOString();
  assert.strictEqual(u(2026, 10, 31, 8, 30), '2026-10-31T12:30:00.000Z');
  assert.strictEqual(u(2026, 11, 2, 8, 30), '2026-11-02T13:30:00.000Z');
  assert.strictEqual(u(2027, 3, 12, 8, 30), '2027-03-12T13:30:00.000Z');
  assert.strictEqual(u(2027, 3, 15, 8, 30), '2027-03-15T12:30:00.000Z');
  assert.doesNotThrow(() => u(2027, 3, 14, 2, 30)); // a time that does not exist
  assert.ok(Number.isNaN(A.icsTime({ value: 'garbage', params: {} }).ms));
  assert.deepStrictEqual(A.blsEvents('not a calendar at all', 'x'), []);
  assert.deepStrictEqual(A.blsEvents('', 'x'), []);
});

test('the built-in schedule is internally consistent', () => {
  const evs = B.events.map((e) => Object.assign({}, e, { ms: Date.parse(e.t) }));
  const fmt = (o) => (e) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'America/New_York' }, o)).format(new Date(e.ms));
  const dow = fmt({ weekday: 'short' });
  const hhmm = (e) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(new Date(e.ms));
  assert.ok(evs.every((e, i) => i === 0 || e.ms > evs[i - 1].ms), 'in date order');
  assert.ok(evs.every((e) => !/Sat|Sun/.test(dow(e))), 'no weekends');
  assert.ok(evs.filter((e) => ['cpi', 'jobs', 'pce'].includes(e.kind)).every((e) => hhmm(e) === '08:30'));
  assert.ok(evs.filter((e) => e.kind.startsWith('fomc')).every((e) => hhmm(e) === '14:00'));
  assert.ok(evs.filter((e) => e.kind === 'fomc').every((e) => dow(e) === 'Wed'));
  evs.forEach((e) => { // the offset written in the string must match New York's real offset on that date
    const claimed = parseInt(e.t.match(/([+-]\d\d):00$/)[1], 10);
    const real = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(e.ms)).find((p) => p.type === 'timeZoneName').value.replace('GMT', ''), 10);
    assert.strictEqual(claimed, real, e.t);
  });
});
