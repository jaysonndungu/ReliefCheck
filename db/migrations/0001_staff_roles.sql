-- 0001_staff_roles.sql — US01 staff auth foundation (ai.md §2, §3, §9).
-- PROPOSED: Jayson coordinates migration numbering (ai.md §15.3); renumber before merge if needed.
-- Run with the migration role, never with the request-handler role.

BEGIN;

CREATE SCHEMA IF NOT EXISTS relief;

-- Keep the private schema out of the Supabase Data API roles.
REVOKE ALL ON SCHEMA relief FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA relief FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA relief FROM authenticated';
  END IF;
END
$$;

-- Future objects created by the migration role start with no public access.
ALTER DEFAULT PRIVILEGES IN SCHEMA relief REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA relief REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA relief REVOKE ALL ON SEQUENCES FROM PUBLIC;

-- Staff roles are bootstrapped out of band for known Supabase Auth user IDs.
-- There is no self-assignment path: the API only ever reads this table.
CREATE TABLE relief.staff_roles (
  user_id    uuid        PRIMARY KEY,
  role       text        NOT NULL CHECK (role IN ('developer', 'admin')),
  enabled    boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON relief.staff_roles FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON relief.staff_roles FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON relief.staff_roles FROM authenticated';
  END IF;
END
$$;

-- Defense in depth only; server-side checks remain mandatory (ai.md §2).
ALTER TABLE relief.staff_roles ENABLE ROW LEVEL SECURITY;

-- The restricted request-handler role (name agreed with the team, e.g. reliefcheck_app)
-- receives read-only access in the deployment runbook:
--   GRANT USAGE ON SCHEMA relief TO reliefcheck_app;
--   GRANT SELECT ON relief.staff_roles TO reliefcheck_app;
--   CREATE POLICY staff_roles_app_read ON relief.staff_roles FOR SELECT TO reliefcheck_app USING (true);

COMMIT;
