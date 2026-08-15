/**
 * Kite & Crypto Quotes API
 * GET / POST /api/kite/quotes
 * 
 * Target Architecture:
 * 1. Bypasses DB lookup entirely.
 * 2. Fetches from local Redis Hash cache first.
 * 3. Handles Crypto symbols directly via Binance REST API when not cached.
 * 4. Falls back to Kite REST API in batches for missing/uncached Indian instruments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getAdminClient } from '@/lib/adminClient';

const CRYPTO_BASES = new Set([
  'BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'LINK', 'UNI', 'SHIB'
]);

function isCryptoSymbol(sym: string): boolean {
  if (!sym) return false;
  const upper = sym.toUpperCase().replace(/^CRYPTO:/, '');
  if (upper.endsWith('USDT')) return true;
  return CRYPTO_BASES.has(upper);
}

function toBinancePair(sym: string): string {
  const upper = sym.toUpperCase().replace(/^CRYPTO:/, '');
  return upper.endsWith('USDT') ? upper : `${upper}USDT`;
}

async function fetchBinanceQuotesBatch(cryptoSymbols: string[]): Promise<Record<string, any>> {
  const pairs = Array.from(new Set(cryptoSymbols.map(toBinancePair)));
  if (pairs.length === 0) return {};

  const result: Record<string, any> = {};
  try {
    const formattedParams = JSON.stringify(pairs);
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedParams)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const array = await res.json();
      for (const item of array) {
        const pair = item.symbol; // e.g. BTCUSDT
        const base = pair.replace('USDT', ''); // e.g. BTC
        const lastPrice = parseFloat(item.lastPrice);
        const prevClose = parseFloat(item.prevClosePrice || item.openPrice);
        const open = parseFloat(item.openPrice);
        const high = parseFloat(item.highPrice);
        const low = parseFloat(item.lowPrice);
        const volume = Math.round(parseFloat(item.volume));
        const bid = parseFloat(item.bidPrice) || (lastPrice * 0.9995);
        const ask = parseFloat(item.askPrice) || (lastPrice * 1.0005);

        const quoteObj = {
          timestamp: new Date(item.closeTime || Date.now()).toISOString(),
          last_price: lastPrice,
          volume,
          ohlc: { open, high, low, close: prevClose },
          net_change: lastPrice - prevClose,
          bid,
          ask,
        };

        result[pair] = quoteObj;
        result[base] = quoteObj;
        result[pair.toLowerCase()] = quoteObj;
        result[base.toLowerCase()] = quoteObj;
        result[`CRYPTO:${base}`] = quoteObj;
        result[`CRYPTO:${pair}`] = quoteObj;
      }
    }
  } catch (err) {
    console.error('[Binance Quotes API] Error fetching from Binance REST API:', err);
  }
  return result;
}

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
    const cryptoRequestIds: string[] = [];

    // Separate Crypto symbols, direct Kite IDs (NSE:RELIANCE), and DB IDs
    for (const id of instruments) {
      if (isCryptoSymbol(id)) {
        cryptoRequestIds.push(id);
        realToRequestedMap[id] = id;
      } else if (id.includes(':')) {
        directKiteIds.push(id);
        realToRequestedMap[id] = id;
      } else {
        dbRequestIds.push(id);
      }
    }

    // Resolve internal DB IDs to Kite IDs (for stock / index / F&O instruments)
    if (dbRequestIds.length > 0) {
      const { data } = await admin
        .from('instruments')
        .select('id, tradingsymbol, exchange, segment')
        .in('id', dbRequestIds);

      if (data) {
        for (const row of data) {
          if (row.segment === 'CRYPTO' || isCryptoSymbol(row.tradingsymbol) || isCryptoSymbol(row.id)) {
            cryptoRequestIds.push(row.id);
            realToRequestedMap[row.id] = row.id;
          } else {
            const kiteId = `${row.exchange}:${row.tradingsymbol}`;
            realToRequestedMap[kiteId] = row.id;
            directKiteIds.push(kiteId);
          }
        }
      }
      
      // Keep unresolved ones as-is as fallback
      for (const id of dbRequestIds) {
        if (!Object.values(realToRequestedMap).includes(id)) {
          if (isCryptoSymbol(id)) {
            cryptoRequestIds.push(id);
          } else {
            realToRequestedMap[id] = id;
            directKiteIds.push(id);
          }
        }
      }
    }

    const finalMappedData: Record<string, any> = {};
    const foundKiteIds = new Set<string>();

    // 1. Fetch from Redis Hash cache first
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();

      const allSearchIds = [...directKiteIds, ...cryptoRequestIds];
      await Promise.all(allSearchIds.map(async (searchId) => {
        const cached = await redis.hget('market:quotes', searchId);
        if (cached) {
          const q = JSON.parse(cached);
          const rawTime = q.last_trade_time || q.timestamp || q.time || 0;
          const qTime = new Date(rawTime).getTime();
          // Reject stale Redis cached ticks older than 15 seconds
          const isFresh = qTime > 0 && !isNaN(qTime) && (Date.now() - qTime < 15000);
          const reqId = realToRequestedMap[searchId] || searchId;
          if (isFresh && reqId && q && q.last_price > 0) {
            const close = q.ohlc?.close || q.close || 0;
            finalMappedData[reqId] = {
              timestamp: new Date(qTime).toISOString(),
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
            foundKiteIds.add(searchId);
          }
        }
      }));
    } catch (redisErr) {
      console.warn('[Quotes API] Failed to query Redis, falling back:', redisErr);
    }

    // 2. Fetch missing Crypto symbols directly from Binance REST API
    const missingCryptoIds = cryptoRequestIds.filter(id => !foundKiteIds.has(id));
    if (missingCryptoIds.length > 0) {
      const binanceQuotes = await fetchBinanceQuotesBatch(missingCryptoIds);
      for (const reqId of missingCryptoIds) {
        const quote = binanceQuotes[reqId] || binanceQuotes[toBinancePair(reqId)] || binanceQuotes[reqId.toUpperCase()];
        if (quote) {
          finalMappedData[reqId] = quote;
          foundKiteIds.add(reqId);
        }
      }
    }

    // 3. Fallback to Ticker Daemon in-memory quotes API for remaining stock symbols
    const remainingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));
    if (remainingKiteIds.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
        if (tickerUrl) {
          const params = new URLSearchParams({ symbols: remainingKiteIds.join(',') });
          const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
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
        }
      } catch (tickerErr) {
        console.warn('[Quotes API] Failed to query Ticker Daemon:', tickerErr);
      }
    }

    // 4. Fallback: Fetch missing Indian stock instruments from Kite REST API on-demand
    const missingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));
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
