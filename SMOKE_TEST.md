# mnueron — smoke test for new-user flow

Internal checklist. Run this when you want to verify the install + signup
+ first-memory path end-to-end. Should take ~10 minutes.

## ✅ What I've already verified

- **npm**: `mnueron@0.3.0` is published. `dist.shasum` matches the registry.
- **PyPI**: `mnueron==0.3.1` is published. `pip install mnueron` works in
  a fresh venv. All exports import cleanly (`Mnueron`, `AsyncMnueron`,
  `Memory`, `Namespace`, `BulkSearchResult`, `WebhookEndpoint`,
  `MnueronError`, `verify_webhook_signature`).
- **HMAC verifier**: signature roundtrip is correct (`verify_webhook_signature`
  returns `True` for a known-good sig, `False` for tampered).

## 🧪 What to walk through on your machine

### 1. Fresh user signup

Open a private/incognito browser window so cookies don't carry.

1. Visit https://www.mnueron.com
2. Click "Sign up" (or whatever the CTA says)
3. Enter a throwaway email + password
4. Should redirect cleanly to `/dashboard`
5. Dashboard should say "0 memories" / empty state

**What I'm checking for**: the login redirect spinner fix from earlier
held — no infinite spinner; hard navigation to dashboard works on
first sign-in.

### 2. Issue an API token

1. From dashboard, navigate to Settings → API Tokens
   (or visit `/account-settings/tokens` directly)
2. Click "Create token"
3. Give it a name like "smoke-test"
4. Copy the `mnu_...` token immediately

### 3. Verify the hosted API responds

In a new PowerShell window (use the token you just copied):

```powershell
$token = "mnu_..."  # paste the real one

# Health probe
curl https://www.mnueron.com/api/health

# Save a memory
curl -Method POST `
     -Uri https://www.mnueron.com/api/memories `
     -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
     -Body '{"content":"smoke test memory","namespace":"smoke","tags":["test"]}'

# Search it back
curl -Uri "https://www.mnueron.com/api/memories?q=smoke&namespace=smoke" `
     -Headers @{ Authorization = "Bearer $token" }
```

Both the save and the search should return JSON with your memory. The
save returns the new `id`, `created_at`, etc. The search returns it
with a `score` field.

### 4. Verify the CLI works in local mode

```powershell
# In a fresh PowerShell — assume mnueron isn't installed
npm install -g mnueron
mnueron --version    # should print 0.3.0
mnueron setup --dry-run    # detect AI tools
```

The dry-run should list every AI tool it sees on your machine and
what it would write. Should NOT actually modify any files yet.

### 5. Save + recall via local CLI

```powershell
mnueron save "Local mode test memory" --ns smoke
mnueron search "test memory" --ns smoke
mnueron stats
```

The save should print a line confirming. The search should return
the memory you just saved. Stats should show 1 memory in namespace
"smoke".

### 6. Python SDK end-to-end

```powershell
pip install mnueron
$env:MNUERON_API_KEY = "mnu_..."   # the token from step 2

python -c "from mnueron import Mnueron;`
m = Mnueron();`
print(m.save('Python SDK smoke test', namespace='smoke').id);`
print([r.content for r in m.search('SDK smoke', namespace='smoke')])"
```

Should print a UUID followed by a list containing your memory.

### 7. Webhook delivery (optional)

If you want to verify webhooks end-to-end:

1. Set up an ephemeral receiver: https://webhook.site (free, gives you
   a random URL that captures POSTs)
2. Register it via the API or dashboard (`/api/webhooks`)
3. Save a memory — webhook should fire within a couple seconds
4. webhook.site shows the POST with HMAC signature header

## Cleanup after the test

Delete the smoke-test memories so they don't pollute your namespace
list:

```powershell
# Either via dashboard UI (browse to namespace=smoke, delete each)
# Or via CLI:
mnueron list --ns smoke
mnueron delete <id-1>
mnueron delete <id-2>
```

And revoke the smoke-test API token at `/account-settings/tokens`.

## What to report back

If anything fails, paste the exact error (or screenshot) and we'll
diagnose. Common failure modes:

- **Signup form errors**: usually validation, check email format
- **Login spins forever**: the `window.location.assign` fix should
  have killed this; if it returns, check for Vercel cache staleness
  (hard-refresh Ctrl+Shift+R)
- **Save returns 500**: check Vercel function logs for the
  `/api/memories` route — usually a DB connection issue
- **CLI says "command not found"**: npm bin path not on PATH;
  `npm bin -g` shows where it installs, add that to PATH
- **MCP not picking up**: restart your AI tool fully (close and reopen,
  not just refresh)
