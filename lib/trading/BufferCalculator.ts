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
 * The buffer belongs to the side of the original position when exiting.
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

  const buyEntryBuffer = (buySetting?.entry_buffer ?? 0.3) / 100;
  const buyExitBuffer = (buySetting?.exit_buffer ?? 0.17) / 100;
  const sellEntryBuffer = (sellSetting?.entry_buffer ?? 0.3) / 100;
  const sellExitBuffer = (sellSetting?.exit_buffer ?? 0.17) / 100;

  let bufferedPrice = basePrice;

  if (side === 'BUY') {
    if (isExit) {
      // Buy to close a short position (Uses SELL side exit_buffer)
      bufferedPrice = basePrice * (1 + sellExitBuffer);
    } else {
      // Long entry (Uses BUY side entry_buffer)
      bufferedPrice = basePrice * (1 + buyEntryBuffer);
    }
    // Add brokerage per unit if applicable
    bufferedPrice += brokeragePerUnit;
  } else {
    // side === 'SELL'
    if (isExit) {
      // Sell to close a long position (Uses BUY side exit_buffer)
      bufferedPrice = basePrice * (1 - buyExitBuffer);
    } else {
      // Short entry (Uses SELL side entry_buffer)
      bufferedPrice = basePrice * (1 - sellEntryBuffer);
    }
    // Subtract brokerage per unit if applicable
    bufferedPrice -= brokeragePerUnit;
  }

  return bufferedPrice;
}
