# APEX – Portfolio Monitoring Dashboard

APEX is a single-page portfolio monitoring dashboard for tracking holdings, entering manual trades, and reviewing performance. Uses Massive (formerly Polygon.io) for real-time market data. No framework. No cash/budget concept — portfolio return is based on cost basis of invested capital.

**v2 redesign** (March 2026): Stripped from a full trading/scanning dashboard to a focused portfolio monitor. Scanning, scoring, signals, AI, chat, calibration, Google Drive, and analytics pages were removed. The full v1 codebase is preserved at the `v1-stable` git tag.

## Project Structure

```
src/
  styles.css        <- All CSS
  body.html         <- HTML body content
  trader.js         <- All JavaScript (~2,300 lines)
  template.html     <- Skeleton HTML with placeholders
server/
  index.js          <- Express server entry point (port 4000)
  admin.js          <- Admin panel (uptime, logs, pull & restart)
  auto-pull.sh      <- Auto-pull from GitHub main every 5 min (cron)
  api/
    portfolio.js    <- GET/POST /api/portfolio with atomic file writes
  lib/
    stocks.js       <- Stock universe (stockNames, stockSectors, getAllSymbols)
  data/
    portfolio.json  <- Server-side portfolio storage (gitignored)
    backups/        <- Last 5 portfolio saves (gitignored)
monitor.html          <- Holdings monitor (standalone, auto-refresh prices)
watchlist.html        <- Watchlist tracker (standalone, auto-refresh prices)
build.cmd / build.sh  <- Build scripts
index.html            <- Generated output (DO NOT EDIT DIRECTLY)
package.json          <- Express dependencies
.env.example          <- Template for server config
```

**Build:** Edit `src/` files, then run `bash build.sh`. Assembles template + CSS + HTML + JS -> `index.html`. Output is committed.

## Architecture

```
Raspberry Pi (Express server, port 4000)
|-- GET/POST /api/portfolio     <- Server-side portfolio storage (JSON file)
|-- GET /api/config             <- Serves Polygon API key to authenticated browsers
|-- GET /api/stocks             <- Stock names for monitor/watchlist pages
|-- GET /monitor                <- Holdings monitor (auto-refresh prices)
|-- GET /watchlist              <- Watchlist tracker (auto-refresh prices)
|-- GET /admin                  <- Admin panel (uptime, logs, pull & restart)
|-- Static files (index.html)   <- Built dashboard
|-- Cloudflare Tunnel           <- Remote access (dash.arc-apex.com)
|-- Auto-pull (cron)            <- Pulls from GitHub main every 5 min
+-- Basic auth                  <- Password protection via .env

Browser (index.html)
|-- portfolioStorage adapter    <- Server-first with localStorage fallback
|-- Massive API                 <- Market data (bulk snapshots for held symbols)
+-- localStorage                <- Price cache, API key
```

**Key design**: The `portfolioStorage` adapter auto-detects whether a server is available. If no server (e.g., opened as a local file), it falls back to localStorage. Dashboard works in both modes with zero config.

## Deployment

**Pi deployment** (primary):
1. Clone repo, `npm install`
2. Copy `.env.example` to `.env`, fill in `MASSIVE_API_KEY`, `AUTH_USER`, `AUTH_PASS`
3. `npm start` — serves on port 4000
4. Systemd services: `apex.service` (server), `apex-tunnel.service` (Cloudflare tunnel)
5. Cron: `auto-pull.sh` runs every 5 min, pulls from `main`, rebuilds and restarts if source files changed

**Remote access**: Cloudflare named tunnel at `https://dash.arc-apex.com`. Basic auth protects all routes.

**Update workflow**: Push to `main` on GitHub -> Pi auto-pulls within 5 min -> rebuilds -> restarts. Or use "Pull & Restart" button on admin panel for immediate update.

## Core Workflow

