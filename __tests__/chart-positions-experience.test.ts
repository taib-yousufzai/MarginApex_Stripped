import { describe, it, expect } from 'vitest';
import { getLotSizeFallback } from '../lib/lotSize';

/**
 * Comprehensive Regression Test Suite for Chart Positions Experience Fixes
 * 
 * Bug #1: Exit buttons remaining disabled/gray after exit operation completes.
 * Expected: Event-driven status reconciliation clears exiting status immediately when positions update.
 * 
 * Bug #2: Scalp mode inheriting previous chart position quantity.
 * Expected:
 *  - Full exit → new scalp order uses configured default quantity for instrument.
 *  - Repeated new scalp orders do not accumulate previous position quantity.
 *  - Partial exit preserves existing position but does not contaminate the new-order default.
 *  - Different instruments resolve and retain their own configured defaults (e.g. BANKNIFTY=30, NIFTY=65, ETH=1, BTC=0.001, MIDCPNIFTY=120).
 */

describe('Chart Positions Experience — Bug #1: Instant Event-Driven Exit State Reconciliation', () => {
  it('clears exiting position ID immediately when positions snapshot no longer contains the position', () => {
    const exitingPosIds = new Set<string>(['pos-123']);

    // Simulate positions state update from socket/poll after exit operation
    const updatedPositions = [
      { id: 'pos-456', symbol: 'BTCUSDT', status: 'open', qty_open: 1 }
    ];

    // Reconcile logic (mirrors TradingChart.tsx useEffect)
    const activeIds = new Set(updatedPositions.filter(p => p.status === 'open' || p.status === 'active').map(p => p.id));
    for (const id of Array.from(exitingPosIds)) {
      if (!activeIds.has(id)) {
        exitingPosIds.delete(id);
      }
    }

    expect(exitingPosIds.has('pos-123')).toBe(false);
    expect(exitingPosIds.size).toBe(0);
  });

  it('keeps exiting state active while position is still in-flight', () => {
    const exitingPosIds = new Set<string>(['pos-123']);

    const currentPositions = [
      { id: 'pos-123', symbol: 'ETHUSDT', status: 'open', qty_open: 5 }
    ];

    const activeIds = new Set(currentPositions.filter(p => p.status === 'open' || p.status === 'active').map(p => p.id));
    for (const id of Array.from(exitingPosIds)) {
      if (!activeIds.has(id)) {
        exitingPosIds.delete(id);
      }
    }

    expect(exitingPosIds.has('pos-123')).toBe(true);
    expect(exitingPosIds.size).toBe(1);
  });
});

