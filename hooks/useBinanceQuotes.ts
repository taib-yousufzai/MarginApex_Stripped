import { useState, useEffect, useCallback } from 'react';

export interface BinanceQuote {
  symbol: string;
  lastPrice: number;
  prevClosePrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  time: number;
  bid: number;
  ask: number;
}

/**
 * Fetches Binance ticker data via our API endpoint
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
      setError(null);

      // Filter out non-Binance symbols (Kite format)
      const symbolList = symbols
        .filter(s => s && !s.includes(':'))
        .filter((v, i, a) => a.indexOf(v) === i); // unique

      if (symbolList.length === 0) {
        setQuotes({});
        setLoading(false);
        return;
      }

      // Call our API endpoint
      const queryString = new URLSearchParams({ symbols: symbolList.join(',') }).toString();
      const res = await fetch(`/api/binance/quotes?${queryString}`);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const result = await res.json();

      if (result.success && result.data) {
        setQuotes(result.data);
      } else {
        throw new Error(result.error || 'Unknown error');
      }

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
