/**
 * Release Evidence Collector
 *
 * Assembles the Phase 2 evidence package into releases/evidence/YYYY-MM-DD_v{version}/
 *
 * Immutability model:
 *   - The first run collects automatic artifacts and checks for manual files.
 *   - If all files are present, it writes INDEX.json and seals the package by
 *     creating a COMPLETE sentinel file containing the package hash.
 *   - Once COMPLETE exists, the directory is frozen. Re-running this script on
 *     an already-sealed package exits with an error and instructions to create
 *     a revision directory (e.g. 2026-08-02_v1.0.0-rev1/) for corrections.
 *   - The package hash (SHA-256 of all file contents in sorted filename order)
 *     gives the directory an identity. Any modification after sealing changes
 *     the hash, making tampering detectable.
 *
 * Automatic artifacts (collected from DB and repo):
 *   release_manifest.json      — latest manifest from releases/
 *   governance_audit.json      — last entry from audit_history.json
 *   engine_releases_row.json   — current row from engine_releases table
 *   engine_metadata_row.json   — current row from current_engine_version()
 *
 * Manual artifacts (operator places before sealing):
 *   deployment_verification.txt  — console output of verify_deployment.ts
 *   contract_tests.txt           — console output of contract_tests.sql
 *   regression_results.txt       — console output of position_engine_validation.sql
 *   load_test_summary.txt        — load test results with P50/P95/P99 latencies
 *   rollback_rehearsal.txt       — output confirming rollback executed on staging
 *
 * Usage:
 *   npx ts-node scripts/collect_release_evidence.ts
 *
 * Environment variables:
 *   SUPABASE_DB_PASSWORD   — database password (or prompted)
 *   DEPLOY_ENV             — production | staging | local (default: local)
 */

import { Client } from 'pg';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── File lists ────────────────────────────────────────────────────────────────

const AUTOMATIC_FILES = [
  'release_manifest.json',
  'governance_audit.json',
  'engine_releases_row.json',
  'engine_metadata_row.json',
];

const MANUAL_FILES = [
  'deployment_verification.txt',
  'contract_tests.txt',
  'regression_results.txt',
  'load_test_summary.txt',
  'rollback_rehearsal.txt',
];

const ALL_FILES = [...AUTOMATIC_FILES, ...MANUAL_FILES];

// ─── Package hash ──────────────────────────────────────────────────────────────
// SHA-256 of: for each file in ALL_FILES (sorted), feed filename + ':' + contents.
// INDEX.json is excluded from the hash so the index can record the hash without
// creating a circular dependency. COMPLETE is also excluded.

