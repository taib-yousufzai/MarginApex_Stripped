import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('Effective Bid/Ask Resolution and Order Execution Engine', () => {
  describe('1. Crypto / Feed Without Real Bid-Ask', () => {
    it('calculates Effective Ask and Bid correctly when LTP = 167.00 with Ask Buffer = +0.50 and Bid Buffer = 0.50', () => {
      const result = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(result.effectiveAsk).toBe(167.50);
      expect(result.effectiveBid).toBe(166.50);
    });

    it('executes MARKET BUY at Effective Ask (167.50) when normal buffer is 0', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      const zeroSetting = { entry_buffer: 0, exit_buffer: 0, exit_price_mode: 'BID_ASK' as const };

      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk,
        buySetting: zeroSetting,
        sellSetting: zeroSetting,
      });

      expect(fillPrice).toBe(167.50);
      expect(fillPrice).toBeGreaterThanOrEqual(effective.effectiveAsk);
    });

    it('executes MARKET SELL at Effective Bid (166.50) when normal buffer is 0', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      const zeroSetting = { entry_buffer: 0, exit_buffer: 0, exit_price_mode: 'BID_ASK' as const };

      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid,
        buySetting: zeroSetting,
        sellSetting: zeroSetting,
      });

      expect(fillPrice).toBe(166.50);
      expect(fillPrice).toBeLessThanOrEqual(effective.effectiveBid);
    });
  });

  describe('2. Zerodha / Real Market Feeds', () => {
    it('preserves real Zerodha Ask and Bid when ask/bid buffer is 0', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        rawBid: 166.50,
        rawAsk: 167.50,
        hasRealBidAsk: true,
        askBuffer: 0,
        bidBuffer: 0,
      });

      expect(effective.effectiveAsk).toBe(167.50);
      expect(effective.effectiveBid).toBe(166.50);
    });

    it('applies Ask/Bid buffers to real Zerodha feed correctly', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        rawBid: 166.50,
        rawAsk: 167.50,
        hasRealBidAsk: true,
        askBuffer: 0.20,
        bidBuffer: 0.20,
      });

      expect(effective.effectiveAsk).toBe(167.70);
      expect(effective.effectiveBid).toBe(166.30);
    });
  });

  describe('3. Execution Boundaries and Double-Buffering Safeguards', () => {
    it('ensures BUY never executes below Effective Ask', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      // Even if negative buffer setting is passed, Math.max enforces boundary
      const negativeSetting = { entry_buffer: -0.01, exit_buffer: -0.01, exit_price_mode: 'BID_ASK' as const };

      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk,
        buySetting: negativeSetting,
        sellSetting: negativeSetting,
      });

      expect(fillPrice).toBeGreaterThanOrEqual(effective.effectiveAsk);
      expect(fillPrice).not.toBe(165.00); // Guarantees the ~165 bug cannot re-occur
    });

    it('ensures SELL never executes above Effective Bid', () => {
      const effective = resolveEffectivePrices({
        ltp: 167.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      const negativeSetting = { entry_buffer: -0.01, exit_buffer: -0.01, exit_price_mode: 'BID_ASK' as const };

      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid,
        buySetting: negativeSetting,
        sellSetting: negativeSetting,
      });

      expect(fillPrice).toBeLessThanOrEqual(effective.effectiveBid);
    });

    it('applies Normal Buffer to Effective Ask/Bid without double-applying artificial 0.1% spread multipliers', () => {
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      // 0.3% normal entry buffer
      const normalSetting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };

      const buyFill = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk, // 100.50
        buySetting: normalSetting,
        sellSetting: normalSetting,
      });

      // 100.50 * (1 + 0.003) = 100.8015
      expect(buyFill).toBe(100.8015);
    });
  });

  describe('4. Original ~165 Bug Regression Proofs', () => {
    it('PROOFS: Effective Ask > LTP (167.50 > 167.00) CANNOT result in BUY fill < Effective Ask (165.00)', () => {
      const ltp = 167.00;
      const effective = resolveEffectivePrices({
        ltp,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveAsk).toBe(167.50);
      expect(effective.effectiveAsk).toBeGreaterThan(ltp);

      const bufferSetting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };
      const fillPrice = calculateBufferedPrice({
        side: 'BUY',
        isExit: false,
        basePrice: effective.effectiveAsk,
        buySetting: bufferSetting,
        sellSetting: bufferSetting,
      });

      // BUY fill is 167.50 * 1.003 = 168.0025, which is strictly >= 167.50 and never 165.00
      expect(fillPrice).toBeGreaterThanOrEqual(effective.effectiveAsk);
      expect(fillPrice).toBe(168.0025);
      expect(fillPrice).not.toBe(165.00);
    });

    it('PROOFS: Effective Bid < LTP (166.50 < 167.00) CANNOT result in SELL fill > Effective Bid', () => {
      const ltp = 167.00;
      const effective = resolveEffectivePrices({
        ltp,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveBid).toBe(166.50);
      expect(effective.effectiveBid).toBeLessThan(ltp);

      const bufferSetting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };
      const fillPrice = calculateBufferedPrice({
        side: 'SELL',
        isExit: false,
        basePrice: effective.effectiveBid,
        buySetting: bufferSetting,
        sellSetting: bufferSetting,
      });

      // SELL fill is 166.50 * (1 - 0.003) = 166.0005, which is strictly <= 166.50
      expect(fillPrice).toBeLessThanOrEqual(effective.effectiveBid);
      expect(fillPrice).toBe(166.0005);
    });
  });

  describe('5. Independent Buffer Combination Matrix', () => {
    it('Case A: Ask/Bid Buffer = 0, Normal Buffer = 0.003 (0.3%)', () => {
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        hasRealBidAsk: false,
        askBuffer: 0,
        bidBuffer: 0,
      });

      expect(effective.effectiveAsk).toBe(100.00);
      expect(effective.effectiveBid).toBe(100.00);

      const setting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };
      const buyFill = calculateBufferedPrice({ side: 'BUY', isExit: false, basePrice: effective.effectiveAsk, buySetting: setting, sellSetting: setting });
      const sellFill = calculateBufferedPrice({ side: 'SELL', isExit: false, basePrice: effective.effectiveBid, buySetting: setting, sellSetting: setting });

      expect(buyFill).toBe(100.30);
      expect(sellFill).toBe(99.70);
    });

    it('Case B: Ask/Bid Buffer = 0.50, Normal Buffer = 0', () => {
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveAsk).toBe(100.50);
      expect(effective.effectiveBid).toBe(99.50);

      const setting = { entry_buffer: 0, exit_buffer: 0, exit_price_mode: 'BID_ASK' as const };
      const buyFill = calculateBufferedPrice({ side: 'BUY', isExit: false, basePrice: effective.effectiveAsk, buySetting: setting, sellSetting: setting });
      const sellFill = calculateBufferedPrice({ side: 'SELL', isExit: false, basePrice: effective.effectiveBid, buySetting: setting, sellSetting: setting });

      expect(buyFill).toBe(100.50);
      expect(sellFill).toBe(99.50);
    });

    it('Case C: Both Ask/Bid Buffer = 0.50 AND Normal Buffer = 0.003 are non-zero', () => {
      const effective = resolveEffectivePrices({
        ltp: 100.00,
        hasRealBidAsk: false,
        askBuffer: 0.50,
        bidBuffer: 0.50,
      });

      expect(effective.effectiveAsk).toBe(100.50);
      expect(effective.effectiveBid).toBe(99.50);

      const setting = { entry_buffer: 0.003, exit_buffer: 0.0017, exit_price_mode: 'BID_ASK' as const };
      const buyFill = calculateBufferedPrice({ side: 'BUY', isExit: false, basePrice: effective.effectiveAsk, buySetting: setting, sellSetting: setting });
      const sellFill = calculateBufferedPrice({ side: 'SELL', isExit: false, basePrice: effective.effectiveBid, buySetting: setting, sellSetting: setting });

      // BUY: 100.50 * 1.003 = 100.8015
      // SELL: 99.50 * 0.997 = 99.2015
      expect(buyFill).toBe(100.8015);
      expect(sellFill).toBe(99.2015);
    });
  });
});
