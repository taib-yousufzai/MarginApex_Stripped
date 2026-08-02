-- ==============================================================================
-- Engine Metadata Table
--
-- Single-row table that records the deployed engine state. The TypeScript layer
-- reads this on startup (or on each request in dev) to verify it is talking to
-- the database version it was compiled against.
--
-- Versions are bumped manually in lockstep:
--   engine_version    — position engine logic version (place_order_v2, etc.)
--   contract_version  — RPC interface version (parameter shapes, return types)
--   schema_version    — database schema version (table/column changes)
--
-- ─── Compatibility policy ─────────────────────────────────────────────────────
-- Engine minor versions are backward-compatible within the same major version:
--
--   Engine 1.x  supports  Contract 1.0, 1.1, 1.2 ... 1.x
--   Engine 2.x  supports  Contract 2.x only
--
-- A TypeScript client built against contract_version 1.0 may talk to any
-- Engine 1.x database. It MUST NOT be deployed against an Engine 2.x database
-- without a coordinated upgrade.
--
-- Patch versions (1.0.1) are reserved for bug fixes with no API surface change.
-- Any parameter rename, return-type change, or error-message change requires
-- a minor version bump (1.1) and a new contract_tests_v1_1.sql file.
-- Any breaking change requires a major version bump (2.0) and a new RPC
-- (e.g. place_order_v3).
--
-- ─── migration_hash ───────────────────────────────────────────────────────────
-- Populated by verify_deployment.ts after all migrations run.
-- SHA-256 of: for each migration file (sorted by name):
--   filename + ':' + file_size_bytes + ':' + file_contents
-- Hashing contents (not just filenames) means a silently modified migration
-- produces a different hash even if its name is unchanged.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.engine_metadata (
    id                   integer     PRIMARY KEY DEFAULT 1,
    engine_version       text        NOT NULL DEFAULT '1.0.0',
    contract_version     text        NOT NULL DEFAULT '1.0.0',
    schema_version       text        NOT NULL DEFAULT '1.0.0',
    migration_hash       text,
    deployment_timestamp timestamptz NOT NULL DEFAULT now(),
    deployed_by          text,

    -- Enforce single-row constraint
    CONSTRAINT engine_metadata_single_row CHECK (id = 1)
);

-- Seed the initial row
INSERT INTO public.engine_metadata (id, engine_version, contract_version, schema_version)
VALUES (1, '1.0.0', '1.0.0', '1.0.0')
ON CONFLICT (id) DO NOTHING;

-- ─── Convenience function ─────────────────────────────────────────────────────
-- Allows: SELECT * FROM current_engine_version();
-- Returns a single row with all version fields.

CREATE OR REPLACE FUNCTION public.current_engine_version()
RETURNS TABLE (
    engine_version       text,
    contract_version     text,
    schema_version       text,
    migration_hash       text,
    deployment_timestamp timestamptz
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        engine_version,
        contract_version,
        schema_version,
        migration_hash,
        deployment_timestamp
    FROM public.engine_metadata
    WHERE id = 1;
$$;
