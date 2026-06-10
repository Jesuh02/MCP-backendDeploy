-- Adds explicit file metadata for AI-generated and uploaded content items.
-- Safe to run multiple times in each tenant database.

ALTER TABLE public.content_items
  ADD COLUMN IF NOT EXISTS file_uri text,
  ADD COLUMN IF NOT EXISTS file_name text;

