-- Migration: Drop Orphaned Functions
-- Drops functions that are no longer used by the application or any database triggers.

-- 1. Drop parse_option_symbol (Logic has been entirely moved to TypeScript)
DROP FUNCTION IF EXISTS public.parse_option_symbol(text);

-- 2. Drop rebaseline_profile_balances (One-off script no longer needed)
DROP FUNCTION IF EXISTS public.rebaseline_profile_balances();

-- 3. Drop cleanup_expired_otps (Legacy authentication artifact)
DROP FUNCTION IF EXISTS public.cleanup_expired_otps();
