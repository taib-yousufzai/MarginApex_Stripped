-- Migration: Add history_reset_at to public.profiles
-- Allows clearing historical trading records without touching financial transactions or balances.

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS history_reset_at timestamptz DEFAULT NULL;
