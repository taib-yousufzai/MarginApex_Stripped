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
      const bar: Bar = {
        time:  boundary,
        open:  isNewCandle ? lastPrice : (prev?.open ?? lastPrice),
        high:  isNewCandle ? lastPrice : Math.max(prev!.high, lastPrice),
        low:   isNewCandle ? lastPrice : Math.min(prev!.low, lastPrice),
        close: lastPrice,
        volume: volume ?? (isNewCandle ? 1 : ((prev?.volume ?? 0) + 1)),
      };

      entry.lastBar = { ...bar };
      entry.callback({ ...bar });
    }
  }
}
