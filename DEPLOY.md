# Hosting Trade check

Free tiers change often. Everything below was researched on **7 Oct 2026** from public pricing pages and
comparison articles, some of which disagree with each other. Check the platform's own pricing page before you
sign up.

## What this server needs from a host

1. **Always on.** The server polls prices every 15 seconds and sends alerts. A host that puts it to sleep when
   nobody visits breaks that, and the page opens on stale data.
2. **Outbound internet access to the exchanges, from a region they allow.** This is the one that catches people.
   Exchanges decide by the server's IP address, not by who you are:
   - **Binance** blocks API access from servers in the US, Canada, Malaysia and the Netherlands (a list its own
     users describe as non-exhaustive; see "b. Eligibility" in Binance's terms). A blocked server gets HTTP 451.
   - **Bybit** excludes the US, Canada, Singapore, Hong Kong and mainland China, among others.
   - **OKX:** I did not find a verified list. Check its terms.
   - So: **host in Frankfurt (Germany)** or another central European region. Avoid the US, Canada, Singapore and
     the Netherlands.
3. **Small.** The server uses roughly the memory of a basic web page script. The smallest plan is enough.

## Which free host

| Platform | Always on? | Card needed? | Verdict |
|---|---|---|---|
| **Northflank (Sandbox)** | Yes, "no sleeping" on the free plan | Yes, to verify; not charged unless you upgrade | **Best fit.** 2 free services, 2 cron jobs, 1 database. Has a Frankfurt region. Northflank's own docs say the free plan is for hobby projects, not production. |
| Render (free) | No: sleeps after 15 min idle | No | Not suitable: polling and alerts stop whenever it sleeps. |
| Railway | Yes | No for the trial | Not really free: a $5 credit for 30 days, then about $1 a month of credit. |
| Koyeb | Sources disagree | Reported to need a card hold since Feb 2026 | Its free tier changed in 2026 and reports conflict (one says it scales to zero after an hour idle, another says it closed). Not recommended. |
| Fly.io | n/a | Yes | Reported to no longer have a real free allowance. |
| Oracle Cloud (Always Free) | Yes (a full VM) | Yes | Good fallback if you are comfortable with a Linux server. Its free ARM allowance was reported cut in half in June 2026, and free capacity can be hard to get. |

I did not verify whether Northflank's **free** plan can use the Frankfurt region, or which instance sizes it
allows. The region list and the plan sizes (from 0.1 vCPU and 0.25 GB) are published, but the free-plan limits are
shown only when you create the service. If Frankfurt is not offered on the free plan, see "If the region is
blocked" below.

## Before you deploy: choose a password

The server can be opened by anyone who finds its address. Set `ACCESS_PASSWORD` (at least 10 characters). Then:

- every page and data request asks for the password (user name `trader`, or set `ACCESS_USER`);
- 10 wrong guesses lock that visitor out for 10 minutes, even if the next guess is right;
- each visitor is limited to 120 data requests a minute and 5 live streams;
- only `/healthz` is open, so the platform can check the server is alive. It reveals nothing.

If you add a Binance key, the server **refuses to start** on a public address without a password.

## Deploy on Northflank (about 15 minutes)

You do these steps; nothing here can be done for you, because they need your accounts and card.

**1. Put the code on GitHub.** Create a new repository (private is fine), then upload everything in the project
folder. The web page for a new repository has an "uploading an existing file" link, so you do not need git.
Do not upload a `.env` file or any key.

**2. Create a Northflank account** at northflank.com and verify with a card when asked. Northflank states you
are not charged unless you upgrade. Do not upgrade.

**3. Create a project.** Choose the managed cloud and the region **Europe - West - Frankfurt**
(`europe-west-frankfurt`). Do not choose Netherlands, a US region, Canada or Singapore.

**4. Add a service from your repository.** Choose a combined (build and deploy) service from your GitHub repo.
The screens may be worded a little differently:

| Setting | Value |
|---|---|
| Build | Dockerfile, at the repository root |
| Port | `8787`, protocol HTTP, **public** |
| Resources | The smallest plan offered on the free sandbox |
| Instances | 1 |
| Health check | HTTP, path `/healthz`, port `8787` |

**5. Add runtime variables** (mark the password as a secret):

| Variable | Value |
|---|---|
| `ACCESS_PASSWORD` | a long password only you know |
| `TRUST_PROXY` | `1` |
| `HTTP_USER_AGENT` | `tradecheck/1.0 (contact: your-email@example.com)` (the BLS asks callers to identify themselves) |

Leave the Binance and Telegram variables out for now. Add them later if you want them.

**6. Deploy.** Northflank builds the image and starts it. When it is running, open the public address it shows
(an `https://` link). Your browser asks for the user name `trader` and your password.

## Check it works (5 minutes)

Open `https://YOUR-ADDRESS/api/health` (it asks for the password). After a minute or two:

- [ ] `"degraded": []` or an empty list. If it mentions a region or a 451, go to the next section.
- [ ] `"coins"` lists your seven default coins.
- [ ] On the page the data strip shows **Live stream** and each exchange shows rates and prices a few seconds old.
- [ ] `/api/events` includes entries with `"src":"bls-feed"`. If none appear, the built-in schedule is being used;
  the feed's format may need a small adjustment (see README).
- [ ] Spot-check: enter the same position on the page and in the exchange's own calculator. The liquidation prices
  should agree closely.

## If the region is blocked

If `/api/health` says an exchange "refused this server's location", or a data-source badge on the page stays red:

1. Check which region the service is in. If it is not Frankfurt (or another allowed region), create the project
   again in Frankfurt.
2. If Frankfurt is not offered on the free plan, try Zurich (`europe-west-zurich`) or London.
3. Still blocked, or no free European region at all: use the VM fallback below.

## Fallback: a free VM (Oracle Cloud, Always Free)

This route is more work and **I have not tested these commands**. In Oracle Cloud, create a free VM in a
Frankfurt region with Ubuntu, open port 8787 in its network rules, then on the VM:

```
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
git clone https://github.com/YOUR-NAME/YOUR-REPO.git tradecheck && cd tradecheck
printf 'ACCESS_PASSWORD=your-long-password\nTRUST_PROXY=0\n' > .env
sudo docker compose up -d
```

Then open `http://VM-ADDRESS:8787`. This is plain HTTP, so your password travels unencrypted. Put it behind a
free HTTPS proxy such as Caddy with a domain before real use, and set `TRUST_PROXY=1`.

## Keeping it running

- **Updates:** push to GitHub and Northflank rebuilds. GitHub also runs the tests on every push (the workflow in
  `.github/workflows/ci.yml`).
- **State:** free plans have no disk, so saved state is lost on restart. That is fine: data refetches within
  seconds, and custom coins are re-requested when you open the page.
- **Limits to watch:** Northflank's free plan reports about 10 GB of outbound traffic a month. A few open pages
  use very little, but leave it unshared.
- **Alerts:** to get release reminders and "data source failing" messages on your phone, create a Telegram bot and
  add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- **Binance rates:** to turn on live Binance maintenance rates, create a **read-only** Binance API key (no trading,
  no withdrawals), restrict it to your server's outbound IP if Northflank gives you one, and add
  `BINANCE_API_KEY` and `BINANCE_API_SECRET`. Only do this with `ACCESS_PASSWORD` set.

## What I could not do

I cannot create your accounts, enter your card, or press deploy: those need you. I also could not run Docker or
reach the platforms from where I built this, so the Dockerfile was checked by starting the server from the same file
list, but `docker build` itself was not run.

## Sources checked on 7 Oct 2026

Northflank pricing and region pages; comparison articles on free hosting from September 2026 and earlier;
Binance geo-restriction notes (freqtrade documentation and a Binance Futures hosting guide); Bybit
restricted-country summaries dated 2026.
