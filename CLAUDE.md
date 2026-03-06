# APEX – Scorecard-Guided Manual Trading Dashboard

APEX is a single-page trading dashboard that screens ~537 stocks across 14 sectors, scores them with a composite scoring engine, and surfaces actionable signals via a candidate scorecard. The user makes all buy/sell decisions manually, guided by the scorecard and trade insights. Uses Massive (formerly Polygon.io) for market data. No framework, no backend beyond a Cloudflare Worker for optional AI chat. No cash/budget concept — portfolio return is based on cost basis of invested capital.

## Project Structure

```
src/
  styles.css        ← All CSS
  body.html         ← HTML body content
  trader.js         ← All JavaScript
  template.html     ← Skeleton HTML with placeholders
build.cmd / build.sh  ← Build scripts
index.html            ← Generated output (DO NOT EDIT DIRECTLY)
```

**Build:** Edit `src/` files, then run `bash build.sh`. Assembles template + CSS + HTML + JS → `index.html`. Output is committed for GitHub Pages.

## Architecture

```
Browser (index.html)
  ├── Massive API → Market data (snapshots, bars, ticker details, short interest, news, VIX)
  ├── Cloudflare Worker proxy → Anthropic API (chat only, not trading decisions)
  ├── Google Drive API → Portfolio backup/restore, encrypted API key sync
  └── localStorage → Portfolio state, price cache, API keys
```

## Core Workflow

1. **Scan Market** — fetches prices, ~65-day OHLCV bars, ticker details, short interest, server indicators (RSI, MACD, SMA50), VIX for ~537 stocks across 14 sectors. Populates all caches. Server indicators fetched for ALL stocks (no cap).
2. **Score** — `calculateCompositeScore` produces weighted sum of ~15 components (momentum, RS, structure, RSI, MACD, pullback, extension, etc.) with entry quality multiplier
3. **Candidate Scorecard** — full universe displayed with sortable, color-coded columns: Score, Price, Day%, 5D, MOM, VOL, RS, RSI, MACD, Structure, DTC, Sector, MCap. Click column headers to sort. Sector filter dropdown. Paginated (40 per page).
4. **Manual Trade** — user enters buy/sell via modal. Same-day trades auto-capture all live signals from caches (run Scan Market first for richest data).
5. **Trade Insights** — derived rules, performance summary, signal accuracy table, regime history — all computed from `closedTrades`

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

**Calibration Engine** (`runCalibrationSweep`): Sweeps 40 historical dates, runs full pipeline, correlates scoring components with forward returns, derives calibrated weights with shrinkage. Regime-segmented. Out-of-sample validated. Chat command: `calibrate`.

**Trade Insights** (`updateLearningInsightsDisplay`): Renders in the Trade Insights section (expanded by default). Shows:
- Trading rules derived from `deriveTradingRules()` — patterns that work/don't work
- Performance summary — W/L record, avg win/loss, profit factor, recent trend
- Signal accuracy table — win rate and avg return by signal condition (momentum, RS, RSI, MACD, structure, DTC, VIX, etc.)
- Regime history — current regime, transitions, near-transition win rate

**Trade History** (`updateTradeHistory`): Table of all closed trades sorted most-recent-first. Shows symbol, buy/sell dates, shares, P&L, return%, hold time.

**Chat Interface** (`sendMessage`): Conversational with portfolio context. Gated behind activation button. Special commands: `calibrate`, `backtest YYYY-MM-DD`. Uses Cloudflare Worker proxy to Claude API.

**Google Drive**: OAuth 2.0 backup/restore, encrypted API key sync.

## Design Constraints

**Single HTML Output**: Build produces one `index.html` — intentional for portability. Source split across `src/` for development.

**After-Hours Pricing**: `isMarketOpen()` checks ET timezone. When market is closed, price priority is `day.c > lastTrade.p`; when open, `lastTrade.p > day.c`. Change calculations recomputed from scratch when closed (Polygon's pre-computed values include extended-hours movement).

**XSS Prevention**: All user content escaped via `escapeHtml()` before `innerHTML` insertion.

**Massive API**: Stocks Advanced + Indices Basic plan — unlimited calls (recommended <100 req/s). Caching is for performance, not rate limits.

**Bulk Snapshot Cache**: `fetchBulkSnapshot()` uses a 15-second cache. Cache hit requires ALL requested symbols present (`symbols.every`), and new fetches merge via `Object.assign` (not overwrite).

## Portfolio Metrics

**Total Return** = Realized P&L (sum of closedTrades.profitLoss) + Unrealized P&L (current holdings value − cost basis). Percentage based on current cost basis. No cash/budget concept — `portfolio.cash` is legacy.

**Alpha vs SPY** = Total Return % − SPY return % (from `spyBaseline` price). Same realized + unrealized formula.

**Cost Basis**: Computed via `getCurrentPositionBuys()` which tracks buys for the current position (after any full exit/re-entry).

## Portfolio State

Persisted to `localStorage`, backed up to Google Drive as `Apex_Portfolio.json`. Key fields: `holdings`, `transactions`, `closedTrades`, `holdingTheses`, `performanceHistory`, `lastMarketRegime`, `lastCandidateScores`, `lastSectorRotation`, `lastVIX`, `regimeHistory`, `portfolioHealth`. Array caps on save: transactions (500), closedTrades (300), performanceHistory (3000).

## Known Issues

- **Technical indicators dual source**: Client-side RSI/MACD are approximations from ~65-day bars. Server values (`serverRsi`, `serverMacd`, `serverSma50`) use full history and are fetched for all stocks during Scan Market. Client for scoring, server for display.
- **Keyboard accessibility**: Collapsible sections use `<div onclick>` — should migrate to `<button>` with proper roles
- **FVG detection partial**: Detected and scored (±0.5) but not used in reversal filtering
- **RS not reconstructable**: Relative strength requires full market context at time of entry. For historical manual trades, RS is null unless cached from a prior Scan Market.

## Legacy AI Code

The codebase still contains the two-phase AI analysis system (`runAIAnalysis`, Phase 1/Phase 2 prompts, `executeSingleTrade`, `executeMultipleTrades`, budget/risk controls). This code is not actively used — the "Run AI Analysis" button has been removed. The chat interface still uses the Cloudflare Worker proxy for conversational queries.

## Stock Universe

~537 stocks across 14 sectors: Technology, Automotive, Financial, Healthcare, Consumer, Energy, Industrials, Real Estate, Materials, Defense, Space, Crypto, Index Fund. Three lists must stay in sync when adding/removing stocks:
1. `stockNames` — display names
2. `stockSectors` — sector classification (drives heatmap, which is dynamic)
3. `screenStocks()` — scan list (sector-grouped arrays, deduplicated)

Coverage includes: AI/software, semiconductors, cybersecurity, biotech/genomics, digital health, EV/auto, fintech/payments, crypto-adjacent, space/satellite, drones/eVTOL, infrastructure/data center, materials/mining, defense contractors, REITs, and more.

## Development Notes

- Edit `src/`, rebuild with `bash build.sh`. **Never edit `index.html` directly.**
- Test with "Scan Market" button (fetches market data and updates scorecard without AI)
- `let`/`const` throughout, `async/await` throughout
- Extensive console logging
