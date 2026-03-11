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

// === FULL SCAN SCORING FUNCTIONS ===

// Noise components zeroed: accel, consistency, FVG (uncorrelated per calibration).
// Pullback bonus removed: biggest score distorter; calibration captures via combo heat.
// SMA proximity and squeeze halved: real but oversized.
const DEFAULT_WEIGHTS = {
    momentumMultiplier: 0.3, rsMultiplier: 0.6, structureMultiplier: 1.25,
    accelBonus: 0, consistencyBonus: 0,
    sectorInflow: 2.0, sectorModestInflow: 1.0, sectorOutflow: -1.0,
    rsiOversold30: 2.5, rsiOversold40: 1.5, rsiOversold50: 0.5,
    rsiOverbought70: -3.0, rsiOverbought80: -5.0,
    macdBullish: 2.5, macdBearish: -2.0, macdNone: -0.5,
    rsMeanRev95: -3.0, rsMeanRev90: -2.0, rsMeanRev85: -1.0,
    squeezeBonusHigh: 0.75, squeezeBonusMod: 0.4,
    smaProxNear: 1.0, smaProxBelow: 0.5, smaProxFar15: -0.75, smaProxFar10: -0.25,
    smaCrossoverBullish: 2.0, smaCrossoverBearish: -2.0,
    fvgBullish: 0, fvgBearish: 0,
    entryMultExtreme: 0.3, entryMultExtended: 0.6
};

function getActiveWeights(calibratedWeights, vixLevel) {
    if (!calibratedWeights) return DEFAULT_WEIGHTS;
    if (vixLevel != null && calibratedWeights.regimeWeights) {
        return vixLevel < 20
            ? calibratedWeights.regimeWeights.lowVix || calibratedWeights.weights || DEFAULT_WEIGHTS
            : calibratedWeights.regimeWeights.highVix || calibratedWeights.weights || DEFAULT_WEIGHTS;
    }
    return calibratedWeights.weights || DEFAULT_WEIGHTS;
}

// Adapted: accepts bars directly instead of reading multiDayCache[symbol]
function calculate5DayMomentum(priceData, bars) {
    if (!bars || bars.length < 2) {
        if (!priceData || !priceData.price) return { score: 0, trend: 'unknown', basis: 'no-data' };
        const cp = priceData.changePercent || 0;
        let score = 5;
        if (cp > 5) score = 7; else if (cp > 2) score = 6.5; else if (cp > 0) score = 6;
        else if (cp > -2) score = 4; else if (cp > -5) score = 2; else score = 0;
        return { score, trend: score >= 6 ? 'building' : score <= 4 ? 'fading' : 'neutral', changePercent: cp, basis: '1-day-fallback' };
    }
    const recentBars = bars.slice(-5);
    const latest = recentBars[recentBars.length - 1], oldest = recentBars[0], mid = recentBars[Math.floor(recentBars.length / 2)];
    const totalReturn = ((latest.c - oldest.c) / oldest.c) * 100;
    const firstHalfReturn = ((mid.c - oldest.c) / oldest.c) * 100;
    const secondHalfReturn = ((latest.c - mid.c) / mid.c) * 100;
    const isAccelerating = secondHalfReturn > firstHalfReturn;
    let upDays = 0;
    for (let i = 1; i < recentBars.length; i++) { if (recentBars[i].c > recentBars[i-1].c) upDays++; }
    const upDayRatio = upDays / (recentBars.length - 1);
    const recentVol = recentBars.slice(-2).reduce((s, b) => s + b.v, 0) / 2;
    const earlyVol = recentBars.slice(0, 2).reduce((s, b) => s + b.v, 0) / 2;
    const volumeTrend = earlyVol > 0 ? recentVol / earlyVol : 1;
    let score = 5;
    if (totalReturn > 8) score += 3; else if (totalReturn > 4) score += 2; else if (totalReturn > 1) score += 1;
    else if (totalReturn < -8) score -= 3; else if (totalReturn < -4) score -= 2; else if (totalReturn < -1) score -= 1;
    if (upDayRatio >= 0.8) score += 1.5; else if (upDayRatio >= 0.6) score += 0.5;
    else if (upDayRatio <= 0.2) score -= 1.5; else if (upDayRatio <= 0.4) score -= 0.5;
    if (isAccelerating && totalReturn > 0) score += 0.5;
    else if (!isAccelerating && totalReturn < 0) score -= 0.5;
    score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
    let trend = 'neutral';
    if (score >= 7 && isAccelerating) trend = 'building';
    else if (score >= 6) trend = 'steady-up';
    else if (score <= 3 && !isAccelerating) trend = 'fading';
    else if (score <= 4) trend = 'steady-down';
    return { score: Math.round(score * 10) / 10, trend, totalReturn5d: Math.round(totalReturn * 100) / 100, todayChange: priceData?.changePercent || 0, upDays, totalDays: recentBars.length - 1, isAccelerating, volumeTrend: Math.round(volumeTrend * 100) / 100, basis: '5-day-real' };
}

