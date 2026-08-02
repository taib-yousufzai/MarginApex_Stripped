# Business Logic Inventory & System Boundaries (v1.0.0)

This document formalizes the division of responsibilities between the application layer and the **Position Engine (v1.0.0)**, inventorying where calculations reside and listing system component interface compatibility.

---

## 1. Business Logic Inventory

Our goal is to ensure **no business calculations** (margins, brokerage, P&L, FIFO splits) are duplicated or performed in the application layer. The application layer must only read and present state, or delegate mutations to versioned SQL RPCs.

| Service / Component | Reads | Writes | Financial Logic? | Keep / Action |
| :--- | :--- | :--- | :--- | :--- |
| **PositionService** | ✅ Reads DB | RPC | **No** | ✅ Keep. Delegating read queries to new views/tables. |
| **ExecutionService** | ✅ Reads DB | RPC | **No** | ✅ Keep. Purely handles Kite execution payloads and routes to database. |
| **TradeEngine** | Config parameters | RPC | **No** (Was: Yes) | ⚠️ **Reduce.** Strip all lot sizing, margin projections, and local netting loops. |
| **MarginService** | DB Limits | None | **No** (Was: Yes) | ⚠️ **Move.** Eliminate TS-level margin formulas; read requirements from engine outputs. |
| **BrokerageService** | Config rates | None | **No** (Was: Yes) | ⚠️ **Move.** Deprecate TS-level commission/fee calculations; delegate to RPC logic. |

---

## 2. API Responsibility Boundaries

```text
  [ Client / Frontend ]
           │ (Presentation & Interaction only - No Calculations)
           ▼
     [ API Layer ]
           │ (Auth, Payload Validation, Rate Limits, Idempotency Headers)
           ▼
   [ Position Engine v1 ]
             (FIFO Netting, Margins, Brokerage, Ledger, Balance, P&L, Lifecycle)
```

### API Layer
- **Responsibilities:**
  - Request authentication and user session verification.
  - Request schema validation (required fields, types, formats).
  - Rate limiting and request throttling.
  - Extraction and tracking of idempotency headers/keys.
  - Response formatting and client error code serialization.

### Position Engine
- **Responsibilities:**
  - Order execution and lot netting (FIFO).
  - Margin checking, locking, and validation.
  - Brokerage and transaction buffer fee calculations.
  - Transactions ledger logging and projection to balances.
  - Realized and unrealized P&L calculations.
  - Position state lifecycle transitions.

### Frontend
- **Responsibilities:**
  - UI state rendering (charts, tables, indicators).
  - User input collection.
  - Interactive validation (e.g., non-empty form checks).
  - *Never* calculates brokerage, margin, or P&L locally.

---

## 3. Component Compatibility Matrix

This matrix tracks which application subsystems and workers are linked to which engine interface contracts:

| System Component | Interface / RPC | Required Engine Version | Status |
| :--- | :--- | :--- | :--- |
| **Next.js Web App** | `place_order_v2`, `close_position_v2` | v1.0.0 | ⬜ Pending |
| **Admin Panel** | `close_position_v2` | v1.0.0 | ⬜ Pending |
| **Stop Loss Worker** | `place_order_v2`, `close_position_v2` | v1.0.0 | ⬜ Pending |
| **Liquidation Daemon** | `close_position_v2` | v1.0.0 | ⬜ Pending |
| **Settlement / EOD Worker** | `close_position_v2` | v1.0.0 | ⬜ Pending |
| **Mobile API Gateways** | `place_order_v2`, `close_position_v2` | v1.0.0 | ⬜ Pending |
