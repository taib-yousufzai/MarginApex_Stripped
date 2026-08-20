import React, { useEffect, useRef, useState } from 'react';
// import type { IChartingLibraryWidget } from '@/public/charting_library/charting_library';
import { Datafeed } from '@/lib/datafeed/Datafeed';
import { toUdfResolution, CHART_TYPE_MAP } from '@/lib/datafeed/resolutionUtils';
import { Candle, Timeframe } from '@/components/chart/types';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';

// ─── Supporting types ────────────────────────────────────────────────────────

interface PendingChanges {
  symbol?: string;
  timeframe?: Timeframe;
  chartType?: 'candle' | 'area' | 'bar' | 'baseline';
  theme?: 'dark' | 'light';
  indicators?: boolean;
}

type IndicatorKey = 'sma' | 'ema' | 'rsi' | 'macd';
type IndicatorEntityIds = Record<IndicatorKey, string | null>;

// ─── Props interface (must match TradingChart.tsx exactly) ───────────────────

interface ChartContainerProps {
  symbol: string;
  segment: string;
  timeframe: Timeframe;
  chartType: 'candle' | 'area' | 'bar' | 'baseline';
  candles: Candle[];
  liveQuote?: any;
  loading: boolean;
  error: string | null;
  loadId?: string;
  /** Called once when the TV widget's first getBars response arrives with bars */
  onFirstBar?: (lastClose: number, prevClose: number | null) => void;
}

