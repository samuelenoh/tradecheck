'use strict';
/*
 * Adapters: turn each exchange's public API response into one common shape.
 *
 * Common tier shape:   { unit: 'notional' | 'qty', tiers: [{ cap, mmr, cum, maxLev }] }
 *   cap     upper bound of the tier (USDT notional, or coin quantity when unit = 'qty')
 *   mmr     maintenance margin rate as a fraction (0.005 = 0.5%)
 *   cum     maintenance amount / deduction in USDT (0 when the exchange has none)
 *   maxLev  maximum leverage allowed in that tier
 *
 * Common market shape: { mark, funding }
 *   mark     mark price
 *   funding  latest funding rate in PERCENT for one funding interval (0.01 = 0.01%)
 *
 * Response shapes follow each exchange's published API documentation:
 *   Binance  GET /fapi/v1/leverageBracket (signed), GET /fapi/v1/premiumIndex
 *   Bybit    GET /v5/market/risk-limit,            GET /v5/market/tickers
 *   OKX      GET /api/v5/public/position-tiers, /public/instruments, /public/mark-price, /public/funding-rate
 */

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

const COIN_RE = /^[A-Z0-9]{2,12}$/;
const EXCHANGES = ['binance', 'bybit', 'okx'];

function symbols(coin) {
  if (!COIN_RE.test(coin)) throw new Error('Invalid coin symbol');
  return {
    binance: coin + 'USDT',
    bybit: coin + 'USDT',
    okx: coin + '-USDT-SWAP',
    okxFamily: coin + '-USDT',
  };
}

function finishTiers(unit, tiers, extra) {
  const clean = tiers
    .filter((t) => Number.isFinite(t.mmr) && t.mmr > 0)
    .sort((a, b) => a.cap - b.cap);
  if (!clean.length) throw new Error('No usable tiers in response');
  // The last tier has no upper bound for our purposes.
  clean[clean.length - 1].cap = Infinity;
  return Object.assign({ unit, tiers: clean }, extra || {});
}

/* Binance: array of { symbol, brackets:[{ notionalCap, maintMarginRatio, cum, initialLeverage }] } */
function binanceTiers(json, symbol) {
  const arr = Array.isArray(json) ? json : [json];
  const item = arr.find((x) => x && x.symbol === symbol);
  if (!item || !Array.isArray(item.brackets) || !item.brackets.length) {
    throw new Error('Binance: no brackets for ' + symbol);
  }
  const tiers = item.brackets.map((b) => ({
    cap: num(b.notionalCap),
    mmr: num(b.maintMarginRatio),
    cum: num(b.cum) || 0,
    maxLev: num(b.initialLeverage),
  }));
  return finishTiers('notional', tiers);
}

function binanceMarket(json) {
  const j = Array.isArray(json) ? json[0] : json;
  const mark = num(j && j.markPrice);
  if (!Number.isFinite(mark)) throw new Error('Binance: no mark price');
  return { mark, funding: num(j.lastFundingRate) * 100, nextFundingTime: num(j.nextFundingTime) || null };
}

/* Bybit: { retCode, result:{ list:[{ riskLimitValue, maintenanceMargin (percent), mmDeduction, maxLeverage }] } } */
function bybitTiers(json) {
  if (!json || json.retCode !== 0) throw new Error('Bybit: ' + ((json && json.retMsg) || 'bad response'));
  const list = json.result && json.result.list;
  if (!Array.isArray(list) || !list.length) throw new Error('Bybit: empty risk limit list');
  const tiers = list.map((t) => ({
    cap: num(t.riskLimitValue),
    mmr: num(t.maintenanceMargin) / 100, // Bybit reports a percent number, e.g. "0.5" = 0.5%
    cum: num(t.mmDeduction) || 0, // empty string means no deduction
    maxLev: num(t.maxLeverage),
  }));
  return finishTiers('notional', tiers);
}

