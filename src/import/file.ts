/**
 * Generic document import — "Smart Context Sharding".
 *
 * Why: a large Markdown / text / log file (architecture docs, chat exports,
 * benchmark dumps, build logs) is exactly the kind of thing that bloats an
 * agent's context window or makes the desktop client sluggish/white-screen
 * when loaded whole. Instead of reading the entire file into context, we
 * split it into small overlapping chunks and store each as its own memory.
 * Later the agent recalls only the handful of chunks relevant to its query.
 *
 * Each chunk becomes one SaveMemoryInput:
 *   - content     : the chunk text (~chunkSize chars)
 *   - source      : 'file-import'
 *   - source_ref  : `file:<absPath>`  (shared parent ref for the whole file)
 *   - tags        : ['imported', 'file', <user tags...>, 'chunk', role:?]
 *   - metadata    : { title, source_path, parent_ref, chunk_index, chunk_count }
 *
 * The grouping mirrors how LocalProvider.bulkSave stamps auto-chunked
 * content (parent_ref + chunk_index + chunk_count), so doc chunks look
 * identical to transcript chunks in the dashboard and recall paths.
 *
 * Note on idempotency: the local SQLite provider INSERTs (does not upsert by
 * source_ref), so re-importing the same file appends a fresh set of chunks.
 * Callers who want a clean re-import should delete the prior file:<path>
 * memories first. The hosted provider upserts by source_ref.
 *
 * Triggered from the CLI:
 *   mnueron import notes.md --chunk-size 1200 --overlap 150 --namespace elevizio
 * and from the MCP tool `import_file`.
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

import { chunkContent } from '../store/chunking.js';
import type { SaveMemoryInput } from '../store/provider.js';

/** Default chunk size (chars) for document imports — small enough to keep
 *  recalled context tight, big enough to carry a coherent section. */
export const DEFAULT_DOC_CHUNK_SIZE = 1200;
/** Default sliding-window overlap (chars) so a section split across a
 *  boundary is still findable from either side. */
export const DEFAULT_DOC_OVERLAP = 150;

export interface DocImportOptions {
  namespace?: string;
  /** Max characters per chunk. Default 1200. */
  chunkSize?: number;
  /** Overlap in characters between consecutive chunks. Default 150. */
  overlap?: number;
  /** Extra tags applied to every chunk. */
  tags?: string[];
  /** Override the derived title (otherwise first H1, else filename). */
  title?: string;
}

export interface DocImportPlan {
  /** Absolute path of the imported file. */
  filePath: string;
  /** Human-readable title (first markdown H1, or the filename). */
  title: string;
  /** Byte size of the file content (UTF-8). */
  sizeBytes: number;
  /** Number of chunks the file was split into. */
  chunkCount: number;
  /** The chunk-size used (after applying defaults). */
  chunkSize: number;
  /** The overlap used (after applying defaults). */
  overlap: number;
  /** One SaveMemoryInput per chunk, ready for provider.bulkSave(). */
  items: SaveMemoryInput[];
}

/** Pull a title from the first Markdown H1, falling back to the filename. */
function deriveTitle(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m && m[1].trim()) return m[1].trim().slice(0, 120);
  return fallback;
}

/**
 * Read a file and build the per-chunk save plan. Does NOT write anything —
 * the caller passes `plan.items` to provider.bulkSave().
 */
export async function planDocImport(
  filePath: string,
  opts: DocImportOptions = {},
): Promise<DocImportPlan> {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }

  const content = await readFile(abs, 'utf8');
  const sizeBytes = Buffer.byteLength(content, 'utf8');

  const chunkSize = opts.chunkSize && opts.chunkSize > 0
    ? Math.floor(opts.chunkSize)
    : DEFAULT_DOC_CHUNK_SIZE;
  const overlap = opts.overlap != null && opts.overlap >= 0
    ? Math.floor(opts.overlap)
    : DEFAULT_DOC_OVERLAP;

  const ns = opts.namespace ?? 'default';
  const userTags = (opts.tags ?? []).filter(Boolean);
  const title = opts.title?.trim() || deriveTitle(content, basename(abs));

  if (content.trim().length === 0) {
    return { filePath: abs, title, sizeBytes, chunkCount: 0, chunkSize, overlap, items: [] };
  }

  const chunks = chunkContent(content, { maxChars: chunkSize, overlapChars: overlap });
  const parentRef = `file:${abs}`;
  const total = chunks.length;

  const items: SaveMemoryInput[] = chunks.map((c, i) => ({
    content: c.content,
    namespace: ns,
    source: 'file-import',
    source_ref: parentRef,
    tags: [
      'imported',
      'file',
      ...userTags,
      'chunk',
      ...(c.role ? [`role:${c.role}`] : []),
    ],
    metadata: {
      title,
      source_path: abs,
      parent_ref: parentRef,
      chunk_index: i,
      chunk_count: total,
      ...(c.role ? { role: c.role } : {}),
    },
  }));

  return { filePath: abs, title, sizeBytes, chunkCount: total, chunkSize, overlap, items };
}

/** Convenience for callers that just want the chunk count without reading
 *  the whole plan (e.g. a `--probe`/dry-run path). */
export async function probeDocImport(
  filePath: string,
  opts: DocImportOptions = {},
): Promise<{ filePath: string; title: string; sizeBytes: number; chunkCount: number }> {
  const plan = await planDocImport(filePath, opts);
  return { filePath: plan.filePath, title: plan.title, sizeBytes: plan.sizeBytes, chunkCount: plan.chunkCount };
}
