// Massive (Polygon.io) API wrappers for server-side Node.js usage.
// Adapted from browser fetch functions in src/trader.js — stripped of
// DOM callbacks, localStorage caching, and global state mutations.

const fs = require('fs');
const path = require('path');
const { isMarketOpen } = require('./scoring');

const CACHE_DIR = path.join(__dirname, '..', 'data');

function loadDiskCache(filename, ttlMs) {
    const filePath = path.join(CACHE_DIR, filename);
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw._timestamp && Date.now() - raw._timestamp < ttlMs) {
            const { _timestamp, ...data } = raw;
            return data;
        }
    } catch { /* corrupt cache, ignore */ }
    return null;
}

function saveDiskCache(filename, data) {
    try {
        const filePath = path.join(CACHE_DIR, filename);
        fs.writeFileSync(filePath, JSON.stringify({ _timestamp: Date.now(), ...data }), 'utf8');
    } catch (err) {
        console.warn(`Failed to save cache ${filename}:`, err.message);
    }
}

/**
 * Fetch bulk snapshot prices for a set of symbols.
 * Returns { [symbol]: { price, change, changePercent, vwap } }
 */
async function fetchBulkSnapshot(symbols, apiKey) {
    const tickerParam = symbols.join(',');
    const response = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerParam}&apiKey=${apiKey}`
    );
    const data = await response.json();

    if (!data || data.status !== 'OK' || !data.tickers || data.tickers.length === 0) {
        console.warn('Bulk snapshot returned no data');
        return {};
    }

    const marketOpen = isMarketOpen();
    const result = {};

    for (const ticker of data.tickers) {
        const sym = ticker.ticker;
        const day = ticker.day;
        const prevDay = ticker.prevDay;
        if (!day || !prevDay) continue;

        let currentPrice;
        if (marketOpen) {
            currentPrice = (ticker.lastTrade && ticker.lastTrade.p) || day.c || day.l;
        } else {
            currentPrice = day.c || (ticker.lastTrade && ticker.lastTrade.p) || day.l;
        }
        const prevClose = prevDay.c;
        if (!currentPrice || currentPrice === 0) currentPrice = prevClose;
        if (!currentPrice || !prevClose) continue;

        let change, changePercent;
        if (marketOpen && ticker.todaysChange != null) {
            change = ticker.todaysChange;
            changePercent = ticker.todaysChangePerc;
        } else {
            change = currentPrice - prevClose;
            changePercent = (currentPrice - prevClose) / prevClose * 100;
        }

        result[sym] = {
            price: parseFloat(currentPrice),
            change: parseFloat(change),
            changePercent: parseFloat(changePercent),
            vwap: day.vw ? parseFloat(day.vw) : null
        };
    }

    console.log(`Bulk snapshot: ${Object.keys(result).length}/${symbols.length} tickers`);
    return result;
}

/**
 * Fetch ~65 days of grouped daily bars for a set of symbols.
 * Returns { [symbol]: [{o, h, l, c, v, t}, ...] } sorted by timestamp ascending.
 */
async function fetchGroupedDailyBars(symbolSet, apiKey) {
    const symbols = symbolSet instanceof Set ? symbolSet : new Set(symbolSet);
    const multiDayCache = {};

    // Compute 80 most recent weekdays
    const tradingDates = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    while (tradingDates.length < 80) {
        d.setDate(d.getDate() - 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            tradingDates.push(`${yyyy}-${mm}-${dd}`);
        }
    }
    tradingDates.reverse();

    console.log(`Fetching grouped daily bars for ${tradingDates.length} trading days...`);

    const BATCH = 20;
    let fetchedDates = 0, skippedDates = 0;
    const failedDates = [];

    async function fetchGroupedDate(dateStr) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(
                `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${apiKey}`,
                { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            if (!response.ok) return { dateStr, bars: [] };
            const data = await response.json();
            if (data.resultsCount === 0 || !data.results) {
                return { dateStr, bars: [], holiday: true };
            }
            return { dateStr, bars: data.results };
        } catch (err) {
            clearTimeout(timeoutId);
            return { dateStr, bars: [], error: err.name === 'AbortError' ? 'timeout' : err.message };
        }
    }

    for (let i = 0; i < tradingDates.length; i += BATCH) {
        const batch = tradingDates.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(fetchGroupedDate));

        for (const result of batchResults) {
            if (result.error) { failedDates.push(result.dateStr); continue; }
            if (result.bars.length === 0) { skippedDates++; continue; }
            fetchedDates++;
            for (const bar of result.bars) {
                if (!symbols.has(bar.T)) continue;
                if (!multiDayCache[bar.T]) multiDayCache[bar.T] = [];
                multiDayCache[bar.T].push({ o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, t: bar.t });
            }
        }
    }

    // Retry failed dates
    if (failedDates.length > 0) {
        console.log(`Retrying ${failedDates.length} failed dates...`);
        for (const dateStr of failedDates) {
            await new Promise(r => setTimeout(r, 300));
            const result = await fetchGroupedDate(dateStr);
            if (result.bars.length > 0) {
                fetchedDates++;
                for (const bar of result.bars) {
                    if (!symbols.has(bar.T)) continue;
                    if (!multiDayCache[bar.T]) multiDayCache[bar.T] = [];
                    multiDayCache[bar.T].push({ o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, t: bar.t });
                }
            } else {
                skippedDates++;
            }
        }
    }

    // Sort each ticker's bars by timestamp ascending
    for (const sym of Object.keys(multiDayCache)) {
        multiDayCache[sym].sort((a, b) => a.t - b.t);
    }

    console.log(`Grouped daily bars: ${Object.keys(multiDayCache).length} stocks, ${fetchedDates} dates, ${skippedDates} holidays`);
    return multiDayCache;
}

/**
 * Fetch server-computed indicators (RSI, MACD, SMA50) from Massive API.
 * Returns { [symbol]: { serverRsi, serverMacd: {macd, signal, histogram}, serverSma50 } }
 */
async function fetchServerIndicators(symbols, apiKey) {
    if (!apiKey) return {};

    console.log(`Fetching server-computed indicators for ${symbols.length} symbols...`);
    const result = {};
    const BATCH = 25;
    let fetched = 0;

    for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        await Promise.all(batch.map(async (symbol) => {
            try {
                const [rsiRes, macdRes, smaRes] = await Promise.all([
                    fetch(`https://api.polygon.io/v1/indicators/rsi/${symbol}?timespan=day&window=14&series_type=close&limit=1&apiKey=${apiKey}`).then(r => r.json()).catch(() => null),
                    fetch(`https://api.polygon.io/v1/indicators/macd/${symbol}?timespan=day&short_window=12&long_window=26&signal_window=9&series_type=close&limit=1&apiKey=${apiKey}`).then(r => r.json()).catch(() => null),
                    fetch(`https://api.polygon.io/v1/indicators/sma/${symbol}?timespan=day&window=50&series_type=close&limit=1&apiKey=${apiKey}`).then(r => r.json()).catch(() => null)
                ]);

                const entry = {};
                if (rsiRes?.results?.values?.[0]) {
                    entry.serverRsi = Math.round(rsiRes.results.values[0].value * 100) / 100;
                }
                if (macdRes?.results?.values?.[0]) {
                    const mv = macdRes.results.values[0];
                    entry.serverMacd = {
                        macd: Math.round((mv.value || 0) * 1000) / 1000,
                        signal: Math.round((mv.signal || 0) * 1000) / 1000,
                        histogram: Math.round((mv.histogram || 0) * 1000) / 1000
                    };
                }
                if (smaRes?.results?.values?.[0]) {
                    entry.serverSma50 = Math.round(smaRes.results.values[0].value * 100) / 100;
                }

                if (Object.keys(entry).length > 0) {
                    result[symbol] = entry;
                    fetched++;
                }
            } catch (err) {
                // Silently skip failed fetches
            }
        }));
        if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Server indicators fetched: ${fetched}/${symbols.length} symbols`);
    return result;
}

/**
 * Fetch ticker details (market cap, shares outstanding) from Massive API.
 * Cached to disk for 7 days — market cap doesn't change fast enough to re-fetch every scan.
 * Returns { [symbol]: { marketCap, sicDescription, name, sharesOutstanding } }
 */
async function fetchTickerDetails(symbols, apiKey) {
    if (!apiKey) return {};

    const TICKER_DETAILS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
    const cached = loadDiskCache('ticker-details-cache.json', TICKER_DETAILS_TTL);

    if (cached) {
        const uncached = symbols.filter(s => !cached[s]);
        if (uncached.length === 0) {
            console.log(`Ticker details: all ${symbols.length} from disk cache`);
            return cached;
        }
        // Partial cache hit — only fetch missing symbols
        console.log(`Ticker details: ${symbols.length - uncached.length} cached, fetching ${uncached.length} new...`);
        const fresh = await _fetchTickerDetailsRaw(uncached, apiKey);
        const merged = { ...cached, ...fresh };
        saveDiskCache('ticker-details-cache.json', merged);
        return merged;
    }

    console.log(`Ticker details: no cache, fetching all ${symbols.length}...`);
    const result = await _fetchTickerDetailsRaw(symbols, apiKey);
    saveDiskCache('ticker-details-cache.json', result);
    return result;
}

async function _fetchTickerDetailsRaw(symbols, apiKey) {
    const result = {};
    const BATCH = 50;
    let fetched = 0;

    for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        await Promise.all(batch.map(async (symbol) => {
            try {
                const response = await fetch(
                    `https://api.polygon.io/v3/reference/tickers/${symbol}?apiKey=${apiKey}`
                );
                if (!response.ok) return;
                const data = await response.json();
                if (data.results) {
                    result[symbol] = {
                        marketCap: data.results.market_cap || null,
                        sicDescription: data.results.sic_description || null,
                        name: data.results.name || null,
                        sharesOutstanding: data.results.share_class_shares_outstanding || null
                    };
                    fetched++;
                }
            } catch (err) {
                // Silently skip
            }
        }));
        if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Ticker details: ${fetched} fetched from API`);
    return result;
}

/**
 * Fetch short interest data from Massive API.
 * Cached to disk for 24 hours — short interest updates biweekly.
 * Returns { [symbol]: { shortInterest, daysToCover, avgDailyVolume, settlementDate } }
 */
async function fetchShortInterest(symbols, apiKey) {
    if (!apiKey) return {};

    const SHORT_INTEREST_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const cached = loadDiskCache('short-interest-cache.json', SHORT_INTEREST_TTL);

    if (cached) {
        const hitCount = symbols.filter(s => cached[s]).length;
        if (hitCount >= symbols.length * 0.8) {
            console.log(`Short interest: ${hitCount}/${symbols.length} from disk cache`);
            return cached;
        }
    }

    console.log(`Fetching short interest data...`);
    const result = cached || {};
    const BATCH = 250;

    for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        try {
            const tickerParam = batch.join(',');
            const response = await fetch(
                `https://api.polygon.io/stocks/v1/short-interest?ticker.any_of=${tickerParam}&order=desc&limit=1000&sort=settlement_date&apiKey=${apiKey}`
            );
            if (!response.ok) {
                console.warn(`Short interest fetch HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (data.results) {
                for (const entry of data.results) {
                    const sym = entry.ticker;
                    if (!result[sym]) {
                        result[sym] = {
                            shortInterest: entry.short_volume || entry.current_short_position || 0,
                            daysToCover: entry.days_to_cover || 0,
                            avgDailyVolume: entry.avg_daily_volume || 0,
                            settlementDate: entry.settlement_date || null
                        };
                    }
                }
            }
        } catch (err) {
            console.warn('Short interest fetch error:', err.message);
        }
    }

    saveDiskCache('short-interest-cache.json', result);
    console.log(`Short interest: ${Object.keys(result).length} stocks`);
    return result;
}

/**
 * Fetch VIX data. Tries Polygon indices API.
 * Returns { level, prevClose, change, changePercent, trend, interpretation }
 */
async function fetchVIX(apiKey, anthropicApiUrl) {
    function buildVixResult(level, prevClose) {
        const change = level - prevClose;
        const changePercent = prevClose !== 0 ? ((level - prevClose) / prevClose) * 100 : 0;
        const trend = changePercent > 5 ? 'rising' : changePercent < -5 ? 'falling' : 'stable';
        let interpretation;
        if (level < 15) interpretation = 'complacent';
        else if (level <= 20) interpretation = 'normal';
        else if (level <= 30) interpretation = 'elevated';
        else interpretation = 'panic';
        return { level, prevClose, change, changePercent, trend, interpretation };
    }

    // Try Yahoo via worker proxy first
    if (anthropicApiUrl) {
        try {
            const baseUrl = anthropicApiUrl.replace(/\/+$/, '');
            const resp = await fetch(`${baseUrl}/vix`);
            if (resp.ok) {
                const data = await resp.json();
                const meta = data.chart?.result?.[0]?.meta;
                if (meta && typeof meta.regularMarketPrice === 'number') {
                    const level = meta.regularMarketPrice;
                    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? level;
                    console.log(`VIX: ${level.toFixed(1)} via yahoo proxy`);
                    return buildVixResult(level, prevClose);
                }
            }
        } catch (e) {
            console.warn('VIX (yahoo) error:', e.message);
        }
    }

    console.warn('VIX: Yahoo proxy unavailable, no data');
    return null;
}

module.exports = {
    fetchBulkSnapshot,
    fetchGroupedDailyBars,
    fetchServerIndicators,
    fetchTickerDetails,
    fetchShortInterest,
    fetchVIX
};
