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
  ├── Polygon.io API → Market data (snapshots, price history)
  ├── Google Drive API → Portfolio backup/restore, encrypted API key sync
  └── localStorage → Portfolio state, price cache, API keys
```

### Core Data Flow: AI Analysis Cycle

1. **Stock Screening** (`screenStocks`) – Builds a universe of ~300 stocks across 12 sectors
2. **Bulk Snapshot** (`fetchBulkSnapshot`) – Fetches prices for all stocks via Polygon `/v2/snapshot` endpoint (single API call, cached 60s)
3. **5-Day History** (`fetchAll5DayHistories`) – Gets 20-day OHLCV bars for top candidates via Polygon `/v2/aggs`
4. **Technical Analysis** (client-side):
   - `detectStructure` – Swing high/low detection, CHoCH, BOS, liquidity sweeps, FVGs
   - `calculate5DayMomentum` – Price momentum scoring
   - `calculateRelativeStrength` – Stock vs sector performance
   - `detectSectorRotation` – Money flow between sectors
5. **Candidate Scoring & Selection** (~line 2750 in `trader.js`):
   - Composite score = momentum (0-10) + RS normalized (0-10) + sector bonus (-1 to +2) + acceleration bonus (0/1.5) + consistency bonus (0/1) + structure bonus (-2.25 to +2.25) + extension penalty (0 to -3) + pullback bonus (0 to +2)
   - `bigMoverBonus` is disabled (was rewarding stocks already up >5% today — chasing)
   - **Extension penalty**: Graduated dampening when BOTH momentum AND RS are very high (9+/85+ → -3, 8+/80+ → -2, 7.5+/75+ → -1). Prevents runners from monopolizing top slots.
   - **Pullback bonus**: Stocks down 2-8% over 5 days with bullish structure + non-outflow sector get +2. Mild pullbacks (0 to -5%) with intact structure get +1. Helps quality dips compete with runners.
   - Final candidate pool: top 25 by score + all current holdings + 5 sector wildcards + up to 10 reversal candidates (bullish CHoCH, low-swept, bullish BOS)
6. **Two-Phase AI Decision**:
   - **Phase 1** (`runAIAnalysis`, first API call) – Reviews existing holdings → SELL or HOLD decisions. Claude gets holdings data, theses, P&L, current technical indicators, and web search capability.
   - Between phases: Sell proceeds are projected into `updatedCash`. Sold symbols are removed from Phase 2 candidates.
   - **Phase 2** (second API call) – Evaluates buy candidates using `updatedCash` as available budget. Gets market data, structure analysis, Phase 1 results, learning insights, market regime context. Entry quality guidance prioritizes pullback setups over extended stocks.
7. **Budget Validation & Execution** (`executeMultipleTrades`):
   - Sells execute first (freeing up actual cash)
   - Buy budget validates against real post-sell `portfolio.cash`
   - Buys execute in conviction-priority order
   - Trades that exceed budget get trimmed (share count reduced) or dropped

### Portfolio State (`portfolio` object)

```javascript
{
  cash: Number,              // Available liquid capital
  initialBalance: Number,    // Starting amount
  totalDeposits: Number,     // All deposits (initial + weekly funding)
  holdings: { SYMBOL: shares },
  transactions: [...],       // Full trade log (BUY/SELL entries)
  performanceHistory: [...], // Time-series for chart (value + deposit markers)
  closedTrades: [...],       // Completed round-trip trades with learning data
  holdingTheses: { SYMBOL: { originalCatalyst, entryConviction, entryPrice, entryMomentum, entryRS, entrySectorFlow, ... } },
  lastMarketRegime: { regime, timestamp },           // Persisted from Phase 1 AI response
  lastCandidateScores: { timestamp, candidates: [] }, // Top 40 scored candidates
  lastSectorRotation: { timestamp, sectors: {} },     // All sectors with money flow data
  tradingStrategy: 'aggressive',
  journalEntries: [...]
}
```

Persisted to `localStorage` on every change. Backed up to Google Drive as `Apex_Portfolio.json`. Performance history is throttled to one entry per 15 minutes (most recent entry is updated in between) with a hard cap of 3000 entries to prevent localStorage quota exhaustion.

## Key Subsystems

### Market Structure Detection (`detectStructure` in `src/trader.js`)
Implements ICT/SMC-style analysis on 20-day bars:
- Swing high/low identification
- Structure classification: bullish (HH+HL), bearish (LH+LL), ranging, contracting
- CHoCH (Change of Character) – trend reversal detection
- BOS (Break of Structure) – trend continuation confirmation
- Liquidity sweep detection (wicks beyond swing levels)
- Fair Value Gap (FVG) detection

### Machine Learning / Self-Improvement (in `src/trader.js`)
Tracks performance patterns from `closedTrades`:
- **Conviction Accuracy** (`analyzeConvictionAccuracy`) – Do high-conviction trades actually outperform?
- **Technical Indicator Accuracy** (`analyzeTechnicalAccuracy`) – Which signals (structure, momentum, RS) correlate with wins?
- **Exit Timing Analysis** (`analyzeExitTiming`) – Post-exit price tracking to evaluate sell decisions
- **Behavioral Patterns** – Detects tendency to sell winners too early, hold losers too long, etc.

These insights are injected into Phase 2's prompt so Claude can learn from past decisions. They're also surfaced in the Learning Insights UI via `updateLearningInsightsDisplay()`, which renders 7 analytics panels: Risk/Reward Profile, Hold Time Comparison, Streaks, Conviction Accuracy, Signal Accuracy, Exit Analysis, and Post-Exit Tracking. Each panel has a minimum data threshold and won't render with insufficient trades.

### Analytics Modules (in `src/trader.js` and `src/body.html`)
Four modules provide visibility into APEX's analysis data and portfolio state. UI section order in `body.html`:

1. Performance Analytics (existing)
2. Charts (existing — perf chart + sector pie)
3. **Market Regime Indicator** — non-collapsible banner
4. Current Holdings (existing collapsible) — includes sector, entry momentum, and RS
5. Decision Reasoning (existing collapsible)
6. **Candidate Scorecard** — collapsible, collapsed by default
7. **Sector Rotation Heatmap** — collapsible, collapsed by default
8. Learning Insights (existing collapsible)
9. Recent Activity (existing collapsible)
10. Chat (existing)

**Data persistence**: Three transient datasets (regime, candidate scores, sector rotation) are saved to the `portfolio` object in `runAIAnalysis()` (full analysis) and `testDataFetch()` (dry run) so they survive page refresh. Thesis data (`holdingTheses`) was already persistent.

**Backfill**: Holdings bought before thesis tracking was added get momentum/RS/sectorFlow backfilled on next analysis or dry run.

| Module | Function | Data Source | Trigger |
|--------|----------|-------------|---------|
| Market Regime | `updateRegimeBanner()` | `portfolio.lastMarketRegime` | `updatePerformanceAnalytics()` |
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
The Anthropic API is not called directly from the browser. All Claude API calls go through a Cloudflare Worker that injects the API key server-side. The `ANTHROPIC_API_URL` points to this worker.

### API Cost Consciousness
- Polygon Stocks Starter plan – unlimited API calls, but the app still uses caching (4hr TTL for individual prices, 60s for bulk snapshots) to avoid unnecessary requests and keep responses fast
- Claude API calls are expensive – freshness checks prevent wasting analysis on stale data
- Phase 1 uses `claude-sonnet-4-5-20250929` with `max_tokens: 4000`
- Phase 2 uses `claude-sonnet-4-5-20250929` with `max_tokens: 8000`
- Chat uses `max_tokens: 1500`

### Anti-Whipsaw Protections (5 layers)
1. **24-hour sell block** (code-enforced): `executeSingleTrade` rejects sells on holdings < 24 hours old regardless of AI recommendation
2. **5-day re-buy cooldown** (code-enforced): `executeMultipleTrades` filters out symbols sold within 5 days from buy candidates
3. **Phase 1 sells removed from Phase 2** (code-enforced): Sold symbols deleted from Phase 2 candidate list — prevents same-session re-buy
4. **Recently-sold warnings** (prompt-level): Phase 2 tags recently-sold symbols with sell date, P&L, exit reason — requires NEW catalyst to re-buy
5. **Prompt anti-whipsaw rules**: "Do not contradict decisions made in last 24 hours", "consistency builds trust"
- **Thesis tracking**: Entry conditions (catalyst, conviction, price, momentum, RS, sector flow) stored in `holdingTheses` so Phase 1 can compare original thesis vs current state

### Two-Phase Architecture Rationale
Splitting sell/buy into separate API calls solves information asymmetry: Phase 1 focuses purely on "should I exit?" without being biased by new opportunities, and Phase 2 gets accurate cash figures (including projected sell proceeds) to plan buys.

## Known Issues / Areas of Ongoing Work

- **Runner bias** (mitigated): Extension penalty + pullback bonus + doubled reversal slots + stronger prompt guidance. Runners still score well (momentum matters), but no longer monopolize top 25.
- **JSON parsing fragility**: AI responses sometimes include markdown, citations, or malformed JSON. Multiple fallback parsers handle this (regex extraction, brace matching, citation stripping).
- **Post-exit tracking** (`updatePostExitTracking`): Checks prices 1 week / 1 month after sells to evaluate exit quality. Depends on Polygon API availability.
- **Volume trend unused**: `calculate5DayMomentum` computes `volumeTrend` but it's never used in composite scoring. Could confirm momentum quality.
- **FVG detection unused**: `detectStructure` detects Fair Value Gaps but they're not used in scoring or reversal filtering. Scaffolding for potential future use.
- **No hard cap on candidate count**: With many holdings, candidate list can exceed 50+. Could degrade Phase 2 decision quality.
- **Keyboard accessibility**: Collapsible section headers and expandable cards use `<div onclick>` — not keyboard-navigable. Should migrate to `<button>` or add `role="button"` + `tabindex="0"`.
- **`bigMoverBonus` dead code**: Always set to 0 in scoring formula. Intentionally disabled but still present in the code.

## Function Reference (Key Functions)

All functions live in `src/trader.js`. Use `grep` or your editor's search to find them.

| Function | Purpose |
|----------|---------|
| `screenStocks` | Builds 300-stock universe across 12 sectors |
| `fetchBulkSnapshot` | Single API call for all ticker prices |
| `fetchAll5DayHistories` | 20-day OHLCV bars for candidates |
| `detectStructure` | ICT/SMC market structure analysis |
| `runAIAnalysis` | Main entry point: orchestrates both phases |
| `executeMultipleTrades` | Budget validation + trade execution |
| `executeSingleTrade` | Individual trade execution with portfolio updates |
| `analyzePerformanceHistory` | ML: overall trade analytics |
| `analyzeConvictionAccuracy` | ML: conviction vs outcome correlation |
| `analyzeTechnicalAccuracy` | ML: which indicators predict wins |
| `analyzeExitTiming` | ML: post-exit price analysis |
| `formatPerformanceInsights` | Formats ML insights for Claude's prompt |
| `calculatePortfolioValue` | Current total value calculation |
| `updateUI` | Refreshes all dashboard elements |
| `escapeHtml` | Sanitizes strings for safe innerHTML insertion |
| `addDecisionReasoning` | Renders decision cards in UI |
| `sendMessage` | Chat interface message handling (with rate limiting) |
| `activateChat` | Unlocks chat UI for the session |
| `updateRegimeBanner` | Renders market regime banner (bull/bear/choppy) |
| `updateCandidateScorecard` | Renders scored candidates table |
| `updateSectorRotationHeatmap` | Renders sector rotation card grid |
| `updateLearningInsightsDisplay` | Renders all analytics panels in Learning Insights |
| `savePortfolio` / `loadPortfolio` | localStorage persistence |
| `savePortfolioToDrive` | Google Drive backup |
| `initChart` | Chart.js performance chart setup |

## Prompt Engineering Notes

The AI prompts are extensive and embedded inline in `src/trader.js`. Key sections (search for these strings):

- **Phase 1 prompt** (in `runAIAnalysis`, search `"Phase 1"`): Holdings review. Includes thesis comparison, anti-whipsaw rules, opportunity cost context (top buy candidates teased).
- **Phase 2 prompt** (in `runAIAnalysis`, search `"Phase 2"`): Buy decisions. Includes market regime guidance (bull/bear/choppy with different cash deployment strategies), conviction-based allocation rules, entry quality tiers (Extended → avoid, Good Entry → sweet spot, Pullback → preferred, Red Flag → skip), recently-sold warnings, and learning insights.
- **Chat prompt** (in `sendMessage`): Concise system prompt with personality, portfolio context. Uses `system` parameter with conversation memory.

When modifying prompts, be careful about:
- The `updatedCash` variable must be correctly referenced in Phase 2's budget section
- JSON response format specifications – Claude must return parseable JSON
- Learning insights injection – `formatPerformanceInsights()` output goes into Phase 2

## Development Notes

- Edit files in `src/`, then run `build.cmd` (Windows) or `./build.sh` (Bash) to regenerate `index.html`.
- **Do not edit `index.html` directly** — it is a generated file and changes will be overwritten on next build.
- Test with "🧪 Dry Run" button which fetches market data without calling Claude API.
- Console logging is extensive – most functions log their progress.
- The file uses `let`/`const` throughout (no `var`).
- All async operations use `async/await` (no raw Promise chains).
