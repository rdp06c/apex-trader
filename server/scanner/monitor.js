// Background structure monitor for APEX holdings.
// Runs on a cron schedule during market hours, detects structure
// breakdowns on held positions, and sends ntfy.sh alerts.
// Also schedules full market scans at key times.

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { isMarketOpen, detectStructure, calculateRSI, calculateMACD, calculateATR, getATRMultiplier, classifyLossSignal, detectVolumeDivergence, calculateFibTargets, generateTradePlan } = require('../lib/scoring');
const { fetchBulkSnapshot, fetchGroupedDailyBars, fetchIntradayBars } = require('../lib/fetchers');
const { sendAlert } = require('./alerts');
const { runFullScan, getScanStatus, isScanRunning, getScanRunningInfo } = require('./full-scan');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PORTFOLIO_PATH = path.join(DATA_DIR, 'portfolio.json');
const STATE_PATH = path.join(DATA_DIR, 'scanner-state.json');
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between re-alerts for same condition
const TARGET_PCT = 10; // +10% take profit (FORGE-validated)
const STOP_PCT = 10;   // -10% cut loss (FORGE-validated)

function loadPortfolio() {
    try {
        if (!fs.existsSync(PORTFOLIO_PATH)) return null;
        return JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
    } catch (err) {
        console.error('Scanner: failed to read portfolio:', err.message);
        return null;
    }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_PATH)) return {};
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('Scanner: failed to save state:', err.message);
    }
}

function shouldAlert(state, symbol, condition) {
    const key = `${symbol}:${condition}`;
    const lastAlert = state.alerts && state.alerts[key];
    if (!lastAlert) return true;
    return Date.now() - lastAlert > ALERT_COOLDOWN_MS;
}

function recordAlert(state, symbol, condition) {
    if (!state.alerts) state.alerts = {};
    state.alerts[`${symbol}:${condition}`] = Date.now();
}

