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
    Number(rawAsk) > 0;

  let effectiveAsk: number;
  let effectiveBid: number;

  if (validRealSpread) {
    // Real / synthetic bid and ask already contain the market spread.
    // Do not add secondary askBuffer / bidBuffer on top of valid quotes.
    effectiveAsk = Number(rawAsk);
    effectiveBid = Number(rawBid);
  } else {
    const aBuf = Number(askBuffer) || 0;
    const bBuf = Number(bidBuffer) || 0;
    effectiveAsk = baseLtp + aBuf;
    effectiveBid = baseLtp - bBuf;
  }

  return {
    effectiveAsk: Math.round(effectiveAsk * 10000) / 10000,
    effectiveBid: Math.round(effectiveBid * 10000) / 10000,
    hasRealBidAsk: Boolean(validRealSpread),
  };
}
