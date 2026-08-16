'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

export interface BinanceQuoteData {
  symbol: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  bid: number;
  ask: number;
}

type BinanceDataContextType = {
  quotes: Record<string, BinanceQuoteData>;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
};

const BinanceDataContext = createContext<BinanceDataContextType>({
  quotes: {},
  subscribe: () => {},
  unsubscribe: () => {},
});

const BINANCE_API = 'https://api.binance.com/api/v3/ticker/24hr';

class BinanceWSManager {
  private ws: WebSocket | null = null;
  private listeners: Set<(data: any) => void> = new Set();
  public symbolRefCount: Map<string, number> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private wsUrl = 'wss://stream.binance.com:9443/ws';
  private subscriptionId = 1;

  public get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      const activeSymbols = Array.from(this.symbolRefCount.keys());
      if (activeSymbols.length > 0) {
        const params = activeSymbols.map(s => `${s.toLowerCase()}@ticker`);
        this.ws?.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: this.subscriptionId++ }));
      }
    };
    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const data = payload.data || payload;
        if (data && data.e === '24hrTicker') {
          for (const listener of this.listeners) listener(data);
        }
      } catch (err) {}
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
  }

  public subscribe(symbols: string[], listener?: (data: any) => void) {
    if (listener) this.listeners.add(listener);
    this.connect();
    const toSubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      this.symbolRefCount.set(sym, count + 1);
      if (count === 0) toSubscribe.push(`${sym.toLowerCase()}@ticker`);
    }
    if (toSubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSubscribe, id: this.subscriptionId++ }));
    }
  }

  public unsubscribe(symbols: string[], listener?: (data: any) => void) {
    const toUnsubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      if (count <= 1) {
        this.symbolRefCount.delete(sym);
        toUnsubscribe.push(`${sym.toLowerCase()}@ticker`);
      } else {
        this.symbolRefCount.set(sym, count - 1);
      }
    }
    if (toUnsubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsubscribe, id: this.subscriptionId++ }));
    }
    if (this.symbolRefCount.size === 0) {
      if (listener) this.listeners.delete(listener);
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }
  }
}

const wsManager = new BinanceWSManager();

export const BinanceDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [quotes, setQuotes] = useState<Record<string, BinanceQuoteData>>({});
  const pendingUpdatesRef = useRef<Record<string, BinanceQuoteData>>({});

  useEffect(() => {
    const onMessage = (data: any) => {
      const symbol = data.s;
      pendingUpdatesRef.current[symbol] = {
        symbol,
        lastPrice: parseFloat(data.c),
        change: parseFloat(data.p),
        changePercent: parseFloat(data.P),
        open: parseFloat(data.o),
        high: parseFloat(data.h),
        low: parseFloat(data.l),
        close: parseFloat(data.x),
        volume: parseFloat(data.v),
        quoteVolume: parseFloat(data.q),
        bid: parseFloat(data.c || '0'),
        ask: parseFloat(data.c || '0'),
      };
    };

    wsManager.subscribe([], onMessage);

    const flushInterval = setInterval(() => {
      const pending = pendingUpdatesRef.current;
      if (Object.keys(pending).length > 0) {
        setQuotes(prev => ({ ...prev, ...pending }));
        pendingUpdatesRef.current = {};
      }
    }, 100); // 100ms for ultra-fast crypto rendering

    const fetchInitialQuotes = async () => {
      if (wsManager.isConnected) return;
      
      const symbols = Array.from(wsManager.symbolRefCount.keys());
      if (symbols.length === 0) return;
      try {
        const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
        const res = await fetch(`${BINANCE_API}?symbols=${symbolsParam}`);
        if (res.ok) {
          const data = await res.json();
          const mapped: Record<string, BinanceQuoteData> = {};
          for (const ticker of data) {
            mapped[ticker.symbol] = {
              symbol: ticker.symbol,
              lastPrice: parseFloat(ticker.lastPrice),
              change: parseFloat(ticker.priceChange),
              changePercent: parseFloat(ticker.priceChangePercent),
              open: parseFloat(ticker.openPrice),
              high: parseFloat(ticker.highPrice),
              low: parseFloat(ticker.lowPrice),
              close: parseFloat(ticker.prevClosePrice),
              volume: parseFloat(ticker.volume),
              quoteVolume: parseFloat(ticker.quoteVolume),
              bid: parseFloat(ticker.lastPrice || '0'),
              ask: parseFloat(ticker.lastPrice || '0'),
            };
          }
          setQuotes(prev => ({ ...prev, ...mapped }));
        }
      } catch (err) {}
    };

    const pollInterval = setInterval(fetchInitialQuotes, 10000); // 10s fallback poll

    return () => {
      clearInterval(flushInterval);
      clearInterval(pollInterval);
      wsManager.unsubscribe([], onMessage);
    };
  }, []);

  const subscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) wsManager.subscribe(validSymbols);
  }, []);

  const unsubscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) wsManager.unsubscribe(validSymbols);
  }, []);

  return (
    <BinanceDataContext.Provider value={{ quotes, subscribe, unsubscribe }}>
      {children}
    </BinanceDataContext.Provider>
  );
};

export const useGlobalBinanceQuotes = () => useContext(BinanceDataContext);
