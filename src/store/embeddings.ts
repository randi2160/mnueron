/**
 * Local embedding generation for hybrid search.
 *
 * Uses Transformers.js + all-MiniLM-L6-v2 (ONNX). ~25MB model, 384-dim
 * normalized vectors. Runs entirely on CPU through onnxruntime-node — no
 * external API calls, no telemetry, no internet after the first download.
 *
 * Lifecycle:
 *   - First call to embed() lazily downloads the model from Hugging Face's
 *     CDN and caches it at ~/.mnueron/models. Takes ~5–15s the first time
 *     on a typical connection. Subsequent process starts are instant
 *     (cached locally).
 *   - If model load fails (no network on first run, corrupt cache, etc.)
 *     `isReady()` stays false and the caller should fall back to FTS5-only.
 *
 * The model is bundle-light (the npm package is ~5MB; the heavy ONNX weights
 * are pulled on demand) so we don't bloat the npm install.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const MODEL_DIR = join(homedir(), '.mnueron', 'models');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;

mkdirSync(MODEL_DIR, { recursive: true });

let pipe: any = null;
let pipePromise: Promise<any> | null = null;
let lastError: string | null = null;

async function loadPipeline(): Promise<any> {
  if (pipe) return pipe;
  if (pipePromise) return pipePromise;

  pipePromise = (async () => {
    // Lazy-import so the heavy module is only paid for when search is actually
    // used. Important for the MCP server, which is spawned cheaply per session.
    const { pipeline, env } = await import('@xenova/transformers');

    // Cache to our own dir so users can easily wipe / inspect / back up.
    // Also disable telemetry — Transformers.js doesn't phone home but we
    // make the intent explicit.
    env.cacheDir = MODEL_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;   // needed for first-run download
    env.useBrowserCache = false;

    try {
      const p = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true,           // smaller, faster, no quality loss for retrieval
      });
      pipe = p;
      return p;
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      pipePromise = null;          // allow retry on next call
      throw e;
    }
  })();

  return pipePromise;
}

/**
 * Generate an embedding for a single piece of text. Returns null if the
 * pipeline can't be loaded — caller should treat the search request as
 * keyword-only in that case.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  try {
    const p = await loadPipeline();
    const out = await p(trimmed, { pooling: 'mean', normalize: true });
    // out.data is a Float32Array of length 384
    return out.data as Float32Array;
  } catch (e) {
    return null;
  }
}

/**
 * Batch generation. Faster than calling embed() N times because the model
 * processes them as a single forward pass when possible.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  const cleaned = texts.map(t => (t ?? '').trim());
  const haveContent = cleaned.some(t => t.length > 0);
  if (!haveContent) return cleaned.map(() => null);

  try {
    const p = await loadPipeline();
    const results: (Float32Array | null)[] = [];
    // Transformers.js batches naturally when given an array.
    const out = await p(cleaned, { pooling: 'mean', normalize: true });
    // out.dims = [N, 384]; out.data is a flat Float32Array of length N*384
    const N = cleaned.length;
    for (let i = 0; i < N; i++) {
      if (!cleaned[i]) { results.push(null); continue; }
      const start = i * EMBED_DIM;
      const slice = new Float32Array(EMBED_DIM);
      slice.set(out.data.slice(start, start + EMBED_DIM));
      results.push(slice);
    }
    return results;
  } catch (e) {
    return texts.map(() => null);
  }
}

export function isReady(): boolean {
  return pipe != null;
}

export function getLastError(): string | null {
  return lastError;
}

export const EMBEDDING_DIM = EMBED_DIM;
export const EMBEDDING_MODEL = MODEL_ID;

/**
 * Pre-warm the model. Useful at MCP-server startup to avoid paying the
 * load cost on the first user query. Non-blocking by default.
 */
export function preload(): Promise<void> {
  return loadPipeline().then(() => undefined).catch(() => undefined);
}
