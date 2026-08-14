export interface BufferSettings {
  entry_buffer?: number;
  exit_buffer?: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
}

export interface BufferCalculationParams {
  side: 'BUY' | 'SELL';
  isExit: boolean;
  basePrice: number;
  buySetting: BufferSettings | undefined;
  sellSetting: BufferSettings | undefined;
  brokeragePerUnit?: number;
  exitPriceMode?: 'BID_ASK' | 'LTP';
  isBasePriceRealBidAsk?: boolean;
}

/**
 * Calculates the execution price after applying entry/exit buffers.
 *
 * Execution Rules based on price mode (BID_ASK vs LTP):
 *
 * Mode = BID_ASK (Default):
 *   - Fresh BUY Entry  : ASK price (base * 1.001) * (1 + buyEntryBuffer)
 *   - Fresh SELL Entry : BID price (base * 0.999) * (1 - sellEntryBuffer)
 *   - BUY Exit (Close) : ASK price (base * 1.001) * (1 + sellExitBuffer)
 *   - SELL Exit (Close): BID price (base * 0.999) * (1 - buyExitBuffer)
 *
 * Mode = LTP:
 *   - Fresh BUY Entry  : raw LTP (base) * (1 + buyEntryBuffer)
 *   - Fresh SELL Entry : raw LTP (base) * (1 - sellEntryBuffer)
 *   - BUY Exit (Close) : raw LTP (base) * (1 + sellExitBuffer)
 *   - SELL Exit (Close): raw LTP (base) * (1 - buyExitBuffer)
 */
export function calculateBufferedPrice({
  side,
  isExit,
  basePrice,
  buySetting,
  sellSetting,
  brokeragePerUnit = 0,
  exitPriceMode,
  isBasePriceRealBidAsk = false,
}: BufferCalculationParams): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new Error('Invalid base price for buffer calculation');
  }

  const toDecimalBuffer = (val: any, fallback: number) => {
    if (val === undefined || val === null || isNaN(Number(val))) return fallback;
    const num = Number(val);
    if (num === 0) return 0;
    return num > 0.005 ? num / 100 : num;
  };

  const buyEntryBuffer  = toDecimalBuffer(buySetting?.entry_buffer, 0.003);
  const buyExitBuffer   = toDecimalBuffer(buySetting?.exit_buffer, 0.0017);
  const sellEntryBuffer = toDecimalBuffer(sellSetting?.entry_buffer, 0.003);
  const sellExitBuffer  = toDecimalBuffer(sellSetting?.exit_buffer, 0.0017);

  const activeSetting = side === 'BUY' ? buySetting : sellSetting;
  const mode = exitPriceMode || activeSetting?.exit_price_mode || buySetting?.exit_price_mode || sellSetting?.exit_price_mode || 'BID_ASK';

  let bufferedPrice: number;

  if (side === 'BUY') {
    if (isExit) {
      // Exiting a short position (Buying back to close)
      const base = (mode === 'LTP' || isBasePriceRealBidAsk) ? basePrice : (basePrice * 1.001);
      bufferedPrice = base * (1 + sellExitBuffer);
    } else {
      // Fresh Long entry (Buying)
      const base = (mode === 'LTP' || isBasePriceRealBidAsk) ? basePrice : (basePrice * 1.001);
      bufferedPrice = base * (1 + buyEntryBuffer);
    }
    bufferedPrice += brokeragePerUnit;
  } else {
    // side === 'SELL'
    if (isExit) {
      // Exiting a long position (Selling to close)
      const base = (mode === 'LTP' || isBasePriceRealBidAsk) ? basePrice : (basePrice * 0.999);
      bufferedPrice = base * (1 - buyExitBuffer);
    } else {
      // Fresh Short entry (Selling)
      const base = (mode === 'LTP' || isBasePriceRealBidAsk) ? basePrice : (basePrice * 0.999);
      bufferedPrice = base * (1 - sellEntryBuffer);
    }
    bufferedPrice -= brokeragePerUnit;
  }

  return bufferedPrice;
}
