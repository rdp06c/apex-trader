// Background structure monitor for APEX holdings.
// Runs on a cron schedule during market hours, detects structure
// breakdowns on held positions, and sends ntfy.sh alerts.

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { isMarketOpen, detectStructure, calculateRSI, calculateMACD } = require('../lib/scoring');
const { fetchBulkSnapshot, fetchGroupedDailyBars } = require('../lib/fetchers');
const { sendAlert } = require('./alerts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PORTFOLIO_PATH = path.join(DATA_DIR, 'portfolio.json');
const STATE_PATH = path.join(DATA_DIR, 'scanner-state.json');
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between re-alerts for same condition

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

async function runStructureCheck() {
    if (!isMarketOpen()) {
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
    if (heldSymbols.length === 0) {
        console.log('Scanner: no holdings to monitor');
        return;
    }

    console.log(`Scanner: checking structure for ${heldSymbols.length} holdings: ${heldSymbols.join(', ')}`);

    const state = loadState();
    const alerts = [];

    try {
        // Fetch current prices
        const prices = await fetchBulkSnapshot(heldSymbols, apiKey);

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
            const price = prices[symbol]?.price;
            const thesis = portfolio.holdingTheses && portfolio.holdingTheses[symbol];

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
                price,
                timestamp: new Date().toISOString()
            };

            // Alert condition 1: Structure breakdown
            // Entry was bullish, current is bearish
            const entryStructure = thesis?.entryTechnicals?.structure || thesis?.entryStructure;
            if (entryStructure === 'bullish' && current.structure === 'bearish') {
                if (shouldAlert(state, symbol, 'structure-breakdown')) {
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
                if (shouldAlert(state, symbol, 'bearish-choch')) {
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

            // Alert condition 3: Stop loss breached
            const stopPrice = thesis?.stopPrice || thesis?.targets?.stop;
            if (stopPrice && price && price <= stopPrice) {
                if (shouldAlert(state, symbol, 'stop-breached')) {
                    alerts.push({
                        symbol,
                        condition: 'stop-breached',
                        title: `APEX: ${symbol} Stop Loss Breached`,
                        body: `${symbol} at $${price} is below stop of $${stopPrice}.`,
                        tags: ['octagonal_sign']
                    });
                    recordAlert(state, symbol, 'stop-breached');
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
    // Run every 15 minutes
    cron.schedule('0,15,30,45 * * * *', () => {
        runStructureCheck().catch(err => {
            console.error('Scanner: unhandled error:', err.message);
        });
    });

    console.log('Scanner: scheduled (every 15 min during market hours)');

    // Run once on startup if market is open
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
    return {
        lastRun: state.lastRun || null,
        lastHoldings: state.lastHoldings || [],
        alertsSent: state.alertsSent || 0,
        readings: state.readings || {},
        marketOpen: isMarketOpen()
    };
}

module.exports = { start, getStatus, runStructureCheck };
