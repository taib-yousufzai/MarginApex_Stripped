/**
 * Internal Order API — MarginApex platform orders
 *
 * GET  /api/orders          → user's own order history (from Supabase)
 * POST /api/orders          → place a new order through MarginApex
 *
 * All order placement runs through this endpoint. Zerodha is NEVER called
 * to place orders — it is used read-only to fetch the LTP for fill price
 * computation only.
 *
 * Fill price = Kite LTP ± segment_settings.entry_buffer / exit_buffer
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { positionStore, parseOptionSymbol } from '../../../lib/positionStore';
import type {
  PlaceOrderRequest,
  PlaceOrderResponse,
  MyOrder,
} from '@/lib/types/order';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the Binance LTP for a crypto symbol.
 */
async function fetchBinanceQuote(symbol: string): Promise<number | null> {
  try {
    let cleanSym = symbol.replace('/', '').toUpperCase();
    if (!cleanSym.endsWith('USDT')) {
      cleanSym = cleanSym + 'USDT';
    }
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`, {
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (err) {
    console.error('[fetchBinanceQuote] Error:', err);
    return null;
  }
}

/**
 * Fetch the Kite LTP for one or more instruments server-side.
 * Resolves from local market_quotes DB cache first, falling back on-demand.
 * Returns a map of instrument -> last_price.
 */
async function fetchKiteQuotes(instruments: string[]): Promise<Record<string, number>> {
  if (instruments.length === 0) return {};
  const result: Record<string, number> = {};
  const foundKiteIds = new Set<string>();

  try {
    const admin = getAdminClient();

    // 1. Fetch available quotes from Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || 'http://localhost:8080';
      const params = new URLSearchParams({ symbols: instruments.join(',') });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store' });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data) {
          for (const [key, val] of Object.entries(json.data)) {
            result[key] = (val as any).last_price;
            foundKiteIds.add(key);
          }
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchKiteQuotes] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. Identify missing instruments
    const missingKiteIds = instruments.filter(id => !foundKiteIds.has(id));

    // 3. Fallback on-demand fetch from Kite REST API for missing instruments only
    if (missingKiteIds.length > 0) {
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return result;
      const session = await getSharedKiteSession();
      if (!session) return result;

      const params = new URLSearchParams();
      missingKiteIds.forEach(i => params.append('i', i));

      const res = await fetch(`https://api.kite.trade/quote?${params}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${session.accessToken}`,
        },
        cache: 'no-store',
      });

      if (!res.ok) return result;

      const data = await res.json() as { data?: Record<string, { last_price: number; instrument_token?: number; ohlc?: { close?: number } }> };
      const instrumentUpserts: any[] = [];

      for (const inst of missingKiteIds) {
        const quote = data.data?.[inst];
        if (quote) {
          result[inst] = quote.last_price;

          const parts = inst.split(':');
          const exchange = parts[0] || 'NSE';
          const tradingsymbol = parts[1] || '';

          instrumentUpserts.push({
            id: inst,
            instrument_token: quote.instrument_token || 0,
            tradingsymbol,
            exchange,
            instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
            segment: exchange,
            updated_at: new Date().toISOString()
          });
        }
      }

      // Cache missing instruments in background (excluding raw ticks)
      if (instrumentUpserts.length > 0) {
        (async () => {
          try {
            await admin.from('instruments').upsert(instrumentUpserts, { onConflict: 'id' });
          } catch (err) {
            console.error('[fetchKiteQuotes] Background cache error:', err);
          }
        })();
      }
    }

    return result;
  } catch (err) {
    console.error('[fetchKiteQuotes] Error:', err);
    return result;
  }
}

/**
 * Map UI display segment to database segment key.
 */
function mapSegmentToDbSegment(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity') return 'NSE-EQ';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  return trimmed;
}

function getLotSize(symbol: string, dbSettings?: { symbol: string; lot_size: number }[]): number {
  const n = symbol.toUpperCase();
  if (dbSettings && Array.isArray(dbSettings)) {
    const match = dbSettings.find(s => n.includes(s.symbol.toUpperCase()) || s.symbol.toUpperCase().includes(n));
    if (match) return Number(match.lot_size);
  }
  if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 15;
  if (n.includes('FINNIFTY')) return 40;
  if (n.includes('MIDCP') || n.includes('MIDCAP')) return 75;
  if (n.includes('SENSEX')) return 10;
  if (n.includes('NIFTY')) return 25;
  return 1;
}

