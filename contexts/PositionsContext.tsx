'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { api } from '@/lib/api';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { MyPosition } from '@/lib/types/order';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { isContractExpired } from '@/lib/contractExpiry';

export interface EnrichedPosition extends MyPosition {
  current_ltp: number;
  unrealised_pnl: number;
  total_pnl: number;
  pnl_percent: number;
  hold_lock_active: boolean;
  remaining_hold_seconds: number;
  required_hold_seconds: number;
  is_closing?: boolean;
}

export interface PositionsContextType {
  positions: EnrichedPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePositionLocally: (posId: string, updatedFields: Partial<MyPosition>) => void;
  removePositionLocally: (posId: string) => void;
  restorePositionLocally: (posId: string) => void;
  startConversion: (posId: string, newType: string) => void;
  endConversion: (posId: string) => void;
}

const PositionsContext = createContext<PositionsContextType | null>(null);



const mapSegmentToDbSegment = (s: string): string => {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity') return 'NSE-EQ';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  return trimmed;
};

const resolveKitePrefix = (key: string, settlement: string) => {
  let baseKey = key;
  if (baseKey.includes(':')) {
    baseKey = baseKey.split(':').slice(1).join(':'); // Strip existing prefix
  }
  const seg = (settlement || '').toUpperCase();
  let prefix = 'NSE:';
  if (baseKey.startsWith('SENSEX') || baseKey.startsWith('BANKEX')) {
    prefix = 'BFO:';
  } else if (
    seg.includes('MCX') ||
    baseKey.startsWith('CRUDEOIL') ||
    baseKey.startsWith('NATGAS') ||
    baseKey.startsWith('SILVER') ||
    baseKey.startsWith('GOLD') ||
    baseKey.startsWith('COPPER') ||
    baseKey.startsWith('ZINC') ||
    baseKey.startsWith('ALUMINIUM') ||
    baseKey.startsWith('LEAD') ||
    baseKey.startsWith('MENTHAOIL')
  ) {
    prefix = 'MCX:';
  } else if (seg.includes('NCO')) {
    prefix = 'NCO:';
  } else if (
    seg.includes('CDS') ||
    seg.includes('FOREX') ||
    baseKey.startsWith('USDINR') ||
    baseKey.startsWith('EURINR') ||
    baseKey.startsWith('GBPINR') ||
    baseKey.startsWith('JPYINR')
  ) {
    prefix = 'CDS:';
  } else if (seg.includes('BSE') || seg.includes('BFO')) {
    prefix = 'BFO:';
  } else if (seg.includes('OPT') || seg.includes('FUT') || seg.includes('NFO')) {
    prefix = 'NFO:';
  }

  // Catch base indexes
  if (prefix === 'BFO:' && !baseKey.match(/\d/)) prefix = 'BSE:';
  if (prefix === 'NFO:' && !baseKey.match(/\d/)) prefix = 'NSE:';

  return `${prefix}${baseKey}`;
};

