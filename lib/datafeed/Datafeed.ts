type Bar = any;
type DatafeedConfiguration = any;
type DatafeedErrorCallback = any;
type HistoryCallback = any;
type IBasicDataFeed = any;
type LibrarySymbolInfo = any;
type OnReadyCallback = any;
type PeriodParams = any;
type ResolveCallback = any;
type ResolutionString = any;
type SubscribeBarsCallback = any;
import { fetchBars } from './historyProvider';
import { RealtimeProvider } from './realtimeProvider';
import { buildSymbolInfo } from './symbolResolver';

/**
 * TradingView `IBasicDataFeed` implementation.
 *
 * One instance is created per TV_Widget. The `segment` string (e.g. "CRYPTO",
 * "NSE - Equity") is injected at construction time so that every data-fetch
 * call can route correctly without needing to infer the segment per-call.
 *
 * Public API surface:
 *  - Standard datafeed methods required by IBasicDataFeed (onReady, resolveSymbol,
 *    getBars, subscribeBars, unsubscribeBars)
 *  - `updateLive(lastPrice, nowMs)` — called by ChartContainer when a liveQuote
 *    arrives so the active subscriber callback receives a real-time bar update.
 */
export class Datafeed implements IBasicDataFeed {
  private readonly realtimeProvider: RealtimeProvider;
  private readonly lastBarCache = new Map<string, Bar>();

  constructor(private readonly segment: string) {
    this.realtimeProvider = new RealtimeProvider();
  }

  // ---------------------------------------------------------------------------
  // IExternalDatafeed
  // ---------------------------------------------------------------------------

  /**
   * Called once by the TV_Widget immediately after construction.
   * Invokes the callback asynchronously (within one event-loop tick) with the
   * datafeed configuration so the widget can proceed with symbol resolution.
   *
   * Requirements: 2.1
   */
  onReady(callback: OnReadyCallback): void {
    setTimeout(() => {
      callback({
        supported_resolutions: ['1', '2', '3', '5', '10', '15', '30', '60', 'D'] as ResolutionString[],
      } satisfies DatafeedConfiguration);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // IDatafeedChartApi
  // ---------------------------------------------------------------------------

  /**
   * Resolves a symbol name to a `LibrarySymbolInfo` descriptor.
   * The resolution is synchronous — `buildSymbolInfo` is a pure function that
   * never throws, so `onResolve` is called immediately.
   *
   * Requirements: 2.2, 2.3, 2.4, 4.2, 4.3
   */
  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    _onError: DatafeedErrorCallback,
  ): void {
    const info = buildSymbolInfo(symbolName, this.segment);
    onResolve(info);
  }

  /**
   * Fetches historical bars for the given symbol, resolution and time range.
   *
   * On success:
   *  - If bars were returned, stores the last bar on the RealtimeProvider so
   *    the first live tick can be merged correctly.
   *  - Calls `onResult` with the bars array and `{ noData }` flag.
   *
   * On failure:
   *  - Calls `onError` with a descriptive message.
   *
   * Requirements: 2.5, 2.6, 2.7, 2.8
   */
  async getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): Promise<void> {
    try {
      const { bars, noData } = await fetchBars(symbolInfo, resolution, periodParams, this.segment);
      if (bars.length > 0 && (periodParams.firstDataRequest === undefined || periodParams.firstDataRequest)) {
        const lastBar = bars[bars.length - 1] as Bar;
        this.lastBarCache.set(resolution, lastBar);
        // Cast to the RealtimeProvider's local Bar type — shape is identical.
        this.realtimeProvider.setLastBar(lastBar, resolution);
      }
      onResult(bars, { noData });
    } catch (err) {
      onError(`Failed to fetch bars: ${(err as Error).message}`);
    }
  }

  /**
   * Called by the TV_Widget when it wants to start receiving real-time bar
   * updates for a symbol/resolution combination.
   *
   * Requirements: 2.9
   */
  subscribeBars(
    _symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    _onResetCacheNeededCallback: () => void,
  ): void {
    const lastBar = this.lastBarCache.get(resolution) || null;
    this.realtimeProvider.subscribe(listenerGuid, {
      callback: onTick,
      resolution,
      lastBar,
    });
  }

  /**
   * Called by the TV_Widget to stop receiving real-time updates.
   * Delegates to `RealtimeProvider.unsubscribe`, which is a no-op for unknown UIDs.
   *
   * Requirements: 2.10
   */
  unsubscribeBars(listenerGuid: string): void {
    this.realtimeProvider.unsubscribe(listenerGuid);
  }

  /**
   * Required by IDatafeedChartApi but not used — symbol search is not needed
   * because the chart is always opened with a pre-known symbol from the watchlist.
   */
  searchSymbols(): void {
    // no-op: symbol search is not supported in this datafeed
  }

  getServerTime(callback: (serverTime: number) => void): void {
    callback(Math.floor(Date.now() / 1000));
  }

  // ---------------------------------------------------------------------------
  // Public extension (called by ChartContainer)
  // ---------------------------------------------------------------------------

  /**
   * Forwards a live price tick to the RealtimeProvider, which computes the
   * updated candle bar and notifies all active subscribers.
   *
   * Should only be called after the loading guards in ChartContainer confirm
   * that `loading === false`, `candles.length > 0`, and the price is finite > 0.
   */
  updateLive(lastPrice: number, nowMs: number): void {
    this.realtimeProvider.update(lastPrice, nowMs);
  }
}
