/**
 * GET /api/admin/instruments/search?q=<query>&tab=<tab>
 *
 * Searches the instruments table for real market instruments.
 */

import { requireAdmin } from '../../_auth';
import {
  applyForexFilter,
  applyCryptoWhitelist,
  type Instrument,
} from '@/lib/filterEngine';

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const tab = searchParams.get('tab');

    if (!query || query.length < 2) {
      return Response.json([], { status: 200 });
    }

    let dbQuery = adminClient
      .from('instruments')
      .select('id, tradingsymbol, exchange, name, instrument_type, segment')
      .or(`tradingsymbol.ilike.%${query}%,name.ilike.%${query}%`)
      .limit(150);

    const applyTabFilter = (query: any) => {
      if (tab === 'All') return query;
      if (tab === 'INDEX-FUT') return query.is('option_type', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'STOCK-FUT') return query.is('option_type', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'INDEX-OPT') return query.not('option_type', 'is', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'STOCK-OPT') return query.not('option_type', 'is', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'MCX-FUT') return query.is('option_type', null).eq('exchange', 'MCX');
      if (tab === 'MCX-OPT') return query.not('option_type', 'is', null).eq('exchange', 'MCX');
      if (tab === 'NSE-EQ') return query.eq('instrument_type', 'EQ').is('option_type', null).in('exchange', ['NSE', 'BSE']);
      if (tab === 'CRYPTO') return query.eq('segment', 'CRYPTO');
      if (tab === 'FOREX') return query.eq('exchange', 'CDS');
      if (tab === 'COMEX') return query.eq('segment', 'COMEX');
      return query;
    };

    dbQuery = applyTabFilter(dbQuery);

    const { data, error } = await dbQuery;

    if (error) {
      console.error('[GET /api/admin/instruments/search] Error:', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    let results: Instrument[] = (data ?? []) as Instrument[];

    // Ensure index/stock segregation for generic FUT/OPT types
    const indexNames = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    if (tab === 'INDEX-FUT' || tab === 'INDEX-OPT') {
      results = results.filter((r: any) => indexNames.includes(r.name) || r.instrument_type === 'FUTIDX' || r.instrument_type === 'OPTIDX');
    } else if (tab === 'STOCK-FUT' || tab === 'STOCK-OPT') {
      results = results.filter((r: any) => !indexNames.includes(r.name) && r.instrument_type !== 'FUTIDX' && r.instrument_type !== 'OPTIDX');
    }

    // Apply production filtering rules so admin search reflects what traders see
    results = applyForexFilter(results);       // Requirement 1.1 — no Forex CE/PE
    if (tab === 'CRYPTO') {
      results = applyCryptoWhitelist(results); // Requirement 5.2 — BTC/ETH/DOGE only (CRYPTO tab only)
    }

    return Response.json(results, { status: 200 });
  } catch (err: any) {
    return Response.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