async function runStructureCheck({ force = false } = {}) {
    if (!force && !isMarketOpen()) {
        return;
    }

    const apiKey = process.env.MASSIVE_API_KEY;
    const ntfyTopic = process.env.NTFY_TOPIC;

    if (!apiKey) {
        console.warn('Scanner: MASSIVE_API_KEY not set — skipping');
        return;
    }

    const portfolio = loadPortfolio();
    if (!portfolio || !portfolio.holdings) return;

    const heldSymbols = Object.keys(portfolio.holdings).filter(s => portfolio.holdings[s] > 0);
    const watchlistSymbols = (portfolio.watchlist || []).filter(s => !portfolio.holdings?.[s]);
    if (heldSymbols.length === 0 && watchlistSymbols.length === 0) {
        console.log('Scanner: no holdings or watchlist to monitor');
        return;
    }

    console.log(`Scanner: checking ${heldSymbols.length} holdings${watchlistSymbols.length > 0 ? `, ${watchlistSymbols.length} watchlist` : ''}`);

    const state = loadState();
    const alerts = [];

    try {
        // Fetch current prices (holdings + watchlist)
        const allSymbols = [...heldSymbols, ...watchlistSymbols];
        const prices = await fetchBulkSnapshot(allSymbols, apiKey);

        // Fetch ~65-day bars for structure analysis
        const symbolSet = new Set(heldSymbols);
        const barsData = await fetchGroupedDailyBars(symbolSet, apiKey);

        for (const symbol of heldSymbols) {
            const bars = barsData[symbol];
            if (!bars || bars.length < 7) {
                console.warn(`Scanner: insufficient bars for ${symbol} (${bars?.length || 0})`);
                continue;
            }

            const current = detectStructure(bars);
            const rsi = calculateRSI(bars);
            const macd = calculateMACD(bars);
            const atr = calculateATR(bars);
            const volDiv = detectVolumeDivergence(bars);
            const fibTargets = calculateFibTargets(bars);
            const price = prices[symbol]?.price;
            const thesis = portfolio.holdingTheses && portfolio.holdingTheses[symbol];

            // ATR-based stop: VIX-aware multiplier (widens during elevated VIX)
            const entryPrice = thesis?.entryPrice || price;
            const vixLevel = portfolio.lastVIX?.level;
            const atrMult = getATRMultiplier(vixLevel);
            const atrStop = atr && entryPrice ? Math.round((entryPrice - atrMult * atr) * 100) / 100 : null;

            // Compute trade plan (R:R, S/R levels) — zero extra API calls, bars already fetched
            const tradePlan = generateTradePlan({
                price, bars, structure: current,
                vixLevel: vixLevel ?? null
            });

            // Compute loss signals with VIX-aware classification
            const setupType = thesis?.entrySetupType || null;
            const allSignals = [];
            const candidateNow = (portfolio.lastCandidateScores?.candidates || []).find(c => c.symbol === symbol);
            if (atrStop && price && price <= atrStop) allSignals.push('ATR stop');
            if (current.choch && current.chochType === 'bearish') allSignals.push('Bearish CHoCH');
            if (current.structure === 'bearish') allSignals.push('Bearish structure');
            if (thesis?.stopPrice && price && price <= thesis.stopPrice) allSignals.push('Stop breached');
            if (thesis?.entryRS != null && candidateNow?.rs != null && (candidateNow.rs - thesis.entryRS) <= -30)
                allSignals.push('RS collapse');
            if (thesis?.entryMomentum >= 7 && candidateNow?.momentum != null && candidateNow.momentum < 3)
                allSignals.push('Mom collapse');
            if (thesis?.entryStructure === 'bullish' && current.structure === 'bearish')
                allSignals.push('Structure flipped');
            if (volDiv.divergence && volDiv.direction === 'bearish') allSignals.push('Vol divergence');
            let holdDays = 0;
            if (thesis?.entryDate) {
                const start = new Date(thesis.entryDate);
                const end = new Date();
                const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
                const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
                while (d < endDay) {
                    d.setDate(d.getDate() + 1);
                    const dow = d.getDay();
                    if (dow !== 0 && dow !== 6) holdDays++;
                }
            }
            const holdReturn = thesis?.entryPrice && price ? ((price - thesis.entryPrice) / thesis.entryPrice) * 100 : null;
            if (holdDays >= 10 && holdReturn != null && Math.abs(holdReturn) <= 3) allSignals.push('Stale capital');

            // Split into actionable vs informational
            const lossSignals = [];
            const infoSignals = [];
            for (const sig of allSignals) {
                if (classifyLossSignal(sig, vixLevel, setupType) === 'actionable') {
                    lossSignals.push(sig);
                } else {
                    infoSignals.push(sig);
                }
            }

            // Store current readings in state
            if (!state.readings) state.readings = {};
            state.readings[symbol] = {
                structure: current.structure,
                structureSignal: current.structureSignal,
                structureScore: current.structureScore,
                choch: current.choch,
                chochType: current.chochType,
                rsi,
                macdCrossover: macd?.crossover || 'none',
                atr,
                atrStop,
                atrMultiplier: atrMult,
                volumeDivergence: volDiv,
                fibTargets,
                tradePlan: tradePlan || null,
                price,
                lossSignals,
                infoSignals,
                vixLevel: vixLevel ?? null,
                setupType: setupType ?? null,
                timestamp: new Date().toISOString()
            };

            // Alert conditions — only fire for actionable signals (skip dampened/informational)
            // Alert condition 1: Structure breakdown
            const entryStructure = thesis?.entryTechnicals?.structure || thesis?.entryStructure;
            if (entryStructure === 'bullish' && current.structure === 'bearish') {
                const isActionable = classifyLossSignal('Structure flipped', vixLevel, setupType) === 'actionable';
                if (isActionable && shouldAlert(state, symbol, 'structure-breakdown')) {
                    alerts.push({
                        symbol,
                        condition: 'structure-breakdown',
                        title: `APEX: ${symbol} Structure Breakdown`,
                        body: `${symbol} structure changed from bullish to bearish.\nPrice: $${price || '?'}\nSignal: ${current.structureSignal}\nScore: ${current.structureScore}`,
                        tags: ['chart_with_downwards_trend', 'warning']
                    });
                    recordAlert(state, symbol, 'structure-breakdown');
                }
            }

            // Alert condition 2: Bearish CHoCH
            if (current.choch && current.chochType === 'bearish') {
                const isActionable = classifyLossSignal('Bearish CHoCH', vixLevel, setupType) === 'actionable';
                if (isActionable && shouldAlert(state, symbol, 'bearish-choch')) {
                    alerts.push({
                        symbol,
                        condition: 'bearish-choch',
                        title: `APEX: ${symbol} Bearish CHoCH`,
                        body: `${symbol} detected bearish Change of Character.\nPrice: $${price || '?'}\nStructure: ${current.structure}\nPrevious swing pattern reversed.`,
                        tags: ['rotating_light']
                    });
                    recordAlert(state, symbol, 'bearish-choch');
                }
            }

            // Alert condition 3: Stop loss breached (manual or ATR-based) — always actionable
            const stopPrice = thesis?.stopPrice || thesis?.targets?.stop;
            const effectiveStop = stopPrice || atrStop;
            if (effectiveStop && price && price <= effectiveStop) {
                const stopType = stopPrice ? 'manual' : 'ATR';
                if (shouldAlert(state, symbol, 'stop-breached')) {
                    alerts.push({
                        symbol,
                        condition: 'stop-breached',
                        title: `APEX: ${symbol} ${stopType} Stop Breached`,
                        body: `${symbol} at $${price} is below ${stopType} stop of $${effectiveStop}.${atr ? `\nATR: $${atr} (${atrMult}×)` : ''}`,
                        tags: ['octagonal_sign']
                    });
                    recordAlert(state, symbol, 'stop-breached');
                }
            }

            // Alert condition 4: Bearish volume divergence
            if (volDiv.divergence && volDiv.direction === 'bearish') {
                const isActionable = classifyLossSignal('Vol divergence', vixLevel, setupType) === 'actionable';
                if (isActionable && shouldAlert(state, symbol, 'volume-divergence')) {
                    alerts.push({
                        symbol,
                        condition: 'volume-divergence',
                        title: `APEX: ${symbol} Volume Divergence`,
                        body: `${symbol} price rising but volume declining over ${volDiv.days} days.\nPrice trend: ${volDiv.priceTrend > 0 ? '+' : ''}${volDiv.priceTrend}%/day\nVolume trend: ${volDiv.volumeTrend}%/day`,
                        tags: ['chart_with_downwards_trend']
                    });
                    recordAlert(state, symbol, 'volume-divergence');
                }
            }

            // Alert condition 5: +10% target hit (FORGE take-profit)
            if (holdReturn != null && holdReturn >= TARGET_PCT) {
                if (shouldAlert(state, symbol, 'target-hit')) {
                    alerts.push({
                        symbol,
                        condition: 'target-hit',
                        title: `APEX: ${symbol} +${TARGET_PCT}% Target Hit`,
                        body: `${symbol} is up ${holdReturn.toFixed(1)}% from entry ($${thesis.entryPrice} → $${price}).\nConsider taking profit per FORGE playbook.`,
                        tags: ['money_with_wings', 'white_check_mark']
                    });
                    recordAlert(state, symbol, 'target-hit');
                }
            }

            // Alert condition 6: -10% stop hit (FORGE cut-loss)
            if (holdReturn != null && holdReturn <= -STOP_PCT) {
                if (shouldAlert(state, symbol, 'stop-hit')) {
                    alerts.push({
                        symbol,
                        condition: 'stop-hit',
                        title: `APEX: ${symbol} -${STOP_PCT}% Stop Hit`,
                        body: `${symbol} is down ${holdReturn.toFixed(1)}% from entry ($${thesis.entryPrice} → $${price}).\nConsider cutting loss per FORGE playbook.`,
                        tags: ['octagonal_sign', 'chart_with_downwards_trend']
                    });
                    recordAlert(state, symbol, 'stop-hit');
                }
            }
        }

        // Intraday signals (5-min bars) — only during market hours
        if (isMarketOpen()) {
            try {
                const intradayBars = await fetchIntradayBars(heldSymbols, apiKey);
                for (const symbol of heldSymbols) {
                    const bars5m = intradayBars[symbol];
                    if (!bars5m || bars5m.length < 14) continue;
                    const idRsi = calculateRSI(bars5m);
                    const idMacd = calculateMACD(bars5m);
                    const idStruct = detectStructure(bars5m);
                    if (state.readings[symbol]) {
                        state.readings[symbol].intraday = {
                            rsi: idRsi != null ? Math.round(idRsi * 100) / 100 : null,
                            macd: idMacd?.crossover || 'none',
                            macdHistogram: idMacd?.histogram ?? null,
                            structure: idStruct?.structure || null,
                            structureScore: idStruct?.structureScore ?? 0,
                            choch: idStruct?.choch || false,
                            chochType: idStruct?.chochType || null,
                            barCount: bars5m.length,
                            timestamp: new Date().toISOString()
                        };
                    }
                }
                console.log(`Intraday signals computed for ${Object.keys(intradayBars).length} holdings`);
            } catch (err) {
                console.warn('Intraday signal fetch failed:', err.message);
            }
        }

        // Watchlist: alert when price hits buy zone limit
        if (watchlistSymbols.length > 0) {
            const candidates = portfolio.lastCandidateScores?.candidates || [];
            const candidateMap = {};
            for (const c of candidates) candidateMap[c.symbol] = c;

            for (const symbol of watchlistSymbols) {
                const snap = prices[symbol];
                const price = snap?.price;
                if (!price) continue;

                const cand = candidateMap[symbol];
                const limitPrice = cand?.buyZonePrice;
                if (limitPrice == null) continue;

                if (price <= limitPrice && shouldAlert(state, symbol, 'watchlist-limit')) {
                    const distPct = ((price - limitPrice) / limitPrice * 100).toFixed(1);
                    alerts.push({
                        symbol,
                        condition: 'watchlist-limit',
                        title: `APEX: ${symbol} Hit Watchlist Limit`,
                        body: `${symbol} at $${price} hit buy zone limit $${limitPrice} (${distPct}%).\nSource: ${cand.buyZoneSource || 'n/a'}`,
                        tags: ['star', 'money_with_wings']
                    });
                    recordAlert(state, symbol, 'watchlist-limit');
                }
            }
        }

        // Send all alerts
        for (const alert of alerts) {
            await sendAlert({
                title: alert.title,
                body: alert.body,
                topic: ntfyTopic,
                priority: 'high',
                tags: alert.tags
            });
        }

        // Clean up readings for symbols no longer held
        if (state.readings) {
            const heldSet = new Set(heldSymbols);
            for (const sym of Object.keys(state.readings)) {
                if (!heldSet.has(sym)) {
                    delete state.readings[sym];
                }
            }
        }

        state.lastRun = new Date().toISOString();
        state.lastHoldings = heldSymbols;
        state.alertsSent = (state.alertsSent || 0) + alerts.length;
        saveState(state);

        console.log(`Scanner: complete. ${alerts.length} alert(s) sent.`);
    } catch (err) {
        console.error('Scanner: error during structure check:', err.message);
    }
}

