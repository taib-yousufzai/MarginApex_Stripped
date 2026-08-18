import { describe, it, expect } from 'vitest';
import { parseOptionSymbol } from '../lib/parseOptionSymbol';
import { OrderService } from '../lib/trading/OrderService';

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

  it('rejects fresh BUY/SELL entries for out-of-range option strikes', () => {
    const symbol = 'NIFTY2681826900PE'; // Strike: 26900
    const spot = 24500;
    const strikeRange = 500; // Allowed range: 24000 to 25000

    const error = OrderService.validateStrikeRange(symbol, true, strikeRange, spot, false);
    expect(error).toContain('outside the allowed range');
    expect(error).toContain('26900');
  });

  it('allows fresh BUY/SELL entries for in-range option strikes', () => {
    const symbol = 'NIFTY2681824600PE'; // Strike: 24600
    const spot = 24500;
    const strikeRange = 500; // Allowed range: 24000 to 25000

    const error = OrderService.validateStrikeRange(symbol, true, strikeRange, spot, false);
    expect(error).toBeNull();
  });

  it('allows position EXITS (isExit = true) even for out-of-range option strikes', () => {
    const symbol = 'NIFTY2681826900PE'; // Strike: 26900 (Far out of range)
    const spot = 24500;
    const strikeRange = 500;

    // Exit order (isExit = true)
    const error = OrderService.validateStrikeRange(symbol, true, strikeRange, spot, true);
    expect(error).toBeNull(); // Must bypass check and allow exit
  });
});
