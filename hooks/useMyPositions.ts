/**
 * useMyPositions
 * 
 * Fetches internal platform positions from /api/positions and
 * enriches them with live LTP from Zerodha Kite.
 */

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useMarketQuotes } from './useMarketQuotes';
import { useComexQuotes } from './useComexQuotes';
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

interface UseMyPositionsResult {
  positions: EnrichedPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePositionLocally?: (posId: string, updatedFields: Partial<MyPosition>) => void;
  removePositionLocally?: (posId: string) => void;
  restorePositionLocally?: (posId: string) => void;
  startConversion?: (posId: string, newType: string) => void;
  endConversion?: (posId: string) => void;
}

let globalPositionsCache: MyPosition[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('order_placed', () => {
    // Clear global cache so next mount doesn't show stale data
    globalPositionsCache = [];
  });
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

export function useMyPositions(refreshInterval = 5000): UseMyPositionsResult {
  const [rawPositions, setRawPositions] = useState<MyPosition[]>(globalPositionsCache);
  const [loading, setLoading] = useState(globalPositionsCache.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  const [segmentSettings, setSegmentSettings] = useState<any[]>([]);
  // Per-instance cache for change detection — avoids cross-instance cache poisoning
  // when multiple hook consumers (position page + chart) fetch at different times.
  const localCacheRef = useRef<MyPosition[]>(globalPositionsCache.slice());
  // Track optimistically removed positions to prevent polling from bringing them back
  const optimisticallyRemovedIds = useRef<Set<string>>(new Set());
  // Track whether segment settings have been fetched at least once.
  // We defer hold-lock computation until settings are known to avoid
  // showing the hardcoded 120s fallback before the real value arrives.
  const [segmentSettingsLoaded, setSegmentSettingsLoaded] = useState(false);

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
        console.error('Failed to fetch segment settings in useMyPositions', err);
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
    fetchPositions(); // trigger a re-fetch to get the position back from the server
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

      const controller = new AbortController();
      const res = await fetch('/api/positions', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!res.ok) throw new Error('Failed to fetch positions');
      const data = await res.json();
      let newPositions: MyPosition[] = data.positions || [];

      // Filter out positions we have optimistically removed
      newPositions = newPositions.filter(p => !optimisticallyRemovedIds.current.has(p.id));

      // Only update state if something actually changed — avoids unnecessary
      // re-renders (and the visible layout shift) when data is identical.
      // Uses per-instance localCacheRef so multiple hook consumers (position page + chart)
      // each independently detect changes rather than sharing a global cache.
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
            p.carry_brokerage_paid !== cached.carry_brokerage_paid ||
            p.ltp !== cached.ltp
          );
        });

      if (didChange) {
        localCacheRef.current = newPositions;
        globalPositionsCache = newPositions; // keep global in sync for initial state on new mounts
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

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          fetchPositions();
        }
      );

    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    // Listen to manual forced re-fetches (e.g., when an order is placed)
    window.addEventListener('order_placed', fetchPositions);

    const timer = setInterval(() => {
      if (!isSubscribed) fetchPositions();
    }, 15000); // DB fetch fallback

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
      window.removeEventListener('order_placed', fetchPositions);
    };
  }, [fetchPositions]);

  // Helper to smartly resolve Kite prefixes if the database is missing them
  const resolveKitePrefix = useCallback((key: string, settlement: string) => {
    let baseKey = key;
    if (baseKey.includes(':')) {
      baseKey = baseKey.split(':').slice(1).join(':'); // Strip existing prefix
    }
    const seg = (settlement || '').toUpperCase();
    let prefix = 'NSE:';
    if (baseKey.startsWith('SENSEX') || baseKey.startsWith('BANKEX')) prefix = 'BFO:';
    else if (seg.includes('MCX')) prefix = 'MCX:';
    else if (seg.includes('NCO')) prefix = 'NCO:';
    else if (seg.includes('CDS') || seg.includes('FOREX')) prefix = 'CDS:';
    else if (seg.includes('BSE') || seg.includes('BFO')) prefix = 'BFO:';
    else if (seg.includes('OPT') || seg.includes('FUT') || seg.includes('NFO')) prefix = 'NFO:';

    // Catch base indexes
    if (prefix === 'BFO:' && !baseKey.match(/\d/)) prefix = 'BSE:';
    if (prefix === 'NFO:' && !baseKey.match(/\d/)) prefix = 'NSE:';

    return `${prefix}${baseKey}`;
  }, []);

  // Group instrument keys by segment
  const { kiteKeys, binanceKeys, comexKeys } = useMemo(() => {
    const kite: string[] = [];
    const binance: string[] = [];
    const comex: string[] = [];

    rawPositions.filter(p => p.status === 'open' || p.status === 'active').forEach(p => {
      const seg = (p.settlement || '').toUpperCase();
      if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
        // Binance API expects symbols without slashes like BTCUSDT
        let sym = (p.symbol || '').replace('/', '');
        if (!sym.endsWith('USDT')) {
          sym = sym + 'USDT';
        }
        binance.push(sym);
      } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
        comex.push(p.symbol);
      } else {
        kite.push(resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''));
      }
    });

    return { kiteKeys: kite, binanceKeys: binance, comexKeys: comex };
  }, [rawPositions]);

  // Combine Kite and Binance symbols for the unified hook
  const marketSymbols = useMemo(() => [...kiteKeys, ...binanceKeys], [kiteKeys, binanceKeys]);
  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexKeys, refreshInterval);

  // Enrich positions with live calculations
  const enrichedPositions = useMemo(() => {
    // Pre-build settings map to avoid O(n²) finds per tick
    const settingsMap = new Map<string, any>();
    for (const s of segmentSettings) {
      settingsMap.set(`${s.segment}|${s.side}`, s);
    }

    return rawPositions.map(p => {
      // Overwrite product_type if there is an in-flight conversion for this position
      const product_type = inFlightConversions[p.id] || p.product_type;

      const seg = (p.settlement || '').toUpperCase();
      let ltp = p.ltp || p.entry_price;

      // Derive DB segment once — used for both PnL and anti-scalping calculations
      const dbSeg = mapSegmentToDbSegment(p.settlement || '');

      const avgPrice = p.avg_price || p.entry_price;

      // Detect expired contracts up-front so the LTP lookup and hold-lock logic
      // can both skip the ticker for dead instruments.
      const contractExpired = isContractExpired(p.kite_instrument || p.symbol);

      // Only look up live quotes for non-expired contracts.
      // Expired futures have no feed — using their last stored LTP is the
      // best we can do and avoids 0-price flicker.
      if (!contractExpired) {
        if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
          let binanceKey = (p.symbol || '').replace('/', '');
          if (!binanceKey.endsWith('USDT')) {
            binanceKey = binanceKey + 'USDT';
          }
          ltp = marketQuotes[binanceKey]?.lastPrice ?? ltp;
        } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
          ltp = comexQuotes[p.symbol]?.lastPrice ?? ltp;
        } else {
          const kiteKey = resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || '');
          ltp = marketQuotes[kiteKey]?.lastPrice ?? ltp;
        }
      }

      // Retrieve segment-specific exit buffer (fallback to 0.17%)
      // exit_buffer is stored as a percentage in the DB (e.g. 0.17 = 0.17%), divide by 100
      const sideSetting = settingsMap.get(`${dbSeg}|${p.side}`);
      const exitBuffer = sideSetting ? Number(sideSetting.exit_buffer ?? 0.17) / 100 : 0.17 / 100;

      let unrealised = 0;
      if ((p.status === 'open' || p.status === 'active') && p.qty_open !== 0) {
        if (p.side === 'BUY') {
          // BUY (Long) exits at raw LTP
          unrealised = (ltp - avgPrice) * p.qty_open;
        } else {
          // SELL (Short) exits at raw LTP
          unrealised = (avgPrice - ltp) * p.qty_open;
        }
      }

      const total_pnl = (p.status === 'closed') ? p.pnl : unrealised;
      const investment = avgPrice * p.qty_open;
      const pnl_percent = investment > 0 ? (total_pnl / investment) * 100 : 0;

      // Anti-scalping hold lock — only on profitable positions.
      // Uses the displayed P&L (total_pnl) so the timer matches what the user sees:
      // green P&L = timer active, red P&L = no timer.
      const profitHoldSec = sideSetting ? Number(sideSetting.profit_hold_sec) : 120;
      const elapsedSec = Math.floor((Date.now() - new Date(p.entry_time).getTime()) / 1000);

      // Profit detection: use the displayed unrealised P&L (buffer-inclusive).
      // This matches what the user sees on screen — if the card shows a negative
      // number, the Exit button is available. If it shows positive, it's locked.
      const isInProfit = unrealised > 0;

      // Only lock if settings have loaded — prevents spurious 120s lock on first render.
      // Also never lock an expired contract — it has no live feed and the user
      // may need to close it manually without a hold-timer obstacle.
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

    return enriched;
  }, [
    rawPositions,
    marketQuotes,
    comexQuotes,
    segmentSettingsLoaded,
    segmentSettings,
    inFlightConversions,
    resolveKitePrefix
  ]);

  return {
    positions: enrichedPositions,
    loading,
    error,
    refresh: fetchPositions,
    updatePositionLocally,
    removePositionLocally,
    startConversion,
    endConversion
  };
}
