import { describe, it, expect } from 'vitest';
import { normalizeOptionQuoteDepth, calculateSyntheticOptionSpread } from '../lib/trading/quoteNormalization';

describe('Option Quote Depth Normalization (B/A Mode)', () => {
  it('A. LTP inside spread with stale high Ask -> clamps Ask to LTP', () => {
    const result = normalizeOptionQuoteDepth(2724, 2713, 2857, { useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('B. LTP exactly at Ask -> preserves valid depth', () => {
    const result = normalizeOptionQuoteDepth(2724, 2713, 2724, { useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('C. LTP above Ask -> normalizes stale Ask to LTP', () => {
    const result = normalizeOptionQuoteDepth(2724, 2600, 2700, { useSyntheticFallback: false });
    expect(result.ask).toBe(2724);
    expect(result.bid).toBeLessThanOrEqual(result.ask);
    expect(2724).toBeGreaterThanOrEqual(result.ask);
  });

  it('D. LTP below Bid -> normalizes stale Bid and Ask to LTP', () => {
    const result = normalizeOptionQuoteDepth(2724, 2800, 2900, { useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2724, ask: 2724 });
  });

  it('E. Valid quote with balanced spread -> preserved unchanged', () => {
    const result = normalizeOptionQuoteDepth(2724, 2700, 2750, { useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2700, ask: 2750 });
  });

  it('F. Synthetic Crypto-style spread generation from LTP', () => {
    const synthetic = calculateSyntheticOptionSpread(2724, 0.3, 0.3);
    expect(synthetic).toEqual({ bid: 2723.7, ask: 2724.3 });
  });

  it('G. No raw depth with synthetic fallback enabled -> generates LTP-buffered spread', () => {
    const result = normalizeOptionQuoteDepth(2724, 0, 0, { askBuffer: 0.3, bidBuffer: 0.3, useSyntheticFallback: true });
    expect(result).toEqual({ bid: 2723.7, ask: 2724.3 });
  });

  it('H. Cross-contract isolation -> normalizes contracts independently', () => {
    const ce = normalizeOptionQuoteDepth(2724, 2713, 2857, { useSyntheticFallback: false });
    const pe = normalizeOptionQuoteDepth(2284.5, 2280, 2290, { useSyntheticFallback: false });

    expect(ce).toEqual({ bid: 2713, ask: 2724 });
    expect(pe).toEqual({ bid: 2280, ask: 2290 });
  });
});
