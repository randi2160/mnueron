# mnueron hosted backend

The multi-tenant Postgres-backed memory service. Runs the same MCP tool
contract as the local SQLite store, just over HTTP with per-org isolation
enforced by Postgres Row-Level Security — and now with email + password
sign-up / login so users can self-provision.

## Stack

- **Postgres 15+** with extensions: `vector` (pgvector), `pgcrypto`, `citext`
- **Node 20+** with Express
- **bcryptjs** for password hashing
- **Optional:** Redis for the job queue, BullMQ for workers (for async
  embedding + summarization at scale)

## Setup

```bash
# 1. Create the database (skip if using Supabase — see SUPABASE_SETUP.md)
createdb mnueron

# 2. Install pgvector
sudo apt install postgresql-15-pgvector
# or build from source: https://github.com/pgvector/pgvector

# 3. Apply the schema
psql $DATABASE_URL < server/schema.sql
# or, on Supabase:
psql $DATABASE_URL < server/supabase_schema.sql

# 4. Install runtime deps (we now ship a real package.json here)
cd server
npm install

# 5. Run
DATABASE_URL=postgres://localhost:5432/mnueron \
ADMIN_DATABASE_URL=postgres://postgres:secret@localhost:5432/mnueron \
OPENAI_API_KEY=sk-... \
npx tsx index.ts
```

The server listens on `:3111` by default. Healthcheck at `GET /health`.

### Two connection strings, on purpose

| Variable | Used for | Postgres role |
| --- | --- | --- |
| `DATABASE_URL` | App requests (`/v1/memories`, `/v1/namespaces`, etc.) | restricted (`mnueron_app` / `authenticated`) — RLS scopes by org |
| `ADMIN_DATABASE_URL` | Auth endpoints that write to `users` / `orgs` / `api_tokens` | privileged (Supabase service_role; or the migration user) |

If unset, `ADMIN_DATABASE_URL` falls back to `DATABASE_URL`. Fine for local
dev. On Supabase, set `ADMIN_DATABASE_URL` to the service-role pooler URL.

## Sign-up and login

Two flavors:

### Web (humans)

- `GET /signup` — renders `auth.html` in sign-up mode
- `GET /login`  — same page, login mode

The page POSTs to `/v1/auth/signup` or `/v1/auth/login` and on success
displays the raw API token once. The user copies it into the Chrome
extension's Options page (or the `MNUERON_API_KEY` env var for the SDK).

### API (programmatic)

```bash
# Sign up
curl -X POST http://localhost:3111/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery","name":"Alice"}'
# → { user, org, token: { raw: "mnu_...", id, prefix, created_at } }

# Log in (issues a fresh token each time)
curl -X POST http://localhost:3111/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery"}'
# → same shape

# Whoami
curl http://localhost:3111/v1/auth/me \
  -H 'Authorization: Bearer mnu_...'

# List your tokens (returns metadata only — hashes never leave the DB)
curl http://localhost:3111/v1/auth/tokens -H 'Authorization: Bearer mnu_...'

# Create a new named token (for CI, a second machine, etc.)
curl -X POST http://localhost:3111/v1/auth/tokens \
  -H 'Authorization: Bearer mnu_...' \
  -H 'Content-Type: application/json' \
  -d '{"name":"ci"}'

# Revoke a token
curl -X DELETE http://localhost:3111/v1/auth/tokens/<token_id> \
  -H 'Authorization: Bearer mnu_...'
```

### Security notes

- Passwords are hashed with bcrypt (cost 10; configurable via `BCRYPT_ROUNDS`).
- Tokens are random 32-byte values prefixed `mnu_`, stored as SHA-256 hashes.
  Plaintext token is returned to the client exactly once at issuance.
- Sign-up and login use generic error messages so an attacker can't probe
  which emails are registered.
- Token rotation: log in again to get a fresh token; delete old ones via
  `DELETE /v1/auth/tokens/:id`. (Token expiry / refresh-token flow is a v2
  add — see the missing-features list at the bottom.)

## Migrating an existing deployment

If you previously applied `schema.sql` or `supabase_schema.sql`, re-running
either is safe — both now include `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
or `CREATE TABLE IF NOT EXISTS` so the new columns
(`password_hash`, `email_verified_at`, `last_login_at`) add without breaking
existing rows. Pre-existing users will have `password_hash = NULL` and can't
log in until you reset their password manually (a `/v1/auth/reset` endpoint
is a v2 todo).

## Deploy paths

- **Cheap first pass:** AWS Lightsail $20–40/mo for the Node app + RDS
  Postgres db.t4g.small (~$35/mo). Easy to provision, easy to monitor.
- **Production posture:** ECS Fargate behind ALB for the API, RDS Postgres
  with a read replica, ElastiCache Redis for the queue, S3 for raw
  observation blobs. Adds ~$200–400/mo over Lightsail at low scale; pays off
  past ~1K active users when autoscaling matters.
- **Supabase:** the easiest start. See `SUPABASE_SETUP.md` for a 15-minute
  walkthrough.

## What's still missing (in order of importance)

1. **Worker pool for async embedding** — currently the write path computes
   the embedding inline. Move to a queue so writes return in <50ms.
2. **Email verification + password reset** — `/v1/auth/verify`, `/v1/auth/reset`.
   Needs an email-sending service (Resend, Postmark, SES).
3. **OAuth providers** — Google / GitHub sign-in via Supabase Auth or a
   handcoded OAuth flow.
4. **Org switching + invitations** — `POST /v1/orgs`, `POST /v1/orgs/:id/invites`.
   The schema supports it; the endpoints don't exist yet.
5. **Secret redaction at ingest** — regex + entropy scanner before content
   touches storage.
6. **Rate limiting per org** — Redis-backed sliding window per token.
7. **Stripe billing webhook** — subscription state on the `orgs.plan` column.
8. **Hosted web dashboard** — port the local-only dashboard to call this API
   instead of the local SQLite, and put it behind the auth wall.

Each is a few hundred lines. The schema is already shaped to absorb them.

## License

Same as the parent — MIT for OSS pieces. The hosted commercial offering you
build with this code is yours; the source remains open.
