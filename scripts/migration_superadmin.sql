
-- 1. Realign roles.id sequence before inserting new roles.
SELECT setval(
  pg_get_serial_sequence('public.roles', 'id'),
  COALESCE((SELECT MAX(id) FROM public.roles), 1),
  true
);

-- 2. Insert superadmin role (level 4, highest privileges)
-- Use a conditional insert to avoid both PK and unique-name conflicts.
INSERT INTO public.roles (nombre, nivel, "default", created_at)
SELECT 'superadmin', 4, false, now()
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE nombre = 'superadmin');

-- 3. Add billing and suspension columns to institutions
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS payment_due_date timestamp with time zone,
  ADD COLUMN IF NOT EXISTS billing_cycle_type text,
  ADD COLUMN IF NOT EXISTS billing_cycle_day integer,
  ADD COLUMN IF NOT EXISTS billing_cycle_hour integer DEFAULT 8,
  ADD COLUMN IF NOT EXISTS is_suspended boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS monthly_price numeric(12,2) DEFAULT 0;

-- 4. Add payment_type to transactions table to distinguish course vs service payments.
--    'course'  = student buys access to a course (existing behaviour)
--    'service' = institution pays for platform usage (new)
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS payment_type text NOT NULL DEFAULT 'course',
  ADD COLUMN IF NOT EXISTS institution_id bigint,
  ADD COLUMN IF NOT EXISTS billing_period_start timestamp with time zone,
  ADD COLUMN IF NOT EXISTS billing_period_end timestamp with time zone,
  ADD COLUMN IF NOT EXISTS wompi_transaction_id text;

-- FK: institution_id → institutions.id (only for service payments)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'transactions_institution_fkey'
      AND table_name = 'transactions'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_institution_fkey
      FOREIGN KEY (institution_id) REFERENCES public.institutions(id);
  END IF;
END $$;

-- Indexes for service-payment queries
CREATE INDEX IF NOT EXISTS idx_transactions_payment_type ON public.transactions(payment_type);
CREATE INDEX IF NOT EXISTS idx_transactions_institution ON public.transactions(institution_id) WHERE institution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_institutions_payment_due ON public.institutions(payment_due_date) WHERE payment_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_institutions_suspended ON public.institutions(is_suspended) WHERE is_suspended = true;

-- 5. Drop the old institution_payments table if it exists (migrated into transactions)
DROP TABLE IF EXISTS public.institution_payments;
