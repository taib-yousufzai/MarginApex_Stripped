import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/binance/quotes?symbols=BTCUSDT,ETHUSDT
 * Returns latest Binance 24hr ticker data for crypto symbols
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawSymbols = searchParams.get('symbols')?.split(',') || [];

  const symbols = rawSymbols
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => (s.endsWith('USDT') ? s : `${s}USDT`));

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotes: Record<string, any> = {};
    const uniqueSymbols = Array.from(new Set(symbols));
    const symbolsParam = JSON.stringify(uniqueSymbols);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach((item: any) => {
          if (item && item.symbol) {
            const lp = parseFloat(item.lastPrice || '0');
            const quote = {
              symbol: item.symbol,
              lastPrice: lp,
              prevClosePrice: parseFloat(item.prevClosePrice || item.openPrice || '0'),
              openPrice: parseFloat(item.openPrice || '0'),
              highPrice: parseFloat(item.highPrice || '0'),
              lowPrice: parseFloat(item.lowPrice || '0'),
              volume: parseFloat(item.volume || '0'),
              time: item.closeTime || Date.now(),
              bid: lp * 0.9995,
              ask: lp * 1.0005,
            };
            quotes[item.symbol] = quote;
            const shortSymbol = item.symbol.replace('USDT', '');
            quotes[shortSymbol] = quote;
          }
        });
      }
    }

    return NextResponse.json({ success: true, data: quotes });
  } catch (err) {
    console.error('[GET /api/binance/quotes] Error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Binance quotes' },
      { status: 500 }
    );
  }
}

