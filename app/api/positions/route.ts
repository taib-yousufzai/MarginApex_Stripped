export const dynamic = 'force-dynamic';

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

    let positionsQuery = admin.from('positions').select('*').eq('user_id', user.id);
    if (statusParam) {
      if (statusParam === 'open') {
        // 'open' shorthand — include both 'open' and 'active' statuses (case-insensitive)
        positionsQuery = positionsQuery
          .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
          .order('created_at', { ascending: false });
      } else {
        // Case-insensitive matching for other status values (like 'closed')
        const lowerStatus = statusParam.toLowerCase();
        const upperStatus = statusParam.toUpperCase();
        positionsQuery = positionsQuery
          .in('status', [lowerStatus, upperStatus])
          .order('updated_at', { ascending: false });

        // For closed positions, default to today-only unless 'all' param or 'from' date is passed
        if (lowerStatus === 'closed' && !searchParams.get('all') && !searchParams.get('from')) {
          const now = new Date();
          // Kolkata offset is +5:30 (330 minutes)
          const kolkataTime = new Date(now.getTime() + (330 * 60 * 1000));
          const yyyy = kolkataTime.getUTCFullYear();
          const mm = String(kolkataTime.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(kolkataTime.getUTCDate()).padStart(2, '0');
          const utcMidnight = new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`);
          positionsQuery = positionsQuery.gte('updated_at', utcMidnight.toISOString());
        } else if (lowerStatus === 'closed' && searchParams.get('from')) {
          positionsQuery = positionsQuery.gte('updated_at', `${searchParams.get('from')}T00:00:00+05:30`);
        }
        // Cap at 500 to prevent full-table scans on large accounts
        positionsQuery = positionsQuery.limit(500);
      }
    } else {
      // Default: only return open/active — closed positions are fetched explicitly (case-insensitive)
      positionsQuery = positionsQuery.in('status', ['open', 'OPEN', 'active', 'ACTIVE']).order('created_at', { ascending: false });
    }

    // Fetch positions
    const posResult = await positionsQuery;

    if (posResult.error) throw posResult.error;

    // Attach product_type to each position, using 'INTRADAY' as a safe ultimate fallback.
    // Also normalize the status field to lowercase so the frontend context can match it reliably.
    const positions = (posResult.data ?? []).map(p => ({
      ...p,
      status: p.status ? p.status.toLowerCase() : 'open',
      product_type: p.product_type || 'INTRADAY',
      kite_instrument: p.kite_instrument || p.symbol,
      brokerage: p.brokerage || 0,
    }));

    return NextResponse.json({ positions });
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
