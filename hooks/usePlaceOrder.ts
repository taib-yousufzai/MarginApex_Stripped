/**
 * usePlaceOrder
 *
 * Calls POST /api/orders with the user's Supabase Bearer token.
 * Returns a `place` function, loading state, and last error.
 */

'use client';

import { useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import type { PlaceOrderRequest, PlaceOrderResponse } from '@/lib/types/order';

interface UsePlaceOrderResult {
  place: (req: PlaceOrderRequest) => Promise<PlaceOrderResponse>;
  loading: boolean;
  error: string | null;
}

export function usePlaceOrder(): UsePlaceOrderResult {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const place = useCallback(async (req: PlaceOrderRequest): Promise<PlaceOrderResponse> => {
    setLoading(true);
    setError(null);

    try {
      return await api.post<PlaceOrderResponse>('/api/orders', req);
    } catch (err) {
      if (err instanceof ApiError) {
        const msg = (err.details as { error?: string } | null)?.error ?? 'Order failed. Please try again.';
        setError(msg);
        throw err;
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { place, loading, error };
}
