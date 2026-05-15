# mnueron-plugin-redact-pii

Strips common PII patterns from memory content before they're saved.

## What it catches

| Pattern | Example | Replaced with |
| --- | --- | --- |
| Emails | `user@example.com` | `[redacted-email]` |
| Phone numbers | `(415) 555-0123` | `[redacted-phone]` |
| Credit cards | `4111 1111 1111 1111` | `[redacted-card]` |
| AWS keys | `AKIAIOSFODNN7EXAMPLE` | `[redacted-aws-key]` |

It also tags the memory with `redacted` and adds counts to metadata, so
you can audit which memories had redactions later:

```python
hits = client.search("...", tags=["redacted"])
```

## Install

```bash
npm install mnueron-plugin-redact-pii
mnueron plugin enable mnueron-plugin-redact-pii
```

That's it — runs automatically on every save.

## Configure (optional)

In `~/.mnueron/config.json`:

```json
{
  "enabledPlugins": ["mnueron-plugin-redact-pii"],
  "pluginConfig": {
    "mnueron-plugin-redact-pii": {
      "redactEmail": true,
      "redactPhone": true,
      "redactCreditCard": true,
      "redactAwsKey": true
    }
  }
}
```

Setting any rule to `false` disables that specific pattern.

## What this code teaches about MNUERON plugins

This is a complete plugin in ~100 lines. Every MNUERON plugin follows the
same shape:

1. **Default-export a `MnueronPlugin` manifest object** with name, version,
   description, and any combination of capability arrays:
   - `processors` — transform memories on save/recall
   - `sources` — pull memories in from external systems
   - `exporters` — push memories out
   - `embedders` — provide alternative embedding models

2. **Implement the hook(s) you care about.** This plugin only implements
   `MemoryProcessor.onBeforeSave`, which fires before every save. Other
   plugins might implement `ExternalSource.fetch` (called on a poll
   interval) or `EmbeddingProvider.embed`.

3. **Optionally use the PluginContext** — read user config, write to your
   plugin's private storage, log with your plugin's name prefix.

The full plugin API surface is in
[`src/plugins/types.ts`](../../../src/plugins/types.ts).

## License

MIT.