// Adapted: accepts bars directly via multiDayCache param
function calculateVolumeRatio(bars) {
    if (!bars || bars.length < 6) return null;
    const todayBar = bars[bars.length - 1];
    const todayVol = todayBar.v;
    if (!todayVol || todayVol <= 0) return null;
    const histBars = bars.slice(-21, -1);
    if (histBars.length < 5) return null;
    const validBars = histBars.filter(b => b.v > 0);
    if (validBars.length < 5) return null;
    const avgVol = validBars.reduce((s, b) => s + b.v, 0) / validBars.length;
    // Time-normalize: during market hours, project today's partial volume to full-day
    let projectedVol = todayVol;
    if (isMarketOpen()) {
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const elapsedMin = (et.getHours() * 60 + et.getMinutes()) - 570; // 570 = 9:30 AM
        if (elapsedMin > 0) {
            projectedVol = todayVol * (390 / elapsedMin);
        }
    }
    return {
        ratio: Math.round((projectedVol / avgVol) * 100) / 100,
        todayVolume: todayVol,
        avgVolume: Math.round(avgVol)
    };
}

// Adapted: accepts bars directly via multiDayCache param
function calculateRelativeStrength(stockData, sectorStocks, stockBars, multiDayCache) {
    if (!stockData || !sectorStocks || sectorStocks.length === 0) return { rsScore: 50, strength: 'neutral' };
    let stockReturn = stockData.changePercent || 0, usedMultiDay = false;
    if (stockBars && stockBars.length >= 2) {
        const recent5 = stockBars.slice(-5);
        stockReturn = ((recent5[recent5.length - 1].c - recent5[0].c) / recent5[0].c) * 100;
        usedMultiDay = true;
    }
    let sectorTotal = 0, sectorCount = 0;
    sectorStocks.forEach(stock => {
        const sBars = multiDayCache[stock.symbol];
        if (sBars && sBars.length >= 2) {
            const sRecent5 = sBars.slice(-5);
            sectorTotal += ((sRecent5[sRecent5.length - 1].c - sRecent5[0].c) / sRecent5[0].c) * 100;
        } else {
            sectorTotal += (stock.changePercent || 0);
        }
        sectorCount++;
    });
    const sectorAvg = sectorCount > 0 ? sectorTotal / sectorCount : 0;
    const relativePerformance = stockReturn - sectorAvg;
    const multiplier = usedMultiDay ? 5 : 10;
    let rsScore = 50 + (relativePerformance * multiplier);
    rsScore = Math.max(0, Math.min(100, rsScore));
    const strength = rsScore >= 70 ? 'outperforming' : rsScore >= 55 ? 'above-average' : rsScore >= 45 ? 'neutral' : rsScore >= 30 ? 'below-average' : 'underperforming';
    return { rsScore: Math.round(rsScore), strength, stockReturn5d: Math.round(stockReturn * 100) / 100, sectorAvg5d: Math.round(sectorAvg * 100) / 100, relativePerformance: Math.round(relativePerformance * 100) / 100, basis: usedMultiDay ? '5-day' : '1-day-fallback' };
}

