import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import { getLotSizeFromDB } from '@/lib/lotSize';
import { calculateFreeMarginFromPositions } from '@/lib/floatingPnl';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: positionId } = await params;
  if (!positionId) {
    return NextResponse.json({ error: 'Missing position id' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { product_type } = body;
    if (!product_type || !['INTRADAY', 'CARRY'].includes(product_type)) {
      return NextResponse.json({ error: 'Invalid or missing product type' }, { status: 400 });
    }

    const admin = getAdminClient();

    // 1. Fetch position and profile
    const [{ data: pos, error: posErr }, { data: profile, error: profileErr }] = await Promise.all([
      admin.from('positions')
        .select('*')
        .eq('id', positionId)
        .eq('user_id', user.id)
        .single(),
      admin.from('profiles')
        .select('parent_id, balance, trading_mode')
        .eq('id', user.id)
        .single()
    ]);

    if (posErr || !pos) {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 });
    }
    if (profileErr || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    if (pos.product_type === product_type) {
      return NextResponse.json({ error: `Position is already ${product_type}` }, { status: 400 });
    }

    // 2. Calculate the new leverage and required margin
    const isScalper = profile.trading_mode === 'scalper';
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';

    const lookupId = profile.parent_id ?? user.id;
    const { data: segSetting } = await admin.from(targetTable)
      .select('holding_leverage, intraday_leverage, holding_type, intraday_type, commission_type, commission_value, carry_commission_type, carry_commission_value')
      .eq('user_id', lookupId)
      .eq('segment', pos.settlement || '')
      .eq('side', pos.side)
      .maybeSingle();

    let finalLeverage: number | null = segSetting 
      ? (product_type === 'CARRY' ? Number(segSetting.holding_leverage) : Number(segSetting.intraday_leverage))
      : null;

    if (!finalLeverage || finalLeverage <= 0) {
      const settlement = (pos.settlement || '').toUpperCase();
      if (settlement.includes('FOREX') || settlement.includes('CDS')) {
        finalLeverage = product_type === 'CARRY' ? 10 : 100;
      } else if (settlement.includes('CRYPTO')) {
        finalLeverage = product_type === 'CARRY' ? 1 : 10;
      } else {
        finalLeverage = product_type === 'CARRY' ? 5 : 50;
      }
    }

    let leverageType: string = segSetting 
      ? (product_type === 'CARRY' ? (segSetting.holding_type || 'Multiplier') : (segSetting.intraday_type || 'Multiplier'))
      : 'Multiplier';

    let newMarginRequired = 0;
    const exposure = Number(pos.qty_open) * Number(pos.entry_price);
    
    if (leverageType === '%') {
      newMarginRequired = exposure * (finalLeverage / 100);
    } else if (leverageType === 'Fixed') {
      // Fetch lot size dynamically from DB, falling back to hardcoded values
      const admin = getAdminClient();
      const symbolLotSize = await getLotSizeFromDB(pos.symbol || '', admin);
      const lotsUsed = Number(pos.qty_open) / symbolLotSize;
      newMarginRequired = lotsUsed * finalLeverage;
    } else {
      newMarginRequired = exposure / finalLeverage;
    }
    const currentPositionMargin = Number(pos.margin_required || 0);
    const marginDifference = newMarginRequired - currentPositionMargin;

    // 3. If converting requires more margin, perform a free margin check
    if (marginDifference > 0) {
      const { data: allOpenPos } = await admin.from('positions')
        .select('locked_margin, margin_required, pnl')
        .eq('user_id', user.id)
        .eq('status', 'open');

      const totalUsedMargin = (allOpenPos || []).reduce((acc, p) => acc + Number(p.locked_margin || p.margin_required || 0), 0);
      const balance = Number(profile.balance || 0);
      const freeMargin = calculateFreeMarginFromPositions(balance, allOpenPos || []);

      if (freeMargin < marginDifference) {
        return NextResponse.json({
          error: `Insufficient margin. Available free margin: ₹${freeMargin.toFixed(2)}, Required additional margin: ₹${marginDifference.toFixed(2)}`
        }, { status: 400 });
      }
    }

    // 4. Update the position row itself in the positions table
    const updateData: any = { 
      product_type,
      margin_required: newMarginRequired,
      locked_margin: newMarginRequired
    };

    // 3.5 Deduct carry brokerage if converting to CARRY and not yet paid
    let carryBrokerageToCharge = 0;
    if (product_type === 'CARRY' && !pos.carry_brokerage_paid) {
      carryBrokerageToCharge = calculateCarryBrokerage({
        productType: 'CARRY',
        qty: Number(pos.qty_open),
        entryPrice: Number(pos.entry_price),
        lots: Number(pos.lots || 0) || undefined,
        carryCommissionType: segSetting?.carry_commission_type,
        commissionType: segSetting?.commission_type,
        carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
        commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
      });

      if (carryBrokerageToCharge > 0) {
        // Free margin check must include the brokerage fee
        if (freeMargin < (marginDifference + carryBrokerageToCharge)) {
          return NextResponse.json({
            error: `Insufficient margin. Free margin: ₹${freeMargin.toFixed(2)}, Required: ₹${(marginDifference + carryBrokerageToCharge).toFixed(2)} (including ₹${carryBrokerageToCharge.toFixed(2)} carry brokerage)`
          }, { status: 400 });
        }
        
        // Deduct from profile balance
        const newBalance = Number(profile.balance || 0) - carryBrokerageToCharge;
        const { error: balanceErr } = await admin.from('profiles').update({ balance: newBalance }).eq('id', user.id);
        
        if (balanceErr) {
          console.error('[Positions Convert API] Error deducting brokerage:', balanceErr);
          return NextResponse.json({ error: 'Failed to deduct carry brokerage' }, { status: 500 });
        }
        
        // Log it
        await admin.from('act_logs').insert({
          user_id: user.id,
          action: 'BROKERAGE_DEDUCTION',
          reason: `Carry Brokerage charged on conversion to CARRY for ${pos.symbol} (Qty: ${pos.qty_open}) | Amount: ₹${carryBrokerageToCharge.toFixed(2)}`,
          ip_address: request.headers.get('x-forwarded-for') || '127.0.0.1'
        });
        
        updateData.carry_brokerage_paid = true;
      }
    }

    const { error: posUpdateErr } = await admin.from('positions')
      .update(updateData)
      .eq('id', positionId)
      .eq('user_id', user.id);

    if (posUpdateErr) {
      console.error('[Positions Convert API] Error updating position:', posUpdateErr);
      return NextResponse.json({ error: 'Failed to convert position product type' }, { status: 500 });
    }

    // 3. Update all EXECUTED orders for this user, symbol, and side (as fallback / consistency)
    const { error: ordErr } = await admin.from('orders')
      .update({ product_type })
      .eq('user_id', user.id)
      .eq('symbol', pos.symbol)
      .eq('side', pos.side)
      .eq('status', 'EXECUTED');

    if (ordErr) {
      console.error('[Positions Convert API] Error updating orders:', ordErr);
    }

    return NextResponse.json({ success: true, product_type }, { status: 200 });
  } catch (err: any) {
    console.error('[Positions Convert API] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
