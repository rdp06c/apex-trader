# APEX – Scorecard-Guided Manual Trading Dashboard

APEX is a single-page trading dashboard that screens ~540 stocks across 14 sectors, scores them with a composite scoring engine, and surfaces actionable signals via a candidate scorecard. The user makes all buy/sell decisions manually, guided by the scorecard and trade insights. Uses Massive (formerly Polygon.io) for market data. No framework. No cash/budget concept — portfolio return is based on cost basis of invested capital.

## Project Structure

```
src/
  styles.css        ← All CSS
  body.html         ← HTML body content
  trader.js         ← All JavaScript
  template.html     ← Skeleton HTML with placeholders
server/
  index.js          ← Express server entry point (port 4000)
  admin.js          ← Admin panel (status, logs, actions)
  auto-pull.sh      ← Auto-pull from GitHub main every 5 min (cron)
  api/
    portfolio.js    ← GET/POST /api/portfolio with atomic file writes
  lib/
    scoring.js      ← Extracted pure scoring functions for server-side use
    fetchers.js     ← Massive API wrappers for Node.js
    stocks.js       ← Shared stock universe (stockNames, stockSectors, getAllSymbols)
  scanner/
    monitor.js      ← Background scanner + full scan scheduler
    full-scan.js    ← Full market scan orchestrator (~540 stocks)
    alerts.js       ← ntfy.sh alert integration
  data/
    portfolio.json  ← Server-side portfolio storage (gitignored)
    backups/        ← Last 5 portfolio saves (gitignored)
    scanner-state.json ← Scanner readings and alert history (gitignored)
    scan-state.json ← Full scan results and top scorers (gitignored)
build.cmd / build.sh  ← Build scripts
index.html            ← Generated output (DO NOT EDIT DIRECTLY)
package.json          ← Express, node-cron dependencies
.env.example          ← Template for server config
```

**Build:** Edit `src/` files, then run `bash build.sh`. Assembles template + CSS + HTML + JS → `index.html`. Output is committed.

## Architecture

```
Raspberry Pi (Express server, port 4000)
├── GET/POST /api/portfolio     ← Server-side portfolio storage (JSON file)
├── GET /api/scanner/status     ← Scanner health check
├── GET /admin                  ← Admin panel (status, logs, actions)
├── Static files (index.html)   ← Built dashboard
├── Background scanner (cron)   ← Structure monitoring every 15 min
│   ├── ntfy.sh alerts          ← Push notifications on breakdown
│   └── Full market scan        ← Scores ~540 stocks at 9:35 AM + 12:30 PM ET
├── Cloudflare Tunnel           ← Remote access (trycloudflare.com URL)
├── Auto-pull (cron)            ← Pulls from GitHub main every 5 min
└── Basic auth                  ← Password protection via .env

Browser (index.html)
├── portfolioStorage adapter    ← Server-first with localStorage fallback
├── Massive API                 ← Market data (snapshots, bars, details, etc.)
├── Cloudflare Worker proxy     ← Anthropic API (chat only)
├── Google Drive API            ← Optional backup/restore
└── localStorage                ← Market data caches, API keys
```

**Key design**: The `portfolioStorage` adapter auto-detects whether a server is available. If no server (e.g., opened as a local file), it falls back to localStorage. Dashboard works in both modes with zero config.

## Deployment

**Pi deployment** (primary):
1. Clone repo, `npm install`
2. Copy `.env.example` to `.env`, fill in `MASSIVE_API_KEY`, `NTFY_TOPIC`, `AUTH_USER`, `AUTH_PASS`
3. `npm start` — serves on port 4000
4. Systemd services: `apex.service` (server), `apex-tunnel.service` (Cloudflare tunnel)
5. Cron: `auto-pull.sh` runs every 5 min, pulls from `main`, rebuilds and restarts if source files changed

**Remote access**: Cloudflare named tunnel at `https://dash.arc-apex.com`. Configured via `~/.cloudflared/config.yml` on Pi. Basic auth protects all routes.

**Update workflow**: Push to `main` on GitHub → Pi auto-pulls within 5 min → rebuilds → restarts → ntfy notification confirms. Or use "Pull & Restart" button on admin panel for immediate update.

## Core Workflow

