import { parseOptionSymbol } from './parseOptionSymbol';

// Re-export so existing imports of parseOptionSymbol from positionStore still work.
export { parseOptionSymbol };

/**
 * DEPRECATED: PositionStoreClass
 * 
 * Per architectural requirements, in-memory caching of positions, orders, balances, 
 * and P&L is strictly prohibited to prevent financial state desynchronization.
 * 
 * All position reads and writes must go through `lib/trading/PositionService.ts`
 * which interfaces directly with the database.
 */
export const positionStore = {
  applyOrder: async () => {
    throw new Error('positionStore.applyOrder is deprecated. Use PositionService and Supabase RPCs directly.');
  }
};
