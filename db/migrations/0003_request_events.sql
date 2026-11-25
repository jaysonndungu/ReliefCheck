-- 0003_request_events.sql — US10 request instrumentation (ai.md §3, §10, §12).
-- PROPOSED: Jayson coordinates migration numbering (ai.md §15.3); renumber before merge if needed.
-- Shared with US12 usage logs (Anson): agree on the column list before either story merges.
-- Run with the migration role, never with the request-handler role.
--
-- Privacy contract: rows hold request METADATA only. There is deliberately no column for the
-- raw question, appeal text, submitted URL, request body, auth header, token, IP or session.

BEGIN;

CREATE TABLE relief.request_events (
  request_id     uuid        PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  -- Route template such as '/chat' or '/sources/:id', never the raw path or query string.
  endpoint       text        NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 100 AND endpoint ~ '^[A-Za-z0-9/:_.()-]+$'),
  method         text        NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS')),
  status_code    smallint    NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  -- Error envelope code (e.g. KB_CHANGED, CHAT_UNAVAILABLE); null on success.
  error_code     text        CHECK (char_length(error_code) BETWEEN 1 AND 64 AND error_code ~ '^[A-Z0-9_]+$'),
  latency_ms     integer     NOT NULL CHECK (latency_ms >= 0 AND latency_ms <= 600000),
  -- Per-stage durations, e.g. {"retrieve": 42, "generate": 1800}. Bounded size, integers only by convention.
  stage_timings  jsonb       CHECK (stage_timings IS NULL OR (jsonb_typeof(stage_timings) = 'object' AND pg_column_size(stage_timings) <= 1024)),
  mode           text        CHECK (mode IN ('factual', 'appeal_explanation', 'comparison')),
  -- Workflow outcome: chat answer status or appeal status. Distinguishes supported/partial/insufficient/degraded.
  outcome        text        CHECK (outcome IN (
                               'supported', 'partial', 'insufficient_evidence', 'extractive_fallback',
                               'documented_official_channel', 'published_warning_found')),
  retrieval_mode text        CHECK (retrieval_mode IN ('hybrid', 'lexical_only', 'registry')),
  -- Selected event: needed for the per-event counts in ai.md §12. Not personal data.
  disaster_id    uuid,
  release_id     uuid,
  epoch          integer     CHECK (epoch >= 0),
  -- Provider token usage when Gemini returns it. Bounded size.
  provider_usage jsonb       CHECK (provider_usage IS NULL OR (jsonb_typeof(provider_usage) = 'object' AND pg_column_size(provider_usage) <= 1024))
);
-- No foreign keys on disaster_id/release_id: telemetry must never fail or block because a
-- release was retired or garbage-collected, and logs outlive the records they mention.

CREATE INDEX request_events_occurred_at_idx ON relief.request_events (occurred_at DESC);
CREATE INDEX request_events_endpoint_time_idx ON relief.request_events (endpoint, occurred_at DESC);

REVOKE ALL ON relief.request_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON relief.request_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON relief.request_events FROM authenticated';
  END IF;
END
$$;

-- Defense in depth only; server-side admin checks remain mandatory (ai.md §2).
ALTER TABLE relief.request_events ENABLE ROW LEVEL SECURITY;

-- Grant the restricted request-handler role in the deployment runbook:
--   GRANT INSERT, SELECT ON relief.request_events TO reliefcheck_app;
--   CREATE POLICY request_events_app_insert ON relief.request_events FOR INSERT TO reliefcheck_app WITH CHECK (true);
--   CREATE POLICY request_events_app_read ON relief.request_events FOR SELECT TO reliefcheck_app USING (true);
-- 14-day retention (ai.md §10) is a bounded admin maintenance job (US12), which will need DELETE;
-- grant it in that story rather than here.

COMMIT;
