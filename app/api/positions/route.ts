import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

// Columns the frontend actually uses — avoids transferring unnecessary data
const POSITION_COLUMNS = 'id,user_id,symbol,kite_instrument,side,status,qty_open,qty_total,entry_price,avg_price,exit_price,ltp,pnl,settlement,product_type,carry_brokerage_paid,created_at,updated_at,entry_time,exit_time,stop_loss,target,margin_required,locked_margin,duration_seconds,closed_by';

/**
 * GET /api/positions
 * 
 * Returns all internal platform positions for the authenticated user.
 * product_type is pulled from the matching entry order (first EXECUTED order for that symbol+side).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');

    // Try short-lived Redis cache (2s) to collapse rapid duplicate fetches
    const cacheKey = `pos:${user.id}:${statusParam || 'default'}`;
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      const cached = await redis.get(cacheKey);
      if (cached) {
        return NextResponse.json(JSON.parse(cached));
      }
    } catch { /* Redis miss or unavailable, continue with DB fetch */ }

    const admin = getAdminClient();

    let positionsQuery = admin.from('positions').select(POSITION_COLUMNS).eq('user_id', user.id).order('created_at', { ascending: false });
    if (statusParam) {
      if (statusParam === 'open') {
        // 'open' shorthand — include both 'open' and 'active' statuses
        positionsQuery = positionsQuery.in('status', ['open', 'active']);
      } else {
        positionsQuery = positionsQuery.eq('status', statusParam);

        // For closed positions, default to today-only unless 'all' param is passed
        if (statusParam === 'closed' && !searchParams.get('all')) {
          // Compute today's start in IST (UTC+5:30), then convert to UTC for the DB query
          const now = new Date();
          const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
          const istNow = new Date(now.getTime() + istOffset);
          const istMidnight = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
          const utcMidnight = new Date(istMidnight.getTime() - istOffset);
          positionsQuery = positionsQuery.gte('updated_at', utcMidnight.toISOString());
        }
      }
    } else {
      // Default: only return open/active — closed positions are fetched explicitly
      positionsQuery = positionsQuery.in('status', ['open', 'active']);
    }

    // Fetch positions
    const posResult = await positionsQuery;

    if (posResult.error) throw posResult.error;

    // Attach product_type to each position, using 'INTRADAY' as a safe ultimate fallback
    const positions = (posResult.data ?? []).map(p => ({
      ...p,
      product_type: p.product_type || 'INTRADAY',
      kite_instrument: p.kite_instrument || p.symbol,
    }));

    const responseBody = { positions };

    // Cache for 2 seconds to collapse rapid duplicate fetches
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      if (redis.setex) {
        await redis.setex(cacheKey, 2, JSON.stringify(responseBody));
      } else {
        await redis.set(cacheKey, JSON.stringify(responseBody), 'EX', 2);
      }
    } catch { /* Redis write failure is non-critical */ }

    return NextResponse.json(responseBody);
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
