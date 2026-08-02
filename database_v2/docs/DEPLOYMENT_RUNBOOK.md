# Deployment Runbook — Position Engine v1.0.0

This runbook covers the complete deployment sequence from pre-flight through Phase 3 operational qualification. Follow it in order. Do not skip steps. Capture evidence as you go — reconstructing it afterward is error-prone and produces a weaker evidence package.

---

## Pre-Flight (Before Running Any Migration)

Complete every item before touching the database.

- [ ] **Git tag created**
  ```
  git tag position-engine-v1.0.0-rc1
  git push origin position-engine-v1.0.0-rc1
  ```
  Tag format: `position-engine-v{version}-rc{n}` for release candidates, `position-engine-v{version}` for final.

- [ ] **Working tree is clean**
  ```
  git status
  ```
  Expected: `nothing to commit, working tree clean`. Stash or commit any pending changes before proceeding.

- [ ] **Governance audit is passing**
  ```
  npx ts-node scripts/ts_audit_checker.ts
  ```
  Expected: `CI Status: ✅ PASS` (0 CRITICAL, 0 HIGH). Do not deploy with open CRITICAL or HIGH violations.

- [ ] **TypeScript compiles without errors**
  ```
  npx tsc --noEmit
  ```

- [ ] **Target environment confirmed**
  Set `DEPLOY_ENV` to `staging` or `production` explicitly. Do not rely on defaults.
  ```
  echo $DEPLOY_ENV
  ```
  Visually confirm this is the intended target before continuing.

- [ ] **Database backup completed and verified**
  Take a point-in-time backup of the target database. Confirm the backup completed successfully — do not proceed if the backup status is unknown.
  Record backup ID/timestamp here: _______________

- [ ] **Rollback procedure and credentials are immediately available**
  The rollback procedure is documented in section "Emergency Rollback" below.
  Database credentials and Supabase dashboard access must be available before starting.
  Do not begin if you cannot roll back within 10 minutes.

- [ ] **Someone else is available to assist during the deployment window**
  Database deployments on financial systems should not be done solo.

---

## Phase 2 — Release Qualification

### Step 1: Deploy migrations

```
DEPLOY_ENV=staging \
DEPLOY_ID=$(git rev-parse --short HEAD)-$(date +%s) \
CI_ACTOR=$(git config user.name) \
npx ts-node scripts/deploy_position_engine.ts
```

Save the full console output to `releases/evidence/YYYY-MM-DD_v{version}/deployment_verification.txt`.

### Step 2: Run deployment verification

```
DEPLOY_ENV=staging \
DEPLOY_ID=$(git rev-parse --short HEAD)-$(date +%s) \
CI_ACTOR=$(git config user.name) \
npx ts-node scripts/verify_deployment.ts
```

Expected: `✅ DEPLOYMENT VERIFIED` with 0 failures. A release manifest is written to `releases/` automatically.
Save the console output to `releases/evidence/YYYY-MM-DD_v{version}/deployment_verification.txt`.

**Do not proceed if this step fails.**

### Step 3: Run contract tests

Connect to the target database and execute:
```sql
\i database_v2/tests/contract_tests.sql
```

Expected: `CONTRACT TESTS v1.0.0: ALL PASSED`
Save output to `releases/evidence/YYYY-MM-DD_v{version}/contract_tests.txt`.

**Do not proceed if any contract test fails.**

### Step 4: Run regression suite

```sql
\i database_v2/tests/position_engine_validation.sql
```

Expected: `SUCCESS: All Position Engine regression scenarios & invariants verified!`
Save output to `releases/evidence/YYYY-MM-DD_v{version}/regression_results.txt`.

### Step 5: Run load/concurrency suite

Execute the load tests and record P50, P95, P99 latencies for `place_order_v2` and `close_position_v2`.

SLO thresholds (any failure blocks Phase 2 completion):

| Metric | Required |
|--------|----------|
| P95 `place_order_v2` | < 250ms |
| P99 `place_order_v2` | < 500ms |
| P95 `close_position_v2` | < 200ms |
| Lock wait P95 | < 50ms |
| Deadlock count | = 0 |
| Serialization failure rate | < 0.1% |

Save results to `releases/evidence/YYYY-MM-DD_v{version}/load_test_summary.txt`.

### Step 6: Rollback rehearsal

Execute the full rollback on staging and confirm the system operates correctly on the legacy path:

1. Switch traffic to v1 path (re-enable legacy RPCs or redirect at application layer).
2. Confirm at least one order executes successfully on the legacy path.
3. Switch traffic back to v2.
4. Confirm at least one order executes successfully on v2.
5. Record what you did, timing, and outcome.

Save output to `releases/evidence/YYYY-MM-DD_v{version}/rollback_rehearsal.txt`.

**This is a required artifact. The evidence package cannot be sealed without it.**

### Step 7: Seal the evidence package

```
DEPLOY_ENV=staging npx ts-node scripts/collect_release_evidence.ts
```

Expected: `✅ Evidence package SEALED` with a package hash printed.