export const PositionsDataProvider = ({ children, refreshInterval = 5000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [rawPositions, setRawPositions] = useState<MyPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  // segmentSettings now comes from TradeConfigProvider — no local fetch needed
  const { segmentSettings } = useTradeConfig();
  const optimisticallyRemovedIds = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Static properties map to cache computations that never change per position lifecycle
  const staticPositionPropsRef = useRef<Record<string, { entryTimeMs: number; dbSeg: string; resolvedKiteSymbol: string; isCrypto: boolean; isComex: boolean; binanceSymbol: string }>>({});

  const updatePositionLocally = useCallback((posId: string, updatedFields: Partial<MyPosition>) => {
    setRawPositions(prev =>
      prev.map(p => (p.id === posId ? { ...p, ...updatedFields } : p))
    );
  }, []);

  const removePositionLocally = useCallback((posId: string) => {
    optimisticallyRemovedIds.current.add(posId);
    setRawPositions(prev => prev.filter(p => p.id !== posId));
  }, []);

  const restorePositionLocally = useCallback((posId: string) => {
    optimisticallyRemovedIds.current.delete(posId);
    fetchPositions();
  }, []);

  const startConversion = useCallback((posId: string, newType: string) => {
    setInFlightConversions(prev => ({ ...prev, [posId]: newType }));
  }, []);

  const endConversion = useCallback((posId: string) => {
    setInFlightConversions(prev => {
      const next = { ...prev };
      delete next[posId];
      return next;
    });
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      // Don't fetch if there's no active session (e.g. on the login page)
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const data = await api.get<{ positions: MyPosition[] }>('/api/positions', {
        signal: controller.signal,
      });

      // The DB is the single source of truth. Apply the server snapshot directly.
      // Filter out any IDs that are still in the optimistic-removal set (exit in flight).
      let newPositions: MyPosition[] = (data.positions || []).filter(
        p => !optimisticallyRemovedIds.current.has(p.id)
      );

      // Evict stale optimistic removals: if the server no longer returns the position
      // it was already closed — clear the set so future fetches stay clean.
      const serverIds = new Set(newPositions.map(p => p.id));
      for (const id of [...optimisticallyRemovedIds.current]) {
        if (!serverIds.has(id)) {
          optimisticallyRemovedIds.current.delete(id);
        }
      }

      // Precompute static properties for any newly loaded positions
      const staticProps = staticPositionPropsRef.current;
      newPositions.forEach(p => {
        if (!staticProps[p.id]) {
          const dbSeg = mapSegmentWithSymbol(p.settlement || '', p.symbol);
          const segUpper = dbSeg.toUpperCase();
          const isCrypto = segUpper.includes('CRYPTO') || !!(p.symbol && p.symbol.endsWith('USDT'));
          const isComex = (p as any).preferredView === 'comex' || segUpper.includes('COMEX');

          let binanceSymbol = '';
          if (isCrypto) {
            binanceSymbol = (p.symbol || '').replace('/', '');
            if (!binanceSymbol.endsWith('USDT')) binanceSymbol += 'USDT';
          }

          staticProps[p.id] = {
            entryTimeMs: new Date(p.entry_time).getTime(),
            dbSeg,
            resolvedKiteSymbol: resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''),
            isCrypto,
            isComex,
            binanceSymbol
          };
        }
      });

      setRawPositions(newPositions);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // One-shot eviction: clear the legacy localStorage cache written by the old code.
    // Existing users may still have stale positions under this key; remove it so they
    // never seed the UI from a ghost snapshot again.
    try { localStorage.removeItem('cached_open_positions'); } catch (_) {}

    fetchPositions();
    let isSubscribed = false;
    const channelName = `my-positions-realtime-${Math.random().toString(36).slice(2)}`;

    const debouncedFetch = (delay = 1500) => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchPositions();
      }, delay);
    };

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          debouncedFetch(500);
        }
      );

    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    const handleOrderPlacedWithData = (_e: Event) => {
      // v2 engine: all position state transitions happen atomically in the DB.
      // Optimistic UI manipulation is not needed and causes incorrect state
      // (e.g. removing unrelated positions, incorrect averaging across multiple lots).
      // A fast DB fetch is sufficient — the real state arrives within ~100ms.
      debouncedFetch(100);
    };

    const handleOrderPlaced = () => {
      debouncedFetch(100);
    };

    const handleOrderFailed = () => {
      optimisticallyRemovedIds.current.clear();
      fetchPositions();
    };
    
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('order_placed_with_data', handleOrderPlacedWithData);
    window.addEventListener('order_failed', handleOrderFailed);

    const timer = setInterval(() => {
      if (!isSubscribed) fetchPositions();
    }, 15000);

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('order_placed_with_data', handleOrderPlacedWithData);
      window.removeEventListener('order_failed', handleOrderFailed);
    };
  }, [fetchPositions]);

  const { kiteKeys, binanceKeys, comexKeys } = useMemo(() => {
    const kite: string[] = [];
    const binance: string[] = [];
    const comex: string[] = [];
    const props = staticPositionPropsRef.current;

    rawPositions.filter(p => p.status === 'open' || p.status === 'active').forEach(p => {
      const cached = props[p.id];
      if (cached) {
        if (cached.isCrypto) {
          binance.push(cached.binanceSymbol);
        } else if (cached.isComex) {
          comex.push(p.symbol);
        } else {
          kite.push(cached.resolvedKiteSymbol);
        }
      } else {
        const seg = (p.settlement || '').toUpperCase();
        if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
          let sym = (p.symbol || '').replace('/', '');
          if (!sym.endsWith('USDT')) sym += 'USDT';
          binance.push(sym);
        } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
          comex.push(p.symbol);
        } else {
          kite.push(resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''));
        }
      }
    });

    return { kiteKeys: kite, binanceKeys: binance, comexKeys: comex };
  }, [rawPositions]);

  const marketSymbols = useMemo(() => [...kiteKeys, ...binanceKeys], [kiteKeys, binanceKeys]);
  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexKeys, refreshInterval);

  const enrichedPositions = useMemo(() => {
    const settingsMap = new Map<string, any>();
    for (const s of segmentSettings) {
      settingsMap.set(`${s.segment}|${s.side}`, s);
    }

    const props = staticPositionPropsRef.current;

    return rawPositions.map(p => {
      const product_type = inFlightConversions[p.id] || p.product_type;
      let ltp = p.ltp || p.entry_price;
      let bid = ltp;
      let ask = ltp;

      const cached = props[p.id];
      const dbSeg = cached ? cached.dbSeg : mapSegmentWithSymbol(p.settlement || '', p.symbol);
      const isCrypto = cached ? cached.isCrypto : (p.settlement || '').toUpperCase().includes('CRYPTO');
      const isComex = cached ? cached.isComex : (p.settlement || '').toUpperCase().includes('COMEX');
      const entryTimeMs = cached ? cached.entryTimeMs : new Date(p.entry_time).getTime();

      const avgPrice = p.avg_price || p.entry_price;
      const contractExpired = isContractExpired(p.kite_instrument || p.symbol);

      if (!contractExpired) {
        if (isCrypto) {
          const binanceKey = cached ? cached.binanceSymbol : (p.symbol || '').replace('/', '') + (p.symbol?.endsWith('USDT') ? '' : 'USDT');
          const quote = marketQuotes[binanceKey];
          if (quote) {
            ltp = quote.lastPrice ?? ltp;
            bid = quote.bid ?? ltp;
            ask = quote.ask ?? ltp;
          }
        } else if (isComex) {
          const quote = comexQuotes[p.symbol];
          if (quote) {
            ltp = quote.lastPrice ?? ltp;
            bid = quote.bid ?? ltp;
            ask = quote.ask ?? ltp;
          }
        } else {
          const kiteKey = cached ? cached.resolvedKiteSymbol : resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || '');
          const quote = marketQuotes[kiteKey];
          if (quote) {
            ltp = quote.lastPrice ?? ltp;
            bid = quote.bid ?? ltp;
            ask = quote.ask ?? ltp;
          }
        }
      }

      const sideSetting = settingsMap.get(`${dbSeg}|${p.side}`);
      let unrealised = 0;
      if ((p.status === 'open' || p.status === 'active') && p.qty_open !== 0) {
        const exitBufferPct = sideSetting?.exit_buffer != null ? Number(sideSetting.exit_buffer) : 0.17;
        const exitBuffer = exitBufferPct / 100;
        if (p.side === 'BUY') {
          // BUY position exits via SELL order at BID.
          // exitPrice = bid * (1 - exitBuffer)
          const exitPrice = Math.round(bid * (1 - exitBuffer) * 100) / 100;
          unrealised = (exitPrice - avgPrice) * p.qty_open;
        } else {
          // SELL position exits via BUY order at ASK.
          // exitPrice = ask * (1 + exitBuffer)
          const exitPrice = Math.round(ask * (1 + exitBuffer) * 100) / 100;
          unrealised = (avgPrice - exitPrice) * p.qty_open;
        }
      }

      const total_pnl = (p.status === 'closed') ? p.pnl : unrealised;
      const investment = avgPrice * p.qty_open;
      const pnl_percent = investment > 0 ? (total_pnl / investment) * 100 : 0;

      const profitHoldSec = sideSetting ? Number(sideSetting.profit_hold_sec) : 120;
      const elapsedSec = Math.floor((Date.now() - entryTimeMs) / 1000);

      const isInProfit = unrealised > 0;
      // Lock when in profit and within hold window.
      // When segmentSettings haven't loaded yet (segmentSettingsLoaded = false) we
      // still apply the lock using the 120s default — this prevents a flash of
      // "exit allowed" on first render while settings are still fetching.
      const isLocked = !contractExpired
        && (p.status === 'open' || p.status === 'active')
        && elapsedSec < profitHoldSec
        && isInProfit;
      const remainingSec = isLocked ? (profitHoldSec - elapsedSec) : 0;

      return {
        ...p,
        product_type,
        current_ltp: ltp,
        unrealised_pnl: (p.status === 'closed') ? 0 : unrealised,
        total_pnl,
        pnl_percent: parseFloat(pnl_percent.toFixed(2)),
        hold_lock_active: isLocked,
        remaining_hold_seconds: remainingSec,
        required_hold_seconds: profitHoldSec
      } as EnrichedPosition;
    });
  }, [
    rawPositions,
    marketQuotes,
    comexQuotes,
    segmentSettings,
    inFlightConversions
  ]);

  return (
    <PositionsContext.Provider value={{
      positions: enrichedPositions,
      loading,
      error,
      refresh: fetchPositions,
      updatePositionLocally,
      removePositionLocally,
      restorePositionLocally,
      startConversion,
      endConversion
    }}>
      {children}
    </PositionsContext.Provider>
  );
};

export const usePositionsData = () => {
  const context = useContext(PositionsContext);
  if (!context) {
    throw new Error('usePositionsData must be used within a PositionsDataProvider');
  }
  return context;
};
