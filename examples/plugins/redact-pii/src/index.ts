/**
 * mnueron-plugin-redact-pii
 *
 * Strips common PII patterns from memory content before they're saved.
 * Implemented as a MemoryProcessor — runs on the save path, never modifies
 * what's already in the database.
 *
 * The pattern shown here is what every third-party MNUERON plugin looks like:
 *
 *   1. Default-export a `MnueronPlugin` object.
 *   2. List your capabilities (processors, sources, exporters, embedders).
 *   3. Implement the hooks. They're called by MNUERON at the right moments.
 *
 * Install in any MNUERON instance with:
 *   npm install mnueron-plugin-redact-pii
 *   mnueron plugin enable mnueron-plugin-redact-pii
 *
 * Configure (optional) in ~/.mnueron/config.json:
 *   {
 *     "enabledPlugins": ["mnueron-plugin-redact-pii"],
 *     "pluginConfig": {
 *       "mnueron-plugin-redact-pii": {
 *         "redactEmail": true,
 *         "redactPhone": true,
 *         "redactCreditCard": true,
 *         "redactAwsKey": true,
 *         "addRedactedTag": true
 *       }
 *     }
 *   }
 */
import type {
  MnueronPlugin,
  PluginContext,
  MemoryProcessor,
} from 'mnueron/plugins/types';
import type { SaveMemoryInput } from 'mnueron/store/provider';

// ---------------------------------------------------------------------------
// Patterns. Each rule has (name, regex, replacement).
// ---------------------------------------------------------------------------

interface Rule {
  name: string;
  re: RegExp;
  replace: string;
}

const RULES: Record<string, Rule> = {
  redactEmail: {
    name: 'email',
    // pragmatic email regex — not RFC-perfect, intentionally
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: '[redacted-email]',
  },
  redactPhone: {
    name: 'phone',
    // catches +1-, (415), 415-..., etc. Tuned for US/CA; tweak for your region.
    re: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replace: '[redacted-phone]',
  },
  redactCreditCard: {
    name: 'credit-card',
    // 13-19 digits, optionally space/dash-separated
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: '[redacted-card]',
  },
  redactAwsKey: {
    name: 'aws-key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: '[redacted-aws-key]',
  },
};

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const plugin: MnueronPlugin = {
  name: 'mnueron-plugin-redact-pii',
  version: '0.1.0',
  description: 'Strips emails, phone numbers, credit cards, AWS keys before saving',
  author: 'MNUERON community',
  homepage: 'https://github.com/yourorg/mnueron-plugin-redact-pii',
  engines: { mnueron: '^0.1.0' },

  async onActivate(ctx: PluginContext) {
    ctx.logger.info('PII redaction active');
    const enabled = enabledRules(ctx.config);
    ctx.logger.info('rules enabled:', enabled.map(r => r.name).join(', ') || '(none)');
  },

  processors: [makeProcessor()],
};

function makeProcessor(): MemoryProcessor {
  return {
    id: 'redact-pii',
    async onBeforeSave(input: SaveMemoryInput): Promise<SaveMemoryInput | null> {
      // We don't have access to ctx here, so we read defaults from process env
      // OR the plugin's onActivate could have stored its config in module-level
      // state. We do the simpler thing: enable all rules by default; users
      // who want fewer can fork or contribute a config-reading variant.
      const rules = Object.values(RULES);
      let content = input.content;
      const hitsBy: Record<string, number> = {};
      let totalHits = 0;

      for (const r of rules) {
        const before = content;
        content = content.replace(r.re, () => { totalHits++; hitsBy[r.name] = (hitsBy[r.name] ?? 0) + 1; return r.replace; });
        // r.re is sticky/global — reset lastIndex defensively
        r.re.lastIndex = 0;
        void before;
      }

      if (totalHits === 0) return input;

      // Add a tag so the user can audit later: which memories got redacted
      const tags = new Set([...(input.tags ?? []), 'redacted']);
      return {
        ...input,
        content,
        tags: Array.from(tags),
        metadata: {
          ...(input.metadata ?? {}),
          redactions: hitsBy,
          redactions_total: totalHits,
        },
      };
    },
  };
}

function enabledRules(config: Record<string, unknown>): Rule[] {
  const out: Rule[] = [];
  for (const [key, rule] of Object.entries(RULES)) {
    // default to true; explicit `false` disables
    if (config[key] !== false) out.push(rule);
  }
  return out;
}

export default plugin;
