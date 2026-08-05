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
  const {
    quotes,
    subscribe,
    unsubscribe,
    connectionStatus,
    lastError,
    reconnectCount
  } = useGlobalMarketQuotes();
  
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

  // We are loading if we have symbols but haven't received quotes for them yet,
  // AND the connection is either connecting or has not exhausted its reconnect attempts
  const isLoading = symbols.length > 0 &&
                    Object.keys(localQuotes).length === 0 &&
                    (connectionStatus === 'connecting' || connectionStatus === 'reconnecting' || reconnectCount < 3);

  // We are unreachable only if multiple reconnect attempts have failed, we have no quotes,
  // and we are not in the process of a successful connection.
  const isUnreachable = symbols.length > 0 &&
                        Object.keys(localQuotes).length === 0 &&
                        connectionStatus !== 'connected' &&
                        reconnectCount >= 3;

  return {
    quotes: localQuotes,
    isLoading,
    isUnreachable,
    connectionStatus,
    lastError,
    reconnectCount
  };
}
