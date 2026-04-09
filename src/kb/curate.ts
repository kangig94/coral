import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  errorMessage,
  isNoEntryError,
  isRecord,
  isStringArray,
  nowIsoString,
  unlinkIfExists,
} from '../shared/utils.js';
import {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  getCurateRepairFrontier,
  isClaimStale,
  migrateCurateStateIfNeeded,
  normalizeCurateStateRepairFrontier,
  readCurateState,
  sameStringList,
  writeCurateState,
  type CurateCursor,
  type CurateRepairFrontier,
  type CurateState,
  type PendingDiscovery,
} from './curate-state.js';
import {
  buildCommunityDocuments,
  buildEntityRelationshipGraph,
  computeCommunitySummaryInputFingerprintForCommunity,
  computeCommunityTopologyFingerprint,
  detectCommunities,
  type ExistingGeneratedCommunity,
  generateCommunityFiles,
  generateCommunitySummary,
  loadExistingCommunityState,
  renderCommunityDocument,
} from './community-detection.js';
import {
  consolidateEntityGraph,
  resolveCanonicalEntityId,
  type ConsolidationResult,
  type EntityConsolidationDelta,
  type EntityReplacementMap,
} from './entity-consolidation.js';
import {
  deriveNoteIdentity,
  extractPrincipleStatement,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
  replaceFrontmatter,
  replaceSourceFrontmatter,
} from './frontmatter.js';
import { loadKbNote, loadKbSource } from './read.js';
import { assertNonEmptyText, assertNoteSlug, compareLocale, stripMarkdownCodeFences } from './validation.js';
import {
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneKbIndex,
  markTextIndexStale,
  recordMetadataMutation,
  writeFileAtomic,
} from './mutation-helpers.js';
import type { KbRuntime } from './contracts.js';
import { runEntrySeqUpgradeGuard } from './runtime.js';
import { rebuildTextArtifactsAndPersistRepairState } from './text-artifacts.js';
import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  getEntry,
  isNoteEntry,
  parseKbEntryId,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type CuratableEntry,
  type EntityGraph,
  type EntityMeta,
  type EntityRelationship,
  type EntityType,
  type KbEntryId,
  type KbIndex,
  type NoteEntry,
  type RelationshipType,
} from './types.js';
import { backendLog } from '../shared/backend-log.js';

const CURATE_SCHEDULE_DEBOUNCE_MS = 60 * 1000;
const CURATE_MIN_CLAIM_SIZE = 10;
const CURATE_IMMEDIATE_CLAIM_SIZE = 30;
const CURATE_MAX_CLAIM_SIZE = 100;
const CLASSIFICATION_BATCH_SIZE = 100;
const CLASSIFICATION_REQUEST_TOKEN_BUDGET = 16_000;
const CLASSIFICATION_RESPONSE_TOKEN_HEADROOM = 4_000;
const CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT = 4_000;
const CLASSIFICATION_SOURCE_EXCERPT_TOKEN_LIMIT = 2_000;
const DISCOVERY_NEW_NOTE_THRESHOLD = 50;
const DISCOVERY_BATCH_SIZE = 100;
const DISCOVERY_PROMPT_BODY_LIMIT = 4000;
const DISCOVERY_MAX_MERGES = 2;
const DISCOVERY_MAX_REFINES = 3;
const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 90;
const USAGE_WK_THRESHOLD = 100;

const CURATE_STALE_REASON = 'KB text snapshot is stale after kb_curate.';
const GITIGNORE_ENTRIES = ['data/', '.obsidian/'];
const ENTITY_TYPE_PROMPT_GUIDANCE: ReadonlyArray<readonly [EntityType, string]> = [
  ['technology', 'a concrete technical capability, platform, or system'],
  ['pattern', 'a reusable design or implementation approach'],
  ['concept', 'an abstract idea, model, or mental frame'],
  ['library', 'a package, framework, SDK, or API surface'],
  ['component', 'a bounded module, service, or subsystem'],
  ['domain', 'a business or problem-space area'],
  ['operation', 'a workflow, procedure, or runtime activity'],
  ['quality', 'a non-functional property, constraint, or attribute'],
];
const RELATIONSHIP_TYPE_PROMPT_GUIDANCE: ReadonlyArray<readonly [RelationshipType, string]> = [
  ['enables', 'source makes target possible'],
  ['requires', 'source depends on target'],
  ['constrains', 'source limits or governs target'],
  ['implements', 'source realizes target'],
  ['specializes', 'source is a narrower form of target'],
  ['conflicts-with', 'source is incompatible with target'],
  ['precedes', 'source comes before target in time or flow'],
  ['composes', 'source contains or assembles target'],
  ['abstracts', 'source generalizes or hides target details'],
  ['replaces', 'source supersedes target'],
];

function isUsageBudgetExhausted(): boolean {
  try {
    const cachePath = join(homedir(), '.claude', 'hud', '.coral-cache.json');
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    const entry = raw.claude as
      | { ts?: number; data?: { fiveHour?: number; weekly?: number }; error?: boolean }
      | undefined;
    if (!entry?.ts || !entry.data || entry.error) {
      return false;
    }
    if (Date.now() - entry.ts > USAGE_CACHE_STALE_MS) {
      return false;
    }
    const { fiveHour, weekly } = entry.data;
    if (typeof fiveHour === 'number' && fiveHour >= USAGE_5H_THRESHOLD) {
      return true;
    }
    if (typeof weekly === 'number' && weekly >= USAGE_WK_THRESHOLD) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
const GITIGNORE_HEADER = '# Coral KB runtime (device-local, auto-managed)';

type SpawnCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type SpawnCliFn = (options: {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  pool?: 'default' | 'discuss' | 'curate';
  signal?: AbortSignal;
}) => Promise<SpawnCliResult>;

type NoteClaimCandidate = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  updatedAt: string;
  cursor: CurateCursor;
};

type SourceClaimCandidate = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  cursor: CurateCursor;
};

type ClaimCandidate = NoteClaimCandidate | SourceClaimCandidate;

type NoteCurateClaimedEntry = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  entrySeq: number;
};

type SourceCurateClaimedEntry = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  claimTimeFingerprint: string;
  entrySeq: number;
};

export type CurateClaimedEntry = NoteCurateClaimedEntry | SourceCurateClaimedEntry;
type DiscoveryCurateClaimedEntry = NoteCurateClaimedEntry;

function isNoteClaimedEntry(entry: CurateClaimedEntry): entry is NoteCurateClaimedEntry {
  return entry.kind === 'note';
}

type NoteMetadataTarget = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  entrySeq: number;
  claimTimeUpdatedAt: string;
  addTags?: string[];
  addRelated?: string[];
  desiredTags?: string[];
  addPrinciples?: string[];
  removePrinciples?: string[];
  removeTags?: string[];
};

export type ClassificationNewEntity = {
  type: EntityType;
  description: string;
};

export type ClassificationRelationship = {
  source: string;
  target: string;
  type: RelationshipType;
  description: string;
};

export type ClassificationAssignment = {
  entry: string;
  tags: string[];
  principles?: string[];
  related?: string[];
  newEntities?: Record<string, ClassificationNewEntity>;
  relationships?: ClassificationRelationship[];
};

type ClassificationPromptVocabularyEntry = {
  name: string;
  type: EntityType;
  description: string;
  relevant: boolean;
  support: number;
};

type ClassificationPromptVocabularyInput = readonly string[] | readonly ClassificationPromptVocabularyEntry[];

export type DiscoveryProposal = {
  slug: string;
  statement: string;
  notes: string[];
  absorbs?: string[];
};

type EnsurePrincipleDocumentResult = {
  status: 'ready' | 'conflict';
  state: CurateState;
};

export type MetadataTarget =
  | {
      kind: 'source';
      entryId: KbEntryId;
      slug: string;
      entrySeq: number;
      claimTimeFingerprint: string;
      addTags?: string[];
      desiredTags?: string[];
      addRelated?: string[];
      removeTags?: string[];
    }
  | NoteMetadataTarget;

export type CurateClaim = {
  entries: CurateClaimedEntry[];
  through: CurateCursor;
};

type LiveMetadataDecision = {
  shouldWrite: boolean;
  nextTags: string[];
  nextPrinciples: string[];
};

type ParsedArrayResult = {
  entries: unknown[];
  parseFailed: boolean;
};

export type CurateHandle = {
  start(): Promise<void>;
  schedule(): void;
  scheduleDeferredCommit(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  _testInternals?: {
    claimCurateRun(today: string): Promise<CurateClaim | null>;
    runClassificationBatches(claim: CurateClaim, index: KbIndex): Promise<ClassificationAssignment[]>;
    commitMetadataTargets(targets: MetadataTarget[]): Promise<void>;
    runPrincipleDiscovery(processedThrough: CurateCursor): Promise<void>;
    recordCurateFailure(through: CurateCursor | null, error: unknown): Promise<void>;
    clearCurateRetryState(): Promise<void>;
    recordDiscoveryAttempt(highSeq: number, nextOffset: number): Promise<void>;
    addPendingDiscovery(entry: PendingDiscovery): Promise<void>;
    removePendingDiscovery(entry: PendingDiscovery): Promise<void>;
    runCommunitySubphase(): Promise<boolean>;
    migrateCurateStateIfNeeded(): Promise<void>;
  };
};

class CurateJsonParseError extends Error {
  constructor(phase: 'classification' | 'discovery') {
    super(`Curate ${phase} returned invalid JSON.`);
    this.name = 'CurateJsonParseError';
  }
}

class CurateRunError extends Error {
  readonly through: CurateCursor | null;

  readonly cause: unknown;

  constructor(through: CurateCursor | null, cause: unknown) {
    super(errorMessage(cause));
    this.name = 'CurateRunError';
    this.through = through;
    this.cause = cause;
  }
}

function buildFlatList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function fingerprintEntryContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function parseJsonArray(raw: string): ParsedArrayResult {
  const normalized = stripMarkdownCodeFences(raw.trim());
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      parseFailed: true,
    };
  }

  return {
    entries: parsed,
    parseFailed: false,
  };
}

function uniqueTrimmedList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function isKnownEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

function isKnownRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

function tokenizeLowercaseText(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function classificationEntityNameSegments(value: string): string[] {
  return value.split('-').filter((segment) => segment.length > 0);
}

function isDescriptiveEntityName(value: string, minimumSegments = 2): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) && classificationEntityNameSegments(value).length >= minimumSegments;
}

function hasNonEmptyDescription(value: string): boolean {
  return value.trim().length > 0;
}

function cloneEntityMetaMap(entityMeta: Record<string, EntityMeta>): Record<string, EntityMeta> {
  return Object.fromEntries(
    Object.entries(entityMeta).map(([entityName, meta]) => [
      entityName,
      {
        type: meta.type,
        description: meta.description,
        ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases] }),
      },
    ]),
  );
}

function cloneEntityRelationships(relationships: EntityRelationship[]): EntityRelationship[] {
  return relationships.map((relationship) => ({
    source: relationship.source,
    target: relationship.target,
    type: relationship.type,
    description: relationship.description,
    evidence: [...relationship.evidence],
  }));
}

function snapshotEntityGraph(index: KbIndex): EntityGraph {
  return {
    entityMeta: cloneEntityMetaMap(index.entityMeta ?? {}),
    relationships: cloneEntityRelationships(index.relationships ?? []),
  };
}

