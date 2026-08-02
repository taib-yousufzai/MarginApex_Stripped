/**
 * EngineClient
 *
 * Single gateway for all Position Engine RPC calls. Every call to a financial
 * RPC (place_order_v2, close_position_v2, apply_carry_charges_v1,
 * convert_position_v1) must pass through here.
 *
 * Responsibilities:
 *  1. Auto-attach correlation_id, engine_version, and contract_version to
 *     every call — callers supply none of this context manually.
 *  2. Record latency and success/failure to rpc_metrics via an in-process
 *     buffer (flushed every FLUSH_INTERVAL_MS or when BUFFER_MAX is reached).
 *     Metric writes are never on the critical path and never affect callers.
 *  3. Optionally write to financial_events journal after a successful RPC —
 *     asynchronous, never inside the transaction, never able to affect
 *     trade execution.
 *  4. Surface a typed, consistent error interface for RPC failures.
 *
 * Design constraints:
 *  - Metric / journal failures MUST NOT propagate to callers.
 *  - Buffering is in-process only. On process restart, any unflushed metrics
 *    are dropped — this is acceptable; they are observability data, not
 *    financial records.
 */

import { randomUUID } from 'crypto';
import { getAdminClient } from '@/lib/adminClient';

// ─── Version constants ────────────────────────────────────────────────────────
// Bumped in lockstep with DATABASE_CONTRACT.md and audit_policy.json.
// Never mutate these without a corresponding versioned RPC (e.g. place_order_v3).
const ENGINE_VERSION   = '1.0.0';
const CONTRACT_VERSION = '1.0.0';

// ─── Metrics buffer ───────────────────────────────────────────────────────────
// Accumulates metric rows and flushes in a single INSERT to avoid one DB round-
// trip per execution. Under sustained trading load (e.g. 50 req/s) this reduces
// metric INSERT rate from ~50/s to ~1 every 5 seconds.
const BUFFER_MAX        = 50;    // flush when this many rows accumulate
const FLUSH_INTERVAL_MS = 5_000; // flush on this interval regardless of fill level
const FLUSH_RETRY_DELAY = 200;   // ms before a single retry on transient failure

interface MetricRow {
  rpc_name:         string;
  latency_ms:       number;
  success:          boolean;
  error_code:       string | null;
  rows_affected:    number;
  user_id:          string | null;
  correlation_id:   string;
  engine_version:   string;
  contract_version: string;
}

let metricBuffer: MetricRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushMetrics();
  }, FLUSH_INTERVAL_MS);
}

function flushMetrics(): void {
  if (metricBuffer.length === 0) return;

  const rows = metricBuffer.splice(0, metricBuffer.length);
  const admin = getAdminClient();

  admin
    .from('rpc_metrics')
    .insert(rows)
    .then(({ error }) => {
      if (!error) return;
      // One retry after a short delay to recover from transient DB hiccups.
      // If the retry also fails, log a warning and discard — metrics must
      // never block or slow down trading.
      setTimeout(() => {
        admin
          .from('rpc_metrics')
          .insert(rows)
          .then(({ error: retryError }) => {
            if (retryError) {
              console.warn(
                `[EngineClient] rpc_metrics flush failed after retry (${rows.length} rows dropped):`,
                retryError.message,
              );
            }
          });
      }, FLUSH_RETRY_DELAY);
    });
}

function bufferMetric(row: MetricRow): void {
  metricBuffer.push(row);
  if (metricBuffer.length >= BUFFER_MAX) {
    // Flush immediately without waiting for the timer
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushMetrics();
  } else {
    scheduleFlush();
  }
}

// ─── Journal writer ───────────────────────────────────────────────────────────
// The financial_events table is an operational audit trail — not the ledger.
// Writes are async, outside the RPC transaction, and best-effort.
// A missing journal entry is acceptable; a journal failure affecting trade
// execution is not.

export interface JournalEvent {
  /** e.g. ORDER_PLACED, POSITION_OPENED, POSITION_CLOSED, CARRY_CHARGED */
  event_type:       string;
  correlation_id:   string;
  user_id:          string;
  /** Raw payload — whatever the caller deems relevant for debugging */
  payload:          Record<string, unknown>;
}

function writeJournalEvent(event: JournalEvent): void {
  const admin = getAdminClient();
  admin
    .from('financial_events')
    .insert({
      event_type:       event.event_type,
      correlation_id:   event.correlation_id,
      user_id:          event.user_id,
      engine_version:   ENGINE_VERSION,
      contract_version: CONTRACT_VERSION,
      payload:          event.payload,
    })
    .then(({ error }) => {
      if (error) {
        console.warn('[EngineClient] financial_events write failed (non-critical):', error.message);
      }
    });
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EngineCallOptions {
  /** User ID for metric attribution and journal writes. */
  userId?: string;
  /**
   * Optional journal event to write after a successful RPC call.
   * Omit if this call does not represent a named financial event.
   * The correlation_id is injected automatically; do not include it in payload.
   */
  journalEvent?: Omit<JournalEvent, 'correlation_id' | 'user_id'>;
}

/**
 * Calls an approved Position Engine RPC with automatic correlation tagging,
 * buffered telemetry, and optional async journal write.
 *
 * @param rpcName  - Approved RPC name (must be in audit_policy.json approved_gateways).
 * @param args     - Argument object passed directly to supabase .rpc().
 * @param options  - Optional userId for attribution and journalEvent for audit trail.
 * @returns        - The RPC data payload on success.
 * @throws         - Error with the database error message on failure.
 */
export async function callEngineRpc<T = unknown>(
  rpcName:  string,
  args:     Record<string, unknown>,
  options:  EngineCallOptions | string = {},  // string form kept for back-compat with userId-only callers
): Promise<T> {
  // Support legacy callEngineRpc(rpc, args, userId) signature
  const opts: EngineCallOptions = typeof options === 'string' ? { userId: options } : options;

  const admin          = getAdminClient();
  const correlationId  = randomUUID();
  const start          = Date.now();
  let   success        = false;
  let   errorCode: string | undefined;

  try {
    const { data, error } = await admin.rpc(rpcName, args);

    if (error) {
      errorCode = error.code ?? 'UNKNOWN';
      throw new Error(error.message || `${rpcName} failed.`);
    }

    success = true;

    // Write journal event asynchronously after confirmed success
    if (opts.journalEvent && opts.userId) {
      writeJournalEvent({
        ...opts.journalEvent,
        correlation_id: correlationId,
        user_id:        opts.userId,
      });
    }

    return data as T;
  } finally {
    bufferMetric({
      rpc_name:         rpcName,
      latency_ms:       Date.now() - start,
      success,
      error_code:       errorCode ?? null,
      rows_affected:    0,
      user_id:          opts.userId ?? null,
      correlation_id:   correlationId,
      engine_version:   ENGINE_VERSION,
      contract_version: CONTRACT_VERSION,
    });
  }
}

/**
 * Returns the current engine and contract versions.
 * Useful for health-check endpoints and shadow mode comparison tagging.
 */
export function getEngineVersions(): { engineVersion: string; contractVersion: string } {
  return { engineVersion: ENGINE_VERSION, contractVersion: CONTRACT_VERSION };
}
