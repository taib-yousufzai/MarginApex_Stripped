/**
 * useOrderEntry
 * 
 * Manages the state and logic for placing an order through the MarginApex platform.
 */

import { useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
export type ProductType = 'INTRADAY' | 'CARRY';

export interface OrderEntryState {
  symbol: string;
  kite_instrument: string;
  segment: string;
  side: OrderSide;
  qty: number;
  lots: number;
  order_type: OrderType;
  product_type: ProductType;
  client_price: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  is_exit?: boolean;
  linked_position_id?: string | null;
}

export function useOrderEntry() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeOrder = useCallback(async (state: OrderEntryState) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.post<{ id: string }>('/api/orders', state);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
      }

      return { success: true, order: result };
    } catch (err) {
      const message = err instanceof ApiError
        ? ((err.details as { details?: string; error?: string } | null)?.details
            ?? (err.details as { details?: string; error?: string } | null)?.error
            ?? `ApiError ${err.status}`)
        : err instanceof Error ? err.message : 'Unknown error';
      console.warn('[useOrderEntry] Order placement failed:', message);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  const closePosition = useCallback(async (positionId: string, clientPrice?: number, symbol?: string, settlement?: string, side?: string) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.post<Record<string, unknown>>(`/api/positions/${positionId}/close`, {
        client_price: clientPrice,
        symbol,
        settlement,
        side
      });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed')); // Backward compatibility for some components
      }

      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof ApiError
        ? ((err.details as { error?: string } | null)?.error ?? `ApiError ${err.status}`)
        : err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  const closePositionsBatch = useCallback(async (positionIds: string[]) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.post<Record<string, unknown>>('/api/positions/close', { positionIds });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
      }

      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof ApiError
        ? ((err.details as { error?: string } | null)?.error ?? `ApiError ${err.status}`)
        : err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    placeOrder,
    closePosition,
    closePositionsBatch,
    loading,
    error,
    setError
  };
}
