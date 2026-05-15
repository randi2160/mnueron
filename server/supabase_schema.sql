-- =============================================================================
-- mnueron schema for Supabase
--
-- Differences from the standalone schema.sql:
--   1. Adds CITEXT extension explicitly (not enabled by default on Supabase)
--   2. Uses Supabase's connection model — the app server connects via the
--      pooler with a regular Postgres user, not service_role (which bypasses
--      RLS). RLS does the work.
--   3. Adds explicit GRANTs to the `authenticated` role since Supabase
--      ships that role pre-configured.
--   4. The `mnueron_app` role from the original is replaced by `authenticated`
--      for app queries; service_role is used only for migrations and admin.
--
-- How to apply:
--   1. Create a Supabase project (free tier is fine to start)
--   2. Project Settings → Database → enable `vector` extension
--      (Database → Extensions → search "vector" → toggle on)
--   3. Paste this entire file into the SQL Editor and Run
--   4. Grab the connection string from Project Settings → Database
--      → Connection string → "URI" with "Use connection pooler" enabled
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- -----------------------------------------------------------------------------
-- Identity
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orgs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'free',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               CITEXT UNIQUE NOT NULL,
    name                TEXT,
    password_hash       TEXT,                       -- bcrypt; NULL for SSO-only users
    email_verified_at   TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For existing deployments — additive columns, safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS org_members (
    org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role     TEXT NOT NULL DEFAULT 'member',
    joined   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    name         TEXT,
    scopes       TEXT[] NOT NULL DEFAULT '{read,write}',
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_org  ON api_tokens(org_id);

-- -----------------------------------------------------------------------------
-- Memory data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS namespaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS memories (
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

CREATE INDEX IF NOT EXISTS idx_mem_org             ON memories(org_id);
CREATE INDEX IF NOT EXISTS idx_mem_namespace       ON memories(namespace_id);
CREATE INDEX IF NOT EXISTS idx_mem_org_created     ON memories(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_tags_gin        ON memories USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_mem_tsv             ON memories USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_mem_embedding_hnsw  ON memories USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- Background work
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS observations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id),
    payload     JSONB NOT NULL,
    processed   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obs_unprocessed
    ON observations(processed, created_at) WHERE NOT processed;

CREATE TABLE IF NOT EXISTS imports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id),
    source       TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    item_count   INT NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, source_hash)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    org_id      UUID REFERENCES orgs(id) ON DELETE SET NULL,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_token UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_id   UUID,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- =============================================================================
-- Row-Level Security — same as the standalone schema
-- =============================================================================

ALTER TABLE memories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE namespaces    ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_memories_isolation ON memories;
CREATE POLICY p_memories_isolation ON memories
    USING (org_id::text = current_setting('app.current_org_id', true));

DROP POLICY IF EXISTS p_namespaces_isolation ON namespaces;
CREATE POLICY p_namespaces_isolation ON namespaces
    USING (org_id::text = current_setting('app.current_org_id', true));

DROP POLICY IF EXISTS p_observations_isolation ON observations;
CREATE POLICY p_observations_isolation ON observations
    USING (org_id::text = current_setting('app.current_org_id', true));

DROP POLICY IF EXISTS p_imports_isolation ON imports;
CREATE POLICY p_imports_isolation ON imports
    USING (org_id::text = current_setting('app.current_org_id', true));

DROP POLICY IF EXISTS p_audit_isolation ON audit_log;
CREATE POLICY p_audit_isolation ON audit_log
    USING (org_id::text = current_setting('app.current_org_id', true));

-- Grant access to the `authenticated` role that Supabase ships with.
-- The app server connects, sets app.current_org_id, then queries —
-- RLS scopes everything by org automatically.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    memories, namespaces, observations, imports, audit_log
TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =============================================================================
-- Helper: signup
--
-- Run once to bootstrap your first org + user + API token.
-- Replace the email and run from the SQL Editor.
-- =============================================================================

CREATE OR REPLACE FUNCTION mnueron_signup(
    p_email TEXT,
    p_name  TEXT,
    p_org_slug TEXT,
    p_org_name TEXT,
    p_token_prefix TEXT,
    p_token_hash   TEXT,
    p_token_name   TEXT DEFAULT 'first-token'
) RETURNS TABLE(org_id UUID, user_id UUID, token_id UUID) AS $$
DECLARE
    v_org_id UUID;
    v_user_id UUID;
    v_token_id UUID;
BEGIN
    INSERT INTO orgs (slug, name) VALUES (p_org_slug, p_org_name)
        RETURNING id INTO v_org_id;
    INSERT INTO users (email, name) VALUES (p_email, p_name)
        RETURNING id INTO v_user_id;
    INSERT INTO org_members (org_id, user_id, role)
        VALUES (v_org_id, v_user_id, 'owner');
    INSERT INTO api_tokens (user_id, org_id, token_hash, prefix, name)
        VALUES (v_user_id, v_org_id, p_token_hash, p_token_prefix, p_token_name)
        RETURNING id INTO v_token_id;
    RETURN QUERY SELECT v_org_id, v_user_id, v_token_id;
END;
$$ LANGUAGE plpgsql;