function entityGraphsEqual(left: EntityGraph, right: EntityGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildEntitySupportMap(index: KbIndex): Map<string, number> {
  const support = new Map<string, number>();

  for (const entry of Object.values(index.entries)) {
    if (!('tags' in entry)) {
      continue;
    }

    for (const tag of new Set(entry.tags)) {
      support.set(tag, (support.get(tag) ?? 0) + 1);
    }
  }

  for (const relationship of index.relationships ?? []) {
    const evidenceCount = uniqueTrimmedList(relationship.evidence).length;
    if (evidenceCount === 0) {
      continue;
    }

    support.set(relationship.source, (support.get(relationship.source) ?? 0) + evidenceCount);
    support.set(relationship.target, (support.get(relationship.target) ?? 0) + evidenceCount);
  }

  return support;
}

function buildClassificationContext(
  entries: CurateClaimedEntry[],
  index: KbIndex,
): {
  liveTags: Set<string>;
  tokenSet: Set<string>;
} {
  const liveTags = new Set<string>();
  const tokenSet = new Set<string>();

  const addTokens = (value: string) => {
    for (const token of tokenizeLowercaseText(value)) {
      tokenSet.add(token);
    }
  };

  for (const entry of entries) {
    const liveEntry = getEntry(index, entry.entryId);
    if (liveEntry !== undefined && 'tags' in liveEntry) {
      for (const tag of liveEntry.tags) {
        liveTags.add(tag);
        addTokens(tag);
      }
    }

    addTokens(entry.title);
    addTokens(entry.body.slice(0, 4_000));

    if (entry.kind === 'note') {
      const identity = deriveNoteIdentity(entry.slug);
      addTokens(identity.domain);
      addTokens(identity.topic);
    }
  }

  return {
    liveTags,
    tokenSet,
  };
}

function buildClassificationPromptVocabulary(
  entries: CurateClaimedEntry[],
  index: KbIndex,
): ClassificationPromptVocabularyEntry[] {
  const entityMeta = index.entityMeta ?? {};
  const entityNames = Object.keys(entityMeta);
  if (entityNames.length === 0) {
    return [];
  }

  const support = buildEntitySupportMap(index);
  const { liveTags, tokenSet } = buildClassificationContext(entries, index);
  const relationships = index.relationships ?? [];

  const ranked = entityNames
    .map((name) => {
      const meta = entityMeta[name];
      const relevantByRelationship = relationships.some(
        (relationship) =>
          (relationship.source === name && liveTags.has(relationship.target)) ||
          (relationship.target === name && liveTags.has(relationship.source)),
      );
      const relevant =
        liveTags.has(name) ||
        relevantByRelationship ||
        classificationEntityNameSegments(name).some((segment) => tokenSet.has(segment));

      return {
        name,
        type: meta.type,
        description: meta.description,
        relevant,
        support: support.get(name) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        Number(right.relevant) - Number(left.relevant) ||
        right.support - left.support ||
        compareLocale(left.name, right.name),
    );

  const selected: ClassificationPromptVocabularyEntry[] = [];
  let consumedTokens = 0;

  for (const candidate of ranked) {
    const renderedLine =
      candidate.relevant && candidate.description
        ? `- ${candidate.name}: ${candidate.type} (${candidate.description})`
        : `- ${candidate.name}: ${candidate.type}`;
    const lineTokens = approximateTokenCount(renderedLine);
    if (selected.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
      continue;
    }

    selected.push(candidate);
    consumedTokens += lineTokens;
  }

  return selected;
}

function normalizeClassificationPromptVocabulary(
  vocabulary: ClassificationPromptVocabularyInput,
): ClassificationPromptVocabularyEntry[] {
  const seen = new Set<string>();
  const normalized: ClassificationPromptVocabularyEntry[] = [];
  let consumedTokens = 0;

  for (const value of vocabulary) {
    const entry =
      typeof value === 'string'
        ? {
            name: value.trim(),
            type: 'concept' as const,
            description: '',
            relevant: false,
            support: 0,
          }
        : {
            name: value.name.trim(),
            type: value.type,
            description: value.description.trim(),
            relevant: value.relevant,
            support: value.support,
          };
    if (!entry.name || seen.has(entry.name)) {
      continue;
    }

    const renderedLine =
      entry.relevant && entry.description
        ? `- ${entry.name}: ${entry.type} (${entry.description})`
        : `- ${entry.name}: ${entry.type}`;
    const lineTokens = approximateTokenCount(renderedLine);
    if (normalized.length > 0 && consumedTokens + lineTokens > CLASSIFICATION_ENTITY_VOCAB_TOKEN_LIMIT) {
      continue;
    }

    seen.add(entry.name);
    normalized.push(entry);
    consumedTokens += lineTokens;
  }

  return normalized;
}

function renderClassificationPromptVocabulary(vocabulary: ClassificationPromptVocabularyInput): string {
  const normalized = normalizeClassificationPromptVocabulary(vocabulary);
  if (normalized.length === 0) {
    return '- (none yet)';
  }

  return normalized
    .map((entry) =>
      entry.relevant && entry.description
        ? `- ${entry.name}: ${entry.type} (${entry.description})`
        : `- ${entry.name}: ${entry.type}`,
    )
    .join('\n');
}

function buildPrincipleNames(index: KbIndex): string[] {
  return Object.keys(index.principles).sort(compareLocale);
}

function getIndexNote(index: KbIndex, note: string): NoteEntry | undefined {
  const entry = getEntry(index, noteEntryId(note));
  return entry !== undefined && isNoteEntry(entry) ? entry : undefined;
}

function getCuratableEntries(index: KbIndex): CuratableEntry[] {
  return Object.values(index.entries).filter(
    (entry): entry is CuratableEntry => isNoteEntry(entry) || isSourceEntry(entry),
  );
}

function getDiscoveryNotes(index: KbIndex): NoteEntry[] {
  return Object.values(index.entries).filter(isNoteEntry);
}

function compareOptionalCursor(left: CurateCursor | null, right: CurateCursor): number {
  if (left === null) {
    return -1;
  }

  return compareCursor(left, right);
}

function isCursorBeforeRepairFrontier(cursor: CurateCursor, frontier: CurateRepairFrontier): boolean {
  if (frontier.kind === 'none') {
    return true;
  }
  if (frontier.kind === 'unknown') {
    return false;
  }

  return compareCursor(cursor, frontier.cursor) < 0;
}

function filterCandidatesBeforeRepairFrontier<T extends { cursor: CurateCursor }>(
  candidates: T[],
  frontier: CurateRepairFrontier,
): T[] {
  if (frontier.kind === 'none') {
    return candidates;
  }

  return candidates.filter((candidate) => isCursorBeforeRepairFrontier(candidate.cursor, frontier));
}

function noteCursor(note: string, entrySeq: number): CurateCursor {
  return {
    entryId: noteEntryId(note),
    entrySeq,
  };
}

function sourceCursor(slug: string, entrySeq: number): CurateCursor {
  return {
    entryId: sourceEntryId(slug),
    entrySeq,
  };
}

function compareCursorDates(target: string | null, now: string): number {
  if (target === null) {
    return Number.NEGATIVE_INFINITY;
  }

  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  return targetMs - nowMs;
}

function collectClaimCandidates(index: KbIndex): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];
  for (const entry of getCuratableEntries(index)) {
    if (entry.entrySeq === undefined) continue;

    if (isNoteEntry(entry)) {
      candidates.push({
        kind: 'note',
        entryId: noteEntryId(entry.slug),
        slug: entry.slug,
        updatedAt: entry.updatedAt,
        cursor: noteCursor(entry.slug, entry.entrySeq),
      });
    } else {
      candidates.push({
        kind: 'source',
        entryId: sourceEntryId(entry.slug),
        slug: entry.slug,
        cursor: sourceCursor(entry.slug, entry.entrySeq),
      });
    }
  }
  return candidates.sort((left, right) => compareCursor(left.cursor, right.cursor));
}

function collectDiscoveryCandidates(index: KbIndex): NoteClaimCandidate[] {
  return getDiscoveryNotes(index)
    .flatMap((noteMeta) =>
      noteMeta.entrySeq === undefined
        ? []
        : [
            {
              kind: 'note' as const,
              entryId: noteEntryId(noteMeta.slug),
              slug: noteMeta.slug,
              updatedAt: noteMeta.updatedAt,
              cursor: noteCursor(noteMeta.slug, noteMeta.entrySeq),
            },
          ],
    )
    .sort((left, right) => compareCursor(left.cursor, right.cursor));
}

function pendingExtendsBeyondCursor(pendingEntries: ClaimCandidate[], cursor: CurateCursor | null): boolean {
  if (cursor === null || pendingEntries.length === 0) {
    return false;
  }

  return compareCursor(pendingEntries[pendingEntries.length - 1].cursor, cursor) > 0;
}

function cursorFromTarget(target: MetadataTarget): CurateCursor {
  return {
    entryId: target.entryId,
    entrySeq: target.entrySeq,
  };
}

function compareMetadataTarget(left: MetadataTarget, right: MetadataTarget): number {
  return compareCursor(cursorFromTarget(left), cursorFromTarget(right));
}

function advanceProcessedThrough(
  processedThrough: CurateCursor | null,
  cursorCanAdvance: boolean,
  cursor: CurateCursor,
): CurateCursor | null {
  if (!cursorCanAdvance || compareOptionalCursor(processedThrough, cursor) >= 0) {
    return processedThrough;
  }

  return cursor;
}

function buildLiveNoteMetadataDecision(
  target: NoteMetadataTarget,
  liveTags: string[],
  livePrinciples: string[],
): LiveMetadataDecision {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const addPrinciples = uniqueTrimmedList(target.addPrinciples ?? []);
  const removePrinciples = uniqueTrimmedList(target.removePrinciples ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined ? undefined : uniqueTrimmedList(target.desiredTags);

  const removeTagSet = new Set(removeTags);
  const nextTags = desiredTags ?? uniqueTrimmedList([...liveTags, ...addTags]).filter((tag) => !removeTagSet.has(tag));

  const removePrincipleSet = new Set(removePrinciples);
  const nextPrinciples = uniqueTrimmedList([...livePrinciples, ...addPrinciples]).filter(
    (principle) => !removePrincipleSet.has(principle),
  );

  return {
    shouldWrite: !sameStringList(nextTags, liveTags) || !sameStringList(nextPrinciples, livePrinciples),
    nextTags,
    nextPrinciples,
  };
}

function buildLiveSourceMetadataDecision(
  target: Extract<MetadataTarget, { kind: 'source' }>,
  liveTags: string[],
): string[] {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined ? undefined : uniqueTrimmedList(target.desiredTags);
  const removeTagSet = new Set(removeTags);

  return desiredTags ?? uniqueTrimmedList([...liveTags, ...addTags]).filter((tag) => !removeTagSet.has(tag));
}

function buildLiveRelatedMetadata(target: MetadataTarget, liveRelated: string[]): string[] {
  const addRelated = uniqueTrimmedList(target.addRelated ?? []);
  if (addRelated.length === 0) {
    return [...liveRelated];
  }

  const existing = new Set(liveRelated);
  const additions = addRelated.filter((relatedEntryId) => !existing.has(relatedEntryId));
  if (additions.length === 0) {
    return [...liveRelated];
  }

  return [...liveRelated, ...additions];
}

function truncateDiscoveryBody(body: string): string {
  return body.slice(0, DISCOVERY_PROMPT_BODY_LIMIT);
}

function extractDiscoveryProposals(entries: unknown[]): DiscoveryProposal[] {
  const proposals: DiscoveryProposal[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.slug !== 'string' ||
      typeof entry.statement !== 'string' ||
      !isStringArray(entry.notes) ||
      (entry.absorbs !== undefined && !isStringArray(entry.absorbs))
    ) {
      continue;
    }

    proposals.push({
      slug: entry.slug,
      statement: entry.statement,
      notes: [...entry.notes],
      ...(entry.absorbs === undefined ? {} : { absorbs: [...entry.absorbs] }),
    });
  }

  return proposals;
}

function normalizeDiscoverySlug(raw: string): string | null {
  try {
    return assertNoteSlug(raw, 'slug');
  } catch {
    return null;
  }
}

export type DiscoveryBatch = {
  selected: NoteClaimCandidate[];
  nextHighSeq: number;
  nextOffset: number;
};

type PreparedDiscoveryBatch = {
  batch: DiscoveryBatch;
  processedThrough: CurateCursor;
  state: CurateState;
};

function sameDiscoverySelection(left: NoteClaimCandidate[], right: NoteClaimCandidate[]): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => {
      const other = right[index];
      return other !== undefined && compareCursor(candidate.cursor, other.cursor) === 0;
    })
  );
}

function shouldRunDiscoveryBatch(
  newNotes: NoteClaimCandidate[],
  state: CurateState,
  processedThrough: CurateCursor,
): boolean {
  if (newNotes.length >= DISCOVERY_NEW_NOTE_THRESHOLD) {
    return true;
  }

  // A rewound discovery frontier must replay already-curated notes even below the normal threshold.
  return state.discoveryHighSeq > 0 && newNotes.length > 0 && state.discoveryHighSeq < processedThrough.entrySeq;
}

function prepareDiscoveryBatch(
  index: KbIndex,
  state: CurateState,
  requestedProcessedThrough: CurateCursor,
): PreparedDiscoveryBatch | null {
  const normalizedState = normalizeCurateStateRepairFrontier(state);
  const currentProcessedThrough = normalizedState.processedThrough;
  if (currentProcessedThrough === null) {
    return null;
  }
  const processedThrough =
    compareCursor(requestedProcessedThrough, currentProcessedThrough) <= 0
      ? requestedProcessedThrough
      : currentProcessedThrough;

  const repairFrontier = getCurateRepairFrontier(normalizedState.pendingRepair);
  const allClassified = filterCandidatesBeforeRepairFrontier(
    collectDiscoveryCandidates(index).filter((candidate) => compareCursor(candidate.cursor, processedThrough) <= 0),
    repairFrontier,
  );
  const newNotes = allClassified.filter((candidate) => candidate.cursor.entrySeq > normalizedState.discoveryHighSeq);
  if (!shouldRunDiscoveryBatch(newNotes, normalizedState, processedThrough)) {
    return null;
  }

  return {
    batch: selectDiscoveryBatch(allClassified, normalizedState.discoveryHighSeq, normalizedState.discoveryOffset),
    processedThrough,
    state: normalizedState,
  };
}

