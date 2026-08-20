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
  symbol: string;
  resolution: string;
  callback: (bar: Bar) => void;
  lastBar: Bar | null;
  loadId?: string;
  loadStartTime?: number;
}

export class RealtimeProvider {
  private subscribers = new Map<string, SubscriberEntry>();
  private lastUpdateTime = 0;
  private pendingUpdate: { symbol: string; lastPrice: number; nowMs: number; volume?: number } | null = null;
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;
  private firstTickLogged = new Set<string>();

  subscribe(uid: string, entry: SubscriberEntry): void {
    this.subscribers.set(uid, entry);
  }

  unsubscribe(uid: string): void {
    this.subscribers.delete(uid);
  }

  clear(): void {
    this.subscribers.clear();
    this.pendingUpdate = null;
    this.firstTickLogged.clear();
  }

  setLastBar(symbol: string, resolution: string, bar: Bar): void {
    for (const entry of this.subscribers.values()) {
      if ((!entry.symbol || entry.symbol === symbol) && entry.resolution === resolution) {
        entry.lastBar = { ...bar };
      }
    }
  }

  update(symbol: string, lastPrice: number, nowMs: number, volume?: number): void {
    this.pendingUpdate = { symbol, lastPrice, nowMs, volume };
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
    const { symbol, lastPrice, nowMs, volume } = this.pendingUpdate;
    this.pendingUpdate = null;

    for (const [uid, entry] of this.subscribers.entries()) {
      // Data race protection: check symbol match (if symbol specified on subscriber)
      if (entry.symbol && entry.symbol !== symbol) {
        continue;
      }

      const resMs = resolutionToMs(entry.resolution);
      const prev = entry.lastBar;

      // Do NOT push real-time ticks before getBars has populated entry.lastBar for this exact symbol/resolution.
      // Premature ticks with unanchored UTC timestamps trigger TradingView's
      // "Incremental update failed. Starting full update" loop.
      if (!prev) {
        continue;
      }

      let boundary = Math.floor(nowMs / resMs) * resMs;

      // Anchor boundary to historical session times to avoid creating disjoint candles
      if (prev) {
        if (nowMs < prev.time + resMs) {
          boundary = prev.time;
        } else {
          const periods = Math.floor((nowMs - prev.time) / resMs);
          boundary = prev.time + periods * resMs;
        }
      }

      const isNewCandle = boundary > prev.time;
      if (isNewCandle) {
        entry.lastBar = {
          time: boundary,
          open: lastPrice,
          high: lastPrice,
          low: lastPrice,
          close: lastPrice,
          volume: volume ?? 1,
        };
      } else if (entry.lastBar) {
        entry.lastBar.high = Math.max(entry.lastBar.high, lastPrice);
        entry.lastBar.low = Math.min(entry.lastBar.low, lastPrice);
        entry.lastBar.close = lastPrice;
        entry.lastBar.volume = volume ?? ((entry.lastBar.volume ?? 0) + 1);
      }

      const activeBar = entry.lastBar;
      if (!activeBar) continue;

      if (entry.loadId && entry.loadStartTime && !this.firstTickLogged.has(uid)) {
        this.firstTickLogged.add(uid);
        const elapsed = (performance.now() - entry.loadStartTime).toFixed(1);
        console.log(`[CHART TRACE ${entry.loadId}] +${elapsed}ms [12] First realtime tick forwarded to TV: symbol=${symbol}, close=${activeBar.close}, time=${activeBar.time}`);
      }

      entry.callback({ ...activeBar });
    }
  }
}
