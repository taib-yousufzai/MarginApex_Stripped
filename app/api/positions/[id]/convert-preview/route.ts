import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';

export async function GET(
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

  const { searchParams } = new URL(request.url);
  const product_type = searchParams.get('product_type');

  if (!product_type || !['INTRADAY', 'CARRY'].includes(product_type)) {
    return NextResponse.json({ error: 'Invalid or missing product type' }, { status: 400 });
  }

  try {
    const admin = getAdminClient();

    const [{ data: pos }, { data: profile }] = await Promise.all([
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

    if (!pos || !profile) {
      return NextResponse.json({ error: 'Position or profile not found' }, { status: 404 });
    }

    if (pos.product_type === product_type) {
      return NextResponse.json({ carryBrokerage: 0 });
    }

    const isScalper = profile.trading_mode === 'scalper';
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
    const lookupId = profile.parent_id ?? user.id;

    const { data: segSetting } = await admin.from(targetTable)
      .select('holding_leverage, intraday_leverage, holding_type, intraday_type, commission_type, commission_value, carry_commission_type, carry_commission_value')
      .eq('user_id', lookupId)
      .eq('segment', pos.segment || pos.settlement || '')
      .eq('side', pos.side)
      .maybeSingle();

    let carryBrokerage = 0;
    if (product_type === 'CARRY') {
      carryBrokerage = calculateCarryBrokerage({
        productType: 'CARRY',
        qty: Number(pos.qty_open),
        entryPrice: Number(pos.entry_price),
        lots: Number(pos.lots || 0) || undefined,
        carryCommissionType: segSetting?.carry_commission_type,
        carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
        commissionType: segSetting?.commission_type,
        commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
      });
    }

    return NextResponse.json({ carryBrokerage });
  } catch (err: any) {
    console.error('[Positions Preview API] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
