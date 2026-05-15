# mnueron Licensing Overview

mnueron uses an **open-core** model — most of the code is permissively
licensed (MIT) so anyone can adopt it without legal review. The
multi-tenant hosted backend is **source-available** under the Functional
Source License (FSL), which lets you read, modify, contribute, and
self-host — but not launch a competing commercial memory-as-a-service.

If you're a user installing mnueron locally, or a developer embedding the
SDK into your app, you only interact with MIT-licensed code.

## At a glance

| Directory | License | Plain English |
| --- | --- | --- |
| `src/` | **MIT** | Local MCP server + CLI. Fork, embed, sell — whatever. |
| `dashboard/` | **MIT** | Local browser dashboard. Same. |
| `extension/` | **MIT** | Chrome / Firefox extension. Same. |
| `sdks/` | **MIT** | Python and C# clients. Embed in commercial products freely. |
| `examples/` | **MIT** | Example agents. Use them as starting points. |
| `scripts/` | **MIT** | Maintenance scripts. |
| `server/` | **FSL-1.1-Apache-2.0** | Hosted multi-tenant backend. Self-host yes, compete-with-mnueron-cloud no. Auto-converts to Apache 2.0 two years after each release. |
| `dashboard-web/` (future) | **FSL-1.1-Apache-2.0** | Hosted web dashboard, when it's built. |

The root [`LICENSE`](LICENSE) is the MIT text and covers the default of the
repo (everything not under `server/` or `dashboard-web/`). Each
source-available directory has its own [`server/LICENSE`](server/LICENSE)
that takes precedence within that directory.

## FAQ

### Can I use mnueron in my commercial app?

Yes. The client code, SDKs, CLI, dashboard, and extension are MIT. Ship them
in commercial products, modify them, charge for what you build on top — no
royalty, no restrictions.

### Can I self-host the hosted backend?

Yes. FSL explicitly allows internal use, internal modification,
non-commercial research, and self-hosting. Run `server/` on your own
infrastructure for your own organization or your own product. The
constraint is only against offering it *as a competing commercial
mnueron-style memory cloud to third parties*.

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

Each version of `server/` automatically becomes Apache 2.0 two years after
the date we make it available. So a `server/` commit from 2026 becomes
fully open Apache 2.0 in 2028. Long-term mnueron is as open as anything;
short-term the commercial moat is protected while we build the hosted
business.

### Why this model?

The open-core split lets us be maximally welcoming on the parts of the
codebase developers actually need to adopt (the SDK, CLI, extension, local
dashboard) while supporting a hosted commercial offering that funds the
project's long-term work. Sentry, GitLab, Mattermost, and a number of
other actively-developed OSS projects use the same shape.

### Is FSL "open source"?

In the strict OSI definition, no — FSL is **source-available**, which
means the source is published and you can read, modify, contribute, and
self-host it, but redistribution for competing commercial use is
restricted for the first two years. After that, each version automatically
converts to Apache 2.0, which is OSI-approved open source.

The client code (`src/`, `dashboard/`, `extension/`, `sdks/`, `examples/`)
is fully OSI-approved open source under MIT.

### How do I contribute?

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Every contributor signs a one-time
Contributor License Agreement (CLA) so mnueron can keep the licensing model
clean. Standard process — same as Google, Apache, Microsoft.

### Commercial use that doesn't fit any of these buckets?

Email us. We can grant a custom commercial license. Most cases get
addressed by the standard FSL terms; outliers are negotiable.

---

This document is informational. The legally operative licenses are:
- [`LICENSE`](LICENSE) — MIT, applies to the repo by default
- [`server/LICENSE`](server/LICENSE) — FSL-1.1-Apache-2.0, applies to `server/`

When in doubt, the LICENSE files govern.