1. **Scan Market** — fetches prices, ~65-day OHLCV bars, ticker details, short interest, server indicators (RSI, MACD, SMA50), VIX for ~540 stocks across 14 sectors. Populates all caches. Server indicators fetched for ALL stocks (no cap). Auto-refreshes UI (holding cards, portfolio metrics) on completion — no manual "Refresh Prices" needed.
2. **Score** — `calculateCompositeScore` produces weighted sum of ~15 components (momentum, RS, structure, RSI, MACD, pullback, extension, etc.) with entry quality multiplier
3. **Candidate Scorecard** — full universe displayed with sortable, color-coded columns: Sig (entry signal badge), Heat (combo heat dots), Score, Price, Day%, 5D, MOM, VOL, RS, RSI, MACD, Structure, DTC, Sector, MCap. All columns sortable (click header to toggle asc/desc). Sector filter dropdown. Paginated (40 per page). Entry signal filter checkbox.
4. **Manual Trade** — user enters buy/sell via modal. Same-day trades auto-capture all live signals from caches (run Scan Market first for richest data).
5. **Trade Insights** — derived rules, performance summary, signal accuracy table, signal combinations (from calibration), regime history — all computed from `closedTrades` and calibration data

## Manual Trade System

All trades are entered manually via the Manual Trade modal (`openManualTradeModal`, `submitManualTrade`).

**Buy path:**
- Fetches ~65-day historical bars for the entry date
- Reconstructs signals via `reconstructSignals()`: RSI, MACD, SMA, structure, momentum, 5D return, volume trend
- Enriches with live cache data: RS, sector rotation, DTC, market cap, composite score, VIX, volume ratio, news sentiment, price vs VWAP
- Records transaction with full `entryTechnicals`, creates `holdingTheses` entry
- **Tip:** Run Scan Market before entering buys to populate all caches for maximum signal capture

**Sell path:**
- Gets `getCurrentPositionBuys()` BEFORE pushing sell transaction (critical ordering)
- Computes P&L, return%, hold time from matched buy transactions
- Auto-classifies exit reason (profit_target, stop_loss, catalyst_failure, manual)
- Pushes to `closedTrades` for Trade Insights analytics

**Undo Last Trade** (`undoLastTrade`):
- Appears after any manual buy/sell, disappears on page reload or Scan Market
- Reverses cash, holdings, closedTrades, holdingTheses changes
- Confirms before executing

## Key Subsystems

**Composite Scoring** (`calculateCompositeScore`): ~15 weighted components. Weights in `DEFAULT_WEIGHTS`, calibratable. `getActiveWeights()` selects regime-aware weights (VIX < 20 vs ≥ 20). Returns `{total, breakdown}` for tooltip decomposition.

**Market Structure** (`detectStructure`): ICT/SMC analysis — swing highs/lows, CHoCH, BOS, liquidity sweeps, FVGs on ~65-day bars. Only takes `symbol` param, reads from `multiDayCache[symbol]`.

**Calibration Engine** (`runCalibrationSweep`): Sweeps 40 historical dates, runs full pipeline, correlates scoring components with forward returns, derives calibrated weights with shrinkage. Regime-segmented. Out-of-sample validated. Chat command: `calibrate`. Also runs signal combo analysis (`analyzeSignalCombos`) — tests 18 curated signal combinations against ~21K observations to discover which combos predict positive/negative 10-day forward returns vs baseline.

**Entry Signals & Combo Heat**: Two complementary scorecard systems:
- `ENTRY_SIGNAL_PATTERNS` + `evaluateEntrySignals()` — data-driven pattern matching (currently: reversal entry with 4 criteria). Shows Sig badge (ENTRY/3/4/2/4).
- `SIGNAL_COMBO_DEFS` + `evaluateComboHeat()` — tests each stock's current signals against 18 combos, cross-references calibration results to show green dots (hot combos) and red dots (cold combos) in the Heat column. Requires calibration data to function.
- Score driver badge (S/M) indicates whether a stock's score is signal-driven or momentum-driven.

**Holdings Health**: Holdings cards show a compact inline stat line (MOM, RS with entry→current arrows, RSI, MACD, Structure, DTC, CHoCH, Vol, Stop/Target levels) and a footer row (Cost, Now, Entry, News count with tooltip). Sell/profit signals display as a centered badge in the card header. Cards are sortable by Date Added, Total P&L%, Daily Change%, Position Size, or Health (with ascending/descending toggle). Custom themed dropdown replaces native `<select>` for dark mode compatibility.

**Trade Insights** (`updateLearningInsightsDisplay`): Renders in the Trade Insights section (expanded by default). Shows:
- Trading rules derived from `deriveTradingRules()` — patterns that work/don't work
- Performance summary — W/L record, avg win/loss, profit factor, recent trend
- Signal accuracy table — win rate and avg return by signal condition (momentum, RS, RSI, MACD, structure, DTC, VIX, etc.)
- Signal combinations — hot/cold combo tables from calibration backtesting with "Show all" toggle
- Regime history — current regime, transitions, near-transition win rate

