// Full market scan orchestrator for server-side execution.
// Runs the complete scoring pipeline on ~537 stocks and saves results
// to portfolio.json so the browser picks them up on next load.

const fs = require('fs');
const path = require('path');
const {
    calculateRSI, calculateSMA, calculateMACD, calculateSMACrossover,
    detectStructure, calculate5DayMomentum, calculateVolumeRatio,
    calculateRelativeStrength, detectSectorRotation, calculateCompositeScore,
    getActiveWeights, isMarketOpen, detectMarketRegime, evaluateEntrySignals,
    evaluateComboHeat, computeComboHeatBonus, computeBuyZone, generateTradePlan,
    calculateVCR, calculateRangePosition, calculateADX, calculateROC,
    countHigherLows, calculateOBVSlope, calculateGapAnalysis
} = require('../lib/scoring');
const {
    fetchBulkSnapshot, fetchGroupedDailyBars, fetchServerIndicators,
    fetchTickerDetails, fetchShortInterest, fetchVIX
} = require('../lib/fetchers');
const { stockSectors, getAllSymbols } = require('../lib/stocks');
const { sendAlert } = require('./alerts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PORTFOLIO_PATH = path.join(DATA_DIR, 'portfolio.json');
const SCAN_STATE_PATH = path.join(DATA_DIR, 'scan-state.json');

function loadPortfolio() {
    try {
        if (!fs.existsSync(PORTFOLIO_PATH)) return null;
        return JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
    } catch (err) {
        console.error('Full scan: failed to read portfolio:', err.message);
        return null;
    }
}

function savePortfolio(portfolio) {
    const tmpPath = PORTFOLIO_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(portfolio), 'utf8');
    fs.renameSync(tmpPath, PORTFOLIO_PATH);
}

function loadScanState() {
    try {
        if (!fs.existsSync(SCAN_STATE_PATH)) return {};
        return JSON.parse(fs.readFileSync(SCAN_STATE_PATH, 'utf8'));
    } catch { return {}; }
}

