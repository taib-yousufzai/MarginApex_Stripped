import { EventEmitter } from 'events';
import pino from 'pino';
import { DbBatchWriter } from './dbWriter.ts';
import type { TickData } from './dbWriter.ts';
import { SubscriptionManager } from './subscriptionManager.ts';
import { telemetry } from '../../lib/metrics.ts';

const logger = pino({ name: 'ticker-processor' });

/**
   * Fixed-size Ring Buffer for memory efficiency.
   */
class RingBuffer<T> {
  private buffer: T[];
  private size: number;
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(size: number) {
    this.buffer = new Array(size);
    this.size = size;
  }

  public push(value: T) {
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.size;
    if (this.count < this.size) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.size;
    }
  }

  public toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.size]);
    }
    return result;
  }
}

export class TickProcessor extends EventEmitter {
  // Track last seen price per token to detect actual price changes
  private lastSeenPrice: Map<number, number> = new Map();
  private lastSeenBid: Map<number, number> = new Map();
  private lastSeenAsk: Map<number, number> = new Map();
  private lastProcessedTimestamp: Map<number, number> = new Map();
  private slidingWindows: Map<number, RingBuffer<{ price: number; timestamp: number }>> = new Map();
  private subscriptionManager: SubscriptionManager;
  private dbWriter: DbBatchWriter;
  
  // Custom metrics tracking for observability
  private tickCount = 0;
  private duplicateDropCount = 0;
  private lastProcessingLatency = 0;

  constructor(subscriptionManager: SubscriptionManager, dbWriter: DbBatchWriter) {
    super();
    this.subscriptionManager = subscriptionManager;
    this.dbWriter = dbWriter;
    
    // Set a max listener limit to prevent warning logs
    this.setMaxListeners(100);
  }

  /**
   * Main entry point to process a batch of incoming ticks from Kite.
   */
  public processTicks(ticks: any[]) {
    const start = performance.now();
    for (const tick of ticks) {
      const token = tick.instrument_token;
      if (!token) continue;

      this.tickCount++;

      // 1. Resolve readable symbol key (e.g. "NSE:RELIANCE")
      const symbolKey = this.subscriptionManager.getSymbolKey(token);
      if (!symbolKey) {
        // Stale or unsubscribed tick, skip
        continue;
      }

      // 2. Track timestamp for metrics/history but do NOT drop ticks solely based on timestamp.
      //    Kite's timestamp resolution is 1 second — multiple ticks per second share the same timestamp.
      //    Dropping by timestamp would silently discard all but the first tick per second.
      const tickTime = tick.timestamp ? new Date(tick.timestamp).getTime() : Date.now();
      this.lastProcessedTimestamp.set(token, tickTime);

      // Only drop if BOTH price AND timestamp are identical (true duplicate)
      const lastPrice = this.lastSeenPrice.get(token);
      if (lastPrice !== undefined && lastPrice === tick.last_price) {
        this.duplicateDropCount++;
        logger.debug({ token, symbolKey, price: tick.last_price }, 'Skipped identical price tick (no change)');
        // Still pass through to DB writer so updated_at refreshes — this keeps Realtime alive
        // but skip heavy processing below
      }
      this.lastSeenPrice.set(token, tick.last_price);

      logger.debug({ symbol: symbolKey, price: tick.last_price }, 'Received real-time tick');

      // 3. Store in bounded memory-efficient ring buffer (max 100 ticks per instrument)
      let window = this.slidingWindows.get(token);
      if (!window) {
        window = new RingBuffer(100);
        this.slidingWindows.set(token, window);
      }
      window.push({ price: tick.last_price, timestamp: tickTime });

      // Preserve depth-derived bid/ask across LTP-only ticks to avoid feed jitter
      const rawBid = tick.depth?.buy?.[0]?.price;
      const rawAsk = tick.depth?.sell?.[0]?.price;
      let bid = (rawBid != null && rawBid > 0) ? rawBid : 0;
      let ask = (rawAsk != null && rawAsk > 0) ? rawAsk : 0;

      if (bid > 0 && ask > 0 && bid < ask) {
        this.lastSeenBid.set(token, bid);
        this.lastSeenAsk.set(token, ask);
      } else {
        const prevBid = this.lastSeenBid.get(token);
        const prevAsk = this.lastSeenAsk.get(token);
        if (prevBid && prevAsk && lastPrice && lastPrice > 0) {
          const delta = tick.last_price - lastPrice;
          bid = Math.max(0.05, Math.round((prevBid + delta) * 100) / 100);
          ask = Math.max(bid + 0.05, Math.round((prevAsk + delta) * 100) / 100);
          this.lastSeenBid.set(token, bid);
          this.lastSeenAsk.set(token, ask);
        }
      }

      // 4. Send to throttled database writer
      const tickData: TickData = {
        instrument_token: token,
        last_price: tick.last_price,
        ohlc: tick.ohlc,
        volume: tick.volume,
        timestamp: tickTime ? new Date(tickTime) : new Date(),
        bid,
        ask,
      };
      this.dbWriter.addTick(symbolKey, tickData);

      // 5. Broadcast tick events to other modular subscribers
      // E.g. strategy engine, alerting, or UI gateway can subscribe using processor.on('tick', ...)
      this.emit('tick', symbolKey, tickData);
      this.emit(`tick:${symbolKey}`, tickData);
    }
    this.lastProcessingLatency = performance.now() - start;
    telemetry.recordTickReceived(ticks.length);
    telemetry.recordTickProcessed(ticks.length, this.lastProcessingLatency);
  }

  /**
   * Retrieves the current sliding window of quotes for an instrument.
   */
  public getHistory(token: number): { price: number; timestamp: number }[] {
    const window = this.slidingWindows.get(token);
    return window ? window.toArray() : [];
  }

  /**
   * Exposes metrics for monitoring.
   */
  public getMetrics() {
    return {
      tickCount: this.tickCount,
      duplicateDropCount: this.duplicateDropCount,
      activeSymbols: this.slidingWindows.size,
      lastProcessingLatencyMs: parseFloat(this.lastProcessingLatency.toFixed(3)),
    };
  }
}
