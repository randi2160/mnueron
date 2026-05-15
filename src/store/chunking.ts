/**
 * Content chunking for long memories.
 *
 * Why: a backfilled claude.ai chat can be 300K+ characters. Stored as one
 * memory it's hard to search precisely, hard to display, and blows up
 * agent context windows when retrieved. Splitting it into per-turn chunks
 * (or sliding-window chunks for unstructured long text) gives us:
 *
 *   - finer-grained semantic search (each turn embeds independently)
 *   - dashboard-friendly previews (one chunk per visible row)
 *   - context-safe agent reads (typical chunk ~1-4KB instead of 300KB)
 *   - cluster-on-display via parent_ref metadata
 *
 * Strategy:
 *   1. If content has `**User:** ... **Assistant:** ...` (or Claude/ChatGPT)
 *      structure with at least 2 turns, split per turn.
 *   2. Otherwise sliding-window split at sentence boundaries with overlap.
 *   3. Either way: each output chunk respects `maxChars`.
 *
 * Output chunks carry their position (`index`) and optional `role`. The
 * caller is responsible for stamping `parent_ref` + `chunk_index` into
 * memory metadata when saving — see LocalProvider.save().
 */

export interface ChunkOptions {
  /** Soft ceiling on a chunk's character count. Default 4000. */
  maxChars?: number;
  /** Sliding-window overlap (chars) for unstructured text. Default 200. */
  overlapChars?: number;
  /** Min chunk size — chunks shorter than this get appended to the
   *  previous one (avoids 30-char single-line orphans). Default 80. */
  minChars?: number;
}

export interface Chunk {
  content: string;
  index: number;          // 0-based position in source
  role?: string;          // 'user' | 'assistant' | 'system' | undefined
}

/** Don't bother chunking content shorter than this. */
export const DEFAULT_CHUNK_THRESHOLD = 6000;

const ROLE_HEADER = /\*\*(User|Assistant|Claude|ChatGPT|Gemini|System|Human):\*\*/gi;

export function shouldChunk(content: string, threshold = DEFAULT_CHUNK_THRESHOLD): boolean {
  return (content?.length ?? 0) > threshold;
}

export function chunkContent(content: string, opts: ChunkOptions = {}): Chunk[] {
  const max     = opts.maxChars     ?? 4000;
  const overlap = opts.overlapChars ?? 200;
  const minLen  = opts.minChars     ?? 80;

  if (!content || content.length === 0) return [];

  // Strategy 1: try transcript-aware chunking
  const transcript = chunkTranscript(content, max, minLen);
  if (transcript.length >= 2) return transcript;

  // Strategy 2: sliding window with sentence-boundary preference
  return chunkSlidingWindow(content, max, overlap, minLen);
}

/**
 * Split content on speaker headers (**User:**, **Claude:**, etc.).
 * Returns at least 2 chunks only if there are at least 2 distinct turns;
 * the caller falls back to sliding-window otherwise.
 */
function chunkTranscript(content: string, max: number, minLen: number): Chunk[] {
  ROLE_HEADER.lastIndex = 0;
  const headers: Array<{ index: number; role: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = ROLE_HEADER.exec(content)) !== null) {
    headers.push({ index: m.index, role: m[1].toLowerCase() });
  }
  if (headers.length < 2) return [];

  // The text before the first header (title, preamble) becomes chunk 0.
  const chunks: Chunk[] = [];
  if (headers[0].index > minLen) {
    chunks.push({
      content: content.slice(0, headers[0].index).trim(),
      index: chunks.length,
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = (i + 1 < headers.length) ? headers[i + 1].index : content.length;
    const turn = content.slice(start, end).trim();
    if (!turn) continue;

    const role = normalizeRole(headers[i].role);

    if (turn.length <= max) {
      chunks.push({ content: turn, index: chunks.length, role });
      continue;
    }

    // Turn longer than max — slide-window subdivide while preserving the role label.
    const sub = chunkSlidingWindow(turn, max, 200, minLen);
    for (const s of sub) {
      chunks.push({ content: s.content, index: chunks.length, role });
    }
  }

  return mergeOrphans(chunks, minLen);
}

/**
 * Generic chunker: split at sentence boundaries when possible, fall back
 * to hard char limit. Overlapping windows so a search hit near a boundary
 * still has context.
 */
function chunkSlidingWindow(
  content: string,
  max: number,
  overlap: number,
  minLen: number,
): Chunk[] {
  if (content.length <= max) return [{ content, index: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + max, content.length);

    if (end < content.length) {
      // Prefer ending at a sentence boundary in the latter half of the window.
      const lookbackFrom = end;
      const minEnd = start + Math.floor(max / 2);
      const candidates = ['. ', '.\n', '! ', '? ', '\n\n'];
      let bestEnd = -1;
      for (const sep of candidates) {
        const i = content.lastIndexOf(sep, lookbackFrom);
        if (i >= minEnd && i + sep.length <= end + 1) {
          bestEnd = Math.max(bestEnd, i + sep.length);
        }
      }
      if (bestEnd > 0) end = bestEnd;
    }

    chunks.push({
      content: content.slice(start, end).trim(),
      index: chunks.length,
    });

    if (end >= content.length) break;
    // Pull back by overlap, but never make zero progress.
    start = Math.max(end - overlap, start + Math.max(1, Math.floor(max / 4)));
  }

  return mergeOrphans(chunks, minLen);
}

/**
 * If the last chunk is too short to stand alone, fold it into the
 * previous one. Re-indexes the result.
 */
function mergeOrphans(chunks: Chunk[], minLen: number): Chunk[] {
  if (chunks.length < 2) return chunks;
  const out: Chunk[] = [];
  for (const c of chunks) {
    if (out.length > 0 && c.content.length < minLen) {
      const prev = out[out.length - 1];
      prev.content = `${prev.content}\n${c.content}`.trim();
    } else {
      out.push({ ...c });
    }
  }
  // Re-number
  return out.map((c, i) => ({ ...c, index: i }));
}

function normalizeRole(raw: string): string {
  const r = raw.toLowerCase();
  if (r === 'human') return 'user';
  if (r === 'claude' || r === 'chatgpt' || r === 'gemini') return 'assistant';
  return r;
}