**Trade History** (`updateTradeHistory`): Table of all closed trades sorted most-recent-first. Shows symbol, buy/sell dates, shares, P&L, return%, hold time.

**Chat Interface** (`sendMessage`): Conversational with portfolio context. Gated behind activation button. Special commands: `calibrate`, `backtest YYYY-MM-DD`. Uses Cloudflare Worker proxy to Claude API.

**Google Drive**: OAuth 2.0 backup/restore. Optional — Pi server is the primary storage now.

## Background Scanner

Runs on the Pi via `server/scanner/monitor.js`. Two modes:

### Structure Monitor
Checks structure on all held positions every 15 minutes during market hours. Can also be triggered manually from the admin panel (bypasses market hours check).

**Alert conditions:**
- Entry structure was bullish, current is bearish → "Structure Breakdown"
- Bearish CHoCH detected → "Bearish CHoCH"
- Price below stop price (if set in holding thesis) → "Stop Loss Breached"
- Bearish volume divergence detected → "Volume Divergence"

**Loss signals** (computed per holding, displayed on admin panel): ATR stop, bearish CHoCH, bearish structure, thesis stop breached, RS collapse (>30pt drop), momentum collapse (entry 7+ → now <3), structure flip, volume divergence.

**Deduplication:** Same condition for same symbol won't re-alert within 4 hours.

### Full Market Scan
Runs the complete scoring pipeline on all ~540 stocks server-side. Scheduled at **9:35 AM ET** (5 min after open) and **12:30 PM ET** (midday update). Can also be triggered from the admin panel via "Run Full Scan" button.

**Pipeline:** Fetches bulk snapshots, ~65-day grouped daily bars (80 API calls), server indicators (RSI/MACD/SMA50), ticker details, short interest, VIX → computes momentum, RS, structure, sector rotation, composite score for every stock → saves results to `portfolio.json` as `lastCandidateScores`.

**Browser integration:** The browser's Candidate Scorecard automatically picks up server scan results on next portfolio load. A "server scan" tag appears in the scorecard header when displaying server-generated data. Manual browser scans still work independently and override the server data.

**Resource impact:** ~80 grouped daily API calls + ~540×3 indicator calls + ~540 ticker detail calls. Takes 2-5 minutes on the Pi. Sends ntfy notification with top 5 scorers on completion.

**Alert delivery:** POST to ntfy.sh topic (configured via `NTFY_TOPIC` in `.env`).

### Extracted Server Functions
Stock universe in `server/lib/stocks.js` (stockNames, stockSectors, getAllSymbols). When adding/removing stocks, update BOTH `server/lib/stocks.js` and `src/trader.js`.

Scoring in `server/lib/scoring.js`: all pure scoring functions adapted to accept data as params. Fetching in `server/lib/fetchers.js`: all Massive API wrappers for Node.js. Duplication with client accepted because client runs in a `<script>` tag and cannot import Node modules.

## Admin Panel

Available at `/admin` (linked from dashboard header nav). Shows:
- Server uptime, market status, last scanner run, last full scan, total alerts sent, stocks scored
- Top scorers from last full scan (symbol, score, price)
- Scanner readings for each holding (price, structure, RSI, MACD, CHoCH, loss signal count with warnings)
- Action buttons: "Pull & Restart" (triggers auto-pull.sh), "Run Scanner Now" (structure check), "Run Full Scan" (~540 stock scan)
- Log viewers: server logs (journalctl), auto-pull logs

## Portfolio Storage

**Primary:** `server/data/portfolio.json` on Pi. Read/written via `/api/portfolio` endpoints. Atomic writes (tmp file + rename). Last 5 saves kept as timestamped backups in `server/data/backups/`.

**Fallback:** localStorage in browser (`aiTradingPortfolio` key). Always written as backup alongside server saves.

**Restore:** `POST /api/portfolio/restore/:filename` restores from a backup. Google Drive restore still works from the browser.

**`portfolioStorage` adapter** (in `src/trader.js`): Probes `/api/portfolio` on first load. If server responds, uses server for all reads/writes. If not (e.g., opened as local file), falls back to localStorage. Browser always saves to both.

## Design Constraints

**Single HTML Output**: Build produces one `index.html` — intentional for portability. Source split across `src/` for development.