1. **Refresh Prices** — fetches bulk snapshot from Massive API for all held symbols. Updates holdings cards, portfolio metrics, and charts.
2. **Manual Trade** — user enters buy/sell via modal with symbol, shares, price, date, and optional reason.
3. **Review Performance** — Performance Analytics cards (Total Return, Daily Performance, Win Rate, Alpha vs SPY, Best/Worst Trade, Avg Hold Time, Total Trades), Portfolio Returns chart, Sector Allocation chart, Trade History table.

## Manual Trade System

All trades are entered manually via the Manual Trade modal (`openManualTradeModal`, `submitManualTrade`).

**Buy path:**
- Fetches ~65-day historical bars for the entry date
- Reconstructs basic signals via `reconstructSignals()`: RSI, MACD, SMA, momentum
- Records transaction with minimal `entryTechnicals`, creates `holdingTheses` entry (stop at -10%, target at +10%)

**Sell path:**
- Gets `getCurrentPositionBuys()` BEFORE pushing sell transaction (critical ordering)
- Computes P&L, return%, hold time from matched buy transactions
- Auto-classifies exit reason (profit_target, stop_loss, catalyst_failure, manual)
- Pushes to `closedTrades` for Trade History

**Undo Last Trade** (`undoLastTrade`):
- Appears after any manual buy/sell, disappears on page reload
- Reverses holdings, closedTrades, holdingTheses changes
- Confirms before executing

## Daily P&L Calculation

Daily P&L correctly handles intraday position adds by splitting shares into "bought today" vs "bought before today":
- **Prior shares**: daily P&L = per-share change from previous close x shares
- **Today's shares**: daily P&L = (current price - entry price) x shares
- This prevents overstating losses/gains when adding to a position on a volatile day

This logic exists in both `updateUI()` (main dashboard) and `computeHoldings()` (monitor page).

## Holdings Cards

Each holding displays:
- **Header**: Symbol, name (linked to stockanalysis.com), sector, shares, days held, portfolio %
- **Values**: Current value, total P&L ($ and %), daily P&L ($ and %)
- **Stats**: Stop (-10% from avg cost), Target (+10% from avg cost)
- **Footer**: Entry date, cost basis, current price

Cards are sortable by Date Added, Total P&L%, Daily Change%, Position Size, or Symbol (ascending/descending toggle).

## Holdings Monitor (`monitor.html`)

Standalone lightweight page for monitoring current holdings with auto-refreshing prices. Fetches portfolio from server (localStorage fallback) and API key from `/api/config` (localStorage fallback). Uses a single bulk snapshot API call for only held symbols.

**Auto-refresh:** Every 30 seconds during market hours. No refresh when market is closed (loads once). Pauses when browser tab is hidden (Page Visibility API), resumes on tab focus.

**Summary cards:** Holdings Value, Day P&L ($ and %), Unrealized P&L ($ and %), Position count with W/L breakdown.

**Table columns:** Symbol, Price, Day%, Day P&L, P&L%, Value, Stop (-10%), Target (+10%), Days (trading days). All columns sortable. Risk-level row highlighting (danger/caution/healthy). Price flash animation on change.

## Watchlist (`watchlist.html`)

Standalone page for tracking symbols of interest without holding them. Same auto-refresh pattern as monitor.html (30s during market hours, pause when hidden/closed).

**Data:** Stored in `portfolio.watchlist` as `[{symbol, addedAt, addedPrice}]`. Legacy string-array format auto-migrated on first load.

**Add:** Text input on the page. Fetches current price from Polygon on add (client-side), snapshots it as `addedPrice`. Invalid symbols rejected (no Polygon data = no add).

**Remove:** X button per row. Saves portfolio immediately.

**Table columns:** Symbol (with name), Price, Day%, Since Added (%), Added date. All columns sortable.

**Summary cards:** Watching (count), Winners (return > 0), Losers (return < 0).

## Admin Panel

Available at `/admin`. Shows:
- Server uptime
- Portfolio health (holdings count, transactions, closed trades, backups)
- Action buttons: "Pull & Restart" (triggers auto-pull.sh)
- Log viewers: server logs (journalctl), auto-pull logs

