# Privacy Policy — MNUERON Browser Extension

*Last updated: May 14, 2026*

This privacy policy describes how the MNUERON browser extension
("the Extension") collects, uses, and shares information.

## Summary in one sentence

The Extension sends the conversation turns you have on **claude.ai** and
**chatgpt.com** to the MNUERON server **you configure** — and nowhere else.

## What the Extension collects

The Extension observes and captures the following data **only on
claude.ai, chatgpt.com, and chat.openai.com**:

- **Conversation messages.** The text of your messages and the AI's
  responses, including code blocks and tool outputs that appear in the
  page.
- **Conversation metadata.** Conversation title (as it appears in the
  browser tab and sidebar), the URL of the conversation, and the
  timestamp the conversation turn appeared.

The Extension also stores the following on your local device:

- **Your MNUERON API token** — stored in `chrome.storage.local`. This is
  isolated by browser, encrypted at rest by your operating system, and
  accessible only to this extension.
- **Per-day capture counts** — a small number-of-turns count kept for the
  last 14 days, used only to populate the toolbar popup's "synced today"
  display.
- **Healed selectors** — if the self-healing system updates CSS
  selectors for either site, the new selectors are cached for 30 days.

The Extension does **not** collect:

- Your Anthropic or OpenAI account credentials, cookies, or session tokens.
- Conversations on any other website.
- Your browsing history.
- Your IP address (the Extension itself doesn't collect this; your
  configured MNUERON server may log it as any web server would).
- Telemetry, analytics, or usage data of any kind.

## Where data is sent

Captured conversation data is sent **only** to the MNUERON server URL
that you configure in the Extension's settings. This is typically a
server you own or self-host. The Extension makes no other outbound
network requests except:

- To your configured MNUERON server's `/v1/memories/bulk` endpoint for
  saving captured turns.
- To your configured MNUERON server's `/v1/extension/heal-selectors`
  endpoint when the Extension's selectors break and need to be repaired
  via an LLM call. The data sent for this purpose is **structural HTML
  with all text content removed and replaced with `[TEXT:N]` placeholders**,
  so conversation content never leaves your browser as part of the
  repair flow.
- To your configured MNUERON server's `/extension-auth/start` endpoint
  during the optional OAuth-style sign-in flow.

No data is sent to the Extension authors, to any third-party analytics
service, or to any party other than the MNUERON server you yourself
configure.

## Third parties

The Extension itself shares data with no third parties. **However**,
your configured MNUERON server may, in turn, call an LLM provider
(such as Anthropic, OpenAI, or another) for the selector-repair feature.
Refer to your MNUERON server's privacy policy for details on what your
server does with the data the Extension sends it.

The Extension is **not affiliated with Anthropic, OpenAI, or any of
their products**. "Claude" and "ChatGPT" are trademarks of their
respective owners.

## Data retention

- Captured conversations on the MNUERON server are retained per **your
  configured MNUERON server's** retention settings. The Extension does
  not control this.
- Local data in `chrome.storage.local` persists until you uninstall the
  Extension or click "Disable" / "Sign Out" in the Extension's settings.
- Daily capture counts older than 14 days are automatically purged.

## Your controls

You can at any time:

- **Disable capture for a site** by visiting the Extension's settings
  page (right-click the toolbar icon → Options) and removing or pausing
  the configuration.
- **Sign out / remove the token** from the settings page.
- **Uninstall the Extension** entirely via `chrome://extensions/` or
  `about:addons` (Firefox). This deletes all locally-stored data.
- **Delete captured memories** from your MNUERON server's dashboard,
  which is outside the Extension's control.

## Security

- The MNUERON API token is stored only in `chrome.storage.local`, never
  in the page's DOM or in any storage accessible to scripts on
  claude.ai or chatgpt.com.
- All network requests use HTTPS.
- The Extension validates that auth redirects come from a legitimate
  `chrome-extension://<id>.chromiumapp.org` origin, preventing CSRF
  during the sign-in flow.

## Changes to this policy

We may update this policy from time to time. Changes will be reflected
in the "Last updated" date at the top and announced in the Extension's
GitHub repository release notes.

## Contact

For questions about this policy or the Extension's behavior, open an
issue at the project's GitHub repository or contact the project
maintainer at the email address listed in the repository.

---

*This is an open-source extension. The code is the canonical statement
of what it does — read it at the project's GitHub repository to verify
the claims in this policy.*
