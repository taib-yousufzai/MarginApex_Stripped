import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('Manual Matrix Verification (Four Combinations, Two-Layer Validation)', () => {

  describe('LAYER 1: Ask/Bid Buffer Enabled, Normal Buffer = 0 (Isolating Base Construction)', () => {
    const zeroNormalBuffer = { entry_buffer: 0, exit_buffer: 0, exit_price_mode: 'BID_ASK' as const };

    it('Combination 1: Crypto BUY (LTP + Ask Buffer)', () => {
      // LTP = 167, Ask Buffer = 0.50
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveAsk).toBe(167.50);

      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk,
        buySetting: zeroNormalBuffer,
        sellSetting: zeroNormalBuffer,
      });

      expect(fillPrice).toBe(167.50);
    });

    it('Combination 2: Crypto SELL (LTP - Bid Buffer)', () => {
      // LTP = 167, Bid Buffer = 0.50
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveBid).toBe(166.50);

      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid,
        buySetting: zeroNormalBuffer,
        sellSetting: zeroNormalBuffer,
      });

      expect(fillPrice).toBe(166.50);
    });

    it('Combination 3: Zerodha BUY (Zerodha Ask + Ask Buffer)', () => {
      // Zerodha Ask = 100.20, Ask Buffer = 0.50
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        rawAsk: 100.20,
        rawBid: 99.80,
        hasRealBidAsk: true,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveAsk).toBe(100.70);

      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk,
        buySetting: zeroNormalBuffer,
        sellSetting: zeroNormalBuffer,
      });

      expect(fillPrice).toBe(100.70);
    });

    it('Combination 4: Zerodha SELL (Zerodha Bid - Bid Buffer)', () => {
      // Zerodha Bid = 99.80, Bid Buffer = 0.50
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        rawAsk: 100.20,
        rawBid: 99.80,
        hasRealBidAsk: true,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveBid).toBe(99.30);

      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid,
        buySetting: zeroNormalBuffer,
        sellSetting: zeroNormalBuffer,
      });

      expect(fillPrice).toBe(99.30);
    });
  });

  describe('LAYER 2: Ask/Bid Buffer + Normal Buffer Enabled (Second Layer Verification)', () => {
    const normalBufferSetting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };

    it('Combination 1 with Normal Buffer: Crypto BUY', () => {
      const effective = resolveEffectivePrices({ ltp: 167.00, hasRealBidAsk: false, askBuffer: 0.50, bidBuffer: 0.50 });
      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk, // 167.50
        buySetting: normalBufferSetting,
        sellSetting: normalBufferSetting,
      });
      // 167.50 * 1.003 = 168.0025
      expect(fillPrice).toBe(168.0025);
    });

    it('Combination 2 with Normal Buffer: Crypto SELL', () => {
      const effective = resolveEffectivePrices({ ltp: 167.00, hasRealBidAsk: false, askBuffer: 0.50, bidBuffer: 0.50 });
      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid, // 166.50
        buySetting: normalBufferSetting,
        sellSetting: normalBufferSetting,
      });
      // 166.50 * (1 - 0.003) = 166.0005
      expect(fillPrice).toBe(166.0005);
    });

    it('Combination 3 with Normal Buffer: Zerodha BUY', () => {
      const effective = resolveEffectivePrices({ ltp: 100.00, rawAsk: 100.20, rawBid: 99.80, hasRealBidAsk: true, askBuffer: 0.50, bidBuffer: 0.50 });
      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk, // 100.70
        buySetting: normalBufferSetting,
        sellSetting: normalBufferSetting,
      });
      // 100.70 * 1.003 = 101.0021
      expect(fillPrice).toBe(101.0021);
    });

    it('Combination 4 with Normal Buffer: Zerodha SELL', () => {
      const effective = resolveEffectivePrices({ ltp: 100.00, rawAsk: 100.20, rawBid: 99.80, hasRealBidAsk: true, askBuffer: 0.50, bidBuffer: 0.50 });
      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid, // 99.30
        buySetting: normalBufferSetting,
        sellSetting: normalBufferSetting,
      });
      // 99.30 * (1 - 0.003) = 99.0021
      expect(fillPrice).toBe(99.0021);
    });
  });
});