function selectDiscoveryBatch(allClassified: NoteClaimCandidate[], highSeq: number, offset: number): DiscoveryBatch {
  const newNotes = allClassified.filter((c) => c.cursor.entrySeq > highSeq);
  const oldNotes = allClassified.filter((c) => c.cursor.entrySeq <= highSeq);

  const selected = newNotes.slice(0, DISCOVERY_BATCH_SIZE);

  let nextOffset = offset;
  if (selected.length < DISCOVERY_BATCH_SIZE && oldNotes.length > 0) {
    const fill = Math.min(DISCOVERY_BATCH_SIZE - selected.length, oldNotes.length);
    const start = offset % oldNotes.length;
    for (let i = 0; i < fill; i++) {
      selected.push(oldNotes[(start + i) % oldNotes.length]);
    }
    nextOffset = (start + fill) % oldNotes.length;
  }

  const nextHighSeq = selected.reduce((max, c) => Math.max(max, c.cursor.entrySeq), highSeq);

  return { selected, nextHighSeq, nextOffset };
}

function buildPrincipleAssignmentTargets(
  principle: string,
  notes: string[],
  index: KbIndex,
  processedThrough: CurateCursor,
): MetadataTarget[] {
  const targets: MetadataTarget[] = [];

  for (const note of notes) {
    const noteMeta = getIndexNote(index, note);
    if (noteMeta === undefined || noteMeta.entrySeq === undefined) {
      continue;
    }

    const cursor = noteCursor(note, noteMeta.entrySeq);
    if (compareCursor(cursor, processedThrough) > 0 || noteMeta.principles.includes(principle)) {
      continue;
    }

    targets.push({
      kind: 'note',
      entryId: noteEntryId(note),
      slug: note,
      entrySeq: noteMeta.entrySeq,
      claimTimeUpdatedAt: noteMeta.updatedAt,
      addPrinciples: [principle],
    });
  }

  return targets.sort(compareMetadataTarget);
}

export function buildClassificationPrompt(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): string {
  const shape = classificationBatchShape(entries);
  const entryBlocks = entries.map(renderClassificationEntryBlock);

  return [
    buildClassificationPromptHeader(shape, tagVocab, principleNames),
    ...entryBlocks,
    buildClassificationPromptFooter(shape),
  ].join('\n\n');
}

export type ClassificationBatchShape = 'source-only' | 'note-or-mixed';

function approximateTokenCount(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

function trimTextToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) {
    return '';
  }

  if (approximateTokenCount(text) <= tokenBudget) {
    return text;
  }

  let low = 0;
  let high = text.length;
  let best = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid).trimEnd();
    if (approximateTokenCount(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  return best;
}

function excerptSourceBody(body: string): string {
  return trimTextToTokenBudget(body, CLASSIFICATION_SOURCE_EXCERPT_TOKEN_LIMIT);
}

function classificationBatchShape(entries: CurateClaimedEntry[]): ClassificationBatchShape {
  return entries.some((entry) => entry.kind === 'note') ? 'note-or-mixed' : 'source-only';
}

function renderClassificationEntryBlock(entry: CurateClaimedEntry): string {
  return `## ${entry.entryId}\n${entry.title}\n${entry.body}`;
}

function buildClassificationPromptHeader(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): string {
  const normalizedVocabulary = normalizeClassificationPromptVocabulary(tagVocab);
  const lines = [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    'Use KB entry IDs exactly as written, including the note:/source: prefix. Never return bare slugs.',
    'Tags must be descriptive entity names in lowercase kebab-case. Prefer 2-4 words and avoid bare keywords.',
    'If you introduce a tag that is not already in the existing entity vocabulary, include it in newEntities with a valid type and a one-sentence description.',
    'Extract directed relationships observed in the document between tags assigned to the same entry. Only use relationship types from the relationship vocabulary. Relationship source and target must both appear in that entry\'s tags.',
    'Entity type vocabulary:',
    buildFlatList(ENTITY_TYPE_PROMPT_GUIDANCE.map(([type, description]) => `${type}: ${description}`)),
    'Relationship type vocabulary:',
    buildFlatList(RELATIONSHIP_TYPE_PROMPT_GUIDANCE.map(([type, description]) => `${type}: ${description}`)),
    'Existing entity vocabulary:',
    renderClassificationPromptVocabulary(normalizedVocabulary),
    normalizedVocabulary.length === 0
      ? 'No existing entity vocabulary is available yet. Create newEntities when the document introduces distinct entities.'
      : 'Reuse existing entity names when they fit. Only introduce newEntities for genuinely new entities.',
  ];

  if (shape === 'source-only') {
    lines.push('Each source entry must return tags, related, newEntities, and relationships. Omit principles or return [].');
    return lines.join('\n\n');
  }

  lines.push('Principle names:', buildFlatList(principleNames));
  lines.push('Use only principle names from the principle list.');
  lines.push(
    'Each note entry must return tags, principles, related, newEntities, and relationships. Source entries in the same batch return tags, related, newEntities, and relationships; omit principles or return [].',
  );
  return lines.join('\n\n');
}

function buildClassificationPromptFooter(shape: ClassificationBatchShape): string {
  return shape === 'source-only'
    ? 'Return a JSON array: [{ "entry": "source:<slug>", "tags": ["<entity-name>", ...], "related": ["source:<slug>", "note:<slug>"], "newEntities": { "<entity-name>": { "type": "<entity-type>", "description": "<one sentence>" } }, "relationships": [{ "source": "<entity-name>", "target": "<entity-name>", "type": "<relationship-type>", "description": "<one sentence>" }] }]'
    : 'Return a JSON array: [{ "entry": "note:<slug>", "tags": ["<entity-name>", ...], "principles": ["<principle>", ...], "related": ["source:<slug>", "note:<slug>"], "newEntities": { "<entity-name>": { "type": "<entity-type>", "description": "<one sentence>" } }, "relationships": [{ "source": "<entity-name>", "target": "<entity-name>", "type": "<relationship-type>", "description": "<one sentence>" }] }]';
}

function classificationPromptTokenLimit(): number {
  const promptTokenLimit = CLASSIFICATION_REQUEST_TOKEN_BUDGET - CLASSIFICATION_RESPONSE_TOKEN_HEADROOM;
  if (promptTokenLimit < 1) {
    throw new Error('Classification request budget must leave positive response headroom.');
  }

  return promptTokenLimit;
}

function estimateClassificationScaffoldTokens(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  return approximateTokenCount(
    [buildClassificationPromptHeader(shape, tagVocab, principleNames), buildClassificationPromptFooter(shape)].join(
      '\n\n',
    ),
  );
}

function estimateClassificationEntryTokens(entry: CurateClaimedEntry): number {
  return approximateTokenCount(`\n\n${renderClassificationEntryBlock(entry)}`);
}

export function estimateClassificationBatchTokens(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): number {
  const shape = classificationBatchShape(entries);
  return (
    estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) +
    entries.reduce((total, entry) => total + estimateClassificationEntryTokens(entry), 0)
  );
}

function assertClassificationScaffoldFits(
  shape: ClassificationBatchShape,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): void {
  if (estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) > classificationPromptTokenLimit()) {
    throw new Error(`Classification ${shape} scaffold exceeds the request budget.`);
  }
}

function fitSourceEntryToPromptBudget(
  entry: SourceCurateClaimedEntry,
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
): SourceCurateClaimedEntry {
  if (estimateClassificationBatchTokens([entry], tagVocab, principleNames) <= classificationPromptTokenLimit()) {
    return entry;
  }

  let low = 0;
  let high = entry.body.length;
  let bestBody: string | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = {
      ...entry,
      body: entry.body.slice(0, mid).trimEnd(),
    };

    if (estimateClassificationBatchTokens([candidate], tagVocab, principleNames) <= classificationPromptTokenLimit()) {
      bestBody = candidate.body;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  if (bestBody === null) {
    throw new Error(`Classification source entry ${entry.entryId} exceeds the request budget.`);
  }

  return {
    ...entry,
    body: bestBody,
  };
}

function parseClassificationNewEntities(value: unknown): Record<string, ClassificationNewEntity> {
  if (!isRecord(value)) {
    return {};
  }

  const accepted: Record<string, ClassificationNewEntity> = {};
  for (const [entityName, rawMeta] of Object.entries(value)) {
    if (
      !isRecord(rawMeta) ||
      typeof rawMeta.type !== 'string' ||
      typeof rawMeta.description !== 'string' ||
      !isKnownEntityType(rawMeta.type)
    ) {
      continue;
    }

    const normalizedName = entityName.trim();
    const description = rawMeta.description.trim();
    if (!normalizedName || !description) {
      continue;
    }

    accepted[normalizedName] = {
      type: rawMeta.type,
      description,
    };
  }

  return accepted;
}

function parseClassificationRelationships(value: unknown): ClassificationRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const relationships: ClassificationRelationship[] = [];
  for (const relationship of value) {
    if (
      !isRecord(relationship) ||
      typeof relationship.source !== 'string' ||
      typeof relationship.target !== 'string' ||
      typeof relationship.type !== 'string' ||
      typeof relationship.description !== 'string' ||
      !isKnownRelationshipType(relationship.type)
    ) {
      continue;
    }

    const source = relationship.source.trim();
    const target = relationship.target.trim();
    const description = relationship.description.trim();
    if (!source || !target || !description) {
      continue;
    }

    relationships.push({
      source,
      target,
      type: relationship.type,
      description,
    });
  }

  return relationships;
}

function classifyParsedEntries(entries: unknown[], entryMap: Map<string, true>): ClassificationAssignment[] {
  const assignments: ClassificationAssignment[] = [];

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.entry !== 'string' || !isStringArray(entry.tags)) {
      continue;
    }

    const parsedEntryId = parseKbEntryId(entry.entry);
    if (parsedEntryId === null || !entryMap.has(parsedEntryId)) {
      continue;
    }

    const principles = entry.principles === undefined ? [] : entry.principles;
    const related = entry.related === undefined ? [] : entry.related;
    if (!isStringArray(principles) || !isStringArray(related)) {
      continue;
    }
    const newEntities = parseClassificationNewEntities(entry.newEntities);
    const relationships = parseClassificationRelationships(entry.relationships);

    const normalizedRelated = uniqueTrimmedList(
      related.flatMap((relatedEntryId) => {
        const normalized = parseKbEntryId(relatedEntryId);
        return normalized === null ? [] : [normalized];
      }),
    );

    assignments.push({
      entry: parsedEntryId,
      tags: uniqueTrimmedList(entry.tags),
      principles: [...principles],
      ...(normalizedRelated.length === 0 ? {} : { related: normalizedRelated }),
      ...(Object.keys(newEntities).length === 0 ? {} : { newEntities }),
      ...(relationships.length === 0 ? {} : { relationships }),
    });
  }

  return assignments;
}

export function parseClassificationResponse(raw: string, entryMap: Map<string, true>): ClassificationAssignment[] {
  const { entries, parseFailed } = parseJsonArray(raw);
  return parseFailed ? [] : classifyParsedEntries(entries, entryMap);
}