// Global counters for React lifecycle tracking across component instances
let globalMountCount = 0;
let globalUnmountCount = 0;
let globalWidgetCreateCount = 0;
let globalWidgetDestroyCount = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getIsDark(): boolean {
  if (typeof document === 'undefined') return true;
  return (
    document.body.classList.contains('dark') ||
    document.body.classList.contains('black')
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChartContainer({
  symbol,
  segment,
  timeframe,
  chartType,
  candles,
  liveQuote,
  loading,
  error,
  loadId: propLoadId,
  onFirstBar,
}: ChartContainerProps) {
  const activeLoadId = propLoadId || 'def';
  const loadStartTimeRef = useRef(performance.now());
  // ── Refs ──────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const tvWidgetRef = useRef<any | null>(null);
  const datafeedRef = useRef<Datafeed | null>(null);
  const isReadyRef = useRef(false);
  const pendingRef = useRef<PendingChanges>({});
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFirstBarRef = useRef(onFirstBar);
  // Keep the callback ref current without re-running the init effect
  useEffect(() => { onFirstBarRef.current = onFirstBar; }, [onFirstBar]);

  // Update datafeed loadId when propLoadId changes
  useEffect(() => {
    if (datafeedRef.current && propLoadId) {
      datafeedRef.current.setLoadId(propLoadId);
    }
  }, [propLoadId]);

  // ── State (drives overlay rendering only) ─────────────────────────────────
  const [chartStatus, setChartStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [chartError, setChartError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(getIsDark);

  // ── Native Toolbar Listeners ─────────────────────────────────────────────
  useEffect(() => {
    const handleShowIndicators = () => {
      if (isReadyRef.current && tvWidgetRef.current) {
        tvWidgetRef.current.chart().executeActionById('insertIndicator');
      }
    };
    const handleToggleDrawings = () => {
      if (isReadyRef.current && tvWidgetRef.current) {
        tvWidgetRef.current.chart().executeActionById('drawingToolbarAction');
      }
    };
    document.addEventListener('tv-show-indicators', handleShowIndicators);
    document.addEventListener('tv-toggle-drawings', handleToggleDrawings);
    return () => {
      document.removeEventListener('tv-show-indicators', handleShowIndicators);
      document.removeEventListener('tv-toggle-drawings', handleToggleDrawings);
    };
  }, []);



  // ── Task 8.2: Widget initialization — runs ONCE on mount ─────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    globalMountCount++;
    const startTime = performance.now();
    loadStartTimeRef.current = startTime;
    console.log(`[CHART TRACE ${activeLoadId}] +0.0ms [2] ChartContainer mount (mountCount=${globalMountCount}, unmountCount=${globalUnmountCount}): symbol=${symbol}, segment=${segment}`);

    const initWidget = () => {
      if (!containerRef.current || tvWidgetRef.current) return;

      globalWidgetCreateCount++;
      const initStart = performance.now();
      console.log(`[CHART TRACE ${activeLoadId}] +${(initStart - startTime).toFixed(1)}ms [3] TradingView widget creation START (widgetCreateCount=${globalWidgetCreateCount})`);
      
      datafeedRef.current = new Datafeed(segment, activeLoadId, startTime);
      datafeedRef.current.onFirstBar = (lastClose, prevClose) => {
        onFirstBarRef.current?.(lastClose, prevClose);
      };

      let savedData;
      try {
        const stored = localStorage.getItem('marginapexx_tv_layout');
        if (stored) {
          savedData = JSON.parse(stored);
        }
      } catch (e) {
        console.error('Failed to parse saved chart layout:', e);
      }

      tvWidgetRef.current = new window.TradingView.widget({
        container: containerRef.current,
        symbol,
        interval: toUdfResolution(timeframe) as any,
        datafeed: datafeedRef.current,
        library_path: '/charting_library/',
        locale: 'en',
        timezone: 'Asia/Kolkata',
        theme: isDark ? 'dark' : 'light',
        autosize: true,
        saved_data: savedData,
        client_id: 'marginapexx',
        user_id: 'public_user',
        auto_save_delay: 1,
        disabled_features: ['timeframes_toolbar', 'countdown', 'header_widget'],
        enabled_features: [],
        overrides: {
          "mainSeriesProperties.showCountdown": false
        }
      });

      console.log(`[CHART TRACE ${activeLoadId}] +${(performance.now() - startTime).toFixed(1)}ms TradingView widget created (iframe element inserting...)`);

      // Monitor for iframe insertion in DOM
      const checkIframeInterval = setInterval(() => {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe) {
          clearInterval(checkIframeInterval);
          console.log(`[CHART TRACE ${activeLoadId}] +${(performance.now() - startTime).toFixed(1)}ms iframe loaded into DOM`);
        }
      }, 20);

      tvWidgetRef.current.onChartReady(() => onChartReady(startTime, checkIframeInterval));
    };

    const onChartReady = (startTime: number, checkIframeInterval?: ReturnType<typeof setInterval>) => {
      if (checkIframeInterval) clearInterval(checkIframeInterval);
      const readyTime = performance.now();
      console.log(`[CHART TRACE ${activeLoadId}] +${(readyTime - startTime).toFixed(1)}ms [4] widget.onChartReady fired!`);
      if (initTimerRef.current) {
        clearTimeout(initTimerRef.current);
        initTimerRef.current = null;
      }
      isReadyRef.current = true;
      setChartStatus('ready');
      console.log(`[CHART TRACE ${activeLoadId}] +${(performance.now() - startTime).toFixed(1)}ms [14] Chart visually usable`);

      // Inject CSS directly to hide native header in case feature flags or custom CSS fail
      try {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe && iframe.contentDocument) {
          const style = iframe.contentDocument.createElement('style');
          style.innerHTML = '.layout__area--top { display: none !important; } .header-chart-panel { display: none !important; }';
          iframe.contentDocument.head.appendChild(style);
        }
      } catch (e) {
        console.error('Failed to inject CSS into TV iframe', e);
      }

      // Drain the pending queue
      const pending = pendingRef.current;
      if (pending.symbol) {
        tvWidgetRef.current?.chart().setSymbol(pending.symbol);
      }
      if (pending.timeframe) {
        tvWidgetRef.current?.chart().setResolution(toUdfResolution(pending.timeframe) as any);
      }
      if (pending.chartType) {
        tvWidgetRef.current?.chart().setChartType(CHART_TYPE_MAP[pending.chartType] as any);
      }
      if (pending.theme) {
        tvWidgetRef.current?.changeTheme(pending.theme);
      }
      pendingRef.current = {};

      const saveChartState = () => {
        if (!tvWidgetRef.current) return;
        try {
          tvWidgetRef.current.save((state: any) => {
            if (state) {
              localStorage.setItem('marginapexx_tv_layout', JSON.stringify(state));
            }
          });
        } catch (e) {
          console.error('Failed to save chart layout:', e);
        }
      };

      // Subscribe to auto save and drawing/indicator changes
      tvWidgetRef.current?.subscribe('onAutoSaveNeeded', saveChartState);
      tvWidgetRef.current?.subscribe('drawing_event', saveChartState);
      tvWidgetRef.current?.subscribe('study_event', saveChartState);
    };

    // Arm 30-second timeout
    initTimerRef.current = setTimeout(() => {
      setChartStatus('error');
      setChartError('Chart failed to initialize. Please refresh the page.');
    }, 30_000);

    const scriptCheckTime = performance.now();
    if (window.TradingView) {
      console.log(`[CHART PERF ${activeLoadId}] +${(scriptCheckTime - startTime).toFixed(1)}ms TradingView script check: ALREADY LOADED in window`);
      initWidget();
    } else {
      console.log(`[CHART PERF ${activeLoadId}] +${(scriptCheckTime - startTime).toFixed(1)}ms TradingView script check: NOT IN WINDOW -> dynamically loading script element`);
      const script = document.createElement('script');
      script.src = '/charting_library/charting_library.standalone.js';
      script.onload = () => {
        console.log(`[CHART PERF ${activeLoadId}] +${(performance.now() - startTime).toFixed(1)}ms TradingView script onload fired! window.TradingView is now available.`);
        initWidget();
      };
      document.head.appendChild(script);
    }

    return () => {
      globalUnmountCount++;
      globalWidgetDestroyCount++;
      console.log(`[CHART PERF ${activeLoadId}] +${(performance.now() - loadStartTimeRef.current).toFixed(1)}ms ChartContainer unmount & tvWidget destroy (unmountCount=${globalUnmountCount}, widgetDestroyCount=${globalWidgetDestroyCount})`);
      if (initTimerRef.current) {
        clearTimeout(initTimerRef.current);
        initTimerRef.current = null;
      }
      tvWidgetRef.current?.remove();
      tvWidgetRef.current = null;
      datafeedRef.current = null;
      isReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Task 8.3: symbol, timeframe, chartType effects ───────────────────────

  useEffect(() => {
    if (!isReadyRef.current) { pendingRef.current.symbol = symbol; return; }
    tvWidgetRef.current?.chart().setSymbol(symbol);
  }, [symbol]);

  useEffect(() => {
    if (datafeedRef.current) {
      datafeedRef.current.setSegment(segment);
    }
  }, [segment]);

  useEffect(() => {
    if (!isReadyRef.current) { pendingRef.current.timeframe = timeframe; return; }
    tvWidgetRef.current?.chart().setResolution(toUdfResolution(timeframe) as any);
  }, [timeframe]);

  useEffect(() => {
    if (!isReadyRef.current) { pendingRef.current.chartType = chartType; return; }
    tvWidgetRef.current?.chart().setChartType(CHART_TYPE_MAP[chartType] as any);
  }, [chartType]);

  // ── Task 8.5: Live quote forwarding ──────────────────────────────────────
  const { quotes: marketQuotes } = useMarketQuotes([symbol]);
  const activeQuote = marketQuotes[symbol] || liveQuote;

  useEffect(() => {
    let lastPrice = activeQuote?.lastPrice ?? activeQuote?.last_price;
    if (lastPrice !== undefined) lastPrice = Number(lastPrice);

    let volume = activeQuote?.volume ?? activeQuote?.v;
    if (volume !== undefined) volume = Number(volume);

    let nowMs = activeQuote?.timestamp ? new Date(activeQuote.timestamp).getTime() : Date.now();
    if (nowMs !== undefined) nowMs = Number(nowMs);

    if (loading || candles.length === 0) return;
    if (!lastPrice || !isFinite(lastPrice) || lastPrice <= 0) return;

    datafeedRef.current?.updateLive(symbol, lastPrice, nowMs, volume);
  }, [activeQuote, symbol, loading, candles.length]);

  // ── Task 8.5: Theme sync via MutationObserver ─────────────────────────────

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dark = getIsDark();
      setIsDark(dark);
      const theme = dark ? 'dark' : 'light';
      if (!isReadyRef.current) { pendingRef.current.theme = theme; return; }
      tvWidgetRef.current?.changeTheme(theme);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // ── Task 8.6: Render ──────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', flex: 1, width: '100%', height: '100%', overflow: 'hidden' }}>

      {/* Widget mount target */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, height: '100%' }}
      />

      {/* Loading overlay */}
      {chartStatus === 'loading' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          background: isDark ? 'rgba(7, 24, 36, 0.85)' : 'rgba(255, 255, 255, 0.85)',
        }}>
          <AnimatedLoader text="Loading chart data..." fullScreen={false} />
        </div>
      )}

      {/* Error overlay (widget-level error or timeout) */}
      {chartStatus === 'error' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ color: '#F23645', fontSize: '13px', fontWeight: 600, maxWidth: '80%', textAlign: 'center' }}>
            {chartError}
          </div>
        </div>
      )}

      {/* Error prop text (data fetch error — no candles yet) */}
      {error !== null && !loading && candles.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isDark ? '#071824' : '#FFFFFF',
        }}>
          <div style={{ color: '#F23645', fontSize: '13px', fontWeight: 600, maxWidth: '80%', textAlign: 'center' }}>
            {error}
          </div>
        </div>
      )}
    </div>
  );
}
