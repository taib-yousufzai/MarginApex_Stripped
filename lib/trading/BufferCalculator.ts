export interface BufferSettings {
  entry_buffer?: number;
  exit_buffer?: number;
}

export interface BufferCalculationParams {
  side: 'BUY' | 'SELL';
  isExit: boolean;
  basePrice: number;
  buySetting: BufferSettings | undefined;
  sellSetting: BufferSettings | undefined;
  brokeragePerUnit?: number;
}

/**
 * Calculates the execution price after applying entry/exit buffers.
 *
 * Fill price formula:
 *   BUY  entry:  ltp * (1 + buyEntryBuffer)             — fills at LTP + slippage
 *   BUY  exit:   (ltp * 1.001) * (1 + sellExitBuffer)   — closing a short at ask
 *   SELL entry:  (ltp * 0.999) * (1 - sellEntryBuffer)  — simulates bid - slippage
 *   SELL exit:   (ltp * 0.999) * (1 - buyExitBuffer)    — closing a long at bid
 *
 * For LIMIT / SL / GTT orders the basePrice is already the client_price,
 * so the 0.999/1.001 spread is NOT applied (those orders fill at the exact limit).
 *
 * The buffer belongs to the side of the original position when exiting.
 *
 * NOTE: Buffers are stored in the DB as percentages (e.g. 0.17 = 0.17%)
 * and must be divided by 100 to convert to decimal form (0.0017).
 */
export function calculateBufferedPrice({
  side,
  isExit,
  basePrice,
  buySetting,
  sellSetting,
  brokeragePerUnit = 0,
}: BufferCalculationParams): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new Error('Invalid base price for buffer calculation');
  }

  // Buffers are stored as percentages in DB (e.g. 0.17 = 0.17%), divide by 100 to get decimal form
  const buyEntryBuffer  = (buySetting?.entry_buffer  ?? 0.3)   / 100;
  const buyExitBuffer   = (buySetting?.exit_buffer   ?? 0.17)  / 100;
  const sellEntryBuffer = (sellSetting?.entry_buffer ?? 0.3)   / 100;
  const sellExitBuffer  = (sellSetting?.exit_buffer  ?? 0.17)  / 100;

  let bufferedPrice: number;

  if (side === 'BUY') {
    if (isExit) {
      // Exiting a short (buying back) — executes at ask + exit buffer (SELL side settings)
      bufferedPrice = (basePrice * 1.001) * (1 + sellExitBuffer);
    } else {
      // Long entry — fills at LTP + entry buffer
      bufferedPrice = basePrice * (1 + buyEntryBuffer);
    }
    bufferedPrice += brokeragePerUnit;
  } else {
    // side === 'SELL'
    if (isExit) {
      // Exiting a long (selling) — executes at bid - exit buffer (BUY side settings)
      bufferedPrice = (basePrice * 0.999) * (1 - buyExitBuffer);
    } else {
      // Short entry — executes at bid - entry buffer (SELL side settings)
      bufferedPrice = (basePrice * 0.999) * (1 - sellEntryBuffer);
    }
    bufferedPrice -= brokeragePerUnit;
  }

  return bufferedPrice;
}