export function chunkEntriesByPromptBudget(
  entries: CurateClaimedEntry[],
  tagVocab: ClassificationPromptVocabularyInput,
  principleNames: string[],
  maxEntries = CLASSIFICATION_BATCH_SIZE,
): CurateClaimedEntry[][] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  if (entries.length === 0) {
    return [];
  }

  if (entries.some((entry) => entry.kind === 'source')) {
    assertClassificationScaffoldFits('source-only', tagVocab, principleNames);
  }
  if (entries.some((entry) => entry.kind === 'note')) {
    assertClassificationScaffoldFits('note-or-mixed', tagVocab, principleNames);
  }

  const batches: CurateClaimedEntry[][] = [];
  let index = 0;
  let currentBatch: CurateClaimedEntry[] = [];

  while (index < entries.length) {
    const entry = entries[index];
    const nextBatch = [...currentBatch, entry];
    const canFit =
      currentBatch.length < maxEntries &&
      estimateClassificationBatchTokens(nextBatch, tagVocab, principleNames) <= classificationPromptTokenLimit();

    if (canFit) {
      currentBatch.push(entry);
      index += 1;
      continue;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      continue;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    currentBatch = [fitSourceEntryToPromptBudget(entry, tagVocab, principleNames)];
    index += 1;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function takeClassificationBatchWithIndex(
  entries: CurateClaimedEntry[],
  index: KbIndex,
  principleNames: string[],
  maxEntries = CLASSIFICATION_BATCH_SIZE,
): {
  batch: CurateClaimedEntry[];
  vocabulary: ClassificationPromptVocabularyEntry[];
} {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }

  if (entries.length === 0) {
    return {
      batch: [],
      vocabulary: [],
    };
  }

  let batch: CurateClaimedEntry[] = [];
  let vocabulary: ClassificationPromptVocabularyEntry[] = [];
  let indexCursor = 0;

  while (indexCursor < entries.length) {
    const entry = entries[indexCursor];
    const candidateBatch = [...batch, entry];
    const candidateVocabulary = buildClassificationPromptVocabulary(candidateBatch, index);
    assertClassificationScaffoldFits(classificationBatchShape(candidateBatch), candidateVocabulary, principleNames);

    if (
      batch.length < maxEntries &&
      estimateClassificationBatchTokens(candidateBatch, candidateVocabulary, principleNames) <=
        classificationPromptTokenLimit()
    ) {
      batch = candidateBatch;
      vocabulary = candidateVocabulary;
      indexCursor += 1;
      continue;
    }

    if (batch.length > 0) {
      break;
    }

    if (entry.kind === 'note') {
      throw new Error(`Classification note entry ${entry.entryId} exceeds the request budget.`);
    }

    const fittedEntry = fitSourceEntryToPromptBudget(entry, candidateVocabulary, principleNames);
    batch = [fittedEntry];
    vocabulary = buildClassificationPromptVocabulary(batch, index);
    assertClassificationScaffoldFits(classificationBatchShape(batch), vocabulary, principleNames);
    break;
  }

  return {
    batch,
    vocabulary,
  };
}

function mergeClassificationNewEntities(
  ...maps: Array<Record<string, ClassificationNewEntity> | undefined>
): Record<string, ClassificationNewEntity> | undefined {
  const merged: Record<string, ClassificationNewEntity> = {};

  for (const map of maps) {
    if (map === undefined) {
      continue;
    }

    for (const [entityName, meta] of Object.entries(map)) {
      if (merged[entityName] !== undefined) {
        continue;
      }

      merged[entityName] = {
        type: meta.type,
        description: meta.description,
      };
    }
  }

  return Object.keys(merged).length === 0 ? undefined : merged;
}

function classificationRelationshipKey(relationship: ClassificationRelationship): string {
  return `${relationship.source}\u0000${relationship.target}\u0000${relationship.type}`;
}

function mergeClassificationRelationships(
  ...lists: Array<ClassificationRelationship[] | undefined>
): ClassificationRelationship[] | undefined {
  const merged: ClassificationRelationship[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    if (list === undefined) {
      continue;
    }

    for (const relationship of list) {
      const key = classificationRelationshipKey(relationship);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
      });
    }
  }

  return merged.length === 0 ? undefined : merged;
}

export function validateAssignments(
  proposals: ClassificationAssignment[],
  index: KbIndex,
  claimedEntries: CurateClaimedEntry[],
): ClassificationAssignment[] {
  const existingEntityVocabulary = new Set(Object.keys(index.entityMeta ?? {}));
  const claimedByEntryId = new Map<KbEntryId, CurateClaimedEntry>();
  for (const entry of claimedEntries) {
    claimedByEntryId.set(entry.entryId, entry);
  }

  const claimedOrder = claimedEntries.map((entry) => entry.entryId);
  const mergedByEntry = new Map<KbEntryId, ClassificationAssignment>();

  for (const proposal of proposals) {
    const entryId = parseKbEntryId(proposal.entry);
    if (entryId === null) {
      continue;
    }

    const claimedEntry = claimedByEntryId.get(entryId);
    if (claimedEntry === undefined || getEntry(index, entryId) === undefined) {
      continue;
    }

    const related = uniqueTrimmedList(
      (proposal.related ?? []).flatMap((relatedEntryId) => {
        const normalized = parseKbEntryId(relatedEntryId);
        if (normalized === null || normalized === entryId || getEntry(index, normalized) === undefined) {
          return [];
        }

        return [normalized];
      }),
    );
    const existing = mergedByEntry.get(entryId);
    if (existing === undefined) {
      const mergedNewEntities = mergeClassificationNewEntities(proposal.newEntities);
      const mergedRelationships = mergeClassificationRelationships(proposal.relationships);
      mergedByEntry.set(entryId, {
        entry: entryId,
        tags: uniqueTrimmedList(proposal.tags),
        principles: uniqueTrimmedList(proposal.principles ?? []),
        ...(related.length === 0 ? {} : { related }),
        ...(mergedNewEntities === undefined ? {} : { newEntities: mergedNewEntities }),
        ...(mergedRelationships === undefined ? {} : { relationships: mergedRelationships }),
      });
      continue;
    }

    existing.tags = uniqueTrimmedList([...existing.tags, ...proposal.tags]);
    existing.principles = uniqueTrimmedList([...(existing.principles ?? []), ...(proposal.principles ?? [])]);
    existing.newEntities = mergeClassificationNewEntities(existing.newEntities, proposal.newEntities);
    existing.relationships = mergeClassificationRelationships(existing.relationships, proposal.relationships);
    if (existing.newEntities === undefined) {
      delete existing.newEntities;
    }
    if (existing.relationships === undefined) {
      delete existing.relationships;
    }
    const mergedRelated = uniqueTrimmedList([...(existing.related ?? []), ...related]);
    if (mergedRelated.length === 0) {
      delete existing.related;
    } else {
      existing.related = mergedRelated;
    }
  }

  const validated: ClassificationAssignment[] = [];
  for (const entryId of claimedOrder) {
    const proposal = mergedByEntry.get(entryId);
    const claimedEntry = claimedByEntryId.get(entryId);
    if (proposal === undefined || claimedEntry === undefined) {
      continue;
    }

    const acceptedNewEntities: Record<string, ClassificationNewEntity> = {};
    const tags = uniqueTrimmedList(
      proposal.tags.filter((tag) => {
        if (existingEntityVocabulary.has(tag)) {
          return true;
        }

        const candidate = proposal.newEntities?.[tag];
        if (
          candidate === undefined ||
          !isDescriptiveEntityName(tag, 2) ||
          !isKnownEntityType(candidate.type) ||
          !hasNonEmptyDescription(candidate.description)
        ) {
          return false;
        }

        acceptedNewEntities[tag] = {
          type: candidate.type,
          description: candidate.description.trim(),
        };
        return true;
      }),
    );
    const tagSet = new Set(tags);
    const principles =
      claimedEntry.kind === 'note'
        ? uniqueTrimmedList(
            (proposal.principles ?? []).filter((principle) => index.principles[principle] !== undefined),
          )
        : [];
    const related = uniqueTrimmedList(
      (proposal.related ?? []).filter(
        (relatedEntryId) => relatedEntryId !== entryId && getEntry(index, relatedEntryId as KbEntryId) !== undefined,
      ),
    );
    const relationships: ClassificationRelationship[] = [];
    const seenRelationships = new Set<string>();
    for (const relationship of proposal.relationships ?? []) {
      if (
        relationship.source === relationship.target ||
        !tagSet.has(relationship.source) ||
        !tagSet.has(relationship.target) ||
        !isKnownRelationshipType(relationship.type) ||
        !hasNonEmptyDescription(relationship.description)
      ) {
        continue;
      }

      const normalizedRelationship = {
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description.trim(),
      };
      const key = classificationRelationshipKey(normalizedRelationship);
      if (seenRelationships.has(key)) {
        continue;
      }

      seenRelationships.add(key);
      relationships.push(normalizedRelationship);
    }

    validated.push({
      entry: entryId,
      tags,
      principles,
      ...(related.length === 0 ? {} : { related }),
      ...(Object.keys(acceptedNewEntities).length === 0 ? {} : { newEntities: acceptedNewEntities }),
      ...(relationships.length === 0 ? {} : { relationships }),
    });
  }

  return validated;
}

function mergeAssignmentsIntoIndexGraph(index: KbIndex, assignments: ClassificationAssignment[]): KbIndex {
  const nextIndex = cloneKbIndex(index);
  const entityMeta = cloneEntityMetaMap(nextIndex.entityMeta ?? {});
  const relationships = cloneEntityRelationships(nextIndex.relationships ?? []);
  const relationshipsByKey = new Map(
    relationships.map((relationship, index) => [classificationRelationshipKey(relationship), index] as const),
  );

  for (const assignment of assignments) {
    for (const [entityName, meta] of Object.entries(assignment.newEntities ?? {})) {
      if (entityMeta[entityName] !== undefined) {
        continue;
      }

      entityMeta[entityName] = {
        type: meta.type,
        description: meta.description,
      };
    }

    for (const relationship of assignment.relationships ?? []) {
      const key = classificationRelationshipKey(relationship);
      const existingIndex = relationshipsByKey.get(key);
      if (existingIndex !== undefined) {
        const existing = relationships[existingIndex];
        if (existing !== undefined) {
          existing.evidence = uniqueTrimmedList([...existing.evidence, assignment.entry]);
          if (!existing.description && relationship.description) {
            existing.description = relationship.description;
          }
        }
        continue;
      }

      relationshipsByKey.set(key, relationships.length);
      relationships.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
        evidence: [assignment.entry],
      });
    }
  }

  nextIndex.entityMeta = entityMeta;
  nextIndex.relationships = relationships;
  return nextIndex;
}

function buildEntityConsolidationDelta(assignments: ClassificationAssignment[]): EntityConsolidationDelta {
  const entities: NonNullable<EntityConsolidationDelta['entities']> = [];
  const relationships: EntityRelationship[] = [];

  for (const assignment of assignments) {
    for (const [name, meta] of Object.entries(assignment.newEntities ?? {})) {
      entities.push({
        name,
        type: meta.type,
        description: meta.description,
      });
    }

    for (const relationship of assignment.relationships ?? []) {
      relationships.push({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
        evidence: [assignment.entry],
      });
    }
  }

  return {
    ...(entities.length === 0 ? {} : { entities }),
    ...(relationships.length === 0 ? {} : { relationships }),
  };
}

function applyEntityReplacementMap(tags: string[] | undefined, replacementMap: EntityReplacementMap): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  return uniqueTrimmedList(tags.map((tag) => resolveCanonicalEntityId(tag, replacementMap)));
}

function rewriteMetadataTargetEntities(target: MetadataTarget, replacementMap: EntityReplacementMap): MetadataTarget {
  return {
    ...target,
    ...(target.addTags === undefined ? {} : { addTags: applyEntityReplacementMap(target.addTags, replacementMap) }),
    ...(target.desiredTags === undefined
      ? {}
      : { desiredTags: applyEntityReplacementMap(target.desiredTags, replacementMap) }),
    ...(target.removeTags === undefined ? {} : { removeTags: uniqueTrimmedList(target.removeTags) }),
  };
}

export function buildMetadataTargets(
  validatedAssignments: ClassificationAssignment[],
  index: KbIndex,
  claimedEntries: CurateClaimedEntry[],
): MetadataTarget[] {
  const assignmentsByEntryId = new Map(
    validatedAssignments.flatMap((assignment) => {
      const entryId = parseKbEntryId(assignment.entry);
      return entryId === null ? [] : [[entryId, assignment] as const];
    }),
  );

  return claimedEntries
    .map((claimedEntry) => {
      const claimTimeMeta = getEntry(index, claimedEntry.entryId);
      const claimTimeCuratableMeta =
        claimTimeMeta !== undefined && (isNoteEntry(claimTimeMeta) || isSourceEntry(claimTimeMeta))
          ? claimTimeMeta
          : undefined;
      const existingRelated = new Set(claimTimeCuratableMeta?.related ?? []);
      const assignment = assignmentsByEntryId.get(claimedEntry.entryId);
      const desiredTags = assignment === undefined ? undefined : uniqueTrimmedList(assignment.tags);
      const desiredTagSet = new Set(desiredTags ?? []);
      const removeTags =
        desiredTags === undefined ? [] : (claimTimeCuratableMeta?.tags ?? []).filter((tag) => !desiredTagSet.has(tag));
      const addRelated = uniqueTrimmedList(
        (assignment?.related ?? []).filter((relatedEntryId) => !existingRelated.has(relatedEntryId)),
      );

      if (claimedEntry.kind === 'source') {
        return {
          kind: 'source' as const,
          entryId: claimedEntry.entryId,
          slug: claimedEntry.slug,
          entrySeq: claimedEntry.entrySeq,
          claimTimeFingerprint: claimedEntry.claimTimeFingerprint,
          ...(desiredTags === undefined ? {} : { desiredTags }),
          ...(addRelated.length === 0 ? {} : { addRelated }),
          ...(removeTags.length === 0 ? {} : { removeTags }),
        };
      }

      const existingPrinciples = new Set(
        claimTimeMeta !== undefined && isNoteEntry(claimTimeMeta) ? claimTimeMeta.principles : [],
      );
      const addPrinciples = uniqueTrimmedList(
        (assignment?.principles ?? []).filter((principle) => !existingPrinciples.has(principle)),
      );

      return {
        kind: 'note' as const,
        entryId: claimedEntry.entryId,
        slug: claimedEntry.slug,
        entrySeq: claimedEntry.entrySeq,
        claimTimeUpdatedAt: claimedEntry.updatedAt,
        ...(desiredTags === undefined ? {} : { desiredTags }),
        ...(addRelated.length === 0 ? {} : { addRelated }),
        ...(addPrinciples.length === 0 ? {} : { addPrinciples }),
        ...(removeTags.length === 0 ? {} : { removeTags }),
      };
    })
    .sort(compareMetadataTarget);
}

