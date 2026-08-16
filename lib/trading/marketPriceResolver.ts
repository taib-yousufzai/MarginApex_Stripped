export interface MarketPriceInput {
  ltp: number;
  rawBid?: number | null;
  rawAsk?: number | null;
  hasRealBidAsk?: boolean;
  askBuffer?: number;
  bidBuffer?: number;
}

export interface EffectivePrices {
  effectiveAsk: number;
  effectiveBid: number;
  hasRealBidAsk: boolean;
}

/**
 * Resolves the Effective Ask and Effective Bid prices according to explicit market feed type.
 *
 * Zerodha / Real Feed (with real bid & ask):
 *   Effective Ask = Zerodha Ask + askBuffer
 *   Effective Bid = Zerodha Bid - bidBuffer
 *
 * Crypto / Synthetic Feed (where data feed has no real bid/ask):
 *   Effective Ask = LTP + askBuffer
 *   Effective Bid = LTP - bidBuffer
 */
export function resolveEffectivePrices({
  ltp,
  rawBid,
  rawAsk,
  hasRealBidAsk = false,
  askBuffer = 0,
  bidBuffer = 0,
}: MarketPriceInput): EffectivePrices {
  const baseLtp = Number.isFinite(Number(ltp)) && Number(ltp) > 0 ? Number(ltp) : 0;

  const validRealSpread =
    hasRealBidAsk &&
    rawBid !== undefined &&
    rawBid !== null &&
    rawAsk !== undefined &&
    rawAsk !== null &&
    Number(rawBid) > 0 &&
    Number(rawAsk) > 0 &&
    Number(rawBid) < Number(rawAsk);

  let effectiveAsk: number;
  let effectiveBid: number;

  if (validRealSpread) {
    // Real orderbook spread feed
    effectiveAsk = Number(rawAsk);
    effectiveBid = Number(rawBid);
  } else {
    const aBuf = Number(askBuffer) || 0;
    const bBuf = Number(bidBuffer) || 0;

    const calcBufferOffset = (buf: number) => {
      if (buf <= 0) return 0;
      if (buf > 0.005 && buf <= 100) {
        const decimal = buf > 1 ? buf / 100 : buf;
        return baseLtp * decimal;
      }
      return buf;
    };

    const aOffset = calcBufferOffset(aBuf);
    const bOffset = calcBufferOffset(bBuf);

    effectiveAsk = baseLtp + aOffset;
    effectiveBid = baseLtp - bOffset;
  }

  return {
    effectiveAsk: Math.round(effectiveAsk * 10000) / 10000,
    effectiveBid: Math.round(effectiveBid * 10000) / 10000,
    hasRealBidAsk: Boolean(validRealSpread),
  };
}
