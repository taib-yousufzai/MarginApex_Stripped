import { getAdminClient } from '@/lib/adminClient';
import { randomUUID } from 'crypto';

export interface ShadowCompareParams {
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

export class ShadowModeService {
  /**
   * Runs the Shadow Mode comparison between the Legacy Engine (committed)
   * and the new Position Engine v2 (rolled back).
   */
  static async runShadowCompare(
    params: ShadowCompareParams,
    legacyOrderId: string
  ): Promise<boolean> {
    const admin = getAdminClient();

    // 1. Check if Shadow Mode is enabled
    const { data: config, error: configErr } = await admin
      .from('shadow_mode_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (configErr || !config || !config.enabled) {
      return true; // Bypassed or disabled
    }

    const correlationId = `SHADOW_${randomUUID()}`;

    try {
      // 2. Fetch the actual committed state from the Legacy Engine run
      const [legacyProfile, legacyPositions, legacyTransactions] = await Promise.all([
        admin.from('profiles').select('balance').eq('id', params.userId).single(),
        admin.from('positions').select('symbol, side, qty_open, qty_total, avg_price, locked_margin, margin_required, pnl, status').eq('user_id', params.userId).eq('status', 'open'),
        admin.from('transactions').select('type, amount, status').eq('user_id', params.userId).gte('created_at', new Date(Date.now() - 3000).toISOString())
      ]);

      const legacyState = {
        balance: legacyProfile.data?.balance ? Number(legacyProfile.data.balance) : 0,
        positions: (legacyPositions.data || []).map((p: any) => ({
          ...p,
          qty_open: Number(p.qty_open),
          qty_total: Number(p.qty_total),
          avg_price: Number(p.avg_price),
          locked_margin: Number(p.locked_margin),
          margin_required: Number(p.margin_required),
          pnl: Number(p.pnl)
        })),
        ledger_entries: (legacyTransactions.data || []).map((t: any) => ({
          ...t,
          amount: Number(t.amount)
        }))
      };

      // 3. Run the new engine in shadow rollback mode
      const { data: v2ResultRaw, error: rpcErr } = await admin.rpc('run_shadow_order_v2', {
        p_user_id:            params.userId,
        p_symbol:             params.symbol,
        p_kite_inst:          params.kiteInst,
        p_segment:            params.dbSegment,
        p_side:               params.side,
        p_order_type:         params.orderType,
        p_product_type:       params.productType,
        p_qty:                params.qty,
        p_lots:               params.lots,
        p_ltp:                params.baseLtp,
        p_fill_price:         params.fillPrice,
        p_is_exit:            params.isExit,
        p_buffer_fee:         params.bufferFee,
        p_status:             params.isImmediate ? 'EXECUTED' : 'PENDING',
        p_trigger_price:      params.triggerPrice,
        p_stop_loss:          params.stopLoss,
        p_target:             params.target,
        p_info:               params.linkedPositionId || null,
        p_expected_margin:    params.requiredMargin,
        p_expected_brokerage: params.brokerage,
        p_idempotency_key:    `SHADOW_KEY_${legacyOrderId}`
      });

      if (rpcErr || !v2ResultRaw) {
        console.error(`[ShadowMode] v2 RPC run failed:`, rpcErr?.message);
        return false;
      }

      const v2Result = v2ResultRaw as any;
      const v2State = {
        balance: v2Result.balance ? Number(v2Result.balance) : 0,
        positions: (v2Result.positions || []).map((p: any) => ({
          ...p,
          qty_open: Number(p.qty_open),
          qty_total: Number(p.qty_total),
          avg_price: Number(p.avg_price),
          locked_margin: Number(p.locked_margin),
          margin_required: Number(p.margin_required),
          pnl: Number(p.pnl)
        })),
        ledger_entries: (v2Result.ledger_entries || []).map((t: any) => ({
          ...t,
          amount: Number(t.amount)
        }))
      };

      // 4. Update total runs counter
      const totalRuns = config.total_runs + 1;
      await admin.from('shadow_mode_config').update({ total_runs: totalRuns }).eq('id', 1);

      // 5. Compare Financial Equality
      const diff = this.compareState(legacyState, v2State);
      const isMatch = Object.keys(diff).length === 0;

      if (!isMatch) {
        const mismatchCount = config.mismatch_count + 1;
        const mismatchRate = mismatchCount / totalRuns;
        const autoDisable = mismatchRate > config.max_mismatch_rate;

        console.error(`[ShadowMode Mismatch] Correlation ID: ${correlationId}, Rate: ${(mismatchRate * 100).toFixed(2)}%`);

        // Record mismatch log
        await admin.from('shadow_mismatch_logs').insert({
          correlation_id: correlationId,
          order_id: legacyOrderId,
          payload: params,
          legacy_output: legacyState,
          v2_output: v2State,
          diff: diff
        });

        // Update stats and auto-disable if threshold is crossed
        await admin
          .from('shadow_mode_config')
          .update({
            mismatch_count: mismatchCount,
            enabled: autoDisable ? false : config.enabled
          })
          .eq('id', 1);

        if (autoDisable) {
          console.warn(`[ShadowMode] Auto-disabled due to mismatch rate (${(mismatchRate * 100).toFixed(2)}%) exceeding threshold.`);
        }
      }

      return isMatch;
    } catch (err: any) {
      console.error(`[ShadowMode] Error executing shadow mode comparison:`, err.message || err);
      return false;
    }
  }

