type Bar = any;
type LibrarySymbolInfo = any;
type PeriodParams = any;
type ResolutionString = any;
import { resolutionToBinanceInterval, resolutionToKiteInterval } from './resolutionUtils';

type BinanceKline = any[];

/**
 * Fetches historical bars for a given symbol and resolution.
 *
 * Routes to the Binance API for CRYPTO symbols (segment === 'CRYPTO' or ticker ends with 'USDT'),
 * and to the internal Kite API for all other (Indian market) symbols.
 *
 * Throws on fetch/parse errors so the caller (Datafeed.getBars) can invoke onErrorCallback.
 */
export async function fetchBars(
  symbolInfo: LibrarySymbolInfo,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  segment: string,
  loadId: string = 'default',
  getBarsCallNum: number = 1,
  loadStartTime: number = performance.now()
): Promise<{ bars: Bar[]; noData: boolean }> {
  try {
    const isCrypto =
      segment.toUpperCase() === 'CRYPTO' ||
      (symbolInfo.ticker ?? symbolInfo.name).endsWith('USDT');

    if (isCrypto) {
      return fetchBinanceBars(symbolInfo.name, resolution, periodParams, loadId, getBarsCallNum, loadStartTime);
    } else {
      return fetchKiteBars(symbolInfo.ticker ?? symbolInfo.name, resolution, periodParams, loadId, getBarsCallNum, loadStartTime);
    }
  } catch (err) {
    throw err;
  }
}

/**
 * Fetches bars from the Binance klines REST API.
 * Bar.time is already in milliseconds (kline[0]).
 */
async function fetchBinanceBars(
  symbol: string,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  loadId: string,
  getBarsCallNum: number,
  loadStartTime: number
): Promise<{ bars: Bar[]; noData: boolean }> {
  const interval = resolutionToBinanceInterval(resolution);
  const url =
    `/api/market/historical-crypto` +
    `?symbol=${symbol}` +
    `&interval=${interval}` +
    `&startTime=${periodParams.from * 1000}` +
    `&endTime=${periodParams.to * 1000}` +
    `&limit=1000`;

  const fetchStart = performance.now();
  console.log(`[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Crypto START: ${symbol} (${interval})`);

  const data: BinanceKline[] = await fetch(url).then((r) => {
    if (!r.ok) throw new Error('Network response was not ok');
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const bars: Bar[] = data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  console.log(`[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Crypto COMPLETE: ${symbol} -> ${bars.length} bars (fetch took ${duration.toFixed(1)}ms, noData=${bars.length === 0})`);
  return { bars, noData: bars.length === 0 };
}

/**
 * Fetches bars from the internal Kite (Zerodha) historical data API.
 * Bar.time is derived from the ISO date string in candle[0].
 */
async function fetchKiteBars(
  ticker: string,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  loadId: string,
  getBarsCallNum: number,
  loadStartTime: number
): Promise<{ bars: Bar[]; noData: boolean }> {
  const interval = resolutionToKiteInterval(resolution);

  const formatDate = (tsSeconds: number) => {
    const d = new Date(tsSeconds * 1000);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
  };

  const fromFmt = formatDate(periodParams.from);
  const toFmt = formatDate(periodParams.to);

  const url =
    `/api/market/historical` +
    `?symbol=${encodeURIComponent(ticker)}` +
    `&interval=${interval}` +
    `&from=${encodeURIComponent(fromFmt)}` +
    `&to=${encodeURIComponent(toFmt)}`;

  const fetchStart = performance.now();
  console.log(`[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Kite START: ${ticker} (${resolution}) [from: ${fromFmt}, to: ${toFmt}]`);

  const json = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Historical data fetch failed: ${r.status} ${r.statusText}`);
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const candles: any[][] = json?.data?.candles ?? json?.candles ?? [];

  if (!Array.isArray(candles)) {
    throw new Error(json?.error || json?.message || 'Invalid candles response from server');
  }

  const bars: Bar[] = candles.map((c) => ({
    time: new Date(c[0]).getTime(),
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5] ?? 0,
  }));

  console.log(`[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Kite COMPLETE: ${ticker} -> ${bars.length} bars (fetch took ${duration.toFixed(1)}ms, noData=${bars.length === 0})`);
  return { bars, noData: bars.length === 0 };
}
