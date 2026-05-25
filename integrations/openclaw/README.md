# mnueron skill for OpenClaw

An [OpenClaw](https://openclaw.ai) skill that gives the agent access to mnueron's persistent memory layer. Replaces OpenClaw's built-in session memory with mnueron's hybrid retrieval (BM25 + vector + RRF) over a local SQLite store that survives across sessions and tools.

## What this is

`SKILL.md` — an AgentSkills-compatible markdown file that teaches OpenClaw's agent when and how to save and recall using mnueron. The actual memory operations are HTTP calls to mnueron's local dashboard server (`http://127.0.0.1:3122`).

Two operations the skill teaches:

| Operation | Endpoint | When the agent uses it |
| --- | --- | --- |
| **Save** | `POST /api/memories` | Whenever the user shares a fact, preference, decision, or runbook worth remembering. |
| **Recall** | `POST /api/memories/search/bulk` | Before answering any question that could benefit from past context. |

## Why a user would install it

OpenClaw ships with built-in memory that's session-scoped. mnueron persists across sessions, across tools (Claude Desktop, Cursor, ChatGPT via MCP, this OpenClaw agent, IDE plugins), and optionally syncs across machines. Same memory store, every tool. For users who already run mnueron alongside their other AI tools, this skill brings OpenClaw into the same memory.

## Install (for users)

Once published to [ClawHub](https://clawhub.ai):

```bash
openclaw skills install mnueron
```

Or install directly from this repo:

```bash
openclaw skills install git:mnueron/mnueron@main --as mnueron
```

Or local install for development:

```bash
git clone https://github.com/mnueron/mnueron.git
openclaw skills install ./mnueron/integrations/openclaw --as mnueron
```

Prerequisites the skill checks at load time:

- `mnueron` binary on PATH (`npm i -g mnueron && mnueron setup`)
- `curl` (universally available)

After install, start mnueron's local server in a separate terminal:

```bash
mnueron dashboard --port 3122 --no-open
```

The skill will fail gracefully with a clear message if the server isn't running.

## Publish to ClawHub (for randy)

Steps to make this available as `openclaw skills install mnueron`:

1. Sign up at [clawhub.ai](https://clawhub.ai) (free).
2. Install the `clawhub` CLI: `npm i -g clawhub`.
3. From this directory: `clawhub publish` (or `clawhub sync --all` if managing multiple skills).
4. ClawHub runs a security scan (VirusTotal + ClawScan + static analysis) before listing — should pass since this skill only invokes `curl` against localhost.
5. Once listed, users get one-command install.

After publishing:

- Tweet at @steipete with a link — devs love when other devs build interop without asking.
- Add a "Use with OpenClaw" badge to mnueron's main README pointing here.
- Track adoption via ClawHub's analytics dashboard.

## Design choices worth knowing

**No custom CLI wrapper.** The skill uses `curl` against mnueron's existing HTTP API rather than shelling out to a `mnueron save` / `mnueron recall` CLI (which doesn't exist yet). This keeps the skill self-contained — no new mnueron CLI surface to maintain. If we later add `mnueron save` / `mnueron recall` shortcuts, the skill can be updated to use them.

**Default namespace is `user:default`.** The SKILL.md instructs the agent to use `project:<name>` and `team:<name>` patterns when context implies them. No user config required to get value on day one.

**Aggressive save behavior.** The skill explicitly tells the agent to save proactively without asking permission for small facts. That's the right default — users who installed a memory skill want memory to actually happen. If a user complains about over-saving, they can disable the skill or add custom gating in `~/.openclaw/openclaw.json` under `skills.entries.mnueron.config`.

**No skill instructions for delete/list/namespaces management.** Those are dashboard operations. Keeping the skill focused on save + recall reduces token overhead (the SKILL.md goes into every OpenClaw system prompt). Users manage their memory via mnueron's dashboard, not via chat.

## Follow-ups worth considering

- **Add `mnueron save` and `mnueron recall` CLI shortcuts** in mnueron core. Cleaner agent invocation than curl, and useful for other shell-driven workflows too.
- **Auto-start mnueron dashboard** when the skill loads. Currently requires the user to start it manually. Could be a `metadata.openclaw.install` post-install hook.
- **Skill config for default namespace.** Let users set `skills.entries.mnueron.config.defaultNamespace = "user:randy"` if they want personalized scoping.
- **Token-efficiency telemetry.** mnueron's recall returns `score` per result — the skill could surface "I used memories at 92% / 87% / 74% match" to build user trust in what got retrieved.

## License

Same as mnueron core (MIT for the skill content, since it's an integration glue layer with no hosted-features surface).
