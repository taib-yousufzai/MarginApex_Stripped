import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { describe, it, expect } from 'vitest';
import { mapSymbolToSegment } from '../lib/trading/SymbolMapping';
import { resolveTargetExchange } from '../lib/trading/OptionStrikeValidator';

describe('Trading Instrument Hierarchy Isolation Regression Tests', () => {
  it('correctly maps Index Options vs Stock Options', () => {
    expect(mapSymbolToSegment('NIFTY26AUG24500CE')).toBe('INDEX-OPT');
    expect(mapSymbolToSegment('SENSEX26AUG80000CE')).toBe('INDEX-OPT');
    expect(mapSymbolToSegment('SENSEX5026AUG8000CE')).toBe('INDEX-OPT');
    expect(mapSymbolToSegment('BANKEX26AUG60000PE')).toBe('INDEX-OPT');

    expect(mapSymbolToSegment('RELIANCE26AUG3000CE')).toBe('STOCK-OPT');
    expect(mapSymbolToSegment('ADANIENSOL26AUG1000PE')).toBe('STOCK-OPT');
    expect(mapSymbolToSegment('MPHASIS26AUG3000CE')).toBe('STOCK-OPT');
    expect(mapSymbolToSegment('BAJFINANCE26AUG7000PE')).toBe('STOCK-OPT');
  });

  it('correctly maps Index Futures vs Stock Futures', () => {
    expect(mapSymbolToSegment('NIFTY26AUGFUT')).toBe('INDEX-FUT');
    expect(mapSymbolToSegment('SENSEX26AUGFUT')).toBe('INDEX-FUT');
    expect(mapSymbolToSegment('SENSEX5026AUGFUT')).toBe('INDEX-FUT');
    expect(mapSymbolToSegment('BANKEX26AUGFUT')).toBe('INDEX-FUT');

    expect(mapSymbolToSegment('ADANIENSOL26AUGFUT')).toBe('STOCK-FUT');
    expect(mapSymbolToSegment('MPHASIS26AUGFUT')).toBe('STOCK-FUT');
    expect(mapSymbolToSegment('BAJFINANCE26AUGFUT')).toBe('STOCK-FUT');
    expect(mapSymbolToSegment('RELIANCE26AUGFUT')).toBe('STOCK-FUT');
  });

  it('resolves target exchange for SENSEX50 and BSE index derivatives as BFO', () => {
    expect(resolveTargetExchange('SENSEX5026AUG8000CE', 'SENSEX50')).toBe('BFO');
    expect(resolveTargetExchange('SENSEX26AUG80000CE', 'SENSEX')).toBe('BFO');
    expect(resolveTargetExchange('BANKEX26AUG60000PE', 'BANKEX')).toBe('BFO');
  });
});