export type DiscoveryPromptResult = {
  prompt: string;
  corpusPath: string;
};

export function buildDiscoveryPrompt(
  notes: DiscoveryCurateClaimedEntry[],
  existingPrinciples: Record<string, string>,
): DiscoveryPromptResult {
  const noteBlocks = notes.map((note) => `## ${note.slug}\n${note.title}\n${truncateDiscoveryBody(note.body)}`);
  const corpusPath = join(tmpdir(), `coral-discovery-${randomUUID()}.md`);
  writeFileSync(corpusPath, noteBlocks.join('\n\n'));

  const principleEntries = Object.entries(existingPrinciples)
    .sort(([a], [b]) => compareLocale(a, b))
    .map(([name, statement]) => `- ${name}: ${statement}`);

  const prompt = [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    '',
    'Principles are cross-domain reusable decision rules extracted from recurring patterns across notes. Each principle is:',
    '- A judgment call that applies beyond its original context',
    '- Actionable: what to do or avoid',
    '- Seen independently in at least 3 notes',
    '- One sentence',
    '',
    "Look for recurring mistakes, structural patterns, or decision heuristics that appear across multiple unrelated notes. Do not propose principles that merely restate a single note's content.",
    '',
    'Existing principles (name: statement). Do not duplicate or propose semantically equivalent ones:',
    ...principleEntries,
    '',
    `Read the note corpus from ${corpusPath} before responding.`,
    '',
    'Return a JSON array: [{ "slug": "<kebab-case>", "statement": "<one-sentence principle>", "notes": ["<slug>", ...], "absorbs": ["<existing-slug>", ...] }]',
    "To improve an existing principle's wording, return it with its existing slug and the better statement.",
    'To merge similar principles, return the surviving slug with absorbs listing the slugs to fold in. Omit absorbs when creating new principles.',
  ].join('\n');

  return { prompt, corpusPath };
}

export function parseDiscoveryResponse(raw: string): DiscoveryProposal[] {
  const { entries, parseFailed } = parseJsonArray(raw);
  return parseFailed ? [] : extractDiscoveryProposals(entries);
}

export function validateDiscoveryProposals(
  proposals: DiscoveryProposal[],
  eligibleNotes: DiscoveryCurateClaimedEntry[],
  existingPrinciples: Record<string, string>,
): DiscoveryProposal[] {
  const eligibleSet = new Set(eligibleNotes.map((note) => note.slug));
  const seenSlugs = new Set<string>();
  const seenAbsorbedSlugs = new Set<string>();
  const validated: DiscoveryProposal[] = [];
  let mergeCount = 0;
  let refineCount = 0;

  for (const proposal of proposals) {
    const slug = normalizeDiscoverySlug(proposal.slug);
    if (slug === null || seenSlugs.has(slug) || seenAbsorbedSlugs.has(slug)) {
      continue;
    }

    const statement = proposal.statement.trim();
    if (!statement) {
      continue;
    }

    const notes = uniqueTrimmedList(proposal.notes.filter((note) => eligibleSet.has(note)));
    if (notes.length < 3) {
      continue;
    }

    const absorbs = uniqueTrimmedList(proposal.absorbs ?? []);
    const normalizedAbsorbs: string[] = [];
    let invalidAbsorption = false;

    for (const rawAbsorb of absorbs) {
      const absorbSlug = normalizeDiscoverySlug(rawAbsorb);
      if (
        absorbSlug === null ||
        existingPrinciples[absorbSlug] === undefined ||
        absorbSlug === slug ||
        seenSlugs.has(absorbSlug) ||
        seenAbsorbedSlugs.has(absorbSlug)
      ) {
        invalidAbsorption = true;
        break;
      }
      normalizedAbsorbs.push(absorbSlug);
    }
    if (invalidAbsorption) {
      continue;
    }

    const existingStatement = existingPrinciples[slug];
    const isMerge = normalizedAbsorbs.length > 0;
    if (existingStatement !== undefined && existingStatement === statement && !isMerge) {
      continue;
    }

    const isRefine = existingStatement !== undefined && !isMerge;
    if (isMerge && mergeCount >= DISCOVERY_MAX_MERGES) {
      continue;
    }
    if (isRefine && refineCount >= DISCOVERY_MAX_REFINES) {
      continue;
    }

    validated.push({
      slug,
      statement,
      notes,
      ...(normalizedAbsorbs.length === 0 ? {} : { absorbs: normalizedAbsorbs }),
    });
    seenSlugs.add(slug);
    for (const absorbSlug of normalizedAbsorbs) {
      seenAbsorbedSlugs.add(absorbSlug);
    }
    if (isMerge) {
      mergeCount += 1;
    }
    if (isRefine) {
      refineCount += 1;
    }
  }

  return validated;
}

export function serializePrincipleDocument(statement: string, createdAt: string): string {
  const normalizedStatement = assertNonEmptyText(statement, 'statement');
  const normalizedCreatedAt = assertNonEmptyText(createdAt, 'createdAt');

  return [
    '---',
    `createdAt: ${normalizedCreatedAt}`,
    `updatedAt: ${normalizedCreatedAt}`,
    '---',
    '',
    normalizedStatement,
    '',
  ].join('\n');
}

async function runCurateClaude(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  prompt: string,
  extraArgs?: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await spawnCli({
    provider: 'claude',
    command: 'claude',
    args: ['-p', '--no-session-persistence', ...(extraArgs ?? [])],
    prompt,
    cwd: kb.markdownRoot,
    pool: 'curate',
    signal,
  });

  if (result.aborted) {
    throw new Error('Claude invocation aborted during curate.');
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      stderr ? `Claude exited with code ${result.code}: ${stderr}` : `Claude exited with code ${result.code}`,
    );
  }

  return result.stdout;
}

function readClaimedEntry(kb: KbRuntime, candidate: ClaimCandidate): CurateClaimedEntry {
  if (candidate.kind === 'note') {
    const { title, body } = loadKbNote(kb.notePath(candidate.slug));

    return {
      kind: 'note',
      entryId: candidate.entryId,
      slug: candidate.slug,
      title,
      body,
      updatedAt: candidate.updatedAt,
      entrySeq: candidate.cursor.entrySeq,
    };
  }

  const { raw, title, body } = loadKbSource(kb.sourcePath(candidate.slug));
  const claimTimeFingerprint = fingerprintEntryContent(raw);
  return {
    kind: 'source',
    entryId: candidate.entryId,
    slug: candidate.slug,
    title,
    body: excerptSourceBody(body),
    claimTimeFingerprint,
    entrySeq: candidate.cursor.entrySeq,
  };
}

function persistCurateState(kb: KbRuntime, state: CurateState, next: CurateState | null): CurateState {
  if (next === null) {
    return state;
  }

  const normalizedNext = normalizeCurateStateRepairFrontier(next);
  writeCurateState(kb, normalizedNext);
  return normalizedNext;
}

function recordCurateFailureLocked(
  kb: KbRuntime,
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
): CurateState {
  return persistCurateState(kb, state, applyRecordCurateFailure(state, through, error));
}

async function recordCurateFailure(kb: KbRuntime, through: CurateCursor | null, error: unknown): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    recordCurateFailureLocked(kb, state, through, error);
  });
}

function clearCurateRetryStateLocked(kb: KbRuntime, state: CurateState): CurateState {
  return persistCurateState(kb, state, applyClearCurateRetryState(state));
}

async function clearCurateRetryState(kb: KbRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    clearCurateRetryStateLocked(kb, state);
  });
}

