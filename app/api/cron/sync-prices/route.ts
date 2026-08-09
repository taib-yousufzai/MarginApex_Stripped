import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { processPendingOrdersAndPositions } from '@/lib/orderMatching';


export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Extend Vercel timeout limits

// Initialize admin client to bypass RLS (lazy to avoid build-time env errors)
function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Helper for waiting
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function GET(request: Request) {
  const supabaseAdmin = getSupabaseAdmin();
  try {
    // 1. Verify cron secret
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret');
    if (secret !== process.env.AUTOLOGIN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Get active Kite session
    const session = await getSharedKiteSession();
    if (!session || !session.accessToken) {
      return NextResponse.json(
        { error: 'No active Kite session. Please login via Admin panel.' },
        { status: 400 }
      );
    }

    // 3. Fetch list of instruments to sync from database (NSE equities + mapped futures)
    const { data: dbInstruments, error: instError } = await supabaseAdmin
      .from('instruments')
      .select('id, tradingsymbol, exchange')
      .or('and(segment.eq.NSE,instrument_type.eq.EQ),instrument_type.eq.MAPPED_FUT');

    // Also fetch symbols from pending orders and open positions so their SL/TP/MTM triggers correctly
    const [ordersRes, positionsRes] = await Promise.all([
      supabaseAdmin.from('orders').select('kite_instrument, symbol, segment').eq('status', 'PENDING'),
      supabaseAdmin.from('positions').select('symbol, settlement').eq('status', 'open')
    ]);

    const activeSymbols = new Set<string>();
    
    // Add default db instruments
    if (dbInstruments) {
      dbInstruments.forEach(inst => activeSymbols.add(`${inst.exchange || 'NSE'}:${inst.tradingsymbol}`));
    }
    
    // Add pending order instruments
    if (ordersRes.data) {
      ordersRes.data.forEach((o: any) => {
        const inst = o.kite_instrument || o.symbol;
        if (inst && inst.includes(':')) {
           activeSymbols.add(inst);
        } else if (inst) {
           activeSymbols.add(`NSE:${inst}`);
        }
      });
    }

    // Add open position instruments
    if (positionsRes.data) {
      positionsRes.data.forEach((p: any) => {
         const sym = p.symbol;
         if (!sym) return;
         if (sym.includes(':')) {
           activeSymbols.add(sym);
         } else {
           let exch = 'NSE';
           const seg = p.settlement || '';
           if (seg.includes('OPT') || seg.includes('FUT') || seg.includes('NFO')) {
             if (sym.startsWith('BANKEX') || sym.startsWith('SENSEX')) exch = 'BFO';
             else exch = 'NFO';
           } else if (seg.includes('MCX')) {
             exch = 'MCX';
           } else if (seg.includes('CDS') || seg.includes('FOREX')) {
             exch = 'CDS';
           }
           activeSymbols.add(`${exch}:${sym}`);
         }
      });
    }

    const instrumentsToFetch = Array.from(activeSymbols);

    if (instrumentsToFetch.length === 0) {
      return NextResponse.json({ error: 'No instruments found to sync' }, { status: 404 });
    }

    console.log(`[Sync Prices] Found ${instrumentsToFetch.length} instruments to sync.`);

    // 4. Chunk into groups of 500 (Kite's max limit per quote request)
    const chunkSize = 500;
    const allQuotes: any[] = [];
    
    for (let i = 0; i < instrumentsToFetch.length; i += chunkSize) {
      const chunk = instrumentsToFetch.slice(i, i + chunkSize);
      // Format: i=NSE:INFY&i=MCX:CRUDEOIL24NOVFUT
      const queryParams = chunk
        .map((inst) => `i=${encodeURIComponent(inst)}`)
        .join('&');

      const url = `https://api.kite.trade/quote?${queryParams}`;
      
      const res = await fetch(url, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${process.env.KITE_API_KEY}:${session.accessToken}`,
        },
      });

      if (!res.ok) {
        console.error(`[Sync Prices] Kite API error on chunk ${i / chunkSize}: ${res.statusText}`);
        continue;
      }

      const json = await res.json();
      if (json.status === 'success' && json.data) {
        // Map Kite response format to our Supabase table format
        Object.keys(json.data).forEach((instrumentId) => {
          const q = json.data[instrumentId];
          allQuotes.push({
            id: instrumentId,
            last_price: q.last_price,
            open: q.ohlc?.open || 0,
            high: q.ohlc?.high || 0,
            low: q.ohlc?.low || 0,
            close: q.ohlc?.close || 0,
            volume: q.volume || 0,
            quote_timestamp: q.timestamp || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        });
      }

      // Kite strictly enforces 3 requests per second. Add 400ms delay between chunks.
      await delay(400);
    }

    // 5. Match pending orders and check stop loss/target thresholds
    if (allQuotes.length > 0) {
      try {
        await processPendingOrdersAndPositions(allQuotes);
      } catch (engineErr) {
        console.error('[Sync Prices] Order matching engine error:', engineErr);
      }
    }

    return NextResponse.json({
      success: true,
      synced: allQuotes.length,
      message: 'Prices synced successfully',
    });
  } catch (error: any) {
    console.error('[Sync Prices] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
