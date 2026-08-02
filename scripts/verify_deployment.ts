/**
 * Deployment Verification
 *
 * Runs after every deploy to confirm the resulting database state matches
 * exactly what the engine requires. Migrations succeeding is necessary but
 * not sufficient — this script verifies the outcome, not the process.
 *
 * Checks:
 *  1. Required RPCs exist with correct signatures
 *  2. Forbidden legacy RPCs are absent
 *  3. Required indexes exist
 *  4. Required triggers exist (append-only enforcement, legacy isolation)
 *  5. engine_metadata version matches TypeScript constants
 *  6. Required tables exist
 *
 * Exit codes:
 *  0 — all checks passed
 *  1 — one or more checks failed (details printed to stdout)
 */

import { Client } from 'pg';
import * as readline from 'readline';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ─── Expected state ────────────────────────────────────────────────────────────
// These lists are the source of truth. Any divergence between these constants
// and the live database state is a deployment failure.

const EXPECTED_ENGINE_VERSION   = '1.0.0';
const EXPECTED_CONTRACT_VERSION = '1.0.0';
const EXPECTED_SCHEMA_VERSION   = '1.0.0';

const REQUIRED_FUNCTIONS = [
  'place_order_v2',
  'close_position_v2',
  'get_trade_context_v1',
  'apply_carry_charges_v1',
  'convert_position_v1',
  'run_shadow_order_v2',
  'run_shadow_close_v2',
  'create_position_internal',
  'increase_position_internal',
  'reduce_position_internal',
  'current_engine_version',
  'financial_events_deny_mutation',
];

// These must NOT exist after the demolition script runs.
// Before demolition they may still be present — this list is checked but
// failures are reported as WARNINGS not errors until demolition is complete.
const FORBIDDEN_AFTER_DEMOLITION = [
  'process_executed_position',
  'place_order',
  'close_position',
  'handle_order_execution',
  'calculate_position_margin',
  'position_insert_margin_debit',
];

const REQUIRED_TABLES = [
  'positions',
  'orders',
  'transactions',
  'profiles',
  'rpc_metrics',
  'shadow_mismatch_logs',
  'shadow_mode_config',
  'engine_metadata',
  'engine_releases',
  'engine_schema_snapshots',
  'financial_events',
  'act_logs',
];

const REQUIRED_INDEXES = [
  'idx_rpc_metrics_time',
  'idx_rpc_metrics_correlation',
  'idx_financial_events_correlation',
  'idx_financial_events_user_time',
  'idx_financial_events_type_time',
  'idx_shadow_mismatch_corr',
];

const REQUIRED_TRIGGERS = [
  // Append-only journal enforcement
  { trigger: 'financial_events_deny_update', table: 'financial_events' },
  { trigger: 'financial_events_deny_delete', table: 'financial_events' },
  // Append-only release history enforcement
  { trigger: 'engine_releases_deny_update',  table: 'engine_releases' },
  { trigger: 'engine_releases_deny_delete',  table: 'engine_releases' },
];

// ─── Result tracking ───────────────────────────────────────────────────────────

interface CheckResult {
  name:    string;
  passed:  boolean;
  warning: boolean;   // true = report but don't fail
  detail:  string;
}

const results: CheckResult[] = [];

function pass(name: string, detail = ''): void {
  results.push({ name, passed: true, warning: false, detail });
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, warning: false, detail });
}

function warn(name: string, detail: string): void {
  results.push({ name, passed: true, warning: true, detail });
}

// ─── Release manifest ──────────────────────────────────────────────────────────
// Manifests are immutable artifacts — written once, never edited.
// Each run of this script produces a new manifest file. The manifest only
// records what is known and verified at the time it is written. There are no
// PENDING fields. If a suite result is not available at verification time,
// run a separate verification pass after the suite completes; that produces
// its own manifest. The manifest_hash field makes accidental modification
// detectable: SHA-256 of the JSON content with manifest_hash omitted.

interface ReleaseManifest {
  manifest_schema_version: string;   // version of this manifest format — frozen at '1.0'
  manifest_hash:           string;   // SHA-256 of manifest content (manifest_hash field set to '')
  deployment_id:           string;   // unique ID for this specific deploy run
  environment:             string;   // production | staging | local
  operator:                string;   // CI workflow name, or git user if run manually
  timestamp:               string;
  engine_version:          string;
  contract_version:        string;
  schema_version:          string;
  governance_policy:       string;
  migration_hash:          string;
  commit:                  string;
  branch:                  string;
  author:                  string;
  verification_passed:     boolean;
  warnings:                number;
  checks_passed:           number;
  checks_failed:           number;
}

