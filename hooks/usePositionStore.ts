'use client';

/**
 * usePositionStore
 *
 * Client-side hook providing a real-time view of the user's open option positions.
 *
 * Strategy:
 *  1. On mount — fetch a full snapshot from /api/positions (open rows only).
 *  2. Subscribe to Supabase Realtime postgres_changes on the `positions` table.
 *  3. Per event — run computeDelta; only push a React state update when fields
 *     actually changed (avoids spurious re-renders).
 *  4. On reconnect after >30 s of disconnection — re-fetch a full snapshot via
 *     isFullSnapshotNeeded() to reconcile any events missed while offline.
 *
 * Returned shape:
 *   positions  — current open option PositionState[]
 *   loading    — true during the initial snapshot fetch
 *   connected  — whether the Realtime channel reports SUBSCRIBED
 *   stale      — true while a re-sync snapshot fetch is in flight
 *   refresh    — manually trigger a full re-fetch
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { positionKeyString } from '@/lib/positionValidator';
import { computeDelta, isFullSnapshotNeeded } from '@/lib/positionDelta';
import { api } from '@/lib/api';
import type { PositionState, PositionKeyString, PositionSide } from '@/lib/positionValidator';

// Shape of a raw row from /api/positions or a Realtime payload
interface PositionRow {
  id: string;
  user_id?: string;
  symbol: string;
  side: string;
  qty_open: number | string;
  status: string;
}

export interface UsePositionStoreResult {
  positions: PositionState[];
  loading: boolean;
  connected: boolean;
  stale: boolean;
  refresh: () => Promise<void>;
}

export function usePositionStore(): UsePositionStoreResult {
  // Internal O(1) keyed cache — the array exposed to callers is derived from this
  const cacheRef = useRef<Map<PositionKeyString, PositionState>>(new Map());

  const [positions, setPositions] = useState<PositionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(false);

  // Timestamp of the moment the channel last dropped; null when connected
  const disconnectedAtRef = useRef<number | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Derive a PositionState from a raw DB row.
   * Returns null when the row represents a closed / zero-qty position.
   */
  const rowToState = (row: PositionRow): PositionState | null => {
    const qty = Number(row.qty_open);
    if (row.status !== 'open' || qty <= 0) return null;
    const parsed = parseOptionSymbol(row.symbol);
    if (!parsed) return null;
    return {
      strike_price: parsed.strike,
      option_type: parsed.optionType,
      side: row.side as PositionSide,
      quantity: qty,
    };
  };

  /** Flush the cache Map to a plain array for React state. */
  const flushState = useCallback(() => {
    setPositions(Array.from(cacheRef.current.values()));
  }, []);

  /**
   * Apply one DB row to the cache using computeDelta as a gate.
   * Returns true when the cache changed (caller should flushState).
   */
  const applyRow = useCallback(
    (row: PositionRow): boolean => {
      const parsed = parseOptionSymbol(row.symbol);
      if (!parsed) return false;

      const keyStr = positionKeyString(parsed.strike, parsed.optionType);
      const before = cacheRef.current.get(keyStr) ?? null;
      const after = rowToState(row);

      // Short-circuit: no actual change → skip state update
      if (!computeDelta(before, after)) return false;

      if (after) {
        cacheRef.current.set(keyStr, after);
      } else {
        cacheRef.current.delete(keyStr);
      }
      return true;
    },
    [], // parseOptionSymbol and positionKeyString are stable pure functions
  );

  // ── Snapshot fetch ───────────────────────────────────────────────────────────

  const fetchSnapshot = useCallback(async () => {
    try {
      const data = await api.get<{ positions: PositionRow[] }>('/api/positions');
      const rows: PositionRow[] = data.positions ?? [];

      // Rebuild cache from scratch so deleted positions are evicted
      cacheRef.current.clear();
      for (const row of rows) {
        if (row.status === 'open') applyRow(row);
      }

      flushState();
    } catch (err) {
      console.error('[usePositionStore] Snapshot fetch failed:', err);
    } finally {
      setLoading(false);
      setStale(false);
    }
  }, [applyRow, flushState]);

  /** Public handle for consumers who want to force a re-sync. */
  const refresh = useCallback(async () => {
    setStale(true);
    await fetchSnapshot();
  }, [fetchSnapshot]);

  // ── Initial snapshot ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  // ── Supabase Realtime subscription ───────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    // Defer subscription until auth session is confirmed (mirrors useKiteQuotes pattern)
    supabase.auth.getSession().then(() => {
      if (cancelled) return;

      const channelId = `pos-rt-${Math.random().toString(36).substring(2, 11)}`;

      const channel = supabase
        .channel(channelId)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'positions' },
          (payload) => {
            // Use new row if present (INSERT / UPDATE), fall back to old (DELETE)
            const row =
              (payload.new as PositionRow)?.symbol
                ? (payload.new as PositionRow)
                : (payload.old as PositionRow);

            if (!row?.symbol) return;

            const changed = applyRow(row);
            if (changed) flushState();
          },
        )
        .subscribe((status) => {
          console.log(`[usePositionStore] Channel ${channelId}: ${status}`);

          if (status === 'SUBSCRIBED') {
            setConnected(true);

            // Reconnect after a long gap — missed events require a full re-sync
            if (
              disconnectedAtRef.current !== null &&
              isFullSnapshotNeeded(disconnectedAtRef.current)
            ) {
              console.warn(
                '[usePositionStore] >30 s disconnection — re-fetching full snapshot',
              );
              setStale(true);
              fetchSnapshot();
            }

            disconnectedAtRef.current = null;
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            setConnected(false);
            // Record the moment we went offline (only on first drop, not repeated events)
            if (disconnectedAtRef.current === null) {
              disconnectedAtRef.current = Date.now();
            }
          }
        });

      return () => {
        cancelled = true;
        console.log(`[usePositionStore] Removing channel ${channelId}`);
        supabase.removeChannel(channel);
      };
    });

    return () => {
      cancelled = true;
    };
  }, [applyRow, flushState, fetchSnapshot]);

  return { positions, loading, connected, stale, refresh };
}
