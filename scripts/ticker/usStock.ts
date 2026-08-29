import pino from 'pino';
import { DbBatchWriter, type TickData } from './dbWriter.ts';
import { getAdminClient } from '../../lib/adminClient.ts';
import { fetchUSStockQuotes } from '../../lib/datafeed/USStockService.ts';

const DEFAULT_US_SYMBOLS = [
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC', 'SPY', 'QQQ',
  'DIA', 'ES=F', 'NQ=F', 'YM=F'
];

const POLL_INTERVAL_MS = 3000; // Poll US stocks every 3 seconds

const logger = pino({ name: 'us-stock-ticker' });

export class USStockTicker {
  private dbWriter: DbBatchWriter;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private isConnected = false;
  private activeSymbols: Set<string> = new Set(DEFAULT_US_SYMBOLS);

  constructor(dbWriter: DbBatchWriter) {
    this.dbWriter = dbWriter;
  }

  public start(): void {
    if (!this.pollTimer) {
      this.ensureInstrumentsExist()
        .catch((err) => {
          logger.warn({ err }, 'ensureInstrumentsExist failed for US stocks — proceeding anyway');
        })
        .finally(() => {
          this.beginPolling();
        });
    }
  }

  public get connected(): boolean {
    return this.isConnected;
  }

  public subscribe(symbols: string[]): void {
    const newSymbols = symbols.filter(s => !this.activeSymbols.has(s.toUpperCase()));
    if (newSymbols.length > 0) {
      newSymbols.forEach(s => this.activeSymbols.add(s.toUpperCase()));
      logger.info({ newSymbols }, 'Added US stock symbols to subscription list');
      this.ensureInstrumentsExist().catch(() => {});
    }
  }

  private async ensureInstrumentsExist(): Promise<void> {
    const admin = getAdminClient();
    const symbols = Array.from(this.activeSymbols);
    const rows = symbols.flatMap(sym => [
      {
        id: sym,
        instrument_token: 0,
        tradingsymbol: sym,
        exchange: 'US',
        instrument_type: 'EQ',
        segment: 'US-EQ',
        updated_at: new Date().toISOString()
      },
      {
        id: `US:${sym}`,
        instrument_token: 0,
        tradingsymbol: sym,
        exchange: 'US',
        instrument_type: 'EQ',
        segment: 'US-EQ',
        updated_at: new Date().toISOString()
      }
    ]);

    try {
      const { error } = await admin
        .from('instruments')
        .upsert(rows, { onConflict: 'id' });
      if (error) {
        logger.error({ error }, 'Failed to upsert US stock instruments');
      } else {
        logger.info({ count: rows.length }, 'Ensured US stock instruments exist in DB');
      }
    } catch (err) {
      logger.error({ err }, 'Error checking/upserting US stock instruments');
    }
  }

  public stop(): void {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isConnected = false;
  }

  private beginPolling(): void {
    this.isConnected = true;
    logger.info({ symbolCount: this.activeSymbols.size }, 'Starting US Stock live data ticker loop');

    // Immediate initial poll
    this.pollQuotes();

    this.pollTimer = setInterval(() => {
      if (!this.stopping) {
        this.pollQuotes();
      }
    }, POLL_INTERVAL_MS);
  }

  private async pollQuotes(): Promise<void> {
    const symbols = Array.from(this.activeSymbols);
    if (symbols.length === 0) return;

    try {
      const quotes = await fetchUSStockQuotes(symbols);
      const now = new Date();

      for (const [sym, q] of Object.entries(quotes)) {
        if (!q || !q.price || q.price <= 0) continue;

        const tickData: TickData = {
          last_price: q.price,
          ohlc: {
            open: q.prevClose || q.price,
            high: q.high || q.price,
            low: q.low || q.price,
            close: q.prevClose || q.price,
          },
          volume: 0,
          timestamp: now,
          bid: q.price,
          ask: q.price,
        };

        // Add tick under both bare symbol (e.g. AAPL) and prefixed symbol (e.g. US:AAPL)
        this.dbWriter.addTick(sym, tickData);
        this.dbWriter.addTick(`US:${sym}`, tickData);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to poll US stock quotes');
    }
  }
}