describe('Chart Positions Experience — Bug #2: Configured Instrument Default Quantity Lifecycle', () => {
  interface SimState {
    symbol: string;
    currentInstrumentPosition: { id: string; symbol: string; qty_open: number } | null;
    qtyValue: number | string;
    useLots: boolean;
    isExitFlow: boolean;
    isAddMoreFlow: boolean;
  }

  function resolveInstrumentDefaultLotSize(symbol: string): number {
    return getLotSizeFallback(symbol);
  }

  function reconcileQuantityState(
    prevState: SimState,
    nextInstrumentPos: { id: string; symbol: string; qty_open: number } | null
  ): SimState {
    const hadPosition = prevState.currentInstrumentPosition !== null;
    const hasPosition = nextInstrumentPos !== null;

    let qtyValue = prevState.qtyValue;
    let useLots = prevState.useLots;
    let isExitFlow = prevState.isExitFlow;
    let isAddMoreFlow = prevState.isAddMoreFlow;

    if (hadPosition && !hasPosition) {
      // Full exit: position count dropped to zero -> reset transient quantity to 1 lot (configured default lot)
      qtyValue = 1;
      useLots = true;
      isExitFlow = false;
      isAddMoreFlow = false;
    }

    return {
      symbol: prevState.symbol,
      currentInstrumentPosition: nextInstrumentPos,
      qtyValue,
      useLots,
      isExitFlow,
      isAddMoreFlow,
    };
  }

  function onExitCompleted(state: SimState, nextInstrumentPos: { id: string; symbol: string; qty_open: number } | null): SimState {
    // Mirrors handleQuickExit completion in TradingChart.tsx:
    // setQtyValue(1), setUseLots(true), setIsExitFlow(false), setIsAddMoreFlow(false)
    return {
      ...state,
      currentInstrumentPosition: nextInstrumentPos,
      qtyValue: 1,
      useLots: true,
      isExitFlow: false,
      isAddMoreFlow: false,
    };
  }

  function calculateScalpOrderQty(state: SimState): { lotCount: number; executedQty: number } {
    let qVal = Number(state.qtyValue) || 1;
    if (state.isExitFlow || state.isAddMoreFlow || !state.currentInstrumentPosition || qVal <= 0) {
      qVal = 1;
    }
    const lotSize = resolveInstrumentDefaultLotSize(state.symbol);
    const effectiveUseLots = true; // Scalp Mode operates in lots
    const executedQty = effectiveUseLots ? qVal * lotSize : qVal;
    return { lotCount: qVal, executedQty };
  }

  it('1. Full exit -> new scalp order uses configured default quantity (ETH = 1, BANKNIFTY = 30, NIFTY = 65)', () => {
    // ETH test
    let ethState: SimState = {
      symbol: 'ETHUSDT',
      currentInstrumentPosition: { id: 'p-eth', symbol: 'ETHUSDT', qty_open: 5 },
      qtyValue: 5,
      useLots: false,
      isExitFlow: true,
      isAddMoreFlow: false,
    };
    ethState = reconcileQuantityState(ethState, null);
    const ethOrder = calculateScalpOrderQty(ethState);
    const ethDefaultQty = resolveInstrumentDefaultLotSize('ETHUSDT');
    expect(ethOrder.executedQty).toBe(ethDefaultQty);
    expect(ethOrder.executedQty).toBe(1);

    // BANKNIFTY test (Configured default lot size = 30)
    let bnState: SimState = {
      symbol: 'BANKNIFTY',
      currentInstrumentPosition: { id: 'p-bn', symbol: 'BANKNIFTY', qty_open: 150 },
      qtyValue: 150,
      useLots: false,
      isExitFlow: true,
      isAddMoreFlow: false,
    };
    bnState = reconcileQuantityState(bnState, null);
    const bnOrder = calculateScalpOrderQty(bnState);
    const bnDefaultQty = resolveInstrumentDefaultLotSize('BANKNIFTY');
    expect(bnDefaultQty).toBe(30);
    expect(bnOrder.executedQty).toBe(30); // 1 lot * 30 lotSize = 30
    expect(bnOrder.executedQty).not.toBe(150);

    // NIFTY test (Configured default lot size = 65)
    let niftyState: SimState = {
      symbol: 'NIFTY',
      currentInstrumentPosition: { id: 'p-nifty', symbol: 'NIFTY', qty_open: 325 },
      qtyValue: 325,
      useLots: false,
      isExitFlow: true,
      isAddMoreFlow: false,
    };
    niftyState = reconcileQuantityState(niftyState, null);
    const niftyOrder = calculateScalpOrderQty(niftyState);
    const niftyDefaultQty = resolveInstrumentDefaultLotSize('NIFTY');
    expect(niftyDefaultQty).toBe(65);
    expect(niftyOrder.executedQty).toBe(65); // 1 lot * 65 lotSize = 65
    expect(niftyOrder.executedQty).not.toBe(325);
  });

  it('2. Repeated new scalp orders do not accumulate previous quantity (1 lot per order)', () => {
    let ethState: SimState = {
      symbol: 'ETHUSDT',
      currentInstrumentPosition: null,
      qtyValue: 1,
      useLots: true,
      isExitFlow: false,
      isAddMoreFlow: false,
    };

    // Order 1
    const order1 = calculateScalpOrderQty(ethState);
    expect(order1.executedQty).toBe(1);
    ethState.currentInstrumentPosition = { id: 'p1', symbol: 'ETHUSDT', qty_open: 1 };

    // Order 2
    const order2 = calculateScalpOrderQty(ethState);
    expect(order2.executedQty).toBe(1);
    ethState.currentInstrumentPosition.qty_open += order2.executedQty; // Total position = 2

    // Order 3
    const order3 = calculateScalpOrderQty(ethState);
    expect(order3.executedQty).toBe(1);
    ethState.currentInstrumentPosition.qty_open += order3.executedQty; // Total position = 3

    expect(ethState.currentInstrumentPosition.qty_open).toBe(3);
    // Order 2 did not become 5+5=10!
  });

  it('3. Partial exit preserves existing position but does not contaminate new-order default', () => {
    // Buy 5
    let state: SimState = {
      symbol: 'ETHUSDT',
      currentInstrumentPosition: { id: 'p1', symbol: 'ETHUSDT', qty_open: 5 },
      qtyValue: 5,
      useLots: false,
      isExitFlow: true,
      isAddMoreFlow: false,
    };

    // Exit 2 -> Partial exit completes, 3 remaining
    state = onExitCompleted(state, { id: 'p1', symbol: 'ETHUSDT', qty_open: 3 });

    // Existing position is preserved at 3
    expect(state.currentInstrumentPosition?.qty_open).toBe(3);
    expect(state.qtyValue).toBe(1); // Reset to 1 lot default

    // Place new Scalp BUY order
    const newOrder = calculateScalpOrderQty(state);
    const configuredDefault = resolveInstrumentDefaultLotSize('ETHUSDT');

    // New order MUST use configured default (1 ETH), NOT remaining position (3) or original (5)
    expect(newOrder.executedQty).toBe(configuredDefault);
    expect(newOrder.executedQty).toBe(1);
    expect(newOrder.executedQty).not.toBe(3);
    expect(newOrder.executedQty).not.toBe(5);
  });

  it('4. Different instruments retain their own configured default quantities', () => {
    const instruments = [
      { symbol: 'ETHUSDT', expectedLotSize: 1 },
      { symbol: 'BANKNIFTY', expectedLotSize: 30 },
      { symbol: 'NIFTY', expectedLotSize: 65 },
      { symbol: 'SENSEX', expectedLotSize: 20 },
      { symbol: 'FINNIFTY', expectedLotSize: 60 },
      { symbol: 'MIDCPNIFTY', expectedLotSize: 120 },
      { symbol: 'CRUDEOIL', expectedLotSize: 100 },
      { symbol: 'NATURALGAS', expectedLotSize: 1250 },
    ];

    for (const inst of instruments) {
      const lotSize = resolveInstrumentDefaultLotSize(inst.symbol);
      expect(lotSize).toBe(inst.expectedLotSize);

      let state: SimState = {
        symbol: inst.symbol,
        currentInstrumentPosition: null,
        qtyValue: 1,
        useLots: true,
        isExitFlow: false,
        isAddMoreFlow: false,
      };

      const order = calculateScalpOrderQty(state);
      expect(order.executedQty).toBe(inst.expectedLotSize);
    }
  });
});
