import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('Market Order Execution Price Synchronization & Non-Sub-Ask BUY Rule', () => {
  it('CRITICAL: MARKET BUY with real Bid/Ask feed must NEVER execute below the execution-time Ask', () => {
    // Case B Reproduction Data:
    // UI Ask = 1878.39, UI Bid = 1876.52, UI LTP = 1877.46
    // Execution-time Ask = 1878.39
    const ltp = 1877.46;
    const rawBid = 1876.52;
    const rawAsk = 1878.39;
    const hasRealBidAsk = true;

    const effective = resolveEffectivePrices({
      ltp,
      rawBid,
      rawAsk,
      hasRealBidAsk,
      askBuffer: 0,
      bidBuffer: 0,
    });

    expect(effective.hasRealBidAsk).toBe(true);
    expect(effective.effectiveAsk).toBe(1878.39);

    const fillPrice = calculateBufferedPrice({
      side: 'BUY',
      isExit: false,
      basePrice: effective.effectiveAsk,
      buySetting: { entry_buffer: 0, exit_buffer: 0 },
      sellSetting: { entry_buffer: 0, exit_buffer: 0 },
    });

    // Fill price MUST equal 1878.39 (Best Ask), NOT 1877.46 (LTP)
    expect(fillPrice).toBe(1878.39);
    expect(fillPrice).toBeGreaterThanOrEqual(rawAsk);
  });

  it('CRITICAL: MARKET SELL with real Bid/Ask feed must NEVER execute above the execution-time Bid', () => {
    const ltp = 1877.46;
    const rawBid = 1876.52;
    const rawAsk = 1878.39;
    const hasRealBidAsk = true;

    const effective = resolveEffectivePrices({
      ltp,
      rawBid,
      rawAsk,
      hasRealBidAsk,
      askBuffer: 0,
      bidBuffer: 0,
    });

    expect(effective.hasRealBidAsk).toBe(true);
    expect(effective.effectiveBid).toBe(1876.52);

    const fillPrice = calculateBufferedPrice({
      side: 'SELL',
      isExit: false,
      basePrice: effective.effectiveBid,
      buySetting: { entry_buffer: 0, exit_buffer: 0 },
      sellSetting: { entry_buffer: 0, exit_buffer: 0 },
    });

    // Fill price MUST equal 1876.52 (Best Bid), NOT 1877.46 (LTP)
    expect(fillPrice).toBe(1876.52);
    expect(fillPrice).toBeLessThanOrEqual(rawBid);
  });

  it('Synthetic / LTP-only feed: BUY uses LTP + Ask Buffer, SELL uses LTP - Bid Buffer', () => {
    const ltp = 1877.46;
    const hasRealBidAsk = false;

    const effective = resolveEffectivePrices({
      ltp,
      rawBid: null,
      rawAsk: null,
      hasRealBidAsk,
      askBuffer: 0,
      bidBuffer: 0,
    });

    expect(effective.hasRealBidAsk).toBe(false);
    expect(effective.effectiveAsk).toBe(1877.46);
    expect(effective.effectiveBid).toBe(1877.46);

    const buyFill = calculateBufferedPrice({
      side: 'BUY',
      isExit: false,
      basePrice: effective.effectiveAsk,
      buySetting: { entry_buffer: 0, exit_buffer: 0 },
      sellSetting: { entry_buffer: 0, exit_buffer: 0 },
    });

    const sellFill = calculateBufferedPrice({
      side: 'SELL',
      isExit: false,
      basePrice: effective.effectiveBid,
      buySetting: { entry_buffer: 0, exit_buffer: 0 },
      sellSetting: { entry_buffer: 0, exit_buffer: 0 },
    });

    expect(buyFill).toBe(1877.46);
    expect(sellFill).toBe(1877.46);
  });
});
