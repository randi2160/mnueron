import type { ToolDetector } from './types.js';
import { ClaudeDesktopDetector } from './claude_desktop.js';
import { ClaudeCodeDetector } from './claude_code.js';
import { CursorDetector } from './cursor.js';
import { WindsurfDetector, ClineDetector } from './extra.js';
// v0.2.7 — additional MCP-speaking editors and agents.
import { ContinueDetector } from './continue.js';
import { ZedDetector } from './zed.js';
import { AiderDetector } from './aider.js';
import { GooseDetector } from './goose.js';
import { OpenCodeDetector } from './opencode.js';

/**
 * Order matters for the setup wizard output. The first five (Claude-family +
 * Cursor + Windsurf + Cline) are the original tier-1 tools. The v0.2.7
 * additions come after — they're real but lower-density in our user base.
 */
export function allDetectors(): ToolDetector[] {
  return [
    new ClaudeDesktopDetector(),
    new ClaudeCodeDetector(),
    new CursorDetector(),
    new WindsurfDetector(),
    new ClineDetector(),
    new ContinueDetector(),
    new ZedDetector(),
    new GooseDetector(),
    new OpenCodeDetector(),
    new AiderDetector(),
  ];
}

export type { ToolDetector } from './types.js';
