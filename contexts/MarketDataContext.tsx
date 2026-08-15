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
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  lastError: string | null;
  reconnectCount: number;
};

const MarketDataContext = createContext<MarketDataContextType>({
  quotes: {},
  subscribe: () => {},
  unsubscribe: () => {},
  connectionStatus: 'disconnected',
  lastError: null,
  reconnectCount: 0,
});

// Singleton manager
class MarketWSManager {
  private ws: WebSocket | null = null;
  private binanceWs: WebSocket | null = null;
  private listeners: Set<(type: string, data: any) => void> = new Set();
  public symbolRefCount: Map<string, number> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;

  public connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  public lastError: string | null = null;
  public reconnectCount = 0;

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  public lastMessageReceivedTime = 0;

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
      
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          lastHiddenTime = Date.now();
        } else if (document.visibilityState === 'visible') {
          console.log('[MarketWSManager] Visibility visible. Checking connection status...');
          const elapsed = lastHiddenTime > 0 ? Date.now() - lastHiddenTime : 0;
          
          if (elapsed > 5000) {
            console.log(`[MarketWSManager] Tab hidden for ${elapsed}ms. Proactively recycling socket for iOS resilience.`);
            this.disconnectCleanly();
            if (this.symbolRefCount.size > 0) {
              this.connect();
            }
          } else if (!this.ws || (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)) {
            if (this.symbolRefCount.size > 0) {
              this.connect();
            }
          }
          lastHiddenTime = 0;
        };
      };

      const handleWake = () => {
        console.log('[MarketWSManager] Lifecycle wake/focus event. Verifying socket health...');
        if (!this.ws || (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)) {
          if (this.symbolRefCount.size > 0) {
            this.connect();
          }
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('pageshow', handleWake);
      window.addEventListener('focus', handleWake);
      window.addEventListener('online', () => {
        console.log('[MarketWSManager] Device online event detected.');
        if ((!this.ws || this.ws.readyState !== WebSocket.OPEN) && this.symbolRefCount.size > 0) {
          this.connect();
        }
      });
    }
  }

  private disconnectCleanly() {
    this.stopHeartbeat();
    if (this.ws) {
      console.log('[MarketWSManager] Disconnecting current WebSocket cleanly...');
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (e) {
        console.error('[MarketWSManager] error closing ws:', e);
      }
      this.ws = null;
    }
    if (this.binanceWs) {
      this.binanceWs.onopen = null;
      this.binanceWs.onmessage = null;
      this.binanceWs.onerror = null;
      this.binanceWs.onclose = null;
      try { this.binanceWs.close(); } catch {}
      this.binanceWs = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private connectBinance() {
    if (typeof window === 'undefined') return;
    const cryptoSymbols: string[] = [];
    const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'];
    for (const sym of Array.from(this.symbolRefCount.keys())) {
      const upper = sym.toUpperCase().replace(/^CRYPTO:/, '').trim();
      if (upper.endsWith('USDT')) {
        cryptoSymbols.push(upper);
      } else if (CRYPTO_BASES.includes(upper)) {
        cryptoSymbols.push(`${upper}USDT`);
      }
    }

    const uniqueStreams = Array.from(new Set(cryptoSymbols)).map(s => `${s.toLowerCase()}@ticker`);
    if (uniqueStreams.length === 0) return;

    if (this.binanceWs && (this.binanceWs.readyState === WebSocket.CONNECTING || this.binanceWs.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      const wsUrl = `wss://stream.binance.com:9443/stream?streams=${uniqueStreams.join('/')}`;
      console.log('[MarketWSManager] Connecting direct Binance WS stream:', wsUrl);
      const bws = new WebSocket(wsUrl);
      this.binanceWs = bws;

      bws.onmessage = (event) => {
        this.lastMessageReceivedTime = Date.now();
        try {
          const payload = JSON.parse(event.data);
          const data = payload?.data;
          if (data && data.s) {
            const symUpper = data.s.toUpperCase();
            const lp = parseFloat(data.c || '0');
            const bp = parseFloat(data.b || data.c || '0');
            const ap = parseFloat(data.a || data.c || '0');
            const close = parseFloat(data.x || data.o || '0');

            const quoteObj = {
              timestamp: new Date(data.E || Date.now()).toISOString(),
              last_price: lp,
              volume: parseFloat(data.v || '0'),
              ohlc: {
                open: parseFloat(data.o || '0'),
                high: parseFloat(data.h || '0'),
                low: parseFloat(data.l || '0'),
                close,
              },
              net_change: lp - close,
              bid: bp,
              ask: ap,
            };

            const shortSymbol = symUpper.replace('USDT', '');
            this.notifyListeners('update', { symbol: symUpper, quote: quoteObj });
            this.notifyListeners('update', { symbol: shortSymbol, quote: quoteObj });
            this.notifyListeners('update', { symbol: `CRYPTO:${shortSymbol}`, quote: quoteObj });
          }
        } catch (e) {
          console.error('[MarketWSManager] Binance WS parse error:', e);
        }
      };

      bws.onerror = (err) => {
        console.warn('[MarketWSManager] Binance WS error:', err);
      };
    } catch (e) {
      console.error('[MarketWSManager] Error creating Binance WS:', e);
    }
  }

  private connect() {
    if (this.symbolRefCount.size === 0) return;

    this.connectBinance();
    
    // Prevent overlapping connection attempts
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.disconnectCleanly();

    this.connectionStatus = this.reconnectCount > 0 ? 'reconnecting' : 'connecting';
    this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });

    console.log(`[MarketWSManager] Connecting to ${this.wsUrl} (attempt #${this.reconnectCount + 1})...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        console.log('[MarketWSManager] WebSocket connection established successfully.');
        this.reconnectCount = 0;
        this.connectionStatus = 'connected';
        this.lastError = null;
        this.lastMessageReceivedTime = Date.now();
        this.notifyListeners('status', { status: this.connectionStatus, error: null, reconnectCount: 0 });

        const activeSymbols = Array.from(this.symbolRefCount.keys());
        if (activeSymbols.length > 0) {
          console.log('[MarketWSManager] Re-subscribing to instruments:', activeSymbols);
          this.ws?.send(JSON.stringify({ action: 'subscribe', symbols: activeSymbols }));
        }
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.lastMessageReceivedTime = Date.now();
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'quotes') {
            this.notifyListeners('quotes', payload.data);
          } else if (payload.type === 'update') {
            this.notifyListeners('update', { symbol: payload.symbol, quote: payload.data });
          } else if (payload.type === 'pong') {
            // Heartbeat response handled
          }
        } catch (err) {
          console.error('[MarketWSManager] error parsing message:', err);
        }
      };

      this.ws.onclose = () => {
        console.warn('[MarketWSManager] WebSocket connection closed.');
        this.connectionStatus = 'disconnected';
        this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = (e) => {
        console.warn('[MarketWSManager] WebSocket connection warning:', e);
        this.lastError = 'WebSocket connection failed';
        this.connectionStatus = 'disconnected';
        this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
      };
    } catch (err: any) {
      console.error('[MarketWSManager] Error during WebSocket instantiation:', err);
      this.lastError = err?.message || 'WebSocket creation failed';
      this.connectionStatus = 'disconnected';
      this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.symbolRefCount.size === 0) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

    this.reconnectCount++;
    // Exponential backoff with jitter, caps at 10s
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectCount) + Math.random() * 1000, 10000);
    console.log(`[MarketWSManager] Reconnecting in ${delay.toFixed(0)}ms...`);
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastMessageReceivedTime = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Send heartbeat ping frame to keep proxy/gate alive and test writeability
          this.ws.send(JSON.stringify({ action: 'ping' }));
        } catch (err) {
          console.warn('[MarketWSManager] ping send failed. Reconnecting.', err);
          this.connect();
          return;
        }

        // If no message has been received for 15 seconds, assume half-open/dormant socket
        if (Date.now() - this.lastMessageReceivedTime > 15000) {
          console.warn('[MarketWSManager] No tick or heartbeat received for 15s. Reconnecting.');
          this.connect();
        }
      }
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private notifyListeners(type: string, data: any) {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        console.error('[MarketWSManager] error in listener invocation:', err);
      }
    }
  }

  public addListener(listener: (type: string, data: any) => void) {
    this.listeners.add(listener);
  }

  public removeListener(listener: (type: string, data: any) => void) {
    this.listeners.delete(listener);
  }

  public subscribe(symbols: string[]) {
    const toSubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      this.symbolRefCount.set(sym, count + 1);
      if (count === 0) toSubscribe.push(sym);
    }
    
    this.connect();
    
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
      this.disconnectCleanly();
    }
  }

  public get isConnectingOrOpen(): boolean {
    return this.ws !== null && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN);
  }
}

const wsManager = new MarketWSManager();

/**
 * Single authoritative quote normalizer.
 *
 * Problem: Kite WebSocket ticks carry `bid`/`ask` that are sourced from market
 * depth (best buy/sell price). For deep OTM options the bid side can be near
 * zero (e.g. ₹360) while the last traded price is ₹5,339 — producing a
 * catastrophically wrong displayed spread.
 *
 * Rule: if the raw bid or ask deviates from lastPrice by more than 50 %, it is
 * unreliable depth data. Fall back to a tight synthetic ±0.05 % spread.
 * This threshold is wide enough to cover legitimate wide spreads on illiquid
 * instruments while catching the pathological OTM-option case.
 */
function normalizeQuote(q: any): QuoteData {
  const close = q.ohlc?.close || q.close || 0;
  let lastPrice = Number(q.last_price || close || 0);

  // Clamp lastPrice to [bid, ask] only when both look reasonable
  const rawBid = Number(q.bid ?? 0);
  const rawAsk = Number(q.ask ?? 0);

  // Sanity-check: depth-derived bid/ask must be within 50 % of lastPrice
  const maxDeviation = 0.50;
  const bidOk = rawBid > 0 && lastPrice > 0 && Math.abs(rawBid - lastPrice) / lastPrice <= maxDeviation;
  const askOk = rawAsk > 0 && lastPrice > 0 && Math.abs(rawAsk - lastPrice) / lastPrice <= maxDeviation;
  const spreadOk = bidOk && askOk && rawBid < rawAsk;

  if (spreadOk) {
    // Keep lastPrice inside [bid, ask]
    if (lastPrice > rawAsk) lastPrice = rawAsk;
    if (lastPrice < rawBid) lastPrice = rawBid;
  }

  const changePercent = close > 0 ? ((lastPrice - close) / close) * 100 : 0;

  return {
    lastPrice: parseFloat(Number(lastPrice).toFixed(8)),
    change: lastPrice - close,
    changePercent: parseFloat(changePercent.toFixed(2)),
    open: q.ohlc?.open || q.open || 0,
    high: q.ohlc?.high || q.high || 0,
    low: q.ohlc?.low || q.low || 0,
    close,
    volume: q.volume || 0,
    // Use real bid/ask only when the sanity check passes; otherwise synthesise
    bid: spreadOk ? rawBid : lastPrice * 0.9995,
    ask: spreadOk ? rawAsk : lastPrice * 1.0005,
  };
}

export const MarketDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const [statusInfo, setStatusInfo] = useState({
    connectionStatus: wsManager.connectionStatus,
    lastError: wsManager.lastError,
    reconnectCount: wsManager.reconnectCount
  });
  
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
      if (type === 'status') {
        setStatusInfo({
          connectionStatus: data.status,
          lastError: data.error,
          reconnectCount: data.reconnectCount
        });
      } else if (type === 'quotes') {
        const mapped: Record<string, QuoteData> = {};
        for (const [key, quote] of Object.entries(data)) {
          mapped[key] = normalizeQuote(quote as any);
        }
        Object.assign(pendingUpdatesRef.current, mapped);
      } else if (type === 'update') {
        const { symbol, quote: q } = data;
        pendingUpdatesRef.current[symbol] = normalizeQuote(q);
      }
    };

    wsManager.addListener(onMessage);

    const fetchInitialQuotes = async () => {
      // Only skip HTTP fallback if WebSocket is connected AND ticks are actively flowing (< 3s ago)
      const ticksAreFlowing = wsManager.connectionStatus === 'connected' && (Date.now() - wsManager.lastMessageReceivedTime < 3000);
      if (ticksAreFlowing) return;
      const symbols = Array.from(wsManager.symbolRefCount.keys());
      if (symbols.length === 0) return;
      
      try {
        // Fallback 1: Local Next.js API route (bypasses iOS Safari / iCloud Private Relay CORS blocks)
        const res = await fetch('/api/kite/quotes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ instruments: symbols })
        });
        if (res.ok) {
          const json = await res.json();
          if (json.data && Object.keys(json.data).length > 0) {
            onMessage('quotes', json.data);
            return;
          }
        }
      } catch (err) {
        console.warn('[MarketDataProvider] Local HTTP fallback failed, trying direct ticker daemon:', err);
      }

      // Fallback 2: Direct query to Railway ticker daemon (original path)
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
        console.error('[MarketDataProvider] Direct HTTP fallback error:', err);
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
      if (wsManager.connectionStatus !== 'connected') {
        fetchInitialQuotesRef.current?.();
      }
    }
  }, []);

  const unsubscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) wsManager.unsubscribe(validSymbols);
  }, []);

  return (
    <MarketDataContext.Provider value={{
      quotes,
      subscribe,
      unsubscribe,
      connectionStatus: statusInfo.connectionStatus,
      lastError: statusInfo.lastError,
      reconnectCount: statusInfo.reconnectCount
    }}>
      {children}
    </MarketDataContext.Provider>
  );
};

export const useGlobalMarketQuotes = () => useContext(MarketDataContext);

