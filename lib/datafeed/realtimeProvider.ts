import { resolutionToMs } from './resolutionUtils';

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SubscriberEntry {
  callback: (bar: Bar) => void;
  resolution: string;
  lastBar: Bar | null;
}

export class RealtimeProvider {
  private subscribers = new Map<string, SubscriberEntry>();
  private lastUpdateTime = 0;
  private pendingUpdate: { lastPrice: number, nowMs: number, volume?: number } | null = null;
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;

  subscribe(uid: string, entry: SubscriberEntry): void {
    this.subscribers.set(uid, entry);
  }

  unsubscribe(uid: string): void {
    this.subscribers.delete(uid); // no-op if not present
  }

  setLastBar(bar: Bar, resolution?: string): void {
    for (const entry of this.subscribers.values()) {
      if (!resolution || entry.resolution === resolution) {
        entry.lastBar = bar;
      }
    }
  }

  update(lastPrice: number, nowMs: number, volume?: number): void {
    this.pendingUpdate = { lastPrice, nowMs, volume };
    const now = Date.now();

    if (now - this.lastUpdateTime > 250) {
      this.flushUpdate();
    } else if (!this.updateTimeout) {
      this.updateTimeout = setTimeout(() => {
        this.flushUpdate();
      }, 250 - (now - this.lastUpdateTime));
    }
  }

  private flushUpdate() {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    if (!this.pendingUpdate) return;

    this.lastUpdateTime = Date.now();
    const { lastPrice, nowMs, volume } = this.pendingUpdate;
    this.pendingUpdate = null;

    for (const entry of this.subscribers.values()) {
      const resMs = resolutionToMs(entry.resolution);
      const prev = entry.lastBar;

      let boundary = Math.floor(nowMs / resMs) * resMs;
      
      // Anchor boundary to historical session times to avoid creating disjoint candles
      // on timeframes that don't align with UTC (e.g., NSE 30m, 1h, 1D).
      if (prev) {
        if (nowMs < prev.time + resMs) {
          boundary = prev.time;
        } else {
          const periods = Math.floor((nowMs - prev.time) / resMs);
          boundary = prev.time + periods * resMs;
        }
      }

      const isNewCandle = !prev || boundary > prev.time;
      if (!entry.lastBar || isNewCandle) {
        entry.lastBar = {
          time:  boundary,
          open:  lastPrice,
          high:  lastPrice,
          low:   lastPrice,
          close: lastPrice,
          volume: volume ?? 1,
        };
      } else {
        entry.lastBar.high = Math.max(entry.lastBar.high, lastPrice);
        entry.lastBar.low = Math.min(entry.lastBar.low, lastPrice);
        entry.lastBar.close = lastPrice;
        entry.lastBar.volume = volume ?? ((entry.lastBar.volume ?? 0) + 1);
      }
      entry.callback({ ...entry.lastBar });
    }
  }
}
