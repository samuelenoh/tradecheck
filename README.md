# Trade check: a futures plan tester that keeps itself up to date

Sizes your position, calculates liquidation with each exchange's own formula (Binance, Bybit, OKX),
and checks the plan before you trade. The server refreshes all of its data on its own.

## Hosting it online

See **DEPLOY.md**: which free hosts work (it has to be always-on and in a region the exchanges allow, such as
Frankfurt), exact settings, and a checklist. Set `ACCESS_PASSWORD` before putting it on the internet.

## Run it

Requires Node 18 or newer. No packages to install.

```
node server.js          # then open http://127.0.0.1:8787
```

Or unattended, restarting after crashes and reboots:

```
docker compose up -d
```

Optional settings (environment variables):

| Variable | What it does |
|---|---|
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | Turns on live Binance maintenance rates. Use a **read-only** key (no trading, no withdrawals), restricted to your server's IP. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Sends alerts to Telegram (see "Alerts"). |
| `COINS` | Coins always watched, comma separated. Default `BTC,ETH,SOL,XRP,DOGE,BNB,HYPE`. |
| `HTTP_USER_AGENT` | Identify yourself to data providers. The BLS asks for this. Put a contact address in it. |
| `EXTRA_ICS` | JSON list of extra calendar feeds: `[{"url":"…","name":"…","cat":"Fed","kind":"fomc","imp":"High"}]`. |
| `ACCESS_PASSWORD`, `ACCESS_USER` | Password-protects everything except `/healthz`. At least 10 characters. 10 wrong guesses lock a visitor out for 10 minutes. |
| `TRUST_PROXY` | How many reverse proxies sit in front (hosting platforms: `1`), so visitor limits use the real address. |
| `PORT`, `HOST`, `DATA_DIR` | Listen address and where saved state lives (default `127.0.0.1:8787`, `./data`). |

## What runs by itself

| Job | How often | What it does |
|---|---|---|
| Prices and funding | every 15 s, per coin and exchange | Mark price and funding rate from each exchange. |
| Maintenance rates | every 30 min | Rate tiers and leverage limits (Bybit and OKX public; Binance with a key). |
| Release calendar | every 6 h | Reads the official BLS calendar feed and merges it with the built-in Fed and PCE schedule. |
| Alerts check | every 60 s | Release reminders, failing sources, schedule running out. |
| Save to disk | every 30 s | So a restart picks up where it left off. |

The server pushes every update to open pages over a live stream (Server-Sent Events), so nobody has to
refresh. If the stream is blocked, the page falls back to polling every 15 s. Coins other than the default
ones are picked up the first time someone asks for them and dropped after 30 minutes of nobody watching.

### How it keeps going

- **Failures back off, nothing crashes.** A failing source retries with growing delays (up to 5 min).
  The last good value is kept and labelled with its age, never silently replaced.
- **Stale data is flagged, not trusted.** Prices older than 45 s and rates older than 3 h show as stale
  on the page and trigger a check warning.
- **Bad data is rejected.** Non-positive prices, absurd funding rates (over 5% per interval), unordered or
  out-of-range tiers, and a missing coin are caught before they are stored.
- **Exchanges are cross-checked.** If mark prices for one coin differ by more than 1% between exchanges
  (a sign of different contracts under one symbol), the page warns.
- **State survives restarts.** Data is saved atomically to `DATA_DIR/state.json`.
- **Unexpected errors are logged, not fatal,** and Docker restarts the process if it ever exits.
  `/api/health` reports every source, and the container has a health check.
- **The schedule watches itself.** The release calendar reports how many days it still covers and warns
  (page, log and Telegram) when fewer than 21 days remain.

## What the page does for a trader

- Sizes the position so a stop-loss hit costs exactly the risk you chose, fees included.
- Calculates liquidation per exchange and checks that your stop comes first, with a safety gap.
- Shows live mark price and funding for all three exchanges, with the age of each number.
- Checks risk per trade, margin used, reward versus risk, funding cost while you hold, and leverage limits.
- Warns before big US releases (CPI, jobs, FOMC) that fall inside your holding time.
- **Watch this trade:** once connected, the page follows the live mark price and alerts you as it nears or
  reaches your stop-loss, take-profit or liquidation level, and 30 minutes before high-impact releases.
  Browser notifications work while the page stays open.

## Alerts

With a Telegram bot configured, the server sends: a reminder 30 minutes before each high-impact release,
one message per data source (not per coin) when it has failed five times in a row and another when it
recovers, at most one failure message per source every 15 minutes, and a daily message when the release
schedule is nearly out. Without Telegram the same alerts appear on the page.

## What comes from where

| Data | Binance | Bybit | OKX |
|---|---|---|---|
| Mark price and funding | public | public | public |
| Maintenance rate tiers | **needs a read-only key** | public | public |
| Fees | published regular rate, editable | same | same |

Published regular-tier futures fees (checked against fee guides dated September 2026): Binance 0.02% maker /
0.05% taker, Bybit 0.02% / 0.055%, OKX 0.02% / 0.05%. Your account may pay less.

