-- Migration: Add thumbnail_url column to subjects table
-- This column stores the URL of the subject thumbnail image

ALTER TABLE public.subjects
ADD COLUMN IF NOT EXISTS thumbnail_url text NULL;

COMMENT ON COLUMN public.subjects.thumbnail_url IS 'URL of the subject thumbnail image stored in R2/cloud storage';