## Portfolio Storage

**Primary:** `server/data/portfolio.json` on Pi. Read/written via `/api/portfolio` endpoints. Atomic writes (tmp file + rename). Last 5 saves kept as timestamped backups in `server/data/backups/`.

**Fallback:** localStorage in browser (`aiTradingPortfolio` key). Always written as backup alongside server saves.

**Restore:** `POST /api/portfolio/restore/:filename` restores from a backup. Local file restore available from Account Controls.

**`portfolioStorage` adapter** (in `src/trader.js`): Probes `/api/portfolio` on first load. If server responds, uses server for all reads/writes. If not (e.g., opened as local file), falls back to localStorage.

## Design Constraints

**Single HTML Output**: Build produces one `index.html` — intentional for portability. Source split across `src/` for development.

**After-Hours Pricing**: `isMarketOpen()` checks ET timezone. When market is closed, price priority is `day.c > lastTrade.p`; when open, `lastTrade.p > day.c`. Change calculations recomputed from scratch when closed (Polygon's pre-computed values include extended-hours movement).

**XSS Prevention**: All user content escaped via `escapeHtml()` before `innerHTML` insertion.

**Massive API**: Stocks Advanced + Indices Basic plan — unlimited calls (recommended <100 req/s). Caching is for performance, not rate limits.

**Bulk Snapshot Cache**: `fetchBulkSnapshot()` uses a 15-second cache. Cache hit requires ALL requested symbols present (`symbols.every`), and new fetches merge via `Object.assign` (not overwrite).

**Basic Auth**: Configured via `AUTH_USER` and `AUTH_PASS` in `.env`. Protects all routes (dashboard, API, admin). Disabled if not set.

## Portfolio Metrics

**Total Return** = Realized P&L (sum of closedTrades.profitLoss) + Unrealized P&L (current holdings value - cost basis). Percentage based on current cost basis. No cash/budget concept — `portfolio.cash` is legacy.

**Alpha vs SPY** = Total Return % - SPY return % (from `spyBaseline` price). Same realized + unrealized formula.

**Cost Basis**: Computed via `getCurrentPositionBuys()` which tracks buys for the current position (after any full exit/re-entry).

## Performance History & Chart

**Portfolio Returns chart** plots `totalReturnPct` over time against SPY, QQQ, and DIA benchmarks.

**Reconstruction migration**: When trades are entered with historical dates, a one-time migration (`_perfHistoryReconstructed`) walks transactions chronologically, tracks running holdings lots and realized P&L, and builds snapshots at each transaction date using cost basis as the value approximation (no historical market prices available). Going forward, `updateUI()` appends actual market-value snapshots every 15 minutes.

## Portfolio State

Persisted to Pi server (with localStorage fallback). Key fields: `holdings`, `transactions`, `closedTrades`, `holdingTheses`, `performanceHistory`. Legacy fields kept for backward compatibility: `lastMarketRegime`, `lastCandidateScores`, `lastSectorRotation`, `lastVIX`, `holdSnapshots`, `regimeHistory`. Array caps on save: transactions (500), closedTrades (300), performanceHistory (3000).

## Stock Universe

`stockNames` and `stockSectors` dictionaries in `src/trader.js` provide display names and sector labels for ~1020 stocks. `server/lib/stocks.js` mirrors these for server-side use. Holdings can include symbols outside this universe — they'll display the ticker as the name and "Unknown" as the sector.

## Development Notes

- Edit `src/`, rebuild with `bash build.sh`. **Never edit `index.html` directly.**
- `let`/`const` throughout, `async/await` throughout
- Push to `main` -> Pi auto-pulls within 5 min, or use admin panel "Pull & Restart"
- Server files in `server/` — these run on the Pi only, not in the browser
- Stock lists in `src/trader.js` and `server/lib/stocks.js` — keep in sync when adding stocks
- The v1 codebase (scanning, scoring, signals, AI, chat, analytics) is preserved at git tag `v1-stable`
