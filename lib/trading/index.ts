/**
 * lib/trading/index.ts — barrel export for the trading domain library.
 *
 * Consumers can import from a single path:
 *
 *   import {
 *     TradingInstrument,
 *     Segment,
 *     mapSegmentToDbSegment,
 *     mapSegmentWithSymbol,
 *     detectFeed,
 *     fromWatchlistItem,
 *     toWatchlistItem,
 *     toChartInstrument,
 *     fromPosition,
 *     fromOrder,
 *     fromOptionContract,
 *   } from '@/lib/trading';
 *
 * instead of importing from multiple deep paths.
 */

// Types
export type { TradingInstrument, ChartInstrument, Segment, InstrumentFeed } from '@/lib/types/instrument';

// Segment mapping + instrument mappers
export {
  mapSegmentToDbSegment,
  mapSegmentWithSymbol,
  mapSymbolToSegment,
  detectFeed,
  fromWatchlistItem,
  toWatchlistItem,
  toChartInstrument,
  fromPosition,
  fromOrder,
  fromOptionContract,
} from '@/lib/trading/SymbolMapping';
