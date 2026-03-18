// Tests for buy zone crash-through fix and trade plan support/fib fallbacks
// Run: node tests/buy-zone-gaps.test.js

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

// Helper: generate deterministic bars with controlled price action
function makeBars(prices) {
    return prices.map((p, i) => ({
        o: +(p - 0.5).toFixed(2),
        h: +(p + 1.5).toFixed(2),
        l: +(p - 1.5).toFixed(2),
        c: +p.toFixed(2),
        v: 1000000,
        t: Date.now() + i * 86400000
    }));
}

// Scenario: stock that traded around $65, then crashed to $56
// SMA20 ≈ $65, current price $56, gap ≈ 16%
function makeCrashBars() {
    const prices = [];
    // 20 bars around $65 with mild oscillation
    for (let i = 0; i < 20; i++) {
        prices.push(65 + Math.sin(i * 0.5) * 2);
    }
    // 10 bars crashing from $65 to $56
    for (let i = 0; i < 10; i++) {
        prices.push(65 - i * 1);
    }
    return makeBars(prices);
}

// Scenario: stock slightly below SMA20 (2-3% gap)
function makeShallowPullbackBars() {
    const prices = [];
    // 25 bars around $100
    for (let i = 0; i < 25; i++) {
        prices.push(100 + Math.sin(i * 0.3) * 2);
    }
    // 5 bars pulling back to $97
    for (let i = 0; i < 5; i++) {
        prices.push(100 - i * 0.7);
    }
    return makeBars(prices);
}

// Scenario: stock at new all-time lows — no structural support below
function makeNewLowBars() {
    const prices = [];
    // Steady decline from $80 to $50 over 30 bars
    for (let i = 0; i < 30; i++) {
        prices.push(80 - i);
    }
    return makeBars(prices);
}

// ========== computeBuyZone: crash-through tests ==========
console.log('\n--- Buy Zone: Crash-Through Handling ---');

test('crash-through: zone price should be ATR-based, not SMA20', () => {
    const bars = makeCrashBars();
    const price = bars[bars.length - 1].c; // ~$56
    const sma20 = scoring.calculateSMA(bars, 20);
    assert.ok(sma20 > price * 1.05, `SMA20 ${sma20.toFixed(2)} should be >5% above price ${price}`);

    const result = scoring.computeBuyZone({ price, support: null, sma20, bars, vixLevel: 20 });
    assert.ok(result !== null, 'Should return a buy zone');
    assert.ok(result.inZone === true, 'Stock should be in zone (deep crash)');
    // Key assertion: zone price should be BELOW current price, not at SMA20
    assert.ok(result.buyZonePrice < price,
        `Zone price $${result.buyZonePrice} should be below current price $${price}, not at SMA20 $${sma20.toFixed(2)}`);
    assert.strictEqual(result.zoneSource, 'atr', 'Zone source should be ATR for crash-through');
});

test('shallow pullback: should still use highest reference (SMA20/pullback)', () => {
    const bars = makeShallowPullbackBars();
    const price = bars[bars.length - 1].c; // ~$97
    const sma20 = scoring.calculateSMA(bars, 20);

    const result = scoring.computeBuyZone({ price, support: null, sma20, bars, vixLevel: 15 });
    assert.ok(result !== null, 'Should return a buy zone');
    // For shallow pullback where refs are above price but not by >5%,
    // existing behavior applies
    assert.ok(result.zoneSource !== 'atr',
        `Shallow pullback should NOT use ATR zone, got source: ${result.zoneSource}`);
});

test('all refs null: should return null', () => {
    const result = scoring.computeBuyZone({ price: 50, support: null, sma20: null, bars: null, vixLevel: 20 });
    assert.strictEqual(result, null, 'Should return null when no references exist');
});

test('crash-through with VIX: ATR zone should be reasonable', () => {
    const bars = makeCrashBars();
    const price = bars[bars.length - 1].c;
    const sma20 = scoring.calculateSMA(bars, 20);
    const atr = scoring.calculateATR(bars);

    const result = scoring.computeBuyZone({ price, support: null, sma20, bars, vixLevel: 25 });
    assert.ok(result !== null);
    assert.ok(result.buyZonePrice > 0, 'Zone price must be positive');
    // Zone should be approximately 0.5 ATR below price
    const expected = price - atr * 0.5;
    assert.ok(Math.abs(result.buyZonePrice - expected) < 0.1,
        `Zone price $${result.buyZonePrice} should be ~$${expected.toFixed(2)} (price - 0.5*ATR)`);
});

// ========== generateTradePlan: support fallback tests ==========
console.log('\n--- Trade Plan: Support Fallback ---');

