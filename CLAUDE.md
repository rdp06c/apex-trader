# APEX – AI Paper Trading Agent

## What This Is

APEX (Autonomous Portfolio EXpert) is a single-page AI-powered paper trading application. It uses Claude's API (via Cloudflare Worker proxy) to make autonomous buy/sell/hold decisions on stocks, and Polygon.io for market data. The source is split into separate files under `src/` and assembled into a single `index.html` via a build script. There is no framework, no backend beyond the Cloudflare Worker proxy.

## Project Structure

```
C:\RP\Apex\
  src\
    styles.css        ← All CSS
    body.html         ← HTML body content (between <body> and <script>)
    trader.js         ← All JavaScript
    template.html     ← Skeleton HTML with placeholders
  build.cmd           ← Windows batch build script
  build.sh            ← Bash build script (Git Bash / WSL / CI)
  index.html          ← Generated output (do not edit directly, served by GitHub Pages)
  CLAUDE.md
  .gitignore
```

### Build Instructions

**Edit source files in `src/`, then rebuild:**
```bash
# Windows
build.cmd

# Git Bash / WSL / Linux / macOS
./build.sh
```

The build assembles `src/template.html` + `src/styles.css` + `src/body.html` + `src/trader.js` → `index.html`. The output is committed to git so GitHub Pages can serve it directly.

## Architecture Overview

```
Browser (index.html)
  ├── Cloudflare Worker proxy → Anthropic API (Claude Sonnet)
  ├── Polygon.io API → Market data (snapshots, grouped daily bars, ticker details, short interest, news, VIX index)
  ├── Google Drive API → Portfolio backup/restore, encrypted API key sync
  └── localStorage → Portfolio state, price cache, API keys
```

### Core Data Flow: AI Analysis Cycle

1. **Stock Screening** (`screenStocks`) – Builds a universe of ~490 stocks across 12 sectors (all stocks per sector, no cap)
2. **Parallel Data Fetching** (runs simultaneously):
   - `fetchBulkSnapshot` – Prices for all stocks via Polygon `/v2/snapshot` (single API call, cached 15s)
   - `fetchGroupedDailyBars` – 40-day OHLCV bars via Polygon `/v2/aggs/grouped` (~40 API calls per date, cached 15min). Falls back to `fetchAll5DayHistories` (per-ticker) on failure.
   - `fetchTickerDetails` – Market cap + SIC description via `/v3/reference/tickers` (cached 7 days)
   - `fetchShortInterest` – Short interest + days-to-cover via `/stocks/v1/short-interest` (cached 24hr)
   - `fetchVIX` – VIX index level + trend via Polygon `/v2/aggs/ticker/I:VIX` (7-day daily bars, cached 4hr). Computes level, day change, weekly trend (rising/falling/stable), interpretation (complacent/normal/elevated/panic)
