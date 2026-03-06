// Extracted scoring/analysis functions for server-side use.
// These are copies of the pure-algorithm functions from src/trader.js,
// adapted to accept data as parameters instead of reading globals.

function isMarketOpen() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const hours = et.getHours();
    const minutes = et.getMinutes();
    const timeMinutes = hours * 60 + minutes;
    return timeMinutes >= 570 && timeMinutes < 960;
}

function calculateRSI(bars, period = 14) {
    if (!bars || bars.length < period + 1) return null;
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
        const change = bars[i].c - bars[i - 1].c;
        if (change > 0) gainSum += change;
        else lossSum += Math.abs(change);
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    for (let i = period + 1; i < bars.length; i++) {
        const change = bars[i].c - bars[i - 1].c;
        avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function calculateSMA(bars, period = 20) {
    if (!bars || bars.length < period) return null;
    const slice = bars.slice(-period);
    return Math.round(slice.reduce((sum, b) => sum + b.c, 0) / period * 100) / 100;
}

function calculateEMAArray(closes, period) {
    if (closes.length < period) return [];
    const multiplier = 2 / (period + 1);
    const emaValues = [];
    let ema = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
    emaValues.push(ema);
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
        emaValues.push(ema);
    }
    return emaValues;
}

function calculateMACD(bars) {
    if (!bars || bars.length < 35) return null;
    const closes = bars.map(b => b.c);
    const ema12 = calculateEMAArray(closes, 12);
    const ema26 = calculateEMAArray(closes, 26);
    const offset = 26 - 12;
    const macdLine = [];
    for (let i = 0; i < ema26.length; i++) {
        macdLine.push(ema12[i + offset] - ema26[i]);
    }
    const signalLine = calculateEMAArray(macdLine, 9);
    if (signalLine.length < 2) return null;
    const currentMACD = macdLine[macdLine.length - 1];
    const currentSignal = signalLine[signalLine.length - 1];
    const prevMACD = macdLine[macdLine.length - 2];
    const prevSignal = signalLine.length >= 2 ? signalLine[signalLine.length - 2] : currentSignal;
    const histogram = currentMACD - currentSignal;
    let crossover = 'none';
    if (prevMACD <= prevSignal && currentMACD > currentSignal) crossover = 'bullish';
    else if (prevMACD >= prevSignal && currentMACD < currentSignal) crossover = 'bearish';
    return {
        macd: Math.round(currentMACD * 1000) / 1000,
        signal: Math.round(currentSignal * 1000) / 1000,
        histogram: Math.round(histogram * 1000) / 1000,
        crossover
    };
}

function calculateSMACrossover(bars) {
    if (!bars || bars.length < 52) return null;
    const sma20Now = calculateSMA(bars, 20);
    const sma50Now = calculateSMA(bars, 50);
    if (sma20Now == null || sma50Now == null) return null;
    const prevBars = bars.slice(0, -1);
    const sma20Prev = calculateSMA(prevBars, 20);
    const sma50Prev = calculateSMA(prevBars, 50);
    if (sma20Prev == null || sma50Prev == null) return null;
    let crossover = 'none';
    if (sma20Prev <= sma50Prev && sma20Now > sma50Now) crossover = 'bullish';
    else if (sma20Prev >= sma50Prev && sma20Now < sma50Now) crossover = 'bearish';
    const spread = sma50Now !== 0 ? ((sma20Now - sma50Now) / sma50Now * 100) : 0;
    return { sma50: sma50Now, crossover, spread: Math.round(spread * 100) / 100 };
}

// Adapted: accepts bars directly instead of reading multiDayCache[symbol]
function detectStructure(bars) {
    if (!bars || bars.length < 7) {
        return { structure: 'unknown', structureSignal: 'neutral', structureScore: 0, choch: false, chochType: 'none', bos: false, bosType: 'none', sweep: 'none', fvg: 'none', swingHighs: 0, swingLows: 0, lastSwingHigh: null, lastSwingLow: null, currentPrice: null, basis: 'insufficient-data' };
    }

    const swingHighs = [];
    const swingLows = [];

    for (let i = 1; i < bars.length - 1; i++) {
        if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h) {
            swingHighs.push({ index: i, price: bars[i].h, time: bars[i].t });
        }
        if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l) {
            swingLows.push({ index: i, price: bars[i].l, time: bars[i].t });
        }
    }

    if (swingHighs.length < 2 || swingLows.length < 2) {
        return { structure: 'unknown', structureSignal: 'neutral', structureScore: 0, choch: false, chochType: 'none', bos: false, bosType: 'none', sweep: 'none', fvg: 'none', swingHighs: swingHighs.length, swingLows: swingLows.length, lastSwingHigh: null, lastSwingLow: null, currentPrice: null, basis: 'insufficient-swings' };
    }

    const lastSH = swingHighs[swingHighs.length - 1];
    const prevSH = swingHighs[swingHighs.length - 2];
    const lastSL = swingLows[swingLows.length - 1];
    const prevSL = swingLows[swingLows.length - 2];

    const higherHigh = lastSH.price > prevSH.price;
    const higherLow = lastSL.price > prevSL.price;
    const lowerHigh = lastSH.price < prevSH.price;
    const lowerLow = lastSL.price < prevSL.price;

    let structure = 'ranging';
    if (higherHigh && higherLow) structure = 'bullish';
    else if (lowerHigh && lowerLow) structure = 'bearish';
    else if (higherHigh && lowerLow) structure = 'ranging';
    else if (lowerHigh && higherLow) structure = 'contracting';

    let choch = false;
    let chochType = null;

    if (swingHighs.length >= 3 && swingLows.length >= 3) {
        const prevPrevSH = swingHighs[swingHighs.length - 3];
        const prevPrevSL = swingLows[swingLows.length - 3];
        const wasBullish = prevSH.price > prevPrevSH.price && prevSL.price > prevPrevSL.price;
        const wasBearish = prevSH.price < prevPrevSH.price && prevSL.price < prevPrevSL.price;

        if (wasBullish && lowerLow) {
            choch = true;
            chochType = 'bearish';
        } else if (wasBearish && higherHigh) {
            choch = true;
            chochType = 'bullish';
        }
    }

    let bos = false;
    let bosType = null;
    const currentPrice = bars[bars.length - 1].c;

    if (structure === 'bullish' && currentPrice > prevSH.price) {
        bos = true;
        bosType = 'bullish';
    } else if (structure === 'bearish' && currentPrice < prevSL.price) {
        bos = true;
        bosType = 'bearish';
    }

    let sweepDetected = false;
    let sweepType = null;
    const latestBar = bars[bars.length - 1];

    if (latestBar.h > lastSH.price && latestBar.c < lastSH.price) {
        sweepDetected = true;
        sweepType = 'high-swept';
    }
    if (latestBar.l < lastSL.price && latestBar.c > lastSL.price) {
        sweepDetected = true;
        sweepType = 'low-swept';
    }

    let fvg = null;
    const fvgs = [];
    for (let i = Math.max(1, bars.length - 4); i < bars.length - 1; i++) {
        if (bars[i-1].h < bars[i+1].l) {
            fvgs.push({ type: 'bullish', gapTop: bars[i+1].l, gapBottom: bars[i-1].h, barIndex: i });
        }
        if (bars[i-1].l > bars[i+1].h) {
            fvgs.push({ type: 'bearish', gapTop: bars[i-1].l, gapBottom: bars[i+1].h, barIndex: i });
        }
    }
    if (fvgs.length > 0) fvg = fvgs[fvgs.length - 1];

    let structureSignal = 'neutral';
    let structureScore = 0;

    if (bos && bosType === 'bullish') { structureSignal = 'strong-bullish'; structureScore = 3; }
    else if (bos && bosType === 'bearish') { structureSignal = 'strong-bearish'; structureScore = -3; }
    else if (choch && chochType === 'bullish') { structureSignal = 'reversal-bullish'; structureScore = 2; }
    else if (choch && chochType === 'bearish') { structureSignal = 'reversal-bearish'; structureScore = -2; }
    else if (structure === 'bullish') { structureSignal = 'bullish'; structureScore = 1; }
    else if (structure === 'bearish') { structureSignal = 'bearish'; structureScore = -1; }

    if (sweepDetected && sweepType === 'low-swept') structureScore += 1;
    if (sweepDetected && sweepType === 'high-swept') structureScore -= 1;

    return {
        structure,
        structureSignal,
        structureScore: Math.max(-3, Math.min(3, structureScore)),
        choch,
        chochType: chochType || 'none',
        bos,
        bosType: bosType || 'none',
        sweep: sweepDetected ? sweepType : 'none',
        fvg: fvg ? fvg.type : 'none',
        swingHighs: swingHighs.length,
        swingLows: swingLows.length,
        lastSwingHigh: lastSH.price,
        lastSwingLow: lastSL.price,
        currentPrice,
        basis: '40-day-structure'
    };
}

module.exports = {
    isMarketOpen,
    calculateRSI,
    calculateSMA,
    calculateEMAArray,
    calculateMACD,
    calculateSMACrossover,
    detectStructure
};
