/**
 * GET /api/market/instruments/search?q=<query>
 *
 * Public endpoint — searches the instruments table for live market instruments.
 * Used by the watchlist search to surface real option chain strikes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getUserFromRequest, getAdminClient } from '@/lib/adminClient';
import {
  applyForexFilter,
  applyCryptoWhitelist,
  applyExpiryFilter,
  type Instrument,
} from '@/lib/filterEngine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Known underlying symbols for smart parsing
const UNDERLYINGS = ['MIDCPNIFTY', 'BANKNIFTY', 'FINNIFTY', 'NIFTY', 'SENSEX', 'BANKEX', 'CRUDEOILM', 'CRUDEOIL', 'NATGASMINI', 'NATURALGAS', 'SILVERM', 'SILVER', 'GOLDM', 'GOLD'];

const mapSegmentToDbSegment = (s: string): string => {
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
};

/**
 * Try to parse a query like "nifty 24040" or "banknifty 48500 ce"
 * into { underlying, strike, optionType }
 */
function parseOptionQuery(q: string): { underlying: string; strike: number; optionType?: string } | null {
  const upper = q.toUpperCase().replace(/\s+/g, ' ').trim();

  // Smart guesser for pure numeric queries like "23600" or "48500 ce"
  const numOnlyMatch = upper.match(/^(\d+(?:\.\d+)?)\s*(CE|PE)?$/);
  if (numOnlyMatch) {
    const num = parseFloat(numOnlyMatch[1]);
    const optType = numOnlyMatch[2];

    let guessed = '';
    // Nifty is around 21k - 29k
    if (num >= 20000 && num <= 29000) guessed = 'NIFTY';
    // BankNifty is around 40k - 62k
    else if (num >= 40000 && num <= 62000) guessed = 'BANKNIFTY';
    // Sensex is around 70k - 95k
    else if (num >= 70000 && num <= 95000) guessed = 'SENSEX';
    // Midcap Nifty is around 9k - 20k
    else if (num >= 9000 && num <= 19999) guessed = 'MIDCPNIFTY';

    if (guessed) {
      return {
        underlying: guessed,
        strike: num,
        optionType: optType || undefined,
      };
    }
  }

  const underlying = UNDERLYINGS.find(u => upper.startsWith(u));
  if (!underlying) return null;
  const rest = upper.slice(underlying.length).trim();
  if (!rest) return null;
  const match = rest.match(/^(\d+(?:\.\d+)?)\s*(CE|PE)?$/);
  if (!match) return null;
  return {
    underlying,
    strike: parseFloat(match[1]),
    optionType: match[2] || undefined,
  };
}

/**
 * Format YYYY-MM-DD date to DD MMM YYYY (e.g. 26 Jun 2026)
 */
function formatUIExpiry(dateStr: string | null): string {
  if (!dateStr) return '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  
  const [, year, month, day] = match;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = monthNames[parseInt(month, 10) - 1];
  
  return `${parseInt(day, 10)} ${monthName} ${year}`;
}

/**
 * Build a human-readable display name from a Zerodha tradingsymbol.
 * e.g. NIFTY26MAY24050CE  →  NIFTY 24050 CE  (19 May 26)
 *      NIFTY2651924050CE  →  NIFTY 24050 CE  (19 May 26)
 */
function buildDisplayName(tradingsymbol: string, underlying: string, strike: number | null, optionType: string | null, expiry: string | null): string {
  const isRealValue = (v: any) => v !== null && v !== undefined && String(v).toLowerCase() !== 'null' && String(v).trim() !== '';
  
  if (isRealValue(strike) && isRealValue(optionType)) {
    const expLabel = isRealValue(expiry) ? ` (${expiry})` : '';
    const safeUnderlying = isRealValue(underlying) ? underlying : (isRealValue(tradingsymbol) ? tradingsymbol : '');
    return `${safeUnderlying} ${strike} ${optionType}${expLabel}`.trim();
  }
  return isRealValue(tradingsymbol) ? tradingsymbol : 'Unknown';
}

/**
 * Fetch live last_price for a list of kite IDs like "NFO:NIFTY26MAY24050CE"
 * Checks local database cache first, and falls back to Kite REST on-demand for missing.
 */
