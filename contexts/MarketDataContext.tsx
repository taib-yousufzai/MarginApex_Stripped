'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

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

type MarketDataContextType = {
  quotes: Record<string, QuoteData>;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
};

const MarketDataContext = createContext<MarketDataContextType>({
  quotes: {},
  subscribe: () => {},
  unsubscribe: () => {},
});

// Singleton manager
class MarketWSManager {
  private ws: WebSocket | null = null;
  private listeners: Set<(type: string, data: any) => void> = new Set();
  public symbolRefCount: Map<string, number> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;

  constructor() {
    let url = process.env.NEXT_PUBLIC_TICKER_WS_URL;
    if (url && url.includes('vercel.app')) url = '';
    if (!url && process.env.NEXT_PUBLIC_TICKER_URL) {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL;
      if (!tickerUrl.includes('vercel.app')) {
        url = tickerUrl.replace(/^http/, 'ws');
      }
    }
    if (!url) {
      url = `wss://marginapexx-production.up.railway.app`;
    }
    this.wsUrl = url;

    if (typeof window !== 'undefined') {
      let lastHiddenTime = 0;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          lastHiddenTime = Date.now();
        } else if (document.visibilityState === 'visible') {
          if (lastHiddenTime > 0 && Date.now() - lastHiddenTime > 10000) {
            if (this.ws) this.ws.close();
            else if (this.symbolRefCount.size > 0) this.connect();
          }
          lastHiddenTime = 0;
        }
      });
      window.addEventListener('online', () => {
        if ((!this.ws || this.ws.readyState !== WebSocket.OPEN) && this.symbolRefCount.size > 0) this.connect();
      });
    }
  }

  private connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      const activeSymbols = Array.from(this.symbolRefCount.keys());
      if (activeSymbols.length > 0) {
        this.ws?.send(JSON.stringify({ action: 'subscribe', symbols: activeSymbols }));
      }
    };
    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'quotes') {
          this.notifyListeners('quotes', payload.data);
        } else if (payload.type === 'update') {
          this.notifyListeners('update', { symbol: payload.symbol, quote: payload.data });
        }
      } catch (err) {
        console.error('[MarketWSManager] error parsing message:', err);
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = (e) => {
      console.error('[MarketWSManager] WebSocket error:', e);
    };
  }

  private scheduleReconnect() {
    if (this.symbolRefCount.size === 0) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
  }

  private notifyListeners(type: string, data: any) {
    for (const listener of this.listeners) listener(type, data);
  }

  public addListener(listener: (type: string, data: any) => void) {
    this.listeners.add(listener);
  }

  public removeListener(listener: (type: string, data: any) => void) {
    this.listeners.delete(listener);
  }

  public subscribe(symbols: string[]) {
    this.connect();
    const toSubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      this.symbolRefCount.set(sym, count + 1);
      if (count === 0) toSubscribe.push(sym);
    }
    if (toSubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', symbols: toSubscribe }));
    }
  }

  public unsubscribe(symbols: string[]) {
    const toUnsubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      if (count <= 1) {
        this.symbolRefCount.delete(sym);
        toUnsubscribe.push(sym);
      } else {
        this.symbolRefCount.set(sym, count - 1);
      }
    }
    if (toUnsubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', symbols: toUnsubscribe }));
    }
    if (this.symbolRefCount.size === 0) {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }
  }
  public get isConnectingOrOpen(): boolean {
    return this.ws !== null;
  }
}

const wsManager = new MarketWSManager();

