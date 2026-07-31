import { getAdminClient } from '@/lib/adminClient';

export interface ClosePositionParams {
  userId: string;
  positionId: string;
  closeQty: number;
  closePrice: number;
  closedBy?: 'USER' | 'ADMIN' | 'SYSTEM' | 'LIQUIDATION';
}

export class PositionService {
  /**
   * Opens a new position or averages an existing one.
   * Relies entirely on the Supabase Postgres RPC 'place_order' to ensure atomic
   * execution of the order creation, position opening/updating, and ledger deduction.
   */
  static async openPosition(
    userId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    lots: number,
    baseLtp: number,
    fillPrice: number,
    orderType: string,
    productType: string,
    dbSegment: string,
    kiteInst: string,
    isImmediate: boolean
  ): Promise<string> {
    const admin = getAdminClient();
    
    // Call the database function to persist the order and open the position transactionally
    const { data: orderId, error: rpcErr } = await admin.rpc('place_order', {
      p_user_id:      userId,
      p_symbol:       symbol,
      p_kite_inst:    kiteInst,
      p_segment:      dbSegment,
      p_side:         side,
      p_order_type:   orderType,
      p_product_type: productType,
      p_qty:          qty,
      p_lots:         lots,
      p_ltp:          baseLtp, // Initial entry price
      p_fill_price:   fillPrice,
      p_is_exit:      false,
      p_status:       isImmediate ? 'EXECUTED' : 'PENDING'
    });

    if (rpcErr || !orderId) {
      throw new Error(rpcErr?.message || 'Failed to open position in the database.');
    }

    return orderId as string;
  }

  /**
   * Closes or partially closes a position.
   * Ensures that margin release and PnL realization happen atomically in the DB.
   */
  static async closePosition(params: ClosePositionParams): Promise<void> {
    const admin = getAdminClient();

    // Call the database function to handle the position close, PnL realization, and ledger update
    const { error: rpcErr } = await admin.rpc('close_position_v2', {
      p_position_id: params.positionId,
      p_close_qty: params.closeQty,
      p_close_price: params.closePrice,
      p_closed_by: params.closedBy || 'USER'
      // Note: p_expected_brokerage and margin credits should be wired up from TS here in v2
    });

    if (rpcErr) {
      throw new Error(rpcErr.message || 'Failed to close position in the database.');
    }
  }

  /**
   * Replaces the old in-memory cache lookup.
   * Always fetches the authoritative position state directly from the database.
   */
  static async getOpenPosition(userId: string, symbol: string): Promise<any | null> {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .maybeSingle();

    if (error) {
      throw new Error(`Database error fetching position: ${error.message}`);
    }

    return data;
  }

  /**
   * Retrieves all open positions for a user directly from the authoritative database.
   */
  static async getAllOpenPositions(userId: string): Promise<any[]> {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'open');

    if (error) {
      throw new Error(`Database error fetching all positions: ${error.message}`);
    }

    return data || [];
  }
}
