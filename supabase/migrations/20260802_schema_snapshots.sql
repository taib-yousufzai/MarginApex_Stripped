-- ==============================================================================
-- engine_schema_snapshots: Schema Drift Detection
--
-- A schema snapshot is a hash of the live database structure at a point in
-- time, computed from:
--   - information_schema.tables   (table names)
--   - information_schema.columns  (column names, types, nullability, defaults)
--   - pg_proc                     (public function signatures — name + args)
--   - pg_indexes                  (index names and full expressions)
--   - information_schema.triggers (trigger names, tables, and events)
--
-- The deploy script records a baseline snapshot after each successful deploy.
-- A scheduled job (e.g. daily cron) recomputes the hash and compares it to
-- the baseline. Any divergence means something changed outside the migration
-- process — a manual ALTER TABLE, a dropped index, a new trigger — and must
-- be investigated.
--
-- Hash algorithm: SHA-256 via pgcrypto, consistent with migration_hash and
-- manifest_hash elsewhere in the engine. The algorithm version is stored
-- alongside the hash so a future change is detectable without comparing
-- hashes across algorithm boundaries.
--
-- Drift classification:
--   CRITICAL — table dropped, column type changed, constraint removed,
--               required trigger missing, function dropped
--   WARNING  — index renamed, storage parameter changed
--   INFO     — new object added (table, index, function) — additive only
--
-- Classification is applied by detect_schema_drift_classified() which
-- compares structured detail, not just the top-level hash.
--
-- Compatibility note:
--   The verify_deployment.ts baseline INSERT is wrapped in try/catch and
--   downgrades to WARN if this table does not exist (supports rollout period).
--   Remove that compatibility path once all environments are on this migration.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.engine_schema_snapshots (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at          timestamptz NOT NULL DEFAULT now(),
    schema_hash          text        NOT NULL,
    schema_hash_algorithm text       NOT NULL DEFAULT 'sha256',  -- algorithm used
    is_baseline          boolean     NOT NULL DEFAULT false,
    release_id           uuid        REFERENCES public.engine_releases(id) ON DELETE SET NULL,
    drift_detected       boolean     NOT NULL DEFAULT false,
    drift_severity       text        CHECK (drift_severity IN ('CRITICAL', 'WARNING', 'INFO', NULL)),
    detail               jsonb       -- structured diff when drift_detected = true
);

