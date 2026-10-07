'use strict';
/*
 * Page tests. They load the real page in a simulated browser (jsdom) and drive it like a user.
 * jsdom is a test-only tool: `npm install --save-dev jsdom` enables these; without it they are skipped.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildPage, slot, payload, wait, hasJsdom } = require('./page-harness');
const opt = { skip: hasJsdom ? false : 'jsdom not installed (npm install --save-dev jsdom)' };

const FORBID = /NaN|Infinity|undefined|\[object|null%|\$null/;
const TIERS = [{ cap: 100000, mmr: 0.005, cum: 0, maxLev: 100 }, { cap: Infinity, mmr: 0.01, cum: 500, maxLev: 50 }];
const live = (p) => payload('BTC', { binance: slot(p, 0.01, TIERS), bybit: slot(p, 0.01, TIERS), okx: slot(p, 0.01, TIERS) });
const visibleText = (pg) => { const c = pg.d.body.cloneNode(true); c.querySelectorAll('script,style').forEach((x) => x.remove()); return c.textContent + pg.d.getElementById('ladder').innerHTML; };

test('first load: no sample values anywhere', opt, async () => {
  const pg = await buildPage({ mode: 'offline' });
  for (const id of ['balance', 'riskPct', 'entry', 'stop', 'tp', 'lev', 'holdNum', 'funding', 'mmr', 'mmrCum']) assert.strictEqual(pg.d.getElementById(id).value, '', id);
  assert.match(pg.txt('#verdict h2'), /Enter your plan/);
  assert.match(pg.txt('#dataStrip'), /Not connected/);
  assert.strictEqual(pg.d.getElementById('contextPanel').hidden, true);
  pg.setv('balance', '1234');
  assert.match(pg.w.localStorage.getItem('tradecheck:v3'), /1234/);
  assert.ok(!/secret|token|apikey/i.test(pg.w.localStorage.getItem('tradecheck:v3')));
  pg.close();
});

test('hostile text from the server is shown as text, never run', opt, async () => {
  const EVIL = '<b id="pwn1">x</b><img id="pwn2" src=x onerror="window.__xss=1"><script id="pwn3">window.__xss=2</script>';
  const pg = await buildPage({ mode: 'stream', binanceTiers: false, degraded: [EVIL] });
  pg.emit('events', { now: Date.now(), list: [{ n: EVIL, cat: EVIL, kind: 'x', imp: 'High', at: Date.parse('2026-10-06T17:00:00Z'), src: 'bls-feed' }], at: 1, sources: { 'bls-feed': { ok: true } }, coverageEnd: Date.parse('2026-12-01T00:00:00Z'), daysLeft: 30, needsUpdate: false });
  pg.emit('health', { degraded: [EVIL], healthy: false });
  pg.emit('alert', { type: EVIL, text: EVIL });
  pg.emit('coin', payload('BTC', { binance: slot(100, 0.01, null, { errors: { market: null, tiers: EVIL } }), bybit: slot(100, 0.01, null, { errors: { market: EVIL, tiers: EVIL } }), okx: slot(100, 0.01, null, { errors: { market: null, tiers: EVIL } }) }));
  await wait(40);
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '10'); pg.setv('holdSel', '24', 'change');
  pg.click('#modeSeg [data-mode=pro]'); pg.click('#watchBtn'); await wait(20);
  for (const id of ['pwn1', 'pwn2', 'pwn3']) assert.strictEqual(pg.d.getElementById(id), null, id + ' was injected');
  assert.strictEqual(pg.d.querySelectorAll('img').length, 0);
  assert.strictEqual(pg.w.__xss, undefined);
  assert.ok(pg.d.body.textContent.includes('<b id="pwn1">'), 'shown as plain text instead');
  pg.setv('coin', 'OTHER', 'change'); pg.setv('coinOther', '<img src=x>ARB"\'');
  assert.strictEqual(pg.d.getElementById('coinOther').value, 'IMGSRCXARB');
  pg.close();
});

/* ---------- liquidation and sizing against an independent reference ---------- */
let seed = 20261006; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const lu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
const un = (a, b) => a + rnd() * (b - a);
const FEES = { binance: { taker: 0.0005 }, bybit: { taker: 0.00055 }, okx: { taker: 0.0005 } };
function genTiers(E, qty) {
  const n = 1 + Math.floor(rnd() * 4), out = []; let cap = qty * E * un(0.3, 3), mmr = un(0.002, 0.01), cum = 0, prevCap = 0, prevMmr = mmr;
  for (let i = 0; i < n; i++) {
    if (i > 0) { mmr = prevMmr + un(0.002, 0.01); cum += prevCap * (mmr - prevMmr); cap = prevCap * un(2, 6); }
    out.push({ cap: i === n - 1 ? Infinity : cap, mmr, cum, maxLev: 50 }); prevCap = cap; prevMmr = mmr;
  }
  return out;
}
const tierAt = (tiers, v) => { for (const t of tiers) if (v <= t.cap) return t; return tiers[tiers.length - 1]; };
/* solves "equity = maintenance margin" by bisection, so it does not share the page's closed-form formulas */
function refLiq(ex, side, E, qty, lev, tiers, unit) {
  const notional = qty * E, margin = notional / lev; let mm;
  if (ex === 'binance') mm = (P) => { const t = tierAt(tiers, qty * P); return qty * P * t.mmr - t.cum; };
  else if (ex === 'bybit') { const t = tierAt(tiers, notional); const fixed = notional * t.mmr - t.cum; mm = () => fixed; }
  else { const t = tierAt(tiers, unit === 'qty' ? qty : notional); mm = (P) => qty * P * (t.mmr + FEES.okx.taker); }
  const f = (P) => margin + side * qty * (P - E) - mm(P);
  if (side === 1) { let lo = 0, hi = E; if (f(lo) >= 0) return null; if (f(hi) <= 0) return E; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; }
  let lo = E, hi = E * 2, g = 0; while (f(hi) > 0 && g++ < 60) hi *= 2; if (f(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; } return (lo + hi) / 2;
}
const num = (t) => parseFloat(String(t).replace(/[^0-9.\-]/g, ''));

test('sizing, take-profit gain and liquidation match an independent solver (300 random plans)', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true });
  pg.emit('coin', live(1000)); await wait(30); pg.click('#modeSeg [data-mode=pro]');
  const fails = []; let compared = 0, immediate = 0;
  for (let k = 0; k < 300; k++) {
    const E = lu(0.5, 120000), side = rnd() < 0.5 ? 1 : -1, stopPct = un(0.003, 0.08), tpPct = un(0.005, 0.15), lev = Math.max(1, Math.round(lu(1, 100))), bal = lu(100, 1e6), risk = un(0.1, 5);
    const SL = E * (1 - side * stopPct), TP = E * (1 + side * tpPct);
    const riskAmt = bal * risk / 100, qty = riskAmt / (Math.abs(E - SL) + FEES.binance.taker * E + FEES.binance.taker * SL);
    const tB = genTiers(E, qty), tY = genTiers(E, qty), tO = genTiers(E, qty).map((t) => ({ ...t, cap: t.cap === Infinity ? Infinity : t.cap / E, cum: 0 }));
    pg.emit('coin', payload('BTC', { binance: slot(E, 0.01, tB), bybit: slot(E, 0.01, tY), okx: slot(E, 0.01, tO, { unit: 'qty' }) })); await wait(3);
    pg.click('#dirSeg [data-dir=' + (side === 1 ? 'long' : 'short') + ']'); pg.click('#exSeg [data-ex=binance]');
    pg.setv('balance', String(bal)); pg.setv('riskPct', String(risk)); pg.setv('entry', String(E)); pg.setv('stop', String(SL)); pg.setv('tp', String(TP)); pg.setv('lev', String(lev)); pg.setv('holdSel', '8', 'change');
    const st = pg.stats(), row = pg.cmpRow('Liquidation price');
    const gotQty = num(st['Size to enter']), qtol = Math.max(5e-3 * qty, 0.5 * Math.pow(10, -(qty >= 100 ? 2 : qty >= 1 ? 3 : qty >= 0.01 ? 4 : 6)));
    if (Math.abs(gotQty - qty) > qtol) fails.push({ k, what: 'size', gotQty, qty });
    const gain = qty * Math.abs(TP - E) - qty * (FEES.binance.taker * E + FEES.binance.taker * TP), gotGain = num(st['If take-profit hits']);
    if (Math.abs(gotGain - gain) > Math.max(0.01, gain * 1e-4)) fails.push({ k, what: 'gain', gotGain, gain });
    ['binance', 'bybit', 'okx'].forEach((ex, i) => {
      const tiers = { binance: tB, bybit: tY, okx: tO }[ex], ref = refLiq(ex, side, E, qty, lev, tiers, ex === 'okx' ? 'qty' : 'notional'), cell = row[i];
      const refImmediate = ref != null && (side === 1 ? ref >= E * (1 - 1e-9) : ref <= E * (1 + 1e-9));
      if (refImmediate) { immediate++; if (!/Immediately/.test(cell)) fails.push({ k, ex, what: 'expected Immediately', cell }); return; }
      if (/Immediately/.test(cell)) { fails.push({ k, ex, what: 'unexpected Immediately', ref, E }); return; }
      if (ref == null || (side === 1 && ref < 0.01 * E)) { if (!/None/.test(cell)) fails.push({ k, ex, what: 'expected None', cell, ref }); return; }
      if (/None/.test(cell)) { fails.push({ k, ex, what: 'unexpected None', ref }); return; }
      compared++;
      const got = num(cell), tol = Math.max(Math.abs(ref) * 2e-4, ref >= 1000 ? 0.006 : ref >= 1 ? 0.0006 : 0.000006);
      if (Math.abs(got - ref) > tol) fails.push({ k, ex, what: 'liq', got, ref, E, lev, side });
    });
  }
  assert.deepStrictEqual(fails.slice(0, 5), [], 'mismatches against the independent solver');
  assert.ok(compared > 700, 'enough liquidation prices compared: ' + compared);
  assert.ok(immediate > 0, 'immediate-liquidation cases were exercised');
  assert.deepStrictEqual(pg.st.errs, []);
  pg.close();
});

