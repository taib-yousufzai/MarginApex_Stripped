export interface MarketHours {
  start_time: string;
  end_time: string;
  is_active: boolean;
}

export class RiskValidation {
  /**
   * Validate if the user is allowed to trade the requested segment.
   * Note: If allowedSegments is empty, it implies all segments are allowed (default permissive).
   */
  static validateSegment(allowedSegments: string[], requestedSegment: string): boolean {
    if (allowedSegments && allowedSegments.length > 0 && !allowedSegments.includes(requestedSegment)) {
      return false;
    }
    return true;
  }

  /**
   * Validate if the requested quantity matches the lot size multiple.
   * For lotSize === 1 (equity, fractional crypto), decimals are allowed.
   */
  static validateLotSize(qty: number, lotSize: number): boolean {
    if (lotSize <= 0) return false;
    if (lotSize === 1) return qty > 0; // allow fractional qty for equity / crypto
    return Math.round(qty * 1000) % Math.round(lotSize * 1000) === 0;
  }

  /**
   * Validate if the requested quantity exceeds the maximum freeze quantity.
   */
  static validateFreezeQuantity(qty: number, freezeQuantity: number): boolean {
    if (freezeQuantity > 0 && qty > freezeQuantity) {
      return false;
    }
    return true;
  }

  /**
   * Validate if the market is currently open for the segment.
   * Handles overnight sessions correctly (e.g. 22:00 to 02:00).
   */
  static validateTradingHours(marketHours: MarketHours | null | undefined): boolean {
    if (!marketHours) return false; // No hours row = market is closed (fail-closed for safety)
    if (!marketHours.is_active) return false;

    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentMins = nowIST.getHours() * 60 + nowIST.getMinutes();
    
    const [startH, startM] = (marketHours.start_time || '').split(':').map(Number);
    const [endH, endM] = (marketHours.end_time || '').split(':').map(Number);

    if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) {
      console.warn('[validateTradingHours] Invalid trading hours config:', marketHours);
      return false; // Fail closed if DB config is broken
    }

    const startMins = startH * 60 + startM;
    const endMins = endH * 60 + endM;

    if (startMins === endMins) {
      // Treat equal start/end as "no trading session" unless you want 24x7.
      return false;
    }

    if (startMins < endMins) {
      // Standard daytime session (e.g. 09:15 to 15:30)
      if (currentMins < startMins || currentMins >= endMins) return false;
    } else {
      // Overnight session (e.g. 22:00 to 02:00)
      // It is CLOSED if the current time is after the end time AND before the start time
      if (currentMins >= endMins && currentMins < startMins) return false;
    }

    return true;
  }

  /**
   * Validates if there's enough free margin for the required margin.
   */
  static validateMargin(freeMargin: number, requiredMargin: number): boolean {
    return freeMargin >= requiredMargin;
  }

  /**
   * Validates if the maximum lot limit for the user has been exceeded.
   */
  static validateMaxLotLimit(totalLotsAfterOrder: number, maxLotLimit: number): boolean {
    if (maxLotLimit > 0 && totalLotsAfterOrder > maxLotLimit) {
      return false;
    }
    return true;
  }
}
