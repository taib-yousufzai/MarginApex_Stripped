type LibrarySymbolInfo = any;
type ResolutionString = any;

export function isForexSymbol(symbolName: string): boolean {
  if (!symbolName) return false;
  const upper = symbolName.toUpperCase().trim();
  if (upper.startsWith('FOREX:')) return true;
  const clean = upper.includes(':') ? upper.split(':')[1] : upper;
  const FOREX_PAIRS = ['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];
  return FOREX_PAIRS.includes(clean);
}

/**
 * Derives the exchange name from a Kite-style exchange-prefixed symbol.
 * Falls back to "NSE" for unrecognised or un-prefixed symbols.
 */
export function deriveExchange(symbolName: string): string {
  const upper = symbolName.toUpperCase();

  if (isForexSymbol(symbolName)) {
    return 'FOREX';
  }

  // Commodity contracts (GOLD, SILVER, CRUDEOIL, NATURALGAS, etc.) are always MCX
  if (
    upper.includes('CRUDE') || upper.includes('GOLD') || 
    upper.includes('SILVER') || upper.includes('NATURALGAS') || 
    upper.includes('NATGAS') || upper.includes('COPPER') || 
    upper.includes('ZINC') || upper.includes('ALUMINIUM') || 
    upper.includes('LEAD')
  ) {
    return 'MCX';
  }

  if (symbolName.startsWith('NSE:')) return 'NSE';
  if (symbolName.startsWith('BSE:')) return 'BSE';
  if (symbolName.startsWith('MCX:')) return 'MCX';
  if (symbolName.startsWith('NCO:')) return 'MCX';
  if (symbolName.startsWith('NFO:')) return 'NFO';
  if (symbolName.startsWith('BFO:')) return 'BFO';
  if (symbolName.startsWith('CDS:')) return 'CDS';

  if (
    upper.includes('EURINR') || upper.includes('USDINR') || 
    upper.includes('GBPINR') || upper.includes('JPYINR')
  ) {
    return 'CDS';
  }

  if (upper.match(/\d+(CE|PE)$/) || upper.match(/(FUT)$/)) {
    if (upper.includes('SENSEX') || upper.includes('BANKEX')) return 'BFO';
    return 'NFO';
  }

  return 'NSE';
}

/**
 * Builds a TradingView `LibrarySymbolInfo` object for the given symbol and segment.
 *
 * - CRYPTO path: symbolName ends with "USDT" OR segment === "CRYPTO" (case-insensitive)
 *   → session "24x7", exchange "BINANCE"
 * - FOREX path: segment === "FOREX" OR isForexSymbol
 *   → session "24x7", exchange "FOREX"
 * - Indian path: all other symbols
 *   → session "0915-1530", exchange derived from kiteSymbol prefix via `deriveExchange`
 */
export function formatShortName(name: string): string {
  // Check for Options (e.g., NIFTY2672124200CE)
  const optMatch = name.match(/^([A-Z]+).*?(\d+)(CE|PE)$/i);
  if (optMatch) {
    return `${optMatch[1]} ${optMatch[2]} ${optMatch[3].toUpperCase()}`;
  }

  // Check for Futures (e.g., NIFTY26JULFUT)
  const futMatch = name.match(/^([A-Z]+).*?(FUT)$/i);
  if (futMatch) {
    return `${futMatch[1]} FUT`;
  }

  // Default fallback
  return name;
}

export function buildSymbolInfo(symbolName: string, segment: string): LibrarySymbolInfo {
  const isForex = segment.toUpperCase() === 'FOREX' || isForexSymbol(symbolName);
  const isCrypto =
    !isForex && (symbolName.endsWith('USDT') || segment.toUpperCase() === 'CRYPTO');

  const colonIdx = symbolName.indexOf(':');
  const rawName = colonIdx >= 0 ? symbolName.slice(colonIdx + 1) : symbolName;
  const name = formatShortName(rawName);
  
  const exchange = isForex ? 'FOREX' : isCrypto ? 'BINANCE' : deriveExchange(symbolName);
  let ticker = (isCrypto || isForex || symbolName.includes(':')) ? symbolName : `${exchange}:${symbolName}`;
  if (exchange === 'MCX' && ticker.startsWith('NFO:')) {
    ticker = `MCX:${ticker.slice(4)}`;
  }
  
  let session = '0915-1530';
  if (isCrypto || isForex) session = '24x7';
  else if (exchange === 'MCX') session = '0900-2355';
  else if (exchange === 'CDS') session = '0900-1700';

  const isJpy = rawName.toUpperCase().includes('JPY');

  return {
    name,
    ticker,
    description: rawName, // Keep the full original name in description
    type: isCrypto ? 'crypto' : isForex ? 'forex' : 'stock',
    exchange,
    listed_exchange: exchange,
    session,
    timezone: 'Asia/Kolkata',
    pricescale: isCrypto ? 100000 : isJpy ? 1000 : isForex ? 100000 : 100,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    intraday_multipliers: ['1', '2', '3', '5', '10', '15', '30', '60'],
    supported_resolutions: ['1', '2', '3', '5', '10', '15', '30', '60', 'D'] as ResolutionString[],
    volume_precision: 2,
    data_status: 'streaming',
    format: 'price',
  };
}

export function getCanonicalSymbol(symbolInfoOrName: any): string {
  if (!symbolInfoOrName) return '';
  if (typeof symbolInfoOrName === 'string') {
    return symbolInfoOrName;
  }
  return symbolInfoOrName.ticker || symbolInfoOrName.name || '';
}

