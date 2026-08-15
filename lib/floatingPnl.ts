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
 *   exit_buffer in DB is stored as a percentage (e.g. 0.17 = 0.17%, 0.02 = 0.02%).
 *   This module converts it to decimal form via toDecimalBuffer before applying.
 *
 * Exit price rules:
 *   - BUY position exit  (selling to close) → BID price (ltp * 0.999) - exitBuffer
 *   - SELL position exit (buying back)      → ASK price (ltp * 1.001) + exitBuffer
 */

/** Convert a DB percentage buffer to its decimal multiplier form */
function toDecimalBuffer(val: number | undefined | null, fallback: number): number {
  if (val === undefined || val === null || isNaN(Number(val))) return fallback;
  const num = Number(val);
  if (num === 0) return 0;
  return num > 0.005 ? num / 100 : num;
}

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
 * BUY:  ((ltp × 0.999) × (1 - exitBuffer) − entryPrice) × qty   [closing long → BID]
 * SELL: (entryPrice − (ltp × 1.001) × (1 + exitBuffer)) × qty   [closing short → ASK]
 */
import { resolveEffectivePrices } from './trading/marketPriceResolver';
import { calculateBufferedPrice } from './trading/BufferCalculator';

export function calculateFloatingPnl({
  side,
  ltp,
  entryPrice,
  qty,
  exitBufferPct,
}: FloatingPnlParams): number {
  const exitPrice = calculateExitPrice({ side, ltp, exitBufferPct });
  if (side === 'BUY') {
    return (exitPrice - entryPrice) * qty;
  }
  return (entryPrice - exitPrice) * qty;
}

/**
 * Compute the exit fill price for a position being closed.
 *
 * For forced / liquidation closes on BUY positions, the bid_buffer is used
 * (the user receives the bid price, which is below LTP).
 * For all other closes (user-initiated, SL/TP, EOD) use exit_buffer.
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

  const effective = resolveEffectivePrices({
    ltp,
    hasRealBidAsk: false,
    askBuffer: 0,
    bidBuffer: 0,
  });

  const basePrice = side === 'BUY' ? effective.effectiveBid : effective.effectiveAsk;
  const bufferVal = side === 'BUY' ? (bidBufferPct ?? exitBufferPct) : exitBufferPct;

  const setting = {
    entry_buffer: bufferVal,
    exit_buffer: bufferVal,
    exit_price_mode: 'BID_ASK' as const,
  };

  const rawExitPrice = calculateBufferedPrice({
    side: side === 'BUY' ? 'SELL' : 'BUY',
    isExit: true,
    basePrice,
    buySetting: setting,
    sellSetting: setting,
  });

  return Math.round(rawExitPrice * factor) / factor;
}
