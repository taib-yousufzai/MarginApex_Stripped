import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { execSync } from 'child_process';

const POLICY_PATH = join(process.cwd(), 'database_v2', 'docs', 'audit_policy.json');
let policy: any = {};

if (existsSync(POLICY_PATH)) {
  policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8'));
} else {
  policy = {
    financial_columns: [],
    approved_files: [],
    allowlist: [],
    adr_references: {},
    approved_rpc_versions: [],
    approved_gateways: []
  };
}

interface Violation {
  id: number;
  file: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  mutationType: string;
  ruleViolated: string;
  adrReference: string;
  suggestedReplacement: string;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function scanDirectory(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    if (['node_modules', '.git', '.next', 'dist', 'build'].includes(file)) continue;
    if (statSync(filePath).isDirectory()) {
      scanDirectory(filePath, fileList);
    } else if (['.ts', '.tsx'].includes(extname(filePath))) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// Scans database_v2/rpc and database_v2/functions for unregistered RPC definitions.
// After Architecture Freeze, any new CREATE FUNCTION that is not in approved_rpc_versions
// must be caught and reviewed before it can be deployed.
function auditSqlContracts(currentId: number): { violations: Violation[]; nextId: number } {
  const violations: Violation[] = [];
  let id = currentId;
  const sqlDirs = [
    join(process.cwd(), 'database_v2', 'rpc'),
    join(process.cwd(), 'database_v2', 'functions'),
  ];

  for (const dir of sqlDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.sql'));
    for (const file of files) {
      const filePath = join(dir, file);
      const content = readFileSync(filePath, 'utf-8');
      // Match: CREATE OR REPLACE FUNCTION public.<name>
      const matches = content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi);
      for (const match of matches) {
        const fnName = match[1];
        // Internal helpers are not public-facing RPCs — skip them
        if (fnName.endsWith('_internal') || fnName.startsWith('assert_')) continue;
        const isRegistered = (policy.approved_rpc_versions || []).includes(fnName);
        if (!isRegistered) {
          violations.push({
            id: id++,
            file: filePath,
            severity: 'HIGH',
            mutationType: 'unregistered sql contract',
            ruleViolated: 'Architecture Freeze — Versioned SQL Contracts',
            adrReference: 'ADR-004: Versioned SQL Contracts',
            suggestedReplacement: `Add '${fnName}' to approved_rpc_versions in audit_policy.json with a companion ADR entry.`,
            reason: `SQL function '${fnName}' is not registered in the approved RPC contract list. All public engine functions must be explicitly versioned and approved.`,
            confidence: 'HIGH'
          });
        }
      }
    }
  }

  return { violations, nextId: id };
}

function auditFile(file: string, content: string, currentId: number): { violations: Violation[]; nextId: number } {
  const violations: Violation[] = [];
  let id = currentId;

  // 1. Direct Position Mutation
  if (/\.from\(['"]positions['"]\)\.(update|insert|delete)/i.test(content)) {
    violations.push({
      id: id++,
      file,
      severity: 'CRITICAL',
      mutationType: 'positions mutation',
      ruleViolated: 'Hard Financial Boundary',
      adrReference: policy.adr_references.positions || 'ADR Reference Missing',
      suggestedReplacement: 'PositionService.closePosition() -> close_position_v2',
      reason: 'Positions must transition exclusively through verified, versioned Position Engine RPCs.',
      confidence: 'HIGH'
    });
  }

  // 2. Direct Transaction Mutation
  if (/\.from\(['"]transactions['"]\)\.(update|insert|delete)/i.test(content)) {
    violations.push({
      id: id++,
      file,
      severity: 'CRITICAL',
      mutationType: 'transactions mutation',
      ruleViolated: 'Single Synchronous Transaction Orchestration',
      adrReference: policy.adr_references.transactions || 'ADR Reference Missing',
      suggestedReplacement: 'Submit transaction entries inside place_order_v2 or close_position_v2 transaction blocks.',
      reason: 'Bypasses the synchronous database ledger. Transactions must not be written to directly from TS.',
      confidence: 'HIGH'
    });
  }

  // 3. Direct Order Mutation
  if (/\.from\(['"]orders['"]\)\.(update|insert|delete)/i.test(content)) {
    violations.push({
      id: id++,
      file,
      severity: 'CRITICAL',
      mutationType: 'orders mutation',
      ruleViolated: 'Hard Financial Boundary',
      adrReference: policy.adr_references.orders || 'ADR Reference Missing',
      suggestedReplacement: 'ExecutionService.submitOrder() -> place_order_v2',
      reason: 'Bypasses the database position state validations. Orders must only be inserted inside place_order_v2.',
      confidence: 'HIGH'
    });
  }

  // 4. Direct Profile Mutations (Semantic checking for financial columns)
  const profileMatches = content.match(/\.from\(['"]profiles['"]\)\.update\(([\s\S]*?)\)/gi);
  if (profileMatches) {
    for (const match of profileMatches) {
      const containsFinancial = policy.financial_columns.some((col: string) => match.includes(col));
      const affectedCols = policy.financial_columns.filter((col: string) => match.includes(col));
      if (containsFinancial) {
        violations.push({
          id: id++,
          file,
          severity: 'CRITICAL',
          mutationType: `profiles mutation (financial columns: ${affectedCols.join(', ')})`,
          ruleViolated: 'Single Source of Financial Truth',
          adrReference: policy.adr_references.profiles || 'ADR Reference Missing',
          suggestedReplacement: 'Re-calculate balance modifications through transaction ledger sums inside position engine RPCs.',
          reason: 'Modifies profile balance columns outside pg transaction ledger sums. Bypasses Single Source of Truth.',
          confidence: 'HIGH'
        });
      } else {
        violations.push({
          id: id++,
          file,
          severity: 'LOW',
          mutationType: 'profiles metadata mutation',
          ruleViolated: 'Allowed - Metadata changes',
          adrReference: 'ADR-005: User Profile Scope',
          suggestedReplacement: 'No change required.',
          reason: 'Updates metadata / non-financial profile fields (avatar/name/phone).',
          confidence: 'HIGH'
        });
      }
    }
  }

  // 5. Gateway Whitelist verification (Checks all .rpc() calls)
  const rpcMatches = content.match(/\.rpc\(['"](\w+)['"]/g);
  if (rpcMatches) {
    for (const match of rpcMatches) {
      const rpcNameMatch = match.match(/\.rpc\(['"](\w+)['"]/);
      if (rpcNameMatch) {
        const rpcName = rpcNameMatch[1];
        // If it targets financial tables (orders/positions/carry) but is not in approved gateways list
        const isFinancialRpc = rpcName.includes('order') || rpcName.includes('position') || rpcName.includes('carry');
        const isApproved = policy.approved_gateways.includes(rpcName);
        if (isFinancialRpc && !isApproved) {
          violations.push({
            id: id++,
            file,
            severity: 'HIGH',
            mutationType: 'unapproved financial gateway rpc call',
            ruleViolated: 'Approved Gateways Compliance',
            adrReference: 'ADR-004: Versioned SQL Contracts',
            suggestedReplacement: `Replace legacy '${rpcName}' call with approved v2 contract gateway.`,
            reason: `Bypasses the versioned API contract. The gateway '${rpcName}' is not in the approved whitelist.`,
            confidence: 'HIGH'
          });
        }
      }
    }
  }

  // 6. Trigger bypass or compatibility override check
  if (/SET\s+app\.is_v2/i.test(content) || /is_legacy/i.test(content)) {
    violations.push({
      id: id++,
      file,
      severity: 'MEDIUM',
      mutationType: 'engine bypass override',
      ruleViolated: 'Engine-First Development',
      adrReference: 'ADR-006: Strangler Fig Transition',
      suggestedReplacement: 'Establish migration paths using shadow mode parity rather than bypass overrides.',
      reason: 'Bypass controls and legacy flags must be actively monitored and audited.',
      confidence: 'MEDIUM'
    });
  }

  return { violations, nextId: id };
}

function runAudit() {
  console.log('======================================================================');
  console.log('RUNNING GOVERNANCE COMPLIANCE & FINANCIAL BOUNDARY AUDIT...');
  console.log(`Policy Version:         ${policy.policy_version || '1.0.0'}`);
  console.log(`Engine Compatibility:   v${policy.compatible_engine_version || '1.0.0'}`);
  console.log(`Contract Compatibility: v${policy.compatible_contract_version || '1.0.0'}`);
  console.log('======================================================================');

  const files = scanDirectory(process.cwd());
  let violationId = 1;
  const allViolations: Violation[] = [];

  for (const file of files) {
    const isApproved = (policy.approved_files || []).some((app: string) => file.endsWith(app));
    if (isApproved) continue;

    const content = readFileSync(file, 'utf-8');
    const { violations, nextId } = auditFile(file, content, violationId);
    allViolations.push(...violations);
    violationId = nextId;
  }

  // SQL Contract Freeze Audit: detect unregistered RPCs in database_v2/
  const { violations: sqlViolations, nextId: sqlNextId } = auditSqlContracts(violationId);
  allViolations.push(...sqlViolations);
  violationId = sqlNextId;

  // Apply allowlist filters
  const activeViolations = allViolations.filter(v => {
    const isAllowed = (policy.allowlist || []).some((al: any) => v.file.endsWith(al.file));
    return !isAllowed;
  });

  const criticals = activeViolations.filter(v => v.severity === 'CRITICAL');
  const highs = activeViolations.filter(v => v.severity === 'HIGH');
  const mediums = activeViolations.filter(v => v.severity === 'MEDIUM');
  const lows = activeViolations.filter(v => v.severity === 'LOW');

  // Print Violations
  for (const v of activeViolations) {
    console.log(`\nViolation #${v.id}`);
    console.log(`----------------------------------------------------------------------`);
    console.log(`File:                  ${v.file}`);
    console.log(`Severity:              ${v.severity}`);
    console.log(`Confidence:            ${v.confidence}`);
    console.log(`Mutation Type:         ${v.mutationType}`);
    console.log(`Rule Violated:         ${v.ruleViolated}`);
    console.log(`ADR Reference:         ${v.adrReference}`);
    console.log(`Suggested Replacement: ${v.suggestedReplacement}`);
    console.log(`Reason:                ${v.reason}`);
  }

  // Print scorecard
  console.log('\n======================================================================');
  console.log('ARCHITECTURAL SCORECARD SUMMARY');
  console.log('======================================================================');
  console.log(`Critical Financial Violations: ${criticals.length}`);
  console.log(`High Severity Legacy RPCs:   ${highs.length}`);
  console.log(`Medium Severity Bypasses:     ${mediums.length}`);
  console.log(`Low Severity Mutations:       ${lows.length}`);
  console.log(`CI Status:                    ${(criticals.length === 0 && highs.length === 0) ? '✅ PASS' : '❌ FAIL'}`);
  console.log('======================================================================');

  // Git Tamper-Evident Metadata Extraction
  let commitHash = 'N/A';
  let branchName = 'N/A';
  let commitAuthor = 'N/A';
  try {
    commitHash = execSync('git rev-parse --short HEAD').toString().trim();
    branchName = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    commitAuthor = execSync('git log -1 --pretty=format:"%an"').toString().trim();
  } catch {
    // Fail-safe if git not installed
  }

  // Store historical audit log
  const logPath = join(process.cwd(), 'database_v2', 'docs', 'audit_history.json');
  let history: any[] = [];
  if (existsSync(logPath)) {
    try {
      history = JSON.parse(readFileSync(logPath, 'utf-8'));
    } catch {
      history = [];
    }
  }

  history.push({
    timestamp: new Date().toISOString(),
    commit: commitHash,
    branch: branchName,
    author: commitAuthor,
    audit_version: '1.3.0',
    policy_version: policy.policy_version || '1.0.0',
    compatible_engine_version: policy.compatible_engine_version || '1.0.0',
    compatible_contract_version: policy.compatible_contract_version || '1.0.0',
    critical: criticals.length,
    high: highs.length,
    medium: mediums.length,
    low: lows.length,
    status: (criticals.length === 0 && highs.length === 0) ? 'PASS' : 'FAIL'
  });

  writeFileSync(logPath, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`Historical audit run logged to: ${logPath}`);

  if (criticals.length > 0 || highs.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAudit();
