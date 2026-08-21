import { describe, it, expect } from 'vitest';
import { normalizeOptionQuoteDepth } from '../lib/trading/quoteNormalization';

describe('Option Quote Depth Normalization (B/A Mode)', () => {
  it('A. LTP inside spread with stale high Ask -> clamps Ask to LTP', () => {
    // LTP 2724, Bid 2713, Ask 2857
    const result = normalizeOptionQuoteDepth(2724, 2713, 2857);
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('B. LTP exactly at Ask -> preserves valid depth', () => {
    // LTP 2724, Bid 2713, Ask 2724
    const result = normalizeOptionQuoteDepth(2724, 2713, 2724);
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('C. LTP above Ask -> normalizes stale Ask to LTP', () => {
    // LTP 2724, Bid 2600, Ask 2700
    const result = normalizeOptionQuoteDepth(2724, 2600, 2700);
    expect(result.ask).toBe(2724);
    expect(result.bid).toBeLessThanOrEqual(result.ask);
    expect(2724).toBeGreaterThanOrEqual(result.ask);
  });

  it('D. LTP below Bid -> normalizes stale Bid and Ask to LTP', () => {
    // LTP 2724, Bid 2800, Ask 2900
    const result = normalizeOptionQuoteDepth(2724, 2800, 2900);
    expect(result).toEqual({ bid: 2724, ask: 2724 });
  });

  it('E. Valid quote with balanced spread -> preserved unchanged', () => {
    // LTP 2724, Bid 2700, Ask 2750
    const result = normalizeOptionQuoteDepth(2724, 2700, 2750);
    expect(result).toEqual({ bid: 2700, ask: 2750 });
  });

  it('F. No depth -> returns 0 / 0 (displays --- / ---)', () => {
    // LTP 2724, Bid 0, Ask 0
    const result = normalizeOptionQuoteDepth(2724, 0, 0);
    expect(result).toEqual({ bid: 0, ask: 0 });
  });

  it('G. Cross-contract isolation -> normalizes contracts independently', () => {
    const ce = normalizeOptionQuoteDepth(2724, 2713, 2857); // 160500 CE
    const pe = normalizeOptionQuoteDepth(2284.5, 2280, 2290); // 161000 PE

    expect(ce).toEqual({ bid: 2713, ask: 2724 });
    expect(pe).toEqual({ bid: 2280, ask: 2290 });
  });

  it('H. Realtime updates -> immediately adapts as LTP moves across spread', () => {
    // Tick 1: LTP 2724, Ask 2857 -> Ask clamped to 2724
    const t1 = normalizeOptionQuoteDepth(2724, 2713, 2857);
    expect(t1).toEqual({ bid: 2713, ask: 2724 });

    // Tick 2: LTP moves up to 2745 -> Ask 2750 now valid
    const t2 = normalizeOptionQuoteDepth(2745, 2713, 2750);
    expect(t2).toEqual({ bid: 2713, ask: 2750 });

    // Tick 3: LTP moves up to 2760 -> Ask 2750 now stale below LTP -> Ask normalized to 2760
    const t3 = normalizeOptionQuoteDepth(2760, 2713, 2750);
    expect(t3.ask).toBe(2760);
  });
});
