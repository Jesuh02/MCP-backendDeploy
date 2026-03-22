-- Migration: Outbox Pattern table for reliable event delivery
-- Ensures domain events survive process crashes and are delivered at-least-once.

CREATE TABLE IF NOT EXISTS public.outbox_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type   text NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}',
    status       text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processed', 'failed')),
    attempts     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    error        text
);

-- Index for the processor polling query (pending events ordered by creation)
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
    ON public.outbox_events (status, created_at)
    WHERE status = 'pending';
