# Security Policy

Thank you for taking the time to disclose a security issue responsibly.
We treat security reports as high priority and aim to acknowledge new
reports within two business days.

## Supported versions

mnueron is pre-1.0 and ships frequently. We provide security fixes for:

| Component | Supported version | Notes |
| --- | --- | --- |
| `mnueron` (npm) | Latest minor release | Older minors get fixes for severe issues at our discretion. |
| Chrome extension | Latest version on the Chrome Web Store | Older versions are not patched; users are prompted to update. |
| Hosted backend (`server/`) | The version currently deployed to `mnueron.com` | Patched in place. |

## How to report

Please **do not** open a public GitHub issue, discussion, or pull
request for security vulnerabilities. Use one of the private channels
below — either is fine, and reports through one are not duplicates of
reports through the other.

### Option 1 — Email

Email **<security@mnueron.com>**. PGP is optional; if you want to
encrypt, ask in your first email and we'll send a key.

Useful detail to include in your first message:

- A short description of the issue ("authenticated user can read another
  org's memories via the bulk-search endpoint").
- The smallest reproduction you can put together — request, response,
  observed vs. expected behavior.
- The version of mnueron / Chrome extension / hosted backend you tested
  against.
- Whether the issue has been publicly disclosed anywhere already.
- How you'd like to be credited in the eventual advisory (real name,
  handle, or anonymous).

### Option 2 — GitHub Private Vulnerability Reporting

Go to the [Security tab](https://github.com/randi2160/mnueron/security)
on the GitHub repo and click **Report a vulnerability**. This routes
the report to project maintainers privately. No public visibility until
we publish an advisory together.

## What happens next

1. **Acknowledgement** within two business days. If you don't hear back,
   re-send — assume your message went to spam, not that we're ignoring
   you.
2. **Triage** — we reproduce the issue, assess scope and severity, and
   give you a rough timeline. Critical issues (data exposure, auth
   bypass, RCE) are usually patched within 7 days; lower-severity issues
   within 30.
3. **Fix + coordinated disclosure.** We'll cut a patch release and
   prepare a GitHub Security Advisory. You're welcome to review the
   advisory text before publication.
4. **Credit.** Unless you ask otherwise, the advisory credits you by
   the name and link you specified.

## Scope

In scope for security reports:

- The published `mnueron` npm package.
- The browser extension (Chrome / Firefox builds we publish).
- The hosted backend at `mnueron.com` (the live deployment) and the
  source in `server/`.
- The Python and .NET SDKs we publish.

Out of scope:

- Issues that require local access to the user's machine and don't
  cross a trust boundary mnueron is supposed to enforce — those are
  expected behavior for a local-first tool.
- Findings against third-party services or libraries we depend on,
  unless we're using them in a way that introduces the vulnerability.
  Please report those upstream first.
- Spam / abuse of public web forms; please report those to the form's
  operator.

## Hall of fame

A list of reporters who have responsibly disclosed issues is published
in `SECURITY-CREDITS.md` once the relevant fixes ship and you've agreed
to be listed. We don't yet operate a paid bug bounty; if that changes,
we'll update this section.