test('leverage too high for the position size is reported as immediate liquidation', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true });
  const t = [{ cap: Infinity, mmr: 0.02, cum: 0, maxLev: 100 }];   // 2% maintenance, but 100x leverage is only 1% margin
  pg.emit('coin', payload('BTC', { binance: slot(100, 0.01, t), bybit: slot(100, 0.01, t), okx: slot(100, 0.01, t) })); await wait(30);
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '100'); pg.setv('holdSel', '8', 'change');
  assert.match(pg.txt('#verdict .stats'), /Liquidation on BinanceImmediately/);
  assert.ok(pg.checks().some((c) => c.s === 'bad' && /Liquidated as soon as the trade opens/.test(c.title)));
  assert.match(pg.txt('#ladder'), /moment the trade opens/);
  pg.close();
});

test('garbage in every field never shows NaN, Infinity or undefined (880 screens)', opt, async () => {
  let seed2 = 7; const r2 = () => { seed2 = (seed2 * 1664525 + 1013904223) >>> 0; return seed2 / 4294967296; }; const pick = (a) => a[Math.floor(r2() * a.length)];
  const vals = { balance: ['', '0', '-5', 'abc', '1e9', '0.0000001', '1000'], riskPct: ['', '0', '-1', '100', '500', '0.25', '1'], entry: ['', '0', '-1', '1e-9', '1e12', '100'], stop: ['', '0', '-3', '100', '99', '1e12', '1e-9', '98'], tp: ['', '0', '100', '101', '1e15', '106'], lev: ['', '0', '0.5', '1', '125', '1000', 'abc', '10'], hold: ['', '0', '-1', '1e6', '8'] };
  for (const mode of ['stream', 'offline']) {
    const pg = await buildPage({ mode, binanceTiers: true });
    if (mode === 'stream') { pg.emit('coin', live(100)); await wait(30); }
    const leaks = [];
    for (const m of ['simple', 'pro']) {
      pg.click('#modeSeg [data-mode=' + m + ']');
      for (let i = 0; i < 220; i++) {
        pg.setv('balance', pick(vals.balance)); pg.setv('riskPct', pick(vals.riskPct)); pg.setv('entry', pick(vals.entry)); pg.setv('stop', pick(vals.stop)); pg.setv('tp', pick(vals.tp)); pg.setv('lev', pick(vals.lev)); pg.setv('holdNum', pick(vals.hold));
        if (r2() < 0.3) pg.click('#dirSeg [data-dir=' + pick(['long', 'short']) + ']');
        if (r2() < 0.3) pg.click('#exSeg [data-ex=' + pick(['binance', 'bybit', 'okx']) + ']');
        const hit = visibleText(pg).match(FORBID); if (hit) leaks.push(hit[0]);
      }
    }
    assert.deepStrictEqual(leaks.slice(0, 3), [], mode);
    assert.deepStrictEqual(pg.st.errs, [], mode + ' script errors');
    pg.close();
  }
});

