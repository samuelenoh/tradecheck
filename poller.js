'use strict';
/*
 * Poller: keeps all data fresh without anyone asking.
 *
 *  - Market jobs (mark price, funding) run every 15 s for each watched coin on each exchange.
 *  - Tier jobs (maintenance rates) run every 30 min.
 *  - The events job reads the official BLS calendar feed every 6 h and merges it with the built-in baseline.
 *  - Failures back off exponentially, the last good data is kept and labelled stale, and nothing crashes.
 *  - Data is validated before it is stored, and exchanges' prices are cross-checked against each other.
 *  - State is saved to disk, so a restart resumes with known data instead of a blank page.
 *  - Alerts (upcoming high-impact releases, failing sources, schedule running out) go to the page and,
 *    if configured, to Telegram.
 *
 * Everything time-related is injected (now, sleep, http) so the logic can be tested without a network.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const A = require('./adapters');
const BASELINE = require('./baseline');

const EXKEYS = ['binance', 'bybit', 'okx'];
const HOSTS = { binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com', okx: 'https://www.okx.com' };
const BLS_ICS = 'https://www.bls.gov/schedule/news_release/bls.ics';
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

const DEFAULTS = {
  marketMs: 15e3,
  tiersMs: 30 * 60e3,
  eventsMs: 6 * 3600e3,
  saveMs: 30e3,
  alertMs: 60e3,
  idleCoinMs: 30 * 60e3,
  marketStaleMs: 45e3,
  tiersStaleMs: 3 * 3600e3,
  minCoverageDays: 21,
  spacingMs: 100,
  maxBackoffMs: 5 * 60e3,
  alertAfterFails: 5,
  reminderMs: 30 * 60e3,
  failAlertCooldownMs: 15 * 60e3,
  jobTimeoutMs: 25e3,
  tickMs: 1000,
  maxCustomCoins: 25,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => String((e && e.message) || e);

class Poller extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.http = o.http;                 // { json(url, headers), text(url) }
    this.now = o.now || Date.now;
    this.sleep = o.sleep || wait;
    this.log = o.log || { info() {}, warn() {}, error() {} };
    this.cfg = Object.assign({}, DEFAULTS, o.intervals || {});
    this.persistPath = o.persistPath || null;
    this.key = o.binanceKey || '';
    this.secret = o.binanceSecret || '';
    this.notifier = o.notifier || null;
    this.extraIcs = o.extraIcs || [];   // [{ url, name, cat, kind, imp }]
    this.defaultCoins = (o.coins || DEFAULT_COINS).map((c) => c.toUpperCase());

    this.jobs = new Map();
    this.coins = {};                    // coin -> ex -> slot
    this.touched = {};                  // coin -> last request time
    this.dirty = new Set();
    this.groupRunning = {};
    this.timer = null;
    this.startedAt = this.now();
    this.nextSaveAt = this.startedAt + this.cfg.saveMs;
    this.nextAlertAt = this.startedAt + 5000;
    this.announced = new Set();
    this.sourceState = {};              // 'kind|exchange' -> { alerted, lastAlertAt }
    this.scheduleAlertDay = '';
    this.saveDirty = false;

    this.events = {
      list: BASELINE.events.map((e) => Object.assign({}, e, { at: Date.parse(e.t), src: 'built-in' })),
      at: 0,
      sources: { 'built-in': { ok: true, at: Date.parse(BASELINE.asOf + 'T00:00:00Z'), count: BASELINE.events.length, error: null } },
    };

    this._load();
    this.defaultCoins.forEach((c) => this.watch(c, true));
    this._addJob({ kind: 'events', ex: null, coin: null });
  }

  /* ---------- watching coins ---------- */
  watch(coin, permanent) {
    coin = String(coin).toUpperCase();
    if (!A.COIN_RE.test(coin)) throw new Error('Invalid coin symbol');
    if (!permanent && !this.defaultCoins.includes(coin) && !(coin in this.touched)) {
      const custom = Object.keys(this.touched).filter((c) => !this.defaultCoins.includes(c)).length;
      if (custom >= this.cfg.maxCustomCoins) {
        const e = new Error('too many coins are being watched; try again later'); e.code = 'TOO_MANY'; throw e;
      }
    }
    this.touched[coin] = this.now();
    EXKEYS.forEach((ex) => {
      this._addJob({ kind: 'market', ex, coin });
      this._addJob({ kind: 'tiers', ex, coin });
    });
    return coin;
  }
  _addJob(j) {
    const key = [j.kind, j.ex || '-', j.coin || '-'].join('|');
    if (this.jobs.has(key)) return this.jobs.get(key);
    const job = Object.assign({ key, nextAt: this.now(), fails: 0, lastOk: 0, lastTry: 0, lastErr: null, running: false }, j);
    this.jobs.set(key, job);
    return job;
  }
  _slot(coin, ex) {
    if (!this.coins[coin]) this.coins[coin] = {};
    if (!this.coins[coin][ex]) this.coins[coin][ex] = { market: null, marketAt: 0, tiers: null, tiersAt: 0, errors: { market: null, tiers: null }, flags: [] };
    return this.coins[coin][ex];
  }
  _reap(now) {
    for (const coin of Object.keys(this.touched)) {
      if (this.defaultCoins.includes(coin)) continue;
      if (now - this.touched[coin] > this.cfg.idleCoinMs) {
        for (const k of [...this.jobs.keys()]) if (k.endsWith('|' + coin)) this.jobs.delete(k);
        delete this.coins[coin]; delete this.touched[coin];
        this.log.info('stopped watching idle coin ' + coin);
      }
    }
  }

  /* ---------- scheduling ---------- */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log.error('tick failed: ' + msg(e))); }, this.cfg.tickMs);
    this.tick().catch((e) => this.log.error('tick failed: ' + msg(e)));
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._save(true);
  }

  /*
   * One tick: housekeeping, then start every due job. Each host has its own runner, so a slow or hung
   * host never holds up the others. Callers that do not await tick() (the interval timer) are never blocked.
   */
  async tick() {
    const now = this.now();
    this._reap(now);
    await this._maintenance(now);
    const due = [...this.jobs.values()].filter((j) => !j.running && j.nextAt <= now);
    const groups = {};
    due.forEach((j) => { const h = j.kind === 'events' ? 'events' : j.ex; (groups[h] = groups[h] || []).push(j); });
    const runs = [];
    for (const h of Object.keys(groups)) {
      if (this.groupRunning[h]) continue;     // that host is still busy with its previous batch
      this.groupRunning[h] = true;
      runs.push((async () => {
        try {
          // jobs on one host run in sequence with spacing, to respect rate limits
          for (const j of groups[h]) {
            await this._run(j);
            this._flush();
            if (this.cfg.spacingMs) await this.sleep(this.cfg.spacingMs);
          }
        } finally {
          this.groupRunning[h] = false;
        }
      })());
    }
    await Promise.all(runs);
  }
  _flush() {
    for (const coin of this.dirty) this.emit('coin', coin);
    this.dirty.clear();
  }
  async _maintenance(now) {
    if (now >= this.nextAlertAt) { this.nextAlertAt = now + this.cfg.alertMs; await this._checkAlerts(now); }
    if (now >= this.nextSaveAt) { this.nextSaveAt = now + this.cfg.saveMs; this._save(false); }
  }

  async _run(job) {
    job.running = true;
    job.lastTry = this.now();
    try {
      const exec = job.kind === 'market' ? this._doMarket(job) : job.kind === 'tiers' ? this._doTiers(job) : this._doEvents(job);
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), this.cfg.jobTimeoutMs); });
      try { await Promise.race([exec, timeout]); } finally { clearTimeout(timer); exec.catch(() => {}); }
      job.fails = 0; job.lastOk = this.now(); job.lastErr = null;
      job.nextAt = this.now() + this._interval(job.kind) + this._jitter();
    } catch (e) {
      const m = msg(e);
      job.lastErr = m;
      if (m === 'needs_api_key') {
        // expected, not a failure: Binance rates need a key. Check again at the normal interval.
        job.nextAt = this.now() + this._interval(job.kind);
        this._setError(job, m);
      } else {
        job.fails++;
        const back = Math.min(this.cfg.maxBackoffMs, this._interval(job.kind) * Math.pow(2, job.fails - 1));
        job.nextAt = this.now() + Math.max(back, 5000) + this._jitter();
        this._setError(job, m);
        this.log.warn(job.key + ' failed (' + job.fails + '): ' + m);
      }
    } finally {
      job.running = false;
    }
  }
  _interval(kind) { return kind === 'market' ? this.cfg.marketMs : kind === 'tiers' ? this.cfg.tiersMs : this.cfg.eventsMs; }
  _jitter() { return Math.floor(Math.random() * 1000); }
  _setError(job, m) {
    if (job.kind === 'events') return;
    const slot = this._slot(job.coin, job.ex);
    slot.errors[job.kind] = m;
    this.dirty.add(job.coin);
  }

  /* ---------- fetching ---------- */
  async _doMarket(job) {
    const { ex, coin } = job, s = A.symbols(coin), H = HOSTS;
    let raw;
    if (ex === 'binance') raw = A.binanceMarket(await this.http.json(H.binance + '/fapi/v1/premiumIndex?symbol=' + s.binance));
    else if (ex === 'bybit') raw = A.bybitMarket(await this.http.json(H.bybit + '/v5/market/tickers?category=linear&symbol=' + s.bybit));
    else {
      const [m, f] = await Promise.all([
        this.http.json(H.okx + '/api/v5/public/mark-price?instType=SWAP&instId=' + s.okx),
        this.http.json(H.okx + '/api/v5/public/funding-rate?instId=' + s.okx),
      ]);
      raw = A.okxMarket(m, f);
    }
    const v = A.validateMarket(raw);
    const slot = this._slot(coin, ex);
    slot.market = v.market; slot.marketAt = this.now(); slot.errors.market = null;
    slot.flags = slot.flags.filter((f) => !f.startsWith('m:')).concat(v.flags.map((f) => 'm:' + f));
    this.dirty.add(coin); this.saveDirty = true;
  }

  async _binanceBrackets(symbol) {
    const qs = 'symbol=' + symbol + '&recvWindow=5000&timestamp=' + this.now();
    const sig = crypto.createHmac('sha256', this.secret).update(qs).digest('hex');
    return this.http.json(HOSTS.binance + '/fapi/v1/leverageBracket?' + qs + '&signature=' + sig, { 'X-MBX-APIKEY': this.key });
  }
  async _doTiers(job) {
    const { ex, coin } = job, s = A.symbols(coin), H = HOSTS;
    let raw;
    if (ex === 'binance') {
      if (!(this.key && this.secret)) throw new Error('needs_api_key');
      raw = A.binanceTiers(await this._binanceBrackets(s.binance), s.binance);
    } else if (ex === 'bybit') {
      raw = A.bybitTiers(await this.http.json(H.bybit + '/v5/market/risk-limit?category=linear&symbol=' + s.bybit));
    } else {
      const [t, i] = await Promise.all([
        this.http.json(H.okx + '/api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&instFamily=' + s.okxFamily),
        this.http.json(H.okx + '/api/v5/public/instruments?instType=SWAP&instId=' + s.okx),
      ]);
      raw = A.okxTiers(t, i, s.okx, coin);
    }
    const v = A.validateTiers(raw);
    const slot = this._slot(coin, ex);
    slot.tiers = v.tiers; slot.tiersAt = this.now(); slot.errors.tiers = null;
    slot.flags = slot.flags.filter((f) => !f.startsWith('t:')).concat(v.flags.map((f) => 't:' + f));
    this.dirty.add(coin); this.saveDirty = true;
  }

  async _doEvents() {
    const sources = {};
    let live = [];
    const feeds = [{ url: BLS_ICS, name: 'bls-feed', parse: (t) => A.blsEvents(t, 'bls-feed') }].concat(
      this.extraIcs.map((f) => ({
        url: f.url, name: f.name || 'extra-feed',
        parse: (t) => A.parseICS(t).map((ev) => {
          const when = A.icsTime(ev.DTSTART);
          return { n: ev.SUMMARY ? ev.SUMMARY.value.trim() : f.name, cat: f.cat || 'Other', kind: f.kind || f.name, imp: f.imp || 'Medium', at: when.ms, src: f.name || 'extra-feed', timeAssumed: !!when.timeAssumed };
        }).filter((e) => Number.isFinite(e.at)),
      })));
    let anyOk = false;
    for (const f of feeds) {
      try {
        const text = await this.http.text(f.url);
        const evs = f.parse(text);
        if (!evs.length) throw new Error('feed had no recognisable events');
        live = live.concat(evs);
        sources[f.name] = { ok: true, at: this.now(), count: evs.length, error: null };
        anyOk = true;
      } catch (e) {
        const prev = this.events.sources[f.name];
        sources[f.name] = { ok: false, at: prev ? prev.at : 0, count: prev ? prev.count : 0, error: msg(e) };
        this.log.warn('event feed ' + f.name + ': ' + msg(e));
      }
    }
    const base = BASELINE.events.map((e) => Object.assign({}, e, { at: Date.parse(e.t), src: 'built-in' }));
    sources['built-in'] = { ok: true, at: Date.parse(BASELINE.asOf + 'T00:00:00Z'), count: base.length, error: null };
    const merged = A.mergeEvents(live, base);
    const changed = JSON.stringify(merged.map((e) => [e.n, e.at])) !== JSON.stringify(this.events.list.map((e) => [e.n, e.at]));
    this.events = { list: merged, at: this.now(), sources };
    if (changed) this.emit('events');
    this.saveDirty = true;
    if (!anyOk) throw new Error('no live event feed reachable; using built-in schedule');
  }

  /* ---------- reading ---------- */
  getCoin(coin) {
    coin = String(coin).toUpperCase();
    const now = this.now(), out = { coin, now, exchanges: {}, spread: { pct: NaN, mismatch: false } };
    const marks = {};
    EXKEYS.forEach((ex) => {
      const s = (this.coins[coin] && this.coins[coin][ex]) || { market: null, marketAt: 0, tiers: null, tiersAt: 0, errors: { market: null, tiers: null }, flags: [] };
      const mAge = s.marketAt ? now - s.marketAt : null, tAge = s.tiersAt ? now - s.tiersAt : null;
      out.exchanges[ex] = {
        market: s.market, marketAt: s.marketAt || null, marketAgeMs: mAge, marketStale: mAge == null || mAge > this.cfg.marketStaleMs,
        tiers: s.tiers, tiersAt: s.tiersAt || null, tiersAgeMs: tAge, tiersStale: tAge != null && tAge > this.cfg.tiersStaleMs,
        errors: s.errors, flags: s.flags,
        attempted: { market: !!(s.marketAt || s.errors.market), tiers: !!(s.tiersAt || s.errors.tiers) },
      };
      if (s.market && mAge != null && mAge <= this.cfg.marketStaleMs * 2) marks[ex] = s.market.mark;
    });
    out.spread = A.priceSpread(marks);
    return out;
  }
  getEvents() {
    const now = this.now();
    const end = this.events.list.length ? Math.max.apply(null, this.events.list.map((e) => e.at)) : 0;
    const daysLeft = end ? (end - now) / 86400e3 : 0;
    return { now, list: this.events.list, at: this.events.at, sources: this.events.sources, coverageEnd: end, daysLeft, needsUpdate: daysLeft < this.cfg.minCoverageDays };
  }
  /* resolves once every exchange has been tried for this coin (or the timeout passes) */
  async ensure(coin, timeoutMs) {
    coin = this.watch(coin);
    const limit = this.now() + (timeoutMs == null ? 8000 : timeoutMs);
    const pending = () => EXKEYS.some((ex) => { const a = this.getCoin(coin).exchanges[ex].attempted; return !a.market || !a.tiers; });
    if (!pending()) return this.getCoin(coin);
    for (const j of this.jobs.values()) if (j.coin === coin && !j.lastTry) j.nextAt = this.now();
    while (pending() && this.now() < limit) {
      await this.tick();
      if (!pending()) break;
      await this.sleep(150);
    }
    return this.getCoin(coin);
  }

  health() {
    const now = this.now(), by = {};
    for (const j of this.jobs.values()) {
      const id = j.kind + (j.ex ? '|' + j.ex : '');
      const b = by[id] || (by[id] = { id, kind: j.kind, ex: j.ex, jobs: 0, failing: 0, retrying: 0, lastOk: 0, lastError: null, needsKey: false });
      b.jobs++;
      if (j.lastOk > b.lastOk) b.lastOk = j.lastOk;
      if (j.lastErr === 'needs_api_key') b.needsKey = true;
      else {
        if (j.fails >= 1) { b.retrying++; b.lastError = j.lastErr; }   // a single hiccup is shown but is not "degraded"
        if (j.fails >= 3) b.failing++;
      }
    }
    const ev = this.getEvents();
    const degraded = [];
    Object.values(by).forEach((b) => {
      if (b.failing) degraded.push(b.id + ': ' + b.failing + '/' + b.jobs + ' jobs failing (' + b.lastError + ')');
    });
    // an exchange refusing this server's location is the most likely first-deploy problem, so say so plainly
    const geoSeen = {};
    for (const j of this.jobs.values()) {
      if (!j.ex || j.fails < 1 || !j.lastErr) continue;
      if (/\b451\b|restricted location|eligibility/i.test(j.lastErr)) geoSeen[j.ex] = 'refused';
      else if (/\b403\b|forbidden|region.*restrict|access.*denied/i.test(j.lastErr) && !geoSeen[j.ex]) geoSeen[j.ex] = 'maybe';
    }
    Object.keys(geoSeen).forEach((ex) => degraded.push(ex + ': ' + (geoSeen[ex] === 'refused'
      ? 'the exchange refused this server\'s location. Host the server in a region it allows, such as Frankfurt (Binance blocks the US, Canada, Malaysia and the Netherlands; Bybit blocks the US, Canada, Singapore and Hong Kong).'
      : 'access was denied (HTTP 403), which can mean this server\'s region is blocked. Try hosting in Frankfurt.')));
    // data that was once fresh but has now gone stale is reported straight away, not after repeated failures
    const staleBy = {};
    for (const coin of Object.keys(this.touched)) {
      for (const ex of EXKEYS) {
        const sl = this.coins[coin] && this.coins[coin][ex];
        if (sl && sl.marketAt && now - sl.marketAt > this.cfg.marketStaleMs) staleBy[ex] = (staleBy[ex] || 0) + 1;
      }
    }
    Object.keys(staleBy).forEach((ex) => degraded.push('market|' + ex + ': prices are stale for ' + staleBy[ex] + ' coin(s)'));
    if (ev.needsUpdate) degraded.push('event schedule ends in ' + Math.max(0, Math.floor(ev.daysLeft)) + ' days');
    const feed = ev.sources['bls-feed'];
    if (!feed || !feed.ok) degraded.push('BLS calendar feed not reachable; using built-in schedule');
    return {
      ok: true, time: now, uptimeS: Math.round((now - this.startedAt) / 1000),
      binanceTiers: !!(this.key && this.secret),
      coins: Object.keys(this.touched), jobs: Object.values(by), events: { sources: ev.sources, coverageEnd: ev.coverageEnd, daysLeft: ev.daysLeft, needsUpdate: ev.needsUpdate },
      degraded, healthy: degraded.length === 0,
    };
  }

  /* ---------- alerts ---------- */
  async _alert(type, text) {
    this.emit('alert', { type, text, at: this.now() });
    this.log.info('alert: ' + text);
    if (this.notifier) { try { await this.notifier.notify(text); } catch (e) { this.log.warn('notifier failed: ' + msg(e)); } }
  }
  async _checkAlerts(now) {
    // 1. high-impact releases coming up
    for (const e of this.events.list) {
      if (e.imp !== 'High') continue;
      const id = e.kind + '|' + e.at, rem = e.at - now;
      if (rem > 0 && rem <= this.cfg.reminderMs && !this.announced.has(id)) {
        this.announced.add(id);
        await this._alert('event', e.n + ' in ' + Math.max(1, Math.round(rem / 60000)) + ' min. Prices often move fast around releases like this.');
      }
    }
    // 2. sources failing for a while, and recovery. One message per source (not per coin), with a cooldown,
    //    so an exchange outage or a flapping connection cannot flood the chat.
    const bySource = {};
    for (const j of this.jobs.values()) {
      if (j.lastErr === 'needs_api_key') continue;
      const id = j.kind + (j.ex ? '|' + j.ex : '');
      const b = bySource[id] || (bySource[id] = { total: 0, failing: 0, err: null });
      b.total++;
      if (j.fails >= this.cfg.alertAfterFails) { b.failing++; b.err = j.lastErr; }
    }
    for (const id of Object.keys(bySource)) {
      const b = bySource[id], st = this.sourceState[id] || (this.sourceState[id] = { alerted: false, lastAlertAt: -Infinity });
      if (b.failing > 0 && !st.alerted && now - st.lastAlertAt >= this.cfg.failAlertCooldownMs) {
        st.alerted = true; st.lastAlertAt = now;
        await this._alert('health', 'Data source failing: ' + id + ' (' + b.failing + ' of ' + b.total + ' jobs). Last error: ' + b.err);
      } else if (b.failing === 0 && st.alerted) {
        st.alerted = false;
        await this._alert('health', 'Data source recovered: ' + id);
      }
    }
    // 3. event schedule running out (once a day)
    const ev = this.getEvents(), day = new Date(now).toISOString().slice(0, 10);
    if (ev.needsUpdate && this.scheduleAlertDay !== day) {
      this.scheduleAlertDay = day;
      await this._alert('health', 'The release schedule ends in ' + Math.max(0, Math.floor(ev.daysLeft)) + ' days. Update baseline.js or check the BLS feed.');
    }
  }

  /* ---------- persistence ---------- */
  _save(force) {
    if (!this.persistPath || (!force && !this.saveDirty)) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = this.persistPath + '.tmp';
      const data = JSON.stringify({ savedAt: this.now(), coins: this.coins, events: this.events }, (k, v) => (v === Infinity ? null : v));
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.persistPath);
      this.saveDirty = false;
    } catch (e) {
      if (!this._saveWarned) { this._saveWarned = true; this.log.warn('could not save state: ' + msg(e)); }
    }
  }
  _load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      const fix = (t) => { if (t && t.tiers) t.tiers.forEach((x) => { if (x.cap == null) x.cap = Infinity; }); return t; };
      for (const coin of Object.keys(j.coins || {})) {
        for (const ex of Object.keys(j.coins[coin])) { const s = j.coins[coin][ex]; fix(s.tiers); }
      }
      this.coins = {};
      for (const c of Object.keys(j.coins || {})) if (this.defaultCoins.includes(c)) this.coins[c] = j.coins[c];  // custom coins start fresh
      // keep loaded events only if they extend past the built-in list; the first events job refreshes them anyway
      if (j.events && Array.isArray(j.events.list) && j.events.list.length) this.events = j.events;
      this.log.info('restored saved state from ' + new Date(j.savedAt).toISOString());
    } catch (e) {
      this.log.warn('ignoring unreadable saved state: ' + msg(e));
    }
  }
}

module.exports = { Poller, DEFAULTS, DEFAULT_COINS, HOSTS, BLS_ICS };
