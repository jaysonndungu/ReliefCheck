# ReliefCheck hosting runbook (US01)

This runbook covers hosted access: one free Render web service with Supabase Free for the database and staff auth. Every account stays on its free plan. Don't enter a credit card, start a paid trial or enable add-ons (ai.md §1 invariant 9). Alex coordinates deployment and config (ai.md §15.3).

Status as of November 6, 2026: no Render or Supabase project exists yet. Steps 1–6 have not been run.

## 1. Supabase project

1. Create a free Supabase project. Note its project ref, for example `abcd1234`.
2. **Auth → Providers:** turn off public sign-ups. Staff accounts are created by hand in step 4.
3. **Auth → JWT signing keys:** make sure the project signs with an asymmetric key (ES256 or RS256). The API trusts only keys from the JWKS endpoint and rejects HS256 shared-secret tokens.
4. Write down these values for Render:
   - `SUPABASE_AUTH_ISSUER` = `https://<ref>.supabase.co/auth/v1`
   - `SUPABASE_AUTH_JWKS_URL` = `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`

## 2. Database roles and migration

Use two credentials. The migration role (the project's `postgres` user) applies migrations. A restricted application role is used only by the API. Never give the migration credential to Render.

```sql
-- Run as the migration role in the Supabase SQL editor, after applying db/migrations/*.sql in order.
CREATE ROLE reliefcheck_app LOGIN PASSWORD '<generate a long random password>';
GRANT USAGE ON SCHEMA relief TO reliefcheck_app;
GRANT SELECT ON relief.staff_roles TO reliefcheck_app;
CREATE POLICY staff_roles_app_read ON relief.staff_roles FOR SELECT TO reliefcheck_app USING (true);
```

Apply `db/migrations/0001_staff_roles.sql` first. Jayson coordinates migration numbers, so confirm the number before applying it to a shared project. Later stories grant `reliefcheck_app` the specific table operations they need.

`DATABASE_URL` for Render is the **session pooler** connection string (Supabase → Connect), using `reliefcheck_app` as the user. It looks like `postgresql://reliefcheck_app.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`. The API verifies TLS. If verification fails, download the Supabase CA certificate (Database settings → SSL) and paste the PEM into `DATABASE_CA_CERT`. Don't turn off verification.

## 3. Render web service

1. Create a free Render account and connect it to the GitHub repo.
2. **New → Blueprint** and select `render.yaml`. It defines one `free` web service. Don't add a Render Postgres database.
3. Enter the four `sync: false` values from steps 1–2 when Render asks for them.
4. Deploy. The build runs `npm ci && npm run build && npm run check:bundle`. The secret check fails the build if a server-only value reaches the browser bundle.

`autoDeploy` is off. Deploy from the Render dashboard after a reviewed merge to `main`.

## 4. Staff accounts (out of band)

1. Supabase → Auth → Users → **Add user** with each teammate's email and a temporary password. Free outbound email isn't needed.
2. Copy the user's UUID and add the role as the migration role:

```sql
INSERT INTO relief.staff_roles (user_id, role) VALUES ('<auth user uuid>', 'developer');
-- Use 'admin' only for teammates who publish, clear, reload or roll back.
-- Disable instead of deleting: UPDATE relief.staff_roles SET enabled = false, updated_at = now() WHERE user_id = '...';
```

The API never writes to this table, and nobody can assign themselves a role.

## 5. Verify the deployment

Replace `$URL` with the Render URL, for example `https://reliefcheck.onrender.com`.

| Check | Expected |
| --- | --- |
| Open `$URL` in a desktop browser and at phone width | Navigation shows all four sections, and the status shows **API connected** |
| `curl $URL/api/v1/health/live` | `200 {"status":"ok"}` |
| `curl -i $URL/api/v1/health/ready` | `503 CORPUS_UNAVAILABLE` until a release is published, or `DATABASE_UNAVAILABLE` if the DB is paused |
| `curl -i $URL/api/v1/admin/me` | `401 UNAUTHENTICATED` |
| `/admin/me` with a staff bearer token | `200` with the verified role |
| `/admin/me` with a verified non-staff user | `403 FORBIDDEN` |
| Open `$URL/compare` directly | The app loads (SPA deep link) |

## 6. Free-tier behavior and demo readiness

- Render free services sleep after 15 idle minutes. The first visit afterwards can take about a minute. The page shows **Waking up**, keeps retrying, and has a **Retry now** button.
- Supabase Free pauses inactive projects. Readiness then reports `DATABASE_UNAVAILABLE`. Resume the project from the Supabase dashboard.
- Before a demo, open the site and check step 5 by hand. Don't set up keep-alive pings or fake traffic to get around idle policies (ai.md §2).
- Check Render build minutes, bandwidth and instance hours, plus Supabase database and storage use, before the demo.

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `PORT` | Set by Render | Listening port |
| `NODE_VERSION` | `render.yaml` | Pins Node 24.22.2, matching `.node-version` |
| `DATABASE_URL` | Render secret | Session pooler URL for `reliefcheck_app` |
| `DATABASE_CA_CERT` | Render secret (optional) | PEM CA for the database TLS chain |
| `SUPABASE_AUTH_ISSUER` | Render secret | JWT `iss` the API accepts |
| `SUPABASE_AUTH_JWKS_URL` | Render secret | HTTPS JWKS used to verify staff JWTs |

None of these may use a `VITE_` prefix, and none may appear in the client bundle.