3. **Technical Analysis** (client-side):
   - `detectStructure` – Swing high/low detection, CHoCH, BOS, liquidity sweeps, FVGs (uses 40-day bars)
   - `calculate5DayMomentum` – Price momentum scoring
   - `calculateRelativeStrength` – Stock vs sector performance
   - `detectSectorRotation` – Money flow between sectors
   - `calculateRSI` – RSI(14) from 40-day bars (client-side Wilder's smoothing)
   - `calculateMACD` – MACD(12,26,9) with crossover detection from 40-day bars
4. **Candidate Scoring & Selection**:
   - Composite score = momentum (0-10) + RS normalized (0-10) + sector bonus (-1 to +2) + acceleration bonus (0/1.5) + consistency bonus (0/1) + structure bonus (-2.25 to +2.25) + extension penalty (0 to -3) + pullback bonus (0 to +2) + RSI bonus/penalty (-1 to +1.5) + MACD bonus (-1 to +1) + squeeze bonus (0 to +1.5)
   - `bigMoverBonus` is disabled (was rewarding stocks already up >5% today — chasing)
   - **RSI bonus/penalty**: RSI < 30 (oversold) → +1.5, RSI > 70 (overbought) → -1.0
   - **MACD bonus**: Bullish crossover → +1.0, bearish crossover → -1.0
   - **Squeeze bonus**: Days-to-cover > 5 + bullish structure + non-outflow sector → +1.5
   - **Extension penalty**: Graduated dampening when momentum OR RS very high. Prevents runners from monopolizing top slots.
   - **Pullback bonus**: Stocks down 2-8% over 5 days with bullish structure + non-outflow sector get +2. Mild pullbacks (0 to -5%) with intact structure get +1. Helps quality dips compete with runners.
   - Final candidate pool: top 25 by score + all current holdings + 5 sector wildcards + up to 10 reversal candidates (bullish CHoCH, low-swept, bullish BOS)
5. **News Fetching** (`fetchNewsForStocks`) – After scoring, fetches recent headlines + machine sentiment for top 25 candidates + holdings (cached 1hr)
6. **Two-Phase AI Decision**:
   - **Phase 1** (`runAIAnalysis`, first API call) – Reviews existing holdings → SELL or HOLD decisions. Claude gets holdings data, theses, P&L, current technical indicators, web search capability, conviction tier definitions (HOLD 3-10, SELL 5-10), and learning context via `formatPhase1Insights()` (exit patterns, hold accuracy, regime context, track record).
   - Between phases: Sell proceeds are projected into `updatedCash`. Sold symbols are removed from Phase 2 candidates. Current holdings are flagged (`currentlyHeld`, `sharesHeld`) but kept in candidate data for potential add-to-position.
   - **Phase 2** (second API call) – Evaluates buy candidates using `updatedCash` as available budget. Gets market data, structure analysis, Phase 1 results, learning insights, market regime context. Entry quality guidance prioritizes pullback setups over extended stocks. May recommend adding shares to existing holdings if setup is exceptional.
7. **Budget Validation & Execution** (`executeMultipleTrades`):
   - Receives `enhancedMarketData` (with all technical indicators, company details, short interest) — used by `executeSingleTrade` to populate `entryTechnicals`, `holdingTheses`, and `exitTechnicals`
   - Sells execute first (freeing up actual cash)
   - **Derived trading rules** (`deriveTradingRules`) are enforced: `block`-level rules hard-reject buy candidates; `warn`-level rules add badges to Decision Reasoning cards
   - Buy budget validates against real post-sell `portfolio.cash`
   - **Budget threshold**: If trimmed buys total <25% of original plan, all buys are skipped (hold cash for better opportunity)
   - Buys execute in conviction-priority order
   - Trades that exceed budget get trimmed (share count reduced) or dropped
   - **Reaffirmation guard**: If all Phase 2 BUYs are for held stocks with no new shares (same count as held), treated as HOLD — no execution

### Portfolio State (`portfolio` object)

```javascript
{
  cash: Number,              // Available liquid capital
  initialBalance: Number,    // Starting amount
  totalDeposits: Number,     // All deposits (initial + weekly funding)
  holdings: { SYMBOL: shares },
  transactions: [...],       // Full trade log (BUY/SELL entries)
  performanceHistory: [...], // Time-series for chart (value + deposit markers)
  closedTrades: [...],       // Completed round-trip trades with learning data (includes entryTechnicals + exitTechnicals with RSI, MACD, structure, DTC, compositeScore, VIX level/interpretation)
  holdingTheses: { SYMBOL: { originalCatalyst, entryConviction, entryPrice, entryMomentum, entryRS, entrySectorFlow, entryRSI, entryMACDCrossover, entryStructure, entryDTC, entryCompositeScore, entryVIX, entryVIXInterpretation, ... } },
  lastMarketRegime: { regime, timestamp },           // Persisted from Phase 1 AI response
  lastCandidateScores: { timestamp, candidates: [] }, // Top 40 scored candidates
  lastSectorRotation: { timestamp, sectors: {} },     // All sectors with money flow data
  lastVIX: { level, interpretation, trend, ... },     // Latest VIX data for banner display
  holdSnapshots: [...],      // Hold decision outcome tracking (price at hold time + next-cycle price, includes VIX)
  regimeHistory: [...],      // Rolling regime transition log (capped at 200 entries)
  blockedTrades: [...],      // Trades blocked by derived trading rules (capped at 50, initialized on-demand)
  spyBaseline: { price, date },       // SPY price at first run (benchmark reference point)
  spyCurrent: { price, date },        // Latest SPY price
  portfolioHealth: { peakValue, drawdownPct, spyReturn, portfolioReturn, alpha, timestamp },
  tradingStrategy: 'aggressive',
  journalEntries: [...]
}
```

Persisted to `localStorage` on every change. Backed up to Google Drive as `Apex_Portfolio.json`. Performance history is throttled to one entry per 15 minutes (most recent entry is updated in between) with a hard cap of 3000 entries to prevent localStorage quota exhaustion.

## Key Subsystems

### Market Structure Detection (`detectStructure` in `src/trader.js`)
Implements ICT/SMC-style analysis on 40-day bars:
- Swing high/low identification
- Structure classification: bullish (HH+HL), bearish (LH+LL), ranging, contracting
- CHoCH (Change of Character) – trend reversal detection
- BOS (Break of Structure) – trend continuation confirmation
- Liquidity sweep detection (wicks beyond swing levels)
- Fair Value Gap (FVG) detection

### Machine Learning / Self-Improvement (in `src/trader.js`)
Tracks performance patterns from `closedTrades`:
- **Conviction Accuracy** (`analyzeConvictionAccuracy`) – Do high-conviction trades actually outperform?
- **Technical Indicator Accuracy** (`analyzeTechnicalAccuracy`) – Which signals correlate with wins? Analyzes: momentum score, RS, sector rotation, runner entries, market structure (CHoCH/BOS), acceleration, regime, concentration, position sizing, RSI zones (oversold/neutral/overbought), MACD crossover (bullish/bearish/none), squeeze potential (DTC buckets), composite score calibration (high/medium/low), and VIX zones (complacent/normal/elevated/panic)
- **Exit Timing Analysis** (`analyzeExitTiming`) – Post-exit price tracking to evaluate sell decisions
- **Behavioral Patterns** – Detects tendency to sell winners too early, hold losers too long, etc.
- **Hold Accuracy** (`analyzeHoldAccuracy`) – Evaluates HOLD decisions by comparing price at hold time vs next analysis cycle. Tracks whether holds gained or lost value and correlates with conviction level and market regime.
- **Regime Transitions** (`analyzeRegimeTransitions`) – Tracks market regime changes (bull/bear/choppy) over time via `regimeHistory`. Detects regime shift frequency and patterns.
- **Post-Exit Quality** (`summarizePostExitQuality`) – Aggregates `priceAfter1Week`/`priceAfter1Month` from `closedTrades[].tracking` to measure whether sold stocks continued rising. Flags "selling too early" pattern when >60% went higher AND avg >+3%.
- **Benchmark & Drawdown** – SPY price tracked via `portfolio.spyBaseline`/`spyCurrent`. Portfolio health computed each cycle: return vs SPY (alpha), drawdown from peak. Stored in `portfolio.portfolioHealth`.

These insights are injected into both phases' prompts so Claude can learn from past decisions:
- **Phase 1** receives concise learning context via `formatPhase1Insights()`: portfolio health (return vs SPY, alpha, drawdown), exit patterns (from `analyzeExitTiming`), hold accuracy by conviction/RSI zone (from `analyzeHoldAccuracy`), regime context with regime-specific hold accuracy (from `analyzeRegimeTransitions`), W-L track record (from `deriveTradingRules` summary), and post-exit quality (from `summarizePostExitQuality`). ~300-450 tokens when fully populated, empty when <3 trades.
- **Phase 2** receives rich learning context via `formatPerformanceInsights()`: portfolio health (return, SPY, alpha, drawdown), trading rules, exit timing (best hold period, avg winner return, dominant exit reason from `analyzeExitTiming`), post-exit quality, hold accuracy, regime context, sector/stock history and behavioral patterns (from `analyzePerformanceHistory`), conviction calibration, and signal accuracy. Additionally, regime-adaptive deployment guidance is injected after the regime section when regime-specific win rate data is available.

Insights are also surfaced in the Learning Insights UI via `updateLearningInsightsDisplay()`, which renders 7 analytics panels: Risk/Reward Profile, Hold Time Comparison, Streaks, Conviction Accuracy, Signal Accuracy, Exit Analysis, and Post-Exit Tracking. Each panel has a minimum data threshold and won't render with insufficient trades.

### Derived Trading Rules (in `src/trader.js`)
Auto-learns from `closedTrades` to prevent repeating mistakes:
- **`deriveTradingRules()`** – Analyzes 9 pattern dimensions (runner entries, overbought RSI, bearish structure, bearish MACD, outflow sectors, high momentum, large positions, low composite scores, overconfident conviction). For each pattern with enough data, calculates win rate and assigns enforcement level:
  - **`block`** – Hard stop. Trade is rejected in `executeMultipleTrades` and logged to `portfolio.blockedTrades`.
  - **`warn`** – Soft warning. A badge is displayed on the Decision Reasoning card.
  - **`observe`** – Tracking only. No user-visible action.
- **`matchesPattern(ruleId, data)`** – Checks whether a buy candidate matches a specific rule pattern using its market data (RSI, MACD, structure, sector flow, momentum, composite score, conviction).
- Rules are re-derived on every analysis cycle (not cached long-term). The Learning Insights UI displays blocked trades and active rules.

### Analytics Modules (in `src/trader.js` and `src/body.html`)
Four modules provide visibility into APEX's analysis data and portfolio state. UI section order in `body.html`:

1. Performance Analytics (existing)
2. Charts (existing — perf chart + sector pie)
3. **Market Regime Indicator** — non-collapsible banner with color-coded VIX level display (right-aligned)
4. Current Holdings (existing collapsible) — includes sector, entry momentum, RS, live RSI/MACD/DTC indicators, and up to 2 recent news headlines with sentiment badges
5. Decision Reasoning (existing collapsible) — individual cards are also collapsible (click header); restored cards start collapsed. Persisted to `localStorage` (`apexDecisionHistory`, last 5 records) and auto-uploaded to Google Drive. Hold decisions are synthesized for any holdings the AI omits from Phase 1.
6. **Candidate Scorecard** — collapsible, collapsed by default. Columns: #, Symbol, Score, Day, Mom, RS, RSI (color-coded), MACD (arrow), Sector, Structure, DTC (squeeze highlight), MCap
7. **Sector Rotation Heatmap** — collapsible, collapsed by default
8. Learning Insights (existing collapsible)
9. Recent Activity (existing collapsible)
10. Chat (existing)

**Data persistence**: Four transient datasets (regime, candidate scores, sector rotation, VIX) are saved to the `portfolio` object in `runAIAnalysis()` (full analysis) and `testDataFetch()` (dry run) so they survive page refresh. Thesis data (`holdingTheses`) was already persistent.

**Backfill**: Holdings bought before thesis tracking was added get momentum/RS/sectorFlow backfilled on next analysis or dry run.

| Module | Function | Data Source | Trigger |
|--------|----------|-------------|---------|
| Market Regime + VIX | `updateRegimeBanner()` | `portfolio.lastMarketRegime` + `portfolio.lastVIX` | `updatePerformanceAnalytics()` |
| Candidate Scorecard | `updateCandidateScorecard()` | `portfolio.lastCandidateScores` | `updatePerformanceAnalytics()` |
| Sector Rotation | `updateSectorRotationHeatmap()` | `portfolio.lastSectorRotation` | `updatePerformanceAnalytics()` |

### Chat Interface (`sendMessage` in `src/trader.js`)
Conversational interface where users can ask APEX questions. Gets portfolio context + web search capability.
- **Gated**: Chat is hidden behind an activation button (`activateChat()`) — user must click "Start Chat Session" to reveal the input
- **Conversation memory**: Last 5 exchanges (10 messages) stored in `chatHistory` and sent with each request. Resets on page refresh.
- **Rate limiting**: 5-second cooldown between messages (`lastChatTime`), 20 messages per session max (`chatMessageCount`). Both reset on refresh.
- **System prompt**: Concise ~80 token personality in the `system` parameter (not embedded in user message). Portfolio snapshot included as context.

### XSS Prevention
All AI-generated and user-generated content is escaped via `escapeHtml()` before `innerHTML` insertion. This covers `addActivity()`, `addDecisionReasoning()` (reasoning, budget warnings, research summaries), and `addChatMessage()` (both user input and AI responses). The chat formatter applies markdown-like transforms (bold, line breaks) after escaping so the formatting tags are trusted.

### Google Drive Integration (in `src/trader.js`)
- OAuth 2.0 with `drive.file` scope (APEX can only see files it created)
- Portfolio backup/restore as JSON
- Decision reasoning auto-upload (`uploadDecisionToDrive`) into a `APEX_Decisions` folder (`findOrCreateFolder`)
- Encrypted API key sync between devices (XOR + base64 encryption)
- Uses Google Identity Services library

### API Key Management (in `src/trader.js`)
All API keys stored in localStorage:
- `polygon_api_key` – Polygon.io market data
- `anthropic_api_url` – Cloudflare Worker proxy URL
- `google_client_id` / `google_api_key` – Google Drive OAuth
- Optional: encrypted sync to Google Drive for cross-device access

## Important Design Decisions & Constraints

### Single HTML Output
The build produces a single `index.html` file. This is intentional for portability (can be opened from any device, hosted on any static server, or run locally). Source is split across `src/` for development convenience but always assembles into one file.

### Cloudflare Worker Proxy
The Anthropic API is not called directly from the browser. All Claude API calls go through a Cloudflare Worker that injects the API key server-side. The `ANTHROPIC_API_URL` points to this worker. The worker injects `stream: true` into every request and pipes the SSE stream straight through to the browser — this keeps the connection alive and avoids Cloudflare's free-plan 100s timeout. On the client side, `fetchAnthropicStreaming()` reads the SSE events and reconstructs the same message object shape as the non-streaming API, so all downstream code (JSON parsing, text extraction) works unchanged.

### API Cost Consciousness
- Massive Stocks Advanced + Indices Basic plan – real-time stock data, EOD index data, **unlimited API calls** (recommended <100 req/s to avoid throttling). Endpoints used: bulk snapshot (`/v2/snapshot`), grouped daily bars (`/v2/aggs/grouped`), ticker details (`/v3/reference/tickers`), short interest (`/stocks/v1/short-interest`), news (`/v2/reference/news`), VIX index (`/v2/aggs/ticker/I:VIX`), and per-ticker OHLCV bars as fallback (`/v2/aggs/ticker`). Caching (4hr TTL for individual prices, 15s for bulk snapshots, 15min for grouped bars, 1hr for news, 24hr for short interest, 7 days for ticker details, 4hr for VIX) is for performance/efficiency, not rate limit avoidance
- Claude API calls are expensive – freshness checks prevent wasting analysis on stale data
- Phase 1 uses `claude-sonnet-4-6` with `max_tokens: 6000`
- Phase 2 uses `claude-sonnet-4-6` with `max_tokens: 10000` (prompt enforces "UNDER 3000 words" to prevent truncation; per-decision reasoning capped at 80-150 words, overall_reasoning at 150-250 words)
- Chat uses `max_tokens: 1500`
- **Search token optimization**: Pre-loaded `recentNews` (headlines + machine sentiment from Polygon) and pre-loaded VIX level are injected into both Phase 1 and Phase 2 prompts. VIX pre-loading eliminates the "VIX level today" web search that previously consumed a Phase 1 search slot (~500-1500 tokens saved). Phase 1 uses up to 3 web searches (broader regime context + news gap filling for holdings with empty/stale news + alarming headline verification). Phase 2 uses up to 4 focused searches (catalyst verification, sector rotation, deep dive). Saves ~2,500-5,500 tokens per analysis cycle vs broad discovery searches.

### After-Hours Price Handling
Polygon's `lastTrade.p` reflects extended-hours trading, which differs from the regular-session closing price most sites display. The `isMarketOpen()` helper checks Eastern Time (9:30 AM – 4:00 PM ET, weekdays). When market is closed, price priority is `day.c > lastTrade.p > day.l`; when open, it's `lastTrade.p > day.c > day.l`. Change calculations are also recomputed from scratch when market is closed (Polygon's pre-computed `todaysChange`/`todaysChangePerc` include extended-hours movement). This applies to both `fetchBulkSnapshot` and individual `getStockPrice` calls.

### Anti-Whipsaw Protections (5 layers)
1. **Same-day sell block** (code-enforced): Both Phase 1 filtering and `executeSingleTrade` reject sells on holdings bought the same calendar day (ET). Blocked sells are converted to HOLD decisions so they still appear in Decision Reasoning.
2. **5-day re-buy cooldown** (code-enforced): `executeMultipleTrades` filters out symbols sold within 5 days from buy candidates
3. **Phase 1 sells removed from Phase 2** (code-enforced): Sold symbols deleted from Phase 2 candidate list — prevents same-session re-buy. Current holdings remain in data (flagged) for add-to-position.
4. **Recently-sold warnings** (prompt-level): Phase 2 tags recently-sold symbols with sell date, P&L, exit reason — requires NEW catalyst to re-buy
5. **Prompt anti-whipsaw rules**: "Do not contradict decisions made in last 24 hours", "consistency builds trust"
- **Thesis tracking**: Entry conditions (catalyst, conviction, price, momentum, RS, sector flow) stored in `holdingTheses` so Phase 1 can compare original thesis vs current state

### Two-Phase Architecture Rationale
Splitting sell/buy into separate API calls solves information asymmetry: Phase 1 focuses purely on "should I exit?" without being biased by new opportunities, and Phase 2 gets accurate cash figures (including projected sell proceeds) to plan buys.

## Known Issues / Areas of Ongoing Work

- **Runner bias** (mitigated): Extension penalty + pullback bonus + doubled reversal slots + stronger prompt guidance. Runners still score well (momentum matters), but no longer monopolize top 25.
- **JSON parsing fragility** (largely mitigated): Multi-layered recovery: (1) code fence extraction uses *last* fence (web search can produce earlier fences with non-JSON content), (2) citation stripping + brace matching + newline escaping, (3) single-quote regex deferred to a retry step (applying eagerly corrupts JSON when reasoning text contains `': 'word'` patterns), (4) `extractDecisionsArray` — string-aware bracket-matching extractor for Phase 1 decisions array, (5) `extractDecisionFromRawResponse` — Phase 2 structural fallback. Phase 1 also regex-extracts `holdings_summary` and `market_regime` individually.
- **Post-exit tracking** (`updatePostExitTracking`): Checks prices 1 week / 1 month after sells to evaluate exit quality. Depends on Polygon API availability.
- **Volume trend unused**: `calculate5DayMomentum` computes `volumeTrend` but it's never used in composite scoring. Could confirm momentum quality.
- **FVG detection unused**: `detectStructure` detects Fair Value Gaps but they're not used in scoring or reversal filtering. Scaffolding for potential future use.
- **No hard cap on candidate count**: With many holdings, candidate list can exceed 50+. Could degrade Phase 2 decision quality.
- **Keyboard accessibility**: Collapsible section headers and expandable cards use `<div onclick>` — not keyboard-navigable. Should migrate to `<button>` or add `role="button"` + `tabindex="0"`.
- **`bigMoverBonus` dead code**: Always set to 0 in scoring formula. Intentionally disabled but still present in the code.
- **`analyzeTechnicalAccuracy` / `analyzeConvictionAccuracy`**: Both wired into `formatPerformanceInsights()` (feeds signal accuracy + conviction calibration into Phase 2 prompt) and `updateLearningInsightsDisplay()` (renders Conviction Calibration + Signal Accuracy panels in Learning Insights UI). Requires 5+ closed trades with `entryConviction` / `entryTechnicals` to activate.
- **Technical indicators are client-side approximations**: RSI(14) and MACD(12,26,9) are computed from 40-day bars. RSI warm-up (25+ smoothed values) is good but not as accurate as server-computed from full price history. Sufficient for screening purposes.
- **Short interest data availability**: The `/stocks/v1/short-interest` endpoint returns bi-monthly settlement data. Coverage may be incomplete for smaller stocks.
- **Exit reason classification**: Uses return % first (objective: ≥2% = `profit_target`, ≤-8% = `stop_loss`), then keyword matching for the middle ground (-8% to +2%). Includes a one-time migration (`_exitReasonV2`) to reclassify historical `closedTrades`.
- **Dry run regime inference**: `testDataFetch` now infers `lastMarketRegime` from VIX level when no regime exists yet (>30 = bear, >25 = choppy, else bull).

## Function Reference (Key Functions)

All functions live in `src/trader.js`. Use `grep` or your editor's search to find them.

| Function | Purpose |
|----------|---------|
| `screenStocks` | Builds ~490-stock universe across 12 sectors (no per-sector cap) |
| `fetchAnthropicStreaming` | SSE streaming fetch — reconstructs Messages API response shape |
| `fetchBulkSnapshot` | Single API call for all ticker prices |
| `fetchGroupedDailyBars` | 40-day OHLCV bars via grouped daily endpoint (~40 API calls) |
| `fetchAll5DayHistories` | Per-ticker OHLCV bars (fallback for grouped daily) |
| `fetchTickerDetails` | Market cap + SIC description (7-day cache) |
| `fetchShortInterest` | Short interest + days-to-cover (24hr cache) |
| `fetchNewsForStocks` | Recent headlines + machine sentiment (1hr cache) |
| `fetchVIX` | VIX index level + trend via Polygon Indices (4hr cache) |
| `calculateRSI` | RSI(14) from bar data (Wilder's smoothing) |
| `calculateSMA` | Simple Moving Average from bar data |
| `calculateEMAArray` | EMA helper (returns array for MACD signal line) |
| `calculateMACD` | MACD(12,26,9) with crossover detection |
| `detectStructure` | ICT/SMC market structure analysis |
| `runAIAnalysis` | Main entry point: orchestrates both phases |
| `executeMultipleTrades` | Budget validation + trade execution |
| `executeSingleTrade` | Individual trade execution with portfolio updates |
| `analyzePerformanceHistory` | ML: overall trade analytics |
| `analyzeConvictionAccuracy` | ML: conviction vs outcome correlation |
| `analyzeTechnicalAccuracy` | ML: which indicators predict wins |
| `analyzeExitTiming` | ML: post-exit price analysis |
| `analyzeHoldAccuracy` | ML: hold decision outcome analysis |
| `analyzeRegimeTransitions` | ML: regime change pattern analysis |
| `deriveTradingRules` | Auto-generates block/warn rules from closed trade patterns |
| `matchesPattern` | Checks if a buy candidate matches a derived rule pattern |
| `extractDecisionsArray` | String-aware bracket-matching extractor for Phase 1 decisions array |
| `recordHoldSnapshots` | Captures hold decisions with technicals for later evaluation |
| `evaluateHoldSnapshots` | Fills in next-cycle prices for hold outcome tracking |
| `recordRegimeTransition` | Tracks market regime changes over time |
| `formatPerformanceInsights` | Formats ML insights for Phase 2 prompt (rules, exit timing, sectors, behavior, conviction, signals) |
| `formatPhase1Insights` | Formats ML insights for Phase 1 prompt (portfolio health, exit patterns, hold accuracy, regime, track record, post-exit quality) |
| `summarizePostExitQuality` | Aggregates post-exit tracking data (1wk/1mo price moves after sells) for prompt injection |
| `calculatePortfolioValue` | Current total value calculation |
| `updateUI` | Refreshes all dashboard elements |
| `escapeHtml` | Sanitizes strings for safe innerHTML insertion |
| `formatMarketCap` | Formats market cap as $1.2T / $45B / $800M |
| `formatTimeAgo` | Formats ISO date as relative time (2h, 1d, 3d) |
| `addDecisionReasoning` | Renders decision cards in UI (persisted to localStorage) |
| `buildDecisionText` | Extracts text from decision card for export |
| `uploadDecisionToDrive` | Uploads decision reasoning to Google Drive |
| `findOrCreateFolder` | Google Drive folder management helper |
| `sendMessage` | Chat interface message handling (with rate limiting) |
| `activateChat` | Unlocks chat UI for the session |
| `updateRegimeBanner` | Renders market regime banner (bull/bear/choppy) |
| `updateCandidateScorecard` | Renders scored candidates table |
| `updateSectorRotationHeatmap` | Renders sector rotation card grid |
| `updateLearningInsightsDisplay` | Renders all analytics panels in Learning Insights |
| `isMarketOpen` | Checks if US market is open (ET timezone, weekday 9:30-16:00) |
| `savePortfolio` / `loadPortfolio` | localStorage persistence |
| `savePortfolioToDrive` | Google Drive backup |
| `initChart` | Chart.js performance chart setup |

## Prompt Engineering Notes

The AI prompts are extensive and embedded inline in `src/trader.js`. Key sections (search for these strings):

- **Phase 1 prompt** (in `runAIAnalysis`, search `"Phase 1"`): Holdings review. Opens with OBJECTIVE statement (maximize returns by protecting capital + preserving winners). Includes thesis comparison, anti-whipsaw rules, opportunity cost context (top buy candidates teased), pre-loaded VIX level, news gap search strategy (searches for holdings with empty/stale news), conviction tier definitions (HOLD: 9-10 Strong → 3-4 Weak; SELL: 9-10 High Conviction → 5-6 Reluctant), and learning context via `${formatPhase1Insights()}`. Hold decisions are synthesized for any holdings the AI omits from its response.
- **Phase 2 prompt** (in `runAIAnalysis`, search `"Phase 2"`): Buy decisions. Includes market regime guidance (bull/bear/choppy with different cash deployment strategies) with adaptive deployment annotation from regime-specific win rate data (`regimeAdaptation`), pre-loaded VIX in Phase 1 results (all 3 paths: sells, no-sells, no-holdings), conviction-based allocation rules, entry quality tiers (Extended → avoid, Good Entry → sweet spot, Pullback → preferred, Red Flag → skip), recently-sold warnings, and learning insights. VIX volatility thresholds (<15 complacent, 15-20 normal, 20-30 elevated, >30 panic) are aligned with `fetchVIX` interpretation — no search needed.
- **Chat prompt** (in `sendMessage`): Concise system prompt with personality, portfolio context. Uses `system` parameter with conversation memory.

When modifying prompts, be careful about:
- The `updatedCash` variable must be correctly referenced in Phase 2's budget section
- JSON response format specifications – Claude must return parseable JSON
- Learning insights injection – `formatPerformanceInsights()` output goes into Phase 2, `formatPhase1Insights()` output goes into Phase 1

## Development Notes

- Edit files in `src/`, then run `build.cmd` (Windows) or `./build.sh` (Bash) to regenerate `index.html`.
- **Do not edit `index.html` directly** — it is a generated file and changes will be overwritten on next build.
- Test with "🧪 Dry Run" button which fetches market data without calling Claude API.
- Console logging is extensive – most functions log their progress.
- The file uses `let`/`const` throughout (no `var`).
- All async operations use `async/await` (no raw Promise chains).
