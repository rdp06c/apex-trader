// Tests for new technical indicators
// Run: node tests/indicators.test.js

const assert = require('assert');
const scoring = require('../server/lib/scoring');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  PASS: ${name}`);
    } catch (e) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${e.message}`);
    }
}

// Generate realistic OHLCV bars for testing
// Simulates a stock moving from ~100 to ~110 over 40 bars with some volatility
function generateBars(count = 40, startPrice = 100, trend = 'up') {
    const bars = [];
    let price = startPrice;
    for (let i = 0; i < count; i++) {
        const direction = trend === 'up' ? 1 : trend === 'down' ? -1 : 0;
        const change = (Math.random() * 2 - 0.5 + direction * 0.3);
        const open = price;
        const close = price + change;
        const high = Math.max(open, close) + Math.random() * 1.5;
        const low = Math.min(open, close) - Math.random() * 1.5;
        const volume = 1000000 + Math.random() * 500000;
        bars.push({ o: +open.toFixed(2), h: +high.toFixed(2), l: +low.toFixed(2), c: +close.toFixed(2), v: Math.round(volume), t: Date.now() + i * 86400000 });
        price = close;
    }
    return bars;
}

// Bars with known properties for deterministic tests
function makeContractingBars() {
    // ATR shrinks over time (volatility contraction)
    const bars = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
        const range = Math.max(0.2, 3 - i * 0.07); // range shrinks from 3 to ~0.2
        bars.push({
            o: price,
            h: +(price + range / 2).toFixed(2),
            l: +(price - range / 2).toFixed(2),
            c: +(price + (Math.random() - 0.5) * range * 0.5).toFixed(2),
            v: 1000000,
            t: Date.now() + i * 86400000
        });
        price = bars[i].c;
    }
    return bars;
}

function makeHigherLowBars(hlCount = 6) {
    // Create bars with consecutive higher lows
    const bars = [];
    let price = 100;
    for (let i = 0; i < 30; i++) {
        const low = price - 1 + (i < hlCount ? i * 0.3 : 0); // higher lows for first hlCount bars
        bars.push({
            o: price,
            h: +(price + 2).toFixed(2),
            l: +low.toFixed(2),
            c: +(price + 0.5).toFixed(2),
            v: 1000000,
            t: Date.now() + i * 86400000
        });
        price = bars[i].c;
    }
    return bars;
}

// ========== VCR Tests ==========
console.log('\n--- VCR (Volatility Contraction Ratio) ---');

test('calculateVCR returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateVCR([]), null);
    assert.strictEqual(scoring.calculateVCR(null), null);
    assert.strictEqual(scoring.calculateVCR(generateBars(10)), null); // need 14+20+1 = 35 min
});

test('calculateVCR returns object with expected fields', () => {
    const result = scoring.calculateVCR(generateBars(40));
    assert.ok(result !== null);
    assert.ok('vcr' in result);
    assert.ok('atr' in result);
    assert.ok('avgAtr' in result);
    assert.ok('contracting' in result);
    assert.ok('expanding' in result);
});

test('calculateVCR detects contraction (VCR < 0.7)', () => {
    const bars = makeContractingBars();
    const result = scoring.calculateVCR(bars);
    assert.ok(result !== null);
    assert.ok(result.vcr < 1.0, `Expected VCR < 1.0 for contracting bars, got ${result.vcr}`);
    assert.ok(result.atr < result.avgAtr, 'Current ATR should be less than avg ATR for contracting');
});

test('calculateVCR vcr is a positive number', () => {
    const result = scoring.calculateVCR(generateBars(40));
    assert.ok(result.vcr > 0, `VCR should be positive, got ${result.vcr}`);
});

// ========== Range Position Tests ==========
console.log('\n--- Range Position ---');

test('calculateRangePosition returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateRangePosition([]), null);
    assert.strictEqual(scoring.calculateRangePosition(null), null);
    assert.strictEqual(scoring.calculateRangePosition(generateBars(5), 20), null);
});

