import { parseOptionSymbol } from '../../lib/positionStore';

export class OrderService {
  /**
   * Validates Limit price constraints relative to LTP
   */
  static validateLimitPrice(orderType: string, side: 'BUY' | 'SELL', clientPrice: number, baseLtp: number, isExit: boolean): string | null {
    if (orderType === 'LIMIT') {
      if (side === 'BUY' && clientPrice >= baseLtp) {
        return 'Limit price must be lower than the current market price (LTP).';
      }
      if (side === 'SELL' && clientPrice <= baseLtp) {
        return 'Limit price must be higher than the current market price (LTP).';
      }
    } else if (orderType === 'GTT' && !isExit) {
      if (side === 'BUY' && clientPrice > baseLtp) {
        return 'Limit price must be lower than or equal to the current market price (LTP).';
      }
      if (side === 'SELL' && clientPrice < baseLtp) {
        return 'Limit price must be higher than or equal to the current market price (LTP).';
      }
    }
    return null;
  }

  /**
   * Validates SL and SLM trigger price constraints relative to LTP.
   *
   * Exit SL orders: trigger must be on the loss side of LTP (cut the position).
   * Entry SLM orders: trigger is the stop-loss price for the new position, so it
   *   must be on the same loss side as an existing SL would be.
   * Entry SL orders: pending breakout orders — trigger must be above LTP for BUY
   *   (buy the breakout) and below LTP for SELL (sell the breakdown).
   */
  static validateStopLoss(orderType: string, side: 'BUY' | 'SELL', triggerPrice: number | null, baseLtp: number, isExit: boolean): string | null {
    if ((orderType === 'SL' || orderType === 'SLM') && triggerPrice !== null && !isNaN(triggerPrice)) {
      if (isExit) {
        // Exiting a long (SELL stop): trigger must be below LTP
        // Exiting a short (BUY stop): trigger must be above LTP
        if (side === 'BUY' && triggerPrice <= baseLtp) {
          return 'Stop loss trigger price must be above the current market price for short exits.';
        }
        if (side === 'SELL' && triggerPrice >= baseLtp) {
          return 'Stop loss trigger price must be below the current market price for long exits.';
        }
      } else if (orderType === 'SLM') {
        // SLM entry: executes immediately as MARKET, trigger is the SL for the new position.
        // BUY SLM = going long → SL must be below market
        // SELL SLM = going short → SL must be above market
        if (side === 'BUY' && triggerPrice >= baseLtp) {
          return 'Stop loss price must be below the current market price.';
        }
        if (side === 'SELL' && triggerPrice <= baseLtp) {
          return 'Stop loss price must be above the current market price.';
        }
      } else {
        // SL entry: pending breakout order.
        // BUY SL = buy above market (breakout buy)
        // SELL SL = sell below market (breakdown sell)
        if (side === 'BUY' && triggerPrice <= baseLtp) {
          return 'Trigger price must be above the current market price for stop limit buy.';
        }
        if (side === 'SELL' && triggerPrice >= baseLtp) {
          return 'Trigger price must be below the current market price for stop limit sell.';
        }
      }
    }
    return null;
  }