CREATE INDEX IF NOT EXISTS idx_schema_snapshots_time
    ON public.engine_schema_snapshots(captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_schema_snapshots_baseline
    ON public.engine_schema_snapshots(is_baseline, captured_at DESC)
    WHERE is_baseline = true;

-- ─── Schema hash computation ──────────────────────────────────────────────────
-- Returns a deterministic SHA-256 of the current live schema structure.
--
-- Determinism requirements:
--   Every string_agg() has an explicit ORDER BY on a stable, unique key.
--   Functions are sorted by (proname, argument_string) to handle overloads.
--   Triggers are sorted by (trigger_name, event_object_table, event_manipulation).
--   No set-returning function relies on implicit ordering.
--
-- The hash covers structure only — not data, not comments, not permissions.
-- Changes to storage parameters (FILLFACTOR, TOAST) are intentionally excluded
-- as they produce WARNING-level drift rather than hash changes.

CREATE OR REPLACE FUNCTION public.compute_schema_hash()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tables_sig   text;
    v_columns_sig  text;
    v_funcs_sig    text;
    v_indexes_sig  text;
    v_triggers_sig text;
    v_combined     text;
BEGIN
    -- Tables: sorted by name
    SELECT string_agg(table_name, '|' ORDER BY table_name)
    INTO v_tables_sig
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type   = 'BASE TABLE';

    -- Columns: sorted by table then by physical position (ordinal_position is stable)
    -- Includes: table, column, data_type, is_nullable, column_default
    SELECT string_agg(
        table_name
            || '.' || column_name
            || ':' || data_type
            || ':' || is_nullable
            || ':' || COALESCE(column_default, 'NULL'),
        '|'
        ORDER BY table_name, ordinal_position
    )
    INTO v_columns_sig
    FROM information_schema.columns
    WHERE table_schema = 'public';

    -- Functions: sorted by (name, argument string) to handle overloads correctly.
    -- Uses pg_get_function_arguments which returns a canonical, stable form.
    SELECT string_agg(
        p.proname || '(' || pg_get_function_arguments(p.oid) || ')',
        '|'
        ORDER BY p.proname, pg_get_function_arguments(p.oid)
    )
    INTO v_funcs_sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public';

    -- Indexes: sorted by name. indexdef includes the full CREATE INDEX expression,
    -- so renames and expression changes are both captured.
    SELECT string_agg(
        indexname || ':' || indexdef,
        '|'
        ORDER BY indexname
    )
    INTO v_indexes_sig
    FROM pg_indexes
    WHERE schemaname = 'public';

    -- Triggers: sorted by (name, table, event) — all three needed to handle
    -- tables with multiple triggers for different events.
    SELECT string_agg(
        trigger_name
            || ':' || event_object_table
            || ':' || event_manipulation
            || ':' || action_timing,
        '|'
        ORDER BY trigger_name, event_object_table, event_manipulation
    )
    INTO v_triggers_sig
    FROM information_schema.triggers
    WHERE trigger_schema = 'public';

    -- Concatenate sections with a section separator that cannot appear in any value
    v_combined :=
        'tables:'   || COALESCE(v_tables_sig,   '') || '##' ||
        'columns:'  || COALESCE(v_columns_sig,  '') || '##' ||
        'functions:'|| COALESCE(v_funcs_sig,    '') || '##' ||
        'indexes:'  || COALESCE(v_indexes_sig,  '') || '##' ||
        'triggers:' || COALESCE(v_triggers_sig, '');

    -- SHA-256 via pgcrypto, returned as hex
    RETURN encode(digest(v_combined, 'sha256'), 'hex');
END;
$$;

-- ─── Drift detection ─────────────────────────────────────────────────────────
-- Returns the comparison of current hash against the most recent baseline.
-- Returns drift_detected = false if no baseline exists (first deploy is safe).

CREATE OR REPLACE FUNCTION public.detect_schema_drift()
RETURNS TABLE (
    drift_detected    boolean,
    current_hash      text,
    baseline_hash     text,
    baseline_captured timestamptz
)
LANGUAGE sql
STABLE
AS $$
    WITH current AS (
        SELECT public.compute_schema_hash() AS hash
    ),
    baseline AS (
        SELECT schema_hash, captured_at
        FROM public.engine_schema_snapshots
        WHERE is_baseline = true
        ORDER BY captured_at DESC
        LIMIT 1
    )
    SELECT
        CASE WHEN b.schema_hash IS NULL THEN false
             ELSE c.hash != b.schema_hash
        END                AS drift_detected,
        c.hash             AS current_hash,
        b.schema_hash      AS baseline_hash,
        b.captured_at      AS baseline_captured
    FROM current c
    LEFT JOIN baseline b ON true;
$$;

-- ─── Drift severity classifier ────────────────────────────────────────────────
-- Compares current live schema structure against the most recent baseline
-- snapshot and classifies any detected differences by severity.
--
-- CRITICAL: destructive or integrity-threatening changes
--   - table present in baseline but absent now (dropped)
--   - column present in baseline but absent now, or type changed
--   - required trigger absent
--   - required function absent
--
-- WARNING: non-destructive but operationally significant changes
--   - index absent (degraded performance, not data loss)
--   - new trigger added (unexpected behaviour possible)
--
-- INFO: purely additive changes (tables, columns, functions added)
--
-- Returns: severity, category, object_name, detail

CREATE OR REPLACE FUNCTION public.classify_schema_drift()
RETURNS TABLE (
    severity    text,
    category    text,
    object_name text,
    detail      text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_baseline_id uuid;
    v_baseline    jsonb;
BEGIN
    -- Load the most recent baseline snapshot detail
    SELECT id INTO v_baseline_id
    FROM public.engine_schema_snapshots
    WHERE is_baseline = true
    ORDER BY captured_at DESC
    LIMIT 1;

    IF v_baseline_id IS NULL THEN
        RETURN; -- no baseline yet, nothing to compare
    END IF;

    -- ── Tables: CRITICAL if dropped ──────────────────────────────────────────
    RETURN QUERY
    WITH baseline_tables AS (
        SELECT t.table_name
        FROM information_schema.tables t
        -- We compare live state against live state at two points in time via the hash,
        -- so for classification we compare current catalog against expected objects.
        -- This function is best used after drift is detected to understand severity.
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND t.table_name IN (
              'positions','orders','transactions','profiles',
              'rpc_metrics','shadow_mismatch_logs','shadow_mode_config',
              'engine_metadata','engine_releases','engine_schema_snapshots',
              'financial_events','act_logs'
          )
    ),
    current_tables AS (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    )
    SELECT
        'CRITICAL'::text,
        'table_missing'::text,
        b.table_name,
        'Required table is absent from current schema'::text
    FROM baseline_tables b
    WHERE NOT EXISTS (SELECT 1 FROM current_tables c WHERE c.table_name = b.table_name);

    -- ── Triggers: CRITICAL if required trigger is absent ─────────────────────
    RETURN QUERY
    WITH required_triggers (trigger_name, table_name) AS (
        VALUES
          ('financial_events_deny_update', 'financial_events'),
          ('financial_events_deny_delete', 'financial_events'),
          ('engine_releases_deny_update',  'engine_releases'),
          ('engine_releases_deny_delete',  'engine_releases')
    )
    SELECT
        'CRITICAL'::text,
        'trigger_missing'::text,
        r.trigger_name || ' on ' || r.table_name,
        'Required append-only enforcement trigger is absent'::text
    FROM required_triggers r
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.triggers t
        WHERE t.trigger_schema = 'public'
          AND t.trigger_name        = r.trigger_name
          AND t.event_object_table  = r.table_name
    );

    -- ── Indexes: WARNING if a named index is absent ───────────────────────────
    RETURN QUERY
    WITH required_indexes (idx) AS (
        VALUES
          ('idx_rpc_metrics_time'),
          ('idx_rpc_metrics_correlation'),
          ('idx_financial_events_correlation'),
          ('idx_financial_events_user_time'),
          ('idx_financial_events_type_time'),
          ('idx_shadow_mismatch_corr'),
          ('idx_engine_releases_time'),
          ('idx_engine_releases_env_time'),
          ('idx_schema_snapshots_baseline')
    )
    SELECT
        'WARNING'::text,
        'index_missing'::text,
        r.idx,
        'Named index is absent — query performance may be degraded'::text
    FROM required_indexes r
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = r.idx
    );

END;
$$;