function bybitMarket(json) {
  if (!json || json.retCode !== 0) throw new Error('Bybit: ' + ((json && json.retMsg) || 'bad response'));
  const t = json.result && json.result.list && json.result.list[0];
  const mark = num(t && t.markPrice);
  if (!Number.isFinite(mark)) throw new Error('Bybit: no mark price');
  return { mark, funding: num(t.fundingRate) * 100, volume24h: num(t.turnover24h) || null, nextFundingTime: num(t.nextFundingTime) || null };
}

/* OKX: { code:'0', data:[...] } */
function okxCheck(json, label) {
  if (!json || json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error('OKX ' + label + ': ' + ((json && json.msg) || 'bad response'));
  }
  return json.data;
}

/* Coins per contract = ctVal x ctMult (linear swaps are quoted in the base coin). */
function okxContractSize(instJson, instId, baseCoin) {
  const inst = okxCheck(instJson, 'instruments').find((i) => i.instId === instId) || okxCheck(instJson, 'instruments')[0];
  if (!inst) throw new Error('OKX: instrument not found');
  const size = num(inst.ctVal) * (num(inst.ctMult) || 1);
  if (!(size > 0)) throw new Error('OKX: bad contract size');
  if (inst.ctValCcy && inst.ctValCcy !== baseCoin) throw new Error('OKX: contract is not valued in ' + baseCoin);
  return size;
}

/*
 * OKX tier sizes (minSz / maxSz) are assumed to be in CONTRACTS for swaps and are converted to coins.
 * This assumption is flagged in the response (unitNote) and must be checked on the first live run.
 */
function okxTiers(tiersJson, instJson, instId, baseCoin) {
  const coinsPerContract = okxContractSize(instJson, instId, baseCoin);
  const rows = okxCheck(tiersJson, 'position-tiers').filter((t) => !t.instId || t.instId === instId);
  if (!rows.length) throw new Error('OKX: no tiers for ' + instId);
  const tiers = rows.map((t) => ({
    cap: t.maxSz === '' || t.maxSz == null ? Infinity : num(t.maxSz) * coinsPerContract,
    mmr: num(t.mmr),
    cum: 0,
    maxLev: num(t.maxLever),
  }));
  return finishTiers('qty', tiers, {
    unitNote: 'OKX tier sizes treated as contracts (' + coinsPerContract + ' ' + baseCoin + ' each). Verify on first live run.',
  });
}

function okxMarket(markJson, fundJson) {
  const m = okxCheck(markJson, 'mark-price')[0];
  const f = okxCheck(fundJson, 'funding-rate')[0];
  const mark = num(m && m.markPx);
  if (!Number.isFinite(mark)) throw new Error('OKX: no mark price');
  return { mark, funding: num(f && f.fundingRate) * 100, nextFundingTime: num(f && f.nextFundingTime) || null };
}


/* ===================== data sanity checks ===================== */

/* Returns the market object (possibly with a bad funding value removed) plus flags. Throws on unusable data. */
function validateMarket(m) {
  const flags = [];
  if (!m || !Number.isFinite(m.mark) || !(m.mark > 0)) throw new Error('invalid mark price');
  const out = Object.assign({}, m);
  if (!Number.isFinite(out.funding) || Math.abs(out.funding) > 5) {
    // a funding rate beyond 5% per interval is almost certainly a parsing or unit error
    flags.push('funding_out_of_range');
    out.funding = NaN;
  }
  return { market: out, flags };
}

/* Tiers must be non-empty, sorted, with sensible rates. Returns flags; throws if unusable. */
function validateTiers(t) {
  const flags = [];
  if (!t || !Array.isArray(t.tiers) || !t.tiers.length) throw new Error('no tiers');
  let prevCap = -Infinity, prevMmr = 0;
  for (const x of t.tiers) {
    if (!(x.mmr > 0 && x.mmr <= 0.5)) throw new Error('tier rate out of range: ' + x.mmr);
    if (!(x.cap > prevCap)) throw new Error('tiers not in ascending order');
    if (x.mmr < prevMmr) flags.push('rate_decreases_with_size');
    prevCap = x.cap; prevMmr = x.mmr;
  }
  return { tiers: t, flags };
}

