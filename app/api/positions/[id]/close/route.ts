/**
 * POST /api/positions/[id]/close
 *
 * Closes an open position for the authenticated user.
 * - Fetches LTP server-side (Ticker Daemon → Kite REST / Binance)
 * - Applies exit_buffer from segment_settings using the original formula:
 *     BUY  exit: (ltp × 0.999) × (1 − buyExitBuffer)
 *     SELL exit: (ltp × 1.001) × (1 + sellExitBuffer)
 * - Calls close_position() Postgres RPC atomically
 * - Logs the action for audit trail
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import type { ClosePositionResponse } from '@/lib/types/order';
import { logAction, extractClientIp } from '@/lib/actionLogger';

// ─── LTP Fetchers ─────────────────────────────────────────────────────────────

async function fetchKiteLtp(instrument: string): Promise<number | null> {
  try {
    const admin = getAdminClient();

    // 1. Ticker Daemon in-memory quotes (fast path)
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL ||
        (process.env.NODE_ENV === 'production'
          ? 'https://marginapexx-production.up.railway.app'
          : 'http://localhost:8080');
      const params = new URLSearchParams({ symbols: instrument });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(100),
      });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data?.[instrument]) {
          return Number(json.data[instrument].last_price);
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchKiteLtp] Ticker Daemon failed, falling back to REST:', tickerErr);
    }

    // 2. On-demand Kite REST fallback
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
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = await res.json() as { data?: Record<string, { last_price: number; instrument_token?: number }> };
    const quote = data.data?.[instrument];
    if (!quote) return null;

    // Background instrument cache
    (async () => {
      try {
        const parts = instrument.split(':');
        const exchange = parts[0] || 'NSE';
        const tradingsymbol = parts[1] || '';
        await admin.from('instruments').upsert({
          id: instrument,
          instrument_token: quote.instrument_token || 0,
          tradingsymbol,
          exchange,
          instrument_type: ['NFO', 'MCX', 'CDS'].includes(exchange) ? 'FUTOPT' : 'EQ',
          segment: exchange,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
      } catch { /* non-critical */ }
    })();

    return quote.last_price;
  } catch (err) {
    console.error('[fetchKiteLtp] Unexpected error:', err);
    return null;
  }
}

