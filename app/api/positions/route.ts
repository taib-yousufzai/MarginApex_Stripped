import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

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

    const admin = getAdminClient();

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');

    let positionsQuery = admin.from('positions').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
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

    return NextResponse.json({ positions });
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
