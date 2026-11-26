-- 0004_usage_log_retention.sql — US12 bounded usage-log retention.
-- Run with the migration role. The application performs only bounded, oldest-first deletes.

BEGIN;

GRANT DELETE ON relief.request_events TO reliefcheck_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reliefcheck_app') THEN
    EXECUTE 'CREATE POLICY request_events_app_delete ON relief.request_events FOR DELETE TO reliefcheck_app USING (true)';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

COMMIT;