test('invalid plans are rejected with a clear message', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true }); pg.emit('coin', live(100)); await wait(30);
  const plan = (o) => { const d = Object.assign({ balance: '1000', riskPct: '1', entry: '100', stop: '98', tp: '106', lev: '10', hold: '8' }, o); pg.setv('balance', d.balance); pg.setv('riskPct', d.riskPct); pg.setv('entry', d.entry); pg.setv('stop', d.stop); pg.setv('tp', d.tp); pg.setv('lev', d.lev); pg.setv('holdSel', d.hold, 'change'); return pg.txt('#verdict h2') + ' | ' + pg.txt('#verdict .lead'); };
  pg.click('#dirSeg [data-dir=long]');
  assert.match(plan({ stop: '100' }), /stop-loss must be below/); assert.match(plan({ stop: '101' }), /stop-loss must be below/); assert.match(plan({ tp: '99' }), /take-profit must be above/);
  pg.click('#dirSeg [data-dir=short]');
  assert.match(plan({ stop: '98', tp: '94' }), /stop-loss must be above/); assert.match(plan({ stop: '102', tp: '106' }), /take-profit must be below/);
  pg.click('#dirSeg [data-dir=long]');
  assert.match(plan({ riskPct: '50', lev: '2' }), /problem/); assert.match(plan({ lev: '200', stop: '99' }), /problem/);
  pg.close();
});

