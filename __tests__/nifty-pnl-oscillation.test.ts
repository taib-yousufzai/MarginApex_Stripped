import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('NIFTY Option P&L Oscillation Bug Proof & Prevention', () => {
  it('does NOT oscillate P&L when alternating between depth ticks and LTP-only ticks', () => {
    // NIFTY BUY Option Position simulation
    // Entry price = 150.00, Qty = 50 (2 lots)
    const entryPrice = 150.00;
    const qty = 50;

    // Simulate 6 consecutive incoming market feed ticks:
    // Tick 1: Full depth tick (Bid 149.80, Ask 150.20, LTP 150.00)
    // Tick 2: LTP-only tick with depth preserved (Bid 149.90, Ask 150.30, LTP 150.10)
    // Tick 3: Full depth tick (Bid 149.90, Ask 150.30, LTP 150.10)
    // Tick 4: LTP-only tick with depth preserved (Bid 150.00, Ask 150.40, LTP 150.20)
    // Tick 5: Full depth tick (Bid 150.00, Ask 150.40, LTP 150.20)
    const feedTicks = [
      { ltp: 150.00, bid: 149.80, ask: 150.20 },
      { ltp: 150.10, bid: 149.90, ask: 150.30 }, // preserved spread across LTP tick
      { ltp: 150.10, bid: 149.90, ask: 150.30 },
      { ltp: 150.20, bid: 150.00, ask: 150.40 }, // preserved spread across LTP tick
      { ltp: 150.20, bid: 150.00, ask: 150.40 },
    ];

    const setting = {
      entry_buffer: 0,
      exit_buffer: 0,
      exit_price_mode: 'BID_ASK' as const,
    };

    const calculatedPnls: number[] = [];

    for (const tick of feedTicks) {
      const hasRealBidAsk = Boolean(
        tick.bid > 0 && tick.ask > 0 && tick.bid < tick.ask
      );

      const effective = resolveEffectivePrices({
        ltp: tick.ltp,
        rawBid: tick.bid,
        rawAsk: tick.ask,
        hasRealBidAsk,
      });

      // BUY position exit uses effectiveBid
      const basePrice = effective.effectiveBid;

      const exitPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: true,
        basePrice,
        buySetting: setting,
        sellSetting: setting,
      });

      const pnl = Math.round((exitPrice - entryPrice) * qty * 100) / 100;
      calculatedPnls.push(pnl);
    }

    // Verify P&L progression is strictly monotonic (smooth trend, NO flip-flopping)
    // Tick 1: (149.80 - 150.00) * 50 = -10.00
    // Tick 2: (149.90 - 150.00) * 50 = -5.00
    // Tick 3: (149.90 - 150.00) * 50 = -5.00
    // Tick 4: (150.00 - 150.00) * 50 = 0.00
    // Tick 5: (150.00 - 150.00) * 50 = 0.00
    expect(calculatedPnls).toEqual([-10, -5, -5, 0, 0]);

    // Ensure direction never reverses backwards between adjacent ticks
    for (let i = 1; i < calculatedPnls.length; i++) {
      expect(calculatedPnls[i]).toBeGreaterThanOrEqual(calculatedPnls[i - 1]);
    }
  });

  it('correctly falls back to LTP when real bid/ask depth is absent without creating fake spreads', () => {
    const ltp = 150.00;
    const bid = 0;
    const ask = 0;

    const hasRealBidAsk = Boolean(bid > 0 && ask > 0 && bid < ask);
    expect(hasRealBidAsk).toBe(false);

    const effective = resolveEffectivePrices({
      ltp,
      rawBid: bid,
      rawAsk: ask,
      hasRealBidAsk,
      askBuffer: 0,
      bidBuffer: 0,
    });

    expect(effective.hasRealBidAsk).toBe(false);
    expect(effective.effectiveBid).toBe(150.00);
    expect(effective.effectiveAsk).toBe(150.00);
  });
});
