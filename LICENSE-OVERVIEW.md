# mnueron Licensing Overview

mnueron uses an **open-core** model. The client-side code — SDKs, CLI,
local dashboard, browser extension — is **MIT-licensed**, so anyone can
read, modify, embed in commercial products, fork, or self-host without
legal review. The multi-tenant hosted backend in `server/` (and any
future `dashboard-web/`) is **source-available** under the Functional
Source License (FSL-1.1-Apache-2.0): you can read, modify, contribute,
and self-host it for any internal or product use, but you can't launch
a competing commercial memory-as-a-service. Each FSL-covered version
auto-converts to Apache 2.0 two years after release.

If you're a user installing mnueron locally, a developer embedding the
SDK into your app, or a team self-hosting `server/` for your own
product, you can use the full stack today without restriction.

## At a glance

| Directory | License | Plain English |
| --- | --- | --- |
| `src/` | **MIT** | Local MCP server + CLI. Fork, embed, sell — no restrictions. |
| `dashboard/` | **MIT** | Local browser dashboard. Same. |
| `extension/` | **MIT** | Chrome / Firefox extension. Same. |
| `sdks/` | **MIT** | Python, C#, TypeScript, and VS Code clients. Embed in commercial products freely. |
| `examples/` | **MIT** | Example agents. Use them as starting points. |
| `scripts/` | **MIT** | Maintenance scripts. |
| `server/` | **FSL-1.1-Apache-2.0** | Hosted multi-tenant backend. Self-host yes, compete-with-mnueron-cloud no. Auto-converts to Apache 2.0 two years after each release. |
| `dashboard-web/` (future) | **FSL-1.1-Apache-2.0** | Hosted web dashboard, when it's built. |

The root [`LICENSE`](LICENSE) is the MIT text and covers the default of
the repo (everything not under `server/` or `dashboard-web/`). The
[`NOTICE`](NOTICE) file carries Mnueron's additional notices —
trademark, hosted-features carve-out, contribution terms, and
third-party attribution. The [`server/LICENSE`](server/LICENSE) file is
the FSL text and takes precedence within `server/`.

## Hosted-features carve-out

Some features that are conceptually part of the hosted product surface
may, for engineering reasons, touch files outside `server/` —
multi-tenancy plumbing, RLS-aware client patches, billing hooks, audit
log emitters, SSO integration, telemetry on the hosted edge. The
[`NOTICE`](NOTICE) file lists these explicitly. Contributions that
extend or modify those hosted-product features are accepted under FSL
terms even when they live in client directories, because the feature
they implement is part of the hosted product surface.

In practice this affects very few contributions. If you're touching a
file in `src/` or `sdks/` for any reason that isn't "support the hosted
product," you're under MIT.

## FAQ

### Can I use mnueron in my commercial app?

Yes. The client code, SDKs, CLI, dashboard, and extension are MIT.
Ship them in commercial products, modify them, charge for what you
build on top — no royalty, no restrictions beyond the standard MIT
copyright notice.

### Can I self-host the hosted backend?

Yes. FSL explicitly allows internal use, internal modification,
non-commercial research, and self-hosting. Run `server/` on your own
infrastructure for your own organization, your own customers, or your
own product. The constraint is only against offering it *as a
competing commercial mnueron-style memory cloud to third parties*.

### What exactly is a "Competing Use" of `server/`?

The FSL text defines it. Plain-English version: launching a hosted
memory-as-a-service that competes with mnueron's hosted offering. So:

| Use case | Allowed? |
| --- | --- |
| Self-host server/ for your team's internal AI memory | ✓ Yes — that's the point |
| Self-host server/ for your own SaaS product where memory is a feature | ✓ Yes — you're not competing in the memory category |
| Self-host server/ to power "AcmeMemoryCloud" SaaS offering an mnueron-equivalent service | ✗ No — that's a Competing Use |
| Fork client code, build a different product on top | ✓ Yes — client code is MIT |
| Research, education, evaluating the architecture | ✓ Yes |

### When does the FSL convert to Apache 2.0?

Each version of `server/` automatically becomes Apache 2.0 two years
after the date we make it available. So a `server/` commit from 2026
becomes fully open Apache 2.0 in 2028. Long-term mnueron is as open as
anything; short-term the commercial moat is protected while we build
the hosted business.

### Why this model?

The open-core split lets us be maximally welcoming on the parts of the
codebase developers actually need to adopt (the SDK, CLI, extension,
local dashboard) while supporting a hosted commercial offering that
funds the project's long-term work. Sentry, GitLab, Mattermost, and a
number of other actively-developed OSS projects use the same shape.

### Is FSL "open source"?

In the strict OSI definition, no — FSL is **source-available**, which
means the source is published and you can read, modify, contribute,
and self-host it, but redistribution for competing commercial use is
restricted for the first two years. After that, each version
automatically converts to Apache 2.0, which is OSI-approved open
source.

The client code (`src/`, `dashboard/`, `extension/`, `sdks/`,
`examples/`, `scripts/`) is fully OSI-approved open source under MIT.

### Can I use the Mnueron name or logo?

No — `NOTICE` carves those out explicitly. Neither the MIT license nor
the FSL extends to the Mnueron trademark, logo, or branding. Don't
imply endorsement or affiliation without prior written permission. If
you fork the code and ship it under a new name, you're good.

### How do I contribute?

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Every contributor signs a
one-time Contributor License Agreement (CLA) so mnueron can keep the
licensing model clean. Standard process — same as Google, Apache,
Microsoft.

### Commercial use that doesn't fit any of these buckets?

Email <opensource@mnueron.com>. We can grant a custom commercial
license. Most cases get addressed by the standard MIT/FSL terms;
outliers are negotiable.

---

This document is informational. The legally operative licenses are:

- [`LICENSE`](LICENSE) — MIT, applies to the repo by default
- [`NOTICE`](NOTICE) — additional notices (trademark, hosted-features carve-out, attribution)
- [`server/LICENSE`](server/LICENSE) — FSL-1.1-Apache-2.0, applies to `server/`

When in doubt, the LICENSE / server/LICENSE / NOTICE files govern.
