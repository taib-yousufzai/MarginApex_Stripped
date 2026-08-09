import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 mins

// Initialize admin client to bypass RLS (lazy to avoid build-time env errors)
function getAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Helper for fetching LTP
async function fetchLtp(symbol: string, settlement: string): Promise<number | null> {
  const cleanSym = symbol.replace('/', '').toUpperCase();
  const isCrypto = (settlement || '').toUpperCase().includes('CRYPTO') || cleanSym.endsWith('USDT');

  if (isCrypto) {
    try {
      const sym = cleanSym.endsWith('USDT') ? cleanSym : `${cleanSym}USDT`;
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
      const params = new URLSearchParams({ symbols: sym });
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data && json.data[sym]) {
          return Number(json.data[sym].last_price);
        }
      }
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
      if (res.ok) {
        const data = await res.json();
        return data.price ? parseFloat(data.price) : null;
      }
    } catch { return null; }
  } else {
    try {
      let fullSymbol = symbol;
      if (!symbol.includes(':')) {
        let exchange = 'NSE';
        const s = (settlement || '').toUpperCase();
        if (s.includes('MCX')) exchange = 'MCX';
        else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
        else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
        else if (s.includes('BSE')) exchange = 'BSE';
        fullSymbol = `${exchange}:${symbol}`;
      }
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return null;
      const session = await getSharedKiteSession();
      if (!session) return null;

      const params = new URLSearchParams({ i: fullSymbol });
      const res = await fetch(`https://api.kite.trade/quote?${params}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${session.accessToken}`,
        },
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json() as any;
        const quote = data.data?.[fullSymbol];
        if (quote) return quote.last_price;
      }
    } catch { return null; }
  }
  return null;
}

export async function GET(request: Request) {
  const admin = getAdmin();
  try {
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret');
    if (secret !== process.env.AUTOLOGIN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[EOD Processing] Starting...');

    // Fetch all open positions
    const { data: openPositions, error: posError } = await admin
      .from('positions')
      .select('*')
      .eq('status', 'open')
      .gt('qty_open', 0);

    if (posError) throw posError;
    if (!openPositions || openPositions.length === 0) {
      return NextResponse.json({ success: true, message: 'No open positions to process' });
    }

    const results = {
      intradayClosed: 0,
      carryCharged: 0,
      errors: [] as string[]
    };

    // Load segment settings and profiles to get users' balances and configurations
    const { data: profiles } = await admin.from('profiles').select('id, parent_id, trading_mode, balance, intraday_sq_off');
    const { data: segmentSettings } = await admin.from('segment_settings').select('*');
    const { data: scalperSettings } = await admin.from('scalper_segment_settings').select('*');

    for (const pos of openPositions) {
      try {
        const userProfile = profiles?.find(p => p.id === pos.user_id);
        if (!userProfile) continue;

        const isScalper = userProfile.trading_mode === 'scalper';
        const settingsToUse = isScalper ? (scalperSettings || []) : (segmentSettings || []);
        const lookupId = userProfile.parent_id ?? userProfile.id;

        const segSetting = settingsToUse.find(
          s => s.user_id === lookupId && s.segment === pos.settlement && s.side === pos.side
        );

        if (pos.product_type === 'CARRY') {
          // --- APPLY CARRY CHARGES ---
          const commType = segSetting?.carry_commission_type || segSetting?.commission_type || 'Per Crore';
          const commVal = segSetting?.carry_commission_value ?? segSetting?.commission_value ?? 0;
          
          if (commVal > 0) {
            const totalQty = Number(pos.qty_open);
            const price = Number(pos.ltp ?? pos.entry_price);
            let charge = 0;

            if (commType === 'Per Crore') {
              charge = (totalQty * price * commVal) / 10000000;
            } else if (commType === 'Per Lot') {
              // Note: We don't have lot_size directly in the position table, but carry charges 
              // for "Per Lot" might be complicated to calculate exactly here without it.
              // Assuming totalQty is already lots if "Per Lot" is selected for this user's segment, 
              // but typically we'd need lotSize. As a fallback:
              charge = totalQty * commVal; 
            } else if (commType === 'Per Trade' || commType === 'Flat') {
              charge = commVal;
            } else {
              charge = totalQty * price * 0.001; // default 0.1% fallback
            }

            charge = Math.max(0, Math.round(charge * 100) / 100);

            if (charge > 0) {
              const idempotencyKey = `EOD_CARRY_${pos.id}_${new Date().toISOString().slice(0, 10)}`;
              const { data: charged, error: uError } = await admin.rpc('apply_carry_charges_v1', {
                p_position_id: pos.id,
                p_charge_amount: charge,
                p_idempotency_key: idempotencyKey
              });

              if (!uError) {
                userProfile.balance = Number(userProfile.balance || 0) - charge; // update local cache
                results.carryCharged++;
              } else {
                results.errors.push(`Failed to debit charge for pos ${pos.id}: ${uError.message}`);
              }
            }
          }
        } else if (pos.product_type === 'INTRADAY' && userProfile.intraday_sq_off) {
          // Intraday auto-square-off has been moved to /api/cron/auto-square-off
        }
      } catch (e: any) {
        results.errors.push(`Error processing pos ${pos.id}: ${e.message}`);
      }
    }

    console.log('[EOD Processing] Completed:', results);

    return NextResponse.json({
      success: true,
      results,
    });
  } catch (error: any) {
    console.error('[EOD Processing] Fatal Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

