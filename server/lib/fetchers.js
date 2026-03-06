// Massive (Polygon.io) API wrappers for server-side Node.js usage.
// Adapted from browser fetch functions in src/trader.js — stripped of
// DOM callbacks, localStorage caching, and global state mutations.

const { isMarketOpen } = require('./scoring');

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

module.exports = { fetchBulkSnapshot, fetchGroupedDailyBars };
