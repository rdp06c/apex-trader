# APEX – AI Paper Trading Agent

## What This Is

APEX (Autonomous Portfolio EXpert) is a single-page AI-powered paper trading application. It uses Claude's API (via Cloudflare Worker proxy) to make autonomous buy/sell/hold decisions on stocks, and Polygon.io for market data. The source is split into separate files under `src/` and assembled into a single `ai_trader.html` via a build script. There is no framework, no backend beyond the Cloudflare Worker proxy.

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
  ai_trader.html      ← Generated output (do not edit directly)
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

The build assembles `src/template.html` + `src/styles.css` + `src/body.html` + `src/trader.js` → `ai_trader.html`. The output file is in `.gitignore` since it's generated.

## Architecture Overview

```
Browser (ai_trader.html)
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
5. **Two-Phase AI Decision**:
   - **Phase 1** (`runAIAnalysis`, first API call) – Reviews existing holdings → SELL or HOLD decisions. Claude gets holdings data, theses, P&L, and web search capability.
   - Between phases: Sell proceeds are projected into `updatedCash`. Sold symbols are removed from Phase 2 candidates.
   - **Phase 2** (second API call) – Evaluates buy candidates using `updatedCash` as available budget. Gets market data, structure analysis, Phase 1 results, learning insights, market regime context.
6. **Budget Validation & Execution** (`executeMultipleTrades`):
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
  holdingTheses: { SYMBOL: { originalCatalyst, entryConviction, entryPrice, ... } },
  tradingStrategy: 'aggressive',
  journalEntries: [...]
}
```

Persisted to `localStorage` on every change. Backed up to Google Drive as `Apex_Portfolio.json`.

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

These insights are injected into Phase 2's prompt so Claude can learn from past decisions.

### Chat Interface (`sendMessage` in `src/trader.js`)
Conversational interface where users can ask APEX questions. APEX has a defined personality (confident trader + patient teacher) and gets portfolio context + web search capability.

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
The build produces a single `ai_trader.html` file. This is intentional for portability (can be opened from any device, hosted on any static server, or run locally). Source is split across `src/` for development convenience but always assembles into one file.

### Cloudflare Worker Proxy
The Anthropic API is not called directly from the browser. All Claude API calls go through a Cloudflare Worker that injects the API key server-side. The `ANTHROPIC_API_URL` points to this worker.

### API Cost Consciousness
- Polygon Stocks Starter plan – unlimited API calls, but the app still uses caching (4hr TTL for individual prices, 60s for bulk snapshots) to avoid unnecessary requests and keep responses fast
- Claude API calls are expensive – freshness checks prevent wasting analysis on stale data
- Phase 1 uses `claude-sonnet-4-20250514` with `max_tokens: 4000`
- Phase 2 uses `claude-sonnet-4-20250514` with `max_tokens: 8000`
- Chat uses `max_tokens: 1500`

### Anti-Whipsaw Protections
- 24-hour cooldown: Phase 1 won't contradict decisions made within 24 hours
- 5-day sell cooldown: Recently sold stocks are flagged if they appear as buy candidates – requires a NEW catalyst to re-buy
- Thesis tracking: Entry conditions are stored so Phase 1 can evaluate if the original thesis still holds

### Two-Phase Architecture Rationale
Splitting sell/buy into separate API calls solves information asymmetry: Phase 1 focuses purely on "should I exit?" without being biased by new opportunities, and Phase 2 gets accurate cash figures (including projected sell proceeds) to plan buys.

## Known Issues / Areas of Ongoing Work

- **Budget validation mismatch** (recently fixed): The sell-first execution flow ensures buy validation uses post-sell cash. If you see "original plan required $X but only $Y available" it's now a genuine AI arithmetic error, not a code bug.
- **JSON parsing fragility**: AI responses sometimes include markdown, citations, or malformed JSON. Multiple fallback parsers handle this (regex extraction, brace matching, citation stripping).
- **Post-exit tracking** (`updatePostExitTracking`): Checks prices 1 week / 1 month after sells to evaluate exit quality. Depends on Polygon API availability.

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
| `addDecisionReasoning` | Renders decision cards in UI |
| `sendMessage` | Chat interface message handling |
| `savePortfolio` / `loadPortfolio` | localStorage persistence |
| `savePortfolioToDrive` | Google Drive backup |
| `initChart` | Chart.js performance chart setup |

## Prompt Engineering Notes

The AI prompts are extensive and embedded inline in `src/trader.js`. Key sections (search for these strings):

- **Phase 1 prompt** (in `runAIAnalysis`, search `"Phase 1"`): Holdings review. Includes thesis comparison, anti-whipsaw rules, opportunity cost context (top buy candidates teased).
- **Phase 2 prompt** (in `runAIAnalysis`, search `"Phase 2"`): Buy decisions. Includes market regime guidance (bull/bear/choppy with different cash deployment strategies), conviction-based allocation rules, entry quality requirements, recently-sold warnings, and learning insights.
- **Chat prompt** (in `sendMessage`): APEX personality definition, teaching style, portfolio context.

When modifying prompts, be careful about:
- The `updatedCash` variable must be correctly referenced in Phase 2's budget section
- JSON response format specifications – Claude must return parseable JSON
- Learning insights injection – `formatPerformanceInsights()` output goes into Phase 2

## Development Notes

- Edit files in `src/`, then run `build.cmd` (Windows) or `./build.sh` (Bash) to regenerate `ai_trader.html`.
- **Do not edit `ai_trader.html` directly** — it is a generated file and changes will be overwritten on next build.
- Test with "🧪 Dry Run" button which fetches market data without calling Claude API.
- Console logging is extensive – most functions log their progress.
- The file uses `let`/`const` throughout (no `var`).
- All async operations use `async/await` (no raw Promise chains).
