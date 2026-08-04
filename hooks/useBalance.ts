/**
 * useBalance
 *
 * Thin hook over BalanceDataProvider. All balance state lives in the provider —
 * no component should fetch /api/pay/balance directly.
 */
'use client';

import { useBalanceData } from '@/contexts/BalanceContext';

export type { BalanceContextType as BalanceState } from '@/contexts/BalanceContext';

export function useBalance() {
  return useBalanceData();
}