function saveScanState(state) {
    try {
        fs.writeFileSync(SCAN_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('Full scan: failed to save state:', err.message);
    }
}

let scanRunning = false;
let scanStartTime = null;

function isScanRunning() {
    return scanRunning;
}

function getScanRunningInfo() {
    if (!scanRunning) return null;
    return { startTime: scanStartTime, elapsed: Math.round((Date.now() - scanStartTime) / 1000) };
}

/**
 * Run a full market scan — fetches data and scores all ~537 stocks.
 * Results are saved to portfolio.json fields that the browser reads:
 *   lastCandidateScores, lastSectorRotation, lastVIX, lastFullScan
 */
async function runFullScan({ force = false } = {}) {
    if (scanRunning) {
        console.log('Full scan: already running, skipping');
        return { skipped: true };
    }

    if (!force && !isMarketOpen()) {
        console.log('Full scan: market closed, skipping');
        return null;
    }

    scanRunning = true;
    scanStartTime = Date.now();

    const apiKey = process.env.MASSIVE_API_KEY;
    const anthropicApiUrl = process.env.ANTHROPIC_API_URL;
    const ntfyTopic = process.env.NTFY_TOPIC;

    if (!apiKey || apiKey === 'your_api_key_here') {
        console.warn('Full scan: MASSIVE_API_KEY not set — skipping');
        return null;
    }

    const startTime = Date.now();
    const allSymbols = getAllSymbols();
    console.log(`Full scan: starting for ${allSymbols.length} stocks...`);

    try {
        // Phase 1: Fetch all market data in parallel where possible
        console.log('Full scan: Phase 1 — fetching market data...');

        // Bulk snapshot in batches (API has ~250 ticker limit per call)
        const snapshotBatches = [];
        for (let i = 0; i < allSymbols.length; i += 250) {
            snapshotBatches.push(allSymbols.slice(i, i + 250));
        }
        let marketData = {};
        for (const batch of snapshotBatches) {
            const batchResult = await fetchBulkSnapshot(batch, apiKey);
            Object.assign(marketData, batchResult);
        }
        console.log(`Full scan: snapshot prices for ${Object.keys(marketData).length} stocks`);

        // Grouped daily bars (the heavy lift — 80 API calls)
        const symbolSet = new Set(allSymbols);
        const multiDayCache = await fetchGroupedDailyBars(symbolSet, apiKey);
        console.log(`Full scan: bars for ${Object.keys(multiDayCache).length} stocks`);

        // Server indicators, ticker details, short interest, VIX — run in parallel
        const [serverIndicators, tickerDetails, shortInterest, vixData] = await Promise.all([
            fetchServerIndicators(allSymbols, apiKey),
            fetchTickerDetails(allSymbols, apiKey),
            fetchShortInterest(allSymbols, apiKey),
            fetchVIX(apiKey, anthropicApiUrl)
        ]);

        // Phase 2: Compute scores
        console.log('Full scan: Phase 2 — computing scores...');

        // Sector rotation analysis
        const sectorRotation = detectSectorRotation(marketData, stockSectors, multiDayCache);

        // Build sector groups for RS calculation
        const sectorGroups = {};
        for (const [symbol, data] of Object.entries(marketData)) {
            const sector = stockSectors[symbol] || 'Unknown';
            if (!sectorGroups[sector]) sectorGroups[sector] = [];
            sectorGroups[sector].push({ symbol, ...data });
        }

        // Load portfolio for calibrated weights
        const portfolio = loadPortfolio();
        const calibratedWeights = portfolio?.calibratedWeights;
        const comboResults = calibratedWeights?.signalCombos?.combos || null;
        const vixLevel = vixData?.level;
        const weights = getActiveWeights(calibratedWeights, vixLevel);

        // Score every stock
        const candidateScores = [];
        let scored = 0;

        for (const symbol of allSymbols) {
            const priceData = marketData[symbol];
            if (!priceData) continue;

            const bars = multiDayCache[symbol];
            const sector = stockSectors[symbol] || 'Unknown';

            // Momentum
            const momentum = calculate5DayMomentum(priceData, bars);

            // Relative strength
            const sectorStocks = sectorGroups[sector] || [];
            const rs = calculateRelativeStrength(priceData, sectorStocks, bars, multiDayCache);
            const rsNormalized = rs.rsScore / 10;

            // Structure
            const structure = bars ? detectStructure(bars) : { structureScore: 0, fvg: 'none' };

            // Technical indicators (prefer server values, fall back to client calculation)
            const si = serverIndicators[symbol] || {};
            const rsi = si.serverRsi ?? calculateRSI(bars);
            const macd = si.serverMacd
                ? { crossover: si.serverMacd.histogram > 0 ? 'bullish' : 'bearish', histogram: si.serverMacd.histogram }
                : calculateMACD(bars);
            const sma20 = calculateSMA(bars, 20);
            const smaCrossover = calculateSMACrossover(bars);

            // Volume and short interest
            const volRatio = calculateVolumeRatio(bars);
            const si_data = shortInterest[symbol];
            const daysToCover = si_data?.daysToCover || 0;

            // Sector flow
            const sectorInfo = sectorRotation[sector];
            const sectorFlow = sectorInfo?.moneyFlow || 'neutral';

            // New indicators
            const vcrResult = calculateVCR(bars);
            const rangePosResult = calculateRangePosition(bars);
            const adxResult = calculateADX(bars);
            const rocResult = calculateROC(bars);
            const hlResult = countHigherLows(bars);
            const obvResult = calculateOBVSlope(bars);
            const gapResult = calculateGapAnalysis(bars);

            // Combo heat bonus from calibration data
            const heatCandidate = {
                rsi,
                macdCrossover: macd?.crossover || 'none',
                structureScore: structure.structureScore,
                return5d: momentum.totalReturn5d,
                momentum: momentum.score,
                rs: rs.rsScore,
                dayChange: priceData.changePercent,
                sectorFlow,
                sma20,
                price: priceData.price,
                isAccelerating: momentum.isAccelerating,
                upDays: momentum.upDays,
                totalDays: momentum.totalDays,
                fvg: structure.fvg,
                smaCrossover: smaCrossover?.crossover || 'none',
                volumeRatio: volRatio?.ratio ?? null,
                volumeTrend: momentum.volumeTrend,
                vcr: vcrResult?.vcr ?? null,
                rangePosition: rangePosResult?.rangePos ?? null,
                adx: adxResult?.adx ?? null,
                higherLowCount: hlResult?.count ?? 0
            };
            // Compute entry signal first — needed to scale heat bonus
            const entrySignal = evaluateEntrySignals({
                macdCrossover: macd?.crossover || 'none', rsi,
                macdHistogram: macd?.histogram ?? null,
                structure: structure.structure, structureScore: structure.structureScore,
                return5d: momentum.totalReturn5d ?? null,
                momentum: momentum.score, momentumScore: momentum.score,
                rs: rs.rsScore, volumeTrend: momentum.volumeTrend,
                volumeRatio: volRatio?.ratio ?? null,
                dayChange: priceData.changePercent,
                isAccelerating: momentum.isAccelerating,
                daysToCover, sectorFlow,
                smaCrossover: smaCrossover?.crossover || 'none'
            });
            const comboHeat = evaluateComboHeat(heatCandidate, comboResults);
            // Scale heat to 33% when no entry signal (heat without signal = "forming, not confirmed")
            const rawHeatBonus = computeComboHeatBonus(comboHeat);
            const heatBonus = entrySignal?.bestMatch ? rawHeatBonus : Math.round(rawHeatBonus * 0.33 * 10) / 10;

            // Composite score
            const score = calculateCompositeScore({
                momentumScore: momentum.score,
                rsNormalized,
                sectorFlow,
                structureScore: structure.structureScore,
                isAccelerating: momentum.isAccelerating,
                upDays: momentum.upDays,
                totalDays: momentum.totalDays,
                todayChange: priceData.changePercent,
                totalReturn5d: momentum.totalReturn5d,
                rsi,
                macdCrossover: macd?.crossover || 'none',
                daysToCover,
                volumeTrend: momentum.volumeTrend,
                fvg: structure.fvg,
                sma20,
                currentPrice: priceData.price,
                smaCrossover,
                comboHeatBonus: heatBonus,
                rangePosition: rangePosResult?.rangePos ?? null,
                higherLowCount: hlResult?.count ?? 0
            }, weights);

            // Market cap formatting
            const td = tickerDetails[symbol];
            let marketCapFormatted = null;
            if (td?.marketCap) {
                const mc = td.marketCap;
                if (mc >= 1e12) marketCapFormatted = (mc / 1e12).toFixed(1) + 'T';
                else if (mc >= 1e9) marketCapFormatted = (mc / 1e9).toFixed(1) + 'B';
                else if (mc >= 1e6) marketCapFormatted = (mc / 1e6).toFixed(0) + 'M';
                else marketCapFormatted = mc.toString();
            }

            // Match browser's lastCandidateScores.candidates format exactly
            candidateScores.push({
                symbol,
                compositeScore: Math.round(score.total * 10) / 10,
                price: priceData.price,
                dayChange: Math.round(priceData.changePercent * 100) / 100,
                return5d: momentum.totalReturn5d ?? null,
                momentum: momentum.score,
                rs: rs.rsScore,
                sector,
                sectorFlow,
                sectorBonus: sectorFlow === 'inflow' ? 2 : sectorFlow === 'modest-inflow' ? 1 : sectorFlow === 'outflow' ? -1 : 0,
                structureScore: structure.structureScore,
                structure: structure.structure,
                rsi,
                macdCrossover: macd?.crossover || 'none',
                macdHistogram: macd?.histogram ?? null,
                marketCap: td?.marketCap || null,
                marketCapFormatted,
                daysToCover,
                name: td?.name || null,
                sma50: smaCrossover?.sma50 ?? si.serverSma50 ?? null,
                smaCrossover: smaCrossover?.crossover || 'none',
                volumeRatio: volRatio?.ratio ?? null,
                volumeTrend: momentum.volumeTrend ?? null,
                scoreBreakdown: score.breakdown,
                serverRsi: si.serverRsi ?? null,
                serverMacd: si.serverMacd ?? null,
                serverSma50: si.serverSma50 ?? null,
                entrySignal,
                vcr: vcrResult?.vcr ?? null,
                rangePosition: rangePosResult?.rangePos ?? null,
                adx: adxResult?.adx ?? null,
                roc5: rocResult?.roc5 ?? null,
                roc10: rocResult?.roc10 ?? null,
                roc20: rocResult?.roc20 ?? null,
                rocDivergence: rocResult?.divergence ?? null,
                higherLowCount: hlResult?.count ?? 0,
                obvSlope: obvResult?.normalized ?? null,
                obvDivergence: obvResult?.bullishDivergence ? 'bullish' : obvResult?.bearishDivergence ? 'bearish' : 'none',
                gapPct: gapResult?.gapPct ?? 0,
                sma20: sma20 ?? null
            });

            // Compute buy zone for this candidate (uses same data already fetched)
            const tradePlan = generateTradePlan({
                price: priceData.price, bars, structure, vixLevel,
                entrySignalPatterns: null, comboResults, comboHeat
            });
            const buyZone = computeBuyZone({
                price: priceData.price,
                support: tradePlan?.support ?? null,
                sma20,
                bars,
                vixLevel
            });
            const lastCandidate = candidateScores[candidateScores.length - 1];
            if (buyZone) {
                lastCandidate.buyZonePrice = buyZone.buyZonePrice;
                lastCandidate.buyZoneDistance = buyZone.distancePct;
                lastCandidate.buyZoneInZone = buyZone.inZone;
                lastCandidate.buyZoneSource = buyZone.zoneSource;
            }

            scored++;
        }

        console.log(`Full scan: scored ${scored} stocks`);

        // Combo heat bonus is included in compositeScore (via comboHeatBonus param).
        // Signal bonus (computeSignalBonus) is applied at display time in the browser,
        // not persisted into scores, to avoid cumulative inflation across re-renders.

        // Sort by composite score descending (matches browser behavior)
        candidateScores.sort((a, b) => b.compositeScore - a.compositeScore);

        // Phase 3: Save results to portfolio (format matches browser's lastCandidateScores)
        // Re-read portfolio right before writing to avoid overwriting browser changes
        // (the scan takes minutes; the browser may have saved trades in the meantime)
        const freshPortfolio = loadPortfolio() || {};
        freshPortfolio.lastCandidateScores = {
            timestamp: new Date().toISOString(),
            candidates: candidateScores,
            source: 'server'
        };
        freshPortfolio.lastSectorRotation = sectorRotation;
        if (vixData) {
            freshPortfolio.lastVIX = vixData;
        }
        const regimeResult = detectMarketRegime(vixData?.level, sectorRotation, marketData, multiDayCache);
        freshPortfolio.lastMarketRegime = { regime: regimeResult.regime, score: regimeResult.score, signals: regimeResult.signals, timestamp: new Date().toISOString() };
        console.log(`Full scan: regime ${regimeResult.regime.toUpperCase()} (score ${regimeResult.score})`, regimeResult.signals);

        // Record regime transition in history
        const normalized = regimeResult.regime.toLowerCase().includes('bull') ? 'bull' : regimeResult.regime.toLowerCase().includes('bear') ? 'bear' : 'choppy';
        if (!freshPortfolio.regimeHistory) freshPortfolio.regimeHistory = [];
        const lastRegime = freshPortfolio.regimeHistory.length > 0 ? freshPortfolio.regimeHistory[freshPortfolio.regimeHistory.length - 1] : null;
        if (lastRegime && lastRegime.regime === normalized) {
            lastRegime.lastSeen = new Date().toISOString();
        } else {
            freshPortfolio.regimeHistory.push({ regime: normalized, timestamp: new Date().toISOString(), lastSeen: new Date().toISOString(), from: lastRegime ? lastRegime.regime : null });
            if (freshPortfolio.regimeHistory.length > 200) freshPortfolio.regimeHistory = freshPortfolio.regimeHistory.slice(-200);
            console.log(`Regime transition: ${lastRegime ? lastRegime.regime : 'none'} → ${normalized}`);
        }
        freshPortfolio.lastFullScan = {
            timestamp: new Date().toISOString(),
            stocksScanned: scored,
            duration: Math.round((Date.now() - startTime) / 1000)
        };

        savePortfolio(freshPortfolio);

        // Record daily health snapshots for held positions
        const today = new Date().toISOString().slice(0, 10);
        let healthRecorded = 0;
        if (freshPortfolio.holdingTheses) {
            for (const symbol of Object.keys(freshPortfolio.holdings || {})) {
                const thesis = freshPortfolio.holdingTheses[symbol];
                if (!thesis) continue;
                if (!thesis.healthHistory) thesis.healthHistory = [];

                // Deduplicate: skip if already recorded today
                if (thesis.healthHistory.length > 0 && thesis.healthHistory[thesis.healthHistory.length - 1].date === today) continue;

                const candidate = candidateScores.find(c => c.symbol === symbol);
                if (!candidate) continue;

                thesis.healthHistory.push({
                    date: today,
                    price: candidate.price,
                    rs: candidate.rs,
                    momentum: candidate.momentum,
                    rsi: candidate.rsi ?? candidate.serverRsi ?? null,
                    macd: candidate.macdCrossover,
                    structure: candidate.structure,
                    compositeScore: candidate.compositeScore
                });

                // Cap at 120 entries (~4 months of daily data)
                if (thesis.healthHistory.length > 120) thesis.healthHistory = thesis.healthHistory.slice(-120);
                healthRecorded++;
            }
            if (healthRecorded > 0) {
                savePortfolio(freshPortfolio);
                console.log(`Full scan: recorded health snapshots for ${healthRecorded} holdings`);
            }
        }

        // Save scan state
        const scanState = loadScanState();
        scanState.lastRun = new Date().toISOString();
        scanState.stocksScanned = scored;
        scanState.duration = Math.round((Date.now() - startTime) / 1000);
        scanState.topScorers = candidateScores
            .slice(0, 10)
            .map(c => ({ symbol: c.symbol, score: c.compositeScore, price: c.price }));
        saveScanState(scanState);

        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`Full scan: complete in ${duration}s — ${scored} stocks scored`);

        // Notify via ntfy
        if (ntfyTopic) {
            const top5 = scanState.topScorers.slice(0, 5)
                .map(s => `${s.symbol}: ${s.score}`)
                .join(', ');
            await sendAlert({
                title: 'APEX Full Scan Complete',
                body: `${scored} stocks scored in ${duration}s\nTop: ${top5}`,
                topic: ntfyTopic,
                priority: 'low',
                tags: ['mag']
            }).catch(() => {});
        }

        return { scored, duration, topScorers: scanState.topScorers };
    } catch (err) {
        console.error('Full scan: error:', err.message);
        console.error(err.stack);

        if (ntfyTopic) {
            await sendAlert({
                title: 'APEX Full Scan Failed',
                body: err.message,
                topic: ntfyTopic,
                priority: 'high',
                tags: ['x']
            }).catch(() => {});
        }

        return null;
    } finally {
        scanRunning = false;
        scanStartTime = null;
    }
}

function getScanStatus() {
    return loadScanState();
}

module.exports = { runFullScan, getScanStatus, isScanRunning, getScanRunningInfo };
