# Architectural Decision Records (ADRs)

This document records the foundational architectural decisions made during the design and implementation of the Position Engine (v1.0.0).

---

## ADR-001: Database is Source of Truth
- **Status:** Approved
- **Decided by:** Platform Architecture Team
- **Context:** Storing financial positions and balances in-memory or relying on client-side state introduces high risks of logic drift, cache invalidation, and data desynchronization.
- **Decision:** All financial states (orders, positions, ledger, profiles) are stored and managed exclusively within the database. The database is the authoritative source of truth.
- **Consequences:** TS/JS layers calculate expectations for fast UI feedback, but the database re-validates all expectations synchronously inside Postgres transactions before committing.

---

## ADR-002: FIFO Lot Selection
- **Status:** Approved
- **Decided by:** Trading Risk Team
- **Context:** Exits and opposite-side netting must follow a predictable, deterministic, and compliance-friendly accounting standard.
- **Decision:** Cumulative position netting, exits, stop-loss triggers, target triggers, liquidations, and auto square-offs must consume open position lots using First-In, First-Out (FIFO) ordering (`ORDER BY entry_time ASC`).
- **Consequences:** Eliminates LIFO or arbitrary lot selection bugs. Standardizes behavior across all manual and automated exit pathways.

---

## ADR-003: Single Transaction Orchestration
- **Status:** Approved
- **Decided by:** Platform Architecture Team
- **Context:** Event chains and database trigger side-effects (e.g. order inserts firing trigger, updating position, firing another trigger to debit margin) are difficult to trace and prone to partial failures.
- **Decision:** All financial operations must occur inside a single synchronous Postgres transaction block (`place_order_v2`, `close_position_v2`) without relying on side-effect chains.
- **Consequences:** Ensures atomic changes. Any validation or state mutation failure rolls back the entire block cleanly, leaving no orphaned orders or margin discrepancies.

---

## ADR-004: Ledger-First Accounting
- **Status:** Approved
- **Decided by:** Finance Audit Team
- **Context:** Direct mutations of user balances without audit logs are non-compliant and untraceable.
- **Decision:** User balances are derived and projected from transaction ledger entries. A transaction projection trigger (`sync_profile_balance`) automatically projects approved ledger entries into the `profiles` table.
- **Consequences:** Reconciling user balances is deterministic—if balances drift, they can always be rebuilt from the transactions ledger.

---

## ADR-005: No Direct Mutations
- **Status:** Approved
- **Decided by:** Platform Security Team
- **Context:** Bypassing execution logic by mutating tables directly leads to unsynchronized states.
- **Decision:** No application code may directly mutate financial tables (`positions`, `orders`, `transactions`, `ledger`, `profiles`). All state mutations must flow through versioned RPC endpoints.
- **Consequences:** Enforces a secure, auditable, and single path of write authority for financial transitions.
