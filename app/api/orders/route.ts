/**
 * Internal Order API — MarginApex platform orders
 *
 * GET  /api/orders → user's own order history (from Supabase)
 * POST /api/orders → place a new order through MarginApex (via TradeEngine)
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';
import type { PlaceOrderRequest, MyOrder } from '@/lib/types/order';
import { logAction, extractClientIp } from '@/lib/actionLogger';
import { TradeEngine } from '@/lib/trading/TradeEngine';
import { getLotSizeFallback } from '@/lib/lotSize';

// ─── GET /api/orders ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await apiRequireAuth(request, ['VIEW_OWN_ORDERS']);
  if (authResult instanceof Response) return authResult as NextResponse;
  const { callerUser: user } = authResult;

  try {
    const admin = getAdminClient();
    const { searchParams } = request.nextUrl;
    const page  = Math.max(1, parseInt(searchParams.get('page')  ?? '1',  10) || 1);
    const limit = Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50);
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
        .eq('status', 'open'),
    ]);

    if (ordersRes.error) throw ordersRes.error;

    const dbOrders     = ordersRes.data ?? [];
    const openPositions = posRes.data   ?? [];

    const orders: MyOrder[] = dbOrders.map((r: Record<string, unknown>) => ({
      id:            r.id as string,
      symbol:        r.symbol as string,
      segment:       (r.segment as string) ?? '',
      side:          r.side as 'BUY' | 'SELL',
      status:        r.status as MyOrder['status'],
      qty:           Number(r.qty),
      lots:          Math.round(Number(r.lots) || (Number(r.qty) / getLotSizeFallback(r.symbol as string))),
      fill_price:    Number(r.fill_price ?? r.price),
      ltp_at_entry:  Number(r.ltp_at_entry ?? 0),
      order_type:    (r.order_type as MyOrder['order_type']) ?? 'MARKET',
      product_type:  (r.product_type as MyOrder['product_type']) ?? 'INTRADAY',
      info:          (r.info as string) ?? null,
      brokerage:     Number(r.brokerage ?? 0),
      client_price:  r.client_price  != null ? Number(r.client_price)  : undefined,
      trigger_price: r.trigger_price != null ? Number(r.trigger_price) : undefined,
      stop_loss:     r.stop_loss     != null ? Number(r.stop_loss)     : undefined,
      target:        r.target        != null ? Number(r.target)        : undefined,
      created_at:    r.created_at as string,
      is_exit:       !!r.is_exit,
    }));

    // Synthesize virtual PENDING orders for positions that have SL / Target set
    const virtualOrders: MyOrder[] = [];
    for (const pos of openPositions) {
      const stopLoss = pos.stop_loss ? Number(pos.stop_loss) : (pos.sl ? Number(pos.sl) : null);
      const target   = pos.target    ? Number(pos.target)    : (pos.tp ? Number(pos.tp) : null);

      if (stopLoss !== null && stopLoss > 0 && target !== null && target > 0) {
        // Both SL + Target → show as a single GTT
        virtualOrders.push({
          id: `pos-gtt-${pos.id}`,
          symbol: pos.symbol,
          segment: pos.settlement || 'NSE-EQ',
          side: pos.side === 'BUY' ? 'SELL' : 'BUY',
          status: 'PENDING',
          qty: Number(pos.qty_open || 0),
          lots: Number(pos.lots ?? 0) || (Number(pos.qty_open) > 0 ? 1 : 0),
          fill_price: 0,
          ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
          order_type: 'GTT',
          product_type: (pos.product_type as any) ?? 'INTRADAY',
          info: 'GTT (Exit)',
          brokerage: 0,
          trigger_price: stopLoss,
          stop_loss: stopLoss,
          target: target,
          created_at: pos.entry_time || pos.created_at || new Date(0).toISOString(),
        });
      } else {
        if (stopLoss !== null && stopLoss > 0) {
          virtualOrders.push({
            id: `pos-sl-${pos.id}`,
            symbol: pos.symbol,
            segment: pos.settlement || 'NSE-EQ',
            side: pos.side === 'BUY' ? 'SELL' : 'BUY',
            status: 'PENDING',
            qty: Number(pos.qty_open || 0),
            lots: Number(pos.lots ?? 0) || (Number(pos.qty_open) > 0 ? 1 : 0),
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
            segment: pos.settlement || 'NSE-EQ',
            side: pos.side === 'BUY' ? 'SELL' : 'BUY',
            status: 'PENDING',
            qty: Number(pos.qty_open || 0),
            lots: Number(pos.lots ?? 0) || (Number(pos.qty_open) > 0 ? 1 : 0),
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
    }

    // Merge and sort newest first
    const combined = [...virtualOrders, ...orders];
    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({ orders: combined, page, limit });
  } catch (err) {
    console.error('[GET /api/orders]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST /api/orders ─────────────────────────────────────────────────────────

async function handleOrderPlacement(request: NextRequest, clientIp: string): Promise<NextResponse> {
  try {
    // 1. Authenticate — session cookie first, then webhook token, then dev fallback
    let user = await getUserFromRequest(request);

    if (!user) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader?.startsWith('Webhook ')) {
        const token = authHeader.slice(8).trim();
        const admin = getAdminClient();
        const { data } = await admin
          .from('profiles')
          .select('id')
          .eq('webhook_token', token)
          .maybeSingle();
        if (data) user = { id: data.id } as any;
      }
    }

    if (!user) {
      if (process.env.NODE_ENV === 'development') {
        user = { id: 'dfa9b057-9187-4054-9ae6-9179c620666e' } as any;
      } else {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // 2. Parse and validate body
    const body = await request.json() as PlaceOrderRequest;
    if (!body.symbol || !body.side || !body.qty || !body.segment) {
      return NextResponse.json(
        { error: 'Missing required fields: symbol, side, qty, segment' },
        { status: 400 },
      );
    }

    // 3. Delegate everything to TradeEngine
    const responseData = await TradeEngine.placeOrder(user, body, clientIp);
    return NextResponse.json(responseData, { status: 201 });

  } catch (err: any) {
    console.error('[POST /api/orders]', err?.message, err?.stack);

    const msg = err?.message || 'Order execution failed. Please try again.';
    let status = 400;
    if (msg.includes('Unauthorized') || msg.includes('inactive'))              status = 401;
    if (msg.includes('Not Allowed') || msg.includes('Anti-Scalping') ||
        msg.includes('market is closed') || msg.includes('read_only'))         status = 403;
    if (msg.includes('determine market price') || msg.includes('unavailable')) status = 503;

    return NextResponse.json({ error: msg }, { status });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  const clonedRequest = request.clone();

  let payload: any = null;
  try { payload = await clonedRequest.json(); } catch { /* empty body */ }

  const response = await handleOrderPlacement(request, ipAddress);

  let errorMessage: string | null = null;
  if (!response.ok) {
    try {
      const errData = await response.clone().json();
      errorMessage = errData.error || errData.message || 'Unknown error';
    } catch { errorMessage = 'Failed to parse error response'; }
  }

  logAction({
    actionType: 'PLACE_ORDER',
    module: 'TRADING',
    apiEndpoint: '/api/orders',
    httpMethod: 'POST',
    ipAddress,
    requestPayload: payload,
    responseStatus: response.status,
    isSuccess: response.ok,
    errorMessage,
  });

  return response;
}
