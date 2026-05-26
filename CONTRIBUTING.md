# Contributing to mnueron

Thanks for thinking about it. We actively want pull requests, issue reports,
documentation improvements, new examples, new tool detectors, new scrapers,
and bug fixes. Here's how the process works.

## Before you start

- **Read [`ROADMAP.md`](ROADMAP.md)** — the contributor-facing roadmap with
  concrete items open for community work, grouped by `good first issue`,
  `help wanted`, and `discuss first`. Start here if you don't have a
  specific idea yet.
- **Read [`PLAN.md`](PLAN.md)** — internal product roadmap (pricing,
  dashboard mockups, strategy). Read if you want maximum context;
  everything contributor-relevant is mirrored to `ROADMAP.md`.
- **Read [`DEVELOPMENT.md`](DEVELOPMENT.md)** — engineering runbook,
  including the verification recipes for each subsystem and the catalog of
  gotchas we've hit. Saves you from rediscovering them.
- **Read [`LICENSE-OVERVIEW.md`](LICENSE-OVERVIEW.md)** — what's MIT vs.
  FSL and what the difference means for your contribution.

## The contribution flow

1. **Open an Issue** describing what you want to change. For small fixes
   (typo, doc tweak, obvious bug) you can skip this and go straight to PR.
2. **Sign the Contributor License Agreement (CLA).** This is a one-time
   thing per GitHub account. See "CLA" below.
3. **Fork the repo**, create a branch off `main` named something
   descriptive (`fix/fts5-stop-words`, `feat/codex-detector`,
   `docs/install-on-arch`).
4. **Make your change.** Match the existing style — Prettier defaults for
   TypeScript, vanilla JS for the extension and dashboard. Keep changes
   focused; one PR per logical concern.
5. **Add or update tests.** For `src/` changes, extend `scripts/smoke.mjs`
   if the change affects the local provider. For extension or dashboard
   changes, add a verification recipe to `DEVELOPMENT.md` §3.
6. **Verify the build passes.** `npm run build` should produce no errors;
   `node scripts/smoke.mjs` should be all green.
7. **Open the Pull Request** against `main`. Reference the Issue in the
   description. Describe what you changed and why, not just what.
8. **Wait for the CLA bot.** [CLA Assistant](https://cla-assistant.io) will
   automatically check whether you've signed the CLA and post a status. PRs
   without a signed CLA can't be merged.
9. **Address review feedback** — usually 1–2 rounds. We try to respond
   within a few days for small PRs, longer for bigger ones.
10. **We merge.** Squash-merge is the default to keep `main`'s history clean.

## Contributor License Agreement (CLA)

mnueron asks every contributor to sign a one-time CLA the first time they
PR. The CLA does three things:

1. **You assert that the code you contribute is yours to contribute** —
   not something you copy-pasted from a proprietary codebase, not
   something your employer owns.
2. **You grant mnueron a license to use, modify, and re-license your
   contribution** as part of the project. This is the bit that protects
   the project: it means we can keep the dual MIT/FSL licensing model
   consistent across the codebase without chasing individual contributors
   later to ask permission.
3. **You retain copyright on your contribution.** We don't take ownership
   of your code — you just grant us a license to use it under the
   project's terms.

The full text is in [`CLA.md`](CLA.md). It's based on the standard Apache
Individual Contributor License Agreement, which is what Google, Microsoft,
and most large OSS projects use.

To sign:

1. The CLA Assistant bot will post a comment on your first PR with a
   sign-in link.
2. Click it, sign in with GitHub, accept the CLA text.
3. Done — applies to all future PRs from the same GitHub account.

If your employer requires you to use a Corporate CLA instead (your
employer holds the copyright), email <opensource@mnueron.com> and we'll
sort out a corporate agreement. This is unusual for individual hobbyists
and common for engineers contributing during work hours.

## What we welcome

- **Bug fixes** — the smaller the PR, the faster it merges.
- **New AI tool detectors** for the setup wizard. The pattern is well-documented
  in `DEVELOPMENT.md` §6.
- **New chat-site scrapers** for the Chrome extension. Pattern in `DEVELOPMENT.md` §7.
- **New SDK languages** (JS/TS, Go, Rust, Ruby, Java) — model them after
  the Python SDK in `sdks/python/`.
- **Plugin examples** — drop them under `examples/plugins/`.
- **Documentation improvements.** Including this file, INSTALL.md, README,
  PLAN.md.
- **Performance improvements** in the local provider.
- **New strategies** for the existing scrapers when claude.ai or chatgpt.com
  break.
- **Translations** of the dashboard or extension UI strings, once we
  externalize them.

## What needs discussion before you start

- **Schema changes** — adding columns, changing index strategies. Open an
  Issue first.
- **New MCP tools** — there are six today plus `memory_get`. Adding an
  eighth needs a strong case; we're trying to keep the surface tight.
- **Provider interface changes** — every change here cascades to local +
  remote. Coordinate before writing code.
- **Anything in `server/`** — paid product surface, FSL-licensed, and
  intentionally constrained.
- **Replacing major dependencies** (better-sqlite3, Transformers.js,
  sqlite-vec). Talk first.

## What's out of scope

- **Telemetry / analytics that phone home.** mnueron is local-first;
  capturing user behavior would break that promise.
- **Required cloud accounts for basic use.** The free local path stays
  account-free forever.
- **Vendor lock-in.** Tools that only work with one LLM provider should be
  optional add-ons, not core.

## Reporting security issues

**Do not file a public Issue for security problems.** Email
<security@mnueron.com> with details and we'll respond within 72 hours. If
you've found a vulnerability that affects user data, please give us a
reasonable disclosure window (~90 days) before going public.

## Code of conduct

Be kind. Disagree respectfully. Assume positive intent in reviews. We
follow the [Contributor Covenant](https://www.contributor-covenant.org/)
as our baseline. Harassment, personal attacks, and dismissiveness will get
you removed.

## Questions?

Open an Issue or start a Discussion. We'd rather hear "is this stupid?"
upfront than have you spend two weekends on a PR we'd have to reject.
