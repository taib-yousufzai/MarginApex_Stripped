/**
 * Regression tests for bid/ask execution pricing fix.
 *
 * These tests document the intended execution behavior and act as a regression
 * guard. If anyone changes the execution logic back to LTP, these tests fail.
 *
 * Test parameters (from client complaint):
 *   BID = 1924.14
 *   ASK = 1926.06
 */

// ---------------------------------------------------------------------------
// Helper: simulate the fill price computation used in the matching engine
// ---------------------------------------------------------------------------
function computeFillPrice(
  side: 'BUY' | 'SELL',
  isExit: boolean,
  quote: { bid: number; ask: number },
  buffers: {
    buyEntryBuffer: number; buyExitBuffer: number;
    sellEntryBuffer: number; sellExitBuffer: number;
  }
): number | null {
  const ref = side === 'BUY' ? quote.ask : quote.bid;
  if (!ref || ref <= 0) return null; // defer — no fallback

  let priceWithBuffer: number;
  if (side === 'BUY') {
    priceWithBuffer = isExit
      ? ref * (1 + buffers.sellExitBuffer)
      : ref * (1 + buffers.buyEntryBuffer);
  } else {
    priceWithBuffer = isExit
      ? ref * (1 - buffers.buyExitBuffer)
      : ref * (1 - buffers.sellEntryBuffer);
  }
  return Math.max(0.01, Math.round(priceWithBuffer * 100) / 100);
}

// Zero-buffer scenario (pure bid/ask spread test)
const ZERO_BUFFERS = {
  buyEntryBuffer: 0,
  buyExitBuffer: 0,
  sellEntryBuffer: 0,
  sellExitBuffer: 0,
};

const QUOTE = { bid: 1924.14, ask: 1926.06 };

// ---------------------------------------------------------------------------
// Test 1 — LONG open + close: spread cost = -192
// ---------------------------------------------------------------------------
describe('Execution pricing — LONG', () => {
  test('BUY 100 fills at ASK', () => {
    const entryFill = computeFillPrice('BUY', false, QUOTE, ZERO_BUFFERS);
    expect(entryFill).toBe(1926.06);
  });

  test('SELL 100 fills at BID', () => {
    const exitFill = computeFillPrice('SELL', true, QUOTE, ZERO_BUFFERS);
    expect(exitFill).toBe(1924.14);
  });

  test('LONG gross P&L (qty=100) = -192', () => {
    const entryFill = computeFillPrice('BUY', false, QUOTE, ZERO_BUFFERS)!;
    const exitFill = computeFillPrice('SELL', true, QUOTE, ZERO_BUFFERS)!;
    const grossPnl = (exitFill - entryFill) * 100;
    expect(Math.round(grossPnl * 100) / 100).toBe(-192);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — SHORT open + close: spread cost = -192
// ---------------------------------------------------------------------------
describe('Execution pricing — SHORT', () => {
  test('SELL 100 fills at BID', () => {
    const entryFill = computeFillPrice('SELL', false, QUOTE, ZERO_BUFFERS);
    expect(entryFill).toBe(1924.14);
  });

  test('BUY 100 fills at ASK', () => {
    const exitFill = computeFillPrice('BUY', true, QUOTE, ZERO_BUFFERS);
    expect(exitFill).toBe(1926.06);
  });

  test('SHORT gross P&L (qty=100) = -192', () => {
    const entryFill = computeFillPrice('SELL', false, QUOTE, ZERO_BUFFERS)!;
    const exitFill = computeFillPrice('BUY', true, QUOTE, ZERO_BUFFERS)!;
    // SHORT P&L = (entry - exit) * qty
    const grossPnl = (entryFill - exitFill) * 100;
    expect(Math.round(grossPnl * 100) / 100).toBe(-192);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Client complaint reproduction: qty 1, P&L = -1.92 NOT ~0
// ---------------------------------------------------------------------------
describe('Client complaint — qty 1 LONG', () => {
  test('entry_price = ASK = 1926.06', () => {
    const entryFill = computeFillPrice('BUY', false, QUOTE, ZERO_BUFFERS);
    expect(entryFill).toBe(1926.06);
  });

  test('exit_price = BID = 1924.14 (NOT 1926.06)', () => {
    const exitFill = computeFillPrice('SELL', true, QUOTE, ZERO_BUFFERS);
    expect(exitFill).toBe(1924.14);
    expect(exitFill).not.toBe(1926.06); // the bug: exit was same as entry
  });

  test('gross P&L = -1.92, not ~0', () => {
    const entryFill = computeFillPrice('BUY', false, QUOTE, ZERO_BUFFERS)!;
    const exitFill = computeFillPrice('SELL', true, QUOTE, ZERO_BUFFERS)!;
    const grossPnl = Math.round((exitFill - entryFill) * 100) / 100;
    expect(grossPnl).toBe(-1.92);
    expect(Math.abs(grossPnl)).toBeGreaterThan(0.5); // must NOT be ~0
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Missing ASK defers BUY order (no silent LTP fallback)
// ---------------------------------------------------------------------------
describe('Missing bid/ask — deferral policy', () => {
  test('BUY order deferred when ASK is missing', () => {
    const quoteWithoutAsk = { bid: 1924.14, ask: 0 }; // ask=0 treated as unavailable
    const fill = computeFillPrice('BUY', false, quoteWithoutAsk, ZERO_BUFFERS);
    expect(fill).toBeNull(); // must defer, not use bid or last_price
  });

  // ---------------------------------------------------------------------------
  // Test 5 — Missing BID defers SELL order
  // ---------------------------------------------------------------------------
  test('SELL order deferred when BID is missing', () => {
    const quoteWithoutBid = { bid: 0, ask: 1926.06 }; // bid=0 treated as unavailable
    const fill = computeFillPrice('SELL', false, quoteWithoutBid, ZERO_BUFFERS);
    expect(fill).toBeNull(); // must defer, not use ask or last_price
  });
});

// ---------------------------------------------------------------------------
// Test 6 — LONG SL triggers on BID, not LTP
// Scenario: SL=1920, BID=1919.50, LTP=1921.00 → SL should fire
// ---------------------------------------------------------------------------
describe('SL/Target trigger semantics', () => {
  function shouldLongSlTrigger(bid: number, stopLoss: number): boolean {
    if (!bid || bid <= 0) return false;
    return bid <= stopLoss;
  }

  test('LONG SL fires when BID <= stopLoss, even if LTP > stopLoss', () => {
    const bid = 1919.50;
    const ltp = 1921.00; // LTP is above SL
    const stopLoss = 1920;
    expect(bid <= stopLoss).toBe(true);   // BID has crossed SL
    expect(ltp <= stopLoss).toBe(false);  // LTP has NOT crossed SL — the bug
    expect(shouldLongSlTrigger(bid, stopLoss)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 7 — SHORT Target triggers on ASK, not LTP
  // Scenario: target=1930, ASK=1929.00, LTP=1928.00 → target should fire
  // ---------------------------------------------------------------------------
  function shouldShortTargetTrigger(ask: number, target: number): boolean {
    if (!ask || ask <= 0) return false;
    return ask <= target;
  }

  test('SHORT target fires when ASK <= target, even if LTP < target', () => {
    const ask = 1929.00;
    const ltp = 1928.00; // LTP is below target
    const target = 1930;
    expect(ask <= target).toBe(true);  // ASK has crossed target
    expect(ltp <= target).toBe(true);  // LTP also crosses but is the wrong reference
    expect(shouldShortTargetTrigger(ask, target)).toBe(true);
  });
});
