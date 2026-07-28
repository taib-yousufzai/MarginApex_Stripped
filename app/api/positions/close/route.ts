import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/brokerage';

/**
 * Fetch LTPs for a mixed batch of instruments (Kite + Binance crypto).
 * Each entry in the map is keyed by the instrument's lookup key:
 *   - Kite instruments: "NSE:NIFTY FUT" etc.
 *   - Binance crypto:   "BTCUSDT" etc.
 * Uses Redis → Ticker Daemon → REST cascade for both.
 */
async function fetchLtpBatch(
  kiteInstruments: string[],
  cryptoSymbols: string[]
): Promise<Record<string, number>> {
  const quotesMap: Record<string, number> = {};
  const allSymbols = [...kiteInstruments, ...cryptoSymbols];
  if (allSymbols.length === 0) return quotesMap;

  const missing = new Set(allSymbols);

  // 1. Redis cache (both Kite and Binance prices land here)
  try {
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();
    await Promise.all(Array.from(missing).map(async (sym) => {
      const cached = await redis.hget('market:quotes', sym);
      if (cached) {
        const q = JSON.parse(cached);
        if (q && q.last_price !== undefined) {
          quotesMap[sym] = Number(q.last_price);
          missing.delete(sym);
        }
      }
    }));
  } catch { /* fall through */ }

  if (missing.size === 0) return quotesMap;

  // 2. Ticker Daemon (serves both Kite and Binance streams)
  try {
    const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
    const params = new URLSearchParams({ symbols: Array.from(missing).join(',') });
    const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
    if (resTicker.ok) {
      const json = await resTicker.json();
      if (json.success && json.data) {
        for (const sym of Array.from(missing)) {
          if (json.data[sym]) {
            quotesMap[sym] = Number(json.data[sym].last_price);
            missing.delete(sym);
          }
        }
      }
    }
  } catch (tickerErr) {
    console.warn('[fetchLtpBatch] Ticker Daemon failed, falling back to REST:', tickerErr);
  }

  if (missing.size === 0) return quotesMap;

  // 3a. Kite REST for remaining non-crypto instruments
  const missingKite = Array.from(missing).filter(s => kiteInstruments.includes(s));
  if (missingKite.length > 0) {
    try {
      const apiKey = process.env.KITE_API_KEY;
      const session = apiKey ? await getSharedKiteSession() : null;
      if (apiKey && session) {
        const params = new URLSearchParams();
        missingKite.forEach(i => params.append('i', i));
        const res = await fetch(`https://api.kite.trade/quote?${params}`, {
          headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${session.accessToken}` },
          cache: 'no-store', signal: AbortSignal.timeout(100),
        });
        
        
        if (res && res.ok) {
          const data = await res.json() as { data?: Record<string, { last_price: number }> };
          for (const inst of missingKite) {
            const quote = data.data?.[inst];
            if (quote) { quotesMap[inst] = quote.last_price; missing.delete(inst); }
          }
        }
      }
    } catch (err) {
      console.error('[fetchLtpBatch] Kite REST error:', err);
    }
  }

  // 3b. Binance REST for remaining crypto symbols
  const missingCrypto = Array.from(missing).filter(s => cryptoSymbols.includes(s));
  if (missingCrypto.length > 0) {
    await Promise.all(missingCrypto.map(async (sym) => {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
        if (res.ok) {
          const data = await res.json();
          if (data.price) { quotesMap[sym] = parseFloat(data.price); missing.delete(sym); }
        }
      } catch (err) {
        console.error(`[fetchLtpBatch] Binance REST error for ${sym}:`, err);
      }
    }));
  }

  return quotesMap;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { positionIds } = await request.json() as { positionIds?: string[] };
    if (!positionIds || !Array.isArray(positionIds) || positionIds.length === 0) {
      return NextResponse.json({ error: 'Missing or empty positionIds array' }, { status: 400 });
    }

    const admin = getAdminClient();

    // 1. Parallel fetch positions, profile, and trading hours
    const [posResult, profileResult, tradingHoursResult] = await Promise.all([
      admin.from('positions')
        .select('*')
        .in('id', positionIds)
        .eq('user_id', user.id)
        .eq('status', 'open'),
      admin.from('profiles')
        .select('parent_id, trading_mode')
        .eq('id', user.id)
        .single(),
      admin.from('trading_hours')
        .select('id, name, start_time, end_time, is_active')
    ]);

    const { data: positions, error: posErr } = posResult;
    if (posErr || !positions || positions.length === 0) {
      return NextResponse.json({ error: 'No open positions found matching the specified IDs' }, { status: 404 });
    }

    // Map trading hours for easy access
    const tradingHoursMap = new Map<string, any>();
    if (tradingHoursResult.data) {
      tradingHoursResult.data.forEach(th => {
        tradingHoursMap.set(th.id, th);
      });
    }

    // 2. Fetch segment settings for all required settings
    const isScalper = profileResult.data?.trading_mode === 'scalper';
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
    const lookupId = profileResult.data?.parent_id ?? user.id;

    const { data: segSettings } = await admin.from(targetTable)
      .select('segment, side, exit_buffer, profit_hold_sec, loss_hold_sec, entry_buffer, commission_type, commission_value, carry_commission_type, carry_commission_value')
      .eq('user_id', lookupId);

    const segSettingsMap = new Map<string, any>();
    if (segSettings) {
      segSettings.forEach(s => {
        segSettingsMap.set(`${s.segment}|${s.side}`, s);
      });
    }

    // 3. Resolve all full symbols and prepare to batch fetch LTPs
    // Crypto positions use Binance key (BTCUSDT), others use Kite exchange-prefixed key
    const kiteSymbolsToFetch = new Set<string>();
    const cryptoSymbolsToFetch = new Set<string>();

    const posSymbols = positions.map(pos => {
      const isCrypto = (pos.settlement || '').toUpperCase().includes('CRYPTO');
      let lookupKey: string;

      if (isCrypto) {
        let cleanSym = (pos.symbol || '').replace('/', '').toUpperCase();
        if (!cleanSym.endsWith('USDT')) cleanSym = cleanSym + 'USDT';
        lookupKey = cleanSym;
        cryptoSymbolsToFetch.add(lookupKey);
      } else {
        let fullSymbol = pos.symbol;
        if (!pos.symbol.includes(':')) {
          let exchange = 'NSE';
          if (pos.settlement) {
            const s = pos.settlement.toUpperCase();
            if (s.includes('MCX')) exchange = 'MCX';
            else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
            else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
            else if (s.includes('BSE')) exchange = 'BSE';
          }
          fullSymbol = `${exchange}:${pos.symbol}`;
        }
        lookupKey = fullSymbol;
        kiteSymbolsToFetch.add(lookupKey);
      }

      return { pos, lookupKey };
    });

    const quotesMap = await fetchLtpBatch(
      Array.from(kiteSymbolsToFetch),
      Array.from(cryptoSymbolsToFetch)
    );

    // 4. Process closings sequentially to avoid database deadlocks.
    // All positions belong to the same user so they compete for locks on the
    // same wallet row. Running them in parallel causes deadlock storms.
    const results: any[] = [];

    for (const { pos, lookupKey } of posSymbols) {
      try {
        // Check market hours
        const symbol = pos.symbol || '';
        const dbSegment = pos.settlement || '';
        const exchangeName = symbol.includes(':') ? symbol.split(':')[0] : 'NSE';
        const ex = exchangeName.toUpperCase();
        const segUpper = dbSegment.toUpperCase();

        if (!segUpper.includes('CRYPTO')) {
          let segmentId = 'nse';
          if (ex === 'MCX' || segUpper.includes('MCX')) segmentId = 'mcx';
          else if (ex === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
          else if (ex === 'CDS' || ex === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
          else if (ex === 'COMEX' || segUpper.includes('COMEX')) segmentId = 'comex';

          const segmentHour = tradingHoursMap.get(segmentId);
          if (segmentHour) {
            if (!segmentHour.is_active) {
              results.push({ positionId: pos.id, success: false, error: 'market is closed' });
              continue;
            }

            const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const dayOfWeek = nowIST.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

            if (isWeekend) {
              results.push({ positionId: pos.id, success: false, error: 'market is closed' });
              continue;
            }

            const currentHHMM = `${String(nowIST.getHours()).padStart(2, '0')}:${String(nowIST.getMinutes()).padStart(2, '0')}`;
            if (currentHHMM < segmentHour.start_time || currentHHMM >= segmentHour.end_time) {
              results.push({ positionId: pos.id, success: false, error: 'market is closed' });
              continue;
            }
          }
        }

        // Get settings and LTP
        const segSetting = segSettingsMap.get(`${pos.settlement ?? ''}|${pos.side}`);
        // exit_buffer is stored as a percentage in the DB (e.g. 0.17 = 0.17%), divide by 100
        const exitBuffer = (segSetting?.exit_buffer ?? 0.17) / 100;
        const profitHoldSec = segSetting?.profit_hold_sec ?? 120;
        const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

        const baseLtp = quotesMap[lookupKey] ?? Number(pos.ltp ?? pos.entry_price);

        // Exit price computation
        let exitPrice: number;
        if (pos.side === 'BUY') {
          exitPrice = baseLtp * (1 - exitBuffer);
        } else {
          exitPrice = baseLtp * (1 + exitBuffer);
        }
        exitPrice = Math.round(exitPrice * 100) / 100;

        const pnlValue = pos.side === 'BUY'
          ? (baseLtp - Number(pos.entry_price)) * Number(pos.qty_open)
          : (Number(pos.entry_price) - baseLtp) * Number(pos.qty_open);

        const durationSec = Math.floor((Date.now() - new Date(pos.entry_time).getTime()) / 1000);
        const requiredHold = pnlValue > 0 ? profitHoldSec : lossHoldSec;

        if (durationSec < requiredHold) {
          results.push({
            positionId: pos.id,
            success: false,
            error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required. Elapsed: ${durationSec}s.`
          });
          continue;
        }

        // --- CARRY BROKERAGE (deferred from entry to exit) ---
        let carryBrokerage = 0;
        if (!pos.carry_brokerage_paid) {
          carryBrokerage = calculateCarryBrokerage({
            productType: pos.product_type,
            qty: Number(pos.qty_open),
            entryPrice: Number(pos.entry_price),
            lots: Number(pos.lots || 0) || undefined,
            carryCommissionType: segSetting?.carry_commission_type,
            carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
            commissionType: segSetting?.commission_type,
            commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
          });
        }

        // Call RPC — sequential execution eliminates deadlocks, but keep one
        // retry just in case an external process touches the same row.
        let pnl: any;
        let rpcErr: any;
        
        for (let attempt = 1; attempt <= 2; attempt++) {
          const result = await admin.rpc('close_position', {
            p_position_id: pos.id,
            p_user_id:     user.id,
            p_ltp:         baseLtp,
            p_exit_price:  exitPrice,
            p_closed_by:   'USER_ACTION',
            p_brokerage:   carryBrokerage,
          });
          
          pnl = result.data;
          rpcErr = result.error;
          
          if (rpcErr && rpcErr.message && rpcErr.message.toLowerCase().includes('deadlock')) {
            console.warn(`[POST /api/positions/close] Deadlock on attempt ${attempt} for position ${pos.id}. Retrying...`);
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 300));
              continue;
            }
          }
          break;
        }

        if (rpcErr) {
          console.error(`[POST /api/positions/close] RPC error for position ${pos.id}:`, rpcErr);
          results.push({ positionId: pos.id, success: false, error: `RPC Error: ${rpcErr.message || JSON.stringify(rpcErr)}` });
          continue;
        }

        results.push({ positionId: pos.id, success: true, pnl: Number(pnl), exit_price: exitPrice });
      } catch (innerErr: any) {
        results.push({ positionId: pos.id, success: false, error: innerErr.message || 'Unknown error' });
      }
    }

    return NextResponse.json({ success: true, results }, { status: 200 });
  } catch (err: any) {
    console.error('[POST /api/positions/close] Request error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

