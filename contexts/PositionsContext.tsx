'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { MyPosition } from '@/lib/types/order';
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

let globalPositionsCache: MyPosition[] = [];

if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem('cached_open_positions');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        globalPositionsCache = parsed;
      }
    }
  } catch (e) {}
}

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
  const [rawPositions, setRawPositions] = useState<MyPosition[]>(globalPositionsCache);
  const [loading, setLoading] = useState(globalPositionsCache.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  const [segmentSettings, setSegmentSettings] = useState<any[]>([]);
  const localCacheRef = useRef<MyPosition[]>(globalPositionsCache.slice());
  const optimisticallyRemovedIds = useRef<Set<string>>(new Set());
  const [segmentSettingsLoaded, setSegmentSettingsLoaded] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const processedOptimisticKeys = useRef<Set<string>>(new Set());

  // Static properties map to cache computations that never change per position lifecycle
  const staticPositionPropsRef = useRef<Record<string, { entryTimeMs: number; dbSeg: string; resolvedKiteSymbol: string; isCrypto: boolean; isComex: boolean; binanceSymbol: string }>>({});

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('trading_mode')
          .eq('id', session.user.id)
          .single();
        const mode = profile?.trading_mode || 'normal';
        const res = await fetch(`/api/user/segments?mode=${mode}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const sData = await res.json();
          setSegmentSettings(sData || []);
          setSegmentSettingsLoaded(true);
        }
      } catch (err) {
        console.error('Failed to fetch segment settings in PositionsContext', err);
      }
    });
  }, []);

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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const res = await fetch('/api/positions', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!res.ok) throw new Error('Failed to fetch positions');
      const data = await res.json();
      let newPositions: MyPosition[] = data.positions || [];

      // Client-side reconciliation to prevent duplicate positions flashing during exit
      const posGroups = new Map<string, MyPosition[]>();
      for (const p of newPositions) {
        const key = `${p.symbol}_${p.product_type}_${p.settlement}`;
        if (!posGroups.has(key)) posGroups.set(key, []);
        posGroups.get(key)!.push(p);
      }
      
      newPositions = [];
      for (const group of posGroups.values()) {
        const buys = group.filter(p => p.side === 'BUY');
        const sells = group.filter(p => p.side === 'SELL');
        if (buys.length > 0 && sells.length > 0) {
          let buyQty = buys.reduce((sum, p) => sum + p.qty_open, 0);
          let sellQty = sells.reduce((sum, p) => sum + p.qty_open, 0);
          if (buyQty > sellQty) {
            newPositions.push({ ...buys[0], qty_open: buyQty - sellQty });
          } else if (sellQty > buyQty) {
            newPositions.push({ ...sells[0], qty_open: sellQty - buyQty });
          }
        } else {
          newPositions.push(...group);
        }
      }

      newPositions = newPositions.filter(p => !optimisticallyRemovedIds.current.has(p.id));

      const now = Date.now();
      const recentTempPositions = localCacheRef.current.filter(p => {
        if (p.id && p.id.toString().startsWith('temp-')) {
          const tsStr = p.id.toString().split('-')[1];
          if (tsStr) {
            const ts = parseInt(tsStr, 10);
            return now - ts < 10000; // Preserve for up to 10 seconds during slow DB updates
          }
        }
        return false;
      });

      const missingTempPositions = recentTempPositions.filter(temp => 
        !newPositions.some(dbPos => dbPos.symbol === temp.symbol && dbPos.side === temp.side)
      );

      if (missingTempPositions.length > 0) {
        newPositions = [...missingTempPositions, ...newPositions];
      }

      // Precompute static properties for any newly loaded positions
      const staticProps = staticPositionPropsRef.current;
      newPositions.forEach(p => {
        if (!staticProps[p.id]) {
          const dbSeg = mapSegmentToDbSegment(p.settlement || '');
          const segUpper = dbSeg.toUpperCase();
          const isCrypto = segUpper.includes('CRYPTO') || (p.symbol && p.symbol.endsWith('USDT'));
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

      const localCache = localCacheRef.current;
      const didChange =
        newPositions.length !== localCache.length ||
        newPositions.some((p, i) => {
          const cached = localCache[i];
          return (
            !cached ||
            p.id !== cached.id ||
            p.qty_open !== cached.qty_open ||
            p.avg_price !== cached.avg_price ||
            p.status !== cached.status ||
            p.product_type !== cached.product_type ||
            (p as any).carry_brokerage_paid !== (cached as any).carry_brokerage_paid ||
            p.ltp !== cached.ltp
          );
        });

      if (didChange || localCache.length === 0) {
        localCacheRef.current = newPositions;
        globalPositionsCache = newPositions;
        try {
          localStorage.setItem('cached_open_positions', JSON.stringify(newPositions));
        } catch (e) {}
        setRawPositions(newPositions);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
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

    const handleOrderPlacedWithData = (e: Event) => {
      const customEvt = e as CustomEvent;
      if (customEvt.detail?.symbol && customEvt.detail?.side) {
        const d = customEvt.detail;
        
        const eventId = d.eventId || `${d.symbol}_${d.side}_${d.qty}_${Date.now()}`;
        if (processedOptimisticKeys.current.has(eventId)) return;
        processedOptimisticKeys.current.add(eventId);
        setTimeout(() => processedOptimisticKeys.current.delete(eventId), 5000);

        const fillPrice = d.result?.fill_price || d.client_price || 0;
        const newPos: MyPosition = {
          id: `temp-${Date.now()}`,
          user_id: '',
          symbol: d.symbol,
          kite_instrument: d.kite_instrument || d.symbol,
          side: d.side,
          status: 'open',
          qty_open: d.qty || 1,
          qty_total: d.qty || 1,
          entry_price: fillPrice,
          avg_price: fillPrice,
          exit_price: null,
          ltp: fillPrice,
          pnl: 0,
          total_pnl: 0,
          settlement: d.segment || '',
          product_type: d.product_type || 'INTRADAY',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          entry_time: new Date().toISOString(),
        } as any;

        setRawPositions(prev => {
          const oppositeSide = d.side === 'BUY' ? 'SELL' : 'BUY';
          const oppositePositions = prev.filter(p => p.symbol === d.symbol && p.side === oppositeSide && p.product_type === (d.product_type || 'INTRADAY'));
          const totalOppositeQty = oppositePositions.reduce((sum, p) => sum + p.qty_open, 0);
          
          let nextState;
          if (oppositePositions.length > 0 && d.qty <= totalOppositeQty) {
            let qtyToDeduct = d.qty || 1;
            nextState = prev.map(p => {
              if (p.symbol === d.symbol && p.side === oppositeSide && p.product_type === (d.product_type || 'INTRADAY')) {
                if (qtyToDeduct <= 0) return p;
                const closedQty = Math.min(qtyToDeduct, p.qty_open);
                qtyToDeduct -= closedQty;
                if (p.qty_open === closedQty) {
                  optimisticallyRemovedIds.current.add(p.id);
                }
                return { ...p, qty_open: p.qty_open - closedQty, is_closing: true };
              }
              return p;
            }).filter(p => p.qty_open > 0);
          } else {
            const exists = prev.some(p => p.symbol === d.symbol && p.side === d.side && p.product_type === (d.product_type || 'INTRADAY'));
            if (exists) {
              nextState = prev.map(p => {
                if (p.symbol === d.symbol && p.side === d.side && p.product_type === (d.product_type || 'INTRADAY')) {
                  const totalQty = p.qty_open + (d.qty || 1);
                  const avgPrice = ((p.avg_price * p.qty_open) + (fillPrice * (d.qty || 1))) / totalQty;
                  return { ...p, qty_open: totalQty, qty_total: totalQty, avg_price: avgPrice, entry_price: avgPrice };
                }
                return p;
              });
            } else {
              nextState = [newPos, ...prev];
            }
          }
          
          localCacheRef.current = nextState;
          return nextState;
        });
      }
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

      const cached = props[p.id];
      const dbSeg = cached ? cached.dbSeg : mapSegmentToDbSegment(p.settlement || '');
      const isCrypto = cached ? cached.isCrypto : (p.settlement || '').toUpperCase().includes('CRYPTO');
      const isComex = cached ? cached.isComex : (p.settlement || '').toUpperCase().includes('COMEX');
      const entryTimeMs = cached ? cached.entryTimeMs : new Date(p.entry_time).getTime();

      const avgPrice = p.avg_price || p.entry_price;
      const contractExpired = isContractExpired(p.kite_instrument || p.symbol);

      if (!contractExpired) {
        if (isCrypto) {
          const binanceKey = cached ? cached.binanceSymbol : (p.symbol || '').replace('/', '') + (p.symbol?.endsWith('USDT') ? '' : 'USDT');
          ltp = marketQuotes[binanceKey]?.lastPrice ?? ltp;
        } else if (isComex) {
          ltp = comexQuotes[p.symbol]?.lastPrice ?? ltp;
        } else {
          const kiteKey = cached ? cached.resolvedKiteSymbol : resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || '');
          ltp = marketQuotes[kiteKey]?.lastPrice ?? ltp;
        }
      }

      const sideSetting = settingsMap.get(`${dbSeg}|${p.side}`);
      let unrealised = 0;
      if ((p.status === 'open' || p.status === 'active') && p.qty_open !== 0) {
        if (p.side === 'BUY') {
          unrealised = (ltp - avgPrice) * p.qty_open;
        } else {
          unrealised = (avgPrice - ltp) * p.qty_open;
        }
      }

      const total_pnl = (p.status === 'closed') ? p.pnl : unrealised;
      const investment = avgPrice * p.qty_open;
      const pnl_percent = investment > 0 ? (total_pnl / investment) * 100 : 0;

      const profitHoldSec = sideSetting ? Number(sideSetting.profit_hold_sec) : 120;
      const elapsedSec = Math.floor((Date.now() - entryTimeMs) / 1000);

      const isInProfit = unrealised > 0;
      const isLocked = segmentSettingsLoaded
        && !contractExpired
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
    segmentSettingsLoaded,
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
