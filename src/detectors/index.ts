import type { ToolDetector } from './types.js';
import { ClaudeDesktopDetector } from './claude_desktop.js';
import { ClaudeCodeDetector } from './claude_code.js';
import { CursorDetector } from './cursor.js';
import { WindsurfDetector, ClineDetector } from './extra.js';

export function allDetectors(): ToolDetector[] {
  return [
    new ClaudeDesktopDetector(),
    new ClaudeCodeDetector(),
    new CursorDetector(),
    new WindsurfDetector(),
    new ClineDetector(),
  ];
}

export type { ToolDetector } from './types.js';
