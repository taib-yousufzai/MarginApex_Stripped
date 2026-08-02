/**
 * POST /api/positions/[id]/close
 *
 * Closes an open position for the authenticated user.
 * - Fetches Kite LTP for exit price computation (server-side)
 * - Applies exit_buffer from segment_settings
 * - Calls close_position() Postgres RPC atomically:
 *     → updates position to 'closed'
 *     → records exit order
 *     → writes PNL_CREDIT / PNL_DEBIT transaction
 *     → logs to act_logs
 *
 * Also used by broker force-close (broker panel calls with user's position id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import { calculateExitPrice } from '@/lib/floatingPnl';
import type { ClosePositionResponse } from '@/lib/types/order';
import { logAction, extractClientIp } from '@/lib/actionLogger';

/**
 * Fetch the Kite LTP for a single instrument key server-side.
 * Resolves from local market_quotes DB cache if available, falling back on-demand.
 */
async function fetchKiteLtp(instrument: string): Promise<{ltp: number, bid: number, ask: number} | null> {
  try {
    const admin = getAdminClient();
    
    // 1. Check Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
      const params = new URLSearchParams({ symbols: instrument });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data && json.data[instrument]) {
          const q = json.data[instrument];
          return {
            ltp: Number(q.last_price),
            bid: Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? q.last_price),
            ask: Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? q.last_price)
          };
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchKiteLtp] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. On-demand fallback to Kite REST API
    const apiKey = process.env.KITE_API_KEY;
    if (!apiKey) return null;
    const session = await getSharedKiteSession();
    if (!session) return null;

    const params = new URLSearchParams({ i: instrument });
    const res = await fetch(`https://api.kite.trade/quote?${params}`, {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${session.accessToken}`,
      },
      cache: 'no-store', signal: AbortSignal.timeout(100),
    });
    
    

    if (!res || !res.ok) return null;

    const data = await res.json() as { data?: Record<string, any> };
    const quote = data.data?.[instrument];
    if (!quote) return null;

    // Cache the instrument asynchronously in background (excluding raw ticks)
    (async () => {
      try {
        const parts = instrument.split(':');
        const exchange = parts[0] || 'NSE';
        const tradingsymbol = parts[1] || '';

        await admin.from('instruments').upsert({
          id: instrument,
          instrument_token: quote.instrument_token || 0,
          tradingsymbol: tradingsymbol,
          exchange: exchange,
          instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
          segment: exchange,
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
      } catch (err) {
        console.error('[fetchKiteLtp] Background cache error:', err);
      }
    })();

    return {
      ltp: Number(quote.last_price),
      bid: Number(quote.depth?.buy?.[0]?.price ?? quote.last_price),
      ask: Number(quote.depth?.sell?.[0]?.price ?? quote.last_price)
    };
  } catch (err) {
    console.error('[fetchKiteLtp] Unexpected error:', err);
    return null;
  }
}

/**
 * Fetch the Binance LTP for a crypto symbol using the same
 * Redis → Ticker Daemon → Binance REST cascade as the Kite path.
 */
async function fetchBinanceLtp(symbol: string): Promise<{ltp: number, bid: number, ask: number} | null> {
  let cleanSym = symbol.replace('/', '').toUpperCase();
  if (!cleanSym.endsWith('USDT')) cleanSym = cleanSym + 'USDT';

  // 1. Redis cache
  try {
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();
    const cached = await redis.hget('market:quotes', cleanSym);
    if (cached) {
      const q = JSON.parse(cached);
      if (q && q.last_price !== undefined) {
        return {
          ltp: Number(q.last_price),
          bid: Number(q.bid || q.last_price * 0.9995),
          ask: Number(q.ask || q.last_price * 1.0005)
        };
      }
    }
  } catch { /* fall through */ }

  // 2. Ticker Daemon
  try {
    const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
    const params = new URLSearchParams({ symbols: cleanSym });
    const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
    if (resTicker.ok) {
      const json = await resTicker.json();
      if (json.success && json.data && json.data[cleanSym]) {
        const q = json.data[cleanSym];
        return {
          ltp: Number(q.last_price),
          bid: Number(q.bid || q.last_price * 0.9995),
          ask: Number(q.ask || q.last_price * 1.0005)
        };
      }
    }
  } catch { /* fall through */ }

  // 3. Direct Binance REST fallback
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.price) {
      const ltp = parseFloat(data.price);
      return { ltp, bid: ltp * 0.9995, ask: ltp * 1.0005 };
    }
    return null;
  } catch (err) {
    console.error('[fetchBinanceLtp] Error:', err);
    return null;
  }
}

/**
 * Fetch LTP for any instrument — routes to Binance for CRYPTO, Kite for everything else.
 */
async function fetchLtp(symbol: string, settlement: string): Promise<{ltp: number, bid: number, ask: number} | null> {
  if ((settlement || '').toUpperCase().includes('CRYPTO')) {
    return fetchBinanceLtp(symbol);
  }
  let fullSymbol = symbol;
  if (!symbol.includes(':')) {
    let exchange = 'NSE';
    const s = settlement.toUpperCase();
    if (s.includes('MCX')) exchange = 'MCX';
    else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
    else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
    else if (s.includes('BSE')) exchange = 'BSE';
    fullSymbol = `${exchange}:${symbol}`;
  }
  return fetchKiteLtp(fullSymbol);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  const clonedRequest = request.clone();
  
  let payload: any = null;
  try {
    payload = await clonedRequest.json();
  } catch {}

  const response = await handleClosePosition(request, params, ipAddress);

  let errorMessage: string | null = null;
  if (!response.ok) {
    try {
      const errorData = await response.clone().json();
      errorMessage = errorData.error || errorData.message || 'Unknown error';
    } catch {
      errorMessage = 'Failed to parse error response';
    }
  }

  logAction({
    actionType: 'CLOSE_POSITION',
    module: 'TRADING',
    apiEndpoint: '/api/positions/[id]/close',
    httpMethod: 'POST',
    ipAddress,
    requestPayload: payload,
    responseStatus: response.status,
    isSuccess: response.ok,
    errorMessage,
  });

  return response;
}

async function handleClosePosition(
  request: NextRequest,
  params: { id: string },
  clientIp: string
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: positionId } = params;
  if (!positionId) {
    return NextResponse.json({ error: 'Missing position id' }, { status: 400 });
  }

  const admin = getAdminClient();

  let body: any = {};
  try {
    body = await request.json();
  } catch {}

  const speculativeSymbol = body.symbol || '';
  const speculativeSegment = body.settlement || '';
  const speculativeSide = body.side || '';
  const clientPrice = body.client_price ? Number(body.client_price) : undefined;

  let segmentId = 'nse';
  if (speculativeSymbol || speculativeSegment) {
    const ex = (speculativeSymbol.includes(':') ? speculativeSymbol.split(':')[0] : 'NSE').toUpperCase();
    const segUpper = speculativeSegment.toUpperCase();
    if (ex === 'MCX' || segUpper.includes('MCX')) segmentId = 'mcx';
    else if (ex === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
    else if (ex === 'CDS' || ex === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
    else if (ex === 'COMEX' || segUpper.includes('COMEX')) segmentId = 'comex';
  }

  // 1. MASSIVE PARALLEL FETCH (Speculative)
  const [posResult, profileResult, hrResult, segSettingResult, kiteLtp] = await Promise.all([
    admin.from('positions').select('*').eq('id', positionId).eq('user_id', user.id).eq('status', 'open').single(),
    admin.from('profiles').select('parent_id, trading_mode').eq('id', user.id).single(),
    (!speculativeSegment.toUpperCase().includes('CRYPTO')) 
        ? admin.from('trading_hours').select('name, start_time, end_time, is_active').eq('id', segmentId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    // Initial speculative fetch: use child settings as a best-effort guess.
    admin.from('segment_settings').select('exit_buffer, profit_hold_sec, loss_hold_sec, entry_buffer, commission_type, commission_value, carry_commission_type, carry_commission_value')
        .eq('user_id', user.id)
        .eq('segment', speculativeSegment)
        .eq('side', speculativeSide)
        .maybeSingle(),
    (clientPrice ? Promise.resolve(null) : fetchLtp(speculativeSymbol, speculativeSegment))
  ]);

  const { data: pos, error: posErr } = posResult;
  if (posErr || !pos) {
    return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
  }

  // Verify speculative parameters (fallback if mismatched)
  let finalHrResult = hrResult;
  let finalSegSettingResult = segSettingResult;
  let finalKiteLtp = kiteLtp;

  if (pos.symbol !== speculativeSymbol || pos.settlement !== speculativeSegment || pos.side !== speculativeSide) {
    // Fallback to sequential if the UI didn't provide body or they mismatched
    console.log('[POST /positions/close] Speculative fetch mismatched, falling back to sequential.');
    let actualSegId = 'nse';
    const ex2 = (pos.symbol.includes(':') ? pos.symbol.split(':')[0] : 'NSE').toUpperCase();
    const segUp = (pos.settlement || '').toUpperCase();
    if (ex2 === 'MCX' || segUp.includes('MCX')) actualSegId = 'mcx';
    else if (ex2 === 'BSE' || segUp.includes('BSE') || segUp.includes('BFO')) actualSegId = 'bse';
    else if (ex2 === 'CDS' || ex2 === 'FOREX' || segUp.includes('CDS') || segUp.includes('FOREX')) actualSegId = 'forex';
    else if (ex2 === 'COMEX' || segUp.includes('COMEX')) actualSegId = 'comex';

    const lookupId = profileResult.data?.parent_id ?? user.id;
    const targetTable = profileResult.data?.trading_mode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

    const [realHr, realSeg, realLtp] = await Promise.all([
      (!segUp.includes('CRYPTO'))
        ? admin.from('trading_hours').select('name, start_time, end_time, is_active').eq('id', actualSegId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      admin.from(targetTable)
          .select('exit_buffer, profit_hold_sec, loss_hold_sec, entry_buffer, commission_type, commission_value, carry_commission_type, carry_commission_value')
          .eq('user_id', lookupId)
          .eq('segment', pos.settlement ?? '')
          .eq('side', pos.side)
          .maybeSingle(),
      (clientPrice ? Promise.resolve(null) : fetchLtp(pos.symbol, pos.settlement ?? ''))
    ]);
    finalHrResult = realHr;
    finalSegSettingResult = realSeg;
    finalKiteLtp = realLtp;
  }

  // Check market hours
  try {
    const segmentHour = finalHrResult?.data;
    if (segmentHour) {
      if (!segmentHour.is_active) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const currentHHMM = `${String(nowIST.getHours()).padStart(2, '0')}:${String(nowIST.getMinutes()).padStart(2, '0')}`;
      if (currentHHMM < segmentHour.start_time || currentHHMM >= segmentHour.end_time) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
    }
  } catch (err) {
    console.error('[POST /api/positions/[id]/close] Market hours check error:', err);
  }

  const { data: segSetting } = finalSegSettingResult;
  const profitHoldSec = segSetting?.profit_hold_sec ?? 120;
  const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

  const baseLtp = finalKiteLtp?.ltp ?? clientPrice ?? Number(pos.ltp ?? pos.entry_price);
  const kiteBid = finalKiteLtp?.bid ?? clientPrice ?? baseLtp;
  const kiteAsk = finalKiteLtp?.ask ?? clientPrice ?? baseLtp;

  // Exit price: exit_buffer applied to the live bid/ask (precision 2 for display/settlement)
  const exitBuffer = segSetting?.exit_buffer ?? 0.17;
  const refPrice = pos.side === 'BUY' ? kiteBid : kiteAsk;
  const exitPrice = calculateExitPrice({ side: pos.side, ltp: refPrice, exitBufferPct: exitBuffer }, 2);

  // ─── Anti-Scalping Check ───
  // Profit/loss determined by comparing live LTP to the buffered entry_price
  // (what the user actually paid). This matches what is displayed on screen —
  // if the user sees a negative P&L, they can exit immediately.
  const pnlValue = pos.side === 'BUY'
    ? (baseLtp - Number(pos.entry_price)) * Number(pos.qty_open)
    : (Number(pos.entry_price) - baseLtp) * Number(pos.qty_open);

  const durationSec = pos.entry_time ? Math.floor((Date.now() - new Date(pos.entry_time).getTime()) / 1000) : 0;
  const requiredHold = pnlValue > 0 ? profitHoldSec : lossHoldSec;

  if (pos.entry_time && durationSec < requiredHold) {
    return NextResponse.json({
      error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
    }, { status: 403 });
  }

  // --- CARRY BROKERAGE (deferred from entry to exit) ---
  // Intraday brokerage was already charged at entry time (×2).
  // Carry brokerage is only charged at exit if the position is currently CARRY.
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

  // Carry brokerage is always charged at exit for CARRY positions.
  // Conversions no longer deduct it upfront, so there's no need to check for CARRY_CONV txs.

  // Call the atomic RPC
  const { data: pnl, error: rpcErr } = await admin.rpc('close_position_v2', {
    p_position_id:        positionId,
    p_close_qty:          Number(pos.qty_open),
    p_close_price:        exitPrice,
    p_closed_by:          'USER',
    p_expected_brokerage: carryBrokerage,
  });

  if (rpcErr) {
    console.error('[POST /api/positions/[id]/close] RPC error:', rpcErr);
    return NextResponse.json({ error: 'Failed to close position. Please try again.' }, { status: 500 });
  }

  // Exit order history is now recorded atomically inside close_position_v2.
  // No direct orders table mutation needed here.

  const response: ClosePositionResponse = {
    pnl:        Number(pnl),
    exit_price: exitPrice,
    message:    `Position closed at ₹${exitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. P&L: ₹${Number(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  };

  return NextResponse.json(response, { status: 200 });
}

