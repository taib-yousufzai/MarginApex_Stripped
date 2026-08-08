/**
 * Kite Quotes API
 * GET /api/kite/quotes?instruments=NSE:NIFTY+50,NSE:RELIANCE,...
 * 
 * Target Architecture:
 * 1. Bypasses DB lookup entirely.
 * 2. Fetches from the local Ticker Daemon quote cache first.
 * 3. Falls back to Kite REST API in batches for missing/uncached instruments.
 * 4. Caches instruments structure, but never stores raw quotes/ticks in the database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getAdminClient } from '@/lib/adminClient';

async function fetchKiteQuotesBatch(
  kiteRequestInstruments: string[],
  apiKey: string,
  accessToken: string,
): Promise<{ data: Record<string, any>; tokenExpired: boolean }> {
  const allKiteData: Record<string, any> = {};
  let tokenExpired = false;

  const batchSize = 100;
  const batches: string[][] = [];
  for (let i = 0; i < kiteRequestInstruments.length; i += batchSize) {
    batches.push(kiteRequestInstruments.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      batch.forEach(inst => params.append('i', inst));

      try {
        const response = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`,
          },
          cache: 'no-store',
        });

        if (response.status === 403 || response.status === 401) {
          return { data: null, expired: true };
        } else if (response.ok) {
          const json = await response.json();
          return { data: json.data || {}, expired: false };
        }
      } catch (err) {
        console.error('[Kite Quotes] Batch fetch error:', err);
      }
      return { data: {}, expired: false };
    })
  );

  for (const res of results) {
    if (res.expired) tokenExpired = true;
    if (res.data) Object.assign(allKiteData, res.data);
  }

  return { data: allKiteData, tokenExpired };
}

async function handleQuotesRequest(instruments: string[], request: NextRequest): Promise<NextResponse> {
  if (instruments.length === 0) {
    return NextResponse.json({ data: {} });
  }

  try {
    const admin = getAdminClient();
    const realToRequestedMap: Record<string, string> = {};
    const directKiteIds: string[] = [];
    const dbRequestIds: string[] = [];

    // Separate direct IDs (with colon e.g. NSE:RELIANCE) from DB ID numbers
    for (const id of instruments) {
      if (id.includes(':')) {
        directKiteIds.push(id);
        realToRequestedMap[id] = id;
      } else {
        dbRequestIds.push(id);
      }
    }

    // Resolve internal DB IDs to Kite IDs
    if (dbRequestIds.length > 0) {
      const { data } = await admin
        .from('instruments')
        .select('id, tradingsymbol, exchange')
        .in('id', dbRequestIds);

      if (data) {
        for (const row of data) {
          const kiteId = `${row.exchange}:${row.tradingsymbol}`;
          realToRequestedMap[kiteId] = row.id;
          directKiteIds.push(kiteId);
        }
      }
      
      // Keep unresolved ones as-is as fallback
      for (const id of dbRequestIds) {
        if (!Object.values(realToRequestedMap).includes(id)) {
          realToRequestedMap[id] = id;
          directKiteIds.push(id);
        }
      }
    }

    const finalMappedData: Record<string, any> = {};
    const foundKiteIds = new Set<string>();

    // 1. Fetch from Redis Hash cache first
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      await Promise.all(directKiteIds.map(async (kiteId) => {
        const cached = await redis.hget('market:quotes', kiteId);
        if (cached) {
          const q = JSON.parse(cached);
          const reqId = realToRequestedMap[kiteId];
          if (reqId && q) {
            const close = q.ohlc?.close || q.close || 0;
            finalMappedData[reqId] = {
              timestamp: q.last_trade_time || q.timestamp || new Date().toISOString(),
              last_price: q.last_price,
              volume: q.volume || 0,
              ohlc: {
                open: q.ohlc?.open || q.open || 0,
                high: q.ohlc?.high || q.high || 0,
                low: q.ohlc?.low || q.low || 0,
                close: close,
              },
              net_change: q.last_price - close,
              bid: q.bid ?? q.depth?.buy?.[0]?.price ?? null,
              ask: q.ask ?? q.depth?.sell?.[0]?.price ?? null,
            };
            foundKiteIds.add(kiteId);
          }
        }
      }));
    } catch (redisErr) {
      console.warn('[Kite Quotes API] Failed to query Redis, falling back:', redisErr);
    }

    // 2. Fallback to Ticker Daemon in-memory quotes API for remaining symbols
    const remainingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));
    if (remainingKiteIds.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
        const params = new URLSearchParams({ symbols: remainingKiteIds.join(',') });
        if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
        if (resTicker.ok) {
          const json = await resTicker.json();
          if (json.success && json.data) {
            for (const [kiteId, quote] of Object.entries(json.data)) {
              const reqId = realToRequestedMap[kiteId];
              if (!reqId || !quote) continue;

              const q = quote as any;
              const close = q.ohlc?.close || q.close || 0;
              finalMappedData[reqId] = {
                timestamp: q.last_trade_time || q.timestamp || new Date().toISOString(),
                last_price: q.last_price,
                volume: q.volume || 0,
                ohlc: {
                  open: q.ohlc?.open || q.open || 0,
                  high: q.ohlc?.high || q.high || 0,
                  low: q.ohlc?.low || q.low || 0,
                  close: close,
                },
                net_change: q.last_price - close,
                bid: q.bid ?? q.depth?.buy?.[0]?.price ?? null,
                ask: q.ask ?? q.depth?.sell?.[0]?.price ?? null,
              };
              foundKiteIds.add(kiteId);
            }
          }
        }
      } catch (tickerErr) {
        console.warn('[Kite Quotes API] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
      }
    }

    // 3. Find missing instruments that aren't in any cache
    const missingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));

    // 3. Fallback: Fetch missing instruments from Kite REST API on-demand
    if (missingKiteIds.length > 0) {
      let accessToken = request.cookies.get('kite_access_token')?.value;
      if (!accessToken) {
        const sharedSession = await getSharedKiteSession();
        accessToken = sharedSession?.accessToken;
      }
      const apiKey = process.env.KITE_API_KEY;

      if (accessToken && apiKey) {
        const { data: kiteData, tokenExpired } = await fetchKiteQuotesBatch(missingKiteIds, apiKey, accessToken);
        
        let activeKiteData = kiteData;
        if (tokenExpired) {
          const freshSession = await getSharedKiteSession();
          if (freshSession && freshSession.accessToken !== accessToken) {
            const retry = await fetchKiteQuotesBatch(missingKiteIds, apiKey, freshSession.accessToken);
            activeKiteData = retry.data;
          }
        }

        if (activeKiteData && Object.keys(activeKiteData).length > 0) {
          const instrumentUpserts: any[] = [];

          for (const [kiteId, quote] of Object.entries(activeKiteData)) {
            const reqId = realToRequestedMap[kiteId];
            if (!reqId || !quote) continue;

            const closePrice = quote.ohlc?.close || 0;
            const netChange = quote.net_change ?? (quote.last_price - closePrice);

            finalMappedData[reqId] = {
              timestamp: quote.last_trade_time || quote.timestamp || new Date().toISOString(),
              last_price: quote.last_price,
              volume: quote.volume || 0,
              ohlc: {
                open: quote.ohlc?.open || 0,
                high: quote.ohlc?.high || 0,
                low: quote.ohlc?.low || 0,
                close: closePrice,
              },
              net_change: netChange,
              bid: quote.bid ?? quote.depth?.buy?.[0]?.price ?? null,
              ask: quote.ask ?? quote.depth?.sell?.[0]?.price ?? null,
            };

            const parts = kiteId.split(':');
            const exchange = parts[0] || 'NSE';
            const tradingsymbol = parts[1] || '';

            instrumentUpserts.push({
              id: kiteId,
              instrument_token: quote.instrument_token || 0,
              tradingsymbol: tradingsymbol,
              exchange: exchange,
              instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
              segment: exchange,
              updated_at: new Date().toISOString()
            });
          }

          // Cache on-demand fetched instruments in background (excluding quotes/ticks table)
          if (instrumentUpserts.length > 0) {
            (async () => {
              try {
                const { error: instErr } = await admin
                  .from('instruments')
                  .upsert(instrumentUpserts, { onConflict: 'id' });

                if (instErr) {
                  console.error('[Quotes API] Background instruments upsert error:', instErr);
                }
              } catch (err) {
                console.error('[Quotes API] Background cache sync error:', err);
              }
            })();
          }
        }
      }
    }

    return NextResponse.json({ data: finalMappedData });
  } catch (err) {
    console.error('[Quotes API] Error:', err);
    return NextResponse.json({ data: {} });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const instruments = searchParams.getAll('instruments');
  return handleQuotesRequest(instruments, request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    return handleQuotesRequest(body.instruments || [], request);
  } catch {
    return NextResponse.json({ data: {} });
  }
}
