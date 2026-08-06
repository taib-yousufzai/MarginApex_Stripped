import { resolveInstrument } from '@/app/api/market/historical/route';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const symbolsToWarm = [
      'NIFTY',
      'NIFTY 50',
      'BANKNIFTY',
      'NIFTY BANK',
      'FINNIFTY',
      'SENSEX',
      'CRUDEOIL',
      'GOLD',
      'SILVER',
      'NATURALGAS',
      'USDINR'
    ];

    console.log('[Startup Warmup] Pre-warming instrument tokens for common symbols in background...');
    
    // Run asynchronously to not block the server startup/boot sequence
    (async () => {
      let resolvedCount = 0;
      for (const symbol of symbolsToWarm) {
        try {
          const res = await resolveInstrument(symbol);
          if (res) {
            resolvedCount++;
          }
        } catch (err: any) {
          console.warn(`[Startup Warmup] Failed to resolve token for ${symbol}:`, err.message);
        }
      }
      console.log(`[Startup Warmup] Finished pre-warming. Successfully resolved ${resolvedCount}/${symbolsToWarm.length} common symbols.`);
    })().catch(err => {
      console.error('[Startup Warmup] Error during warmup loop:', err);
    });
  }
}