// Adapted: accepts stockSectors and multiDayCache as params
function detectSectorRotation(marketData, stockSectors, multiDayCache) {
    const sectors = {};
    Object.entries(marketData).forEach(([symbol, data]) => {
        const sector = stockSectors[symbol] || 'Unknown';
        if (!sectors[sector]) sectors[sector] = { stocks: [], totalReturn5d: 0, totalChangeToday: 0, leaders5d: 0, laggards5d: 0, leadersToday: 0, laggardsToday: 0 };
        const bars = multiDayCache[symbol];
        let return5d = data.changePercent || 0;
        if (bars && bars.length >= 2) {
            const recent5 = bars.slice(-5);
            return5d = ((recent5[recent5.length - 1].c - recent5[0].c) / recent5[0].c) * 100;
        }
        sectors[sector].stocks.push({ symbol, ...data, return5d });
        sectors[sector].totalReturn5d += return5d;
        sectors[sector].totalChangeToday += (data.changePercent || 0);
        if (return5d > 2) sectors[sector].leaders5d++;
        if (return5d < -2) sectors[sector].laggards5d++;
        if ((data.changePercent || 0) > 1) sectors[sector].leadersToday++;
        if ((data.changePercent || 0) < -1) sectors[sector].laggardsToday++;
    });
    const sectorAnalysis = {};
    Object.entries(sectors).forEach(([sector, data]) => {
        const count = data.stocks.length;
        const avgReturn5d = data.totalReturn5d / count;
        const avgChange = data.totalChangeToday / count;
        const leaderRatio5d = data.leaders5d / count;
        const laggardRatio5d = data.laggards5d / count;
        let flow = 'neutral', rotationSignal = 'hold';
        if (avgReturn5d > 2 && leaderRatio5d > 0.5) { flow = 'inflow'; rotationSignal = 'accumulate'; }
        else if (avgReturn5d > 1 && leaderRatio5d > 0.35) { flow = 'modest-inflow'; rotationSignal = 'favorable'; }
        else if (avgReturn5d < -2 && laggardRatio5d > 0.5) { flow = 'outflow'; rotationSignal = 'avoid'; }
        else if (avgReturn5d < -1 && laggardRatio5d > 0.35) { flow = 'modest-outflow'; rotationSignal = 'caution'; }
        sectorAnalysis[sector] = { avgChange: avgChange.toFixed(2), avgReturn5d: avgReturn5d.toFixed(2), leaders5d: data.leaders5d, laggards5d: data.laggards5d, leadersToday: data.leadersToday, laggardsToday: data.laggardsToday, total: count, leaderRatio5d: (leaderRatio5d * 100).toFixed(0) + '%', moneyFlow: flow, rotationSignal };
    });
    return sectorAnalysis;
}

