import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { describe, it, expect } from 'vitest';
import { validateOptionStrike, resolveTargetExchange } from '../lib/trading/OptionStrikeValidator';

describe('OptionStrikeValidator — Strict Exchange & 11-Strike Membership', () => {
  it('resolves MCX exchange correctly for commodity underlyings', () => {
    expect(resolveTargetExchange('GOLD26AUG159000CE', 'GOLD')).toBe('MCX');
    expect(resolveTargetExchange('SILVERM26AUG231000PE', 'SILVERM')).toBe('MCX');
    expect(resolveTargetExchange('NIFTY26AUG24500CE', 'NIFTY')).toBe('NSE');
    expect(resolveTargetExchange('SENSEX26AUG80000CE', 'SENSEX')).toBe('BSE');
  });

  it('allows GOLD 159000 CE when spot is ~157801 in the active MCX 11-strike window', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG159000CE',
      isExit: false,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });

    expect(res.allowed).toBe(true);
    expect(res.orderStrike).toBe(159000);
    expect(res.minAllowed).toBe(155500);
    expect(res.maxAllowed).toBe(160500);
  });

  it('allows GOLD 159000 PE when spot is ~157801 in the active MCX 11-strike window', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG159000PE',
      isExit: false,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });

    expect(res.allowed).toBe(true);
    expect(res.orderStrike).toBe(159000);
    expect(res.minAllowed).toBe(155500);
    expect(res.maxAllowed).toBe(160500);
  });

  it('allows boundary strikes 155500 and 160500 in the 11-strike window', async () => {
    const resMin = await validateOptionStrike({
      symbol: 'GOLD26AUG155500CE',
      isExit: false,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });
    expect(resMin.allowed).toBe(true);

    const resMax = await validateOptionStrike({
      symbol: 'GOLD26AUG160500CE',
      isExit: false,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });
    expect(resMax.allowed).toBe(true);
  });

  it('rejects strike 155000 which is outside the active 11-strike window (155500 to 160500)', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG155000CE',
      isExit: false,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });

    expect(res.allowed).toBe(false);
    expect(res.minAllowed).toBe(155500);
    expect(res.maxAllowed).toBe(160500);
    expect(res.reason).toContain('outside the active option chain window (155500 to 160500)');
  });

  it('always bypasses validation for exit orders', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG155000CE',
      isExit: true,
      knownQuotesMap: { 'MCX:GOLD26OCTFUT': 157801 },
    });

    expect(res.allowed).toBe(true);
  });
});