**After-Hours Pricing**: `isMarketOpen()` checks ET timezone. When market is closed, price priority is `day.c > lastTrade.p`; when open, `lastTrade.p > day.c`. Change calculations recomputed from scratch when closed (Polygon's pre-computed values include extended-hours movement).

**XSS Prevention**: All user content escaped via `escapeHtml()` before `innerHTML` insertion.

**Massive API**: Stocks Advanced + Indices Basic plan — unlimited calls (recommended <100 req/s). Caching is for performance, not rate limits.

**Bulk Snapshot Cache**: `fetchBulkSnapshot()` uses a 15-second cache. Cache hit requires ALL requested symbols present (`symbols.every`), and new fetches merge via `Object.assign` (not overwrite).

**Basic Auth**: Configured via `AUTH_USER` and `AUTH_PASS` in `.env`. Protects all routes (dashboard, API, admin). Disabled if not set.

## Portfolio Metrics

**Total Return** = Realized P&L (sum of closedTrades.profitLoss) + Unrealized P&L (current holdings value − cost basis). Percentage based on current cost basis. No cash/budget concept — `portfolio.cash` is legacy.

**Alpha vs SPY** = Total Return % − SPY return % (from `spyBaseline` price). Same realized + unrealized formula.

**Cost Basis**: Computed via `getCurrentPositionBuys()` which tracks buys for the current position (after any full exit/re-entry).

## Portfolio State

Persisted to Pi server (with localStorage fallback). Key fields: `holdings`, `transactions`, `closedTrades`, `holdingTheses`, `performanceHistory`, `lastMarketRegime`, `lastCandidateScores`, `lastSectorRotation`, `lastVIX`, `regimeHistory`, `portfolioHealth`. Array caps on save: transactions (500), closedTrades (300), performanceHistory (3000).

## Known Issues

- **Technical indicators dual source**: Client-side RSI/MACD are approximations from ~65-day bars. Server values (`serverRsi`, `serverMacd`, `serverSma50`) use full history and are fetched for all stocks during Scan Market. Client for scoring, server for display.
- **Keyboard accessibility**: Collapsible sections use `<div onclick>` — should migrate to `<button>` with proper roles
- **FVG detection partial**: Detected and scored (±0.5) but not used in reversal filtering
- **RS not reconstructable**: Relative strength requires full market context at time of entry. For historical manual trades, RS is null unless cached from a prior Scan Market.
- **Tunnel**: Permanent domain `dash.arc-apex.com` via Cloudflare named tunnel. No URL changes on reboot.

## Legacy AI Code

The codebase still contains the two-phase AI analysis system (`runAIAnalysis`, Phase 1/Phase 2 prompts, `executeSingleTrade`, `executeMultipleTrades`, budget/risk controls). This code is not actively used — the "Run AI Analysis" button has been removed. The chat interface still uses the Cloudflare Worker proxy for conversational queries.

## Stock Universe

~540 stocks across 14 sectors: Technology, Automotive, Financial, Healthcare, Consumer, Energy, Industrials, Real Estate, Materials, Defense, Space, Crypto, Index Fund. **Four** lists must stay in sync when adding/removing stocks:
1. `stockNames` in `src/trader.js` — display names
2. `stockSectors` in `src/trader.js` — sector classification
3. `screenStocks()` in `src/trader.js` — scan list (sector-grouped arrays, deduplicated)
4. `server/lib/stocks.js` — server-side mirror (stockNames, stockSectors, getAllSymbols)

Coverage includes: AI/software, semiconductors, cybersecurity, biotech/genomics, digital health, EV/auto, fintech/payments, crypto-adjacent, space/satellite, drones/eVTOL, infrastructure/data center, materials/mining, defense contractors, REITs, and more.

## Development Notes

- Edit `src/`, rebuild with `bash build.sh`. **Never edit `index.html` directly.**
- Test with "Scan Market" button (fetches market data and updates scorecard without AI)
- `let`/`const` throughout, `async/await` throughout
- Extensive console logging
- Push to `main` → Pi auto-pulls within 5 min, or use admin panel "Pull & Restart"
- Server files in `server/` — these run on the Pi only, not in the browser
- Scoring functions duplicated between `src/trader.js` (browser) and `server/lib/scoring.js` (Node.js) — keep in sync. Includes `evaluateEntrySignals` and `ENTRY_SIGNAL_PATTERNS`.
- Stock lists duplicated between `src/trader.js` and `server/lib/stocks.js` — keep in sync
