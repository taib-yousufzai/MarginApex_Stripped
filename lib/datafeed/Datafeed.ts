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
 */
export class Datafeed implements IBasicDataFeed {
  private readonly realtimeProvider: RealtimeProvider;
  private readonly lastBarCache = new Map<string, Bar>();
  private firstBarFired = false;
  private firstRealtimeTickLogged = false;
  private getBarsCallNum = 0;
  private loadId: string = 'default';
  private loadStartTime: number = performance.now();
  onFirstBar?: (lastClose: number, prevClose: number | null) => void;

  constructor(private segment: string, loadId?: string, loadStartTime?: number) {
    this.realtimeProvider = new RealtimeProvider();
    if (loadId) this.loadId = loadId;
    if (loadStartTime) this.loadStartTime = loadStartTime;
  }

  setSegment(segment: string) {
    this.segment = segment;
    this.firstBarFired = false;
    this.firstRealtimeTickLogged = false;
  }

  setLoadId(loadId: string, startTime?: number) {
    this.loadId = loadId;
    this.loadStartTime = startTime ?? performance.now();
    this.getBarsCallNum = 0;
    this.firstBarFired = false;
    this.firstRealtimeTickLogged = false;
    this.lastBarCache.clear();
  }

  // ---------------------------------------------------------------------------
  // IExternalDatafeed
  // ---------------------------------------------------------------------------

  onReady(callback: OnReadyCallback): void {
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms Datafeed.onReady called by TV iframe`);
    setTimeout(() => {
      callback({
        supported_resolutions: ['1', '2', '3', '5', '10', '15', '30', '60', 'D'] as ResolutionString[],
        supports_time: true,
      } satisfies DatafeedConfiguration);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // IDatafeedChartApi
  // ---------------------------------------------------------------------------

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    _onError: DatafeedErrorCallback,
  ): void {
    const start = performance.now();
    const elapsed = (start - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [5] Datafeed.resolveSymbol START: ${symbolName}`);
    const info = buildSymbolInfo(symbolName, this.segment);
    onResolve(info);
    const endElapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${endElapsed}ms Datafeed.resolveSymbol END: ${symbolName}`);
  }

  async getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): Promise<void> {
    this.getBarsCallNum++;
    const currentCallNum = this.getBarsCallNum;
    const start = performance.now();
    const startElapsed = (start - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${startElapsed}ms [6] Datafeed.getBars #${currentCallNum} START: ${symbolInfo.name} (${resolution}) [from: ${periodParams.from}, to: ${periodParams.to}, firstDataRequest: ${periodParams.firstDataRequest}]`);
    try {
      const { bars, noData } = await fetchBars(symbolInfo, resolution, periodParams, this.segment, this.loadId, currentCallNum, this.loadStartTime);
      const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
      console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [7] Datafeed.getBars #${currentCallNum} END: ${symbolInfo.name} -> ${bars.length} bars (took ${(performance.now() - start).toFixed(1)}ms, noData=${noData})`);
      
      if (bars.length > 0 && (periodParams.firstDataRequest === undefined || periodParams.firstDataRequest)) {
        const firstBar = bars[0] as Bar;
        const lastBar = bars[bars.length - 1] as Bar;
        
        const cacheKey = `${symbolInfo.name}:${resolution}`;
        this.lastBarCache.set(cacheKey, lastBar);

        console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [8] First historical bar received: time=${firstBar.time}, close=${firstBar.close}`);
        console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [9] lastBar established: symbol=${symbolInfo.name}, resolution=${resolution}, time=${lastBar.time}, close=${lastBar.close}`);

        this.realtimeProvider.setLastBar(symbolInfo.name, resolution, lastBar);

        if (!this.firstBarFired) {
          this.firstBarFired = true;
          const prevClose = bars.length > 1 ? (bars[bars.length - 2] as Bar).close : null;
          console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [13] First visible candle rendered: lastClose=${lastBar.close}`);
          this.onFirstBar?.(lastBar.close, prevClose);
        }
      }
      onResult(bars, { noData });
    } catch (err) {
      const errElapsed = (performance.now() - this.loadStartTime).toFixed(1);
      console.error(`[CHART TRACE ${this.loadId}] +${errElapsed}ms Datafeed.getBars #${currentCallNum} ERROR:`, err);
      onError(`Failed to fetch bars: ${(err as Error).message}`);
    }
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    _onResetCacheNeededCallback: () => void,
  ): void {
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [10] subscribeBars START: listenerGuid=${listenerGuid} symbol=${symbolInfo.name} (${resolution})`);
    
    const cacheKey = `${symbolInfo.name}:${resolution}`;
    const lastBar = this.lastBarCache.get(cacheKey) || null;

    this.realtimeProvider.subscribe(listenerGuid, {
      symbol: symbolInfo.name,
      resolution,
      callback: (bar: Bar) => {
        onTick(bar);
      },
      lastBar,
      loadId: this.loadId,
      loadStartTime: this.loadStartTime,
    });
  }

  unsubscribeBars(listenerGuid: string): void {
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms Datafeed.unsubscribeBars: ${listenerGuid}`);
    this.realtimeProvider.unsubscribe(listenerGuid);
  }

  searchSymbols(): void {
    // no-op
  }

  getServerTime(callback: (serverTime: number) => void): void {
    callback(Math.floor(Date.now() / 1000));
  }

  updateLive(symbol: string, lastPrice: number, nowMs: number, volume?: number) {
    if (!this.firstRealtimeTickLogged) {
      this.firstRealtimeTickLogged = true;
      const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
      console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [11] First realtime tick received: symbol=${symbol}, price=${lastPrice}`);
    }
    this.realtimeProvider.update(symbol, lastPrice, nowMs, volume);
  }
}