async function claimCurateRun(kb: KbRuntime, today: string): Promise<CurateClaim | null> {
  const lockResult = await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    const now = nowIsoString();

    if (state.activeClaim !== null && !isClaimStale(state, now)) {
      return null;
    }

    const index = kb.readIndex();
    if (index === null) {
      return null;
    }

    const repairFrontier = getCurateRepairFrontier(state.pendingRepair);
    const pendingEntries = filterCandidatesBeforeRepairFrontier(
      collectClaimCandidates(index).filter(
        (candidate) => compareOptionalCursor(state.processedThrough, candidate.cursor) < 0,
      ),
      repairFrontier,
    );
    if (pendingEntries.length === 0) {
      return null;
    }

    const firstPassClaim =
      (today !== state.lastRunDay && pendingEntries.length >= CURATE_MIN_CLAIM_SIZE) ||
      pendingEntries.length >= CURATE_IMMEDIATE_CLAIM_SIZE;
    const retryBlocked =
      compareCursorDates(state.retryNotBefore, now) > 0 &&
      !pendingExtendsBeyondCursor(pendingEntries, state.lastAttemptedThrough);
    const retryClaim = state.lastAttemptedThrough !== null && state.retryNotBefore !== null && !retryBlocked;

    if (!firstPassClaim && !retryClaim) {
      return null;
    }

    const claimedCandidates = pendingEntries.slice(0, CURATE_MAX_CLAIM_SIZE);
    const through = claimedCandidates[claimedCandidates.length - 1]?.cursor;
    if (through === undefined) {
      return null;
    }

    const freshPendingSuffix = pendingExtendsBeyondCursor(pendingEntries, state.lastAttemptedThrough);

    writeCurateState(
      kb,
      normalizeCurateStateRepairFrontier({
        ...state,
        retryNotBefore: null,
        activeClaim: {
          through,
          startedAt: now,
        },
        lastAttemptedThrough: through,
        consecutiveFailures: freshPendingSuffix ? 0 : state.consecutiveFailures,
        ...(firstPassClaim ? { lastRunDay: today } : {}),
      }),
    );

    return { claimedCandidates, through };
  });

  if (lockResult === null) {
    return null;
  }

  // Read file contents outside the mutation lock — the claim cursor is already
  // persisted, and commitMetadataTargetsLocked uses compare-and-swap (updatedAt /
  // fingerprint) to detect any changes between now and commit.
  const entries = lockResult.claimedCandidates.flatMap((candidate) => {
    try {
      return [readClaimedEntry(kb, candidate)];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) {
    return null;
  }

  return { entries, through: lockResult.through };
}

async function runClassificationBatches(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  claim: CurateClaim,
  index: KbIndex,
  signal?: AbortSignal,
): Promise<ClassificationAssignment[]> {
  let workingIndex = cloneKbIndex(index);
  const validatedAssignments: ClassificationAssignment[] = [];
  const principleNames = buildPrincipleNames(workingIndex);
  const remainingEntries = [...claim.entries];

  while (remainingEntries.length > 0) {
    const { batch, vocabulary } = takeClassificationBatchWithIndex(
      remainingEntries,
      workingIndex,
      principleNames,
      CLASSIFICATION_BATCH_SIZE,
    );
    if (batch.length === 0) {
      throw new Error('Classification batch selection produced an empty batch.');
    }

    const prompt = buildClassificationPrompt(batch, vocabulary, principleNames);
    const raw = await runCurateClaude(kb, spawnCli, prompt, undefined, signal);
    const { entries, parseFailed } = parseJsonArray(raw);
    if (parseFailed) {
      throw new CurateJsonParseError('classification');
    }
    const entryMap = new Map<string, true>(batch.map((entry) => [entry.entryId, true] as const));
    const validatedBatch = validateAssignments(classifyParsedEntries(entries, entryMap), workingIndex, batch);
    validatedAssignments.push(...validatedBatch);
    workingIndex = mergeAssignmentsIntoIndexGraph(workingIndex, validatedBatch);
    remainingEntries.splice(0, batch.length);
  }

  return validatedAssignments;
}

async function commitMetadataTargetsLocked(
  kb: KbRuntime,
  targets: MetadataTarget[],
  state: CurateState,
  graphAssignments?: ClassificationAssignment[],
): Promise<CurateState> {
  const normalizedState = normalizeCurateStateRepairFrontier(state);
  const repairFrontier = getCurateRepairFrontier(normalizedState.pendingRepair);
  const currentIndex = kb.readIndexOrEmpty();
  const nextIndex = cloneKbIndex(currentIndex);
  const currentGraph = snapshotEntityGraph(currentIndex);
  const consolidationResult: ConsolidationResult = consolidateEntityGraph(
    currentGraph,
    graphAssignments === undefined ? undefined : buildEntityConsolidationDelta(graphAssignments),
  );
  const desiredGraph = consolidationResult.canonicalGraph;
  const graphChanged = !entityGraphsEqual(currentGraph, desiredGraph);
  const sortedTargets = [...targets]
    .map((target) => rewriteMetadataTargetEntities(target, consolidationResult.replacementMap))
    .sort(compareMetadataTarget);

  nextIndex.entityMeta = cloneEntityMetaMap(desiredGraph.entityMeta);
  nextIndex.relationships = cloneEntityRelationships(desiredGraph.relationships);
  let processedThrough = normalizedState.processedThrough;
  let cursorCanAdvance = true;
  let wroteMarkdown = false;
  let failure: unknown = null;

  if (graphChanged) {
    try {
      writeFileAtomic(kb.entityGraphPath(), `${JSON.stringify(desiredGraph, null, 2)}\n`);
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  if (failure !== null) {
    if (failure instanceof Error) throw failure;
    throw new Error(typeof failure === 'string' ? failure : 'Unknown error');
  }

  for (const target of sortedTargets) {
    const cursor = cursorFromTarget(target);
    if (!isCursorBeforeRepairFrontier(cursor, repairFrontier)) {
      cursorCanAdvance = false;
      continue;
    }

    if (target.kind === 'note') {
      const notePath = kb.notePath(target.slug);
      let raw: string;

      try {
        raw = readFileSync(notePath, 'utf-8');
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
          continue;
        }
        throw error;
      }

      const liveFrontmatter = parseFrontmatter(raw);
      if (liveFrontmatter.updatedAt !== target.claimTimeUpdatedAt) {
        cursorCanAdvance = false;
        continue;
      }

      const metadataDecision = buildLiveNoteMetadataDecision(target, liveFrontmatter.tags, liveFrontmatter.principles);
      const nextRelated = buildLiveRelatedMetadata(target, liveFrontmatter.related ?? []);
      if (!metadataDecision.shouldWrite && sameStringList(nextRelated, liveFrontmatter.related ?? [])) {
        processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
        continue;
      }

      const nextFrontmatter = {
        tags: metadataDecision.nextTags,
        principles: metadataDecision.nextPrinciples,
        source: liveFrontmatter.source,
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        related: nextRelated,
        entrySeq: liveFrontmatter.entrySeq ?? target.entrySeq,
      };

      writeFileAtomic(notePath, replaceFrontmatter(raw, nextFrontmatter));
      wroteMarkdown = true;

      const existingIndexEntry = nextIndex.entries[noteEntryId(target.slug)];
      const existingIndexNote =
        existingIndexEntry !== undefined && isNoteEntry(existingIndexEntry) ? existingIndexEntry : undefined;
      nextIndex.entries[noteEntryId(target.slug)] = buildNoteIndexEntry({
        slug: target.slug,
        title: existingIndexNote?.title ?? extractTitle(raw),
        tags: metadataDecision.nextTags,
        principles: metadataDecision.nextPrinciples,
        source: liveFrontmatter.source,
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        related: nextRelated,
        entrySeq: nextFrontmatter.entrySeq,
      });

      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
      continue;
    }

    const sourcePath = kb.sourcePath(target.slug);
    let raw: string;

    try {
      raw = readFileSync(sourcePath, 'utf-8');
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
        continue;
      }
      throw error;
    }

    if (fingerprintEntryContent(raw) !== target.claimTimeFingerprint) {
      cursorCanAdvance = false;
      continue;
    }

    const liveFrontmatter = parseSourceFrontmatter(raw);
    const nextTags = buildLiveSourceMetadataDecision(target, liveFrontmatter.tags);
    const nextRelated = buildLiveRelatedMetadata(target, liveFrontmatter.related ?? []);
    if (sameStringList(nextTags, liveFrontmatter.tags) && sameStringList(nextRelated, liveFrontmatter.related ?? [])) {
      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
      continue;
    }

    const nextFrontmatter = {
      title: liveFrontmatter.title,
      type: liveFrontmatter.type,
      tags: nextTags,
      ...(liveFrontmatter.url === undefined ? {} : { url: liveFrontmatter.url }),
      importedAt: liveFrontmatter.importedAt,
      related: nextRelated,
      entrySeq: liveFrontmatter.entrySeq ?? target.entrySeq,
    };

    writeFileAtomic(sourcePath, replaceSourceFrontmatter(raw, nextFrontmatter));
    wroteMarkdown = true;

    const existingIndexEntry = nextIndex.entries[sourceEntryId(target.slug)];
    const existingIndexSource =
      existingIndexEntry !== undefined && isSourceEntry(existingIndexEntry) ? existingIndexEntry : undefined;
    nextIndex.entries[sourceEntryId(target.slug)] = buildSourceIndexEntry({
      slug: target.slug,
      title: existingIndexSource?.title ?? liveFrontmatter.title,
      type: liveFrontmatter.type,
      tags: nextTags,
      ...(liveFrontmatter.url === undefined ? {} : { url: liveFrontmatter.url }),
      importedAt: liveFrontmatter.importedAt,
      related: nextRelated,
      entrySeq: nextFrontmatter.entrySeq,
    });

    processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
  }

  const nextState = normalizeCurateStateRepairFrontier({
    ...normalizedState,
    processedThrough,
    activeClaim: null,
  });

  if (wroteMarkdown || graphChanged) {
    recordMetadataMutation(kb, CURATE_STALE_REASON);
    try {
      kb.writeIndex(nextIndex);
    } catch (error: unknown) {
      failure ??= error;
    }
  }

  if (failure !== null) {
    if (failure instanceof Error) throw failure;
    throw new Error(typeof failure === 'string' ? failure : 'Unknown error');
  }

  writeCurateState(kb, nextState);
  return nextState;
}

async function commitMetadataTargets(
  kb: KbRuntime,
  targets: MetadataTarget[],
  graphAssignments?: ClassificationAssignment[],
): Promise<void> {
  await kb.withMutationLock(async () => {
    runEntrySeqUpgradeGuard(kb);
    const state = readCurateState(kb);
    await commitMetadataTargetsLocked(kb, targets, state, graphAssignments);
  });
}

function loadEligibleDiscoveryNotes(kb: KbRuntime, candidates: NoteClaimCandidate[]): DiscoveryCurateClaimedEntry[] {
  const eligible: DiscoveryCurateClaimedEntry[] = [];

  for (const candidate of candidates) {
    try {
      const entry = readClaimedEntry(kb, candidate);
      if (isNoteClaimedEntry(entry)) {
        eligible.push(entry);
      }
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        continue;
      }
      throw error;
    }
  }

  return eligible;
}

function recordDiscoveryAttemptLocked(
  kb: KbRuntime,
  state: CurateState,
  highSeq: number,
  nextOffset: number,
): CurateState {
  return persistCurateState(kb, state, applyRecordDiscoveryAttempt(state, highSeq, nextOffset));
}

async function recordDiscoveryAttempt(kb: KbRuntime, highSeq: number, nextOffset: number): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    recordDiscoveryAttemptLocked(kb, state, highSeq, nextOffset);
  });
}

function addPendingDiscoveryLocked(kb: KbRuntime, state: CurateState, entry: PendingDiscovery): CurateState {
  return persistCurateState(kb, state, applyAddPendingDiscovery(state, entry));
}

async function addPendingDiscovery(kb: KbRuntime, entry: PendingDiscovery): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    addPendingDiscoveryLocked(kb, state, entry);
  });
}

function removePendingDiscoveryLocked(kb: KbRuntime, state: CurateState, entry: PendingDiscovery): CurateState {
  return persistCurateState(kb, state, applyRemovePendingDiscovery(state, entry));
}

async function removePendingDiscovery(kb: KbRuntime, entry: PendingDiscovery): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    removePendingDiscoveryLocked(kb, state, entry);
  });
}

function ensurePrincipleDocumentLocked(
  kb: KbRuntime,
  entry: PendingDiscovery,
  state: CurateState,
): EnsurePrincipleDocumentResult {
  const principlePath = kb.principlePath(assertNoteSlug(entry.principle, 'principle'));
  const nextIndex = cloneKbIndex(kb.readIndex());

  try {
    const liveStatement = extractPrincipleStatement(readFileSync(principlePath, 'utf-8'));
    if (liveStatement !== entry.statement) {
      return { status: 'conflict', state };
    }

    if (nextIndex.principles[entry.principle] !== entry.statement) {
      nextIndex.principles[entry.principle] = entry.statement;
      kb.writeIndex(nextIndex);
      markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);
    }

    return { status: 'ready', state };
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      return { status: 'conflict', state };
    }
  }

  recordMetadataMutation(kb, CURATE_STALE_REASON);
  writeFileAtomic(principlePath, serializePrincipleDocument(entry.statement, entry.createdAt));
  nextIndex.principles[entry.principle] = entry.statement;
  kb.writeIndex(nextIndex);
  return {
    status: 'ready',
    state,
  };
}

function pendingDiscoverySatisfied(kb: KbRuntime, entry: PendingDiscovery, processedThrough: CurateCursor): boolean {
  const index = kb.readIndexOrEmpty();

  return entry.notes.every((note) => {
    const noteMeta = getIndexNote(index, note);
    if (noteMeta === undefined) {
      return true;
    }
    if (noteMeta.entrySeq === undefined) {
      return false;
    }
    if (compareCursor(noteCursor(note, noteMeta.entrySeq), processedThrough) > 0) {
      return false;
    }

    return noteMeta.principles.includes(entry.principle);
  });
}

async function drainPendingDiscoveries(kb: KbRuntime, processedThrough: CurateCursor): Promise<void> {
  await kb.withMutationLock(async () => {
    let state = readCurateState(kb);
    const pendingDiscoveries = state.pendingDiscoveries;

    for (const entry of pendingDiscoveries) {
      const principleDocument = ensurePrincipleDocumentLocked(kb, entry, state);
      state = principleDocument.state;

      if (principleDocument.status === 'conflict') {
        state = removePendingDiscoveryLocked(kb, state, entry);
        continue;
      }

      const targets = buildPrincipleAssignmentTargets(
        entry.principle,
        entry.notes,
        kb.readIndexOrEmpty(),
        processedThrough,
      );
      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, targets, state);
      }

      if (pendingDiscoverySatisfied(kb, entry, processedThrough)) {
        state = removePendingDiscoveryLocked(kb, state, entry);
      }
    }
  });
}

type RunCommunitySubphaseOptions = {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
};

function communitySlugFromReference(reference: string): string {
  const parsed = parseKbEntryId(reference);
  if (parsed !== null && parsed.startsWith('community:')) {
    return parsed.slice('community:'.length);
  }

  return reference;
}

function normalizedCommunitySummaryFingerprints(
  fingerprints: Readonly<Record<string, string>> | undefined,
  communities: ReadonlyArray<{ slug: string }>,
): Record<string, string> | undefined {
  if (fingerprints === undefined) {
    return undefined;
  }

  const allowedSlugs = new Set(communities.map((community) => community.slug));
  const entries = Object.entries(fingerprints)
    .filter(([slug]) => allowedSlugs.has(slug))
    .sort(([left], [right]) => compareLocale(left, right));

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function sameCommunitySummaryFingerprints(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => compareLocale(leftKey, rightKey));
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => compareLocale(leftKey, rightKey));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([slug, fingerprint], index) =>
        rightEntries[index]?.[0] === slug && rightEntries[index]?.[1] === fingerprint,
    )
  );
}

function communitySummaryChildren(
  community: { children?: string[] },
  communitiesBySlug: ReadonlyMap<string, ExistingGeneratedCommunity>,
): Array<{ slug: string; title: string; members: string[]; summary: string }> | undefined {
  if (community.children === undefined || community.children.length === 0) {
    return undefined;
  }

  return [...community.children]
    .sort((left, right) => compareLocale(communitySlugFromReference(left), communitySlugFromReference(right)))
    .map((reference) => {
      const slug = communitySlugFromReference(reference);
      const child = communitiesBySlug.get(slug);
      if (child === undefined) {
        throw new Error(`Missing child community ${reference} while generating community summaries.`);
      }
      if (child.summary === undefined) {
        throw new Error(`Missing child summary for ${reference} while generating parent community summaries.`);
      }

      return {
        slug: child.slug,
        title: child.title,
        members: child.members,
        summary: child.summary,
      };
    });
}

