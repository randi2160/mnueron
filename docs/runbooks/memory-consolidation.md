# Memory Consolidation — Operator Runbook

A living document for anyone running the consolidation engine in
production — on their own machine, on the hosted backend, or as a
scheduled job. Read end-to-end the first time, then come back to
specific sections when something goes wrong.

> **Conceptual overview** lives at <https://mnueron.com/features/consolidation>.
> **End-user setup guide** is at <https://mnueron.com/docs#consolidation>.
> This file is the operator's manual: the failure modes, the tunables,
> and the recovery procedures.

---

## Why this exists

Every memory store gets worse with time. Duplicate captures pile up,
status updates supersede each other, dated "ship next week" notes go
stale. Recall precision drops while you're busy shipping.

The consolidation engine runs a reflective pass over the store:

1. Lists namespaces and recent activity (cheap; no LLM).
2. Surfaces duplicate clusters via embedding similarity + keyword
   recall.
3. For ambiguous clusters, an LLM judges: exact duplicate (delete),
   superseded status (keep latest), complementary fragments (merge),
   or leave alone.
4. Writes proposals to a review queue. Operators approve, reject, or
   flip auto-apply on per namespace.
5. Captures a `consolidation-log` memory after each run with counts,
   patterns surfaced, and anything noticed-but-not-acted-on.

Default mode is conservative — when in doubt, leave it alone. False
positives on deletion cost trust faster than any other failure.

---

## CLI surface

Already wired in `src/cli.ts`. Subcommands:

```
mnueron consolidate <sub>
   detect    [--ns <name>] [--limit <n>] [--threshold <0..1>] [--dry-run]
   list      [--status pending|approved|rejected|all]
   approve   <proposal-id>
   reject    <proposal-id> [--reason "<text>"]
   schedule  [--cadence nightly|weekly|hourly|off] [--at HH:MM] [--tz <iana>]
             [--ns <name>] [--mode aggressive|conservative]
   auto-apply --ns <name> [--on | --off] [--confidence <0..1>]
   restore   <id>         # restore a soft-deleted entry within 30 days
   status                 # show schedule + last run summary per namespace
```

Run `mnueron consolidate help` for full flag docs.

---

## Quick start (5 minutes)

### 1. Dry-run on your noisiest namespace

```powershell
mnueron consolidate detect --ns elevizio --dry-run --limit 25
```

Expected output (excerpt):

```
Scanned 4,879 entries in 'elevizio' (sample 25).
Found 2 high-confidence duplicate pairs:
  • 153cd902…  ↔  32984cff…   (Phase 2 Stripe walkthrough, identical 3,980 chars)
  • 4488b81d…  ↔  a611efe1…   (psql migration check, identical 2,270 chars)
Found 0 superseded statuses.
Found 0 stale relative time references.
No changes written (--dry-run).
```

### 2. Inspect a proposal

```powershell
mnueron consolidate list --status pending
mnueron consolidate detect --ns elevizio    # actually write proposals
mnueron consolidate list --status pending --limit 5
```

Each row shows: proposal id, type (merge / delete / rewrite), affected
entry ids, confidence, and the LLM's one-line rationale.

### 3. Approve or reject

```powershell
mnueron consolidate approve 7ba69936-…
mnueron consolidate reject 41e95592-… --reason "still relevant to current sprint"
```

Approvals execute the change atomically. Rejections move the proposal
to status=rejected and surface the reason in the run log so the engine
can learn (eventually — currently logged only, no model retrain loop).

### 4. Read the audit log

```powershell
mnueron recall --tag consolidation-log --k 5
```

The most recent entry has the run's full report.

---

## Scheduling

Schedules live in `~/.mnueron/schedules.json` locally, and in the
`scheduled_tasks` table on hosted.

### Turn on the default nightly pass

```powershell
mnueron consolidate schedule --cadence nightly --at 03:00 --tz local
```

### Per-namespace policies

```powershell
# Aggressive on a noisy chunk-import namespace
mnueron consolidate schedule --ns elevizio --cadence weekly --mode aggressive

# Skip a critical decisions namespace entirely
mnueron consolidate schedule --ns preferences --cadence off
mnueron consolidate schedule --ns mnueron --cadence off
```

### Modes — what they actually change

| Mode | Threshold | LLM tiebreak | Auto-action |
|---|---|---|---|
| `conservative` (default) | 0.92 | only on close calls | proposal only |
| `balanced` | 0.85 | yes | proposal only |
| `aggressive` | 0.80 | yes | auto-merge if confidence ≥ 0.95 |
| `off` | — | — | namespace skipped entirely |

Per-namespace mode overrides the global default. Set the global
default with `--global` on the schedule command.

---

## Auto-apply

Auto-apply is what turns the review queue into a true background
consolidation loop. Defaults are off everywhere. The recommended
ramp-up:

1. Run scheduled passes for two weeks with manual approval.
2. After approving ~50 proposals on a given namespace and they all
   look right, flip auto-apply on for that namespace at 0.95
   confidence.
3. Lower confidence to 0.90 after another month if you're happy.
4. Ambiguous proposals (below the confidence floor) always still
   queue for manual review — auto-apply is only about the safe end
   of the spectrum.

```powershell
mnueron consolidate auto-apply --ns elevizio --on --confidence 0.95
mnueron consolidate auto-apply --ns elevizio --confidence 0.90
mnueron consolidate auto-apply --ns elevizio --off
```

---

## Safety guarantees

Codified in `src/store/consolidator.ts` and enforced at the engine
level — not opt-in. If you change them, the test suite breaks.

1. **Hard cap: 50 deletions per run.** If a single run would delete
   more, it stops and emits a report-only entry instead. Bulk
   cleanup is always a human decision.