function calculateCompositeScore({ momentumScore, rsNormalized, sectorFlow, structureScore, isAccelerating, upDays, totalDays, todayChange, totalReturn5d, rsi, macdCrossover, daysToCover, volumeTrend, fvg, sma20, currentPrice, smaCrossover, comboHeatBonus }, weights) {
    const w = weights || DEFAULT_WEIGHTS;

    const momentumContrib = momentumScore * w.momentumMultiplier;
    const rsContrib = rsNormalized * w.rsMultiplier;

    let sectorBonus = 0;
    if (sectorFlow === 'inflow') sectorBonus = w.sectorInflow;
    else if (sectorFlow === 'modest-inflow') sectorBonus = w.sectorModestInflow;
    else if (sectorFlow === 'outflow') sectorBonus = w.sectorOutflow;

    const accelBonus = isAccelerating && momentumScore >= 6 ? w.accelBonus : 0;
    const consistencyBonus = (upDays >= 3 && totalDays >= 4) ? w.consistencyBonus : 0;
    const structureBonus = (structureScore || 0) * w.structureMultiplier;

    const chg = todayChange || 0;
    const runnerPenalty = chg >= 15 ? -3 : chg >= 10 ? -2 : chg >= 7 ? -1 : chg >= 5 ? -0.5 : 0;
    const declinePenalty = 0;

    const extensionPenalty = (momentumScore >= 9 && rsNormalized >= 8.5) ? -5
        : (momentumScore >= 9 || rsNormalized >= 8.5) ? -3.5
        : (momentumScore >= 8 || rsNormalized >= 8) ? -2
        : (momentumScore >= 7.5 || rsNormalized >= 7.5) ? -1
        : 0;

    const ret5d = totalReturn5d ?? 0;
    // Pullback bonus removed: biggest score distorter; calibration captures via combo heat.
    const pullbackBonus = 0;

    const rsiBonusPenalty = rsi != null
        ? (rsi < 30 ? w.rsiOversold30 : rsi < 40 ? w.rsiOversold40 : rsi < 50 ? w.rsiOversold50
            : rsi > 80 ? w.rsiOverbought80 : rsi > 70 ? w.rsiOverbought70 : 0)
        : 0;
    const macdBonus = macdCrossover === 'bullish' ? w.macdBullish : macdCrossover === 'bearish' ? w.macdBearish : w.macdNone;

    const rsMeanRevPenalty = rsNormalized >= 9.5 ? w.rsMeanRev95 : rsNormalized >= 9 ? w.rsMeanRev90 : rsNormalized >= 8.5 ? w.rsMeanRev85 : 0;

    const dtc = daysToCover || 0;
    const squeezeBonus = (dtc > 5 && (structureScore ?? 0) >= 1 && sectorFlow !== 'outflow') ? w.squeezeBonusHigh
        : (dtc > 3 && (structureScore ?? 0) >= 1) ? w.squeezeBonusMod
        : 0;

    const vt = volumeTrend ?? 1;
    const volumeBonus = (momentumScore >= 7 && vt < 0.7) ? -2.0
        : (momentumScore >= 7 && vt > 1.3) ? 1.0
        : (momentumScore < 5 && vt > 1.5 && (structureScore ?? 0) >= 0) ? 1.5
        : (vt > 1.2 ? 0.5 : vt < 0.8 ? -0.5 : 0);

    const fvgBonus = (fvg === 'bullish' && ret5d < 0 && (structureScore ?? 0) >= 0) ? w.fvgBullish
        : (fvg === 'bearish' && (structureScore ?? 0) < 0) ? w.fvgBearish
        : 0;

    let smaProximityBonus = 0;
    if (sma20 != null && currentPrice != null && sma20 > 0) {
        const pctFromSMA20 = ((currentPrice - sma20) / sma20) * 100;
        if (pctFromSMA20 >= 0 && pctFromSMA20 <= 3 && (structureScore ?? 0) >= 1) smaProximityBonus = w.smaProxNear;
        else if (pctFromSMA20 < 0 && pctFromSMA20 >= -3 && (structureScore ?? 0) >= 1) smaProximityBonus = w.smaProxBelow;
        else if (pctFromSMA20 > 15) smaProximityBonus = w.smaProxFar15;
        else if (pctFromSMA20 > 10) smaProximityBonus = w.smaProxFar10;
    }

    const smaCrossoverBonus = smaCrossover?.crossover === 'bullish' ? w.smaCrossoverBullish
        : smaCrossover?.crossover === 'bearish' ? w.smaCrossoverBearish
        : 0;

    // No learned adjustments on server (requires portfolio.closedTrades analysis)
    const learnedAdj = 0;

    const heatBonus = comboHeatBonus ?? 0;

    const additiveScore = momentumContrib + rsContrib + sectorBonus + accelBonus + consistencyBonus
        + structureBonus + extensionPenalty + pullbackBonus + runnerPenalty + declinePenalty
        + rsiBonusPenalty + macdBonus + rsMeanRevPenalty + squeezeBonus + volumeBonus + fvgBonus
        + smaProximityBonus + smaCrossoverBonus + learnedAdj + heatBonus;

    let entryMultiplier = 1.0;
    if (additiveScore > 0) {
        if (rsi != null && rsi > 80 && momentumScore >= 9) entryMultiplier = w.entryMultExtreme;
        else if ((rsi != null && rsi > 70) || momentumScore >= 9 || rsNormalized >= 9) entryMultiplier = w.entryMultExtended;
    }

    const compositeScore = additiveScore * entryMultiplier;

    return {
        total: compositeScore,
        breakdown: {
            momentumContrib, rsContrib, sectorBonus, accelBonus, consistencyBonus,
            structureBonus, extensionPenalty, pullbackBonus, runnerPenalty, declinePenalty,
            rsiBonusPenalty, macdBonus, rsMeanRevPenalty, squeezeBonus, volumeBonus, fvgBonus,
            smaProximityBonus, smaCrossoverBonus, learnedAdj, heatBonus, entryMultiplier
        }
    };
}