test('funding: longs pay and shorts receive when the rate is positive', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true }); pg.emit('coin', live(100)); await wait(30); pg.click('#modeSeg [data-mode=pro]');
  pg.setv('balance', '10000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '5'); pg.setv('holdNum', '24'); pg.setv('funding', '0.05');
  const f = () => pg.checks().find((c) => /^Funding/.test(c.title)).msg;
  pg.click('#dirSeg [data-dir=long]');
  const notional = num(pg.stats()['Position value']), want = notional * 0.0005 * 3, got = num(f().match(/cost about \$([0-9,.]+)/)[1]);
  assert.ok(Math.abs(got - want) < 0.01, got + ' vs ' + want);
  pg.click('#dirSeg [data-dir=short]'); pg.setv('stop', '102'); pg.setv('tp', '94');
  assert.match(f(), /receive about/);
  pg.setv('funding', '-0.05'); pg.click('#dirSeg [data-dir=long]'); pg.setv('stop', '98'); pg.setv('tp', '106');
  assert.match(f(), /receive about/);
  pg.close();
});

test('watch mode alerts on a short, once per level, and can be re-armed', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true }); pg.emit('coin', live(100)); await wait(30);
  pg.click('#dirSeg [data-dir=short]'); pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '102'); pg.setv('tp', '94'); pg.setv('lev', '5'); pg.setv('holdSel', '8', 'change');
  pg.click('#watchBtn'); await wait(10);
  const al = () => [...pg.d.querySelectorAll('#alerts .al span')].map((x) => x.textContent);
  pg.emit('coin', live(101.7)); await wait(10); assert.ok(al().some((t) => /close to your stop-loss/.test(t)));
  pg.emit('coin', live(102.2)); await wait(10); assert.ok(al().some((t) => /reached your stop-loss/.test(t)));
  pg.emit('coin', live(95)); await wait(10); assert.ok(al().some((t) => /close to your take-profit/.test(t)));
  pg.emit('coin', live(93.9)); await wait(10); assert.ok(al().some((t) => /reached your take-profit/.test(t)));
  const n = al().length; pg.emit('coin', live(93.8)); pg.emit('coin', live(93.7)); await wait(10); assert.strictEqual(al().length, n);
  pg.click('#unwatchBtn'); await wait(5); assert.ok(pg.d.getElementById('watchBtn'));
  pg.click('#watchBtn'); await wait(5); pg.emit('coin', live(102.5)); await wait(10);
  assert.ok(al().filter((t) => /reached your stop-loss/.test(t)).length >= 1);
  pg.close();
});

test('stale prices and rates are flagged, and recovery clears the flag', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true });
  const mk = (mAge, tAge) => payload('BTC', { binance: slot(100, 0.01, TIERS, { marketAge: mAge, tiersAge: tAge }), bybit: slot(100, 0.01, TIERS, { marketAge: mAge, tiersAge: tAge }), okx: slot(100, 0.01, TIERS, { marketAge: mAge, tiersAge: tAge }) });
  pg.emit('coin', mk(1000, 60000)); await wait(20);
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '10'); pg.setv('holdSel', '1', 'change');
  assert.ok(!pg.checks().some((c) => /stopped updating/.test(c.title)));
  pg.emit('coin', mk(120000, 60000)); await wait(20);
  assert.ok(pg.checks().some((c) => /stopped updating/.test(c.title))); assert.match(pg.txt('#dataStrip'), /stale/);
  pg.emit('coin', mk(1000, 4 * 3600e3)); await wait(20);
  const dc = pg.checks().find((c) => /^Maintenance rates/.test(c.title)); assert.strictEqual(dc.s, 'warn'); assert.match(dc.msg, /refresh every 30 minutes/);
  pg.emit('coin', mk(1000, 60000)); await wait(20);
  assert.ok(!pg.checks().some((c) => /stopped updating/.test(c.title)));
  pg.close();
});

