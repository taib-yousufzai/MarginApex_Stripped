import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/binance/quotes?symbols=BTCUSDT,ETHUSDT
 * Returns latest Binance 24hr ticker data for crypto symbols
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbols = searchParams.get('symbols')?.split(',') || [];

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotes: Record<string, any> = {};

    // Fetch all symbols in parallel
    const promises = symbols.map(async (symbol) => {
      const sym = symbol.trim().toUpperCase();
      if (!sym) return null;

      // Ensure symbol ends with USDT
      const binanceSymbol = sym.endsWith('USDT') ? sym : `${sym}USDT`;

      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`, {
          cache: 'no-store',
        });

        if (!res.ok) return null;

        const data = await res.json();
        if (data.code) return null;

        return {
          symbol: binanceSymbol,
          lastPrice: parseFloat(data.lastPrice),
          prevClosePrice: parseFloat(data.prevClosePrice),
          openPrice: parseFloat(data.openPrice),
          highPrice: parseFloat(data.highPrice),
          lowPrice: parseFloat(data.lowPrice),
          volume: parseFloat(data.volume),
          time: data.time,
        };
      } catch (err) {
        console.error(`Failed to fetch ${binanceSymbol}:`, err);
        return null;
      }
    });

    const results = await Promise.all(promises);

    results.forEach((quote) => {
      if (quote) {
        // Store by full symbol (e.g., BTCUSDT)
        quotes[quote.symbol] = quote;
        // Also store by short symbol (e.g., BTC)
        const shortSymbol = quote.symbol.replace('USDT', '');
        quotes[shortSymbol] = quote;
      }
    });

    return NextResponse.json({ success: true, data: quotes });
  } catch (err) {
    console.error('[GET /api/binance/quotes] Error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Binance quotes' },
      { status: 500 }
    );
  }
}
