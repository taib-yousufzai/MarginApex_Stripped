/**
 * POST /api/admin/positions/[id]/sqoff
 *
 * Admin-initiated square-off for a single open position.
 *
 * Uses the same close_position() RPC as user-initiated and auto-liquidation
 * closes to ensure full accounting consistency:
 *   - Closes the position at current LTP (with exit buffer from segment_settings)
 *   - Inserts a PNL_CREDIT or PNL_DEBIT transaction → updates wallet via trigger
 *   - Records the exit order row (is_exit = true)
 *   - Writes to act_logs
 *
 * Intentionally does NOT charge brokerage on admin-forced square-offs
 * (same convention as AUTO_LIQUIDATION and AUTO_SL paths).
 *
 * Validates: Requirements 7.10, 12.1–12.6
 */

import { requireAdmin } from '../../../_auth';
import { calculateCarryBrokerage } from '@/lib/brokerage';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Fetch the open position row (must be open to square off)
    const { data: position, error: fetchError } = await adminClient
      .from('positions')
      .select('id, user_id, symbol, side, settlement, qty_open, entry_price, ltp, product_type')
      .eq('id', id)
      .eq('status', 'open')
      .single();

    if (fetchError || position === null) {
      return Response.json({ error: 'Position not found or already closed' }, { status: 404 });
    }

    // Step 4: Resolve LTP — use stored ltp, fall back to entry_price
    const baseLtp = Number(position.ltp ?? position.entry_price);

    // Step 5: Fetch exit buffer from segment_settings (user's own settings first)
    const { data: segSetting } = await adminClient
      .from('segment_settings')
      .select('exit_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
      .eq('user_id', position.user_id)
      .eq('segment', position.settlement ?? '')
      .eq('side', position.side)
      .maybeSingle();

    const exitBuffer = Number(segSetting?.exit_buffer ?? 0.17) / 100;

    // Step 6: Compute exit price (same formula as user-close and liquidation engine)
    let exitPrice: number;
    if (position.side === 'BUY') {
      exitPrice = baseLtp * (1 - exitBuffer);
    } else {
      exitPrice = baseLtp * (1 + exitBuffer);
    }
    exitPrice = Math.round(exitPrice * 100) / 100;

    // Step 7: Call the atomic close_position RPC — this handles:
    //   - Setting position status = 'closed', exit_price, exit_time, pnl, qty_open = 0
    //   - Inserting PNL_CREDIT / PNL_DEBIT transaction (wallet updated via trigger)
    //   - Inserting exit order row
    //   - Writing to act_logs
    // Carry brokerage deferred to exit
    let carryBrokerage = 0;
    if (!position.carry_brokerage_paid) {
      carryBrokerage = calculateCarryBrokerage({
        productType: position.product_type,
        qty: Number(position.qty_open),
        entryPrice: Number(position.entry_price),
        carryCommissionType: segSetting?.carry_commission_type,
        carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
        commissionType: segSetting?.commission_type,
        commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
      });
    }

    const { data: pnl, error: rpcErr } = await adminClient.rpc('close_position', {
      p_position_id: id,
      p_user_id: position.user_id,
      p_ltp: baseLtp,
      p_exit_price: exitPrice,
      p_closed_by: 'ADMIN_ACTION',
      p_brokerage: carryBrokerage,
    });

    if (rpcErr) {
      console.error('[POST /api/admin/positions/[id]/sqoff] RPC error:', rpcErr);
      return Response.json({ error: 'Failed to close position' }, { status: 500 });
    }

    // Step 8: Return result
    return Response.json(
      {
        success: true,
        pnl: Number(pnl),
        exit_price: exitPrice,
        message: `Position squared off at ₹${exitPrice}. PnL: ₹${Number(pnl).toFixed(2)}`,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[POST /api/admin/positions/[id]/sqoff] Error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
