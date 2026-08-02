# Position Engine Specification (v1.0.0)

This document serves as the formal specification contract for the Position Engine. All future modifications, features, and refactoring efforts must conform to the invariants and behaviors defined herein.

---

## 1. State Machine & Transitions

The Position Engine models transitions as explicit state modifications of positions based on order execution inputs:

```text
No Position
    │
    ├── BUY  → Long (Create)
    └── SELL → Short (Create)

Long
    │
    ├── BUY           → Increase (Averaging)
    ├── SELL Partial  → Reduce (Partial Close)
    ├── SELL Equal    → Close (Full Close)
    └── SELL Greater  → Reverse → Short (FIFO Close + opposite side Create)

Short
    │
    ├── SELL          → Increase (Averaging)
    ├── BUY Partial   → Reduce (Partial Close)
    ├── BUY Equal     → Close (Full Close)
    └── BUY Greater   → Reverse → Long (FIFO Close + opposite side Create)
```

Every transition is transactional and strictly deterministic.

---

## 2. FIFO (First-In, First-Out) Netting Policy

Exits and opposite-side matches must consume lots in the order they were opened:
1. **Ordering:** Opposite positions are queried ordered by `entry_time ASC` (oldest first).
2. **Consumption:** Quantity is consumed lot-by-lot.
3. **Splitting:** If a lot is partially consumed, it is updated using `reduce_position_internal`. If fully consumed, it is transitioned using `close_position_v2`.
4. **Reversal:** Leftover quantity after consuming all matching open lots triggers the creation of a new opposite-side lot.

FIFO netting must apply consistently across all exit paths, including:
- Manual user exits
- Opposite-side order netting
- Stop-loss execution
- Target executions
- Automatic square-offs
- Liquidation events

---

## 3. Margin & Brokerage Rules

1. **Calculate vs Validate:** Margin requirements are estimated in the TS layer but strictly validated and deducted inside PostgreSQL transactions.
2. **Proportional Release:** Partial exits release margin proportionally:
   $$\text{Released Margin} = \text{round}\left(\frac{\text{Locked Margin} \times \text{Closed Qty}}{\text{Open Qty}}, 2\right)$$
3. **Historical Retention:** On position closure (`status = 'closed'`), `locked_margin` is zeroed out but `margin_required` remains intact to preserve historical exposure.
4. **Strict Lot Sizes:** Missing lot sizes in `instruments` or `script_settings` trigger transaction failures; fallback defaults are prohibited.

---

## 4. Idempotency & Transaction Guarantees

1. **User-Scoped Idempotency:** Requests must supply a unique `p_idempotency_key` which is scoped to the `user_id`. Duplicate requests immediately return the cached order/PnL.
2. **ACID Transaction Block:** All side effects (order placement, position updates, ledger writes, profile balance changes) occur synchronously within a single Postgres transaction block. Async event chains are prohibited.
3. **Locking Protocol:** Row-level locks (`FOR UPDATE`) are acquired on `profiles` and `positions` during execution to guarantee deterministic concurrency.

---

## 5. Core Invariants

The following financial invariants are strictly enforced:
- **Non-Negative Open Quantity:** `qty_open >= 0` for all positions.
- **Non-Negative Locked Margin:** `locked_margin >= 0` for all positions.
- **Closed Quantity Balance:** Positions with `status = 'closed'` must have `qty_open = 0` and `locked_margin = 0`.
- **Reconciliation:** The sum of transactions (`amount` signed by type) must perfectly match profile balance changes.

---

## 6. Failure & Rollback Guarantees

If any validation, ledger update, margin adjustment, or position mutation fails, the entire transaction is rolled back. No partial financial state is ever committed, ensuring zero data leakage.

---

## 7. Operational Roadmap

### Phase 9: Observability
- Record detailed execution telemetry for every `place_order_v2` and `close_position_v2` call:
  - Correlation ID / Request ID
  - Order ID & User ID
  - Symbol & Side
  - Fill details & Lots Consumed
  - FIFO Chain details
  - Balances & Margin levels (before and after execution)
  - Execution duration and SQLSTATE code on failure

### Phase 10: Shadow Mode
- Execute v1.0.0 in parallel with the current production engine without committing v1.0.0 transactions (roll back at end).
- Log and compare results (position state, margins, ledger records) for thousands of live trades to guarantee perfect alignment before switching execution paths.

### Phase 11: Load Testing
- Stress test under high concurrent volumes (10,000+ orders, 100+ concurrent simulated users).
- Measure P50, P95, P99 latencies, lock wait times, and deadlock frequencies.

### Phase 12: Disaster Testing
- Validate engine behavior under simulated infrastructure failures (unexpected database restarts mid-request, Zerodha/Binance timeouts, network retries).
