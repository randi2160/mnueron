# Building MNUERON plugins

MNUERON has a plugin system that lets anyone extend it without modifying
core code. Plugins are regular npm packages, follow a naming convention,
and implement one or more capability interfaces.

## What plugins can do

| Capability | What it adds | Example |
| --- | --- | --- |
| **Processor** | Transform memories on save or recall | PII redaction, translation, sentiment tagging |
| **Source** | Pull memories from external systems on a schedule | GitHub issues, Slack mentions, Linear tasks, calendar events |
| **Exporter** | Push memories out to external systems | Daily digest email, Notion sync, Slack updates |
| **Embedder** | Alternative embedding provider | Local ONNX, Cohere, Voyage, self-hosted |

A single plugin can implement any combination.

## Naming convention

To be loadable by MNUERON, your npm package name must match one of:

- `mnueron-plugin-<name>` — published independently
- `@yourorg/mnueron-plugin-<name>` — published under your org scope

This is the same pattern ESLint and Babel use. It's a security guardrail —
MNUERON will refuse to load packages outside this naming pattern.

## Install / enable / disable

End users install your plugin like any npm package:

```bash
npm install mnueron-plugin-yourname            # install the code
mnueron plugin enable mnueron-plugin-yourname  # turn it on
mnueron plugin disable mnueron-plugin-yourname # turn it off
mnueron plugin list                            # see what's enabled
```

Enabled plugins are listed in `~/.mnueron/config.json`. Each plugin can
also have user-provided config under `pluginConfig[plugin-name]`.

## Minimum viable plugin (20 lines)

A plugin that adds an `[important]` tag to every memory mentioning the
word "decision":

```typescript
// src/index.ts
import type { MnueronPlugin } from 'mnueron/plugins/types';

const plugin: MnueronPlugin = {
  name: 'mnueron-plugin-mark-decisions',
  version: '0.1.0',
  description: 'Tags memories mentioning decisions as important',
  processors: [{
    id: 'mark-decisions',
    async onBeforeSave(input) {
      if (!/\bdecision\b/i.test(input.content)) return input;
      const tags = new Set([...(input.tags ?? []), 'important']);
      return { ...input, tags: Array.from(tags) };
    },
  }],
};

export default plugin;
```

That's a complete plugin. Publish to npm with `mnueron-plugin-mark-decisions`
as the name, anyone in the world can install and enable it.

## The plugin interface

See [`src/plugins/types.ts`](../../src/plugins/types.ts) for the full type
definitions. The summary:

```typescript
interface MnueronPlugin {
  name: string;
  version: string;
  description: string;

  // Lifecycle hooks (all optional)
  onInstall?(ctx: PluginContext): Promise<void>;     // first time only
  onActivate?(ctx: PluginContext): Promise<void>;    // every startup
  onDeactivate?(ctx: PluginContext): Promise<void>;  // shutdown / disable

  // Capabilities (any combination, all optional)
  processors?: MemoryProcessor[];
  sources?: ExternalSource[];
  exporters?: MemoryExporter[];
  embedders?: EmbeddingProvider[];
}
```

## PluginContext: what your plugin can access

```typescript
interface PluginContext {
  provider: Provider;                       // read/write memories
  config: Record<string, unknown>;          // user-supplied config
  storage: PluginStorage;                   // your plugin's private KV store
  logger: PluginLogger;                     // logs prefixed with your plugin name
}
```

Plugins are sandboxed — each gets its own private `storage` directory under
`~/.mnueron/plugins-state/<sanitized-name>/`, so you can persist state
across runs without worrying about colliding with other plugins.

## Plugin examples in this repo

| Plugin | Type | What it does |
| --- | --- | --- |
| [`redact-pii`](./redact-pii/) | Processor | Strips emails, phones, cards, AWS keys before saving |

More to come. PRs welcome — your plugin can live in this repo as a sample,
or you can publish it independently and we'll link to it from the README.

## Publishing your plugin

1. Pick a name following `mnueron-plugin-<name>` convention.
2. `npm init` and set the name.
3. Add MNUERON as a peer dependency:
   ```json
   "peerDependencies": { "mnueron": "^0.1.0" }
   ```
4. Implement and default-export your `MnueronPlugin`.
5. `npm publish`.
6. Open a PR adding your plugin to the registry list in this README.

## What about the official plugin marketplace?

Long-term, MNUERON will host a plugin directory at
`https://plugins.mnueron.dev` (or similar) where users can browse, read
ratings, and install plugins with one click. For now, npm is the registry
— anyone with the name and the install command can use your plugin.

If you'd like your plugin featured when the marketplace launches, please
follow these conventions:

- Use semver. Breaking changes bump the major version.
- Document your `pluginConfig` schema in `package.json` under a `mnueron`
  field (see [`redact-pii/package.json`](./redact-pii/package.json) for the shape).
- Be opinionated about defaults — most users won't read your config docs.
- Fail closed. If your processor errors, return the original input
  unchanged rather than dropping the memory.
- Keep the package small. Plugins should be lightweight; if you need
  heavy ML, prefer a remote service.

## Security model

- Plugins are full Node code with access to anything MNUERON has access
  to. Users who install plugins are trusting them. Don't install random
  npm packages without reading the source.
- The naming-convention regex is the only enforced guardrail — it stops
  arbitrary npm packages from being loaded by name.
- For SaaS deployments of MNUERON, the hosted backend will not load
  user-provided plugins; only operator-blessed plugins. The local CLI
  will continue to load any installed plugin.

## License

The plugin system itself is MIT. Each plugin chooses its own license.