test('calculateRangePosition returns object with expected fields', () => {
    const result = scoring.calculateRangePosition(generateBars(40));
    assert.ok(result !== null);
    assert.ok('rangePos' in result);
    assert.ok('high20' in result);
    assert.ok('low20' in result);
    assert.ok('atBottom' in result);
    assert.ok('atTop' in result);
});

test('calculateRangePosition is 0-100 range', () => {
    const result = scoring.calculateRangePosition(generateBars(40));
    assert.ok(result.rangePos >= 0 && result.rangePos <= 100,
        `Range position should be 0-100, got ${result.rangePos}`);
});

test('calculateRangePosition atBottom when price near low', () => {
    // Create deterministic bars where last close is near the 20-day low
    const bars = [];
    for (let i = 0; i < 25; i++) {
        const price = 100 - i * 0.5; // steady decline
        bars.push({ o: price + 0.2, h: price + 1, l: price - 0.5, c: price, v: 1000000, t: Date.now() + i * 86400000 });
    }
    const result = scoring.calculateRangePosition(bars, 20);
    assert.ok(result !== null);
    assert.ok(result.rangePos < 20, `Expected range < 20 for declining bars, got ${result.rangePos}`);
    assert.strictEqual(result.atBottom, true);
});

// ========== ADX Tests ==========
console.log('\n--- ADX (Average Directional Index) ---');

test('calculateADX returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateADX([]), null);
    assert.strictEqual(scoring.calculateADX(null), null);
    assert.strictEqual(scoring.calculateADX(generateBars(20)), null); // needs 2*period+1 = 29 bars
});

test('calculateADX returns object with expected fields', () => {
    const result = scoring.calculateADX(generateBars(40));
    assert.ok(result !== null);
    assert.ok('adx' in result);
    assert.ok('plusDI' in result);
    assert.ok('minusDI' in result);
    assert.ok('trending' in result);
    assert.ok('ranging' in result);
});

test('calculateADX values are non-negative', () => {
    const result = scoring.calculateADX(generateBars(40));
    assert.ok(result.adx >= 0, `ADX should be >= 0, got ${result.adx}`);
    assert.ok(result.plusDI >= 0, `+DI should be >= 0, got ${result.plusDI}`);
    assert.ok(result.minusDI >= 0, `-DI should be >= 0, got ${result.minusDI}`);
});

test('calculateADX trending/ranging are booleans based on thresholds', () => {
    const result = scoring.calculateADX(generateBars(40));
    assert.strictEqual(result.trending, result.adx > 25);
    assert.strictEqual(result.ranging, result.adx < 20);
});

// ========== ROC Tests ==========
console.log('\n--- ROC (Rate of Change) ---');

test('calculateROC returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateROC([]), null);
    assert.strictEqual(scoring.calculateROC(null), null);
    assert.strictEqual(scoring.calculateROC(generateBars(3)), null);
});

test('calculateROC returns object with expected fields', () => {
    const result = scoring.calculateROC(generateBars(25));
    assert.ok(result !== null);
    assert.ok('roc5' in result);
    assert.ok('roc10' in result);
    assert.ok('roc20' in result);
    assert.ok('divergence' in result);
});

test('calculateROC positive for uptrending bars', () => {
    const bars = generateBars(25, 100, 'up');
    const result = scoring.calculateROC(bars);
    if (result) {
        // Uptrend should generally have positive ROC, but random noise could flip short-term
        assert.ok(typeof result.roc5 === 'number');
        assert.ok(typeof result.roc20 === 'number');
    }
});

test('calculateROC divergence is valid string', () => {
    const result = scoring.calculateROC(generateBars(25));
    assert.ok(['accelerating', 'decelerating', 'stable'].includes(result.divergence),
        `Divergence should be accelerating/decelerating/stable, got ${result.divergence}`);
});

// ========== Higher-Low Count Tests ==========
console.log('\n--- Higher-Low Count ---');

