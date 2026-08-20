import { chromium } from 'playwright-core';

interface MetricEntry {
  loadId: string;
  symbol: string;
  type: string;
  step1_renderMs?: number;
  step2_mountMs?: number;
  step3_widgetCreateMs?: number;
  step4_onChartReadyMs?: number;
  step5_resolveSymbolMs?: number;
  step6_getBarsStartMs?: number;
  step7_getBarsEndMs?: number;
  step8_firstBarMs?: number;
  step9_lastBarMs?: number;
  step10_subscribeBarsMs?: number;
  step11_realtimeRxMs?: number;
  step12_realtimeFwdMs?: number;
  step13_visibleCandleMs?: number;
  step14_usableMs?: number;
  totalGetBarsCalls: number;
  totalWidgetCreations: number;
  totalReactRenders: number;
  errorMessages: string[];
}

async function runBenchmark() {
  console.log('=====================================================');
  console.log('     TRADINGVIEW CHART LIFECYCLE & PERF BENCHMARK    ');
  console.log('=====================================================\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const metrics: MetricEntry[] = [];
  const networkRequests: { url: string; status: number; durationMs: number }[] = [];
  const consoleErrors: string[] = [];
  const detectedLoopErrors: string[] = [];

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
    if (
      text.includes('Incremental update failed') ||
      text.includes('Starting full update') ||
      text.includes('Returned data should be in the requested range')
    ) {
      detectedLoopErrors.push(text);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/') || url.includes('/charting_library/')) {
      const timing = res.request().timing();
      const durationMs = timing ? Math.max(0, timing.responseEnd - timing.requestStart) : 0;
      networkRequests.push({ url, status: res.status(), durationMs });
    }
  });

  await context.addInitScript(() => {
    (window as any).__disableAuthRedirect = true;
  });

  console.log('1. Navigating to watchlist page...');
  await page.goto('http://localhost:3000/watchlist', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as any).__reactOpenChartSheet === 'function', { timeout: 15000 });
  console.log('✓ Watchlist & React handlers ready!\n');

  // Helper to open chart for a symbol and capture lifecycle logs
  const testChartOpen = async (symbol: string, type: 'COLD' | 'WARM' | 'SYMBOL_SWITCH' | 'TIMEFRAME_SWITCH') => {
    console.log(`-----------------------------------------------------`);
    console.log(`>>> TEST RUN: ${type} [Symbol: ${symbol}]`);
    console.log(`-----------------------------------------------------`);

    const traceLogs: string[] = [];
    const logHandler = (msg: any) => {
      const text = msg.text();
      if (text.includes('[CHART TRACE') || text.includes('[CHART PERF')) {
        traceLogs.push(text);
        console.log(`  ${text}`);
      }
    };

    page.on('console', logHandler);

    const startTime = Date.now();
    await page.evaluate((sym) => {
      const fn = (window as any).__reactOpenChartSheet;
      fn({
        id: sym,
        symbol: sym,
        segment: sym.startsWith('MCX:') ? 'MCX - Futures' : 'NSE - Futures',
        kiteSymbol: sym.startsWith('MCX:') || sym.startsWith('NSE:') ? sym : `NSE:${sym}`,
        preferredView: 'kite',
      });
    }, symbol);

    // Wait for visual usability or timeout
    await page.waitForTimeout(4500);
    page.off('console', logHandler);

    // Parse metric details from logs
    let loadId = 'unknown';
    let renderMs, mountMs, widgetCreateMs, readyMs, resolveMs, getBarsStartMs, getBarsEndMs;
    let firstBarMs, lastBarMs, subscribeMs, realtimeRxMs, realtimeFwdMs, candleMs, usableMs;
    let getBarsCount = 0;
    let widgetCreateCount = 0;
    let renderCount = 0;

    for (const log of traceLogs) {
      const matchId = log.match(/\[CHART TRACE ([a-zA-Z0-9_]+)\]/);
      if (matchId) loadId = matchId[1];

      if (log.includes('Datafeed.getBars #')) getBarsCount++;
      if (log.includes('[3] TradingView widget creation START')) widgetCreateCount++;
      if (log.includes('[1] TradingChart render')) renderCount++;

      const timeMatch = log.match(/\+([0-9.]+)ms/);
      const ms = timeMatch ? parseFloat(timeMatch[1]) : undefined;

      if (log.includes('[1] TradingChart render')) renderMs = ms;
      if (log.includes('[2] ChartContainer mount')) mountMs = ms;
      if (log.includes('[3] TradingView widget creation START')) widgetCreateMs = ms;
      if (log.includes('[4] widget.onChartReady fired')) readyMs = ms;
      if (log.includes('[5] Datafeed.resolveSymbol START')) resolveMs = ms;
      if (log.includes('[6] Datafeed.getBars #1 START')) getBarsStartMs = ms;
      if (log.includes('[7] Datafeed.getBars #1 END')) getBarsEndMs = ms;
      if (log.includes('[8] First historical bar received')) firstBarMs = ms;
      if (log.includes('[9] lastBar established')) lastBarMs = ms;
      if (log.includes('[10] subscribeBars START')) subscribeMs = ms;
      if (log.includes('[11] First realtime tick received')) realtimeRxMs = ms;
      if (log.includes('[12] First realtime tick forwarded')) realtimeFwdMs = ms;
      if (log.includes('[13] First visible candle rendered')) candleMs = ms;
      if (log.includes('[14] Chart visually usable')) usableMs = ms;
    }

    metrics.push({
      loadId,
      symbol,
      type,
      step1_renderMs: renderMs,
      step2_mountMs: mountMs,
      step3_widgetCreateMs: widgetCreateMs,
      step4_onChartReadyMs: readyMs,
      step5_resolveSymbolMs: resolveMs,
      step6_getBarsStartMs: getBarsStartMs,
      step7_getBarsEndMs: getBarsEndMs,
      step8_firstBarMs: firstBarMs,
      step9_lastBarMs: lastBarMs,
      step10_subscribeBarsMs: subscribeMs,
      step11_realtimeRxMs: realtimeRxMs,
      step12_realtimeFwdMs: realtimeFwdMs,
      step13_visibleCandleMs: candleMs,
      step14_usableMs: usableMs,
      totalGetBarsCalls: getBarsCount,
      totalWidgetCreations: widgetCreateCount,
      totalReactRenders: renderCount,
      errorMessages: [...detectedLoopErrors],
    });
  };

  // Run 5 Consecutive Chart Loads to measure P50/P95
  console.log('2. Running 5 Consecutive COLD / WARM Loads...');
  await testChartOpen('NSE:NIFTY 50', 'COLD');
  await testChartOpen('NSE:NIFTY 50', 'WARM');
  await testChartOpen('NSE:NIFTY 50', 'WARM');
  await testChartOpen('NSE:NIFTY 50', 'WARM');
  await testChartOpen('NSE:NIFTY 50', 'WARM');

  console.log('\n3. Running Symbol Switch Sequence: NIFTY -> BANKNIFTY -> GOLD -> SILVER -> NIFTY...');
  await testChartOpen('NSE:NIFTY BANK', 'SYMBOL_SWITCH');
  await testChartOpen('MCX:GOLD26OCTFUT', 'SYMBOL_SWITCH');
  await testChartOpen('MCX:SILVER26SEPFUT', 'SYMBOL_SWITCH');
  await testChartOpen('NSE:NIFTY 50', 'SYMBOL_SWITCH');

  console.log('\n=====================================================');
  console.log('               BENCHMARK RESULTS REPORT              ');
  console.log('=====================================================\n');

  console.log('--- 14-STEP TIMELINE METRICS ---');
  for (const m of metrics) {
    console.log(`[${m.type}] Symbol: ${m.symbol} | traceId: ${m.loadId}`);
    console.log(`  Step 1: TradingChart render       : ${m.step1_renderMs ?? 'N/A'} ms`);
    console.log(`  Step 2: ChartContainer mount       : ${m.step2_mountMs ?? 'N/A'} ms`);
    console.log(`  Step 3: Widget creation           : ${m.step3_widgetCreateMs ?? 'N/A'} ms`);
    console.log(`  Step 4: widget.onChartReady       : ${m.step4_onChartReadyMs ?? 'N/A'} ms`);
    console.log(`  Step 5: Datafeed.resolveSymbol    : ${m.step5_resolveSymbolMs ?? 'N/A'} ms`);
    console.log(`  Step 6: Datafeed.getBars START    : ${m.step6_getBarsStartMs ?? 'N/A'} ms`);
    console.log(`  Step 7: Datafeed.getBars END      : ${m.step7_getBarsEndMs ?? 'N/A'} ms`);
    console.log(`  Step 8: First hist bar received   : ${m.step8_firstBarMs ?? 'N/A'} ms`);
    console.log(`  Step 9: lastBar established       : ${m.step9_lastBarMs ?? 'N/A'} ms`);
    console.log(`  Step 10: subscribeBars START      : ${m.step10_subscribeBarsMs ?? 'N/A'} ms`);
    console.log(`  Step 11: Realtime tick received   : ${m.step11_realtimeRxMs ?? 'N/A'} ms`);
    console.log(`  Step 12: Realtime tick to TV      : ${m.step12_realtimeFwdMs ?? 'N/A'} ms`);
    console.log(`  Step 13: First visible candle     : ${m.step13_visibleCandleMs ?? 'N/A'} ms`);
    console.log(`  Step 14: Chart visually usable    : ${m.step14_usableMs ?? 'N/A'} ms`);
    console.log(`  Stats  : getBarsCalls=${m.totalGetBarsCalls}, widgetCreations=${m.totalWidgetCreations}, reactRenders=${m.totalReactRenders}\n`);
  }

  console.log('--- TASK 2: 10-SECOND LOOP & ERROR VERIFICATION ---');
  if (detectedLoopErrors.length === 0) {
    console.log('✓ PROOF PASSED: Zero "Incremental update failed" or "Starting full update" errors detected!');
  } else {
    console.log('❌ FAIL: Loop errors detected:', detectedLoopErrors);
  }

  console.log('\n--- TASK 8: NETWORK REQUEST WATERFALL ---');
  networkRequests.slice(0, 15).forEach((req) => {
    console.log(`  ${req.status} | ${req.durationMs.toFixed(1)}ms | ${req.url}`);
  });

  await browser.close();
  console.log('\n=====================================================');
  console.log('         BENCHMARK COMPLETED SUCCESSFULLY            ');
  console.log('=====================================================');
}

runBenchmark().catch((err) => {
  console.error('Benchmark script failed:', err);
  process.exit(1);
});
