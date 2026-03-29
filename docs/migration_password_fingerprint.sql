-- Migration: Add password_fingerprint column to usuarios table
-- Run this script in BOTH Supabase projects via the SQL Editor:
--   1. QA-Develop:  https://supabase.com/dashboard/project/vxuksizvwrkctrvpciyp
--   2. Incat:       https://supabase.com/dashboard/project/gzckzrocfmhsizlrnqep
--
-- Purpose: Stores a per-user HMAC-SHA256 fingerprint of the plain-text password
-- (keyed with PASSWORD_FINGERPRINT_PEPPER env var) so that the backend can detect
-- duplicate passwords across ALL tenant databases without exposing the actual hash.
-- This column is write-once on registration and never read by the client.

-- Add the column if it does not already exist
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS password_fingerprint TEXT DEFAULT NULL;

-- Index to make uniqueness lookups fast (O(log n) instead of O(n))
CREATE INDEX IF NOT EXISTS idx_usuarios_password_fingerprint
    ON usuarios (password_fingerprint)
    WHERE password_fingerprint IS NOT NULL;

-- Optional: enforce uniqueness at DB level as a second safety net
-- (uncomment only after backfilling existing rows, to avoid constraint violations)
-- ALTER TABLE usuarios
--     ADD CONSTRAINT uq_usuarios_password_fingerprint
--     UNIQUE (password_fingerprint);