test('new lows: support should NOT be null (ATR fallback)', () => {
    const bars = makeNewLowBars();
    const price = bars[bars.length - 1].c;
    const structure = scoring.detectStructure(bars);

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 20 });
    assert.ok(plan !== null, 'Should produce a trade plan');
    assert.ok(plan.support !== null,
        `Support should not be null for stocks at new lows (price: $${price})`);
    assert.ok(plan.support < price,
        `Fallback support $${plan.support} should be below price $${price}`);
});

test('normal case: support should come from structure', () => {
    const bars = makeBars([
        // Up, pull back, up higher — creates swing low below price
        50, 52, 54, 56, 58, 60, 58, 56, 54, 52, 50, 48, 46,
        48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72,
        74, 76, 78, 80
    ]);
    const price = bars[bars.length - 1].c; // $80
    const structure = scoring.detectStructure(bars);

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 15 });
    assert.ok(plan !== null);
    assert.ok(plan.support !== null, 'Support should exist from structure');
    assert.ok(plan.support < price, 'Support should be below price');
});

// ========== generateTradePlan: fib fallback tests ==========
console.log('\n--- Trade Plan: Fib Fallback for Bearish Structure ---');

test('bearish structure: fib targets should NOT be null (retracement fallback)', () => {
    // Create bearish structure: high then decline
    const bars = makeBars([
        50, 52, 55, 58, 62, 66, 70, 74, 78, 80,  // up to $80
        78, 75, 72, 69, 66, 63, 60, 57, 54, 51,   // down to $51
        50, 49, 48, 47, 46, 45, 44, 43, 42, 41     // continued decline
    ]);
    const price = bars[bars.length - 1].c; // ~$41
    const structure = scoring.detectStructure(bars);
    const fibs = scoring.calculateFibTargets(bars);

    // Verify bearish structure first
    assert.ok(fibs !== null, 'Should have fib data');
    assert.strictEqual(fibs.type, 'bearish', 'Structure should be bearish');

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 25 });
    assert.ok(plan !== null, 'Should produce a trade plan');
    // Key assertion: fib targets should be populated with retracement levels
    assert.ok(plan.fib1272 !== null,
        'Fib target 1 should not be null for bearish structure (retracement expected)');
    assert.ok(plan.fib1272 > price,
        `Fib target 1 ($${plan.fib1272}) should be above current price ($${price})`);
});

test('bearish fib: should indicate retracement type', () => {
    const bars = makeBars([
        50, 55, 60, 65, 70, 75, 80, 75, 70, 65,
        60, 55, 50, 48, 46, 44, 42, 40, 38, 36,
        35, 34, 33, 32, 31, 30, 29, 28, 27, 26
    ]);
    const price = bars[bars.length - 1].c;
    const structure = scoring.detectStructure(bars);

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 20 });
    assert.ok(plan !== null);
    assert.strictEqual(plan.fibType, 'retracement',
        'Bearish fib should indicate retracement type');
});

test('bullish structure: fib type should be extension', () => {
    const bars = makeBars([
        40, 42, 44, 46, 48, 50, 48, 46, 44, 42,
        44, 46, 48, 50, 52, 54, 56, 58, 60, 62,
        64, 66, 68, 70, 72, 74, 76, 78, 80, 82
    ]);
    const price = bars[bars.length - 1].c;
    const structure = scoring.detectStructure(bars);

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 15 });
    assert.ok(plan !== null);
    if (plan.fib1272 !== null) {
        assert.strictEqual(plan.fibType, 'extension',
            'Bullish fib should indicate extension type');
    }
});

// ========== Integration: crash-through + support fallback together ==========
console.log('\n--- Integration: Full REV Workflow ---');

test('REV stock: trade plan + buy zone should both produce usable values', () => {
    // REV scenario: stock crashed from $80 to $41
    const bars = makeBars([
        65, 67, 70, 73, 76, 78, 80, 78, 75, 72,
        69, 66, 63, 60, 57, 54, 51, 48, 45, 42,
        41, 40.5, 41, 40, 41.5, 41, 40.5, 41, 40.5, 41
    ]);
    const price = bars[bars.length - 1].c;
    const structure = scoring.detectStructure(bars);

    const plan = scoring.generateTradePlan({ price, bars, structure, vixLevel: 30 });
    assert.ok(plan !== null, 'Trade plan should exist');
    assert.ok(plan.support !== null, 'Support should not be null');
    assert.ok(plan.stop < price, 'Stop should be below price');
    assert.ok(plan.target > price, 'Target should be above price');

    const sma20 = scoring.calculateSMA(bars, 20);
    const bz = scoring.computeBuyZone({ price, support: plan.support, sma20, bars, vixLevel: 30 });
    assert.ok(bz !== null, 'Buy zone should exist');
    assert.ok(bz.buyZonePrice <= price,
        `Buy zone price $${bz.buyZonePrice} should be at or below current price $${price}`);
    assert.ok(bz.buyZonePrice > 0, 'Buy zone price must be positive');
});

// ========== Summary ==========
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