async function fetchLivePrices(kiteIds: string[], request: NextRequest): Promise<Record<string, number>> {
  if (kiteIds.length === 0) return {};
  const priceMap: Record<string, number> = {};
  const foundKiteIds = new Set<string>();

  try {
    // 1. Fetch from Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
      const params = new URLSearchParams({ symbols: kiteIds.join(',') });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store' });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data) {
          for (const [key, val] of Object.entries(json.data)) {
            priceMap[key] = (val as any).last_price;
            foundKiteIds.add(key);
          }
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchLivePrices] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. Identify missing instruments
    const missingKiteIds = kiteIds.filter(id => !foundKiteIds.has(id));

    // 3. Fallback on-demand fetch from Kite REST API for missing instruments
    if (missingKiteIds.length > 0) {
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return priceMap;

      let accessToken = request.cookies.get('kite_access_token')?.value;
      if (!accessToken) {
        const session = await getSharedKiteSession();
        accessToken = session?.accessToken;
      }
      if (!accessToken) return priceMap;

      const batchSize = 100;
      const batches: string[][] = [];
      for (let i = 0; i < missingKiteIds.length; i += batchSize) {
        batches.push(missingKiteIds.slice(i, i + batchSize));
      }

      const results = await Promise.all(
        batches.map(async (batch) => {
          const params = new URLSearchParams();
          batch.forEach(id => params.append('i', id));

          try {
            const res = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
              headers: {
                'X-Kite-Version': '3',
                'Authorization': `token ${apiKey}:${accessToken}`,
              },
              cache: 'no-store',
            });

            if (res.ok) {
              const json = await res.json();
              return json.data || {};
            }
          } catch (err) {
            console.error('[Search Quotes Fallback] error:', err);
          }
          return {};
        })
      );

      const instrumentUpserts: any[] = [];

      for (const resData of results) {
        for (const [id, quote] of Object.entries(resData)) {
          if (!quote) continue;
          const ltp = (quote as any).last_price ?? 0;
          priceMap[id] = ltp;

          const parts = id.split(':');
          const exchange = parts[0] || 'NSE';
          const tradingsymbol = parts[1] || '';

          instrumentUpserts.push({
            id,
            instrument_token: (quote as any).instrument_token || 0,
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
            await supabase.from('instruments').upsert(instrumentUpserts, { onConflict: 'id' });
          } catch (err) {
            console.error('[fetchLivePrices] Background cache error:', err);
          }
        })();
      }
    }

    return priceMap;
  } catch (err) {
    console.error('[fetchLivePrices] Unexpected error:', err);
    return priceMap;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawQ = searchParams.get('q') || '';
    // Normalize: remove multiple spaces, trim
    const q = rawQ.replace(/\s+/g, ' ').trim();
    const tab = searchParams.get('tab') || 'All';

    if (q.length < 1) {
      return NextResponse.json([]);
    }

    let data: any[] | null = null;
    let error: any = null;

    const parsed = parseOptionQuery(q);

    let allowedSymbols: string[] | null = null;
    const user = await getUserFromRequest(request);
    if (user) {
      const adminClient = getAdminClient();
      const { data: profile } = await adminClient.from('profiles').select('template_id').eq('id', user.id).single();
      if (profile?.template_id) {
        const { data: scripts } = await adminClient.from('template_scripts').select('symbol').eq('template_id', profile.template_id);
        if (scripts && scripts.length > 0) {
          allowedSymbols = scripts.map(s => s.symbol);
        }
      }
    }

    const applyTabFilter = (query: any) => {
      if (allowedSymbols) {
        query = query.in('tradingsymbol', allowedSymbols);
      }
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

    const today = new Date().toISOString().split('T')[0];

    if (parsed) {
      // Try fetching active expiries directly matching the underlying and strike
      let qry = supabase
        .from('instruments')
        .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol')
        .eq('strike_price', parsed.strike)
        .gte('expiry', today)
        .order('expiry', { ascending: true })
        .limit(150);

      if (parsed.optionType) qry = qry.eq('option_type', parsed.optionType);

      let q1 = applyTabFilter(qry.eq('name', parsed.underlying));
      ({ data, error } = await q1);

      if (!error && (!data || data.length === 0)) {
        let q2 = applyTabFilter(qry.eq('underlying_symbol', parsed.underlying));
        ({ data, error } = await q2);
      }
    }

    // Fallback: tradingsymbol ilike (spaces removed) or numeric strike
    if (!data || data.length === 0) {
      const qNoSpace = q.replace(/\s+/g, '').toUpperCase();

      let buildBaseFallbackQuery = () => {
        let qry = supabase
          .from('instruments')
          .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol');
          
        let orParts = [];

        if (/^\d+(\.\d+)?$/.test(q)) {
          // Pure numeric query — search exact strike_price, but also allow partial text matches
          orParts.push(`strike_price.eq.${q}`);
          // Also match string fields since users type "21" intending to find "21000"
          orParts.push(`tradingsymbol.ilike.%${qNoSpace}%`);
          orParts.push(`name.ilike.%${q}%`);
        } else {
          // Text query — search by name and tradingsymbol
          // Add ilike conditions that approximate exact, starts with, and contains
          orParts.push(`name.ilike.${q}%`);
          orParts.push(`name.ilike.% ${q}%`);
          orParts.push(`tradingsymbol.ilike.%${qNoSpace}%`);
        }

        qry = qry.or(orParts.join(','));
        // CRITICAL FIX: Only fetch live options to not exhaust the limit on dead contracts
        qry = qry.or(`expiry.gte.${today},expiry.is.null`);

        qry = qry
          .order('expiry', { ascending: true })
          .limit(300); // Increased limit to ensure we get enough candidates for proper sorting

        return applyTabFilter(qry);
      };

      ({ data, error } = await buildBaseFallbackQuery());
    }

    if (error) {
      console.error('[GET /api/market/instruments/search] Error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    let rows: any[] = data ?? [];

    // Ensure index/stock segregation for generic FUT/OPT types
    const indexNames = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    if (tab === 'INDEX-FUT' || tab === 'INDEX-OPT') {
      rows = rows.filter(r => indexNames.includes(r.name) || r.instrument_type === 'FUTIDX' || r.instrument_type === 'OPTIDX');
    } else if (tab === 'STOCK-FUT' || tab === 'STOCK-OPT') {
      rows = rows.filter(r => !indexNames.includes(r.name) && r.instrument_type !== 'FUTIDX' && r.instrument_type !== 'OPTIDX');
    }

    // Filter rows to ensure they actually match the search terms in a meaningful way.
    let searchTerms = q.toLowerCase().split(/\s+/);
    if (parsed) {
      const newQ = `${parsed.underlying} ${parsed.strike} ${parsed.optionType || ''}`.toLowerCase().trim();
      searchTerms = newQ.split(/\s+/);
    }

    function wordStartMatch(text: string, term: string): boolean {
      if (!text) return false;
      const t = text.toLowerCase();
      if (t.startsWith(term)) return true;
      const words = t.split(/[\s\-_\/]/);
      return words.some(w => w.startsWith(term));
    }

    rows = rows.filter((r: any) => {
      const dispName = buildDisplayName(
        r.tradingsymbol,
        r.underlying_symbol || r.name || r.tradingsymbol,
        r.strike_price ?? null,
        r.option_type ?? null,
        null
      ).toLowerCase();
      const symbol = (r.tradingsymbol || '').toLowerCase();
      const name = (r.name || '').toLowerCase();

      return searchTerms.every(term => {
        if (/^\d+(\.\d+)?$/.test(term)) {
          if (r.strike_price !== null && String(r.strike_price).startsWith(term)) return true;
          // Allow numeric term to match inside the symbol as well (e.g., '21' in NIFTY21...)
          return symbol.includes(term) || wordStartMatch(dispName, term) || wordStartMatch(name, term);
        }
        return wordStartMatch(dispName, term) || wordStartMatch(name, term) || wordStartMatch(symbol, term);
      });
    });

    // Apply Filter Engine rules server-side before returning results
    const forexRows = rows.filter((r: any) => r.exchange === 'CDS' || r.segment === 'CDS');
    const cryptoRows = rows.filter((r: any) => r.segment === 'CRYPTO');
    const optionRows = rows.filter((r: any) =>
      !['CDS', 'CRYPTO'].includes(r.exchange) &&
      r.segment !== 'CDS' && r.segment !== 'CRYPTO' &&
      (r.option_type === 'CE' || r.option_type === 'PE')
    );
    const otherRows = rows.filter((r: any) =>
      r.exchange !== 'CDS' && r.segment !== 'CDS' &&
      r.segment !== 'CRYPTO' &&
      r.option_type !== 'CE' && r.option_type !== 'PE'
    );

    const filteredForex = applyForexFilter(forexRows as Instrument[]);
    const filteredCrypto = applyCryptoWhitelist(cryptoRows as Instrument[]);
    let filteredOptions = optionRows as Instrument[];
    
    if (filteredOptions.length > 0) {
      const expiries = [...new Set(filteredOptions.map((r: any) => r.expiry).filter(Boolean))] as string[];
      const activeExpiries = applyExpiryFilter(expiries, today);
      if (activeExpiries.length > 0) {
        const activeSet = new Set(activeExpiries);
        filteredOptions = filteredOptions.filter((r: any) => !r.expiry || activeSet.has(r.expiry));
      }
    }

    // Combine all valid rows
    let validRows = [...otherRows, ...filteredCrypto, ...filteredForex, ...filteredOptions];

    // Remove duplicates based on exchange:tradingsymbol
    const uniqueMap = new Map();
    for (const r of validRows) {
      const key = `${r.exchange}:${r.tradingsymbol}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, r);
      }
    }
    validRows = Array.from(uniqueMap.values());

    // Remove future contracts with null expiry if dated versions exist
    const futMap = new Map<string, any[]>();
    for (const r of validRows) {
      if (r.instrument_type?.startsWith('FUT') || ['FUT', 'MAPPED_FUT'].includes(r.instrument_type)) {
        const key = r.name || r.underlying_symbol || r.tradingsymbol;
        if (!futMap.has(key)) futMap.set(key, []);
        futMap.get(key)!.push(r);
      }
    }
    for (const [key, futs] of futMap.entries()) {
      const hasDated = futs.some(f => f.expiry !== null && f.expiry !== undefined);
      if (hasDated) {
        validRows = validRows.filter(r => {
          if ((r.name || r.underlying_symbol || r.tradingsymbol) === key && (r.instrument_type?.startsWith('FUT') || ['FUT', 'MAPPED_FUT'].includes(r.instrument_type))) {
            return r.expiry !== null && r.expiry !== undefined;
          }
          return true;
        });
      }
    }

    // Ranking algorithm
    const qLower = q.toLowerCase();
    
    function scoreInstrument(r: any): number {
      const sym = (r.tradingsymbol || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      const dispName = buildDisplayName(
        r.tradingsymbol,
        r.underlying_symbol || r.name || r.tradingsymbol,
        r.strike_price ?? null,
        r.option_type ?? null,
        null
      ).toLowerCase();

      // Rank 1: Exact match
      if (sym === qLower || name === qLower || dispName === qLower) return 1;
      
      // Rank 2: Prefix match
      if (sym.startsWith(qLower) || name.startsWith(qLower) || dispName.startsWith(qLower)) return 2;
      
      // Rank 3: Word Start match (e.g., "50" in "NIFTY 50")
      if (wordStartMatch(name, qLower) || wordStartMatch(dispName, qLower) || wordStartMatch(sym, qLower)) return 3;

      // Rank 4: Contains
      if (sym.includes(qLower) || name.includes(qLower) || dispName.includes(qLower)) return 4;
      
      return 5; // Fallback
    }

    validRows.sort((a: any, b: any) => {
      const scoreA = scoreInstrument(a);
      const scoreB = scoreInstrument(b);
      
      // Sort by score
      if (scoreA !== scoreB) return scoreA - scoreB;
      
      // Tie-breaker 1: Prefer Equity
      if (a.instrument_type === 'EQ' && b.instrument_type !== 'EQ') return -1;
      if (b.instrument_type === 'EQ' && a.instrument_type !== 'EQ') return 1;
      
      // Tie-breaker 2: Nearest expiry for derivatives
      if (a.expiry && b.expiry && a.expiry !== b.expiry) {
        return a.expiry.localeCompare(b.expiry);
      }
      
      // Tie-breaker 3: Alphabetical by tradingsymbol
      return (a.tradingsymbol || '').localeCompare(b.tradingsymbol || '');
    });

    // Filter out expired contracts by parsing the date from the symbol (e.g. CRUDEOIL26JUNFUT)
    validRows = validRows.filter((r: any) => {
      if (!r.expiry && r.tradingsymbol && r.tradingsymbol.includes('FUT')) {
        const match = r.tradingsymbol.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/);
        if (match) {
          const year = parseInt(match[1], 10) + 2000;
          const monthIndex = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(match[2]);
          
          // Set to the end of the month for a rough expiry check
          const roughExpiry = new Date(year, monthIndex + 1, 0);
          if (roughExpiry < new Date()) {
            return false; // It's expired
          }
        }
      }
      return true;
    });

    // We only need the top 50 matches for the UI to stay performant
    validRows = validRows.slice(0, 50);

    // Fetch live prices for all results
    const kiteIds = validRows.map((inst: any) => `${inst.exchange}:${inst.tradingsymbol}`);
    const priceMap = await fetchLivePrices(kiteIds, request);

    // Map to watchlist-compatible shape
    let results = validRows.map((inst: any) => {
      let segmentLabel = '';
      const exch = inst.exchange === 'NFO' ? 'NSE' : inst.exchange === 'BFO' ? 'BSE' : inst.exchange;
      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(inst.name);
      const type = inst.instrument_type;

      if (type === 'OPTSTK' || (!isIndex && (type === 'CE' || type === 'PE' || type === 'OPT'))) {
        segmentLabel = `${exch} - Stock Options`;
      } else if (type === 'OPTIDX' || (isIndex && (type === 'CE' || type === 'PE' || type === 'OPT'))) {
        segmentLabel = `${exch} - Options`;
      } else if (type === 'FUTSTK' || (!isIndex && ['FUT', 'MAPPED_FUT'].includes(type) && ['NSE', 'BSE'].includes(exch))) {
        segmentLabel = `${exch} - Stock Futures`;
      } else if (['FUT', 'MAPPED_FUT', 'FUTIDX', 'FUTCOM', 'FUTCUR'].includes(type)) {
        segmentLabel = `${exch} - Futures`;
      } else if (type === 'EQ') {
        segmentLabel = `${exch} - Equity`;
      } else {
        segmentLabel = inst.segment || inst.exchange || '';
      }

      const kiteId = `${inst.exchange}:${inst.tradingsymbol}`;
      const livePrice = priceMap[kiteId] ?? 0;

      const displayName = buildDisplayName(
        inst.tradingsymbol,
        inst.underlying_symbol || inst.name || inst.tradingsymbol,
        inst.strike_price ?? null,
        inst.option_type ?? null,
        formatUIExpiry(inst.expiry) || null,
      );

      return {
        name: displayName,
        symbol: inst.tradingsymbol,
        kiteSymbol: kiteId,
        price: livePrice,
        change: '0%',
        segment: segmentLabel,
        contractDate: formatUIExpiry(inst.expiry) || '',
        open: 0,
        high: 0,
        low: 0,
        close: 0,
      };
    });

    // ── Filter out blocked symbols for this user ──────────────────────────
    // Fetch the user's blocked scripts and remove those instruments from results.
    // This ensures blocked symbols don't appear in watchlist search at all.
    if (user) {
      try {
        const { data: blockedRows } = await supabase
          .from('user_blocked_scripts')
          .select('symbol')
          .eq('user_id', user.id);
        if (blockedRows && blockedRows.length > 0) {
          const blockedSet = new Set(blockedRows.map((r: any) => r.symbol.toUpperCase()));
          results = results.filter(r => !blockedSet.has((r.symbol || '').toUpperCase()));
        }

        // Also filter out entire segments if they are blocked (trade_allowed = false)
        const [ { data: segRows }, { data: scalperRows } ] = await Promise.all([
          supabase.from('segment_settings').select('segment').eq('user_id', user.id).eq('trade_allowed', false),
          supabase.from('scalper_segment_settings').select('segment').eq('user_id', user.id).eq('trade_allowed', false)
        ]);

        const blockedSegments = new Set<string>([
          ...(segRows?.map(r => r.segment) || []),
          ...(scalperRows?.map(r => r.segment) || [])
        ]);

        if (blockedSegments.size > 0) {
          results = results.filter(r => !blockedSegments.has(mapSegmentToDbSegment(r.segment)));
        }
      } catch {
        // Non-fatal — if we can't fetch blocked scripts, show all results
      }
    }

    return NextResponse.json(results);
  } catch (err: any) {
    console.error('[GET /api/market/instruments/search] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