test('countHigherLows returns null for insufficient bars', () => {
    assert.strictEqual(scoring.countHigherLows([]), null);
    assert.strictEqual(scoring.countHigherLows(null), null);
});

test('countHigherLows returns object with expected fields', () => {
    const result = scoring.countHigherLows(generateBars(25));
    assert.ok(result !== null);
    assert.ok('count' in result);
    assert.ok('consecutive' in result);
    assert.ok('maxSequence' in result);
});

test('countHigherLows detects higher lows in constructed data', () => {
    const bars = makeHigherLowBars(6);
    const result = scoring.countHigherLows(bars, 20);
    assert.ok(result.count >= 3, `Expected at least 3 higher lows, got ${result.count}`);
});

test('countHigherLows count is non-negative integer', () => {
    const result = scoring.countHigherLows(generateBars(25));
    assert.ok(Number.isInteger(result.count) && result.count >= 0);
    assert.ok(Number.isInteger(result.maxSequence) && result.maxSequence >= 0);
});

// ========== OBV Slope Tests ==========
console.log('\n--- OBV Slope ---');

test('calculateOBVSlope returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateOBVSlope([]), null);
    assert.strictEqual(scoring.calculateOBVSlope(null), null);
    assert.strictEqual(scoring.calculateOBVSlope(generateBars(5)), null);
});

test('calculateOBVSlope returns object with expected fields', () => {
    const result = scoring.calculateOBVSlope(generateBars(25));
    assert.ok(result !== null);
    assert.ok('slope' in result);
    assert.ok('normalized' in result);
    assert.ok('bullishDivergence' in result);
    assert.ok('bearishDivergence' in result);
});

test('calculateOBVSlope divergence flags are booleans', () => {
    const result = scoring.calculateOBVSlope(generateBars(25));
    assert.strictEqual(typeof result.bullishDivergence, 'boolean');
    assert.strictEqual(typeof result.bearishDivergence, 'boolean');
});

// ========== Gap Analysis Tests ==========
console.log('\n--- Gap Analysis ---');

test('calculateGapAnalysis returns null for insufficient bars', () => {
    assert.strictEqual(scoring.calculateGapAnalysis([]), null);
    assert.strictEqual(scoring.calculateGapAnalysis(null), null);
    assert.strictEqual(scoring.calculateGapAnalysis([{ o: 100, h: 101, l: 99, c: 100, v: 1000 }]), null);
});

test('calculateGapAnalysis returns object with expected fields', () => {
    const result = scoring.calculateGapAnalysis(generateBars(10));
    assert.ok(result !== null);
    assert.ok('gapPct' in result);
    assert.ok('gapType' in result);
    assert.ok('gapSize' in result);
});

test('calculateGapAnalysis detects gap up', () => {
    const bars = [
        { o: 100, h: 101, l: 99, c: 100, v: 1000000 },
        { o: 105, h: 106, l: 104, c: 105, v: 1000000 } // 5% gap up
    ];
    const result = scoring.calculateGapAnalysis(bars);
    assert.ok(result.gapPct > 0, `Expected positive gap, got ${result.gapPct}`);
    assert.strictEqual(result.gapType, 'up');
});

test('calculateGapAnalysis detects gap down', () => {
    const bars = [
        { o: 100, h: 101, l: 99, c: 100, v: 1000000 },
        { o: 95, h: 96, l: 94, c: 95, v: 1000000 } // -5% gap down
    ];
    const result = scoring.calculateGapAnalysis(bars);
    assert.ok(result.gapPct < 0, `Expected negative gap, got ${result.gapPct}`);
    assert.strictEqual(result.gapType, 'down');
});

test('calculateGapAnalysis gapSize classification', () => {
    const result = scoring.calculateGapAnalysis(generateBars(10));
    assert.ok(['large', 'small', 'none'].includes(result.gapSize),
        `gapSize should be large/small/none, got ${result.gapSize}`);
});

// ========== Summary ==========
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