// ATR (Average True Range) — measures typical daily price movement.
// Used to set volatility-aware stop losses (e.g., entry - 2×ATR).
function calculateATR(bars, period = 14) {
    if (!bars || bars.length < period + 1) return null;
    let trSum = 0;
    for (let i = 1; i <= period; i++) {
        const tr = Math.max(
            bars[i].h - bars[i].l,
            Math.abs(bars[i].h - bars[i - 1].c),
            Math.abs(bars[i].l - bars[i - 1].c)
        );
        trSum += tr;
    }
    let atr = trSum / period;
    // Smooth remaining bars with Wilder's method
    for (let i = period + 1; i < bars.length; i++) {
        const tr = Math.max(
            bars[i].h - bars[i].l,
            Math.abs(bars[i].h - bars[i - 1].c),
            Math.abs(bars[i].l - bars[i - 1].c)
        );
        atr = (atr * (period - 1) + tr) / period;
    }
    return Math.round(atr * 100) / 100;
}

// Volume divergence — detects price rising with declining volume.
// Returns { divergence: bool, direction, priceTrend, volumeTrend, days }
function detectVolumeDivergence(bars, lookback = 15) {
    if (!bars || bars.length < lookback + 1) return { divergence: false };
    const recent = bars.slice(-lookback);

    // Price trend: linear regression slope of closes
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = recent.length;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += recent[i].c;
        sumXY += i * recent[i].c;
        sumX2 += i * i;
    }
    const priceSlope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Volume trend: linear regression slope of volume
    sumY = 0; sumXY = 0;
    for (let i = 0; i < n; i++) {
        sumY += recent[i].v;
        sumXY += i * recent[i].v;
    }
    const volSlope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Normalize slopes for comparison
    const avgPrice = recent.reduce((s, b) => s + b.c, 0) / n;
    const avgVol = recent.reduce((s, b) => s + b.v, 0) / n;
    const priceTrendPct = avgPrice > 0 ? (priceSlope / avgPrice) * 100 : 0;
    const volTrendPct = avgVol > 0 ? (volSlope / avgVol) * 100 : 0;

    // Bearish divergence: price trending up, volume trending down
    const bearishDiv = priceTrendPct > 0.5 && volTrendPct < -2;
    // Bullish divergence: price trending down, volume trending up
    const bullishDiv = priceTrendPct < -0.5 && volTrendPct > 2;

    return {
        divergence: bearishDiv || bullishDiv,
        direction: bearishDiv ? 'bearish' : bullishDiv ? 'bullish' : 'none',
        priceTrend: Math.round(priceTrendPct * 100) / 100,
        volumeTrend: Math.round(volTrendPct * 100) / 100,
        days: lookback
    };
}