function mapSymbolToSegment(symbol: string): string {
  const n = symbol.toUpperCase();
  if (n.includes('FUT') || n.includes('FUTURES')) {
    if (n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP')) {
      return 'INDEX-FUT';
    }
    return 'STOCK-FUT';
  }
  if (n.includes('CE') || n.includes('PE')) {
    if (n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP')) {
      return 'INDEX-OPT';
    }
    return 'STOCK-OPT';
  }
  return 'NSE-EQ'; // fallback default
}

// ─── GET /api/orders ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = getAdminClient();
    const { searchParams } = request.nextUrl;
    const page  = parseInt(searchParams.get('page')  ?? '1',  10);
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    // Fetch orders and open positions in parallel
    const [ordersRes, posRes] = await Promise.all([
      admin
        .from('orders')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, to),
      admin
        .from('positions')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'open')
    ]);

    if (ordersRes.error) throw ordersRes.error;

    const dbOrders = ordersRes.data ?? [];
    const openPositions = posRes.data ?? [];

    const orders: MyOrder[] = dbOrders.map((r: Record<string, unknown>) => ({
      id:           r.id as string,
      symbol:       r.symbol as string,
      segment:      (r.segment as string) ?? '',
      side:         r.side as 'BUY' | 'SELL',
      status:       r.status as MyOrder['status'],
      qty:          Number(r.qty),
      lots:         Number(r.lots ?? 0),
      fill_price:   Number(r.fill_price ?? r.price),
      ltp_at_entry: Number(r.ltp_at_entry ?? 0),
      order_type:   (r.order_type as MyOrder['order_type']) ?? 'MARKET',
      product_type: (r.product_type as MyOrder['product_type']) ?? 'INTRADAY',
      info:         (r.info as string) ?? null,
      brokerage:    Number(r.brokerage ?? 0),
      client_price: r.client_price !== null ? Number(r.client_price) : undefined,
      trigger_price: r.trigger_price !== null ? Number(r.trigger_price) : undefined,
      stop_loss:    r.stop_loss !== null ? Number(r.stop_loss) : undefined,
      target:       r.target !== null ? Number(r.target) : undefined,
      created_at:   r.created_at as string,
    }));

    // Dynamically synthesize virtual pending orders for positions with SL/Target
    const virtualOrders: MyOrder[] = [];
    for (const pos of openPositions) {
      const stopLoss = pos.stop_loss ? Number(pos.stop_loss) : (pos.sl ? Number(pos.sl) : null);
      const target = pos.target ? Number(pos.target) : (pos.tp ? Number(pos.tp) : null);

      if (stopLoss !== null && stopLoss > 0) {
        virtualOrders.push({
          id: `pos-sl-${pos.id}`,
          symbol: pos.symbol,
          segment: pos.settlement || '',
          side: pos.side === 'BUY' ? 'SELL' : 'BUY', // Stop loss exit is opposite side
          status: 'PENDING',
          qty: Number(pos.qty_open),
          lots: Number(pos.lots ?? 0) || (pos.qty_open > 0 ? 1 : 0),
          fill_price: stopLoss,
          ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
          order_type: 'SL',
          product_type: (pos.product_type as any) ?? 'INTRADAY',
          info: 'Stop Loss (Exit)',
          brokerage: 0,
          trigger_price: stopLoss,
          stop_loss: stopLoss,
          created_at: pos.created_at || new Date().toISOString(),
        });
      }

      if (target !== null && target > 0) {
        virtualOrders.push({
          id: `pos-target-${pos.id}`,
          symbol: pos.symbol,
          segment: pos.settlement || '',
          side: pos.side === 'BUY' ? 'SELL' : 'BUY', // Target exit is opposite side
          status: 'PENDING',
          qty: Number(pos.qty_open),
          lots: Number(pos.lots ?? 0) || (pos.qty_open > 0 ? 1 : 0),
          fill_price: target,
          ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
          order_type: 'LIMIT',
          product_type: (pos.product_type as any) ?? 'INTRADAY',
          info: 'Target (Exit)',
          brokerage: 0,
          client_price: target,
          target: target,
          created_at: pos.created_at || new Date().toISOString(),
        });
      }
    }

    // Combine and sort by created_at descending (so latest is at top)
    const combinedOrders = [...virtualOrders, ...orders];
    combinedOrders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({ orders: combinedOrders, page, limit });
  } catch (err) {
    console.error('[GET /api/orders]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST /api/orders ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse body
  let body: PlaceOrderRequest;
  try {
    body = await request.json() as PlaceOrderRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { symbol, kite_instrument, segment, side, order_type, product_type, qty, lots, client_price, trigger_price, stop_loss, target, is_exit } = body;

  // 3. Basic field validation
  if (!symbol || !side || !qty || !segment) {
    return NextResponse.json({ error: 'Missing required fields: symbol, side, qty, segment' }, { status: 400 });
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return NextResponse.json({ error: 'Invalid side' }, { status: 400 });
  }
  if (qty <= 0) {
    return NextResponse.json({ error: 'Quantity must be positive' }, { status: 400 });
  }

  const dbSegment = mapSegmentToDbSegment(segment);
  const admin = getAdminClient();

  // Check market hours
  try {
    const exchangeName = symbol.includes(':') ? symbol.split(':')[0] : 'NSE';
    const ex = exchangeName.toUpperCase();
    const segUpper = dbSegment.toUpperCase();

    if (!segUpper.includes('CRYPTO')) {
      let segmentId = 'nse';
      if (ex === 'MCX' || segUpper.includes('MCX')) segmentId = 'mcx';
      else if (ex === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
      else if (ex === 'CDS' || ex === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
      else if (ex === 'COMEX' || segUpper.includes('COMEX')) segmentId = 'comex';

      const { data: segmentHour, error: hrError } = await admin
        .from('trading_hours')
        .select('name, start_time, end_time, is_active')
        .eq('id', segmentId)
        .maybeSingle();

      if (!hrError && segmentHour) {
        if (!segmentHour.is_active) {
          return NextResponse.json({ error: 'market is closed' }, { status: 400 });
        }

        const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const dayOfWeek = nowIST.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        if (isWeekend) {
          return NextResponse.json({ error: 'market is closed' }, { status: 400 });
        }

        const currentHHMM = `${String(nowIST.getHours()).padStart(2, '0')}:${String(nowIST.getMinutes()).padStart(2, '0')}`;
        if (currentHHMM < segmentHour.start_time || currentHHMM >= segmentHour.end_time) {
          return NextResponse.json({ error: 'market is closed' }, { status: 400 });
        }
      }
    }
  } catch (err) {
    console.error('[POST /api/orders] Market hours check error:', err);
  }

  const kiteInst = kite_instrument || symbol;

  // Identify all instruments needed for this order to batch the Kite API call
  const instrumentsToFetch = [kiteInst];
  const isOption = dbSegment.includes('OPT');
  const underlyingId = dbSegment.includes('BANK') ? 'NSE:NIFTY BANK' : 'NSE:NIFTY 50';
  if (isOption && underlyingId !== kiteInst) {
    instrumentsToFetch.push(underlyingId);
  }

  // 4-6 + 8-9: Run all independent DB queries AND the Kite LTP fetch in parallel.
  // This is the key optimization — previously these were sequential (~4 round-trips).
  const [profileResult, segSettingsResult, scalperSegSettingsResult, positionsResult, quotesMap, scriptSettingsResult] = await Promise.all([
    // Profile
    admin.from('profiles')
      .select('id, active, read_only, segments, parent_id, balance, trading_mode')
      .eq('id', user.id)
      .single(),

    // Segment settings (we don't know parent_id yet, so we'll refetch if needed)
    admin.from('segment_settings')
      .select('*')
      .eq('user_id', user.id)
      .eq('segment', dbSegment),

    // Scalper segment settings
    admin.from('scalper_segment_settings')
      .select('*')
      .eq('user_id', user.id)
      .eq('segment', dbSegment),

    // Fetch active positions to verify total open lot limits (max_lot)
    admin.from('positions')
      .select('id, symbol, qty_open, status, entry_price, side, product_type, entry_time')
      .eq('user_id', user.id)
      .in('status', ['open', 'OPEN', 'active', 'ACTIVE']),

    // Fetch quotes — either Kite or Binance depending on segment
    (async () => {
      if (dbSegment === 'CRYPTO') {
        const price = await fetchBinanceQuote(symbol);
        return price ? { [kiteInst]: price } : {};
      } else {
        return fetchKiteQuotes(instrumentsToFetch);
      }
    })(),

    // Fetch script settings for dynamic lot size
    admin.from('script_settings')
      .select('symbol, lot_size'),
  ]);

  const profile = profileResult.data;
  const profileErr = profileResult.error;
  const openPositions = positionsResult?.data ?? [];
  const kiteLtp = quotesMap[kiteInst] ?? null;
  const dbScriptSettings = (scriptSettingsResult?.data as any[]) ?? [];

  // 4. Profile checks
  if (profileErr || !profile) {
    return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
  }
  if (!profile.active) {
    return NextResponse.json({ error: 'Account is inactive' }, { status: 403 });
  }
  if (profile.read_only) {
    return NextResponse.json({ error: 'Account is in read-only mode' }, { status: 403 });
  }

  // 5. Segment permission check
  const allowedSegments: string[] = profile.segments ?? [];
  if (allowedSegments.length > 0 && !allowedSegments.includes(dbSegment)) {
    return NextResponse.json({ error: `Trading not allowed in segment: ${segment}` }, { status: 403 });
  }

  // 6. Segment settings — choose based on active trading mode
  const isScalper = profile.trading_mode === 'scalper';
  const settingsList = isScalper ? (scalperSegSettingsResult.data || []) : (segSettingsResult.data || []);

  let buySetting = settingsList.find((s: any) => s.side === 'BUY');
  let sellSetting = settingsList.find((s: any) => s.side === 'SELL');

  if ((!buySetting || !sellSetting) && profile.parent_id && profile.parent_id !== user.id) {
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
    const { data } = await admin
      .from(targetTable)
      .select('*')
      .eq('user_id', profile.parent_id)
      .eq('segment', dbSegment);
    if (data) {
      if (!buySetting) buySetting = data.find((s: any) => s.side === 'BUY');
      if (!sellSetting) sellSetting = data.find((s: any) => s.side === 'SELL');
    }
  }

  // If there are still no settings in database, construct safety fallback defaults based on segment
  const segUpper = dbSegment.toUpperCase();
  let intraday_leverage = 50;
  let holding_leverage = 5;
  if (segUpper.includes('FOREX') || segUpper.includes('CDS')) {
    intraday_leverage = 100;
    holding_leverage = 10;
  } else if (segUpper.includes('CRYPTO')) {
    intraday_leverage = 10;
    holding_leverage = 1;
  }

  if (!buySetting) {
    buySetting = {
      id: '',
      user_id: user.id,
      segment: dbSegment,
      side: 'BUY',
      trade_allowed: !dbSegment.toUpperCase().includes('CRYPTO'),
      max_lot: 50,
      max_order_lot: 50,
      intraday_leverage,
      holding_leverage,
      intraday_type: 'Multiplier',
      holding_type: 'Multiplier',
      entry_buffer: 0.003,
      exit_buffer: 0.0017,
      strike_range: 0,
      commission_type: 'Per Crore',
      commission_value: isScalper ? 8500 : (segUpper.includes('FOREX') || segUpper.includes('CDS') ? 2000 : (segUpper.includes('CRYPTO') ? 1000 : 4500)),
      top_limit: 0,
      min_limit: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  if (!sellSetting) {
    sellSetting = {
      id: '',
      user_id: user.id,
      segment: dbSegment,
      side: 'SELL',
      trade_allowed: !dbSegment.toUpperCase().includes('CRYPTO'),
      max_lot: 50,
      max_order_lot: 50,
      intraday_leverage,
      holding_leverage,
      intraday_type: 'Multiplier',
      holding_type: 'Multiplier',
      entry_buffer: 0.003,
      exit_buffer: 0.0017,
      strike_range: 0,
      commission_type: 'Per Crore',
      commission_value: isScalper ? 8500 : (segUpper.includes('FOREX') || segUpper.includes('CDS') ? 2000 : (segUpper.includes('CRYPTO') ? 1000 : 4500)),
      top_limit: 0,
      min_limit: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const segSetting = side === 'BUY' ? buySetting : sellSetting;

  // 7. Validate lot / qty limits & Strike Range
  if (!segSetting.trade_allowed) {
    return NextResponse.json({ error: `${side} orders not allowed in ${segment}` }, { status: 403 });
  }

  const symbolLotSize = lots > 0 ? (qty / lots) : getLotSize(symbol, dbScriptSettings);
  const maxQty = (segSetting.max_order_lot as number) * symbolLotSize;
  if (qty > maxQty) {
    return NextResponse.json({
      error: `Order exceeds maximum allowed order limit of ${segSetting.max_order_lot} lots (${maxQty} units)`,
    }, { status: 400 });
  }

  // Verify cumulative segment limits (max_lot)
  let totalOpenLots = 0;
  if (openPositions.length > 0) {
    for (const pos of openPositions) {
      const posSegment = mapSymbolToSegment(pos.symbol);
      if (posSegment === dbSegment) {
        const size = getLotSize(pos.symbol, dbScriptSettings);
        totalOpenLots += Number(pos.qty_open) / size;
      }
    }
  }

  const newOrderLots = lots > 0 ? lots : (qty / symbolLotSize);
  if (totalOpenLots + newOrderLots > (segSetting.max_lot as number)) {
    return NextResponse.json({
      error: `Order exceeds maximum segment limit of ${segSetting.max_lot} lots. Current open positions: ${totalOpenLots.toFixed(2)} lots.`,
    }, { status: 400 });
  }

  // Strike Range check — reuse the already-fetched quotes (no second Kite call)
  if (isOption && segSetting.strike_range > 0 && kiteLtp) {
    const strikePrice = parseFloat(symbol.match(/\d+/)?.[0] || '0');
    if (strikePrice > 0) {
      const spot = quotesMap[underlyingId];
      if (spot) {
        const diff = Math.abs(strikePrice - spot);
        if (diff > segSetting.strike_range) {
          return NextResponse.json({
            error: `Strike price ${strikePrice} is outside the allowed range of ${segSetting.strike_range} from spot (${spot.toFixed(2)})`,
          }, { status: 403 });
        }
      }
    }
  }

  // 8. Balance check — use the balance from the profile query
  const balance = Number(profile.balance ?? 0);
  const targetProductType = product_type ?? 'INTRADAY';
  const leverage = targetProductType === 'CARRY'
    ? (segSetting.holding_leverage ?? 1)
    : (segSetting.intraday_leverage ?? 1);
  const exposure      = qty * client_price;
  const requiredMargin = exposure / leverage;

  if (balance < requiredMargin) {
    return NextResponse.json({
      error: `Insufficient margin. Available: ₹${balance.toFixed(2)}, Required: ₹${requiredMargin.toFixed(2)}`,
    }, { status: 400 });
  }

  // 9. Fill price — use the already-fetched kiteLtp (no second Kite call)
  const baseLtp = kiteLtp ?? client_price;
  if (!baseLtp || baseLtp <= 0) {
    return NextResponse.json({ error: 'Could not determine market price. Try again.' }, { status: 503 });
  }

  // Validate Limit price constraints relative to LTP
  if (order_type === 'LIMIT') {
    if (side === 'BUY' && client_price >= baseLtp) {
      return NextResponse.json({ error: 'Limit price must be lower than the current market price (LTP).' }, { status: 400 });
    }
    if (side === 'SELL' && client_price <= baseLtp) {
      return NextResponse.json({ error: 'Limit price must be higher than the current market price (LTP).' }, { status: 400 });
    }
  } else if (order_type === 'GTT' && !is_exit) {
    if (side === 'BUY' && client_price > baseLtp) {
      return NextResponse.json({ error: 'Limit price must be lower than or equal to the current market price (LTP).' }, { status: 400 });
    }
    if (side === 'SELL' && client_price < baseLtp) {
      return NextResponse.json({ error: 'Limit price must be higher than or equal to the current market price (LTP).' }, { status: 400 });
    }
  }

  // Validate SL and SLM trigger price constraints relative to LTP
  if (order_type === 'SL' || order_type === 'SLM') {
    const trigPrice = trigger_price ? parseFloat(trigger_price.toString()) : null;
    if (trigPrice !== null && !isNaN(trigPrice)) {
      if (is_exit) {
        // Exit stop loss order:
        // - Exiting LONG (SELL order): trigger price must be below market price (LTP) to act as stop loss
        // - Exiting SHORT (BUY order): trigger price must be above market price (LTP) to act as stop loss
        if (side === 'BUY' && trigPrice <= baseLtp) {
          return NextResponse.json({ error: 'Stop loss trigger price must be above the current market price for short exits.' }, { status: 400 });
        }
        if (side === 'SELL' && trigPrice >= baseLtp) {
          return NextResponse.json({ error: 'Stop loss trigger price must be below the current market price for long exits.' }, { status: 400 });
        }
      } else {
        // Entry order:
        // - SLM entry on MarginApex executes immediately as a MARKET order and sets the trigger price as the position's stop loss.
        //   Thus, BUY SLM = LONG position (SL below market), SELL SLM = SHORT position (SL above market).
        // - SL entry is a pending breakout order.
        //   Thus, BUY SL = pending buy above market, SELL SL = pending sell below market.
        if (order_type === 'SLM') {
          if (side === 'BUY' && trigPrice >= baseLtp) {
            return NextResponse.json({ error: 'Stop loss price must be below the current market price.' }, { status: 400 });
          }
          if (side === 'SELL' && trigPrice <= baseLtp) {
            return NextResponse.json({ error: 'Stop loss price must be above the current market price.' }, { status: 400 });
          }
        } else { // SL order type
          if (side === 'BUY' && trigPrice <= baseLtp) {
            return NextResponse.json({ error: 'Trigger price must be above the current market price for stop limit buy.' }, { status: 400 });
          }
          if (side === 'SELL' && trigPrice >= baseLtp) {
            return NextResponse.json({ error: 'Trigger price must be below the current market price for stop limit sell.' }, { status: 400 });
          }
        }
      }
    }
  }

  // Validate Target and Stop Loss rules
  const orderTarget = target ? parseFloat(target.toString()) : null;
  const orderSL = stop_loss ? parseFloat(stop_loss.toString()) : null;
  const refPrice = ['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET') ? client_price : baseLtp;

  // Resolve reference entry price and position side (Long vs Short)
  const activePosition = openPositions.find(
    (p: any) => p.symbol === symbol && p.product_type === targetProductType
  );

  const refEntry = (is_exit && activePosition) ? Number(activePosition.entry_price) : refPrice;
  const isLong = (is_exit && activePosition) ? (activePosition.side === 'BUY') : (side === 'BUY');

  // Enforce Anti-Scalping hold duration for manual market exits
  if (is_exit && activePosition && (order_type === 'MARKET' || order_type === 'SLM')) {
    const exitBuffer = segSetting?.exit_buffer ?? 0.0017;
    const profitHoldSec = segSetting?.profit_hold_sec ?? 120;
    const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

    let estExitPrice: number;
    if (activePosition.side === 'BUY') {
      estExitPrice = baseLtp * (1 - exitBuffer);
    } else {
      estExitPrice = baseLtp * (1 + exitBuffer);
    }
    estExitPrice = Math.round(estExitPrice * 100) / 100;

    const pnlValue = activePosition.side === 'BUY'
      ? (estExitPrice - Number(activePosition.entry_price)) * Number(qty)
      : (Number(activePosition.entry_price) - estExitPrice) * Number(qty);

    const durationSec = Math.floor((Date.now() - new Date(activePosition.entry_time).getTime()) / 1000);
    const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

    if (durationSec < requiredHold) {
      return NextResponse.json({
        error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
      }, { status: 403 });
    }
  }

  if (is_exit) {
    if (isLong) {
      if (orderTarget !== null && orderTarget <= baseLtp) {
        return NextResponse.json({ error: 'Target price must be above the current market price (LTP).' }, { status: 400 });
      }
      if (orderSL !== null && orderSL >= baseLtp) {
        return NextResponse.json({ error: 'Stop loss price must be below the current market price (LTP).' }, { status: 400 });
      }
    } else {
      if (orderTarget !== null && orderTarget >= baseLtp) {
        return NextResponse.json({ error: 'Target price must be below the current market price (LTP).' }, { status: 400 });
      }
      if (orderSL !== null && orderSL <= baseLtp) {
        return NextResponse.json({ error: 'Stop loss price must be above the current market price (LTP).' }, { status: 400 });
      }
    }
  } else {
    // First-time purchase validations
    const hasLimitPrice = ['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET');
    if (isLong) {
      if (orderSL !== null) {
        if (orderSL >= baseLtp) {
          return NextResponse.json({ error: 'Stop loss price must be below the current market price (LTP).' }, { status: 400 });
        }
        if (hasLimitPrice && orderSL >= client_price) {
          return NextResponse.json({ error: 'Stop loss price must be below the limit price.' }, { status: 400 });
        }
      }
      if (orderTarget !== null && orderTarget < baseLtp) {
        return NextResponse.json({ error: 'Target price must be above or equal to the current market price (LTP).' }, { status: 400 });
      }
    } else {
      if (orderSL !== null) {
        if (orderSL <= baseLtp) {
          return NextResponse.json({ error: 'Stop loss price must be above the current market price (LTP).' }, { status: 400 });
        }
        if (hasLimitPrice && orderSL <= client_price) {
          return NextResponse.json({ error: 'Stop loss price must be above the limit price.' }, { status: 400 });
        }
      }
      if (orderTarget !== null && orderTarget > baseLtp) {
        return NextResponse.json({ error: 'Target price must be below or equal to the current market price (LTP).' }, { status: 400 });
      }
    }
  }

  // Segment Price Limits validation (top_limit and min_limit)
  const topLimit = Number(segSetting.top_limit ?? 0);
  const minLimit = Number(segSetting.min_limit ?? 0);
  if (['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET')) {
    if (side === 'BUY') {
      if (topLimit > 0) {
        const maxAllowed = baseLtp * (1 + topLimit / 100);
        if (client_price > maxAllowed) {
          return NextResponse.json({
            error: `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`
          }, { status: 400 });
        }
      }

      if (minLimit > 0) {
        const minAllowed = baseLtp * (1 - minLimit / 100);
        if (client_price < minAllowed) {
          return NextResponse.json({
            error: `Minimum price allowed is ₹${minAllowed.toFixed(2)}`
          }, { status: 400 });
        }
      }
    } else { // SELL side
      if (topLimit > 0) {
        const maxAllowed = baseLtp * (1 + topLimit / 100);
        if (client_price > maxAllowed) {
          return NextResponse.json({
            error: `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`
          }, { status: 400 });
        }
      }

      if (minLimit > 0) {
        const minAllowed = baseLtp * (1 - minLimit / 100);
        if (client_price < minAllowed) {
          return NextResponse.json({
            error: `Minimum price allowed is ₹${minAllowed.toFixed(2)}`
          }, { status: 400 });
        }
      }
    }
  }

  // 10. Compute fill price (LTP ± buffer from segment_settings)
  let fillPrice: number;
  const isImmediate = (order_type ?? 'MARKET') === 'MARKET' || order_type === 'SLM';

  if (order_type === 'LIMIT' || order_type === 'SL' || order_type === 'GTT') {
    fillPrice = client_price;
  } else {
    const buyEntryBuffer = buySetting?.entry_buffer ?? 0.003;
    const buyExitBuffer = buySetting?.exit_buffer ?? 0.0017;
    const sellEntryBuffer = sellSetting?.entry_buffer ?? 0.003;
    const sellExitBuffer = sellSetting?.exit_buffer ?? 0.0017;

    if (side === 'BUY') {
      if (is_exit) {
        // Exiting SELL/Short (Buying back) executes at: Ask * (1 + exitBuffer) of SELL side settings
        fillPrice = (baseLtp * 1.001) * (1 + sellExitBuffer);
      } else {
        // Long Entry (Buying) executes at: Ask * (1 + entryBuffer) of BUY side settings
        fillPrice = (baseLtp * 1.001) * (1 + buyEntryBuffer);
      }
    } else {
      if (is_exit) {
        // Exiting BUY/Long (Selling to close) executes at: Bid * (1 - exitBuffer) of BUY side settings
        fillPrice = (baseLtp * 0.999) * (1 - buyExitBuffer);
      } else {
        // Short Entry (Selling) executes at: Bid * (1 - entryBuffer) of SELL side settings
        fillPrice = (baseLtp * 0.999) * (1 - sellEntryBuffer);
      }
    }
  }

  fillPrice = Math.round(fillPrice * 100) / 100; // 2 dp

  // 11. Atomic write via Postgres RPC
  const targetOrderType = order_type ?? 'MARKET';
  
  // To make SLM execute immediately and create a position, we tell the DB it's a MARKET order
  const rpcOrderType = targetOrderType === 'SLM' ? 'MARKET' : targetOrderType;

  let resolvedTriggerPrice = trigger_price ? parseFloat(trigger_price.toString()) : null;
  let resolvedStopLoss = stop_loss ? parseFloat(stop_loss.toString()) : null;

  // For SLM, the UI sends the Stop Loss price in the trigger_price field.
  if (targetOrderType === 'SLM') {
    if (resolvedTriggerPrice !== null) {
      resolvedStopLoss = resolvedTriggerPrice;
      resolvedTriggerPrice = null; // Clear trigger price since it's a market order now
    }
  }

  const parsedOption = parseOptionSymbol(symbol);
  
  const executeDbCall = async () => {
    const { data: oId, error: rpcErr } = await admin.rpc('place_order', {
      p_user_id:      user.id,
      p_symbol:       symbol,
      p_kite_inst:    kiteInst,
      p_segment:      dbSegment,
      p_side:         side,
      p_order_type:   rpcOrderType,
      p_product_type: product_type ?? 'INTRADAY',
      p_qty:          qty,
      p_lots:         lots ?? 0,
      p_ltp:          baseLtp,
      p_fill_price:   fillPrice,
      p_info:         null,
      p_trigger_price: resolvedTriggerPrice,
      p_stop_loss:    resolvedStopLoss,
      p_target:       target ? parseFloat(target.toString()) : null,
      p_is_exit:      is_exit ?? false
    });
    if (rpcErr) {
      throw new Error(rpcErr.message || 'Order execution failed. Please try again.');
    }
    return oId as string;
  };

  let orderId: string;
  try {
    if (parsedOption) {
      const incomingOrder = {
        position_key: {
          strike_price: parsedOption.strike,
          option_type: parsedOption.optionType,
        },
        action: (is_exit ?? false)
          ? (side === 'BUY' ? 'BUY_EXIT' : 'SELL_EXIT')
          : (side === 'BUY' ? 'BUY' : 'SELL'),
        quantity: qty,
      } as any;
      orderId = await positionStore.applyOrder(user.id, incomingOrder, executeDbCall);
    } else {
      orderId = await executeDbCall();
    }
  } catch (err: any) {
    console.error('[POST /api/orders] Order execution error:', err);
    return NextResponse.json({ error: err.message || 'Order execution failed. Please try again.' }, { status: 400 });
  }

  // Update order_type to 'SLM' in the database if it was an SLM order asynchronously
  if (targetOrderType === 'SLM' && orderId) {
    admin
      .from('orders')
      .update({ order_type: 'SLM' })
      .eq('id', orderId)
      .then(({ error: updateErr }) => {
        if (updateErr) {
          console.error('[POST /api/orders] Failed to restore SLM order type:', updateErr);
        }
      });
  }

  const response: PlaceOrderResponse = {
    order_id:   orderId as string,
    status:     isImmediate ? 'EXECUTED' : 'PENDING',
    fill_price: fillPrice,
    message:    isImmediate 
      ? `${side} order executed at ₹${fillPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      : `${side} ${order_type} order placed (Pending) at ₹${fillPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  };

  return NextResponse.json(response, { status: 201 });
}
