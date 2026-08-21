import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';

describe('All Account Types Crypto & Non-Indian Buffer Consistency', () => {
  it('A. Demo Account (0.3% buffer = 0.3) calculates correct bid & ask spread on $2,400 ETH', () => {
    const effective = resolveEffectivePrices({
      ltp: 2400,
      hasRealBidAsk: false,
      askBuffer: 0.3,
      bidBuffer: 0.3,
    });

    // 0.3% of 2400 is 7.20
    expect(effective.effectiveAsk).toBe(2407.2);
    expect(effective.effectiveBid).toBe(2392.8);
  });

  it('B. Live/Real User Account (stored buffer = 0.003) calculates EXACT same spread on $2,400 ETH', () => {
    const effective = resolveEffectivePrices({
      ltp: 2400,
      hasRealBidAsk: false,
      askBuffer: 0.003,
      bidBuffer: 0.003,
    });

    // 0.003 (0.3%) of 2400 is 7.20
    expect(effective.effectiveAsk).toBe(2407.2);
    expect(effective.effectiveBid).toBe(2392.8);
  });

  it('C. Bitcoin $90,000 calculates correct scaled spread for both 0.3 and 0.003 inputs', () => {
    const effectiveDemo = resolveEffectivePrices({
      ltp: 90000,
      hasRealBidAsk: false,
      askBuffer: 0.3,
      bidBuffer: 0.3,
    });

    const effectiveReal = resolveEffectivePrices({
      ltp: 90000,
      hasRealBidAsk: false,
      askBuffer: 0.003,
      bidBuffer: 0.003,
    });

    // 0.3% of 90,000 is 270
    expect(effectiveDemo.effectiveAsk).toBe(90270);
    expect(effectiveDemo.effectiveBid).toBe(89730);

    expect(effectiveReal.effectiveAsk).toBe(90270);
    expect(effectiveReal.effectiveBid).toBe(89730);
  });

  it('D. Fallback buffer applies default 0.3% when 0 or undefined buffer is passed for synthetic feed', () => {
    const effective = resolveEffectivePrices({
      ltp: 1000,
      hasRealBidAsk: false,
      askBuffer: 0,
      bidBuffer: 0,
    });

    // Without buffer, ask and bid match LTP
    expect(effective.effectiveAsk).toBe(1000);
    expect(effective.effectiveBid).toBe(1000);
  });

  it('E. Indian Market (Zerodha real feed) strictly ignores buffers and passes through raw orderbook depth', () => {
    const effective = resolveEffectivePrices({
      ltp: 24000,
      rawAsk: 24005,
      rawBid: 24000,
      hasRealBidAsk: true,
      askBuffer: 0,
      bidBuffer: 0,
    });

    expect(effective.effectiveAsk).toBe(24005);
    expect(effective.effectiveBid).toBe(24000);
  });
});