// Fibonacci extension targets from the most recent swing.
// Identifies the last completed swing (low→high or high→low→pullback)
// and projects 1.272 and 1.618 extension levels.
function calculateFibTargets(bars) {
    if (!bars || bars.length < 10) return null;

    // Find swing highs and lows (same logic as detectStructure)
    const swingHighs = [];
    const swingLows = [];
    for (let i = 1; i < bars.length - 1; i++) {
        if (bars[i].h > bars[i - 1].h && bars[i].h > bars[i + 1].h) {
            swingHighs.push({ index: i, price: bars[i].h });
        }
        if (bars[i].l < bars[i - 1].l && bars[i].l < bars[i + 1].l) {
            swingLows.push({ index: i, price: bars[i].l });
        }
    }

    if (swingHighs.length < 1 || swingLows.length < 1) return null;

    const currentPrice = bars[bars.length - 1].c;
    const lastSH = swingHighs[swingHighs.length - 1];
    const lastSL = swingLows[swingLows.length - 1];

    // Bullish setup: swing low → swing high → pullback (current price < swing high)
    // Project upside targets from the pullback
    if (lastSL.index < lastSH.index) {
        const swingRange = lastSH.price - lastSL.price;
        // Use current price as the pullback level (or last swing low if it's after the high)
        const pullback = currentPrice < lastSH.price ? currentPrice : lastSL.price;
        return {
            type: 'bullish',
            swingLow: Math.round(lastSL.price * 100) / 100,
            swingHigh: Math.round(lastSH.price * 100) / 100,
            pullback: Math.round(pullback * 100) / 100,
            fib100: Math.round((pullback + swingRange) * 100) / 100,
            fib1272: Math.round((pullback + swingRange * 1.272) * 100) / 100,
            fib1618: Math.round((pullback + swingRange * 1.618) * 100) / 100
        };
    }

    // Bearish setup: swing high → swing low (downtrend)
    // Project downside targets
    if (lastSH.index < lastSL.index) {
        const swingRange = lastSH.price - lastSL.price;
        const bounce = currentPrice > lastSL.price ? currentPrice : lastSH.price;
        return {
            type: 'bearish',
            swingHigh: Math.round(lastSH.price * 100) / 100,
            swingLow: Math.round(lastSL.price * 100) / 100,
            bounce: Math.round(bounce * 100) / 100,
            fib100: Math.round((bounce - swingRange) * 100) / 100,
            fib1272: Math.round((bounce - swingRange * 1.272) * 100) / 100,
            fib1618: Math.round((bounce - swingRange * 1.618) * 100) / 100
        };
    }

    return null;
}

function detectMarketRegime(vix, sectorAnalysis, mktData, multiDayCache) {
    const signals = {};
    let score = 0;

    if (vix != null) {
        if (vix <= 20) { score += 1; signals.vix = 'bull'; }
        else if (vix > 30) { score -= 1; signals.vix = 'bear'; }
        else { signals.vix = 'neutral'; }
    }

    if (sectorAnalysis && typeof sectorAnalysis === 'object') {
        const sectors = Object.values(sectorAnalysis);
        const inflowCount = sectors.filter(s => s.moneyFlow === 'inflow' || s.moneyFlow === 'modest-inflow').length;
        const outflowCount = sectors.filter(s => s.moneyFlow === 'outflow' || s.moneyFlow === 'modest-outflow').length;
        if (inflowCount >= 8) { score += 1; signals.sectorBreadth = 'bull'; }
        else if (inflowCount < 4 && outflowCount >= 6) { score -= 1; signals.sectorBreadth = 'bear'; }
        else { signals.sectorBreadth = 'neutral'; }
        signals.sectorDetail = `${inflowCount} inflow, ${outflowCount} outflow`;
    }

    if (mktData && typeof mktData === 'object') {
        const stocks = Object.values(mktData);
        const total = stocks.length;
        if (total > 0) {
            const advancers = stocks.filter(s => (s.changePercent || 0) > 0).length;
            const pct = advancers / total;
            if (pct >= 0.6) { score += 1; signals.breadth = 'bull'; }
            else if (pct < 0.4) { score -= 1; signals.breadth = 'bear'; }
            else { signals.breadth = 'neutral'; }
            signals.breadthDetail = `${advancers}/${total} advancing (${(pct * 100).toFixed(0)}%)`;
        }
    }

    if (multiDayCache) {
        const spyBars = multiDayCache['SPY'];
        if (spyBars && spyBars.length >= 5) {
            const recent5 = spyBars.slice(-5);
            const spy5dReturn = ((recent5[recent5.length - 1].c - recent5[0].c) / recent5[0].c) * 100;
            if (spy5dReturn > 1) { score += 1; signals.spy5d = 'bull'; }
            else if (spy5dReturn < -1) { score -= 1; signals.spy5d = 'bear'; }
            else { signals.spy5d = 'neutral'; }
            signals.spy5dDetail = `${spy5dReturn >= 0 ? '+' : ''}${spy5dReturn.toFixed(2)}%`;
        }
    }

    const regime = score >= 2 ? 'bull' : score <= -2 ? 'bear' : 'choppy';
    return { regime, score, signals };
}

