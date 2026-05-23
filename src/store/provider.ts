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

// ─── P2.3 — Entity resolution (canonical entities + edges) ─────────────────

/**
 * A canonical entity row — one per unique person/org/project/etc. resolved
 * across all memories in the store. `aliases` collects every surface form
 * we've seen (e.g., John Doe ← "Johnny", "John D.", "@johndoe").
 */
export interface Entity {
  id: string;
  display_name: string;
  entity_type: string;
  aliases: string[];
  mention_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface EntityListInput {
  /** Filter by entity type (person, organization, project, ...). */
  type?: string;
  /** Substring match on display_name OR any alias. Case-insensitive. */
  q?: string;
  limit?: number;
  offset?: number;
  /** Sort: 'recent' (last_seen_at desc, default) | 'mentions' | 'alpha'. */
  sort?: 'recent' | 'mentions' | 'alpha';
}

/** Returned from getEntityMemories — memory + the surface form used. */
export interface EntityMemoryHit extends Memory {
  surface_form: string;
  confidence: number;
}

// ─── P3 + P4 — Knowledge graph (relations + temporal) ──────────────────────

/** One relationship edge between two canonical entities. */
export interface Relation {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  /** Lowercase snake_case verb phrase (e.g. "recommended", "works_at"). */
  predicate: string;
  /** Source memory id — provenance for the assertion. */
  memory_id: string;
  /** Extractor's confidence [0, 1]. */
  confidence: number;
  /** P4 — epoch ms when the fact became true. null = unspecified. */
  valid_from: number | null;
  /** P4 — epoch ms when it stopped (null = still true or unspecified). */
  valid_to: number | null;
  /** When mnueron learned the fact (recorded into the store). */
  recorded_at: number;
}

export interface GetRelationsInput {
  /** Limit to edges where this entity is the source (outgoing). */
  fromEntityId?: string;
  /** Limit to edges where this entity is the target (incoming). */
  toEntityId?: string;
  /** Filter by predicate (exact match). */
  predicate?: string;
  /**
   * P4 — bi-temporal filter. When set, only return edges that were valid
   * AT this point in time. An edge is valid at T iff:
   *   (valid_from IS NULL OR valid_from <= T)  AND
   *   (valid_to   IS NULL OR valid_to   >  T)
   * Edges with NO temporal info match all `asOf` queries (the fact has no
   * known validity window — best-effort recall).
   */
  asOf?: number;
  limit?: number;
}

/** One node in a graph traversal. */
export interface TraverseHop {
  entity: Entity;
  /** Edge that took us here from the previous hop. Null for the seed entity. */
  via: Relation | null;
  /** Direction of the edge relative to the previous hop. 'out' = previous → here, 'in' = here → previous. */
  direction: 'out' | 'in' | null;
  /** Distance from the seed entity in hops (0 = seed itself). */
  depth: number;
}

// ─── P5 — Self-revising memory (consolidation proposals) ───────────────────

export type ProposalKind = 'duplicate' | 'contradiction' | 'stale';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface ConsolidationProposal {
  id: string;
  kind: ProposalKind;
  memory_a_id: string;
  memory_b_id: string;
  score: number;
  status: ProposalStatus;
  note: string | null;
  proposed_at: number;
  reviewed_at: number | null;
}

export interface ConsolidationScanResult {
  scanned: number;
  proposalsCreated: number;
  proposalsAlreadyKnown: number;
}

// ─── Procedural memory ────────────────────────────────────────────────────

export interface ProceduralStep {
  step: string;
  code?: string;
  why?: string;
}

export interface ProceduralMemoryView {
  id: string;
  namespace: string;
  name: string;
  summary: string;
  steps: ProceduralStep[];
  tools: string[];
  last_used_at: number;
  use_count: number;
  created_at: number;
}

export interface SaveProceduralInputView {
  name: string;
  namespace?: string;
  summary?: string;
  steps: ProceduralStep[];
  tools?: string[];
}

// ─── Provider contract ─────────────────────────────────────────────────────

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

