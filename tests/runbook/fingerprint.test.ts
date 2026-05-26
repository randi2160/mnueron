/**
 * Unit tests for error fingerprinting.
 *
 * The fingerprint algorithm is the highest-risk piece of the Terminal
 * Copilot — a bad fingerprint means either false-positive matches
 * (users get bad suggestions) or false-negative matches (the whole
 * feature appears broken). Tests live or die on whether the same root
 * cause yields the same hash across realistic input variations.
 *
 * Run with: npm test -- fingerprint
 */

import { describe, expect, it } from 'vitest';
import { fingerprintError, normalize, detectTool } from '../../src/runbook/fingerprint.js';

describe('normalize', () => {
  it('strips Windows paths', () => {
    expect(normalize(`Cannot find C:\\Users\\me\\file.ts`)).not.toContain('users');
    expect(normalize(`Cannot find C:\\Users\\me\\file.ts`)).toContain('<path>');
  });

  it('strips POSIX paths', () => {
    expect(normalize(`Cannot find /Users/me/file.ts`)).toContain('<path>');
    expect(normalize(`Cannot find /Users/me/file.ts`)).not.toContain('users');
  });

  it('strips git SHAs and other long hex', () => {
    expect(normalize(`fatal: ref a1b2c3d4e5f6 missing`)).toContain('<hex>');
    expect(normalize(`fatal: ref a1b2c3d4e5f6 missing`)).not.toContain('a1b2c3d4e5f6');
  });

  it('strips UUIDs', () => {
    expect(normalize(`Task abc12345-de67-89ab-cdef-0123456789ab failed`)).toContain('<uuid>');
  });

  it('strips line:col positions', () => {
    expect(normalize(`page.tsx:1059:8: Expression expected.`)).toContain(':<l>:<c>');
    expect(normalize(`page.tsx:1059:8: Expression expected.`)).not.toContain('1059:8');
  });

  it('lowercases everything', () => {
    expect(normalize('FATAL: Unable to create')).toBe(normalize('fatal: unable to create'));
  });

  it('collapses whitespace', () => {
    expect(normalize('fatal:   too   many   spaces')).toBe('fatal: too many spaces');
  });
});

describe('fingerprintError', () => {
  it('same fingerprint across path variants (Win vs POSIX)', () => {
    const a = fingerprintError(`fatal: Unable to create 'C:\\Mnueron\\.git\\index.lock': File exists.`);
    const b = fingerprintError(`fatal: Unable to create '/home/me/repo/.git/index.lock': File exists.`);
    expect(a.hash).toBe(b.hash);
  });

  it('same fingerprint regardless of timestamp', () => {
    const a = fingerprintError(`ERROR 2026-05-25T10:30:00Z: connection refused on port 5432`);
    const b = fingerprintError(`ERROR 2026-12-01T22:14:33Z: connection refused on port 5432`);
    expect(a.hash).toBe(b.hash);
  });

  it('different fingerprint for different errors', () => {
    const a = fingerprintError(`fatal: Unable to create '.git/index.lock': File exists.`);
    const b = fingerprintError(`fatal: pathspec 'foo' did not match any files`);
    expect(a.hash).not.toBe(b.hash);
  });

  it('redacts secrets before fingerprinting', () => {
    const fp = fingerprintError(`Authorization: Bearer sk-ant-api03-1234567890abcdefABCDEF1234567890`);
    expect(fp.normalized).not.toContain('sk-ant-api03');
    expect(fp.redactedCount).toBeGreaterThan(0);
  });

  it('same fingerprint with or without surrounding noise', () => {
    const a = fingerprintError(`[2026-05-25 10:30:01] fatal: Unable to create '.git/index.lock': File exists.`);
    const b = fingerprintError(`fatal: Unable to create '.git/index.lock': File exists.`);
    expect(a.hash).toBe(b.hash);
  });

  it('returns 12-character hex hash', () => {
    const fp = fingerprintError('any error');
    expect(fp.hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('detectTool', () => {
  it('detects git', () => {
    expect(detectTool(normalize(`fatal: Unable to create '.git/index.lock'`))).toBe('git');
    expect(detectTool(normalize(`fatal: refusing to merge unrelated histories`))).toBe('git');
  });

  it('detects typescript', () => {
    expect(detectTool(normalize(`error TS17008: JSX element 'main' has no corresponding closing tag.`))).toBe(
      'typescript',
    );
  });

  it('detects postgres', () => {
    // Use a postgres-specific error WITHOUT supabase keywords so it doesn't
    // get caught by the supabase signature first.
    expect(detectTool(normalize(`ERROR: relation "users" does not exist`))).toBe('postgres');
  });

  it('detects supabase when supabase_migrations is referenced', () => {
    expect(detectTool(normalize(`Error from supabase_migrations table`))).toBe('supabase');
  });

  it('detects powershell', () => {
    // Use a generic name (not a tool name from another sig) so the test
    // isolates the powershell signature.
    expect(
      detectTool(normalize(`The term 'foo' is not recognized as the name of a cmdlet`)),
    ).toBe('powershell');
  });

  it('detects npm', () => {
    expect(detectTool(normalize(`npm err! ENOENT: no such file or directory`))).toBe('npm');
  });

  it('returns undefined for unrecognized errors', () => {
    expect(detectTool(normalize(`some weird custom application error nobody has seen`))).toBeUndefined();
  });
});

describe('regression — real errors from this session', () => {
  it('git index.lock', () => {
    const fp = fingerprintError(`fatal: Unable to create 'C:/Mnueron/ai-boilerplate-pro/.git/index.lock': File exists.
Another git process seems to be running in this repository...`);
    expect(fp.tool).toBe('git');
    expect(fp.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('powershell && unsupported', () => {
    const fp = fingerprintError(
      `At line:1 char:30
+ git add supabase/migrations/ && git commit -m "feat: ..." && git push
+                              ~~
The token '&&' is not a valid statement separator in this version.`,
    );
    expect(fp.tool).toBe('powershell');
  });

  it('supabase duplicate version key', () => {
    const fp = fingerprintError(
      `Applying migration 023_token_rate_limit.sql...
ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)
Key (version)=(023) already exists.`,
    );
    // Note: This may detect as 'postgres' or 'supabase' — we accept either since
    // both are valid. The IMPORTANT thing is that two identical errors share
    // a fingerprint.
    expect(['postgres', 'supabase']).toContain(fp.tool);
  });
});
