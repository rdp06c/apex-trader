# APEX – AI Paper Trading Agent

APEX (Autonomous Portfolio EXpert) is a single-page AI-powered paper trading app. Uses Claude API (via Cloudflare Worker proxy) for autonomous buy/sell/hold decisions and Massive (formerly Polygon.io) for market data. No framework, no backend beyond the CF Worker.

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

**Build:** Edit `src/` files, then run `build.cmd` (Windows) or `./build.sh` (Bash). Assembles template + CSS + HTML + JS → `index.html`. Output is committed for GitHub Pages.

## Architecture

```
Browser (index.html)
  ├── Cloudflare Worker proxy → Anthropic API (Claude Sonnet)
  ├── Massive API → Market data (snapshots, bars, ticker details, short interest, news, VIX)
  ├── Google Drive API → Portfolio backup/restore, encrypted API key sync
  └── localStorage → Portfolio state, price cache, API keys
```

## Core Data Flow

1. **Screen** ~490 stocks across 12 sectors (`screenStocks`)
2. **Fetch** prices, ~65-day OHLCV bars, ticker details, short interest, VIX — all in parallel
3. **Analyze** client-side: market structure (ICT/SMC), momentum, relative strength, sector rotation, RSI, MACD, SMA crossovers. Server-side: RSI/MACD/SMA50 from Massive indicators API
4. **Score** candidates via `calculateCompositeScore` — weighted sum of ~15 components (momentum, RS, structure, RSI, MACD, pullback, extension, etc.) with entry quality multiplier. All weights defined in `DEFAULT_WEIGHTS`, auto-calibratable via `runCalibrationSweep`
5. **Select** top 25 + holdings + wildcards + reversal candidates (capped at 40)
6. **Fetch news** for candidates + holdings
7. **Two-phase AI decision** — Phase 1: sell/hold existing holdings → Phase 2: buy candidates with updated cash
8. **Execute** trades with budget validation, position limits, sector caps

## Two-Phase Architecture

Phase 1 (sell/hold) runs first so Phase 2 (buy) gets accurate post-sell cash figures. This prevents information asymmetry — exit decisions aren't biased by new buy opportunities.

- Between phases: sell proceeds projected into `updatedCash`, sold symbols removed from Phase 2 candidates
- Both phases receive learning insights from closed trade analysis (`formatPhase1Insights`, `formatPerformanceInsights`)
- Calibration insights injected via `formatCalibrationInsights()` — tells AI which scoring signals are predictive vs anti-predictive

## Anti-Whipsaw Protections (5 layers)

1. Same-day sell block (code-enforced in Phase 1 filter + `executeSingleTrade`)
2. 5-day re-buy cooldown (code-enforced in `executeMultipleTrades`)
3. Phase 1 sells removed from Phase 2 candidate list
4. Recently-sold warnings in Phase 2 prompt (requires NEW catalyst to re-buy)
5. Prompt rules: "Do not contradict decisions made in last 24 hours"

Entry conditions stored in `holdingTheses` so Phase 1 can compare original thesis vs current state.

## Budget & Risk Controls (code-enforced)

- **Regime-based cash reserve**: bull=10%, choppy=20%, bear=30%
- **Position sizing by conviction**: 9-10→15%, 7-8→12%, 5-6→8%, <5→5% of portfolio
- **Sector concentration cap**: 35% per sector
- **Max holdings**: 12 concurrent positions
- **Budget threshold**: If trimmed buys total <25% of original plan, skip all buys
- **Catalyst freshness gate**: Blocks buys on stocks up >10% today without fresh positive catalyst
- **Volume gate**: Hard veto based on today's volume vs 20-day average (`calculateVolumeRatio`). Breakout entries (momentum ≥5) require ≥1.5x avg volume; pullback entries (momentum <5) require ≤0.7x avg volume. Blocked trades logged to `portfolio.blockedTrades`.
- **Derived trading rules**: Auto-learned from `closedTrades` — `block` (hard reject), `warn` (badge), `observe` (track only)

## Key Subsystems

**Composite Scoring** (`calculateCompositeScore`): ~15 weighted components. Weights in `DEFAULT_WEIGHTS`, calibratable. `getActiveWeights()` selects regime-aware weights (VIX < 20 vs ≥ 20). Returns `{total, breakdown}` for tooltip decomposition.