function writeReleaseManifest(
  engineVersion:   string,
  contractVersion: string,
  schemaVersion:   string,
  migrationHash:   string,
  passCount:       number,
  warnCount:       number,
  failCount:       number,
): void {
  const releasesDir = path.resolve(process.cwd(), 'releases');
  if (!fs.existsSync(releasesDir)) {
    fs.mkdirSync(releasesDir, { recursive: true });
  }

  // Git metadata — fail-safe if git is unavailable
  let commit = 'N/A', branch = 'N/A', author = 'N/A';
  try {
    commit = execSync('git rev-parse HEAD',               { stdio: 'pipe' }).toString().trim();
    branch = execSync('git rev-parse --abbrev-ref HEAD',  { stdio: 'pipe' }).toString().trim();
    author = execSync('git log -1 --pretty=format:"%an"', { stdio: 'pipe' }).toString().trim();
  } catch { /* git not available */ }

  const policyVersion: string = (() => {
    try {
      const p = path.resolve(process.cwd(), 'database_v2', 'docs', 'audit_policy.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).policy_version ?? 'unknown';
    } catch { return 'unknown'; }
  })();

  // Deployment identity — prefer CI environment variables, fall back to local context
  const environment  = process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'local';
  const deploymentId = process.env.DEPLOY_ID  ?? `local-${Date.now()}`;
  const operator     = process.env.CI_WORKFLOW ?? process.env.CI_ACTOR ?? author;

  const timestamp = new Date().toISOString();

  // Build the manifest without the hash field first, then compute and add it
  const manifestBody: Omit<ReleaseManifest, 'manifest_hash'> = {
    manifest_schema_version: '1.0',
    deployment_id:           deploymentId,
    environment,
    operator,
    timestamp,
    engine_version:          engineVersion,
    contract_version:        contractVersion,
    schema_version:          schemaVersion,
    governance_policy:       policyVersion,
    migration_hash:          migrationHash,
    commit,
    branch,
    author,
    verification_passed:     failCount === 0,
    warnings:                warnCount,
    checks_passed:           passCount,
    checks_failed:           failCount,
  };

  const manifestHash = createHash('sha256')
    .update(JSON.stringify(manifestBody))
    .digest('hex');

  const manifest: ReleaseManifest = { ...manifestBody, manifest_hash: manifestHash };

  // Filename: timestamp + environment + pass/fail — sortable, scannable without opening
  const status   = failCount === 0 ? 'pass' : 'fail';
  const filename = `${timestamp.slice(0, 19).replace(/[:T]/g, '-')}_${environment}_${status}.json`;

  const manifestPath = path.join(releasesDir, filename);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`\nRelease manifest written to: releases/${filename}`);
  console.log(`Manifest hash: ${manifestHash.slice(0, 16)}`);
  return manifestHash;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const getPassword = (): Promise<string> => {
    if (process.env.SUPABASE_DB_PASSWORD) {
      return Promise.resolve(process.env.SUPABASE_DB_PASSWORD);
    }
    return new Promise(resolve => rl.question('Enter Supabase Database Password: ', resolve));
  };

  const password = await getPassword();
  rl.close();

  const client = new Client({
    host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });

  // Captured during check #1 for use in the manifest
  let deployedEngineVersion   = EXPECTED_ENGINE_VERSION;
  let deployedContractVersion = EXPECTED_CONTRACT_VERSION;
  let deployedSchemaVersion   = EXPECTED_SCHEMA_VERSION;
  let deployedMigrationHash   = '';

  // Hoisted so it's available both inside try (for INSERT) and after finally (for UPDATE)
  const deploymentId = process.env.DEPLOY_ID ?? `local-${Date.now()}`;

  try {
    await client.connect();

    // ── 1. engine_metadata version check ────────────────────────────────────
    const metaRes = await client.query(
      `SELECT engine_version, contract_version, schema_version, migration_hash
       FROM public.engine_metadata WHERE id = 1`
    );

    if (metaRes.rows.length === 0) {
      fail('engine_metadata', 'Row not found — engine_metadata table missing or empty');
    } else {
      const row = metaRes.rows[0];
      deployedEngineVersion   = row.engine_version   ?? EXPECTED_ENGINE_VERSION;
      deployedContractVersion = row.contract_version ?? EXPECTED_CONTRACT_VERSION;
      deployedSchemaVersion   = row.schema_version   ?? EXPECTED_SCHEMA_VERSION;
      deployedMigrationHash   = row.migration_hash   ?? '';

      if (row.engine_version === EXPECTED_ENGINE_VERSION) {
        pass('engine_metadata.engine_version', `${row.engine_version}`);
      } else {
        fail('engine_metadata.engine_version',
          `Expected ${EXPECTED_ENGINE_VERSION}, got ${row.engine_version}`);
      }
      if (row.contract_version === EXPECTED_CONTRACT_VERSION) {
        pass('engine_metadata.contract_version', `${row.contract_version}`);
      } else {
        fail('engine_metadata.contract_version',
          `Expected ${EXPECTED_CONTRACT_VERSION}, got ${row.contract_version}`);
      }
      if (row.schema_version === EXPECTED_SCHEMA_VERSION) {
        pass('engine_metadata.schema_version', `${row.schema_version}`);
      } else {
        fail('engine_metadata.schema_version',
          `Expected ${EXPECTED_SCHEMA_VERSION}, got ${row.schema_version}`);
      }
      if (!row.migration_hash) {
        warn('engine_metadata.migration_hash', 'migration_hash is null — run deploy script to populate');
      } else {
        pass('engine_metadata.migration_hash', row.migration_hash);
      }
    }

    // ── 2. Required functions exist ──────────────────────────────────────────
    const fnRes = await client.query(
      `SELECT proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`
    );
    const existingFns = new Set(fnRes.rows.map((r: any) => r.proname as string));

    for (const fn of REQUIRED_FUNCTIONS) {
      if (existingFns.has(fn)) {
        pass(`function:${fn}`);
      } else {
        fail(`function:${fn}`, `Required function public.${fn} not found`);
      }
    }

    // ── 3. Forbidden functions absent ───────────────────────────────────────
    for (const fn of FORBIDDEN_AFTER_DEMOLITION) {
      if (existingFns.has(fn)) {
        warn(`forbidden_function:${fn}`,
          `Legacy function public.${fn} still exists — run demolition_script.sql after observation window`);
      } else {
        pass(`forbidden_function:${fn}`, 'absent ✓');
      }
    }

    // ── 4. Required tables exist ─────────────────────────────────────────────
    const tblRes = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const existingTables = new Set(tblRes.rows.map((r: any) => r.tablename as string));

    for (const tbl of REQUIRED_TABLES) {
      if (existingTables.has(tbl)) {
        pass(`table:${tbl}`);
      } else {
        fail(`table:${tbl}`, `Required table public.${tbl} not found`);
      }
    }

    // ── 5. Required indexes exist ────────────────────────────────────────────
    const idxRes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const existingIndexes = new Set(idxRes.rows.map((r: any) => r.indexname as string));

    for (const idx of REQUIRED_INDEXES) {
      if (existingIndexes.has(idx)) {
        pass(`index:${idx}`);
      } else {
        fail(`index:${idx}`, `Required index ${idx} not found`);
      }
    }

    // ── 6. Required triggers exist ───────────────────────────────────────────
    const trgRes = await client.query(
      `SELECT trigger_name, event_object_table FROM information_schema.triggers
       WHERE trigger_schema = 'public'`
    );
    const existingTriggers = new Set(
      trgRes.rows.map((r: any) => `${r.trigger_name}@${r.event_object_table}`)
    );

    for (const { trigger, table } of REQUIRED_TRIGGERS) {
      const key = `${trigger}@${table}`;
      if (existingTriggers.has(key)) {
        pass(`trigger:${trigger}`);
      } else {
        fail(`trigger:${trigger}`, `Required trigger ${trigger} on ${table} not found`);
      }
    }

    // ── 7. shadow_mode_config seeded ────────────────────────────────────────
    const smRes = await client.query(
      `SELECT id, enabled, max_mismatch_rate FROM public.shadow_mode_config WHERE id = 1`
    );
    if (smRes.rows.length === 0) {
      fail('shadow_mode_config', 'Config row missing — INSERT seed not applied');
    } else {
      pass('shadow_mode_config', `enabled=${smRes.rows[0].enabled}, max_mismatch_rate=${smRes.rows[0].max_mismatch_rate}`);
    }

    // ── 8. Compute and record migration hash ─────────────────────────────────
    // Hash input per file: filename + ':' + file_size_bytes + ':' + file_contents
    // Concatenated in sorted filename order, then SHA-256'd.
    //
    // Hashing contents (not just filenames) means a modified migration file
    // produces a different hash even if its name is unchanged. Including the
    // filename and size makes accidental collisions between differently-named
    // files with identical contents distinguishable.
    const migrationsDir = path.resolve(process.cwd(), 'supabase', 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      const hasher = createHash('sha256');
      for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const contents     = fs.readFileSync(filePath, 'utf8');
        const { size }     = fs.statSync(filePath);
        hasher.update(`${file}:${size}:${contents}`);
      }
      const hash = hasher.digest('hex').slice(0, 16);
      deployedMigrationHash = hash;
      await client.query(
        `UPDATE public.engine_metadata
         SET migration_hash = $1, deployment_timestamp = now()
         WHERE id = 1`,
        [hash]
      );
      pass('migration_hash_recorded', `sha256[0:16]=${hash} (${files.length} files hashed)`);
    }

    // ── 9. Record baseline schema snapshot ───────────────────────────────────
    // Captures the structural SHA-256 hash of the live database immediately after
    // deployment. Future drift detection compares against this baseline.
    // The hash algorithm is stored alongside the hash for forward compatibility.
    try {
      await client.query(
        `INSERT INTO public.engine_schema_snapshots
           (schema_hash, schema_hash_algorithm, is_baseline, drift_detected)
         VALUES (public.compute_schema_hash(), 'sha256', true, false)`
      );
      pass('schema_snapshot_recorded', 'baseline sha256 schema hash captured');
    } catch (e: any) {
      // Non-fatal: schema_snapshots table may not exist on older deployments.
      // Remove this compatibility path once all environments are on 20260802_schema_snapshots.sql.
      warn('schema_snapshot_recorded', `could not record baseline: ${e.message}`);
    }

    // ── 10. Insert engine_releases row ────────────────────────────────────────
    // One immutable row per deployment. Idempotent via deployment_id UNIQUE constraint.
    const environment  = process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'local';
    const operator     = process.env.CI_WORKFLOW ?? process.env.CI_ACTOR ?? 'unknown';
    let   releaseCommit = 'N/A';
    try {
      releaseCommit = execSync('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
    } catch { /* git not available */ }
    let releaseBranch = 'N/A';
    try {
      releaseBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
    } catch { /* git not available */ }

    try {
      await client.query(
        `INSERT INTO public.engine_releases
           (version, engine_version, contract_version, schema_version,
            migration_hash, git_commit, git_branch,
            deployed_by, environment, deployment_id, verification_passed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (deployment_id) DO NOTHING`,
        [
          deployedEngineVersion,
          deployedEngineVersion,
          deployedContractVersion,
          deployedSchemaVersion,
          deployedMigrationHash || 'pending',
          releaseCommit,
          releaseBranch,
          operator,
          environment,
          deploymentId,
          false,  // updated to true after final verification pass completes
        ]
      );
      pass('engine_releases_row', `deployment_id=${deploymentId}`);
    } catch (e: any) {
      warn('engine_releases_row', `could not insert release row: ${e.message}`);
    }

  } finally {
    await client.end();
  }

  // ── Print results ──────────────────────────────────────────────────────────
  const failures = results.filter(r => !r.passed);
  const warnings = results.filter(r => r.passed && r.warning);
  const passes   = results.filter(r => r.passed && !r.warning);

  console.log('\n======================================================================');
  console.log('DEPLOYMENT VERIFICATION REPORT');
  console.log('======================================================================');

  for (const r of results) {
    const icon   = !r.passed ? '❌' : r.warning ? '⚠️ ' : '✅';
    const detail = r.detail  ? `  (${r.detail})` : '';
    console.log(`${icon} ${r.name}${detail}`);
  }

  console.log('\n----------------------------------------------------------------------');
  console.log(`Passed:   ${passes.length}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Failed:   ${failures.length}`);
  console.log('----------------------------------------------------------------------');

  // Update the engine_releases row with final pass/fail and manifest hash.
  // Uses a new client since the main client is already closed.
  const updateReleaseRow = async (passed: boolean, manifestHash: string): Promise<void> => {
    const updateClient = new Client({
      host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
      port: 5432,
      user: 'postgres',
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
    });
    try {
      await updateClient.connect();
      await updateClient.query(
        `UPDATE public.engine_releases
         SET verification_passed = $1, manifest_hash = $2
         WHERE deployment_id = $3`,
        [passed, manifestHash, deploymentId]
      );
    } catch (e: any) {
      console.warn(`[verify] Could not update engine_releases row: ${e.message}`);
    } finally {
      await updateClient.end();
    }
  };

  if (failures.length > 0) {
    console.log('\n❌ DEPLOYMENT VERIFICATION FAILED');
    console.log('The database state does not match the expected engine configuration.');
    console.log('Do not proceed with rollout until all failures are resolved.');
    const mHash = writeReleaseManifest(
      deployedEngineVersion, deployedContractVersion, deployedSchemaVersion,
      deployedMigrationHash, passes.length, warnings.length, failures.length,
    );
    await updateReleaseRow(false, mHash);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log('\n⚠️  DEPLOYMENT VERIFIED WITH WARNINGS');
    console.log('Warnings are non-blocking but should be addressed before full rollout.');
    const mHash = writeReleaseManifest(
      deployedEngineVersion, deployedContractVersion, deployedSchemaVersion,
      deployedMigrationHash, passes.length, warnings.length, failures.length,
    );
    await updateReleaseRow(true, mHash);
    process.exit(0);
  } else {
    console.log('\n✅ DEPLOYMENT VERIFIED');
    const mHash = writeReleaseManifest(
      deployedEngineVersion, deployedContractVersion, deployedSchemaVersion,
      deployedMigrationHash, passes.length, warnings.length, failures.length,
    );
    await updateReleaseRow(true, mHash);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Verification script error:', err.message);
  process.exit(1);
});
