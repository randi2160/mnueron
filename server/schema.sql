-- =============================================================================
-- mnueron hosted backend — Postgres schema with multi-tenant isolation
--
-- Tenancy model:
--   - Each company is an `org`.
--   - Users belong to one or more orgs via `org_members`.
--   - API tokens are bound to a (user, org, namespace?) triple.
--   - Memories are scoped by org_id. Row-Level Security (RLS) on `memories`
--     enforces this AT THE DATABASE LEVEL — even a bug in app code can't
--     leak memories across orgs as long as connections run with the
--     `mnueron_app` role and set `app.current_org_id`.
--
-- Required extensions:
--   pgvector  for embeddings
--   pgcrypto  for gen_random_uuid()
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Identity
-- -----------------------------------------------------------------------------

CREATE TABLE orgs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'free',     -- 'free' | 'pro' | 'team' | 'enterprise'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               CITEXT UNIQUE NOT NULL,
    name                TEXT,
    password_hash       TEXT,                       -- bcrypt; NULL for SSO-only users
    email_verified_at   TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user can belong to multiple orgs (personal + work, multiple clients, etc.)
CREATE TABLE org_members (
    org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role     TEXT NOT NULL DEFAULT 'member',     -- 'owner' | 'admin' | 'member'
    joined   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);

-- API tokens. We store only the hash. `prefix` is the first 8 chars
-- for display in the dashboard ("mn_abc12345...").
CREATE TABLE api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,           -- SHA-256 of the raw token
    prefix       TEXT NOT NULL,                  -- first 8 chars, plaintext
    name         TEXT,                           -- "laptop", "ci", "claude-app"
    scopes       TEXT[] NOT NULL DEFAULT '{read,write}',
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tokens_user ON api_tokens(user_id);
CREATE INDEX idx_tokens_org  ON api_tokens(org_id);

-- -----------------------------------------------------------------------------
-- Memory data
-- -----------------------------------------------------------------------------

-- Namespaces let one org separate memory pools — e.g. one per app, project,
-- or team. Two apps under the same org account get clean separation here.
CREATE TABLE namespaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, name)
);

-- The memory table. Embedding is 1536-d (OpenAI text-embedding-3-small).
-- If you switch to a different embedding model, run a migration.
CREATE TABLE memories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  UUID NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    created_by    UUID REFERENCES users(id),
    content       TEXT NOT NULL,
    content_tsv   TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    source        TEXT NOT NULL DEFAULT 'agent',
    source_ref    TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding     VECTOR(1536),
    decay_score   REAL NOT NULL DEFAULT 1.0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mem_org             ON memories(org_id);
CREATE INDEX idx_mem_namespace       ON memories(namespace_id);
CREATE INDEX idx_mem_org_created     ON memories(org_id, created_at DESC);
CREATE INDEX idx_mem_tags_gin        ON memories USING gin (tags);
CREATE INDEX idx_mem_tsv             ON memories USING gin (content_tsv);
CREATE INDEX idx_mem_embedding_hnsw  ON memories USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- Background work
-- -----------------------------------------------------------------------------

-- Raw observations from hooks. Workers process these into memories
-- asynchronously (embed + optionally summarize, then upsert into `memories`).
CREATE TABLE observations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id),
    payload     JSONB NOT NULL,
    processed   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_obs_unprocessed ON observations(processed, created_at) WHERE NOT processed;

-- Imports table: tracks bulk imports so we can resume / dedupe.
CREATE TABLE imports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id),
    source       TEXT NOT NULL,                -- 'claude-export' | 'openai-export'
    source_hash  TEXT NOT NULL,                -- sha256 of file
    item_count   INT NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, source_hash)               -- prevent dupe re-import
);

-- -----------------------------------------------------------------------------
-- Audit log (cheap to write, helpful for support and compliance)
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    org_id      UUID REFERENCES orgs(id) ON DELETE SET NULL,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_token UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,                 -- 'memory.save' | 'memory.delete' | ...
    target_id   UUID,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- =============================================================================
-- Row-Level Security
--
-- The application role connects, then sets `app.current_org_id` per request
-- after resolving the bearer token. RLS uses that GUC to scope queries.
-- =============================================================================

CREATE ROLE mnueron_app NOLOGIN;

ALTER TABLE memories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE namespaces    ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_memories_isolation ON memories
    USING (org_id::text = current_setting('app.current_org_id', true));
CREATE POLICY p_namespaces_isolation ON namespaces
    USING (org_id::text = current_setting('app.current_org_id', true));
CREATE POLICY p_observations_isolation ON observations
    USING (org_id::text = current_setting('app.current_org_id', true));
CREATE POLICY p_imports_isolation ON imports
    USING (org_id::text = current_setting('app.current_org_id', true));
CREATE POLICY p_audit_isolation ON audit_log
    USING (org_id::text = current_setting('app.current_org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON
    memories, namespaces, observations, imports, audit_log
TO mnueron_app;

-- Identity tables are NOT scoped by org — app code accesses them only via
-- a privileged migration role, never via `mnueron_app`.

-- =============================================================================
-- Sanity-check function: are we leaking? Useful in tests.
-- =============================================================================

CREATE OR REPLACE FUNCTION assert_org_scope() RETURNS VOID AS $$
BEGIN
    IF current_setting('app.current_org_id', true) IS NULL THEN
        RAISE EXCEPTION 'app.current_org_id is not set — refusing query';
    END IF;
END;
$$ LANGUAGE plpgsql;
