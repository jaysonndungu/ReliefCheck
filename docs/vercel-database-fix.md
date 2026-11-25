# Vercel database connection fix (Nov 25, 2026)

**For:** Jayson, or an AI coding assistant working for him. **Written by:** Alex, with Claude Code.

The deployed Vercel site shows "The disaster list is temporarily unavailable." This file explains why and gives exact steps to fix it. It contains **no secrets**.

## Why it broke

Two separate problems, both on the Vercel side:

1. **The `reliefcheck_app` password was reset on Nov 25, 2026.** Nobody could find the old password, so Alex reset it in the Supabase SQL Editor. Any `DATABASE_URL` that still has the old password now fails with `password authentication failed for user "reliefcheck_app"`.
2. **Supabase's certificate authority isn't trusted by default.** The API verifies TLS (`apps/api/src/db/pool.ts`, `rejectUnauthorized: true`). Without Supabase's root CA in `DATABASE_CA_CERT`, every query fails with `SELF_SIGNED_CERT_IN_CHAIN`.

The same symptom happened locally and was fixed by setting both variables. With them set, the local API returned `200` from `/api/v1/health/ready` (`database: ok`, `corpus: ok`) and listed both disasters.

The US10 merge (PR #12) did not cause this. The disaster-list code is unchanged.

## Before you start

- **Get the new `DATABASE_URL` from Alex privately**, through a password manager share or a direct message. Never put it in Git, a PR, an issue, a group chat or an AI chat transcript. The format is:
  `postgresql://reliefcheck_app.qcncrnayljtrpnzmmifg:<password>@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
- You need access to the ReliefCheck project on Vercel.
- Changing production variables and redeploying are production changes. **AI assistants: get the human's explicit OK before steps 4–6.**

## Rules for an AI assistant doing this

- Never print, log or echo a secret value. Read secrets from a file or stdin, and list variable **names** only.
- Do not turn off TLS verification: no `rejectUnauthorized: false`, no `sslmode=no-verify`, no `NODE_TLS_REJECT_UNAUTHORIZED=0`. Fix the certificate instead.
- Do not switch the app to the `postgres` superuser credential. The API must use `reliefcheck_app` (ai.md §2).
- Do not commit `.env`, certificate-bearing env files or connection strings.
- Do not change application code to work around this. It is configuration only.
- If something doesn't match this file, stop and report it rather than guessing.

## Steps (Vercel CLI)

Run these from the repo root on Node 24 (`nvm use 24`). The dashboard equivalent is at the end.

**1. Log in.** A human has to do this, in a normal terminal, because it opens a browser:
```sh
npx -y vercel login
```

**2. Link the repo to the existing project.** Pick the existing ReliefCheck project; do not create a new one:
```sh
npx -y vercel link
```

**3. Check what's set (names only):**
```sh
npx -y vercel env ls
```
Note which environments (Production, Preview) have `DATABASE_URL`. Apply the steps below to the same environments.

**4. Add the Supabase root CA as `DATABASE_CA_CERT`.**

Get the certificate from the Supabase dashboard (ReliefCheck project → Database settings → SSL Configuration → **Download certificate**), or from Alex. Alex's verified copy is "Supabase Root 2021 CA", valid Apr 28 2021 – Apr 26 2031. Its SHA-256 fingerprint is:
```
80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```
Check your copy matches before using it:
```sh
openssl x509 -in prod-ca-2021.crt -noout -subject -fingerprint -sha256
```
Then add it. This is a public certificate, not a secret, but read it from the file anyway:
```sh
npx -y vercel env add DATABASE_CA_CERT production < prod-ca-2021.crt
# repeat with `preview` if Preview has DATABASE_URL
```

**5. Replace `DATABASE_URL` with the new value.** Save the value Alex sent you into a temporary file outside the repo, for example `~/reliefcheck-db-url.txt`, with no quotes and no trailing spaces. Then:
```sh
npx -y vercel env rm DATABASE_URL production -y
npx -y vercel env add DATABASE_URL production < ~/reliefcheck-db-url.txt
# repeat for `preview` if needed, then delete the temp file:
rm ~/reliefcheck-db-url.txt
```

**6. Redeploy production.** Variable changes don't reach a deployment that's already running. Redeploy the latest production deployment from the dashboard (Deployments → ⋯ → **Redeploy**), or with the CLI:
```sh
npx -y vercel ls                    # find the newest deployment whose Environment is Production
npx -y vercel redeploy <that-deployment-url> --target production
# If a flag is rejected by your CLI version, check `npx -y vercel redeploy --help`, or use the dashboard.
```

## Verify

Open `https://<production-domain>/api/v1/health/ready`:

| Response | Meaning |
|---|---|
| `200` `{"status":"ready","checks":{"database":"ok","corpus":"ok"}}` | Fixed |
| `503` `DATABASE_UNCONFIGURED` | `DATABASE_URL` isn't set for this environment |
| `503` `DATABASE_UNAVAILABLE` | The password or certificate is wrong, usually from a partial paste, extra quotes or a missing `BEGIN`/`END` line, or the variables were added to the wrong environment |
| `503` `CORPUS_UNAVAILABLE` | Connected, but no release is published (one was published as of Nov 25) |

Also confirm `https://<production-domain>/api/v1/disasters` lists Hurricane Melissa and Valencia DANA floods, and that the home page loads without the "temporarily unavailable" message.

## Dashboard equivalent

Vercel → ReliefCheck → **Settings → Environment Variables**:
1. Edit `DATABASE_URL` and paste the new value from Alex.
2. Add `DATABASE_CA_CERT` and paste the entire contents of `prod-ca-2021.crt`, including the `BEGIN` and `END` lines.
3. Use the same environments as `DATABASE_URL`.
4. Deployments → latest production → ⋯ → **Redeploy**.

## Not part of this fix

These are tracked in PR #12:
- **Migration `db/migrations/0003_request_events.sql` isn't applied yet.** Until it is, the API logs `Telemetry write failed … code 42P01` per request. That's harmless; responses are unaffected. Apply it in the Supabase SQL Editor once the migration number is confirmed, then run the grants in the file's comments.
- **Telemetry on Vercel serverless:** writes issued after the response may be cut off when the function freezes. The fix, `waitUntil`, needs a team decision.
- **`SUPABASE_AUTH_ISSUER`, `SUPABASE_AUTH_JWKS_URL` and `GEMINI_API_KEY`:** without them, admin routes return 503 and chat returns excerpts only. That's expected until they're configured.