const ENTRY_SIGNAL_PATTERNS = [
    {
        id: 'reversal',
        label: 'Reversal Entry',
        badge: 'REV',
        criteria: [
            { id: 'macd', label: 'MACD Bull', test: c => c.macdCrossover === 'bullish' },
            { id: 'rsi', label: 'RSI<40', test: c => c.rsi != null && c.rsi < 40 },
            { id: 'structure', label: 'Bull Structure', test: c => c.structure === 'bullish' || c.structure === 'bullish_continuation' },
            { id: 'pullback', label: 'Pullback', test: c => c.return5d != null && c.return5d >= -8 && c.return5d <= -2 }
        ],
        minMatch: 2,
        requireAny: ['macd', 'structure']
    },
    {
        id: 'momentum_cont',
        label: 'Momentum Continuation',
        badge: 'MOM',
        calibrationKey: 'momentum_trend_confirm',
        criteria: [
            { id: 'momentum', label: 'Mom 5-8', test: c => (c.momentum ?? c.momentumScore ?? 0) >= 5 && (c.momentum ?? c.momentumScore ?? 0) <= 8 },
            { id: 'rsi', label: 'RSI<50', test: c => c.rsi != null && c.rsi < 50 },
            { id: 'structure', label: 'Bull Structure', test: c => c.structure === 'bullish' || c.structure === 'bullish_continuation' },
            { id: 'rs', label: 'RS>50', test: c => (c.rs ?? 0) > 50 }
        ],
        minMatch: 3,
        requireAny: ['structure', 'momentum']
    },
    {
        id: 'quiet_momentum',
        label: 'Quiet Momentum',
        badge: 'QMO',
        calibrationKey: 'vol_ratio_low_mom',
        criteria: [
            { id: 'vol_low', label: 'Vol<0.5x', test: c => c.volumeRatio != null && c.volumeRatio < 0.5 },
            { id: 'momentum', label: 'Mom 7+', test: c => (c.momentum ?? c.momentumScore ?? 0) >= 7 },
            { id: 'structure', label: 'Bull Structure', test: c => c.structure === 'bullish' || c.structure === 'bullish_continuation' },
            { id: 'not_overbought', label: 'RSI<70', test: c => c.rsi == null || c.rsi < 70 }
        ],
        minMatch: 3,
        requireAny: ['vol_low', 'momentum']
    },
    {
        id: 'squeeze',
        label: 'Squeeze Setup',
        badge: 'SQZ',
        calibrationKey: 'vol_ratio_high_struct',
        criteria: [
            { id: 'dtc', label: 'DTC>5', test: c => (c.daysToCover ?? c.dtc ?? 0) > 5 },
            { id: 'structure', label: 'Bull Structure', test: c => c.structure === 'bullish' || c.structure === 'bullish_continuation' },
            { id: 'sector', label: 'Sector Inflow', test: c => { const f = c.sectorFlow || c.sectorRotation || ''; return f === 'inflow' || f === 'accumulate' || f === 'favorable' || f === 'modest-inflow'; } }
        ],
        minMatch: 2,
        requireAny: ['dtc', 'structure']
    },
    {
        id: 'sector_leader',
        label: 'Sector Leader',
        badge: 'LDR',
        calibrationKey: 'sector_leader_mom',
        criteria: [
            { id: 'rs', label: 'RS>60', test: c => (c.rs ?? 0) > 60 },
            { id: 'sector', label: 'Sector Inflow', test: c => { const f = c.sectorFlow || c.sectorRotation || ''; return f === 'inflow' || f === 'accumulate' || f === 'favorable' || f === 'modest-inflow'; } },
            { id: 'structure', label: 'Bull Structure', test: c => c.structure === 'bullish' || c.structure === 'bullish_continuation' }
        ],
        minMatch: 2,
        requireAny: ['rs', 'sector']
    },
    {
        id: 'exhausted',
        label: 'Exhausted Runner',
        badge: 'AVOID',
        antiPattern: true,
        criteria: [
            { id: 'rsi_high', label: 'RSI>70', test: c => c.rsi != null && c.rsi > 70 },
            { id: 'runner', label: 'Day +5%', test: c => (c.dayChange ?? c.todayChange ?? 0) >= 5 },
            { id: 'mom_high', label: 'Mom 9+', test: c => (c.momentum ?? c.momentumScore ?? 0) >= 9 },
            { id: 'vol_decline', label: 'Vol Declining', test: c => (c.volumeTrend ?? c.volumeRatio ?? 1) < 0.85 }
        ],
        minMatch: 2,
        requireAny: ['rsi_high', 'runner', 'mom_high']
    }
];

