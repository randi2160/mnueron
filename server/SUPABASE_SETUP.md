# Supabase setup for mnueron

This is the 15-minute path from "no database yet" to "schema deployed, server connected, your first org and API token created." Free tier the whole way.

## 1. Create the Supabase project (2 min)

1. Go to https://supabase.com and sign up (GitHub or email)
2. Click **New project**
3. **Name:** `mnueron` (or `engrama` / whatever you settled on)
4. **Database password:** generate a strong one, copy it to a password manager — you'll need it for the connection string
5. **Region:** pick the one closest to you (`us-east-1` if you're in Florida)
6. **Plan:** Free
7. Wait ~2 min while Supabase provisions

## 2. Enable the `vector` extension (30 sec)

1. Left sidebar → **Database** → **Extensions**
2. Search "vector"
3. Toggle the `vector` extension **on**

`pgcrypto` and `citext` are already enabled on Supabase, no action needed.

## 3. Apply the schema (1 min)

1. Left sidebar → **SQL Editor** → **New query**
2. Open `server/supabase_schema.sql` from this repo
3. Paste the entire contents into the SQL Editor
4. Click **Run** (or Ctrl+Enter)
5. You should see "Success. No rows returned" — all tables, indexes, RLS policies, and the signup helper are now live

Verify:
- Left sidebar → **Database** → **Tables** — you should see `orgs`, `users`, `memories`, `namespaces`, `api_tokens`, `observations`, `imports`, `audit_log`

## 4. Create your first org + API token (2 min)

The schema includes a helper function `mnueron_signup`. You'll generate an API token locally first, hash it, then call the function with the hash. Supabase only ever stores the hash.

**On your laptop, in PowerShell:**

```powershell
# Generate a random token. Save the RAW value somewhere safe — it's shown once.
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$raw = "mn_" + [Convert]::ToHexString($bytes).ToLower()
$prefix = $raw.Substring(0, 8)

# Hash it (SHA-256, hex)
$sha = [Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
$hash = [Convert]::ToHexString($hashBytes).ToLower()

Write-Host "RAW (save this, you'll only see it once):"
Write-Host "  $raw"
Write-Host "PREFIX: $prefix"
Write-Host "HASH:   $hash"
```

**Back in the Supabase SQL Editor**, replacing the placeholders with your values:

```sql
SELECT * FROM mnueron_signup(
  'you@example.com',
  'Your Name',
  'personal',
  'Personal',
  '<PREFIX from PowerShell>',
  '<HASH from PowerShell>',
  'laptop'
);
```

You'll get back `org_id`, `user_id`, `token_id`. Save the `org_id` — you'll need it when the server starts.

## 5. Get the connection string (1 min)

1. Left sidebar → **Project Settings** → **Database**
2. Scroll to **Connection string** section
3. Choose **URI** mode
4. Enable **"Use connection pooler"** toggle (port 6543, not 5432 — important for serverless and for Windows where direct connections sometimes get rate-limited)
5. Copy the string. It looks like:

   ```
   postgresql://postgres.xxxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

6. Replace `[YOUR-PASSWORD]` with the database password you set in step 1

## 6. Run the mnueron server (2 min)

In `server/index.ts`, the only thing you need is the `DATABASE_URL`. Create a `.env` file in the `server/` directory:

```bash
# server/.env
DATABASE_URL=postgresql://postgres.xxx:yourpass@aws-0-us-east-1.pooler.supabase.com:6543/postgres
OPENAI_API_KEY=sk-...                    # optional, omit to fall back to BM25 only
PORT=3111
```

Install runtime deps:

```powershell
cd server
npm install express pg dotenv @types/pg @types/express
```

Add to the top of `server/index.ts`:

```ts
import 'dotenv/config';
```

Run:

```powershell
npx tsx index.ts
```

You should see: `mnueron-server listening on :3111`

## 7. Point the MCP client at the hosted server (1 min)

On any machine you want using your hosted memory — laptop, desktop, work — open the `claude_desktop_config.json` and set the env vars on the mnueron block:

```json
{
  "mcpServers": {
    "mnueron": {
      "command": "node",
      "args": ["C:\\path\\to\\mnueron\\dist\\index.js"],
      "env": {
        "MNUERON_API_URL": "https://your-server-hostname",
        "MNUERON_API_TOKEN": "mn_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The same MCP client now writes/reads from Supabase instead of local SQLite, scoped to your org by the token.

## 8. (Later) Deploy the server

For now you can run `server/index.ts` on your laptop with the URL being `http://localhost:3111`. That works on one machine.

To use it from **any computer**, you need to host the server somewhere with a public URL. Three options ordered by cost/effort:

- **Lightsail $5/mo Node container** — same shape as Elevizio's deployment, you already know this
- **Railway** ~$5/mo, no DevOps, deploy from GitHub in 2 minutes
- **Fly.io** $1.94/mo for a tiny VM, slightly more setup
- **Render** free tier (spins down after inactivity) or $7/mo for always-on

For a personal mnueron deployment you use across machines, Railway is the easiest. Push the repo, link Supabase env vars, you have an HTTPS URL in under 5 minutes.

## Troubleshooting

- **"relation memories does not exist"** — the schema didn't apply. Re-run in SQL Editor; check that you're connected to the right database.
- **"vector type does not exist"** — the `vector` extension didn't enable. Database → Extensions → toggle it on, then re-run the schema.
- **RLS returns zero rows even though data exists** — the server didn't set `app.current_org_id` before the query. Check the `withTenantScope` helper in `server/index.ts` is being used on every query.
- **Connection times out** — make sure you're using the pooler URL (port 6543), not the direct connection (port 5432). Direct connections have a low session limit on free tier.

## What this gets you

- Multi-machine access: connect from anywhere, no security group whitelisting
- Free tier supports your dev work indefinitely (just remember the 7-day pause)
- pgvector included — your embeddings live in the same database as your data
- HIPAA-eligible infrastructure when you're ready to ask for the BAA (Team plan and up)
- One bill, one dashboard, one place to back up

Cost trajectory:
- Now → first launch: $0
- First 100 users: $0 still (Pro $25/mo when you upgrade to avoid the inactivity pause)
- 1K users: $25/mo Pro + maybe $10 compute add-on
- 10K users: ~$200/mo Supabase + your own LLM/embedding costs separately
