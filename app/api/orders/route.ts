/**
 * Internal Order API — MarginApex platform orders
 *
 * GET  /api/orders          → user's own order history (from Supabase)
 * POST /api/orders          → place a new order through MarginApex (via TradeEngine)
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';
import type { PlaceOrderRequest, MyOrder } from '@/lib/types/order';
import { logAction, extractClientIp } from '@/lib/actionLogger';
import { TradeEngine } from '@/lib/trading/TradeEngine';

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

      if (stopLoss !== null && stopLoss > 0 && target !== null && target > 0) {
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
            side: pos.side === 'BUY' ? 'SELL' : 'BUY', // Stop loss exit is opposite side
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
            side: pos.side === 'BUY' ? 'SELL' : 'BUY', // Target exit is opposite side
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

async function handleOrderPlacement(request: NextRequest, clientIp: string): Promise<NextResponse> {
  try {
    // 1. Authenticate
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
        if (data) {
          user = { id: data.id } as any;
        }
      }
    }
    
    if (!user) {
      if (process.env.NODE_ENV === 'development') {
        user = { id: 'dfa9b057-9187-4054-9ae6-9179c620666e' } as any; // Mock user ID for testing
      } else {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // 2. Parse request
    const body = await request.json() as PlaceOrderRequest;
    
    if (!body.symbol || !body.side || !body.qty || !body.segment) {
      return NextResponse.json({ error: 'Missing required fields: symbol, side, qty, segment' }, { status: 400 });
    }

    // 3. Trade Engine Orchestration
    const responseData = await TradeEngine.placeOrder(user, body, clientIp);
    
    return NextResponse.json(responseData, { status: 201 });
    
  } catch (globalError: any) {
    console.error('[POST /api/orders] FATAL ERROR:', globalError?.message, globalError?.stack);
    
    let status = 400;
    const msg = globalError.message || '';
    if (msg.includes('Unauthorized') || msg.includes('inactive')) status = 401;
    if (msg.includes('Not Allowed') || msg.includes('Anti-Scalping') || msg.includes('market is closed')) status = 403;
    if (msg.includes('determine market price')) status = 503;

    return NextResponse.json(
      { error: msg || 'Order execution failed. Please try again.' }, 
      { status }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  // We need to clone the request because we can only read the body once
  const clonedRequest = request.clone();
  
  let payload: any = null;
  try {
    payload = await clonedRequest.json();
  } catch {
    // Body will fail if it's empty or invalid JSON, handled by handleOrderPlacement
  }

  const response = await handleOrderPlacement(request, ipAddress);

  // Read the response safely for error messages
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