  // ── P2.3 — Entity API ────────────────────────────────────────────────
  // Optional on the interface (not every provider exposes them yet) but the
  // local SQLite provider implements all four. Hosted exposes them via
  // /api/entities/* and the SDK's `entities` namespace will mirror these.
  /** List canonical entities with filtering + sort. */
  listEntities?(input: EntityListInput): Promise<Entity[]>;
  /** Get a single canonical entity by id. */
  getEntity?(id: string): Promise<Entity | null>;
  /** List memories linked to this canonical entity (most recent first). */
  getEntityMemories?(id: string, limit?: number): Promise<EntityMemoryHit[]>;
  /**
   * Merge two canonical entities. After merge, `loserId` no longer exists;
   * all memory_entities edges and aliases are absorbed into `winnerId`.
   * Returns the merged winner row, or null if either id is missing.
   */
  mergeEntities?(winnerId: string, loserId: string): Promise<Entity | null>;

  /**
   * P2.3 backfill helper — run the resolver against entities already
   * stored in `metadata.entities` of an existing memory. Populates the
   * `entities` and `memory_entities` tables, and returns the resolutions
   * so the caller can stamp `canonical_id` onto the memory's metadata.
   *
   * Used by `mnueron entities backfill` to retro-fit canonical IDs onto
   * memories that were saved before the resolver shipped.
   */
  backfillResolveMemory?(
    memoryId: string,
    extracted: Array<{ name: string; type: string; context?: string }>,
    opts?: { anthropicKey?: string },
  ): Promise<Array<{ canonical_id: string; confidence: number; created: boolean } | null>>;

  // ── P3 + P4 — Knowledge graph ────────────────────────────────────────
  /**
   * Fetch relation edges with optional filters (from/to/predicate) and
   * the P4 `asOf` bi-temporal filter. When no filter is set, returns the
   * most recent N edges across the whole graph.
   */
  getRelations?(input: GetRelationsInput): Promise<Relation[]>;
  /**
   * BFS-traverse from a seed entity out to `depth` hops, returning every
   * node visited along with the edge that took you there. Optional
   * `asOf` filter respects the P4 temporal window on each edge.
   *
   * Default depth = 2 (the seed itself + its direct relations + the
   * relations of those). Capped to 5 internally to keep large graphs sane.
   */
  traverseGraph?(seedEntityId: string, opts?: {
    depth?: number;
    asOf?: number;
  }): Promise<TraverseHop[]>;

  // ── P5 — Self-revising memory ────────────────────────────────────────
  /**
   * Phase 5a — pure detection pass. Walks recent memories, finds likely
   * duplicates via embedding similarity, and inserts pending proposals
   * the user can review with `proposalsList()` / `proposalReview()`.
   *
   * Idempotent: re-running won't double-create proposals for the same
   * (memory_a, memory_b, kind) triple.
   */
  detectConsolidation?(opts?: {
    limit?: number;
    threshold?: number;
    namespace?: string;
  }): Promise<ConsolidationScanResult>;
  /** List proposals, filterable by status / kind. */
  proposalsList?(opts?: {
    status?: ProposalStatus;
    kind?: ProposalKind;
    limit?: number;
    offset?: number;
  }): Promise<ConsolidationProposal[]>;
  /** Mark a proposal approved or rejected. Phase 5a leaves the underlying
   *  memories alone either way; phase 5b will act on 'approved' merges. */
  proposalReview?(
    id: string,
    decision: 'approved' | 'rejected',
  ): Promise<ConsolidationProposal | null>;

  // ── Procedural memory (Mem0-leapfrog feature) ────────────────────────
  /** Save (UPSERT) a procedural memory keyed by (namespace, name). */
  saveProcedural?(input: SaveProceduralInputView): Promise<ProceduralMemoryView>;
  /** Look up a procedural memory by name within a namespace. */
  getProcedural?(name: string, namespace?: string): Promise<ProceduralMemoryView | null>;
  /** List procedural memories, most-recently-used first. */
  listProcedural?(opts?: { namespace?: string; limit?: number }): Promise<ProceduralMemoryView[]>;
  /** Recall — bump last_used_at + use_count and return the runbook. */
  recallProcedural?(name: string, namespace?: string): Promise<ProceduralMemoryView | null>;
  /** Hard-delete a procedural memory by id. */
  deleteProcedural?(id: string): Promise<boolean>;

  close(): Promise<void>;
}
