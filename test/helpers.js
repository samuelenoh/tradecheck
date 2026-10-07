'use strict';
/* A fake exchange network for tests. Payloads follow each exchange's documented response shapes. */
const PRICES = { BTC: 60000, ETH: 2500, SOL: 100, ARB: 1 };

function makeHttp(state) {
  const st = Object.assign({ prices: Object.assign({}, PRICES), calls: [], fail: {}, okxMultiplier: 1, blsText: null, funding: 0.0001 }, state || {});
  const coinOf = (u) => { const m = u.match(/(?:symbol=|instId=|instFamily=)([A-Z0-9]+)/); const c = m ? m[1] : 'BTC'; return c.endsWith('USDT') ? c.slice(0, -4) : c; };
  const price = (u, mult) => { const p = st.prices[coinOf(u)]; return (p == null ? 1 : p) * (mult || 1); };
  const bad = (u) => Object.keys(st.fail).some((k) => u.includes(k) && st.fail[k]);

  async function json(url) {
    st.calls.push(url);
    const hit = Object.keys(st.fail).find((k) => url.includes(k) && st.fail[k]);
    if (hit) throw new Error(typeof st.fail[hit] === 'string' ? st.fail[hit] : 'HTTP 500');
    if (url.includes('/fapi/v1/premiumIndex')) return { symbol: 'X', markPrice: String(price(url)), lastFundingRate: String(st.funding), nextFundingTime: 1 };
    if (url.includes('/fapi/v1/leverageBracket')) return [{ symbol: url.match(/symbol=([A-Z0-9]+)/)[1], brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: 100000, notionalFloor: 0, maintMarginRatio: 0.005, cum: 0 }, { bracket: 2, initialLeverage: 20, notionalCap: 1e9, notionalFloor: 100000, maintMarginRatio: 0.01, cum: 500 }] }];
    if (url.includes('/v5/market/tickers')) return { retCode: 0, result: { list: [{ markPrice: String(price(url)), fundingRate: String(st.funding), turnover24h: '1000' }] } };
    if (url.includes('/v5/market/risk-limit')) return { retCode: 0, result: { list: [{ riskLimitValue: '200000', maintenanceMargin: '0.5', mmDeduction: '', maxLeverage: '100' }, { riskLimitValue: '1000000', maintenanceMargin: '1', mmDeduction: '1000', maxLeverage: '50' }] } };
    if (url.includes('/public/mark-price')) return { code: '0', data: [{ markPx: String(price(url, st.okxMultiplier)) }] };
    if (url.includes('/public/funding-rate')) return { code: '0', data: [{ fundingRate: String(st.funding), nextFundingTime: '1' }] };
    if (url.includes('/public/position-tiers')) { const id = coinOf(url) + '-USDT-SWAP'; return { code: '0', data: [{ instId: id, tier: '1', minSz: '0', maxSz: '1000', mmr: '0.01', maxLever: '50' }, { instId: id, tier: '2', minSz: '1000', maxSz: '5000', mmr: '0.02', maxLever: '20' }] }; }
    if (url.includes('/public/instruments')) return { code: '0', data: [{ instId: coinOf(url) + '-USDT-SWAP', ctVal: '0.1', ctMult: '1', ctValCcy: coinOf(url) }] };
    throw new Error('unexpected url ' + url);
  }
  async function text(url) {
    st.calls.push(url);
    if (url.includes('bls.gov')) {
      if (Object.keys(st.fail).some((k) => url.includes(k) && st.fail[k])) throw new Error('HTTP 403');
      if (st.blsText == null) throw new Error('HTTP 404');
      return st.blsText;
    }
    throw new Error('unexpected url ' + url);
  }
  return { json, text, state: st };
}
module.exports = { makeHttp, PRICES };
