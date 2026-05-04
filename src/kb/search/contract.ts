import { z } from 'zod';
import type { EntityGraph, KbEntryId, KbIndex, KbMatchSurface, KbResult, KbSearchScope } from '../entry-types.js';
import type { Disposable } from '../../runtime/ports.js';
import { kbCapabilityNameSchema, type KbCapabilityName } from '../capability/contract.js';

export type RetrievalScope = KbSearchScope;
export type RetrievalKind = KbResult['kind'];

/**
 * Engine-blind document shape returned with each FTS hit. Carries the fields
 * KB-tier consumes for snippet anchoring, scope filtering, and freshness gating.
 */
export interface RetrievedDocument {
  readonly entryId: string;
  readonly slug: string;
  readonly kind: RetrievalKind;
  readonly freshness: 'fresh' | 'stale';
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly principles: readonly string[];
}

const kbSearchScopeSchema = z.enum(['notes', 'sources', 'communities', 'all'] satisfies [
  KbSearchScope,
  KbSearchScope,
  KbSearchScope,
  KbSearchScope,
]);

export interface RetrievalRoleDescriptor {
  readonly id: string;
  readonly label: string;
  readonly tags: string[];
  readonly phase: 'retrieval-source';
  readonly supportsScopes: KbSearchScope[];
  // Optional in inputs; always non-undefined ([]) after normalizeRetrievalRoleDescriptor.
  readonly requires?: KbCapabilityName[];
  readonly provides: 'retrieval-source';
}

export const retrievalRoleDescriptorSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    tags: z.array(z.string().min(1)),
    phase: z.literal('retrieval-source'),
    supportsScopes: z.array(kbSearchScopeSchema),
    requires: z.array(kbCapabilityNameSchema).optional(),
    provides: z.literal('retrieval-source'),
  })
  .strict();

export interface RetrievalEvidence {
  readonly roleId: string;
  readonly label: string;
  readonly rank: number;
  readonly weight: number;
  readonly contribution: number;
  readonly match?: KbMatchSurface[];
}

export type RetrievalDiagnosticCode =
  // Role execution observed the caller's abort signal before completion.
  | 'role_aborted'
  // Graph-backed retrieval could not use graph data because it is stale.
  | 'graph_stale'
  // A role required a KB runtime binding that was not available.
  | 'binding_missing'
  // A role failed for a non-setup execution reason.
  | 'role_failed'
  // Planner or executor referenced a descriptor that is not registered.
  | 'descriptor_unregistered';

export interface RetrievalDiagnostic {
  readonly roleId: string;
  readonly code: RetrievalDiagnosticCode;
  readonly recoverable: boolean;
  readonly publicText?: string;
}

export interface RetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
  document?: RetrievedDocument;
  match?: KbMatchSurface[];
}

export interface RoleSearchResult {
  hits: RetrievalHit[];
  diagnostic?: RetrievalDiagnostic;
}

export interface RoleQueryContext {
  readonly rawQuery: string;
  readonly topK: number;
  readonly scope: KbSearchScope;
  readonly signal: AbortSignal;
  /** Lazy memoized normalized query accessor. */
  normalizedQuery(): string;
  /** Lazy memoized token accessor. */
  tokens(): readonly string[];
  /** Lazy memoized query embedding accessor. */
  embedding(): Promise<Float32Array>;
  /** Lazy memoized KB index accessor. */
  index(): KbIndex;
  /** Lazy memoized graph context accessor. */
  graphContext(): EntityGraph | null;
}

export interface RetrievalRole {
  readonly id: string;
  readonly descriptor: RetrievalRoleDescriptor;
  search(ctx: RoleQueryContext): Promise<RoleSearchResult>;
}

export interface FusionProfile {
  readonly classWeights: ReadonlyMap<string, number>;
  readonly overrides: ReadonlyMap<string, number>;
  readonly rrfK: number;
}

export interface RegisteredRetrievalRole {
  readonly role: RetrievalRole;
  readonly descriptor: RetrievalRoleDescriptor;
  readonly origin: 'builtin' | 'external';
  readonly permanence: 'runtime' | 'scoped';
  readonly criticality?: 'core';
}

export type RoleExecutionResult =
  | {
      readonly registeredRole: RegisteredRetrievalRole;
      readonly hits: RetrievalHit[];
      readonly diagnostic?: never;
    }
  | {
      readonly registeredRole: RegisteredRetrievalRole;
      readonly diagnostic: RetrievalDiagnostic;
      readonly hits?: never;
    };

export interface RoleExecutionRegistryView {
  list(): readonly RegisteredRetrievalRole[];
}

export interface RoleCatalogView {
  listDescriptors(): readonly RetrievalRoleDescriptor[];
}

export interface RoleHandle {
  readonly id: string;
  dispose(): void;
}

export interface RoleRegistry {
  registerScoped(role: RetrievalRole, scope: Disposable): RoleHandle;
  registerBuiltin(role: RetrievalRole, options?: { readonly criticality?: 'core' }): RoleHandle;
  unregister(id: string): boolean;
  list(): readonly RegisteredRetrievalRole[];
  executionView(): RoleExecutionRegistryView;
  catalogView(): RoleCatalogView;
}

export interface RetrievalEntry {
  entryId: KbEntryId;
  slug: string;
  kind: RetrievalKind;
  title: string;
  tags: string[];
  principles: string[];
}

export interface RankedRetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
}

export interface TextRetrievalHit extends RankedRetrievalHit {
  document: RetrievedDocument;
}

export type VectorRetrievalHit = RankedRetrievalHit;

export type GraphRetrievalHit = RankedRetrievalHit;

export interface FusedRetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
  document: RetrievedDocument | null;
  evidence: RetrievalEvidence[];
}

export interface TextRetrievalResult {
  hits: TextRetrievalHit[];
}

export interface VectorRetrievalResult {
  hits: VectorRetrievalHit[];
}

export interface GraphRetrievalResult {
  hits: GraphRetrievalHit[];
}

export interface FusedResult {
  hits: FusedRetrievalHit[];
}

/**
 * FTS hit shape returned by `FtsRetrieval.search`. The `documentId` is the
 * KB-owned entry id; `fields` carries the engine-blind document for snippet
 * anchoring and scope filtering.
 */
export interface FtsHit {
  readonly documentId: string;
  readonly score: number;
  readonly fields: RetrievedDocument;
}

export interface FtsSearchResult {
  readonly hits: readonly FtsHit[];
  /** True when the engine has no more results past the requested topK. */
  readonly exhausted: boolean;
}

export interface VectorRetrieval {
  search(embedding: number[], topK: number, scope?: RetrievalScope): Promise<VectorRetrievalResult>;
}

// Graph retrieval stays routed through entity-graph queries and is fused explicitly.
export interface GraphRetrieval {
  search(query: string, scope?: RetrievalScope): Promise<GraphRetrievalResult>;
}

export interface HybridFusion {
  fuse(roleResults: ReadonlyArray<RoleExecutionResult>, profile: FusionProfile): FusedResult;
}
