import { useEffect, useMemo } from 'react';
import { useGlobalMarketQuotes } from '@/contexts/MarketDataContext';
import { isContractExpired } from '@/lib/contractExpiry';

export interface QuoteData {
  lastPrice: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
}

export function useMarketQuotes(symbols: string[]) {
  const { quotes, subscribe, unsubscribe } = useGlobalMarketQuotes();
  const symbolsKey = symbols.join(',');

  useEffect(() => {
    const currentSymbols = symbolsKey.split(',').filter(Boolean);
    if (currentSymbols.length === 0) return;

    subscribe(currentSymbols);
    return () => {
      unsubscribe(currentSymbols);
    };
  }, [symbolsKey, subscribe, unsubscribe]);

  const localQuotes = useMemo(() => {
    const res: Record<string, QuoteData> = {};
    symbols.forEach(s => {
      if (quotes[s]) res[s] = quotes[s];
    });
    return res;
  }, [quotes, symbolsKey]);

  const isLoading = symbols.length > 0 && Object.keys(localQuotes).length === 0;

  return { quotes: localQuotes, isLoading };
}
