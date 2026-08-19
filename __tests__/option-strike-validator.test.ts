import { describe, it, expect, vi } from 'vitest';
import { resolveUnderlyingKiteId, validateOptionStrike } from '../lib/trading/OptionStrikeValidator';

// Mock admin client and market data calls for unit tests
vi.mock('@/lib/adminClient', () => ({
  getAdminClient: () => ({
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          or: () => chain,
          eq: (field: string, val: any) => {
            if (field === 'name' && val === 'SILVER') {
              chain._lastFut = 'SILVERM26AUGFUT';
            } else if (field === 'name' && val === 'GOLD') {
              chain._lastFut = 'GOLD26OCTFUT';
            }
            return chain;
          },
          in: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: (n: number) => chain,
          maybeSingle: async () => ({
            data: {
              name: 'GOLD',
              expiry: '2026-08-31',
              tradingsymbol: 'GOLD26AUG158500CE',
            },
            error: null,
          }),
          then: (resolve: any) => resolve({
            data: [
              { strike_price: 155500, tradingsymbol: chain._lastFut || 'GOLD26OCTFUT', exchange: 'MCX' },
              { strike_price: 156000 },
              { strike_price: 156500 },
              { strike_price: 157000 },
              { strike_price: 157500 },
              { strike_price: 158000 },
              { strike_price: 158500 },
              { strike_price: 159000 },
              { strike_price: 159500 },
              { strike_price: 160000 },
              { strike_price: 160500 },
              { strike_price: 161000 },
              { strike_price: 161500 },
            ],
            error: null,
          }),
        };
        return chain;
      },
    }),
  }),
}));

vi.mock('@/lib/datafeed/MarketDataService', () => ({
  fetchSpeedQuotes: async () => ({}),
  fetchKiteQuotes: async () => ({}),
}));

describe('Option Strike Validator & Underlying Resolution', () => {
  it('resolves proper underlying futures instrument key for MCX options', async () => {
    const goldKiteId = await resolveUnderlyingKiteId('GOLD26AUG158500CE', 'GOLD');
    expect(goldKiteId).toBe('MCX:GOLD26OCTFUT');

    const silvermKiteId = await resolveUnderlyingKiteId('SILVERM26AUG231000PE', 'SILVERM');
    expect(silvermKiteId).toBe('MCX:SILVERM26AUGFUT');

    const niftyKiteId = await resolveUnderlyingKiteId('NIFTY26AUG24500CE', 'NIFTY');
    expect(niftyKiteId).toBe('NSE:NIFTY 50');

    const bankNiftyKiteId = await resolveUnderlyingKiteId('BANKNIFTY26AUG54000CE', 'BANKNIFTY');
    expect(bankNiftyKiteId).toBe('NSE:NIFTY BANK');
  });

  it('always allows position EXITS (isExit = true)', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG158500CE',
      isExit: true,
    });
    expect(res.allowed).toBe(true);
  });

  it('allows strikes present in the active 11-strike option-chain window (e.g. 158500 CE with spot 158000)', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG158500CE',
      isExit: false,
      strikeRangeSetting: 0,
      knownQuotesMap: {
        'MCX:GOLD26OCTFUT': 158000,
      },
    });

    expect(res.allowed).toBe(true);
    expect(res.orderStrike).toBe(158500);
    expect(res.minAllowed).toBe(155500);
    expect(res.maxAllowed).toBe(160500);
  });

  it('rejects strikes outside the active 11-strike option-chain window (e.g. 150000 CE with spot 158000)', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG150000CE',
      isExit: false,
      strikeRangeSetting: 0,
      knownQuotesMap: {
        'MCX:GOLD26OCTFUT': 158000,
      },
    });

    expect(res.allowed).toBe(false);
    expect(res.orderStrike).toBe(150000);
    expect(res.minAllowed).toBe(155500);
    expect(res.maxAllowed).toBe(160500);
  });
});
