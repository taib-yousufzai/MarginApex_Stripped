import { getAdminClient } from '../../lib/adminClient.ts';
import { processPendingOrdersAndPositions } from '../../lib/orderMatching.ts';
import { getRedisClient } from '../../lib/redis.ts';
import pino from 'pino';

const logger = pino({ name: 'ticker-db-writer' });

export interface TickData {
  instrument_token?: number;
  last_price: number;
  ohlc?: {
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  };
  volume?: number;
  timestamp?: string | Date;
  bid?: number;
  ask?: number;
}

export class DbBatchWriter {
  private buffer: Map<string, TickData> = new Map();
  private isProcessing = false;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  // Real-time distribution interfaces
  private gateway: any = null;
  private candleAggregator: any = null;

  constructor(intervalMs = 1000) {
    this.intervalMs = intervalMs;
  }

  public setGatewayAndAggregator(gateway: any, candleAggregator: any) {
    this.gateway = gateway;
    this.candleAggregator = candleAggregator;
  }

  /**
   * Buffers an incoming tick in memory, overwriting any older tick for the same instrument.
   * Also updates the Redis Cache, Pub/Sub, and Candle Aggregator immediately in real-time.
   */
  public addTick(symbolKey: string, tick: TickData) {
    this.buffer.set(symbolKey, tick);

    // 1. Write to Redis Cache and PubSub
    try {
      const redis = getRedisClient();
      const tickStr = JSON.stringify(tick);
      redis.hset('market:quotes', symbolKey, tickStr).catch((err: any) => {
        logger.error({ err, symbolKey }, 'Failed to HSET quote in Redis');
      });
      redis.publish(`market:ticks:${symbolKey}`, tickStr).catch((err: any) => {
        logger.error({ err, symbolKey }, 'Failed to publish quote to Redis PubSub');
      });
    } catch (redisErr) {
      logger.error({ err: redisErr }, 'Error sending tick to Redis layer');
    }

    // 2. Instantly update candle aggregator
    if (this.candleAggregator) {
      const ts = tick.timestamp 
        ? (tick.timestamp instanceof Date ? tick.timestamp : new Date(tick.timestamp)) 
        : new Date();
      this.candleAggregator.addTick(symbolKey, tick.last_price, tick.volume || 0, ts);
    }
  }


  /**
   * Starts the periodic database write worker.
   */
  public start() {
    logger.info({ intervalMs: this.intervalMs }, 'Starting database batch writer...');
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  /**
   * Stops the database writer and flushes any remaining buffered ticks.
   */
  public async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    logger.info('Database batch writer stopped.');
  }

  /**
   * Triggers order matching using the latest in-memory buffered prices.
   */
  private async flush() {
    if (this.buffer.size === 0 || this.isProcessing) return;

    this.isProcessing = true;
    const snapshot = Array.from(this.buffer.entries());
    this.buffer.clear(); // Clear immediately to allow incoming ticks to queue

    try {
      const allQuotes = snapshot.map(([symbolKey, tick]) => {
        return {
          id: symbolKey,
          last_price: tick.last_price,
          bid: tick.bid,
          ask: tick.ask,
        };
      });

      logger.debug({ total: allQuotes.length }, 'Triggering order matching on buffered batch');

      // Trigger order matching engine (SL/Target + Limit triggers)
      try {
        await processPendingOrdersAndPositions(allQuotes);
      } catch (err) {
        logger.error({ err }, 'Error executing pending order/position matching engine');
      }

    } catch (err) {
      logger.error({ err }, 'Unexpected error in database batch flush');
    } finally {
      this.isProcessing = false;
    }
  }
}

