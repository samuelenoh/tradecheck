'use strict';
/*
 * These tests use MOCK payloads shaped like each exchange's documented response.
 * The numbers are made up. They prove the conversion logic, not that live endpoints match.
 * Run:  node --test
 */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../adapters');

test('symbols builds each exchange symbol and rejects bad input', () => {
  const s = A.symbols('ETH');
  assert.strictEqual(s.binance, 'ETHUSDT');
  assert.strictEqual(s.bybit, 'ETHUSDT');
  assert.strictEqual(s.okx, 'ETH-USDT-SWAP');
  assert.strictEqual(s.okxFamily, 'ETH-USDT');
  assert.throws(() => A.symbols('eth&x=1'));
  assert.throws(() => A.symbols('../'));
});

test('binanceTiers maps brackets (doc-shaped payload)', () => {
  const json = [{
    symbol: 'ETHUSDT',
    brackets: [
      { bracket: 1, initialLeverage: 75, notionalCap: 10000, notionalFloor: 0, maintMarginRatio: 0.0065, cum: 0 },
      { bracket: 2, initialLeverage: 50, notionalCap: 50000, notionalFloor: 10000, maintMarginRatio: 0.01, cum: 35 },
    ],
  }];
  const t = A.binanceTiers(json, 'ETHUSDT');
  assert.strictEqual(t.unit, 'notional');
  assert.deepStrictEqual(t.tiers[0], { cap: 10000, mmr: 0.0065, cum: 0, maxLev: 75 });
  assert.strictEqual(t.tiers[1].cap, Infinity); // last tier is open-ended
  assert.strictEqual(t.tiers[1].cum, 35);
  assert.throws(() => A.binanceTiers(json, 'BTCUSDT'));
});

test('bybitTiers converts percent numbers and empty deductions', () => {
  const json = { retCode: 0, retMsg: 'OK', result: { list: [
    { id: 1, symbol: 'ETHUSDT', riskLimitValue: '200000', maintenanceMargin: '0.5', initialMargin: '1', maxLeverage: '100.00', mmDeduction: '' },
    { id: 2, symbol: 'ETHUSDT', riskLimitValue: '400000', maintenanceMargin: '1', initialMargin: '2', maxLeverage: '50.00', mmDeduction: '1000' },
  ] } };
  const t = A.bybitTiers(json);
  assert.strictEqual(t.tiers[0].mmr, 0.005);
  assert.strictEqual(t.tiers[0].cum, 0);
  assert.strictEqual(t.tiers[0].cap, 200000);
  assert.strictEqual(t.tiers[1].mmr, 0.01);
  assert.strictEqual(t.tiers[1].cum, 1000);
  assert.throws(() => A.bybitTiers({ retCode: 10001, retMsg: 'params error' }));
});

test('okxTiers converts contract sizes to coins', () => {
  const tiers = { code: '0', msg: '', data: [
    { instType: 'SWAP', tdMode: 'isolated', instId: 'ETH-USDT-SWAP', tier: '1', minSz: '0', maxSz: '1000', imr: '0.1', mmr: '0.05', maxLever: '10' },
    { instType: 'SWAP', tdMode: 'isolated', instId: 'ETH-USDT-SWAP', tier: '2', minSz: '1000', maxSz: '5000', imr: '0.2', mmr: '0.1', maxLever: '5' },
  ] };
  const inst = { code: '0', data: [{ instId: 'ETH-USDT-SWAP', ctVal: '0.1', ctMult: '1', ctValCcy: 'ETH' }] };
  const t = A.okxTiers(tiers, inst, 'ETH-USDT-SWAP', 'ETH');
  assert.strictEqual(t.unit, 'qty');
  assert.strictEqual(t.tiers[0].cap, 100); // 1000 contracts x 0.1 ETH
  assert.strictEqual(t.tiers[0].mmr, 0.05);
  assert.strictEqual(t.tiers[1].cap, Infinity);
  assert.match(t.unitNote, /contracts/);
  assert.throws(() => A.okxTiers(tiers, { code: '0', data: [{ instId: 'ETH-USDT-SWAP', ctVal: '1', ctMult: '1', ctValCcy: 'USD' }] }, 'ETH-USDT-SWAP', 'ETH'));
  assert.throws(() => A.okxTiers({ code: '51001', msg: 'Instrument ID does not exist', data: [] }, inst, 'ETH-USDT-SWAP', 'ETH'));
});

test('market adapters return mark and funding in percent', () => {
  const b = A.binanceMarket({ symbol: 'ETHUSDT', markPrice: '2500.50', lastFundingRate: '0.00010000', nextFundingTime: 1700000000000 });
  assert.strictEqual(b.mark, 2500.5);
  assert.ok(Math.abs(b.funding - 0.01) < 1e-9);

  const y = A.bybitMarket({ retCode: 0, result: { list: [{ symbol: 'ETHUSDT', markPrice: '2500.4', fundingRate: '0.0001', turnover24h: '123456' }] } });
  assert.strictEqual(y.mark, 2500.4);
  assert.ok(Math.abs(y.funding - 0.01) < 1e-9);
  assert.strictEqual(y.volume24h, 123456);

  const o = A.okxMarket(
    { code: '0', data: [{ instId: 'ETH-USDT-SWAP', markPx: '2500.3' }] },
    { code: '0', data: [{ instId: 'ETH-USDT-SWAP', fundingRate: '0.0001', nextFundingTime: '1700000000000' }] });
  assert.strictEqual(o.mark, 2500.3);
  assert.ok(Math.abs(o.funding - 0.01) < 1e-9);
});

