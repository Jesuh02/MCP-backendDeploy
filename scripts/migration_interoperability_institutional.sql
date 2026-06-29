-- Institutional interoperability MVP for CourseV.
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS interoperability_learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  institution_id text,
  user_id bigint,
  role text,
  course_id bigint,
  module_id text,
  lesson_id text,
  event_type text NOT NULL,
  event_source text NOT NULL DEFAULT 'coursev_web',
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  standard_target text NOT NULL DEFAULT 'internal',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interop_events_tenant_created
  ON interoperability_learning_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interop_events_target
  ON interoperability_learning_events (tenant_id, standard_target, event_type);

CREATE TABLE IF NOT EXISTS interoperability_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  standard_code text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'success',
  actor_user_id bigint,
  summary text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interop_logs_tenant_created
  ON interoperability_action_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interop_logs_standard
  ON interoperability_action_logs (tenant_id, standard_code, status);

CREATE TABLE IF NOT EXISTS interoperability_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  standard_code text NOT NULL,
  item_key text NOT NULL,
  label text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, standard_code, item_key)
);

CREATE TABLE IF NOT EXISTS interoperability_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  standard_code text NOT NULL,
  institution_id text,
  status text NOT NULL DEFAULT 'pending',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at timestamptz,
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, standard_code)
);

CREATE INDEX IF NOT EXISTS idx_interop_connections_tenant
  ON interoperability_connections (tenant_id, standard_code);
