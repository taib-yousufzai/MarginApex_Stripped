# Production Readiness Checklist (v1.0.0)

The release process is split into three phases. Each phase has different completion criteria and a different person responsible for sign-off.

**For the step-by-step execution sequence, pre-flight checklist, and emergency rollback procedure, see `database_v2/docs/DEPLOYMENT_RUNBOOK.md`.**

---

## Phase 1 — Code Freeze ✅

**Status: COMPLETE**

These are engineering gates. They are verified by static analysis, code review, and the governance audit script. They do not require a running database or production traffic.

| Gate | Verified by | Status |
|------|-------------|--------|
| Position Engine implemented (`place_order_v2`, `close_position_v2`, FIFO, margin) | Code review | ✅ |
| ADRs written and frozen | `ARCHITECTURE_DECISIONS.md` | ✅ |
| Engine invariants documented | `ENGINE_INVARIANTS.md` | ✅ |
| SQL contracts documented | `DATABASE_CONTRACT.md` | ✅ |
| Contract tests written | `database_v2/tests/contract_tests.sql` | ✅ |
| Regression suite written | `database_v2/tests/position_engine_validation.sql` | ✅ |
| Governance audit passing | `ts_audit_checker.ts` — 0 CRITICAL, 0 HIGH | ✅ |
| Zero direct financial mutations outside approved gateways | Audit history | ✅ |
| Deployment tooling complete | `deploy_position_engine.ts`, `verify_deployment.ts` | ✅ |
| Release manifest tooling complete | `verify_deployment.ts` → `releases/` | ✅ |
| Schema drift detection complete | `check_schema_drift.sql`, `compute_schema_hash()` | ✅ |
| Incident playbook written | `INCIDENT_PLAYBOOK.md` | ✅ |
| Contributing / migration policy written | `CONTRIBUTING.md` | ✅ |
| Post-launch review template written | `POST_LAUNCH_REVIEW_TEMPLATE.md` | ✅ |

---

## Phase 2 — Release Qualification

**Status: NOT STARTED — requires deployment**

These gates require executing the release candidate against a real database. They can typically be completed in a few hours once the deployment is initiated.

### 2a. Deploy and verify

- [ ] `scripts/deploy_position_engine.ts` runs to completion with no errors
- [ ] `scripts/verify_deployment.ts` exits 0 with zero failures
- [ ] `engine_metadata` row present with correct `engine_version`, `contract_version`, `schema_version`
- [ ] `engine_releases` row present with `verification_passed = true`
- [ ] Schema drift baseline recorded in `engine_schema_snapshots`
- [ ] Migration hash computed and stored in `engine_metadata`

### 2b. Run test suites

- [ ] Contract tests pass: `database_v2/tests/contract_tests.sql` — all 8 assertions pass
- [ ] Regression suite passes: `database_v2/tests/position_engine_validation.sql` — all 7 scenarios pass
- [ ] Load/concurrency suite passes — results within SLOs:
  - [ ] P95 `place_order_v2` < 250ms
  - [ ] P99 `place_order_v2` < 500ms
  - [ ] P95 `close_position_v2` < 200ms
  - [ ] Lock wait P95 < 50ms
  - [ ] Deadlock count = 0
  - [ ] Serialization failure rate < 0.1%
- [ ] `EXPLAIN ANALYZE` confirms no sequential scans on `orders`, `transactions`, `positions`

### 2c. Rollback rehearsal

- [ ] Rollback procedure executed successfully against **staging** — not just documented
- [ ] Traffic switched from v2 back to v1 path, confirmed working
- [ ] Traffic switched back to v2, confirmed working
- [ ] Result recorded in `rollback_rehearsal.txt` (placed in evidence directory)

There is a significant difference between "rollback plan exists" and "rollback was executed successfully." This gate requires the latter.

### 2d. Release evidence package

- [ ] Release manifest present in `releases/` with `verification_passed = true`
- [ ] Governance audit output archived
- [ ] Contract test results archived
- [ ] Regression suite results archived
- [ ] Load test summary archived
- [ ] Rollback rehearsal output archived
- [ ] Evidence package sealed: `COMPLETE` sentinel exists in `releases/evidence/YYYY-MM-DD_v{version}/`
- [ ] Package hash recorded in `COMPLETE` and `INDEX.json`

The evidence package is immutable once sealed. Any correction after sealing requires a revision directory (`…-rev1/`). The package hash (SHA-256 of all file contents) gives the directory a tamper-evident identity. See `scripts/collect_release_evidence.ts`.

---

## Phase 3 — Operational Qualification

**Status: NOT STARTED — requires elapsed time and production traffic**

These gates cannot be completed quickly. They depend on real traffic, real time, and observed system behaviour. Each has a minimum duration that cannot be shortened.

### 3a. Shadow mode

- [ ] Shadow mode enabled in `shadow_mode_config`
- [ ] Running against realistic production traffic volume
- [ ] Mismatch rate < 1% over rolling 1,000 orders
- [ ] No unexplained mismatches — all mismatches investigated and resolved or classified
- [ ] Minimum duration: until mismatch rate is effectively zero for 48+ consecutive hours

### 3b. Progressive rollout

- [ ] Staged rollout initiated (e.g. 1% → 10% → 50% → 100% of traffic)
- [ ] At each stage, confirm within SLOs:
  - [ ] Latency (P95, P99)
  - [ ] Deadlock rate
  - [ ] Rollback rate
  - [ ] Reconciliation discrepancy = 0