Endpoints: Binance `/fapi/v1/premiumIndex`, `/fapi/v1/leverageBracket` · Bybit `/v5/market/tickers`,
`/v5/market/risk-limit` · OKX `/api/v5/public/mark-price`, `funding-rate`, `position-tiers`, `instruments` ·
BLS `https://www.bls.gov/schedule/news_release/bls.ics`.

## Nothing is made up

There are no sample values anywhere. If a real rate is missing the page shows "Not loaded" and does not
calculate liquidation for that exchange. The built-in schedule in `baseline.js` is official data with its
sources noted, used as the safety net when the live calendar feed is unreachable.

## What has been tested

Run `node --test`. For the page and end-to-end tests install the optional test tool first
(`npm install`); without it those 13 tests are skipped, not failed. 72 tests in total.

- **Maths.** Position size, take-profit gain and liquidation price for all three exchanges are checked
  against an independent solver (it finds the price where account equity equals maintenance margin by
  bisection, instead of using the closed-form formulas the page uses) on 300 random plans, about 900
  liquidation prices, with random multi-tier rate tables. Bybit's own worked example reproduces exactly.
  An earlier 600-plan run found no mismatches either.
- **Data engine.** Scheduling, back-off, keeping the last good value, staleness, validation, cross-exchange
  price checks, calendar parsing (including clock changes), alerts and their cooldown, saving and restoring
  state (including a corrupted or unwritable file), and one hung source not stalling the others.
- **Server.** Path traversal and malformed or hostile requests, the Content-Security-Policy, stream limits,
  the custom-coin limit, and the live stream.
- **Public hosting.** Password protection (including the lockout and the live stream), per-visitor limits,
  forged forwarding headers, the open `/healthz` probe, the refusal to start with a Binance key on an open
  address, and the plain-language message when an exchange blocks the server's region.
- **Page.** Nothing pre-filled; hostile text from the server shown as text, never run; 880 screens of garbage
  input with no NaN, Infinity or undefined; invalid plans rejected; funding signs; watch alerts for longs and
  shorts; stale-data and price-disagreement warnings; release windows; accessibility basics.
- **End to end.** The real server and the real page over real HTTP: prices and funding change upstream and
  appear on the page by themselves, switching coins, the server restarting mid-session (the page reconnects),
  and an upstream outage (the last values stay, health reports it, recovery is automatic).
- **Stability.** Six simulated hours with 26 coins and random outages ran with no crashes, no unhandled errors,
  no memory growth (0.5 MB over 113,000 polls), and the data fresh throughout normal conditions.

All of this ran against **simulated** exchanges and a simulated BLS feed, shaped like each provider's
documentation.

## Not yet verified (needs your first real run)

The environment this was built in could not reach the real exchanges, the BLS site, Telegram, Docker, or a
real browser. So these have **not** been tested:

1. **The real exchange responses.** OKX tier sizes are assumed to be in contracts (converted with
   `ctVal × ctMult`). Compare one tier with OKX's trading-rules page.
2. **The real BLS feed format.** The reader follows standard iCalendar and keeps only CPI, the national jobs
   report and PPI. Open `/api/events`: entries with `"src":"bls-feed"` should appear. If the titles differ,
   adjust `classifyBLS` in `adapters.js`; the built-in schedule keeps working in the meantime.
3. **Telegram delivery.** The request is built to Telegram's documented format and tested against a fake,
   not a real bot.
4. **The Docker image.** `docker-compose.yml` is valid and the image's file list was checked by booting the
   server from exactly those files, but `docker build` itself was not run.
5. **How the page looks.** Layout, colours, spacing and phone screens were not viewed in a real browser.
6. **Spot-check each exchange.** Enter the same position here and in the exchange's own calculator.
   `/api/health` should list no `degraded` items after a minute or two.

## Known limits

- Isolated margin and one-way mode only. Funding is assumed to settle every 8 hours.
- At most 25 coins beyond the default seven are watched at once (a guard against flooding the exchanges);
  further requests get a "try again later" answer, and idle coins are dropped after 30 minutes.
- Fed and PCE dates come from the built-in list (the Fed and BEA were not available as machine-readable
  feeds I could verify). Add one with `EXTRA_ICS` if you have a feed, or update `baseline.js` and the copy
  in `public/index.html`; a test fails if the two differ.
- Crypto-specific events (token unlocks, expiries) are not included: no verified source.
- Alerts about your own trade work while the page is open. The Telegram alerts cover releases and data
  health, not your individual trades.
- The page escapes all text from outside and the server sends a strict Content-Security-Policy. Set
  `ACCESS_PASSWORD` before exposing it. It uses HTTP Basic authentication, which is only safe over HTTPS
  (hosting platforms provide it).

## Files

`server.js` (HTTP and live stream) · `poller.js` (the scheduler) · `adapters.js` (exchange and calendar parsers,
validation) · `notifier.js` (Telegram) · `baseline.js` (built-in schedule) · `public/index.html` (the page) ·
`test/` · `Dockerfile`, `docker-compose.yml`