2. **Read before delete.** Every entry the pass acts on is fetched
   in full via `memory_get` first. Logged in the audit trail with
   `before_hash` so you can verify after the fact.
3. **Preserved tags.** Entries tagged `decision`, `architecture`,
   `plan`, or `runbook` are never touched. The list lives in
   `src/store/consolidator.ts:PRESERVED_TAGS`.
4. **Preserved namespaces.** Anything mode-off plus the built-in
   `preferences`, `mnueron`, and `mnueron-plan` namespaces.
5. **Dry-run mode.** `--dry-run` on `detect` writes nothing — useful
   when changing thresholds or modes.
6. **30-day soft-delete quarantine.** Deletions move to namespace
   `consolidation-quarantine` first and become permanent after
   30 days. Restore any time with `mnueron consolidate restore <id>`.

---

## Cost model

Local: free (you bring the LLM via Anthropic/OpenAI key). Hosted:
included up to the tier's monthly LLM call cap, then BYOK fall-through.

A typical nightly run on a 5,000-entry store:

- ~12 recall queries (free; SQL + embeddings)
- ~30 LLM judgments on candidate clusters at Haiku-class pricing
- ~$0.01–0.03 per run with cached embeddings

A reading namespace pass that finds nothing costs ~$0.001 — the
recall round-trips are free, no LLM ever fires.

---

## Operating procedures

### Recover a wrongly-deleted entry

```powershell
mnueron consolidate list --status applied --since 7d
# find the deletion record, copy the entry id
mnueron consolidate restore <entry-id>
```

If past the 30-day window, restore is impossible — the row is gone.
Audit log still shows what happened.

### Disable everything immediately

```powershell
mnueron consolidate schedule --global --cadence off
```

Stops all scheduled runs across all namespaces. Existing proposals
in the queue stay there; nothing in flight is interrupted.

### Investigate an unexpected pattern in the log

The `consolidation-log` memory always includes a "patterns worth
surfacing" section even when no actions are taken. If the same
pattern shows up across multiple runs:

1. Pull the last 7 logs:
   `mnueron recall --tag consolidation-log --since 7d --k 10`
2. Grep for the pattern phrase.
3. Decide if it warrants a one-time manual cleanup script (live in
   `scripts/consolidate-onetime/`) or a feature request to the
   detection rules in `src/store/consolidator.ts:DETECTION_RULES`.

### Move from scheduled back to manual

```powershell
mnueron consolidate schedule --global --cadence off
mnueron consolidate auto-apply --global --off
```

You can still run `detect` and review proposals on demand.

---

## Hosted-specific

### Where the schedule lives

`scheduled_tasks` table in Supabase. Each row: `org_id`, `namespace
(nullable)`, `cadence`, `at_hour`, `at_minute`, `tz`, `mode`,
`auto_apply`, `confidence_floor`, `last_run_at`, `last_run_status`.

### Run history dashboard

`Dashboard → Consolidation → Run history` (paid tiers). Shows each
run's start/end time, counts, cost, and a link to the
consolidation-log memory.

### Webhooks (Team tier)

If you've registered a webhook with event `consolidation.run.completed`,
each run emits an HMAC-signed payload to your endpoint with the same
data the dashboard shows. Useful for piping into Slack or PagerDuty.

```json
{
  "event": "consolidation.run.completed",
  "run_id": "7ba69936-…",
  "namespaces": ["default", "web-claude", "elevizio"],
  "deleted": 22, "merged": 0, "time_fixes": 0,
  "duration_ms": 8421,
  "cost_usd": 0.014,
  "log_memory_id": "7ba69936-556a-481a-be2a-9c13cfdb8bff"
}
```

### Subscription lapse

When billing fails, scheduled runs pause after the grace period. The
schedule rows are kept; resuming billing reactivates them on the
next cycle. Manual `consolidate detect` continues to work as long as
the org has any active free or paid tier.

---

## Tuning playbook (by symptom)

| Symptom | Try first |
|---|---|
| Pass finds zero duplicates but you know they exist | `--threshold 0.80`, scope to one namespace |
| Pass merges entries you wanted to keep separate | Switch namespace to `conservative`, disable auto-apply, increase `--confidence 0.97` |
| LLM cost on hosted is higher than expected | Schedule weekly instead of nightly; mark stable namespaces `--mode off` |
| Same proposal keeps reappearing after rejection | Rejection reason is logged but not learned from yet — open an issue; meanwhile delete one entry manually so the cluster collapses |
| Run takes longer than 60 seconds | Add `--ns <one-name>` to scope; the global pass parallelizes 4-way but can still scale linearly with namespace count |

---

## Engineering log

Append dated notes here when you fix something subtle so the next
person doesn't trip over it.

**2026-05-25 (initial production run)** — first nightly pass on a
~5K-entry store deleted 22 entries safely. Surfaced two structural
issues we hadn't acted on: (a) `elevizio` namespace is ~99%
claude-cowork chunk imports and would benefit from archive-by-session
rather than per-chunk consolidation, (b) scheduled-task prompts
themselves were becoming memories via cowork import — filter
`<scheduled-task name=...>` chunks at import time. Audit memory id:
`7ba69936-556a-481a-be2a-9c13cfdb8bff`.

**2026-05-25** — confirmed safety cap works as designed; pass would
have exceeded 50-delete cap on a separate test run and correctly
stopped, emitting a report-only entry instead of proceeding.

---

## See also

- `src/store/consolidator.ts` — the engine itself (detection rules,
  safety guards, audit-log writer).
- `src/cli.ts` — `cmdConsolidate` and subcommand dispatch.
- `PLAN.md` §3 (Premium UX) — the dashboard Consolidation Proposals
  page spec.
- `CONTRIBUTING.md` — branch naming and PR checklist if you're
  contributing detection rules.