  /**
   * Compares the financial state outputs and returns any diff details.
   */
  private static compareState(legacy: any, v2: any): any {
    const diff: any = {};

    // 1. Compare Balances
    if (Math.abs(legacy.balance - v2.balance) > 0.02) {
      diff.balance = { legacy: legacy.balance, v2: v2.balance };
    }

    // 2. Compare Positions (Ignore timestamps/IDs, check keys)
    const legacyPositions = legacy.positions || [];
    const v2Positions = v2.positions || [];

    if (legacyPositions.length !== v2Positions.length) {
      diff.positions_count = { legacy: legacyPositions.length, v2: v2Positions.length };
    } else {
      for (const lp of legacyPositions) {
        const vp = v2Positions.find((v: any) => v.symbol === lp.symbol && v.side === lp.side);
        if (!vp) {
          diff[`position_${lp.symbol}_${lp.side}`] = 'Missing in v2';
          continue;
        }

        const pDiff: any = {};
        if (Math.abs(lp.qty_open - vp.qty_open) > 0.001) pDiff.qty_open = { legacy: lp.qty_open, v2: vp.qty_open };
        if (Math.abs(lp.avg_price - vp.avg_price) > 0.02) pDiff.avg_price = { legacy: lp.avg_price, v2: vp.avg_price };
        if (Math.abs(lp.locked_margin - vp.locked_margin) > 0.02) pDiff.locked_margin = { legacy: lp.locked_margin, v2: vp.locked_margin };
        if (Math.abs(lp.pnl - vp.pnl) > 0.02) pDiff.pnl = { legacy: lp.pnl, v2: vp.pnl };

        if (Object.keys(pDiff).length > 0) {
          diff[`position_${lp.symbol}_${lp.side}`] = pDiff;
        }
      }
    }

    // 3. Compare Transaction Types and Totals
    const legacyTx = legacy.ledger_entries || [];
    const v2Tx = v2.ledger_entries || [];

    // Aggregate values by transaction type for clean matching
    const aggregateTx = (txs: any[]) => {
      const agg: any = {};
      for (const t of txs) {
        agg[t.type] = (agg[t.type] || 0) + t.amount;
      }
      return agg;
    };

    const legacyAgg = aggregateTx(legacyTx);
    const v2Agg = aggregateTx(v2Tx);

    const txKeys = new Set([...Object.keys(legacyAgg), ...Object.keys(v2Agg)]);
    for (const key of txKeys) {
      const lAmt = legacyAgg[key] || 0;
      const vAmt = v2Agg[key] || 0;
      if (Math.abs(lAmt - vAmt) > 0.02) {
        diff[`ledger_${key}`] = { legacy: lAmt, v2: vAmt };
      }
    }

    return diff;
  }
}
