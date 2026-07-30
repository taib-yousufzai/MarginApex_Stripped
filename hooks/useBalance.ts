/**
 * useBalance
 *
 * Wallet balance data hook, refactored to consume the global BalanceContext.
 */

'use client';

import { useBalanceData } from '@/contexts/BalanceContext';

interface BalanceState {
  balance: number;
  settlementAmount: number;
  loading: boolean;
}

export function useBalance(): BalanceState {
  return useBalanceData();
}
