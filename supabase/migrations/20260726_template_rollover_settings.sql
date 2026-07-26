-- ==============================================================================
-- MIGRATION: template_rollover_settings
-- Date: 2026-07-26
-- Description: Adds carry rollover configuration to account_templates and profiles
-- ==============================================================================

ALTER TABLE public.account_templates
ADD COLUMN IF NOT EXISTS carry_rollover_day text NOT NULL DEFAULT 'Sunday',
ADD COLUMN IF NOT EXISTS carry_rollover_time text NOT NULL DEFAULT '23:59';

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS carry_rollover_day text NOT NULL DEFAULT 'Sunday',
ADD COLUMN IF NOT EXISTS carry_rollover_time text NOT NULL DEFAULT '23:59',
ADD COLUMN IF NOT EXISTS last_carry_rollover timestamptz;