async function fetchBinanceLtp(symbol: string): Promise<number | null> {
  let cleanSym = symbol.replace('/', '').toUpperCase();
  if (!cleanSym.endsWith('USDT')) cleanSym = cleanSym + 'USDT';

  // 1. Redis cache
  try {
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();
    const cached = await redis.hget('market:quotes', cleanSym);
    if (cached) {
      const q = JSON.parse(cached);
      if (q?.last_price !== undefined) return Number(q.last_price);
    }
  } catch { /* fall through */ }

  // 2. Ticker Daemon
  try {
    const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL ||
      (process.env.NODE_ENV === 'production'
        ? 'https://marginapexx-production.up.railway.app'
        : 'http://localhost:8080');
    const params = new URLSearchParams({ symbols: cleanSym });
    const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(500),
    });
    if (resTicker.ok) {
      const json = await resTicker.json();
      if (json.success && json.data?.[cleanSym]) {
        return Number(json.data[cleanSym].last_price);
      }
    }
  } catch { /* fall through */ }

  // 3. Direct Binance REST
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`,
      { cache: 'no-store', signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (err) {
    console.error('[fetchBinanceLtp] Error:', err);
    return null;
  }
}

/**
 * Route LTP fetch to Binance (CRYPTO) or Kite (everything else).
 * Resolves synthetic MCX/CDS symbols (e.g. CRUDEOIL_FUT) to nearest active contract.
 */
async function fetchLtp(symbol: string, settlement: string): Promise<number | null> {
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

    // Resolve synthetic COMEX/FOREX symbols to nearest active futures contract
    if (exchange === 'MCX' || exchange === 'CDS') {
      let baseName = symbol.toUpperCase();
      if (baseName.endsWith('_FUT')) baseName = baseName.slice(0, -4);

      const cacheKey = `nearest_fut_${exchange}_${baseName}`;
      const { getRedisClient } = require('@/lib/redis');
      const redis = getRedisClient();
      let resolvedSymbol = await redis.get(cacheKey);

      if (!resolvedSymbol) {
        const admin = getAdminClient();
        const { data: nearestFut } = await admin
          .from('instruments')
          .select('tradingsymbol')
          .eq('name', baseName)
          .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
          .gte('expiry', new Date().toISOString().split('T')[0])
          .order('expiry', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (nearestFut?.tradingsymbol) {
          resolvedSymbol = nearestFut.tradingsymbol;
          await redis.setex(cacheKey, 3600, resolvedSymbol);
        }
      }

      fullSymbol = resolvedSymbol
        ? `${exchange}:${resolvedSymbol}`
        : `${exchange}:${symbol}`;
    } else {
      fullSymbol = `${exchange}:${symbol}`;
    }
  }

  return fetchKiteLtp(fullSymbol);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  const clonedRequest = request.clone();
  const { id } = await params;

  let payload: any = null;
  try { payload = await clonedRequest.json(); } catch { /* empty body */ }

  const response = await handleClosePosition(request, { id }, ipAddress);

  let errorMessage: string | null = null;
  if (!response.ok) {
    try {
      const errData = await response.clone().json();
      errorMessage = errData.error || errData.message || 'Unknown error';
    } catch { errorMessage = 'Failed to parse error response'; }
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
  clientIp: string,
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: positionId } = params;
  if (!positionId) return NextResponse.json({ error: 'Missing position id' }, { status: 400 });

  const admin = getAdminClient();

  // Read optional body hints so we can start fetching speculatively
  let body: any = {};
  try { body = await request.json(); } catch { /* no body */ }

  const speculativeSymbol  = body.symbol     || '';
  const speculativeSegment = body.settlement || '';
  const speculativeSide    = body.side       || '';
  const clientPrice        = body.client_price ? Number(body.client_price) : undefined;

  // Determine segment ID for trading hours lookup
  let segmentId = 'nse';
  if (speculativeSymbol || speculativeSegment) {
    const ex      = (speculativeSymbol.includes(':') ? speculativeSymbol.split(':')[0] : 'NSE').toUpperCase();
    const segUpper = speculativeSegment.toUpperCase();
    if (ex === 'MCX' || segUpper.includes('MCX'))                               segmentId = 'mcx';
    else if (ex === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
    else if (ex === 'CDS' || ex === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
    else if (ex === 'COMEX' || segUpper.includes('COMEX'))                      segmentId = 'comex';
  }

  // 1. Parallel fetch — position, profile, market hours, LTP all at once
  const [posResult, profileResult, hrResult, ltpResult] = await Promise.all([
    admin.from('positions').select('*').eq('id', positionId).eq('user_id', user.id).eq('status', 'open').single(),
    admin.from('profiles').select('parent_id, trading_mode').eq('id', user.id).single(),
    !speculativeSegment.toUpperCase().includes('CRYPTO')
      ? admin.from('trading_hours').select('name, start_time, end_time, is_active').eq('id', segmentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    clientPrice ? Promise.resolve(null) : fetchLtp(speculativeSymbol, speculativeSegment),
  ]);

  const { data: pos, error: posErr } = posResult;
  if (posErr || !pos) {
    return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
  }

  // 2. Fetch segment settings (user first, fallback to parent)
  const profile      = profileResult.data;
  const targetTable  = profile?.trading_mode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

  let segSettingResult = await admin
    .from(targetTable)
    .select('exit_buffer, profit_hold_sec, loss_hold_sec, commission_type, commission_value, carry_commission_type, carry_commission_value')
    .eq('user_id', user.id)
    .eq('segment', pos.settlement ?? '')
    .eq('side', pos.side)
    .maybeSingle();

  if ((segSettingResult.error || !segSettingResult.data) && profile?.parent_id) {
    segSettingResult = await admin
      .from(targetTable)
      .select('exit_buffer, profit_hold_sec, loss_hold_sec, commission_type, commission_value, carry_commission_type, carry_commission_value')
      .eq('user_id', profile.parent_id)
      .eq('segment', pos.settlement ?? '')
      .eq('side', pos.side)
      .maybeSingle();
  }

  // 3. If speculative params didn't match the actual position, re-fetch LTP correctly
  let finalHrResult      = hrResult;
  let finalLtp: number | null = ltpResult;

  if (
    pos.symbol     !== speculativeSymbol  ||
    pos.settlement !== speculativeSegment ||
    pos.side       !== speculativeSide
  ) {
    console.log('[POST /positions/[id]/close] Speculative fetch mismatched, re-fetching for actual position.');

    let actualSegId = 'nse';
    const ex2   = (pos.symbol.includes(':') ? pos.symbol.split(':')[0] : 'NSE').toUpperCase();
    const segUp = (pos.settlement || '').toUpperCase();
    if (ex2 === 'MCX' || segUp.includes('MCX'))                               actualSegId = 'mcx';
    else if (ex2 === 'BSE' || segUp.includes('BSE') || segUp.includes('BFO')) actualSegId = 'bse';
    else if (ex2 === 'CDS' || ex2 === 'FOREX' || segUp.includes('CDS') || segUp.includes('FOREX')) actualSegId = 'forex';
    else if (ex2 === 'COMEX' || segUp.includes('COMEX'))                      actualSegId = 'comex';

    const [realHr, realLtp] = await Promise.all([
      !segUp.includes('CRYPTO')
        ? admin.from('trading_hours').select('name, start_time, end_time, is_active').eq('id', actualSegId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      clientPrice ? Promise.resolve(null) : fetchLtp(pos.symbol, pos.settlement ?? ''),
    ]);

    finalHrResult = realHr;
    finalLtp      = realLtp;
  }

  // 4. Market hours check
  try {
    const segmentHour = finalHrResult?.data;
    if (segmentHour) {
      if (!segmentHour.is_active) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const dayOfWeek = nowIST.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
      const currentHHMM = `${String(nowIST.getHours()).padStart(2, '0')}:${String(nowIST.getMinutes()).padStart(2, '0')}`;
      if (currentHHMM < segmentHour.start_time || currentHHMM >= segmentHour.end_time) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
    }
  } catch (err) {
    console.error('[POST /api/positions/[id]/close] Market hours check error:', err);
  }

  const { data: segSetting } = segSettingResult;
  // exit_buffer is stored in decimal form in DB (e.g. 0.0017 = 0.17%), use directly
  const exitBuffer    = Number(segSetting?.exit_buffer ?? 0.0017);
  const profitHoldSec = segSetting?.profit_hold_sec ?? 120;
  const lossHoldSec   = segSetting?.loss_hold_sec   ?? 0;

  const baseLtp = finalLtp ?? clientPrice ?? Number(pos.ltp ?? pos.entry_price);

  // 5. Exit price — use LTP directly with exit buffer
  // This ensures closed P&L matches live P&L calculation
  let exitPrice: number;

  // Apply exit buffer to LTP (both BUY and SELL use LTP directly)
  if (pos.side === 'BUY') {
    // Closing a long → use LTP with buffer
    // Formula: ltp * (1 - exitBuffer)
    exitPrice = baseLtp * (1 - exitBuffer);
  } else {
    // Closing a short → use LTP with buffer
    // Formula: ltp * (1 + exitBuffer)
    exitPrice = baseLtp * (1 + exitBuffer);
  }
  exitPrice = Math.round(exitPrice * 100) / 100;

  // 6. Anti-scalping check — P&L estimated against buffered exit price
  const pnlValue = pos.side === 'BUY'
    ? (exitPrice - Number(pos.entry_price)) * Number(pos.qty_open)
    : (Number(pos.entry_price) - exitPrice) * Number(pos.qty_open);

  const durationSec = pos.entry_time
    ? Math.floor((Date.now() - new Date(pos.entry_time).getTime()) / 1000)
    : 0;
  const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

  if (pos.entry_time && durationSec < requiredHold) {
    return NextResponse.json({
      error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
    }, { status: 403 });
  }

  // 7. Carry brokerage — only charged at exit for CARRY positions (not paid yet at entry)
  let carryBrokerage = 0;
  if (!pos.carry_brokerage_paid) {
    carryBrokerage = calculateCarryBrokerage({
      productType:         pos.product_type,
      qty:                 Number(pos.qty_open),
      entryPrice:          Number(pos.entry_price),
      lots:                Number(pos.lots || 0) || undefined,
      carryCommissionType: segSetting?.carry_commission_type,
      carryCommissionValue: segSetting?.carry_commission_value != null
        ? Number(segSetting.carry_commission_value) : null,
      commissionType:  segSetting?.commission_type,
      commissionValue: segSetting?.commission_value != null
        ? Number(segSetting.commission_value) : null,
    });
  }

  // 8. Atomic RPC — close position, record exit order, write P&L transaction
  const { data: pnl, error: rpcErr } = await admin.rpc('close_position', {
    p_position_id: positionId,
    p_user_id:     user.id,
    p_ltp:         baseLtp,
    p_exit_price:  exitPrice,
    p_closed_by:   'USER',
  });

  if (rpcErr) {
    console.error('[POST /api/positions/[id]/close] RPC error:', rpcErr);
    return NextResponse.json({ error: 'Failed to close position. Please try again.' }, { status: 500 });
  }

  const response: ClosePositionResponse = {
    pnl:        Number(pnl),
    exit_price: exitPrice,
    message:    `Position closed at ₹${exitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. P&L: ₹${Number(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  };

  return NextResponse.json(response, { status: 200 });
}
