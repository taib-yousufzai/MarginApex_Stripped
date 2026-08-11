import { useState, useEffect, useCallback } from 'react';

export interface BinanceQuote {
  symbol: string;
  lastPrice: number;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  timestamp: number;
}

/**
 * Fetches Binance ticker data directly from Binance REST API
 * Updates every 1 second for crypto symbols
 */
export function useBinanceQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, BinanceQuote>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQuotes = useCallback(async () => {
    if (symbols.length === 0) {
      setQuotes({});
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Build query with all symbols
      const symbolList = symbols
        .filter(s => s && !s.includes(':')) // Only Binance symbols (not Kite format)
        .map(s => {
          // Ensure symbol ends with USDT
          const sym = s.toUpperCase();
          return sym.endsWith('USDT') ? sym : `${sym}USDT`;
        });

      if (symbolList.length === 0) {
        setQuotes({});
        setLoading(false);
        return;
      }

      // Fetch from Binance API
      const promises = symbolList.map(sym =>
        fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`)
          .then(res => res.json())
          .then(data => {
            if (data.code) throw new Error(data.msg);
            return {
              symbol: sym,
              lastPrice: parseFloat(data.lastPrice),
              close: parseFloat(data.prevClosePrice),
              open: parseFloat(data.openPrice),
              high: parseFloat(data.highPrice),
              low: parseFloat(data.lowPrice),
              volume: parseFloat(data.volume),
              timestamp: data.time,
            } as BinanceQuote;
          })
          .catch(err => {
            console.warn(`Failed to fetch ${sym}:`, err);
            return null;
          })
      );

      const results = await Promise.all(promises);
      const quotesMap: Record<string, BinanceQuote> = {};

      results.forEach(quote => {
        if (quote) {
          // Store by full symbol (e.g., BTCUSDT)
          quotesMap[quote.symbol] = quote;
          // Also store by short symbol (e.g., BTC)
          const shortSymbol = quote.symbol.replace('USDT', '');
          quotesMap[shortSymbol] = quote;
        }
      });

      setQuotes(quotesMap);
      setLoading(false);
    } catch (err) {
      console.error('Failed to fetch Binance quotes:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes');
      setLoading(false);
    }
  }, [symbols]);

  // Fetch on mount and every 1 second
  useEffect(() => {
    fetchQuotes();
    const interval = setInterval(fetchQuotes, 1000);
    return () => clearInterval(interval);
  }, [fetchQuotes]);

  return { quotes, loading, error };
}