test('exchanges that disagree on price raise a warning', opt, async () => {
  const pg = await buildPage({ mode: 'stream', binanceTiers: true }); pg.emit('coin', live(100)); await wait(20);
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '10'); pg.setv('holdSel', '1', 'change');
  pg.emit('coin', payload('BTC', { binance: slot(100, 0.01, TIERS), bybit: slot(100, 0.01, TIERS), okx: slot(100000, 0.01, TIERS) }, { pct: 99900, mismatch: true })); await wait(20);
  assert.ok(pg.checks().some((c) => /disagree/.test(c.title)));
  pg.close();
});

test('release warnings follow the holding window (now = 11:00Z, CPI at 12:30Z)', opt, async () => {
  const NOW = Date.parse('2026-10-14T11:00:00Z');
  const pg = await buildPage({ mode: 'stream', now: NOW, binanceTiers: true }); pg.emit('coin', live(100)); await wait(20);
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '10'); pg.click('#modeSeg [data-mode=pro]');
  const ev = () => pg.checks().find((c) => /^Scheduled/.test(c.title));
  pg.setv('holdNum', '1'); assert.strictEqual(ev().s, 'ok');
  pg.setv('holdNum', '1.5'); assert.strictEqual(ev().s, 'warn');
  pg.setv('holdNum', '8'); assert.strictEqual(ev().s, 'warn'); assert.match(ev().msg, /CPI/);
  pg.emit('events', { now: NOW, list: [{ n: 'Minor release', cat: 'Inflation', kind: 'ppi', imp: 'Medium', at: NOW + 3600e3, src: 'bls-feed' }, { n: 'Far away', cat: 'Inflation', kind: 'ppi', imp: 'Medium', at: NOW + 60 * 86400e3, src: 'bls-feed' }], at: NOW, sources: { 'bls-feed': { ok: true } }, coverageEnd: NOW + 60 * 86400e3, daysLeft: 60, needsUpdate: false });
  pg.setv('holdNum', '24'); await wait(10);
  assert.strictEqual(ev().s, 'ok'); assert.match(ev().msg, /lower-impact/);
  pg.setv('holdNum', '2000'); await wait(10);
  assert.strictEqual(ev().s, 'warn'); assert.match(ev().msg, /schedule .* ends/);
  pg.close();
});

test('accessibility basics', opt, async () => {
  const pg = await buildPage({ mode: 'offline' }); const d = pg.d;
  const ids = [...d.querySelectorAll('[id]')].map((e) => e.id);
  assert.deepStrictEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], 'unique ids');
  const unlabeled = [...d.querySelectorAll('input,select')].filter((e) => !((e.id && d.querySelector('label[for="' + e.id + '"]')) || e.getAttribute('aria-label') || e.closest('label'))).map((e) => e.id);
  assert.deepStrictEqual(unlabeled, []);
  assert.deepStrictEqual([...d.querySelectorAll('label[for]')].filter((l) => !d.getElementById(l.getAttribute('for'))).length, 0);
  assert.deepStrictEqual([...d.querySelectorAll('button')].filter((b) => !b.hidden && !b.textContent.trim() && !b.getAttribute('aria-label')).length, 0);
  assert.strictEqual(d.documentElement.lang, 'en'); assert.ok(d.querySelector('meta[name=viewport]'));
  assert.ok([...d.querySelectorAll('.seg')].every((g) => g.getAttribute('role') === 'group' && (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby'))));
  assert.ok([...d.querySelectorAll('.seg button')].every((b) => b.hasAttribute('aria-pressed')));
  pg.setv('balance', '1000'); pg.setv('riskPct', '1'); pg.setv('entry', '100'); pg.setv('stop', '98'); pg.setv('tp', '106'); pg.setv('lev', '10'); pg.setv('holdSel', '8', 'change'); pg.setv('mmr', '0.5');
  assert.ok(d.querySelector('#ladder svg[role=img][aria-label]')); assert.ok(d.querySelector('#verdict[aria-live]'));
  pg.close();
});
