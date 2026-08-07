import { parseOptionSymbol } from '../../lib/positionStore';

export class OrderService {
  /**
   * Validates Limit price constraints relative to LTP
   */
  static validateLimitPrice(orderType: string, side: 'BUY' | 'SELL', clientPrice: number, baseLtp: number, isExit: boolean): string | null {
    if (orderType === 'LIMIT') {
      if (side === 'BUY' && clientPrice > baseLtp) {
        return 'Limit price must be lower than or equal to the current market price (LTP) for Buy orders.';
      }
      if (side === 'SELL' && clientPrice < baseLtp) {
        return 'Limit price must be higher than or equal to the current market price (LTP) for Sell orders.';
      }
    } else if (orderType === 'GTT' && !isExit) {
      if (side === 'BUY' && clientPrice > baseLtp) {
        return 'Trigger price must be lower than or equal to the current market price (LTP).';
      }
      if (side === 'SELL' && clientPrice < baseLtp) {
        return 'Trigger price must be higher than or equal to the current market price (LTP).';
      }
    }
    return null;
  }

  /**
   * Validates SL and SLM trigger price constraints relative to LTP
   */
  static validateStopLoss(orderType: string, side: 'BUY' | 'SELL', triggerPrice: number | null, baseLtp: number, isExit: boolean): string | null {
    if ((orderType === 'SL' || orderType === 'SLM') && triggerPrice !== null && !isNaN(triggerPrice)) {
      if (isExit) {
        if (side === 'BUY' && triggerPrice <= baseLtp) {
          return 'Stop loss trigger price must be above the current market price for short exits.';
        }
        if (side === 'SELL' && triggerPrice >= baseLtp) {
          return 'Stop loss trigger price must be below the current market price for long exits.';
        }
      } else {
        // Entry orders
        if (side === 'BUY' && triggerPrice <= baseLtp) {
          return 'Stop entry trigger price must be above the current market price for long entries.';
        }
        if (side === 'SELL' && triggerPrice >= baseLtp) {
          return 'Stop entry trigger price must be below the current market price for short entries.';
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
   * Enforce Anti-Scalping hold duration for manual market exits
   */
  static validateHoldDuration(
    isExit: boolean,
    orderType: string,
    activePosition: any,
    baseLtp: number,
    profitHoldSec: number,
    lossHoldSec: number
  ): string | null {
    if (isExit && activePosition && activePosition.entry_time && (orderType === 'MARKET' || orderType === 'SLM')) {
      const entryPrice = Number(activePosition.avg_price || activePosition.entry_price || 0);
      const pnlValue = activePosition.side === 'BUY'
        ? (baseLtp - entryPrice) * Number(activePosition.qty_open)
        : (entryPrice - baseLtp) * Number(activePosition.qty_open);

      const durationSec = Math.floor((Date.now() - new Date(activePosition.entry_time).getTime()) / 1000);

      // Anti-scalping hold time only applies to profitable trades. Exiting in a loss is always allowed.
      if (pnlValue <= 0) {
        return null;
      }

      const requiredHold = profitHoldSec;

      if (durationSec < requiredHold) {
        return `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`;
      }
    }
    return null;
  }
}
