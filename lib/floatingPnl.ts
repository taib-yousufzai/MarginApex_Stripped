/**
 * Floating P&L and exit price calculations.
 *
 * Single source of truth for the exit-buffer-adjusted formulas used across:
 *   - liquidationEngine.ts  (account-level liquidation trigger)
 *   - marginSquareOff.ts    (carry margin square-off)
 *   - orderMatching.ts      (per-tick P&L for all open positions)
 *   - positions/[id]/close  (user-initiated close)
 *
 * Buffer convention:
 *   exit_buffer is stored in the DB in decimal form (e.g. 0.0017 = 0.17%).
 *   Pass the raw DB value here — this module uses it directly.
 *
 *   bid_buffer is used for BUY-side liquidation closes (forced exits on longs
 *   use the bid price, which is slightly below LTP). Defaults to exit_buffer
 *   when not provided.
 */

export interface FloatingPnlParams {
  side: string;
  ltp: number;
  entryPrice: number;
  qty: number;
  /** Raw DB value in decimal form — e.g. 0.0017 for 0.17%. Applied to SELL closes and BUY floating P&L. */
  exitBufferPct: number;
  /**
   * Raw DB value in decimal form — e.g. 0.003 for 0.3%. Applied to BUY-side forced closes
   * (liquidation engine uses bid price for longs).
   * Defaults to exitBufferPct when omitted.
   */
  bidBufferPct?: number;
}

/**
 * Compute the free (available) margin for an account.
 *
 * Free margin = balance + sum of floating losses from open positions.
 * Floating losses are negative numbers, so adding them reduces available capital.
 * Floating profits are excluded — they cannot be used as collateral until realised.
 *
 * This is the canonical formula used by:
 *   - Order placement margin check  (orders/route.ts)
 *   - Product type conversion check (positions/[id]/convert/route.ts)
 *   - Carry margin square-off       (marginSquareOff.ts)
 *
 * @param balance         - Current wallet balance
 * @param totalFloatingLoss - Sum of unrealised losses only (must be ≤ 0; profits ignored)
 */
export function calculateFreeMargin(balance: number, totalLockedMargin: number, totalFloatingPnl: number): number {
  return balance - totalLockedMargin + Math.min(0, totalFloatingPnl);
}

/**
 * Convenience helper: derive totalFloatingLoss and totalLockedMargin from an array of open positions
 * and then compute free margin.
 *
 * Positions are expected to have a numeric `pnl` field (the DB-cached value).
 * For real-time liquidation checks, use calculateFloatingPnl per position instead.
 */
export function calculateFreeMarginFromPositions(
  balance: number,
  openPositions: Array<{ pnl?: number | string | null; locked_margin?: number | string | null; margin_required?: number | string | null }>,
): number {
  let totalLockedMargin = 0;
  const totalFloatingPnl = openPositions.reduce((sum, p) => {
    totalLockedMargin += Number(p.locked_margin || p.margin_required || 0);
    const pnl = Number(p.pnl || 0);
    return sum + pnl;
  }, 0);
  return calculateFreeMargin(balance, totalLockedMargin, totalFloatingPnl);
}

/**
 * Compute the floating (unrealised) P&L for an open position.
 *
 * Uses the exit-buffer-adjusted LTP with spread simulation so the result matches what the liquidation
 * engine sees — i.e. "what would this position settle for right now".
 * This matches the formula used in positions/[id]/close and PositionsContext.
 *
 * BUY:  ((ltp × 0.999) × (1 - exitBuffer) − entryPrice) × qty
 * SELL: (entryPrice − (ltp × 1.001) × (1 + exitBuffer)) × qty
 */
export function calculateFloatingPnl({
  side,
  ltp,
  entryPrice,
  qty,
  exitBufferPct,
}: FloatingPnlParams): number {
  const exitBuffer = exitBufferPct;  // DB stores in decimal form, use directly
  if (side === 'BUY') {
    return ((ltp * 0.999) * (1 - exitBuffer) - entryPrice) * qty;
  }
  return (entryPrice - (ltp * 1.001) * (1 + exitBuffer)) * qty;
}

/**
 * Compute the exit fill price for a position being closed.
 *
 * For forced / liquidation closes on BUY positions, the bid_buffer is used
 * (the user receives the bid price, which is below LTP).
 * For all other closes (user-initiated, SL/TP, EOD) use exit_buffer.
 * Includes spread simulation (0.999 for BUY, 1.001 for SELL).
 *
 * BUY:  ltp × 0.999 × (1 − buffer)   — user receives bid
 * SELL: ltp × 1.001 × (1 + buffer)   — user pays ask
 *
 * @param precision - decimal places to round to (default 4; use 2 for display)
 */
export function calculateExitPrice({
  side,
  ltp,
  exitBufferPct,
  bidBufferPct,
}: Pick<FloatingPnlParams, 'side' | 'ltp' | 'exitBufferPct' | 'bidBufferPct'>,
  precision = 4,
): number {
  const factor = Math.pow(10, precision);
  if (side === 'BUY') {
    const bidBuffer = bidBufferPct ?? exitBufferPct;  // DB stores in decimal form, use directly
    return Math.round(ltp * 0.999 * (1 - bidBuffer) * factor) / factor;
  }
  const exitBuffer = exitBufferPct;  // DB stores in decimal form, use directly
  return Math.round(ltp * 1.001 * (1 + exitBuffer) * factor) / factor;
}