/* Perpetual mark prices for the same coin should sit close together. A big gap usually means the exchanges
 * list different contracts under one symbol (for example a 1000x version). */
function priceSpread(marksByExchange) {
  const vals = Object.values(marksByExchange).filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 2) return { pct: NaN, mismatch: false };
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const pct = (hi / lo - 1) * 100;
  return { pct, mismatch: pct > 1 };
}

/* ===================== calendar feeds (iCalendar) ===================== */

function unfoldICS(text) { return String(text).replace(/\r?\n[ \t]/g, ''); }

function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of unfoldICS(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...paramParts] = line.slice(0, i).split(';');
    const params = {};
    paramParts.forEach((x) => { const [k, v] = x.split('='); params[(k || '').toUpperCase()] = v; });
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params };
  }
  return events;
}

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}
function zonedToUtc(Y, M, D, h, mi, s, tz) {
  const wall = Date.UTC(Y, M, D, h, mi, s);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(guess, tz);
  return guess;
}
function zoneName(tzid) {
  if (!tzid || /new_york|eastern/i.test(tzid)) return 'America/New_York';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tzid }); return tzid; } catch (e) { return 'America/New_York'; }
}
/* date-only events have no time, so US releases are assumed to be 08:30 Eastern. The flag says so. */
function icsTime(prop) {
  if (!prop) return { ms: NaN };
  const m = String(prop.value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return { ms: NaN };
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (h === undefined) return { ms: zonedToUtc(+Y, +Mo - 1, +D, 8, 30, 0, 'America/New_York'), timeAssumed: true };
  if (z === 'Z') return { ms: Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s) };
  return { ms: zonedToUtc(+Y, +Mo - 1, +D, +h, +mi, +s, zoneName(prop.params && prop.params.TZID)) };
}

/* Which BLS releases matter, by the official title. Anything else is ignored. */
function classifyBLS(summary) {
  const s = String(summary || '');
  if (/consumer price index/i.test(s) && !/average price|metropolitan|regional|area/i.test(s)) return { cat: 'Inflation', kind: 'cpi', imp: 'High' };
  if (/employment situation/i.test(s) && !/state|local|metropolitan/i.test(s)) return { cat: 'Jobs', kind: 'jobs', imp: 'High' };
  if (/producer price index/i.test(s)) return { cat: 'Inflation', kind: 'ppi', imp: 'Medium' };
  return null;
}

function blsEvents(icsText, source) {
  const out = [];
  for (const ev of parseICS(icsText)) {
    const summary = ev.SUMMARY && ev.SUMMARY.value;
    const cls = classifyBLS(summary);
    if (!cls) continue;
    const when = icsTime(ev.DTSTART);
    if (!Number.isFinite(when.ms)) continue;
    out.push({ n: String(summary).replace(/\\,/g, ',').trim(), cat: cls.cat, kind: cls.kind, imp: cls.imp, at: when.ms, src: source || 'bls-feed', timeAssumed: !!when.timeAssumed });
  }
  return out;
}

/* Eastern-time calendar date, used to match the same release across sources. */
function etDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/* Live entries replace baseline entries of the same kind on the same Eastern date. */
function mergeEvents(live, baseline) {
  const seen = new Set(live.map((e) => e.kind + '|' + etDate(e.at)));
  const base = baseline.filter((e) => !seen.has(e.kind + '|' + etDate(e.at)));
  return live.concat(base).sort((a, b) => a.at - b.at);
}

module.exports = {
  EXCHANGES, symbols, COIN_RE,
  binanceTiers, binanceMarket, bybitTiers, bybitMarket, okxTiers, okxMarket, okxContractSize,
  validateMarket, validateTiers, priceSpread,
  parseICS, icsTime, classifyBLS, blsEvents, etDate, mergeEvents, zonedToUtc,
};