function evaluateEntrySignals(candidate) {
    const results = [];
    let bestMatch = null;
    let bestMatchCount = 0;
    let bestPatternId = null;
    let antiPatternMatch = null;

    for (const pattern of ENTRY_SIGNAL_PATTERNS) {
        const criteriaResults = {};
        let matchCount = 0;
        for (const crit of pattern.criteria) {
            const passed = crit.test(candidate);
            criteriaResults[crit.id] = passed;
            if (passed) matchCount++;
        }

        const total = pattern.criteria.length;
        let match = null;
        if (matchCount === total) {
            match = 'full';
        } else if (matchCount >= total - 1) {
            match = 'strong';
        } else if (matchCount >= pattern.minMatch) {
            const hasRequired = pattern.requireAny.some(id => criteriaResults[id]);
            if (hasRequired) match = 'partial';
        }

        const result = { id: pattern.id, label: pattern.label, badge: pattern.badge, match, matchCount, totalCriteria: total, criteria: criteriaResults, calibrationKey: pattern.calibrationKey, antiPattern: pattern.antiPattern };
        results.push(result);

        if (pattern.antiPattern && match) {
            antiPatternMatch = result;
        } else if (match && matchCount > bestMatchCount) {
            bestMatchCount = matchCount;
            bestMatch = match;
            bestPatternId = pattern.id;
        }
    }

    return { patterns: results, bestMatch, bestMatchCount, bestPatternId, antiPatternMatch };
}

// Compute a score bonus for stocks matching calibrated entry signal patterns.
// Full (GREEN) match gets the full bonus, strong (YELLOW) gets 60%.
// Bonus scales with the pattern's calibration edge (vsBaselineReturn).
function computeSignalBonus(entrySignal, calibratedWeights) {
    if (!entrySignal || !entrySignal.bestMatch) return 0;

    const combos = calibratedWeights?.signalCombos?.combos;
    let bestBonus = 0;

    for (const pat of entrySignal.patterns) {
        if (!pat.match || pat.antiPattern) continue;

        let edge = null;
        const key = pat.calibrationKey || (pat.id === 'reversal' ? 'rsi_low_structure_bull' : null);
        if (key && combos) {
            const cal = combos[key];
            if (cal && !cal.insufficient && (cal.n ?? 0) >= 100) {
                edge = cal.vsBaselineReturn;
            }
        }

        if (edge == null || edge <= 0) continue;

        const rawBonus = Math.min(edge * 1.5, 10.0);
        const matchMult = pat.match === 'full' ? 1.0 : pat.match === 'strong' ? 0.35 : 0;
        const bonus = rawBonus * matchMult;

        if (bonus > bestBonus) bestBonus = bonus;
    }

    return Math.round(bestBonus * 10) / 10;
}

// Compute a score bonus from combo heat analysis — integrates calibration
// data directly into the composite score. Hot combos boost, cold combos penalize.
function computeComboHeatBonus(comboHeatResult) {
    if (!comboHeatResult) return 0;
    let bonus = 0;
    for (const combo of (comboHeatResult.hotCombos || [])) {
        bonus += Math.min(combo.vsBaseline * 0.5, 2.0);
    }
    for (const combo of (comboHeatResult.coldCombos || [])) {
        bonus += Math.max(combo.vsBaseline * 0.5, -2.0);
    }
    return Math.max(-6.0, Math.min(6.0, Math.round(bonus * 10) / 10));
}

module.exports = {
    isMarketOpen,
    calculateRSI,
    calculateSMA,
    calculateEMAArray,
    calculateMACD,
    calculateSMACrossover,
    detectStructure,
    DEFAULT_WEIGHTS,
    getActiveWeights,
    calculate5DayMomentum,
    calculateVolumeRatio,
    calculateRelativeStrength,
    detectSectorRotation,
    calculateCompositeScore,
    calculateATR,
    detectVolumeDivergence,
    calculateFibTargets,
    detectMarketRegime,
    evaluateEntrySignals,
    computeSignalBonus,
    computeComboHeatBonus
};
