// ─── Trade Configuration Types ───────────────────────────────────────────────
// Shared types for segment settings and script settings used across
// TradeSheet, TradingChart, Watchlist, OptionChain, and PositionsContext.

export interface SegmentSetting {
  id: string;
  user_id?: string;
  segment: string;
  side: 'BUY' | 'SELL';
  trade_allowed: boolean;
  intraday_leverage: number;
  intraday_type?: string;
  holding_leverage: number;
  holding_type?: string;
  /** @deprecated use holding_leverage */
  normal_leverage?: number;
  /** @deprecated use holding_type */
  normal_type?: string;
  strike_range: number;
  max_lot: number;
  max_order_lot: number;
  commission_type: string;
  commission_value: number;
  carry_commission_type?: string;
  carry_commission_value?: number;
  gtt_commission_type?: string;
  gtt_commission_value?: number;
  intraday_commission_type?: string;
  intraday_commission_value?: number;
  profit_hold_sec: number;
  loss_hold_sec: number;
  entry_buffer: number;
  exit_buffer: number;
  bid_buffer?: number;
  top_limit?: number;
  min_limit?: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
  created_at?: string;
  updated_at?: string;
}

export interface ScriptSetting {
  symbol: string;
  lot_size: number;
}
