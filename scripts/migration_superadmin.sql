-- ═══════════════════════════════════════════════════════════════════════
-- Migration: SuperAdmin (Role 4) + Institution Billing
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Insert superadmin role (level 4, highest privileges)
INSERT INTO public.roles (nombre, nivel, "default", created_at)
VALUES ('superadmin', 4, false, now())
ON CONFLICT (nombre) DO NOTHING;

-- 2. Add billing and suspension columns to institutions
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS payment_due_date timestamp with time zone,
  ADD COLUMN IF NOT EXISTS is_suspended boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS suspended_reason text;

-- 3. Create institution_payments table for tracking monthly billing
CREATE TABLE IF NOT EXISTS public.institution_payments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  institution_id bigint NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'COP',
  status text NOT NULL DEFAULT 'PENDING',
  payment_method text DEFAULT 'wompi',
  external_reference text,
  wompi_transaction_id text,
  paid_by_user_id bigint,
  billing_period_start timestamp with time zone,
  billing_period_end timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT institution_payments_pkey PRIMARY KEY (id),
  CONSTRAINT institution_payments_institution_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_institution_payments_institution ON public.institution_payments(institution_id);
CREATE INDEX IF NOT EXISTS idx_institution_payments_status ON public.institution_payments(status);
CREATE INDEX IF NOT EXISTS idx_institutions_payment_due ON public.institutions(payment_due_date) WHERE payment_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_institutions_suspended ON public.institutions(is_suspended) WHERE is_suspended = true;
