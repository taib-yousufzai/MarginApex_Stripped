# Financial Decision Matrix (v1.0.0)

This matrix acts as the definitive checklist for the **TradeEngine** refactoring, delineating which decisions remain in the TypeScript/API orchestration layer and which decisions belong exclusively to the **Position Engine (v1.0.0)**.

---

## 1. Decision Matrix Checklist

| Decision Vitals | Current Location | Final Owner | Action / Strategy |
| :--- | :--- | :--- | :--- |
| **Margin Required** | `TradeEngine` | Position Engine | **Move.** Delete TS-level margin check formulas; delegate validation to the RPC. |
| **Brokerage** | `TradeEngine` | Position Engine | **Move.** Delete TS-level fee calculators; delegate calculations to the RPC. |
| **Buffer Fees** | `TradeEngine` | Position Engine | **Move.** Delegate buffer fee debits to the transaction-bound RPC. |
| **FIFO Lot Selection** | Position Engine | Position Engine | **Keep.** Maintain database-level query sorting (`ORDER BY entry_time ASC`). |
| **Lot Netting / Split** | `TradeEngine` / Legacy | Position Engine | **Move.** Netting looping and partial-exit splits occur inside SQL. |
| **Market Hours Check** | `TradeEngine` | `TradeEngine` / Config | **Keep.** Application-level session scheduling check (workflow). |
| **Trading Enabled Flag**| `TradeEngine` / Config | `TradeEngine` / Config | **Keep.** Operational configuration check (workflow). |
| **JWT / Auth** | API Layer | API Layer | **Keep.** User authentication and authorization check (security). |
| **Read-Only Profile** | API Layer | API Layer | **Keep.** Access-control block (security). |

---

## 2. Invariant Checkpoint Checklist

Verify after refactoring `TradeEngine`:
1. **Does this service still calculate financial values?** (**No**)
2. **Does it directly mutate financial tables?** (**No**)
3. **Does it duplicate any engine rule?** (**No**)
4. **Does it remain stateless?** (**Yes**)
5. **Does it still pass existing tests?** (**Yes**)