Confirm the `COMPLETE` sentinel exists:
```
cat releases/evidence/YYYY-MM-DD_v{version}/COMPLETE
```

**Phase 2 is complete when the evidence package is sealed. Do not begin Phase 3 without a sealed package.**

---

## Phase 3 — Operational Qualification

### Entry conditions
- Phase 2 evidence package is sealed.
- Deployment is on staging or production.
- Reconciliation cron is scheduled.
- Schema drift cron is scheduled.

### Step 8: Enable shadow mode

```sql
UPDATE public.shadow_mode_config
SET enabled = true, updated_at = now()
WHERE id = 1;
```

Confirm:
```sql
SELECT enabled, max_mismatch_rate FROM shadow_mode_config WHERE id = 1;
```

Monitor `v_telemetry_shadow_logs` daily. Any unexplained mismatch must be investigated and resolved before advancing the rollout percentage.

### Step 9: Progressive rollout

Advance through rollout stages only when the previous stage shows clean metrics for at least 24 hours.

| Stage | Traffic | Minimum duration | Gate |
|-------|---------|------------------|------|
| 1 | 1% | 24 hours | No shadow mismatches, no reconciliation alerts |
| 2 | 10% | 24 hours | SLOs met, reconciliation clean |
| 3 | 50% | 48 hours | SLOs met, shadow mismatches = 0 unexplained |
| 4 | 100% | 7 days | All Phase 3 exit criteria trending toward completion |

At each stage, record:
- Shadow mismatch count (explained vs unexplained)
- Reconciliation discrepancies
- P95 / P99 latencies
- Deadlock count
- Any incidents

### Step 10: Monitor exit criteria

Phase 3 closes when all of the following are simultaneously true (see `PRODUCTION_READINESS.md` for the complete list):

- Shadow mismatches = 0 unexplained for 30 consecutive days
- Reconciliation discrepancies = 0 for 30 consecutive days
- Zero Sev-1 financial incidents attributable to engine design
- SLOs met continuously for 7+ days at 100% traffic
- Legacy engine retired

Check daily:
```sql
-- Shadow mode
SELECT * FROM public.v_telemetry_shadow_logs ORDER BY created_at DESC LIMIT 20;

-- Reconciliation
SELECT user_id, ledger_discrepancy
FROM public.v_telemetry_financial_recon
WHERE abs(ledger_discrepancy) > 1.0;

-- Schema drift
SELECT * FROM public.detect_schema_drift();

-- Latency
SELECT rpc_name,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
FROM public.rpc_metrics
WHERE created_at >= now() - interval '24 hours'
GROUP BY rpc_name;
```

### Step 11: Legacy retirement

Only after the observation window is satisfied:
```
-- Confirm zero legacy invocations
\i scripts/verify_legacy_retirement.sql
```

Then promote and apply:
```
cp database_v2/demolition_script.sql supabase/migrations/20260803_demolition.sql
npx ts-node scripts/deploy_position_engine.ts  # redeploy with demolition included
npx ts-node scripts/verify_deployment.ts        # confirm legacy functions absent
```

### Step 12: Issue certification

Once all Phase 3 exit criteria are met, complete `ENGINE_CERTIFICATION.md` at the repo root and commit it.

```
git add ENGINE_CERTIFICATION.md
git commit -m "cert: position engine v1.0.0 production certified"
git tag position-engine-v1.0.0
git push origin main --tags
```

---

## Emergency Rollback

If at any point during Phase 2 or Phase 3 a critical issue is found:

**Immediate (< 2 minutes):**
1. Disable shadow mode: `UPDATE shadow_mode_config SET enabled = false WHERE id = 1;`
2. If v2 traffic is causing financial errors: redirect application traffic to the legacy RPC path.
3. Alert the team.

**Investigation (< 10 minutes):**
1. Check `v_telemetry_shadow_logs` for mismatch details.
2. Check `v_telemetry_financial_recon` for any discrepancies.
3. Check `v_telemetry_locking` for deadlock evidence.
4. Identify affected users.

**Recovery:**
1. If data integrity is intact: restore shadow mode after fixing the root cause.
2. If data integrity is in question: freeze affected user accounts (`active = false`) and engage incident playbook (`INCIDENT_PLAYBOOK.md`).
3. Do not resume rollout until the root cause is documented and resolved.

**The backup taken in pre-flight is the last resort.** Restore only if all other recovery paths are exhausted. Restoring from backup has financial implications (transactions after the backup point are lost) and requires reconciliation verification afterward.

---

## Resist the Temptation to Optimize

During Phase 3, the purpose is observation, not improvement.

If something looks suboptimal, record it. Do not change it. The 90-day post-launch review is the correct venue for deciding whether production evidence justifies a change. Premature optimization during Phase 3 introduces new variables into an environment you are actively trying to characterize.

The questions Phase 3 answers are:
- Does the engine behave correctly under real traffic?
- Do telemetry and reconciliation agree?
- Do shadow comparisons converge to effectively zero unexplained mismatches?
- Are the operational SLOs being met?

If the answers are consistently yes, the engine has earned production certification.
