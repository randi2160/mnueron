-- =============================================================================
-- mnueron docs — migration 024
-- Patches the stale "Embedding similarity" bullet in the "What's not tracked
-- yet" section. As of the current server/index.ts the /v1/memories/search
-- endpoint does HYBRID recall: BM25 (ts_rank_cd on tsvector) + cosine
-- similarity (pgvector) fused via RRF, with OpenAI text-embedding-3-small as
-- the default embedder. BM25-only is now just the fallback when no embedder
-- API key is present.
--
-- Evidence (server/index.ts):
--   line 8:    "Hybrid recall (BM25 via tsvector + cosine via pgvector)."
--   line 137:  pluggable embedder, default OpenAI text-embedding-3-small
--   line 420:  embeddings computed at save time
--   line 484:  cosine ranking: 1 - (m.embedding <=> $4::vector) AS s
--   line 491:  RRF fusion of BM25 + vector
--
-- Idempotency: this migration uses REPLACE() against content_md. The first
-- run rewrites the stale paragraph; the second run finds nothing to replace
-- and is a no-op. Safe to apply repeatedly.
--
-- HOW TO APPLY: Supabase SQL Editor → toggle Enforce RLS OFF → paste → Run.
-- =============================================================================

BEGIN;

-- Sanity check: confirm at least one row contains the stale phrase before
-- we touch anything. (Just a NOTICE; the UPDATE below handles zero matches
-- gracefully.)
DO $$
DECLARE
  match_count int;
BEGIN
  SELECT count(*) INTO match_count
    FROM doc_pages
   WHERE content_md LIKE '%Search is BM25 (Postgres FTS) today%';
  RAISE NOTICE 'Pages containing stale embedding bullet: %', match_count;
END $$;

-- Rewrite the bullet. We match on a unique-enough substring of the old
-- prose; the surrounding markdown structure ("Embedding similarity"
-- heading + bullet body) is preserved.
UPDATE doc_pages
   SET content_md = REPLACE(
         content_md,
         E'Embedding similarity\nSearch is BM25 (Postgres FTS) today. Vector search lands when a hosted embedder is wired.',
         E'Embedding similarity ✅ Wired\nThe hosted backend embeds at save time using a pluggable embedder (default: OpenAI ``text-embedding-3-small``) and fuses BM25 + cosine via Reciprocal Rank Fusion in ``/v1/memories/search``. BM25-only is the fallback when no embedder API key is configured. The local SQLite store has used hybrid (FTS5 + sqlite-vec) since v0.1.0.'
       ),
       updated_at = now()
 WHERE content_md LIKE '%Search is BM25 (Postgres FTS) today%';

-- Some doc-page authoring uses inline phrasing without the explicit heading
-- on its own line. Cover that variant too.
UPDATE doc_pages
   SET content_md = REPLACE(
         content_md,
         'Search is BM25 (Postgres FTS) today. Vector search lands when a hosted embedder is wired.',
         'Hybrid BM25 + cosine via pgvector is wired in /v1/memories/search; default embedder is OpenAI text-embedding-3-small, with a BM25-only fallback when no embedder key is present.'
       ),
       updated_at = now()
 WHERE content_md LIKE '%Search is BM25 (Postgres FTS) today%';

-- Confirm the rewrite actually happened.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
    FROM doc_pages
   WHERE content_md LIKE '%Search is BM25 (Postgres FTS) today%';
  IF remaining > 0 THEN
    RAISE WARNING 'Migration 024 left % page(s) still containing the stale phrase. Manual review needed.', remaining;
  ELSE
    RAISE NOTICE 'Migration 024 OK — stale embedding-similarity bullet has been rewritten everywhere.';
  END IF;
END $$;

COMMIT;
