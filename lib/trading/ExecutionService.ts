import { getAdminClient } from '@/lib/adminClient';

export interface ExecutionParams {
  userId: string;
  symbol: string;
  kiteInst: string;
  dbSegment: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  productType: string;
  qty: number;
  lots: number;
  baseLtp: number;
  fillPrice: number;
  bufferFee: number;
  triggerPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  isExit: boolean;
  linkedPositionId?: string;
  isImmediate: boolean;
  requiredMargin: number;
  brokerage: number;
}

export class ExecutionService {
  /**
   * Executes the order by calling the place_order RPC and interacting with the PositionStore.
   * Handles Redis locking to prevent race conditions.
   */
  static async executeOrder(params: ExecutionParams): Promise<string> {
    const admin = getAdminClient();
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();

    let orderId: string;
    const lockKey = `order_lock:${params.userId}`;
    
    // Acquire Redis Lock (5 seconds TTL)
    const acquired = await redis.set(lockKey, '1', 'PX', 5000, 'NX');
    if (!acquired) {
      throw new Error('Order processing in progress. Please wait a second before placing another order.');
    }

    try {
      const rpcOrderType = params.orderType === 'SLM' ? 'MARKET' : params.orderType;

      let resolvedTriggerPrice = params.triggerPrice;
      let resolvedStopLoss = params.stopLoss;

      if (params.orderType === 'SLM') {
        if (resolvedTriggerPrice !== null) {
          resolvedStopLoss = resolvedTriggerPrice;
          resolvedTriggerPrice = null;
        }
      }

      const executeDbCall = async () => {
        const { data: oId, error: rpcErr } = await admin.rpc('place_order_v2', {
          p_user_id:      params.userId,
          p_symbol:       params.symbol,
          p_kite_inst:    params.kiteInst,
          p_segment:      params.dbSegment,
          p_side:         params.side,
          p_order_type:   rpcOrderType,
          p_product_type: params.productType,
          p_qty:          params.qty,
          p_lots:         params.lots,
          p_ltp:          params.baseLtp,
          p_fill_price:   params.fillPrice,
          p_info:         params.linkedPositionId || null,
          p_trigger_price: resolvedTriggerPrice,
          p_stop_loss:    resolvedStopLoss,
          p_target:       params.target,
          p_is_exit:      params.isExit,
          p_buffer_fee:   params.bufferFee,
          p_status:       params.isImmediate ? 'EXECUTED' : 'PENDING',
          p_expected_margin: params.requiredMargin,
          p_expected_brokerage: params.brokerage
        });

        if (rpcErr) {
          throw new Error(rpcErr.message || 'Order execution failed. Please try again.');
        }

        // Append margin/brokerage info to act_log asynchronously
        setTimeout(async () => {
          try {
            const { data: actLog, error: actLogError } = await admin
              .from('act_logs')
              .select('id, reason')
              .eq('user_id', params.userId)
              .eq('symbol', params.symbol)
              .in('type', ['ORDER_EXECUTION', 'ORDER_PLACED'])
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            if (actLog && !actLogError) {
              const marginStr = ` | Margin Req: ₹${params.requiredMargin.toFixed(2)} | Bkg: ₹${params.brokerage.toFixed(2)} | Buf: ₹${params.bufferFee.toFixed(2)}`;
              await admin
                .from('act_logs')
                .update({ reason: actLog.reason + marginStr })
                .eq('id', actLog.id);
            }
          } catch { /* non-critical */ }
        }, 0);

        return oId as string;
      };

      // Directly call DB, no in-memory positionStore
      orderId = await executeDbCall();

    } finally {
      // Release the lock
      await redis.del(lockKey);
      try {
        await redis.del(`pos:${params.userId}:default`, `pos:${params.userId}:open`, `pos:${params.userId}:active`);
      } catch {}
    }

    // Restore SLM order type if needed
    if (params.orderType === 'SLM' && orderId) {
      admin
        .from('orders')
        .update({ order_type: 'SLM' })
        .eq('id', orderId)
        .then(({ error: updateErr }) => {
          if (updateErr) {
            console.error('[ExecutionService] Failed to restore SLM order type:', updateErr);
          }
        });
    }

    return orderId;
  }
}
