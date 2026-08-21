import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { normalizeOptionQuoteDepth, calculateSyntheticOptionSpread } from '../lib/trading/quoteNormalization';

describe('Crypto & Non-Indian Market Quote Buffering', () => {
  it('A. Resolves non-zero bid/ask synthetic spread for Crypto when askBuffer & bidBuffer are supplied', () => {
    const buySetting = { segment: 'CRYPTO', side: 'BUY', entry_buffer: 0.3, bid_buffer: 0.3 };
    const sellSetting = { segment: 'CRYPTO', side: 'SELL', entry_buffer: 0.3, bid_buffer: 0.3 };

    const askBuffer = buySetting.entry_buffer ?? buySetting.bid_buffer;
    const bidBuffer = sellSetting.entry_buffer ?? sellSetting.bid_buffer;

    const effective = resolveEffectivePrices({
      ltp: 2400.0,
      hasRealBidAsk: false,
      askBuffer,
      bidBuffer,
    });

    expect(effective.effectiveAsk).toBeGreaterThan(2400.0);
    expect(effective.effectiveBid).toBeLessThan(2400.0);
    expect(effective.effectiveAsk).toBe(2407.2);
    expect(effective.effectiveBid).toBe(2392.8);
  });

  it('B. normalizeOptionQuoteDepth generates synthetic spread for Crypto when forceSynthetic is true', () => {
    const ltp = 2402.04;
    const { bid, ask } = normalizeOptionQuoteDepth(ltp, ltp, ltp, {
      forceSynthetic: true,
      askBuffer: 0.3,
      bidBuffer: 0.3,
    });

    expect(ask).toBeGreaterThan(ltp);
    expect(bid).toBeLessThan(ltp);
    expect(ask).toBe(2409.25);
    expect(bid).toBe(2394.83);
  });

  it('C. Ignores ask/bid buffers for Indian market (Raw passthrough)', () => {
    const isIndianMarket = true;
    const askBuffer = isIndianMarket ? 0 : 0.3;
    const bidBuffer = isIndianMarket ? 0 : 0.3;

    const effective = resolveEffectivePrices({
      ltp: 2400.0,
      rawAsk: 2401.0,
      rawBid: 2399.0,
      hasRealBidAsk: true,
      askBuffer,
      bidBuffer,
    });

    expect(effective.effectiveAsk).toBe(2401.0);
    expect(effective.effectiveBid).toBe(2399.0);
  });
});