function toExistingGeneratedCommunity(document: {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}): ExistingGeneratedCommunity {
  return {
    slug: document.slug,
    title: document.title,
    level: document.level,
    members: document.members,
    ...(document.parent === undefined ? {} : { parent: document.parent }),
    ...(document.children === undefined ? {} : { children: document.children }),
    ...(document.summary === undefined ? {} : { summary: document.summary }),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

async function runCommunitySubphase(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  options: RunCommunitySubphaseOptions = {},
): Promise<boolean> {
  const { signal, shouldStop = () => false } = options;
  let wroteCommunityFiles = false;

  await kb.withMutationLock(async () => {
    if (shouldStop() || signal?.aborted) {
      return;
    }

    const today = nowIsoString().slice(0, 10);
    const state = readCurateState(kb);
    const finalIndex = kb.readIndexOrEmpty();
    const graph = buildEntityRelationshipGraph({
      entityMeta: finalIndex.entityMeta ?? {},
      relationships: finalIndex.relationships ?? [],
    });
    const topologyHash = computeCommunityTopologyFingerprint(finalIndex, graph);
    const topologyNeedsRefresh = state.communityTopologyHash !== topologyHash;
    const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);

    let activeCommunities = [...priorGeneratedCommunities];
    let pendingArtifactRebuild = false;
    let summaryStateChanged = false;
    const recordCommunityMutation = () => {
      recordMetadataMutation(kb, CURATE_STALE_REASON);
      pendingArtifactRebuild = true;
    };

    if (topologyNeedsRefresh) {
      const communities = detectCommunities(graph, {
        priorCommunities: priorGeneratedCommunities,
        reservedSlugs,
      });
      const communityDocuments = buildCommunityDocuments(communities, {
        priorGeneratedCommunities,
        today,
      });

      if (generateCommunityFiles(kb, communityDocuments, priorGeneratedCommunities, recordCommunityMutation)) {
        wroteCommunityFiles = true;
      }

      activeCommunities = communityDocuments.map(toExistingGeneratedCommunity);
    }

    let currentState = topologyNeedsRefresh ? readCurateState(kb) : state;
    let summaryInputFingerprints = {
      ...(normalizedCommunitySummaryFingerprints(currentState.communitySummaryInputFingerprints, activeCommunities) ?? {}),
    };
    const normalizedFingerprints =
      Object.keys(summaryInputFingerprints).length === 0 ? undefined : summaryInputFingerprints;
    const initialSummaryStateChange =
      currentState.communityTopologyHash !== topologyHash ||
      currentState.communitySummaryTopologyHash !== topologyHash ||
      !sameCommunitySummaryFingerprints(currentState.communitySummaryInputFingerprints, normalizedFingerprints);
    if (initialSummaryStateChange) {
      writeCurateState(kb, {
        ...currentState,
        communityTopologyHash: topologyHash,
        communitySummaryTopologyHash: topologyHash,
        communitySummaryInputFingerprints: normalizedFingerprints,
      });
      summaryStateChanged = true;
    }

    if (pendingArtifactRebuild || (topologyNeedsRefresh && summaryStateChanged)) {
      const rebuildState = kb.readIndexState();
      await rebuildTextArtifactsAndPersistRepairState(kb, {
        contentSeq: rebuildState.contentSeq,
        metadataSeq: rebuildState.metadataSeq,
      });
      pendingArtifactRebuild = false;
      summaryStateChanged = false;
    }

    const communitiesBySlug = new Map(activeCommunities.map((community) => [community.slug, community] as const));
    for (const community of [...activeCommunities].sort((left, right) => {
      if (left.level !== right.level) {
        return left.level - right.level;
      }
      return compareLocale(left.slug, right.slug);
    })) {
      if (shouldStop() || signal?.aborted) {
        break;
      }

      const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
        community,
        communitiesBySlug,
        kb,
        finalIndex,
      );
      const currentSummaryFingerprint = summaryInputFingerprints[community.slug];

      if (community.summary === undefined || currentSummaryFingerprint !== summaryInputFingerprint) {
        const summary = await generateCommunitySummary({
          community: {
            slug: community.slug,
            title: community.title,
            level: community.level,
            members: community.members,
            ...(community.parent === undefined ? {} : { parent: community.parent }),
            ...(community.children === undefined ? {} : { children: community.children }),
          },
          kb,
          index: finalIndex,
          childCommunities: communitySummaryChildren(community, communitiesBySlug),
          priorCommunity: community,
          priorSummaryInputFingerprint: currentSummaryFingerprint,
          runClaude(prompt, extraArgs, summarySignal) {
            return runCurateClaude(kb, spawnCli, prompt, extraArgs, summarySignal);
          },
          signal,
        });

        if (summary !== community.summary) {
          const updatedCommunity: ExistingGeneratedCommunity = {
            ...community,
            ...(summary === undefined ? {} : { summary }),
            updatedAt: today,
          };
          writeFileAtomic(
            kb.communityPath(updatedCommunity.slug),
            renderCommunityDocument({
              title: updatedCommunity.title,
              members: updatedCommunity.members,
              level: updatedCommunity.level,
              ...(updatedCommunity.parent === undefined ? {} : { parent: updatedCommunity.parent }),
              ...(updatedCommunity.children === undefined ? {} : { children: updatedCommunity.children }),
              ...(summary === undefined ? {} : { summary }),
              createdAt: updatedCommunity.createdAt,
              updatedAt: updatedCommunity.updatedAt,
            }),
          );
          recordCommunityMutation();
          wroteCommunityFiles = true;
          communitiesBySlug.set(updatedCommunity.slug, updatedCommunity);
        }
      }

      if (summaryInputFingerprints[community.slug] !== summaryInputFingerprint) {
        summaryInputFingerprints = {
          ...summaryInputFingerprints,
          [community.slug]: summaryInputFingerprint,
        };
        currentState = readCurateState(kb);
        writeCurateState(kb, {
          ...currentState,
          communityTopologyHash: topologyHash,
          communitySummaryTopologyHash: topologyHash,
          communitySummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
            summaryInputFingerprints,
            activeCommunities,
          ),
        });
        summaryStateChanged = true;
      }
    }

    if (pendingArtifactRebuild || summaryStateChanged) {
      const rebuildState = kb.readIndexState();
      await rebuildTextArtifactsAndPersistRepairState(kb, {
        contentSeq: rebuildState.contentSeq,
        metadataSeq: rebuildState.metadataSeq,
      });
    }

    currentState = readCurateState(kb);
    writeCurateState(kb, {
      ...currentState,
      communityTopologyHash: topologyHash,
      communitySummaryTopologyHash: topologyHash,
      communitySummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
        summaryInputFingerprints,
        activeCommunities,
      ),
    });
  });

  return wroteCommunityFiles;
}

type RunPrincipleDiscoveryOptions = {
  signal?: AbortSignal;
  schedule?: () => void;
};

async function runPrincipleDiscovery(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  processedThrough: CurateCursor,
  options: RunPrincipleDiscoveryOptions = {},
): Promise<void> {
  const { signal, schedule } = options;
  await drainPendingDiscoveries(kb, processedThrough);

  const currentIndex = kb.readIndexOrEmpty();
  const preparedBatch = prepareDiscoveryBatch(currentIndex, readCurateState(kb), processedThrough);
  if (preparedBatch === null) {
    return;
  }

  const batch = preparedBatch.batch;
  const eligibleNotes = loadEligibleDiscoveryNotes(kb, batch.selected);

  const { prompt, corpusPath } = buildDiscoveryPrompt(eligibleNotes, currentIndex.principles);
  let raw: string;
  try {
    raw = await runCurateClaude(kb, spawnCli, prompt, undefined, signal);
  } finally {
    unlinkIfExists(corpusPath);
  }
  const { entries, parseFailed } = parseJsonArray(raw);
  if (parseFailed) {
    throw new CurateJsonParseError('discovery');
  }
  const proposals = validateDiscoveryProposals(
    extractDiscoveryProposals(entries),
    eligibleNotes,
    currentIndex.principles,
  );

  await kb.withMutationLock(async () => {
    const refreshedState = readCurateState(kb);
    const refreshedIndex = kb.readIndexOrEmpty();
    const refreshedBatch = prepareDiscoveryBatch(refreshedIndex, refreshedState, processedThrough);
    if (
      refreshedBatch === null ||
      compareCursor(refreshedBatch.processedThrough, preparedBatch.processedThrough) !== 0 ||
      !sameDiscoverySelection(refreshedBatch.batch.selected, batch.selected)
    ) {
      schedule?.();
      return;
    }

    let state = refreshedBatch.state;
    let index = refreshedIndex;
    const repairFrontier = getCurateRepairFrontier(state.pendingRepair);
    const effectiveProcessedThrough = refreshedBatch.processedThrough;

    for (const proposal of proposals) {
      const entry: PendingDiscovery = {
        principle: proposal.slug,
        statement: proposal.statement,
        notes: [...proposal.notes],
        createdAt: nowIsoString(),
      };

      state = addPendingDiscoveryLocked(kb, state, entry);
      const isRefineProposal = index.principles[proposal.slug] !== undefined && (proposal.absorbs?.length ?? 0) === 0;
      const principleDocument = ensurePrincipleDocumentLocked(kb, entry, state);
      state = principleDocument.state;
      index = kb.readIndexOrEmpty();

      if (principleDocument.status === 'conflict') {
        if (!isRefineProposal) {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }

        const principlePath = kb.principlePath(assertNoteSlug(entry.principle, 'principle'));
        let rawPrinciple: string;
        try {
          rawPrinciple = readFileSync(principlePath, 'utf-8');
        } catch {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }
        const createdAtMatch = rawPrinciple.match(/^createdAt:\s*(.+)$/m);
        if (createdAtMatch === null) {
          state = removePendingDiscoveryLocked(kb, state, entry);
          continue;
        }

        const updatedAt = nowIsoString();
        writeFileAtomic(
          principlePath,
          [
            '---',
            `createdAt: ${assertNonEmptyText(createdAtMatch[1] ?? '', 'createdAt')}`,
            `updatedAt: ${updatedAt}`,
            '---',
            '',
            entry.statement,
            '',
          ].join('\n'),
        );
        recordMetadataMutation(kb, CURATE_STALE_REASON);
        const nextIndex = cloneKbIndex(kb.readIndexOrEmpty());
        nextIndex.principles[entry.principle] = entry.statement;
        kb.writeIndex(nextIndex);
        index = nextIndex;
      }

      const targets = filterCandidatesBeforeRepairFrontier(
        buildPrincipleAssignmentTargets(entry.principle, entry.notes, index, effectiveProcessedThrough).map(
          (target) => ({
            cursor: cursorFromTarget(target),
            target,
          }),
        ),
        repairFrontier,
      ).map(({ target }) => target);
      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, targets, state);
        index = kb.readIndexOrEmpty();
      }

      if (pendingDiscoverySatisfied(kb, entry, effectiveProcessedThrough)) {
        state = removePendingDiscoveryLocked(kb, state, entry);
      }
    }

    for (const proposal of proposals) {
      const absorbs = proposal.absorbs ?? [];
      if (absorbs.length === 0) {
        continue;
      }

      const nextIndex = cloneKbIndex(index);
      for (const absorbSlug of absorbs) {
        const absorbedPending = state.pendingDiscoveries.filter((pending) => pending.principle === absorbSlug);
        for (const pending of absorbedPending) {
          state = removePendingDiscoveryLocked(kb, state, pending);
        }

        unlinkIfExists(kb.principlePath(absorbSlug));
        delete nextIndex.principles[absorbSlug];
      }
      recordMetadataMutation(kb, CURATE_STALE_REASON);
      kb.writeIndex(nextIndex);
      index = nextIndex;

      const targets: MetadataTarget[] = [];
      for (const absorbSlug of absorbs) {
        for (const noteMeta of getDiscoveryNotes(index)) {
          const note = noteMeta.slug;
          if (!noteMeta.principles.includes(absorbSlug) || noteMeta.entrySeq === undefined) {
            continue;
          }

          const cursor = noteCursor(note, noteMeta.entrySeq);
          if (
            compareCursor(cursor, effectiveProcessedThrough) > 0 ||
            !isCursorBeforeRepairFrontier(cursor, repairFrontier)
          ) {
            continue;
          }

          targets.push({
            kind: 'note',
            entryId: noteEntryId(assertNoteSlug(note, 'note')),
            slug: assertNoteSlug(note, 'note'),
            entrySeq: noteMeta.entrySeq,
            claimTimeUpdatedAt: noteMeta.updatedAt,
            addPrinciples: [proposal.slug],
            removePrinciples: [absorbSlug],
          });
        }
      }

      if (targets.length > 0) {
        state = await commitMetadataTargetsLocked(kb, targets, state);
        index = kb.readIndexOrEmpty();
      }
    }

    recordDiscoveryAttemptLocked(kb, state, refreshedBatch.batch.nextHighSeq, refreshedBatch.batch.nextOffset);
  });
}