function start() {
    // Structure check every 15 minutes
    cron.schedule('0,15,30,45 * * * *', () => {
        runStructureCheck().catch(err => {
            console.error('Scanner: unhandled error:', err.message);
        });
    });

    // Full market scan at 9:35 AM ET and 12:30 PM ET (weekdays)
    // 9:35 gives 5 min after open for prices to settle
    // 12:30 gives a midday update
    cron.schedule('35 9 * * 1-5', () => {
        console.log('Full scan: triggered (9:35 AM ET schedule)');
        runFullScan().catch(err => {
            console.error('Full scan: unhandled error:', err.message);
        });
    }, { timezone: 'America/New_York' });

    cron.schedule('30 12 * * 1-5', () => {
        console.log('Full scan: triggered (12:30 PM ET schedule)');
        runFullScan().catch(err => {
            console.error('Full scan: unhandled error:', err.message);
        });
    }, { timezone: 'America/New_York' });

    // End-of-day scan at 4:05 PM ET — captures final daily bar values
    // for after-hours review and manual trade signal enrichment
    cron.schedule('5 16 * * 1-5', () => {
        console.log('Full scan: triggered (4:05 PM ET schedule)');
        runFullScan({ force: true }).catch(err => {
            console.error('Full scan: unhandled error:', err.message);
        });
    }, { timezone: 'America/New_York' });

    console.log('Scanner: scheduled (structure check every 15 min, full scan 9:35 AM + 12:30 PM + 4:05 PM ET)');

    // Run structure check on startup if market is open
    if (isMarketOpen()) {
        console.log('Scanner: market is open, running initial check...');
        runStructureCheck().catch(err => {
            console.error('Scanner: initial check error:', err.message);
        });
    }
}

// GET /api/scanner/status handler
function getStatus() {
    const state = loadState();
    const scanState = getScanStatus();
    return {
        lastRun: state.lastRun || null,
        lastHoldings: state.lastHoldings || [],
        alertsSent: state.alertsSent || 0,
        readings: state.readings || {},
        marketOpen: isMarketOpen(),
        fullScan: {
            lastRun: scanState.lastRun || null,
            stocksScanned: scanState.stocksScanned || 0,
            duration: scanState.duration || 0,
            topScorers: scanState.topScorers || [],
            isRunning: isScanRunning(),
            runningInfo: getScanRunningInfo()
        }
    };
}

module.exports = { start, getStatus, runStructureCheck, runFullScan, isScanRunning };