export const MarketDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const pendingUpdatesRef = useRef<Record<string, QuoteData>>({});
  const fetchInitialQuotesRef = useRef<() => void>(() => {});

  // Periodically flush buffered updates to state at 250ms interval
  useEffect(() => {
    const flushQuotes = () => {
      const pending = pendingUpdatesRef.current;
      if (Object.keys(pending).length > 0) {
        setQuotes(prev => ({ ...prev, ...pending }));
        pendingUpdatesRef.current = {};
      }
    };
    const flushInterval = setInterval(flushQuotes, 250);
    return () => clearInterval(flushInterval);
  }, []);

  useEffect(() => {
    const onMessage = (type: string, data: any) => {
      if (type === 'quotes') {
        const mapped: Record<string, QuoteData> = {};
        for (const [key, quote] of Object.entries(data)) {
          const q = quote as any;
          const close = q.ohlc?.close || q.close || 0;
          let finalPrice = q.last_price || close;
          const bid = Number(q.bid || 0);
          const ask = Number(q.ask || 0);
          if (bid > 0 && ask > 0) {
            if (finalPrice > ask) finalPrice = ask;
            if (finalPrice < bid) finalPrice = bid;
          }
          const changePercent = close > 0 ? ((finalPrice - close) / close) * 100 : 0;
          mapped[key] = {
            lastPrice: parseFloat(Number(finalPrice).toFixed(8)),
            change: finalPrice - close,
            changePercent: parseFloat(changePercent.toFixed(2)),
            open: q.ohlc?.open || q.open || 0,
            high: q.ohlc?.high || q.high || 0,
            low: q.ohlc?.low || q.low || 0,
            close: close,
            volume: q.volume || 0,
            bid: (q.bid != null && q.bid > 0) ? q.bid : finalPrice * 0.9995,
            ask: (q.ask != null && q.ask > 0) ? q.ask : finalPrice * 1.0005,
          };
        }
        Object.assign(pendingUpdatesRef.current, mapped);
      } else if (type === 'update') {
        const { symbol, quote: q } = data;
        const close = q.ohlc?.close || q.close || 0;
        let finalPrice = q.last_price || close;
        const bid = Number(q.bid || 0);
        const ask = Number(q.ask || 0);
        if (bid > 0 && ask > 0) {
          if (finalPrice > ask) finalPrice = ask;
          if (finalPrice < bid) finalPrice = bid;
        }
        const changePercent = close > 0 ? ((finalPrice - close) / close) * 100 : 0;
        const newQuote = {
          lastPrice: parseFloat(Number(finalPrice).toFixed(8)),
          change: finalPrice - close,
          changePercent: parseFloat(changePercent.toFixed(2)),
          open: q.ohlc?.open || q.open || 0,
          high: q.ohlc?.high || q.high || 0,
          low: q.ohlc?.low || q.low || 0,
          close: close,
          volume: q.volume || 0,
          bid: (q.bid != null && q.bid > 0) ? q.bid : finalPrice * 0.9995,
          ask: (q.ask != null && q.ask > 0) ? q.ask : finalPrice * 1.0005,
        };
        pendingUpdatesRef.current[symbol] = newQuote;
      }
    };

    wsManager.addListener(onMessage);



    const fetchInitialQuotes = async () => {
      if (wsManager.isConnectingOrOpen) return;
      const symbols = Array.from(wsManager.symbolRefCount.keys());
      if (symbols.length === 0) return;
      try {
        let baseUrl = process.env.NEXT_PUBLIC_TICKER_URL;
        if (!baseUrl) {
          baseUrl = 'https://marginapexx-production.up.railway.app';
        }
        const res = await fetch(`${baseUrl}/quotes?symbols=${symbols.map(s => encodeURIComponent(s)).join(',')}`);
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.data && Object.keys(json.data).length > 0) {
            onMessage('quotes', json.data);
          }
        }
      } catch (err) {
        console.error('[MarketDataProvider] HTTP fallback error:', err);
      }
    };

    fetchInitialQuotesRef.current = fetchInitialQuotes;
    fetchInitialQuotes();

    const pollInterval = setInterval(fetchInitialQuotes, 3000);

    return () => {
      clearInterval(pollInterval);
      wsManager.removeListener(onMessage);
    };
  }, []);

  const subscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) {
      wsManager.subscribe(validSymbols);
      if (!wsManager.isConnectingOrOpen) {
        fetchInitialQuotesRef.current?.();
      }
    }
  }, []);

  const unsubscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) wsManager.unsubscribe(validSymbols);
  }, []);

  return (
    <MarketDataContext.Provider value={{ quotes, subscribe, unsubscribe }}>
      {children}
    </MarketDataContext.Provider>
  );
};

export const useGlobalMarketQuotes = () => useContext(MarketDataContext);
