export class SymbolNormalizer {
  /**
   * Normalizes a crypto symbol into the standard format used by the database (e.g. BTCUSDT)
   * Ensures that `positions`, `script_settings`, and `user_blocked_scripts` can match reliably.
   */
  static normalizeCryptoSymbol(symbol: string): string {
    const symUp = symbol.toUpperCase();
    if (symUp.endsWith('USDT')) {
      return symUp;
    }
    // E.g. BTC -> BTCUSDT
    return `${symUp}USDT`;
  }

  /**
   * Normalizes an Indian equity/derivative symbol to strip the exchange prefix if needed
   * or standardize it for internal queries.
   */
  static normalizeIndianSymbol(symbol: string, dbSegment: string): string {
    // Basic placeholder for future logic (e.g., stripping "NSE:" or "NFO:" for DB storage)
    return symbol.toUpperCase().trim();
  }
}
