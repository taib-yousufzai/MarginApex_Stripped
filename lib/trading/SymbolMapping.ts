export function mapSegmentToDbSegment(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (['NSE - Futures', 'BSE - Futures', 'NFO - Futures', 'BFO - Futures'].includes(trimmed)) return 'INDEX-FUT';
  if (['NSE - Options', 'BSE - Options', 'NFO - Options', 'BFO - Options'].includes(trimmed)) return 'INDEX-OPT';
  if (['NSE - Stock Futures', 'BSE - Stock Futures', 'NFO - Stock Futures', 'BFO - Stock Futures'].includes(trimmed)) return 'STOCK-FUT';
  if (['NSE - Stock Options', 'BSE - Stock Options', 'NFO - Stock Options', 'BFO - Stock Options'].includes(trimmed)) return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures' || trimmed === 'MCX-FUT' || trimmed === 'MCX') return 'MCX-FUT';
  if (trimmed === 'MCX - Options' || trimmed === 'MCX-OPT') return 'MCX-OPT';
  if (['NSE - Equity', 'NSE-EQ'].includes(trimmed)) return 'NSE-EQ';
  if (['BSE - Equity', 'BSE-EQ', 'BSE'].includes(trimmed)) return 'BSE-EQ';
  return trimmed;
}

export function mapSymbolToSegment(symbol: string): string {
  const n = symbol.toUpperCase();
  if (n.includes('GOLD') || n.includes('SILVER') || n.includes('CRUDE') || n.includes('NATGAS') || n.includes('NATURALGAS')) {
    if (n.includes('CE') || n.includes('PE')) return 'MCX-OPT';
    return 'MCX-FUT';
  }
  if (n.includes('FUT') || n.includes('FUTURES')) {
    if (n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP')) {
      return 'INDEX-FUT';
    }
    return 'STOCK-FUT';
  }
  if (n.includes('CE') || n.includes('PE')) {
    if (n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP')) {
      return 'INDEX-OPT';
    }
    return 'STOCK-OPT';
  }
  return 'NSE-EQ';
}
