# Post-Launch Review Record
# Position Engine — 90-Day Review

<!--
  Instructions:
  Copy this file to database_v2/docs/reviews/YYYY-MM-DD_v{version}_90day.md
  Complete every section. Do not leave fields blank — if a signal was not
  examined, record why. The point is an honest artifact, not a clean one.

  This document is append-only once filed. If the review conclusion changes
  after further investigation, file a new review record that supersedes this one.
  Reference the earlier record by filename.
-->

---

## Identity

| Field | Value |
|-------|-------|
| Release | v<!-- e.g. 1.0.0 --> |
| Review date | <!-- YYYY-MM-DD --> |
| Review period | <!-- e.g. 2026-08-02 → 2026-11-02 --> |
| Conducted by | <!-- name(s) --> |
| Supersedes | <!-- filename of prior review, or "none" --> |

---

## Evidence Reviewed

Mark each signal as examined (✓), not applicable (—), or not available (✗).
For each examined signal, record a one-line finding. "No issues found" is a valid finding.

| Signal | Status | Finding |
|--------|--------|---------|
| Shadow mismatch logs (`v_telemetry_shadow_logs`) | | |
| Financial reconciliation history (`v_telemetry_financial_recon`) | | |
| RPC latency distributions (`rpc_metrics` P50/P95/P99) | | |
| Lock telemetry (`v_telemetry_locking`) | | |
| Deadlock and serialization statistics | | |
| Incident reports | | |
| Recovery drill results | | |
| Customer / support issues | | |
| Developer friction (PR history, code review comments) | | |

---

## Quantitative Summary

Fill in from `rpc_metrics` and production telemetry over the review period.

| Metric | Observed | SLO | Within SLO? |
|--------|----------|-----|-------------|
| P95 `place_order_v2` latency | | < 250ms | |
| P99 `place_order_v2` latency | | < 500ms | |
| P95 `close_position_v2` latency | | < 200ms | |
| Lock wait P95 | | < 50ms | |
| Deadlock count | | 0 | |
| Shadow mismatch rate | | < 1% | |
| Serialization failure rate | | < 0.1% | |
| Reconciliation alerts fired | | 0 | |
| Incidents attributed to engine design | | 0 | |

---

## Decision

Select exactly one:

- [ ] **Continue Architecture Freeze** — no v1.1 planning initiated
- [ ] **Begin v1.x Planning** — minor version, additive changes only (new optional parameters, no breaking changes)
- [ ] **Begin v2.0 Planning** — breaking changes required, new RPC names required, coordinated client upgrade required

---

## Reason

<!--
  State the concrete evidence that supports the decision above.

  For "Continue Freeze":
    Describe what was observed and why it does not justify architectural change.
    Example: "No recurring architectural deficiencies observed. All three incidents
    were attributable to business logic configuration, not engine design.
    P95 latency averaged 87ms, well within the 250ms SLO."

  For "Begin Planning":
    Describe the specific, measured problem.
    Example: "Sustained P99 latency of 680ms observed during peak trading hours
    on days with >500 concurrent users. Deadlock count was 0. Lock wait P95 was
    within SLO. Root cause is margin calculation contention under high concurrency.
    ADR-014 opened to evaluate partial index on positions(user_id, symbol, status)."

  Speculation or hypothetical future requirements are not valid reasons.
  Only production evidence counts.
-->

---

## Action Items

| # | Action | Owner | Due | ADR / ticket |
|---|--------|-------|-----|--------------|
| | | | | |

If the decision is "Continue Freeze" and there are no action items, write:
**No action items. Architecture freeze continues.**

---

## Next Review

| Field | Value |
|-------|-------|
| Scheduled date | <!-- 90 days from this review date --> |
| Trigger condition | Scheduled — or earlier if a production incident implicates engine design |
