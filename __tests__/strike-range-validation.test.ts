import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { describe, it, expect } from 'vitest';
import { parseOptionSymbol } from '../lib/parseOptionSymbol';
import { validateOptionStrike } from '../lib/trading/OptionStrikeValidator';

describe('Strike Range Validation & Exit Bypass', () => {
  it('correctly parses strike price from complex option symbols', () => {
    const niftyOpt = parseOptionSymbol('NIFTY2681826900PE');
    expect(niftyOpt).not.toBeNull();
    expect(niftyOpt?.underlying).toBe('NIFTY');
    expect(niftyOpt?.strike).toBe(26900);
    expect(niftyOpt?.optionType).toBe('PE');

    const bankNiftyOpt = parseOptionSymbol('BANKNIFTY26AUG54000CE');
    expect(bankNiftyOpt).not.toBeNull();
    expect(bankNiftyOpt?.underlying).toBe('BANKNIFTY');
    expect(bankNiftyOpt?.strike).toBe(54000);
  });

  it('allows position EXITS (isExit = true) even for out-of-range option strikes', async () => {
    const res = await validateOptionStrike({
      symbol: 'GOLD26AUG155000CE',
      isExit: true,
    });
    expect(res.allowed).toBe(true);
  });
});
