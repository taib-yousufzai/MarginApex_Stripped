/**
 * useKiteOrders
 *
 * Fetches today's orders from Kite Connect via /api/kite/orders.
 * Polls every `refreshInterval` ms (default 5000ms).
 *
 * Shows cached data instantly on mount, then refreshes in the background.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { pageCache } from '@/lib/pageCache';
import { kiteRestore, kiteStatus } from '@/lib/kiteClient';
import { api, ApiError } from '@/lib/api';

export interface KiteOrder {
  order_id: string;
  parent_order_id: string | null;
  exchange_order_id: string | null;
  placed_by: string;
  variety: string;
  status: string;
  status_message: string | null;
  status_message_raw: string | null;
  order_timestamp: string;
  exchange_update_timestamp: string | null;
  exchange_timestamp: string | null;
  modified: boolean;
  exchange: string;
  tradingsymbol: string;
  instrument_token: number;
  order_type: string;
  transaction_type: string;
  validity: string;
  product: string;
  quantity: number;
  disclosed_quantity: number;
  price: number;
  trigger_price: number;
  average_price: number;
  filled_quantity: number;
  pending_quantity: number;
  cancelled_quantity: number;
  market_protection: number;
  tag: string | null;
}

interface UseKiteOrdersResult {
  orders: KiteOrder[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useKiteOrders(refreshInterval = 10000): UseKiteOrdersResult {
  const [orders, setOrders] = useState<KiteOrder[]>(() => pageCache.get<KiteOrder[]>('kite:orders') ?? []);
  const [connected, setConnected] = useState(() => pageCache.get<boolean>('kite:connected') ?? false);
  const [loading, setLoading] = useState(() => pageCache.get<KiteOrder[]>('kite:orders') === null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.get<{ orders: KiteOrder[] }>('/api/kite/orders');
      const freshOrders = data.orders ?? [];
      setOrders(freshOrders);
      pageCache.set('kite:orders', freshOrders);
      setConnected(true);
      pageCache.set('kite:connected', true);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setConnected(false);
        pageCache.set('kite:connected', false);
        setLoading(false);
        return;
      }
      setError(err instanceof ApiError
        ? ((err.details as { error?: string } | null)?.error ?? 'Failed to fetch orders')
        : 'Network error fetching orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      await kiteRestore();
      if (cancelled) return;

      try {
        const status = await kiteStatus();
        if (!status.connected) {
          setConnected(false);
          setLoading(false);
          return;
        }
      } catch {
        setConnected(false);
        setLoading(false);
        return;
      }

      if (cancelled) return;

      await fetchOrders();

      if (cancelled) return;

      intervalRef.current = setInterval(fetchOrders, refreshInterval);
    }

    init();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchOrders, refreshInterval]);

  return { orders, connected, loading, error, refresh: fetchOrders };
}