- [ ] Rollback plan tested at least once at the 1% stage

### 3c. Telemetry and reconciliation

- [ ] `rpc_metrics` populated — confirmed by `SELECT count(*), rpc_name FROM rpc_metrics GROUP BY rpc_name`
- [ ] Reconciliation cron scheduled and running — `v_telemetry_financial_recon` polled daily, alerts on `ledger_discrepancy > 1.0`
- [ ] Schema drift cron scheduled — `check_schema_drift.sql` running daily, alerts on `drift_detected = true` with `drift_severity = CRITICAL`

### 3d. Legacy retirement

- [ ] Observation window: `verify_legacy_retirement.sql` query #1 returns 0 rows for 72+ continuous hours
- [ ] `v_telemetry_financial_recon` shows zero `ledger_discrepancy` across all active users
- [ ] Demolition script applied: `database_v2/demolition_script.sql` → `supabase/migrations/`
- [ ] Post-demolition verification: legacy functions and triggers confirmed absent

### 3e. Disaster recovery

- [ ] Production backup restored into isolated environment
- [ ] `database_v2/tests/contract_tests.sql` passes against restored database
- [ ] `database_v2/tests/position_engine_validation.sql` passes against restored database
- [ ] `v_telemetry_financial_recon` shows zero discrepancy post-restore
- [ ] Open positions and balances match live snapshot
- [ ] Restore duration measured and documented

### 3f. Full rollout declaration and Phase 3 exit criteria

Phase 3 ends when **all** of the following are simultaneously true. These are not aspirational — each requires documented evidence:

- [ ] 100% of traffic on v2 engine
- [ ] Shadow mismatch rate = 0 unexplained mismatches for 30 consecutive days
- [ ] `v_telemetry_financial_recon` shows zero `ledger_discrepancy` for 30 consecutive days
- [ ] Zero Sev-1 financial incidents attributable to engine design
- [ ] All SLOs met continuously for 7+ days at full traffic:
  - P95 `place_order_v2` < 250ms
  - P99 `place_order_v2` < 500ms
  - Lock wait P95 < 50ms
  - Deadlock count = 0
- [ ] Legacy engine retired (demolition script applied and verified)
- [ ] Architecture Freeze formally declared
- [ ] Compatibility paths removed from `verify_deployment.ts` (step 9 try/catch)
- [ ] `ENGINE_CERTIFICATION.md` issued and committed to repo root

**Without an explicit exit condition, operational qualification becomes an indefinite state.** These criteria exist to close Phase 3 cleanly, not to set a bar so high it is never reached.

---

## Phase 2 Completion: Release Evidence Package

The evidence package is the definitive answer to "what was deployed and was it verified." It must be sealed (COMPLETE sentinel present) before Phase 3 begins.

**Location:** `releases/evidence/YYYY-MM-DD_v{version}/`

**Contents:**

| File | Source | Type |
|------|--------|------|
| `release_manifest.json` | Auto: `verify_deployment.ts` | Automatic |
| `governance_audit.json` | Auto: `audit_history.json` last entry | Automatic |
| `engine_releases_row.json` | Auto: `engine_releases` table | Automatic |
| `engine_metadata_row.json` | Auto: `current_engine_version()` | Automatic |
| `deployment_verification.txt` | Manual: console output of `verify_deployment.ts` | Manual |
| `contract_tests.txt` | Manual: console output of `contract_tests.sql` | Manual |
| `regression_results.txt` | Manual: console output of `position_engine_validation.sql` | Manual |
| `load_test_summary.txt` | Manual: load test results with P50/P95/P99 latencies | Manual |
| `rollback_rehearsal.txt` | Manual: rollback execution output from staging | Manual |
| `INDEX.json` | Auto: generated by collector | Automatic |
| `COMPLETE` | Auto: written on seal, contains package hash | Automatic |

Generate and seal with: `npx ts-node scripts/collect_release_evidence.ts`

---

## Post-Launch Review (90 Days After Phase 3 Completion)

Schedule 90 days after the Phase 3f declaration. Use `POST_LAUNCH_REVIEW_TEMPLATE.md`. File the completed record as `database_v2/docs/reviews/YYYY-MM-DD_v{version}_90day.md`.

The review examines shadow mode history, reconciliation alerts, RPC latency distributions, lock telemetry, incidents, recovery drill results, and developer friction. The default conclusion is: keep the freeze. Only production evidence of recurring friction or a demonstrated bottleneck justifies planning v1.1.

---

## Engineering Status

| Area | Status |
|------|--------|
| Financial engine | ✅ Complete |
| Transaction boundaries | ✅ Complete |
| FIFO implementation | ✅ Complete |
| RPC contracts | ✅ Complete |
| Governance & audit | ✅ Complete |
| Regression testing | ✅ Complete |
| Contract testing | ✅ Complete |
| Deployment verification | ✅ Complete |
| Release management | ✅ Complete |
| Schema drift detection | ✅ Complete |
| Documentation | ✅ Complete |
| Release Qualification (Phase 2) | 🔴 Not started |
| Operational Qualification (Phase 3) | 🔴 Not started |
| 90-day post-launch review | 🔵 Pending Phase 3 |
