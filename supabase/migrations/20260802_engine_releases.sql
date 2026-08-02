-- ==============================================================================
-- engine_releases: Deployment Identity Table
--
-- Every deployment inserts exactly one row. This table is the canonical answer
-- to "what was running on production at time T?"
--
-- Unlike engine_metadata (a single mutable row updated per deploy), this table
-- is append-only — one immutable row per deployment event. That means you can
-- reconstruct the complete deployment history, not just the current state.
--
-- Query patterns:
--   Current deployment:
--     SELECT * FROM engine_releases ORDER BY deployed_at DESC LIMIT 1;
--
--   What was deployed on a specific date:
--     SELECT * FROM engine_releases
--     WHERE deployed_at <= '2026-08-14 23:59:59'
--     ORDER BY deployed_at DESC LIMIT 1;
--
--   All production deployments:
--     SELECT * FROM engine_releases WHERE environment = 'production'
--     ORDER BY deployed_at DESC;
--
-- The manifest_hash links this row to the corresponding file in releases/.
-- The schema_hash links to the schema snapshot in engine_schema_snapshots.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.engine_releases (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    version          text        NOT NULL,          -- e.g. '1.0.0'
    engine_version   text        NOT NULL,
    contract_version text        NOT NULL,
    schema_version   text        NOT NULL,
    migration_hash   text        NOT NULL,
    schema_hash      text,                          -- populated by schema drift job
    git_commit       text        NOT NULL,
    git_branch       text,
    manifest_hash    text,                          -- links to releases/<filename>.json
    deployed_at      timestamptz NOT NULL DEFAULT now(),
    deployed_by      text        NOT NULL,          -- operator or CI workflow
    environment      text        NOT NULL,          -- production | staging | local
    deployment_id    text        NOT NULL UNIQUE,   -- idempotency: one row per pipeline run
    verification_passed boolean  NOT NULL DEFAULT false,
    notes            text                           -- optional human annotation
);

-- Lookup by time (most common query: what was running at T?)
CREATE INDEX IF NOT EXISTS idx_engine_releases_time
    ON public.engine_releases(deployed_at DESC);

-- Lookup by environment + time
CREATE INDEX IF NOT EXISTS idx_engine_releases_env_time
    ON public.engine_releases(environment, deployed_at DESC);

-- Lookup by deployment_id (idempotency check)
CREATE INDEX IF NOT EXISTS idx_engine_releases_deploy_id
    ON public.engine_releases(deployment_id);

-- ─── Append-only enforcement ──────────────────────────────────────────────────
-- Deployment history must not be editable after the fact.

CREATE OR REPLACE FUNCTION public.engine_releases_deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'engine_releases is append-only. UPDATE and DELETE are not permitted.';
END;
$$;

CREATE TRIGGER engine_releases_deny_update
    BEFORE UPDATE ON public.engine_releases
    FOR EACH ROW EXECUTE FUNCTION public.engine_releases_deny_mutation();

CREATE TRIGGER engine_releases_deny_delete
    BEFORE DELETE ON public.engine_releases
    FOR EACH ROW EXECUTE FUNCTION public.engine_releases_deny_mutation();
