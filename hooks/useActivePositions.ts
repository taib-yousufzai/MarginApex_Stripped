'use client';

import { useMemo } from 'react';
import { usePositionsData } from '@/contexts/PositionsContext';

export interface ActivePosition {
  id: string;
  symbol: string;
  kite_instrument: string;
  side: 'BUY' | 'SELL';
  status: 'open' | 'closed';
  qty_open: number;
  qty_total: number;
  avg_price: number;
  product_type: string;
}

export function useActivePositions() {
  const { positions, loading, refresh } = usePositionsData();

  const activePositions = useMemo(() => {
    return positions.filter(
      (p) => p.status === 'open' || p.status === 'OPEN' || p.status === 'active'
    ) as unknown as ActivePosition[];
  }, [positions]);

  return {
    positions: activePositions,
    loading,
    refreshPositions: refresh,
  };
}