test('validateMarket rejects bad prices and drops absurd funding', () => {
  assert.throws(() => A.validateMarket({ mark: 0, funding: 0.01 }));
  assert.throws(() => A.validateMarket({ mark: NaN, funding: 0.01 }));
  const ok = A.validateMarket({ mark: 100, funding: 0.01 });
  assert.deepStrictEqual(ok.flags, []);
  const bad = A.validateMarket({ mark: 100, funding: 900 });
  assert.ok(Number.isNaN(bad.market.funding));
  assert.deepStrictEqual(bad.flags, ['funding_out_of_range']);
});

test('validateTiers enforces order and sane rates', () => {
  const good = { unit: 'notional', tiers: [{ cap: 10, mmr: 0.005 }, { cap: Infinity, mmr: 0.01 }] };
  assert.deepStrictEqual(A.validateTiers(good).flags, []);
  assert.throws(() => A.validateTiers({ tiers: [] }));
  assert.throws(() => A.validateTiers({ tiers: [{ cap: 10, mmr: 0.9 }] }));
  assert.throws(() => A.validateTiers({ tiers: [{ cap: 10, mmr: 0.01 }, { cap: 5, mmr: 0.02 }] }));
  assert.deepStrictEqual(A.validateTiers({ tiers: [{ cap: 10, mmr: 0.02 }, { cap: 20, mmr: 0.01 }] }).flags, ['rate_decreases_with_size']);
});

test('priceSpread flags exchanges that disagree', () => {
  assert.strictEqual(A.priceSpread({ binance: 100, bybit: 100.2, okx: 99.9 }).mismatch, false);
  const m = A.priceSpread({ binance: 100, bybit: 100, okx: 1000 });
  assert.strictEqual(m.mismatch, true);
  assert.ok(m.pct > 800);
  assert.strictEqual(A.priceSpread({ binance: 100 }).mismatch, false);
});

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261014T083000', 'SUMMARY:Consumer Price Index for', '  September 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261106', 'SUMMARY:Employment Situation for October 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261120T083000', 'SUMMARY:Employment Situation - October 2026 (state and local)', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261110T133000Z', 'SUMMARY:Producer Price Index for October 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261201T100000', 'SUMMARY:Import and Export Price Indexes', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseICS unfolds lines and reads parameters', () => {
  const evs = A.parseICS(ICS);
  assert.strictEqual(evs.length, 5);
  assert.strictEqual(evs[0].SUMMARY.value, 'Consumer Price Index for September 2026');
  assert.strictEqual(evs[0].DTSTART.params.TZID, 'America/New_York');
});

test('blsEvents keeps only market-moving releases and converts time zones', () => {
  const evs = A.blsEvents(ICS, 'bls-feed');
  const kinds = evs.map((e) => e.kind).sort();
  assert.deepStrictEqual(kinds, ['cpi', 'jobs', 'ppi']); // state/local jobs and import prices are ignored
  const cpi = evs.find((e) => e.kind === 'cpi');
  assert.strictEqual(new Date(cpi.at).toISOString(), '2026-10-14T12:30:00.000Z'); // 08:30 EDT
  assert.strictEqual(cpi.timeAssumed, false);
  const jobs = evs.find((e) => e.kind === 'jobs');
  assert.strictEqual(new Date(jobs.at).toISOString(), '2026-11-06T13:30:00.000Z'); // date-only: 08:30 EST assumed
  assert.strictEqual(jobs.timeAssumed, true);
  const ppi = evs.find((e) => e.kind === 'ppi');
  assert.strictEqual(new Date(ppi.at).toISOString(), '2026-11-10T13:30:00.000Z'); // explicit UTC
});

test('mergeEvents lets live entries replace baseline ones for the same release', () => {
  const base = [
    { n: 'base CPI', kind: 'cpi', at: Date.parse('2026-10-14T12:30:00Z') },
    { n: 'base FOMC', kind: 'fomc', at: Date.parse('2026-10-28T18:00:00Z') },
  ];
  const live = [{ n: 'live CPI', kind: 'cpi', at: Date.parse('2026-10-14T12:30:00Z') }];
  const merged = A.mergeEvents(live, base);
  assert.deepStrictEqual(merged.map((e) => e.n), ['live CPI', 'base FOMC']);
  // a moved date keeps both until the baseline is updated, so a rescheduled release is not lost
  const moved = A.mergeEvents([{ n: 'live CPI', kind: 'cpi', at: Date.parse('2026-10-15T12:30:00Z') }], base);
  assert.strictEqual(moved.length, 3);
});