export function createCurateScheduler({
  kb,
  spawnCli,
  scheduleDebounceMs = CURATE_SCHEDULE_DEBOUNCE_MS,
}: {
  kb: KbRuntime;
  spawnCli: SpawnCliFn;
  scheduleDebounceMs?: number;
}): CurateHandle {
  let runtimeStarted = false;
  let stopped = false;
  let queuedRun = false;
  let activeRun: Promise<void> | null = null;
  let activeRunController: AbortController | null = null;
  let retryWakeTimer: NodeJS.Timeout | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let cachedIsGitRepo: boolean | null = null;

  const root = kb.markdownRoot;

  // -- Git operations (all use closure-bound root) --

  function git(args: string[], timeoutMs = 15000): string {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  }

  const execFileP = promisify(execFile);

  async function gitAsync(args: string[], timeoutMs = 15000): Promise<string> {
    const { stdout } = await execFileP('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  function gitCommit(message: string): void {
    try {
      git(['commit', '-m', message], 10000);
    } catch {
      git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-m', message], 10000);
    }
  }

  function isGitRepo(): boolean {
    if (cachedIsGitRepo !== null) return cachedIsGitRepo;
    try {
      git(['rev-parse', '--is-inside-work-tree'], 5000);
      cachedIsGitRepo = true;
    } catch {
      cachedIsGitRepo = false;
    }
    return cachedIsGitRepo;
  }

  function isGitSyncEnabled(): boolean {
    if (process.env.CORAL_KB_GIT_SYNC !== '1') return false;
    try {
      return git(['remote'], 5000).trim().length > 0;
    } catch {
      return false;
    }
  }

  function getDefaultBranch(): string {
    try {
      const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], 5000).trim();
      return ref.replace(/^origin\//, '') || 'main';
    } catch {
      return 'main';
    }
  }

  function hasStagedChanges(): boolean {
    try {
      git(['diff', '--cached', '--quiet'], 5000);
      return false;
    } catch {
      return true;
    }
  }

  function hasConflictMarkers(): boolean {
    try {
      git(['diff', '--check'], 5000);
      return false;
    } catch {
      return true;
    }
  }

  function ensureKbGitignore(): void {
    const gitignorePath = join(root, '.gitignore');
    try {
      let existing = '';
      try {
        existing = readFileSync(gitignorePath, 'utf-8');
      } catch {
        /* no file */
      }
      const lines = existing.split('\n');
      const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.some((line) => line.trim() === entry));
      if (missing.length === 0) return;

      const suffix = `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`;
      const newContent = existing.length === 0 ? suffix : `${existing}\n${suffix}`;
      writeFileAtomic(gitignorePath, newContent);
    } catch {
      // best-effort
    }
  }

  async function resolveConflictsWithClaude(signal?: AbortSignal): Promise<boolean> {
    const prompt =
      'Git rebase conflict in KB repository. Resolve all conflicts in the working tree:' +
      ' keep both changes where possible, prefer the incoming (remote) version for' +
      ' frontmatter metadata (tags, principles, updatedAt), and preserve local body' +
      ' content. Stage all resolved files with git add.';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runCurateClaude(
          kb,
          spawnCli,
          prompt,
          ['--permission-mode', 'bypassPermissions', '--model', 'sonnet'],
          signal,
        );
      } catch {
        return false;
      }

      if (hasConflictMarkers()) continue;

      try {
        git(['add', '-A'], 5000);
        git(['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'rebase', '--continue'], 30000);
        return true;
      } catch {
        // rebase --continue failed — may have another conflicting commit
      }
    }
    return false;
  }

  async function gitSync(signal?: AbortSignal): Promise<void> {
    if (!isGitRepo() || !isGitSyncEnabled()) return;

    // Cancel pending deferred commit — gitSync's pre-sync snapshot handles dirty state
    cancelDeferredCommit();

    const branch = getDefaultBranch();

    try {
      await gitAsync(['fetch', 'origin'], 30000);

      // Commit dirty state (e.g. from Obsidian Sync) instead of stashing.
      try {
        if (git(['status', '--porcelain'], 5000).trim().length > 0) {
          git(['add', '-A'], 5000);
          gitCommit('auto: pre-sync snapshot');
        }
      } catch {
        // commit failure — proceed with rebase anyway
      }

      try {
        await gitAsync(['rebase', `origin/${branch}`]);
      } catch {
        if (!(await resolveConflictsWithClaude(signal))) {
          try {
            git(['rebase', '--abort'], 5000);
          } catch {
            /* no-op */
          }
        }
      }
    } catch {
      // fetch failure (offline, no remote) — proceed with local state
    }
  }

  async function gitPush(): Promise<void> {
    if (!isGitRepo() || !isGitSyncEnabled()) return;
    try {
      await gitAsync(['push', 'origin', getDefaultBranch()], 30000);
    } catch {
      /* next cycle */
    }
  }

  function kbGitPaths(): string[] {
    return ['notes/', 'sources/', 'principles/', 'communities/', '.entity-graph.json', '.gitignore'].filter((entry) =>
      existsSync(join(root, entry.replace(/\/$/, ''))),
    );
  }

  function gitAutoCommit(message: string): void {
    if (!isGitRepo()) return;
    try {
      const paths = kbGitPaths();
      if (paths.length === 0) return;
      git(['add', ...paths], 10000);
      if (!hasStagedChanges()) return;
      gitCommit(message);
    } catch {
      // best-effort
    }
  }

  // Debounced async git commit for external mutations (promote/update/delete).
  // Batches changes within a 60s window into a single commit.
  const DEFERRED_COMMIT_DELAY_MS = 60_000;
  let deferredCommitTimer: NodeJS.Timeout | null = null;

  async function gitAutoCommitAsync(message: string): Promise<void> {
    if (!isGitRepo()) return;
    try {
      const paths = kbGitPaths();
      if (paths.length === 0) return;
      await gitAsync(['add', ...paths], 10000);
      if (!hasStagedChanges()) return;
      gitCommit(message);
    } catch {
      // best-effort
    }
  }

  function scheduleDeferredCommit(): void {
    if (!isGitRepo()) return;
    if (deferredCommitTimer !== null) return;
    deferredCommitTimer = setTimeout(() => {
      deferredCommitTimer = null;
      void gitAutoCommitAsync('auto: kb mutation');
    }, DEFERRED_COMMIT_DELAY_MS);
    deferredCommitTimer.unref?.();
  }

  function cancelDeferredCommit(): void {
    if (deferredCommitTimer !== null) {
      clearTimeout(deferredCommitTimer);
      deferredCommitTimer = null;
    }
  }

  async function hasPendingEntriesBeyondCursor(cursor: CurateCursor): Promise<boolean> {
    return kb.withMutationLock(() => {
      const state = readCurateState(kb);
      const index = kb.readIndex();
      if (index === null) {
        return false;
      }

      const repairFrontier = getCurateRepairFrontier(state.pendingRepair);
      return filterCandidatesBeforeRepairFrontier(collectClaimCandidates(index), repairFrontier).some(
        (candidate) => compareCursor(candidate.cursor, cursor) > 0,
      );
    });
  }

  function clearRetryWake(): void {
    if (retryWakeTimer !== null) {
      clearTimeout(retryWakeTimer);
      retryWakeTimer = null;
    }
  }

  function armRetryWake(knownState?: CurateState): void {
    clearRetryWake();

    if (stopped) {
      return;
    }
    if (!runtimeStarted) {
      return;
    }

    const state = knownState ?? readCurateState(kb);
    if (state.retryNotBefore === null) {
      return;
    }

    const delayMs = Date.parse(state.retryNotBefore) - Date.now();
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      schedule();
      return;
    }

    retryWakeTimer = setTimeout(() => {
      retryWakeTimer = null;
      schedule();
    }, delayMs);
  }

  async function runScheduledCurate(signal: AbortSignal): Promise<CurateCursor | null> {
    await gitSync(signal);
    let lastCompletedThrough: CurateCursor | null = null;

    while (!stopped && !signal.aborted) {
      const claim = await claimCurateRun(kb, nowIsoString().slice(0, 10));
      if (claim === null) {
        break;
      }

      try {
        const claimIndex = kb.readIndexOrEmpty();
        const validatedAssignments = await runClassificationBatches(kb, spawnCli, claim, claimIndex, signal);
        const metadataTargets = buildMetadataTargets(validatedAssignments, claimIndex, claim.entries);
        await commitMetadataTargets(kb, metadataTargets, validatedAssignments);
        gitAutoCommit(`curate: classify ${claim.entries.length} entries (tags + principles)`);

        await clearCurateRetryState(kb);
        lastCompletedThrough = claim.through;
      } catch (error: unknown) {
        throw new CurateRunError(claim.through, error);
      }
    }

    if (lastCompletedThrough === null) {
      // Consume stale retry state so armRetryWake doesn't re-trigger.
      // Skip if a live claim exists — clearCurateRetryState also clears activeClaim.
      await kb.withMutationLock(() => {
        const state = readCurateState(kb);
        if (state.activeClaim !== null && !isClaimStale(state, nowIsoString())) return;
        clearCurateRetryStateLocked(kb, state);
      });
      return null;
    }

    // Discovery runs once after all classification claims, seeing the full corpus.
    const postClassifyState = readCurateState(kb);
    const processedThrough = postClassifyState.processedThrough;

    if (!stopped && !signal.aborted && processedThrough !== null) {
      try {
        await runPrincipleDiscovery(kb, spawnCli, processedThrough, { signal, schedule });
        gitAutoCommit('curate: discover principles');
      } catch (error: unknown) {
        throw new CurateRunError(lastCompletedThrough, error);
      }
    }

    if (!stopped && !signal.aborted) {
      try {
        if (await runCommunitySubphase(kb, spawnCli, { signal, shouldStop: () => stopped })) {
          gitAutoCommit('curate: detect communities');
        }
      } catch (error: unknown) {
        throw new CurateRunError(lastCompletedThrough, error);
      }
    }

    if (!stopped && !signal.aborted) await gitPush();
    return lastCompletedThrough;
  }

  function launchQueuedRun(): void {
    if (stopped || !runtimeStarted || activeRun !== null || !queuedRun) {
      return;
    }
    if (isUsageBudgetExhausted()) {
      return;
    }

    queuedRun = false;
    const runController = new AbortController();
    activeRunController = runController;
    activeRun = (async () => {
      let lastCompletedThrough: CurateCursor | null = null;

      try {
        lastCompletedThrough = await runScheduledCurate(runController.signal);
        if (!stopped && !runController.signal.aborted && lastCompletedThrough === null) {
          if (await runCommunitySubphase(kb, spawnCli, { signal: runController.signal, shouldStop: () => stopped })) {
            gitAutoCommit('curate: detect communities');
            await gitPush();
          }
        }
      } catch (error: unknown) {
        if (stopped && runController.signal.aborted) {
          try {
            await clearCurateRetryState(kb);
          } catch (stateError: unknown) {
            backendLog.error('kb_curate: failed to clear stop state', stateError);
          }
          return;
        }
        const runError = error instanceof CurateRunError ? error : new CurateRunError(null, error);
        backendLog.error('kb_curate: run failed', runError.cause);
        try {
          await recordCurateFailure(kb, runError.through, runError.cause);
        } catch (stateError: unknown) {
          backendLog.error('kb_curate: failed to persist retry state', stateError);
        }
      } finally {
        activeRun = null;
        if (activeRunController === runController) {
          activeRunController = null;
        }
        try {
          if (!stopped) {
            armRetryWake();
          }
        } catch (error: unknown) {
          backendLog.error('kb_curate', error);
        }
        if (!stopped && lastCompletedThrough !== null) {
          try {
            if (await hasPendingEntriesBeyondCursor(lastCompletedThrough)) {
              schedule();
            }
          } catch (error: unknown) {
            backendLog.error('kb_curate', error);
          }
        }
      }
    })();
  }

  async function start(): Promise<void> {
    if (runtimeStarted) {
      return;
    }

    ensureKbGitignore();
    await kb.ensureIndex();
    await migrateCurateStateIfNeeded(kb);
    runtimeStarted = true;
    armRetryWake();
    schedule();
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    queuedRun = true;
    if (!runtimeStarted) {
      return;
    }

    clearRetryWake();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    if (scheduleDebounceMs <= 0) {
      setTimeout(launchQueuedRun, 0);
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      launchQueuedRun();
    }, scheduleDebounceMs);
  }

  async function stop(): Promise<void> {
    stopped = true;
    queuedRun = false;
    clearRetryWake();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    cancelDeferredCommit();
    const run = activeRun;
    const runController = activeRunController;
    if (runController !== null) {
      runController.abort();
    }
    if (run !== null) {
      try {
        await run;
      } catch (error: unknown) {
        if (!(stopped && runController?.signal.aborted)) {
          throw error;
        }
      }
    }
  }

  return {
    start,
    schedule,
    stop,
    scheduleDeferredCommit,
    isRunning() {
      return queuedRun || activeRun !== null || retryWakeTimer !== null || debounceTimer !== null;
    },
    _testInternals: {
      claimCurateRun(today) {
        return claimCurateRun(kb, today);
      },
      runClassificationBatches(claim, index) {
        return runClassificationBatches(kb, spawnCli, claim, index);
      },
      commitMetadataTargets(targets) {
        return commitMetadataTargets(kb, targets);
      },
      runPrincipleDiscovery(processedThrough) {
        return runPrincipleDiscovery(kb, spawnCli, processedThrough, { schedule });
      },
      recordCurateFailure(through, error) {
        return recordCurateFailure(kb, through, error);
      },
      clearCurateRetryState() {
        return clearCurateRetryState(kb);
      },
      recordDiscoveryAttempt(highSeq, nextOffset) {
        return recordDiscoveryAttempt(kb, highSeq, nextOffset);
      },
      addPendingDiscovery(entry) {
        return addPendingDiscovery(kb, entry);
      },
      removePendingDiscovery(entry) {
        return removePendingDiscovery(kb, entry);
      },
      runCommunitySubphase() {
        return runCommunitySubphase(kb, spawnCli, { shouldStop: () => stopped });
      },
      async migrateCurateStateIfNeeded() {
        await migrateCurateStateIfNeeded(kb);
      },
    },
  };
}