  /**
   * Validates Target and Stop Loss rules on entry and exit.
   */
  static validateTargetAndStopLoss(
    isExit: boolean,
    isLong: boolean,
    orderTarget: number | null,
    orderSL: number | null,
    baseLtp: number,
    clientPrice: number,
    hasLimitPrice: boolean
  ): string | null {
    if (isExit) {
      if (isLong) {
        if (orderTarget !== null && orderTarget <= baseLtp) {
          return `Target price must be above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
        if (orderSL !== null && orderSL >= baseLtp) {
          return `Stop Loss must be strictly below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      } else {
        if (orderTarget !== null && orderTarget >= baseLtp) {
          return `Target price must be below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
        if (orderSL !== null && orderSL <= baseLtp) {
          return `Stop Loss must be strictly above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      }
    } else {
      if (isLong) {
        if (orderSL !== null) {
          if (orderSL >= baseLtp) {
            return `Stop loss price must be below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
          if (hasLimitPrice && orderSL >= clientPrice) {
            return 'Stop loss price must be below the limit price.';
          }
        }
        if (orderTarget !== null && orderTarget < baseLtp) {
          return `Target price must be above or equal to the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      } else {
        if (orderSL !== null) {
          if (orderSL <= baseLtp) {
            return `Stop loss price must be above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
          if (hasLimitPrice && orderSL <= clientPrice) {
            return 'Stop loss price must be above the limit price.';
          }
        }
        if (orderTarget !== null && orderTarget > baseLtp) {
          return `Target price must be below or equal to the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      }
    }
    return null;
  }

  /**
   * Validates Segment Price Limits (top_limit and min_limit)
   */
  static validateSegmentPriceLimits(orderType: string, clientPrice: number, baseLtp: number, topLimitPercent: number, minLimitPercent: number): string | null {
    if (['LIMIT', 'SL', 'GTT'].includes(orderType)) {
      if (topLimitPercent > 0) {
        const maxAllowed = baseLtp * (1 + topLimitPercent / 100);
        if (clientPrice > maxAllowed) {
          return `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`;
        }
      }
      if (minLimitPercent > 0) {
        const minAllowed = baseLtp * (1 - minLimitPercent / 100);
        if (clientPrice < minAllowed) {
          return `Minimum price allowed is ₹${minAllowed.toFixed(2)}`;
        }
      }
    }
    return null;
  }

  /**
   * Validates Strike Range check
   */
  static validateStrikeRange(symbol: string, isOption: boolean, strikeRange: number, underlyingLtp: number | undefined): string | null {
    if (isOption && strikeRange > 0 && underlyingLtp !== undefined) {
      const parsedOption = parseOptionSymbol(symbol);
      const strikePrice = parsedOption ? parsedOption.strike : 0;
      if (strikePrice > 0) {
        const diff = Math.abs(strikePrice - underlyingLtp);
        if (diff > strikeRange) {
          return `Strike price ${strikePrice} is outside the allowed range of ${strikeRange} from spot (${underlyingLtp.toFixed(2)})`;
        }
      }
    }
    return null;
  }

  /**
   * Enforce Anti-Scalping hold duration for manual market exits.
   *
   * P&L is estimated using the buffered exit price (matching what the position
   * would actually realise), consistent with the original order execution logic.
   * Both profit and loss hold times are enforced.
   */
  static validateHoldDuration(
    isExit: boolean,
    orderType: string,
    activePosition: any,
    baseLtp: number,
    profitHoldSec: number,
    lossHoldSec: number,
    exitBuffer?: number
  ): string | null {
    if (isExit && activePosition && activePosition.entry_time && (orderType === 'MARKET' || orderType === 'SLM')) {
      const buf = exitBuffer ?? 0.0017;
      // Estimate the buffered exit price the way the actual execution would compute it
      let estExitPrice: number;
      if (activePosition.side === 'BUY') {
        estExitPrice = (baseLtp * 0.999) * (1 - buf);
      } else {
        estExitPrice = (baseLtp * 1.001) * (1 + buf);
      }
      estExitPrice = Math.round(estExitPrice * 100) / 100;

      const entryPrice = Number(activePosition.avg_price || activePosition.entry_price || 0);
      const pnlValue = activePosition.side === 'BUY'
        ? (estExitPrice - entryPrice) * Number(activePosition.qty_open)
        : (entryPrice - estExitPrice) * Number(activePosition.qty_open);

      const durationSec = Math.floor((Date.now() - new Date(activePosition.entry_time).getTime()) / 1000);
      const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

      if (durationSec < requiredHold) {
        return `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`;
      }
    }
    return null;
  }
}