function computePackageHash(dir: string): string {
  const hasher = createHash('sha256');
  for (const file of ALL_FILES) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      const contents = fs.readFileSync(filePath, 'utf8');
      hasher.update(`${file}:${contents}`);
    }
  }
  return hasher.digest('hex');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const getPassword = (): Promise<string> => {
    if (process.env.SUPABASE_DB_PASSWORD) return Promise.resolve(process.env.SUPABASE_DB_PASSWORD);
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

  try {
    await client.connect();

    // ── Fetch database rows ───────────────────────────────────────────────────
    const releaseRow  = await client.query(
      `SELECT * FROM public.engine_releases ORDER BY deployed_at DESC LIMIT 1`
    );
    const metadataRow = await client.query(
      `SELECT * FROM public.current_engine_version()`
    );

    if (releaseRow.rows.length === 0) {
      console.error('❌ No engine_releases row found. Run verify_deployment.ts first.');
      process.exit(1);
    }

    const release     = releaseRow.rows[0];
    const metadata    = metadataRow.rows[0];
    const version     = release.engine_version ?? '1.0.0';
    const environment = process.env.DEPLOY_ENV ?? release.environment ?? 'local';
    const today       = new Date().toISOString().slice(0, 10);
    const dirName     = `${today}_v${version}`;
    const evidenceDir = path.resolve(process.cwd(), 'releases', 'evidence', dirName);
    const completePath = path.join(evidenceDir, 'COMPLETE');

    // ── Immutability guard ────────────────────────────────────────────────────
    // If the package is already sealed, refuse to modify it.
    if (fs.existsSync(completePath)) {
      const seal = fs.readFileSync(completePath, 'utf8');
      console.error('');
      console.error('❌ This evidence package is already sealed.');
      console.error(`   Location: releases/evidence/${dirName}/`);
      console.error(`   Sealed:   ${seal.trim()}`);
      console.error('');
      console.error('To issue a correction, create a new revision directory:');
      console.error(`   releases/evidence/${dirName}-rev1/`);
      console.error('Then re-run this script with a distinct DEPLOY_ENV or by');
      console.error('temporarily renaming the directory target in this script.');
      process.exit(1);
    }

    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }

    console.log(`\nCollecting release evidence into: releases/evidence/${dirName}/\n`);

    // ── Write automatic artifacts ─────────────────────────────────────────────
    fs.writeFileSync(
      path.join(evidenceDir, 'engine_releases_row.json'),
      JSON.stringify(release, null, 2),
    );
    console.log('✅ engine_releases_row.json');

    fs.writeFileSync(
      path.join(evidenceDir, 'engine_metadata_row.json'),
      JSON.stringify(metadata, null, 2),
    );
    console.log('✅ engine_metadata_row.json');

    // Latest release manifest for this environment
    const releasesDir = path.resolve(process.cwd(), 'releases');
    const manifests   = fs.readdirSync(releasesDir)
      .filter(f => f.endsWith('.json') && f.includes(environment))
      .sort()
      .reverse();
    if (manifests.length > 0) {
      fs.copyFileSync(
        path.join(releasesDir, manifests[0]),
        path.join(evidenceDir, 'release_manifest.json'),
      );
      console.log(`✅ release_manifest.json  (from ${manifests[0]})`);
    } else {
      console.warn('⚠️  No release manifest found for environment:', environment);
    }

    // Last governance audit entry
    const auditPath = path.resolve(process.cwd(), 'database_v2', 'docs', 'audit_history.json');
    if (fs.existsSync(auditPath)) {
      const history   = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      const lastEntry = history[history.length - 1];
      fs.writeFileSync(
        path.join(evidenceDir, 'governance_audit.json'),
        JSON.stringify(lastEntry, null, 2),
      );
      console.log(`✅ governance_audit.json  (status: ${lastEntry?.status ?? 'unknown'})`);
    } else {
      console.warn('⚠️  audit_history.json not found');
    }

    // ── Check manual files ────────────────────────────────────────────────────
    console.log('\nChecking for manually placed files:');
    const missing: string[] = [];
    for (const file of MANUAL_FILES) {
      if (fs.existsSync(path.join(evidenceDir, file))) {
        console.log(`✅ ${file}`);
      } else {
        console.log(`❌ ${file}  — MISSING`);
        missing.push(file);
      }
    }

    // ── Write INDEX.json (always refreshed until sealed) ─────────────────────
    const packageHash = missing.length === 0 ? computePackageHash(evidenceDir) : '';
    const index = {
      release:             dirName,
      version,
      environment,
      collected_at:        new Date().toISOString(),
      engine_version:      release.engine_version,
      contract_version:    release.contract_version,
      schema_version:      release.schema_version,
      migration_hash:      release.migration_hash,
      manifest_hash:       release.manifest_hash,
      git_commit:          release.git_commit,
      git_branch:          release.git_branch,
      deployed_by:         release.deployed_by,
      deployed_at:         release.deployed_at,
      verification_passed: release.verification_passed,
      package_hash:        packageHash || null,
      package_hash_algorithm: packageHash ? 'sha256' : null,
      files: { automatic: AUTOMATIC_FILES, manual: MANUAL_FILES, missing },
      complete:            missing.length === 0,
    };

    fs.writeFileSync(path.join(evidenceDir, 'INDEX.json'), JSON.stringify(index, null, 2));
    console.log('\n✅ INDEX.json written');

    // ── Print summary ─────────────────────────────────────────────────────────
    console.log('\n======================================================================');
    console.log(`Release: v${version}  |  Environment: ${environment}`);
    console.log(`Commit:  ${String(release.git_commit ?? 'N/A').slice(0, 12)}  |  Branch: ${release.git_branch ?? 'N/A'}`);
    console.log(`Migration hash: ${release.migration_hash ?? 'N/A'}`);
    console.log(`Manifest hash:  ${String(release.manifest_hash ?? 'N/A').slice(0, 16)}`);
    console.log('======================================================================');

    if (missing.length > 0) {
      console.log(`\n⚠️  Evidence package INCOMPLETE — ${missing.length} file(s) missing:`);
      for (const f of missing) console.log(`   • ${f}`);
      console.log(`\nPlace the missing files in: releases/evidence/${dirName}/`);
      console.log('Then re-run this script to seal the package.');
      process.exit(0);
    }

    // ── Seal the package ──────────────────────────────────────────────────────
    // Write the COMPLETE sentinel containing the package hash and timestamp.
    // After this point the directory must not be modified.
    const sealContent = [
      `sealed_at: ${new Date().toISOString()}`,
      `package_hash: ${packageHash}`,
      `package_hash_algorithm: sha256`,
      `version: ${version}`,
      `environment: ${environment}`,
      '',
      'This evidence package is sealed. Do not modify any files in this directory.',
      'To issue a correction, create a revision directory:',
      `  releases/evidence/${dirName}-rev1/`,
    ].join('\n');

    fs.writeFileSync(completePath, sealContent);

    console.log(`\nPackage hash: ${packageHash.slice(0, 32)}...`);
    console.log(`\n✅ Evidence package SEALED`);
    console.log(`   Location: releases/evidence/${dirName}/`);
    console.log(`   Sentinel: releases/evidence/${dirName}/COMPLETE`);
    console.log('\nPhase 2 is complete. You may begin Phase 3 (Operational Qualification).');
    process.exit(0);

  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Evidence collection error:', err.message);
  process.exit(1);
});
