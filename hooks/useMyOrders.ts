/**
 * useMyOrders
 *
 * Polls GET /api/orders for the authenticated user's platform orders.
 * These are MarginApex internal orders — NOT Zerodha Kite orders.
 *
 * Also exposes a `cancel` function that calls PATCH /api/orders/[id]
 * to cancel an open order.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { MyOrder } from '@/lib/types/order';

interface UseMyOrdersResult {
  orders:  MyOrder[];
  loading: boolean;
  error:   string | null;
  refresh: () => void;
  cancelOrder: (id: string) => Promise<{ success: boolean; error?: string }>;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let globalOrdersCache: MyOrder[] = [];

export function useMyOrders(refreshInterval = 15000): UseMyOrdersResult {
  const [orders,  setOrders]  = useState<MyOrder[]>(globalOrdersCache);
  const [loading, setLoading] = useState(globalOrdersCache.length === 0);
  const [error,   setError]   = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const headers = await getAuthHeader();
      const res = await fetch('/api/orders?limit=100', {
        headers,
        cache: 'no-store',
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? 'Failed to fetch orders');
        return;
      }

      const data = await res.json() as { orders: MyOrder[] };
      globalOrdersCache = data.orders ?? [];
      setOrders(globalOrdersCache);
      setError(null);
    } catch {
      setError('Network error loading orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    let isSubscribed = false;
    const channelName = `my-orders-realtime-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          fetchOrders();
        }
      );
      
    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    async function init() {
      await fetchOrders();
      if (cancelled) return;
      intervalRef.current = setInterval(() => {
        if (!isSubscribed) fetchOrders();
      }, refreshInterval);
    }

    init();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      supabase.removeChannel(channel);
    };
  }, [fetchOrders, refreshInterval]);

  const cancelOrder = async (id: string) => {
    try {
      const headers = await getAuthHeader();
      const res = await fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? 'Failed to cancel order');
      }

      await fetchOrders(); // Refresh list
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  };

  return { orders, loading, error, refresh: fetchOrders, cancelOrder };
}
