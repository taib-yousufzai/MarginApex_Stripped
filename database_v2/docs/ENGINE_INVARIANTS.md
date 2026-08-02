# Engine Invariants

This document outlines the timeless mathematical contracts that the Position Engine guarantees. Regardless of the underlying query optimizations, code refactoring, database updates, or performance configurations, these rules must always be verified and satisfied.

---

## 1. Ownership & Identity Invariants

- **Single Owner Constraint:** Every executed order belongs to exactly one user profile:
  $$\forall o \in \text{orders}, \text{exists } u \in \text{profiles s.t. } o.\text{user\_id} = u.\text{id}$$
- **Ledger Mutation Links:** Every ledger transaction belongs to exactly one user profile and must map to a unique execution log (`ref_id`).
- **No Orphan Positions:** Every open position must belong to a valid user profile. No anonymous positions are tolerated.

---

## 2. Quantity & Margin Invariants

- **Non-Negative Quantities:** Position open quantity can never be negative:
  $$\forall p \in \text{positions}, p.\text{qty\_open} \ge 0$$
- **Non-Negative Locked Margins:** Reserved/locked margins can never be negative:
  $$\forall p \in \text{positions}, p.\text{locked\_margin} \ge 0$$
- **Closed Lot Integrity:** A closed position lot must have zero open quantity and zero locked margin:
  $$\forall p \in \text{positions} \text{ where } p.\text{status} = \text{'closed'}, p.\text{qty\_open} = 0 \text{ and } p.\text{locked\_margin} = 0$$

---

## 3. Financial Reconciliation Invariant

- **Balance Equation:** Available balance matches equity minus reserved margins.
- **Ledger Invariance:** The current user profile balance must equal the initial starting balance plus/minus the sum of all approved ledger transactions:
  $$\text{Balance}_{\text{current}} = \text{Balance}_{\text{initial}} + \sum \text{Transactions}_{\text{APPROVED}}$$

---

## 4. Transaction & Rollback Invariants

- **Failure Isolation:** Any validation, ledger adjustment, margin depletion, or state mutation failure triggers a full rollback. No partial financial states are ever committed.
- **Idempotency Uniqueness:** Each unique execution request (`idempotency_key` + `user_id`) produces exactly one transition. Re-runs yield identical states.