**Market Structure** (`detectStructure`): ICT/SMC analysis — swing highs/lows, CHoCH, BOS, liquidity sweeps, FVGs on ~65-day bars.

**Calibration Engine** (`runCalibrationSweep`): Sweeps 40 historical dates, runs full pipeline, correlates scoring components with forward returns, derives calibrated weights with shrinkage. Regime-segmented. Out-of-sample validated. Chat command: `calibrate`.

**Self-Improvement**: Analyzes `closedTrades` for conviction accuracy, signal accuracy, exit timing, hold accuracy, regime transitions, post-exit quality. Insights injected into AI prompts and displayed in Learning Insights UI.

**Calibration vs Learning boundary**: Both systems can influence the same signals. When fresh calibration exists (≤60 days), learning's score-level adjustments (`getSignalAccuracyAdjustments`) are suppressed — calibration captures them from a much larger dataset. Learning's prompt injection still runs, giving the AI portfolio-specific context ("your trades with bullish MACD won 45%") alongside calibration's market-wide view. When calibration is stale or absent, learning's ±1 score adjustments reactivate as the fallback.

**Chat Interface** (`sendMessage`): Conversational with portfolio context. Gated behind activation button. Special commands: `calibrate`, `backtest YYYY-MM-DD`.

**Google Drive**: OAuth 2.0 backup/restore, decision reasoning upload, encrypted API key sync.

## Design Constraints

**Single HTML Output**: Build produces one `index.html` — intentional for portability. Source split across `src/` for development.

**Cloudflare Worker Proxy**: All Claude API calls go through a CF Worker that injects the API key server-side and enables SSE streaming (avoids free-plan 100s timeout). Client-side `fetchAnthropicStreaming()` reconstructs Messages API response shape from SSE events.

**After-Hours Pricing**: `isMarketOpen()` checks ET timezone. When market is closed, price priority is `day.c > lastTrade.p`; when open, `lastTrade.p > day.c`. Change calculations recomputed from scratch when closed (Polygon's pre-computed values include extended-hours movement).

**XSS Prevention**: All AI/user content escaped via `escapeHtml()` before `innerHTML` insertion.

**Massive API**: Stocks Advanced + Indices Basic plan — unlimited calls (recommended <100 req/s). Caching is for performance, not rate limits.

## Portfolio State

Persisted to `localStorage`, backed up to Google Drive as `Apex_Portfolio.json`. Key fields: `cash`, `holdings`, `transactions`, `closedTrades`, `holdingTheses`, `performanceHistory`, `lastMarketRegime`, `lastCandidateScores`, `lastSectorRotation`, `lastVIX`, `holdSnapshots`, `regimeHistory`, `portfolioHealth`, `spyBaseline`/`spyCurrent`. Array caps on save: transactions (500), closedTrades (300), performanceHistory (3000).

## Known Issues

- **JSON parsing fragility** (largely mitigated): Multi-layered recovery — code fence extraction, citation stripping, `extractDecisionsArray` bracket-matching, `extractDecisionFromRawResponse` fallback
- **Technical indicators dual source**: Client-side RSI/MACD are approximations from ~65-day bars. Server values (`serverRsi`, `serverMacd`, `serverSma50`) use full history. Client for scoring, server for AI prompts.
- **Keyboard accessibility**: Collapsible sections use `<div onclick>` — should migrate to `<button>` with proper roles
- **FVG detection partial**: Detected and scored (±0.5) but not used in reversal filtering
- **Backtesting**: Early-stage, simplified execution model without full AI analysis

## Prompt Engineering

Prompts are inline in `trader.js`. Search for `"Phase 1"` and `"Phase 2"` in `runAIAnalysis`. Both use `system` for static instructions and `user` for runtime data. When modifying prompts, watch for:
- `updatedCash` must be correct in Phase 2's budget section
- JSON response format must remain parseable
- `formatPerformanceInsights()` → Phase 2, `formatPhase1Insights()` → Phase 1

## Development Notes

- Edit `src/`, rebuild with `build.cmd` / `build.sh`. **Never edit `index.html` directly.**
- Test with "Dry Run" button (fetches market data without calling Claude API)
- `let`/`const` throughout, `async/await` throughout
- Extensive console logging
