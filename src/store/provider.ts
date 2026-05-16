/**
 * Provider interface — the same shape whether storage is local SQLite or a
 * remote multi-tenant HTTP backend. The MCP server uses this; swapping
 * providers is a one-line change.
 */

export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  source: string;          // 'manual' | 'claude-export' | 'openai-export' | 'hook' | 'agent'
  source_ref?: string;     // original conversation id, file path, etc.
  metadata?: Record<string, unknown>;
  score?: number;          // populated on search results (BM25 rank or cosine sim)
  created_at: number;
  updated_at: number;
}

export interface SaveMemoryInput {
  content: string;
  namespace?: string;
  tags?: string[];
  source?: string;
  source_ref?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Shared filter fields. The hosted /api/memories endpoints accept all of
 * these too — keeping the shapes identical means SDK code is portable
 * across local + hosted without branching.
 */
export interface MemoryFilters {
  namespace?: string;
  tags?: string[];
  /** v0.2.1 — inclusive epoch-ms date bounds */
  created_after?: number;
  created_before?: number;
  updated_after?: number;
  updated_before?: number;
  /** v0.2.4 — metadata containment (top-level key=value matches via JSON). */
  metadata_filter?: Record<string, unknown>;
}

export interface SearchInput extends MemoryFilters {
  query: string;
  k?: number;
}

export interface ListInput extends MemoryFilters {
  limit?: number;
  offset?: number;
  before?: number;       // legacy unix ms cursor; prefer updated_before
}

/** v0.2.3 — multi-query search in one call. */
export interface BulkSearchInput extends MemoryFilters {
  queries: string[];
  k?: number;
}

export interface BulkSearchResult {
  query: string;
  hits: Memory[];
}

/** v0.2.2 — partial update. Unspecified fields are left untouched. */
export interface UpdateMemoryInput {
  content?: string;
  namespace?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface NamespaceInfo {
  name: string;
  count: number;
  last_updated: number;
}

export interface Provider {
  save(input: SaveMemoryInput): Promise<Memory>;
  search(input: SearchInput): Promise<Memory[]>;
  /** v0.2.3 — run N queries against the same scope; same RTT as one call. */
  bulkSearch?(input: BulkSearchInput): Promise<BulkSearchResult[]>;
  list(input: ListInput): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  /** v0.2.2 — partial update. Re-embeds if content changed. Logs to metadata.history. */
  update?(id: string, patch: UpdateMemoryInput): Promise<Memory | null>;
  delete(id: string): Promise<boolean>;
  namespaces(): Promise<NamespaceInfo[]>;
  bulkSave(inputs: SaveMemoryInput[]): Promise<{ saved: number; errors: number }>;
  close(): Promise<void>;
}
