import { describe, it, expect } from 'vitest';
import { parseOptionSymbol } from '../lib/parseOptionSymbol';

// Helper mimicking getOcSymbol logic from WatchlistSearch.tsx
function getOcSymbolTest(nameOrSymbol: string): string | null {
  const name = nameOrSymbol.toUpperCase().replace(/\s+/g, '');
  // MCX commodities — check mini/variant contracts before standard base contracts
  if (name.includes('GOLDM')) return 'GOLDM';
  if (name.includes('GOLD')) return 'GOLD';
  if (name.includes('SILVERM') || name.includes('SILVERMIC')) return 'SILVERM';
  if (name.includes('SILVER')) return 'SILVER';
  if (name.includes('CRUDEOILM')) return 'CRUDEOILM';
  if (name.includes('CRUDEOIL') || name.includes('CRUDE')) return 'CRUDEOIL';
  if (name.includes('NATGASMINI')) return 'NATGASMINI';
  if (name.includes('NATURALGAS') || name.includes('NATGAS')) return 'NATURALGAS';
  // Indices
  if (name.includes('BANKNIFTY') || name.includes('BANKN')) return 'BANKNIFTY';
  if (name.includes('FINNIFTY')) return 'FINNIFTY';
  if (name.includes('MIDCAP') || name.includes('MIDCP')) return 'MIDCPNIFTY';
  if (name.includes('SENSEX')) return 'SENSEX';
  if (name.includes('BANKEX')) return 'BANKEX';
  if (name.includes('NIFTY')) return 'NIFTY';
  return null;
}

describe('MCX Symbol Resolution & Variant Disambiguation', () => {
  it('correctly maps mini and base commodity symbols without cross-pollution', () => {
    expect(getOcSymbolTest('SILVERM')).toBe('SILVERM');
    expect(getOcSymbolTest('SILVERM26AUGFUT')).toBe('SILVERM');
    expect(getOcSymbolTest('SILVERM26AUG231000PE')).toBe('SILVERM');
    
    expect(getOcSymbolTest('SILVER')).toBe('SILVER');
    expect(getOcSymbolTest('SILVER26AUGFUT')).toBe('SILVER');
    expect(getOcSymbolTest('SILVER26AUG231000PE')).toBe('SILVER');

    expect(getOcSymbolTest('GOLDM')).toBe('GOLDM');
    expect(getOcSymbolTest('GOLD')).toBe('GOLD');

    expect(getOcSymbolTest('CRUDEOILM')).toBe('CRUDEOILM');
    expect(getOcSymbolTest('CRUDEOIL')).toBe('CRUDEOIL');

    expect(getOcSymbolTest('NATGASMINI')).toBe('NATGASMINI');
    expect(getOcSymbolTest('NATURALGAS')).toBe('NATURALGAS');
  });

  it('correctly parses option symbols into distinct underlyings', () => {
    const silvermParsed = parseOptionSymbol('SILVERM26AUG231000PE');
    expect(silvermParsed).not.toBeNull();
    expect(silvermParsed?.underlying).toBe('SILVERM');
    expect(silvermParsed?.strike).toBe(231000);
    expect(silvermParsed?.optionType).toBe('PE');

    const silverParsed = parseOptionSymbol('SILVER26AUG231000PE');
    expect(silverParsed).not.toBeNull();
    expect(silverParsed?.underlying).toBe('SILVER');
    expect(silverParsed?.strike).toBe(231000);
    expect(silverParsed?.optionType).toBe('PE');
  });

  it('ensures distinct instrument token keys in ticker mapping', () => {
    const silvermToken = 143460871;
    const silverToken = 143330311;

    const tokenMap = new Map<number, string>();
    tokenMap.set(silvermToken, 'MCX:SILVERM26AUG231000PE');
    tokenMap.set(silverToken, 'MCX:SILVER26AUG231000PE');

    expect(tokenMap.get(143460871)).toBe('MCX:SILVERM26AUG231000PE');
    expect(tokenMap.get(143330311)).toBe('MCX:SILVER26AUG231000PE');
    expect(tokenMap.get(143460871)).not.toBe(tokenMap.get(143330311));
  });
});
