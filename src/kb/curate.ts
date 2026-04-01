import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  errorMessage,
  isNoEntryError,
  isRecord,
  isStringArray,
  nowIsoString,
  unlinkIfExists,
} from '../shared/mcp-utils.js';
import {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  isClaimStale,
  migrateCurateStateIfNeeded,
  readCurateState,
  sameStringList,
  writeCurateState,
  type CurateCursor,
  type CurateState,
} from './curate-state.js';
import { cleanupTags, countTagSupport, type TagCleanupResult } from './curate-tags.js';
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
import { assertNonEmptyText, assertNoteSlug, compareLocale } from './validation.js';
import {
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneKbIndex,
  markTextIndexStale,
  writeFileAtomic,
} from './mutation-helpers.js';
import { runEntrySeqUpgradeGuard, type KbRuntime } from './runtime.js';
import {
  getEntry,
  isNoteEntry,
  parseKbEntryId,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type EntryRecord,
  type KbEntryId,
  type KbIndex,
  type NoteEntry,
} from './types.js';
import { backendLog } from '../shared/backend-log.js';

// -- Schedule debounce --
const CURATE_SCHEDULE_DEBOUNCE_MS = 60 * 1000;

// -- Claim thresholds --
const CURATE_MIN_CLAIM_SIZE = 10;
const CURATE_IMMEDIATE_CLAIM_SIZE = 30;
const CURATE_MAX_CLAIM_SIZE = 100;
const CLASSIFICATION_BATCH_SIZE = 100;
const CLASSIFICATION_REQUEST_TOKEN_BUDGET = 12_000;
const CLASSIFICATION_RESPONSE_TOKEN_HEADROOM = 2_000;
const CLASSIFICATION_SOURCE_EXCERPT_TOKEN_LIMIT = 2_000;

// -- Principle discovery --
const DISCOVERY_NEW_NOTE_THRESHOLD = 50;
const DISCOVERY_BATCH_SIZE = 100;
const DISCOVERY_PROMPT_BODY_LIMIT = 4000;
const DISCOVERY_MAX_MERGES = 2;
const DISCOVERY_MAX_REFINES = 3;

// -- Usage budget --
const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 90;
const USAGE_WK_THRESHOLD = 100;

const CURATE_STALE_REASON = 'KB text snapshot is stale after kb_curate.';
const GITIGNORE_ENTRIES = ['data/', '.obsidian/'];

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
  cleanup?: boolean;
};

export type ClassificationAssignment = {
  entry: string;
  tags: string[];
  principles?: string[];
  related?: string[];
};

export type DiscoveryProposal = {
  slug: string;
  statement: string;
  notes: string[];
  absorbs?: string[];
};

type PendingDiscovery = CurateState['pendingDiscoveries'][number];

type EnsurePrincipleDocumentResult = {
  status: 'ready' | 'conflict';
  state: CurateState;
};

export type MetadataTarget = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  entrySeq: number;
  claimTimeFingerprint: string;
  addTags?: string[];
  addRelated?: string[];
} | NoteMetadataTarget;

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

function stripMarkdownCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonArray(raw: string): ParsedArrayResult {
  const normalized = stripMarkdownCodeFences(raw.trim());
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    return {
      entries: [],
      parseFailed: true,
    };
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

function countClassificationTagSupport(index: KbIndex): Map<string, number> {
  const counts = new Map<string, number>();

  for (const entry of getCuratableEntries(index)) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return counts;
}

function buildTagVocabulary(index: KbIndex): string[] {
  return [...countClassificationTagSupport(index).keys()].sort(compareLocale);
}

function buildPrincipleNames(index: KbIndex): string[] {
  return Object.keys(index.principles).sort(compareLocale);
}

function getIndexNote(index: KbIndex, note: string): NoteEntry | undefined {
  const entry = getEntry(index, noteEntryId(note));
  return entry !== undefined && isNoteEntry(entry) ? entry : undefined;
}

function getCuratableEntries(index: KbIndex): EntryRecord[] {
  return Object.values(index.entries);
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

function parentAbsorptionTarget(
  tag: string,
  noteTagSet: ReadonlySet<string>,
  tagSupport: ReadonlyMap<string, number>,
): string | null {
  const splitAt = tag.lastIndexOf('-');
  if (splitAt <= 0) {
    return null;
  }

  const core = tag.slice(0, splitAt);
  if (!noteTagSet.has(core)) {
    return null;
  }
  if ((tagSupport.get(core) ?? 0) < 3) {
    return null;
  }

  return core;
}

function hasParentAbsorptionCandidate(note: string, tags: string[], tagSupport: ReadonlyMap<string, number>): boolean {
  const domain = deriveNoteIdentity(note).domain;
  const noteTagSet = new Set(tags);

  return tags.some((tag) => tag !== domain && parentAbsorptionTarget(tag, noteTagSet, tagSupport) !== null);
}

function applyParentAbsorption(note: string, tags: string[], tagSupport: ReadonlyMap<string, number>): string[] {
  const domain = deriveNoteIdentity(note).domain;
  const noteTagSet = new Set(tags);
  const nextTags = tags.map((tag) => {
    if (tag === domain) {
      return tag;
    }

    return parentAbsorptionTarget(tag, noteTagSet, tagSupport) ?? tag;
  });

  return uniqueTrimmedList(nextTags);
}

function buildLiveNoteMetadataDecision(
  target: NoteMetadataTarget,
  liveTags: string[],
  livePrinciples: string[],
  cleanupTagSupport: ReadonlyMap<string, number>,
): LiveMetadataDecision {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const addPrinciples = uniqueTrimmedList(target.addPrinciples ?? []);
  const removePrinciples = uniqueTrimmedList(target.removePrinciples ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined ? undefined : uniqueTrimmedList(target.desiredTags);

  if (target.cleanup && removeTags.length > 0 && removeTags.some((tag) => !liveTags.includes(tag))) {
    return {
      shouldWrite: false,
      nextTags: [...liveTags],
      nextPrinciples: [...livePrinciples],
    };
  }

  const removeTagSet = new Set(removeTags);
  let nextTags = desiredTags ?? uniqueTrimmedList([...liveTags, ...addTags]).filter((tag) => !removeTagSet.has(tag));
  if (target.cleanup) {
    nextTags = applyParentAbsorption(target.slug, nextTags, cleanupTagSupport);
  }

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

function buildLiveSourceMetadataDecision(target: Extract<MetadataTarget, { kind: 'source' }>, liveTags: string[]): string[] {
  return uniqueTrimmedList([...liveTags, ...(target.addTags ?? [])]);
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

function applyGlobalCleanup(note: string, tags: string[], cleanup: TagCleanupResult): string[] {
  const domain = deriveNoteIdentity(note).domain;

  return uniqueTrimmedList(
    tags.flatMap((tag) => {
      if (tag === domain) {
        return [tag];
      }

      const replacement = cleanup.globalReplacements.get(tag);
      if (replacement !== undefined) {
        return [replacement];
      }
      if (cleanup.globalDeletions.has(tag)) {
        return [];
      }

      return [tag];
    }),
  );
}

function buildCleanupTargets(index: KbIndex, cohortNotes: string[], cleanup: TagCleanupResult): MetadataTarget[] {
  const tagSupport = countTagSupport(index);
  const targets: MetadataTarget[] = [];

  for (const slug of cohortNotes) {
    const noteMeta = getIndexNote(index, slug);
    if (noteMeta === undefined || noteMeta.entrySeq === undefined) {
      continue;
    }

    const desiredTags = applyGlobalCleanup(slug, noteMeta.tags, cleanup);
    const desiredSet = new Set(desiredTags);
    const removeTags = noteMeta.tags.filter((tag) => !desiredSet.has(tag));
    const parentAbsorptionPending = hasParentAbsorptionCandidate(slug, desiredTags, tagSupport);

    if (!parentAbsorptionPending && sameStringList(desiredTags, noteMeta.tags)) {
      continue;
    }

    targets.push({
      kind: 'note',
      entryId: noteEntryId(slug),
      slug,
      entrySeq: noteMeta.entrySeq,
      claimTimeUpdatedAt: noteMeta.updatedAt,
      desiredTags,
      cleanup: true,
      ...(removeTags.length === 0 ? {} : { removeTags }),
    });
  }

  return targets.sort(compareMetadataTarget);
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
  tagVocab: string[],
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
  tagVocab: string[],
  principleNames: string[],
): string {
  const lines = [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    'Use KB entry IDs exactly as written, including the note:/source: prefix. Never return bare slugs.',
    'Tag vocabulary:',
    buildFlatList(tagVocab),
    'Use only tags from the tag vocabulary.',
  ];

  if (shape === 'source-only') {
    lines.push('Each source entry must return tags and related only.');
    return lines.join('\n\n');
  }

  lines.push('Principle names:', buildFlatList(principleNames));
  lines.push('Use only principle names from the principle list.');
  lines.push(
    'Each note entry must return tags, principles, and related. Source entries in the same batch return tags and related; omit principles or return [].',
  );
  return lines.join('\n\n');
}

function buildClassificationPromptFooter(shape: ClassificationBatchShape): string {
  return shape === 'source-only'
    ? 'Return a JSON array: [{ "entry": "source:<slug>", "tags": ["<tag>", ...], "related": ["source:<slug>", "note:<slug>"] }]'
    : 'Return a JSON array: [{ "entry": "note:<slug>", "tags": ["<tag>", ...], "principles": ["<principle>", ...], "related": ["source:<slug>", "note:<slug>"] }]';
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
  tagVocab: string[],
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
  tagVocab: string[],
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
  tagVocab: string[],
  principleNames: string[],
): void {
  if (estimateClassificationScaffoldTokens(shape, tagVocab, principleNames) > classificationPromptTokenLimit()) {
    throw new Error(`Classification ${shape} scaffold exceeds the request budget.`);
  }
}

function fitSourceEntryToPromptBudget(
  entry: SourceCurateClaimedEntry,
  tagVocab: string[],
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

    const normalizedRelated = uniqueTrimmedList(
      related.flatMap((relatedEntryId) => {
        const normalized = parseKbEntryId(relatedEntryId);
        return normalized === null ? [] : [normalized];
      }),
    );

    assignments.push({
      entry: parsedEntryId,
      tags: [...entry.tags],
      principles: [...principles],
      ...(normalizedRelated.length === 0 ? {} : { related: normalizedRelated }),
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
  tagVocab: string[],
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

export function validateAssignments(
  proposals: ClassificationAssignment[],
  index: KbIndex,
  claimedEntries: CurateClaimedEntry[],
): ClassificationAssignment[] {
  const existingTagVocabulary = new Set(countClassificationTagSupport(index).keys());
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
      mergedByEntry.set(entryId, {
        entry: entryId,
        tags: uniqueTrimmedList(proposal.tags),
        principles: uniqueTrimmedList(proposal.principles ?? []),
        ...(related.length === 0 ? {} : { related }),
      });
      continue;
    }

    existing.tags = uniqueTrimmedList([...existing.tags, ...proposal.tags]);
    existing.principles = uniqueTrimmedList([...(existing.principles ?? []), ...(proposal.principles ?? [])]);
    const mergedRelated = uniqueTrimmedList([...(existing.related ?? []), ...related]);
    if (mergedRelated.length === 0) {
      delete existing.related;
      continue;
    }

    existing.related = mergedRelated;
  }

  const newTagSupport = new Map<string, number>();
  for (const proposal of mergedByEntry.values()) {
    const seenNewTags = new Set<string>();
    for (const tag of proposal.tags) {
      if (existingTagVocabulary.has(tag) || seenNewTags.has(tag)) {
        continue;
      }
      seenNewTags.add(tag);
      newTagSupport.set(tag, (newTagSupport.get(tag) ?? 0) + 1);
    }
  }

  const validated: ClassificationAssignment[] = [];
  for (const entryId of claimedOrder) {
    const proposal = mergedByEntry.get(entryId);
    const claimedEntry = claimedByEntryId.get(entryId);
    if (proposal === undefined || claimedEntry === undefined) {
      continue;
    }

    const filteredTags = proposal.tags.filter(
      (tag) => existingTagVocabulary.has(tag) || (newTagSupport.get(tag) ?? 0) >= 3,
    );
    const tags =
      claimedEntry.kind === 'note'
        ? uniqueTrimmedList([deriveNoteIdentity(claimedEntry.slug).domain, ...filteredTags])
        : uniqueTrimmedList(filteredTags);
    const principles =
      claimedEntry.kind === 'note'
        ? uniqueTrimmedList((proposal.principles ?? []).filter((principle) => index.principles[principle] !== undefined))
        : [];
    const related = uniqueTrimmedList(
      (proposal.related ?? []).filter((relatedEntryId) => relatedEntryId !== entryId && getEntry(index, relatedEntryId as KbEntryId) !== undefined),
    );

    validated.push({
      entry: entryId,
      tags,
      principles,
      ...(related.length === 0 ? {} : { related }),
    });
  }

  return validated;
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
      const existingTags = new Set(claimTimeMeta?.tags ?? []);
      const existingRelated = new Set(claimTimeMeta?.related ?? []);
      const assignment = assignmentsByEntryId.get(claimedEntry.entryId);
      const addTags = uniqueTrimmedList((assignment?.tags ?? []).filter((tag) => !existingTags.has(tag)));
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
          ...(addTags.length === 0 ? {} : { addTags }),
          ...(addRelated.length === 0 ? {} : { addRelated }),
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
        ...(addTags.length === 0 ? {} : { addTags }),
        ...(addRelated.length === 0 ? {} : { addRelated }),
        ...(addPrinciples.length === 0 ? {} : { addPrinciples }),
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

  // -- Claude invocation (KB-scoped) --

  async function runClaude(prompt: string, extraArgs?: string[], signal?: AbortSignal): Promise<string> {
    const result = await spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p', '--no-session-persistence', ...(extraArgs ?? [])],
      prompt,
      cwd: root,
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

      if (existing.length === 0) {
        writeFileSync(gitignorePath, `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`, 'utf-8');
      } else {
        appendFileSync(gitignorePath, `\n${GITIGNORE_HEADER}\n${missing.join('\n')}\n`, 'utf-8');
      }
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
        await runClaude(prompt, ['--permission-mode', 'bypassPermissions', '--model', 'sonnet'], signal);
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

  function gitAutoCommit(message: string): void {
    if (!isGitRepo()) return;
    try {
      git(['add', 'notes/', 'sources/', 'principles/', '.gitignore'], 10000);
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
      await gitAsync(['add', 'notes/', 'sources/', 'principles/', '.gitignore'], 10000);
      if (!hasStagedChanges()) return;
      gitCommit(message);
    } catch {
      // best-effort
    }
  }

  function scheduleDeferredCommit(): void {
    if (!isGitRepo()) return;
    if (deferredCommitTimer !== null) return; // already scheduled
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

  function readClaimedEntry(candidate: ClaimCandidate): CurateClaimedEntry {
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

  function persistCurateState(state: CurateState, next: CurateState | null): CurateState {
    if (next === null) {
      return state;
    }

    writeCurateState(kb, next);
    return next;
  }

  function recordCurateFailureLocked(state: CurateState, through: CurateCursor | null, error: unknown): CurateState {
    return persistCurateState(state, applyRecordCurateFailure(state, through, error));
  }

  async function recordCurateFailure(through: CurateCursor | null, error: unknown): Promise<void> {
    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      recordCurateFailureLocked(state, through, error);
    });
  }

  function clearCurateRetryStateLocked(state: CurateState): CurateState {
    return persistCurateState(state, applyClearCurateRetryState(state));
  }

  async function clearCurateRetryState(): Promise<void> {
    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      clearCurateRetryStateLocked(state);
    });
  }

  async function hasPendingEntriesBeyondCursor(cursor: CurateCursor): Promise<boolean> {
    return kb.withMutationLock(() => {
      const index = kb.readIndex();
      if (index === null) {
        return false;
      }

      return collectClaimCandidates(index).some((candidate) => compareCursor(candidate.cursor, cursor) > 0);
    });
  }

  function clearRetryWake(): void {
    if (retryWakeTimer !== null) {
      clearTimeout(retryWakeTimer);
      retryWakeTimer = null;
    }
  }

  function armRetryWake(): void {
    clearRetryWake();

    if (stopped) {
      return;
    }
    if (!runtimeStarted) {
      return;
    }

    const state = readCurateState(kb);
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

  async function claimCurateRun(today: string): Promise<CurateClaim | null> {
    return kb.withMutationLock(() => {
      const state = readCurateState(kb);
      const now = nowIsoString();

      if (state.activeClaim !== null && !isClaimStale(state, now)) {
        return null;
      }

      const index = kb.readIndex();
      if (index === null) {
        return null;
      }

      const pendingEntries = collectClaimCandidates(index).filter(
        (candidate) => compareOptionalCursor(state.processedThrough, candidate.cursor) < 0,
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

      const claim: CurateClaim = {
        entries: claimedCandidates.map(readClaimedEntry),
        through,
      };
      const freshPendingSuffix = pendingExtendsBeyondCursor(pendingEntries, state.lastAttemptedThrough);

      writeCurateState(kb, {
        ...state,
        retryNotBefore: null,
        activeClaim: {
          through,
          startedAt: now,
        },
        lastAttemptedThrough: through,
        consecutiveFailures: freshPendingSuffix ? 0 : state.consecutiveFailures,
        ...(firstPassClaim ? { lastRunDay: today } : {}),
      });

      return claim;
    });
  }

  async function runClassificationBatches(
    claim: CurateClaim,
    index: KbIndex,
    signal?: AbortSignal,
  ): Promise<ClassificationAssignment[]> {
    const rawAssignments: ClassificationAssignment[] = [];
    const tagVocab = buildTagVocabulary(index);
    const principleNames = buildPrincipleNames(index);

    for (const batch of chunkEntriesByPromptBudget(
      claim.entries,
      tagVocab,
      principleNames,
      CLASSIFICATION_BATCH_SIZE,
    )) {
      const prompt = buildClassificationPrompt(batch, tagVocab, principleNames);
      const raw = await runClaude(prompt, undefined, signal);
      const { entries, parseFailed } = parseJsonArray(raw);
      if (parseFailed) {
        throw new CurateJsonParseError('classification');
      }
      const entryMap = new Map<string, true>(batch.map((entry) => [entry.entryId, true] as const));
      rawAssignments.push(...classifyParsedEntries(entries, entryMap));
    }

    return rawAssignments;
  }

  async function commitMetadataTargetsLocked(targets: MetadataTarget[], state: CurateState): Promise<CurateState> {
    const sortedTargets = [...targets].sort(compareMetadataTarget);
    const currentIndex = kb.readIndexOrEmpty();
    const nextIndex = cloneKbIndex(currentIndex);
    const hasCleanup = sortedTargets.some((target) => target.kind === 'note' && target.cleanup === true);
    const cleanupTagSupport = hasCleanup ? countTagSupport(currentIndex) : new Map<string, number>();
    let processedThrough = state.processedThrough;
    let cursorCanAdvance = true;
    let wroteMarkdown = false;
    let failure: unknown = null;

    for (const target of sortedTargets) {
      const cursor = cursorFromTarget(target);
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

        const metadataDecision = buildLiveNoteMetadataDecision(
          target,
          liveFrontmatter.tags,
          liveFrontmatter.principles,
          cleanupTagSupport,
        );
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
        kb.recordMutationCommitted();
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
      kb.recordMutationCommitted();
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
      kb.writeIndex(nextIndex);

      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
    }

    const nextState = {
      ...state,
      processedThrough,
      activeClaim: null,
    };

    if (wroteMarkdown) {
      try {
        kb.writeIndex(nextIndex);
      } catch (error: unknown) {
        failure ??= error;
      }
    }

    try {
      writeCurateState(kb, nextState);
    } catch (error: unknown) {
      failure ??= error;
    }

    if (wroteMarkdown) {
      try {
        markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);
      } catch (error: unknown) {
        failure ??= error;
      }
    }

    if (failure !== null) {
      if (failure instanceof Error) throw failure;
      throw new Error(typeof failure === 'string' ? failure : 'Unknown error');
    }

    return nextState;
  }

  async function commitMetadataTargets(targets: MetadataTarget[]): Promise<void> {
    await kb.withMutationLock(async () => {
      runEntrySeqUpgradeGuard(kb);
      const state = readCurateState(kb);
      await commitMetadataTargetsLocked(targets, state);
    });
  }

  function loadEligibleDiscoveryNotes(candidates: NoteClaimCandidate[]): DiscoveryCurateClaimedEntry[] {
    const eligible: DiscoveryCurateClaimedEntry[] = [];

    for (const candidate of candidates) {
      try {
        const entry = readClaimedEntry(candidate);
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

  function recordDiscoveryAttemptLocked(state: CurateState, highSeq: number, nextOffset: number): CurateState {
    return persistCurateState(state, applyRecordDiscoveryAttempt(state, highSeq, nextOffset));
  }

  async function recordDiscoveryAttempt(highSeq: number, nextOffset: number): Promise<void> {
    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      recordDiscoveryAttemptLocked(state, highSeq, nextOffset);
    });
  }

  function addPendingDiscoveryLocked(state: CurateState, entry: PendingDiscovery): CurateState {
    return persistCurateState(state, applyAddPendingDiscovery(state, entry));
  }

  async function addPendingDiscovery(entry: PendingDiscovery): Promise<void> {
    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      addPendingDiscoveryLocked(state, entry);
    });
  }

  function removePendingDiscoveryLocked(state: CurateState, entry: PendingDiscovery): CurateState {
    return persistCurateState(state, applyRemovePendingDiscovery(state, entry));
  }

  async function removePendingDiscovery(entry: PendingDiscovery): Promise<void> {
    await kb.withMutationLock(() => {
      const state = readCurateState(kb);
      removePendingDiscoveryLocked(state, entry);
    });
  }

  function ensurePrincipleDocumentLocked(entry: PendingDiscovery, state: CurateState): EnsurePrincipleDocumentResult {
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

    kb.recordMutationCommitted();
    writeFileAtomic(principlePath, serializePrincipleDocument(entry.statement, entry.createdAt));
    nextIndex.principles[entry.principle] = entry.statement;
    kb.writeIndex(nextIndex);
    markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);
    return {
      status: 'ready',
      state,
    };
  }

  function pendingDiscoverySatisfied(entry: PendingDiscovery, processedThrough: CurateCursor): boolean {
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

  async function drainPendingDiscoveries(processedThrough: CurateCursor): Promise<void> {
    await kb.withMutationLock(async () => {
      let state = readCurateState(kb);
      const pendingDiscoveries = state.pendingDiscoveries;

      for (const entry of pendingDiscoveries) {
        const principleDocument = ensurePrincipleDocumentLocked(entry, state);
        state = principleDocument.state;

        if (principleDocument.status === 'conflict') {
          state = removePendingDiscoveryLocked(state, entry);
          continue;
        }

        const targets = buildPrincipleAssignmentTargets(
          entry.principle,
          entry.notes,
          kb.readIndexOrEmpty(),
          processedThrough,
        );
        if (targets.length > 0) {
          state = await commitMetadataTargetsLocked(targets, state);
        }

        if (pendingDiscoverySatisfied(entry, processedThrough)) {
          state = removePendingDiscoveryLocked(state, entry);
        }
      }
    });
  }

  async function runPrincipleDiscovery(processedThrough: CurateCursor, signal?: AbortSignal): Promise<void> {
    await drainPendingDiscoveries(processedThrough);

    const currentIndex = kb.readIndexOrEmpty();
    let state = readCurateState(kb);

    const allClassified = collectDiscoveryCandidates(currentIndex).filter(
      (c) => compareCursor(c.cursor, processedThrough) <= 0,
    );
    const newNotes = allClassified.filter((c) => c.cursor.entrySeq > state.discoveryHighSeq);

    if (newNotes.length < DISCOVERY_NEW_NOTE_THRESHOLD) {
      return;
    }

    const batch = selectDiscoveryBatch(allClassified, state.discoveryHighSeq, state.discoveryOffset);
    const eligibleNotes = loadEligibleDiscoveryNotes(batch.selected);

    const { prompt, corpusPath } = buildDiscoveryPrompt(eligibleNotes, currentIndex.principles);
    let raw: string;
    try {
      raw = await runClaude(prompt, undefined, signal);
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
      let index = kb.readIndexOrEmpty();

      for (const proposal of proposals) {
        const entry: PendingDiscovery = {
          principle: proposal.slug,
          statement: proposal.statement,
          notes: [...proposal.notes],
          createdAt: nowIsoString(),
        };

        state = addPendingDiscoveryLocked(state, entry);
        const isRefineProposal = index.principles[proposal.slug] !== undefined && (proposal.absorbs?.length ?? 0) === 0;
        const principleDocument = ensurePrincipleDocumentLocked(entry, state);
        state = principleDocument.state;
        index = kb.readIndexOrEmpty();

        if (principleDocument.status === 'conflict') {
          if (!isRefineProposal) {
            state = removePendingDiscoveryLocked(state, entry);
            continue;
          }

          const principlePath = kb.principlePath(assertNoteSlug(entry.principle, 'principle'));
          let rawPrinciple: string;
          try {
            rawPrinciple = readFileSync(principlePath, 'utf-8');
          } catch {
            state = removePendingDiscoveryLocked(state, entry);
            continue;
          }
          const createdAtMatch = rawPrinciple.match(/^createdAt:\s*(.+)$/m);
          if (createdAtMatch === null) {
            state = removePendingDiscoveryLocked(state, entry);
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
          kb.recordMutationCommitted();
          const nextIndex = cloneKbIndex(kb.readIndexOrEmpty());
          nextIndex.principles[entry.principle] = entry.statement;
          kb.writeIndex(nextIndex);
          index = nextIndex;
          markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);
        }

        const targets = buildPrincipleAssignmentTargets(entry.principle, entry.notes, index, processedThrough);
        if (targets.length > 0) {
          state = await commitMetadataTargetsLocked(targets, state);
          index = kb.readIndexOrEmpty();
        }

        if (pendingDiscoverySatisfied(entry, processedThrough)) {
          state = removePendingDiscoveryLocked(state, entry);
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
            state = removePendingDiscoveryLocked(state, pending);
          }

          unlinkIfExists(kb.principlePath(absorbSlug));
          delete nextIndex.principles[absorbSlug];
        }
        kb.writeIndex(nextIndex);
        index = nextIndex;
        markTextIndexStale(kb.invalidateTextSnapshot, CURATE_STALE_REASON);

        const targets: MetadataTarget[] = [];
        for (const absorbSlug of absorbs) {
          for (const noteMeta of getDiscoveryNotes(index)) {
            const note = noteMeta.slug;
            if (!noteMeta.principles.includes(absorbSlug) || noteMeta.entrySeq === undefined) {
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
          state = await commitMetadataTargetsLocked(targets, state);
          index = kb.readIndexOrEmpty();
        }
      }

      state = recordDiscoveryAttemptLocked(state, batch.nextHighSeq, batch.nextOffset);
    });
  }

  async function runScheduledCurate(signal: AbortSignal): Promise<CurateCursor | null> {
    await gitSync(signal);
    let lastCompletedThrough: CurateCursor | null = null;
    const allCohortSlugs: string[] = [];

    while (!stopped && !signal.aborted) {
      const claim = await claimCurateRun(nowIsoString().slice(0, 10));
      if (claim === null) {
        break;
      }

      try {
        const claimIndex = kb.readIndexOrEmpty();
        const rawAssignments = await runClassificationBatches(claim, claimIndex, signal);
        const validatedAssignments = validateAssignments(rawAssignments, claimIndex, claim.entries);
        const metadataTargets = buildMetadataTargets(validatedAssignments, claimIndex, claim.entries);
        await commitMetadataTargets(metadataTargets);
        gitAutoCommit(`curate: classify ${claim.entries.length} entries (tags + principles)`);

        allCohortSlugs.push(...claim.entries.filter(isNoteClaimedEntry).map((entry) => entry.slug));
        await clearCurateRetryState();
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
        clearCurateRetryStateLocked(state);
      });
      return null;
    }

    // Discovery runs once after all classification claims, seeing the full corpus.
    const postClassifyState = readCurateState(kb);
    const processedThrough = postClassifyState.processedThrough;
    const postClassifyIndex = kb.readIndexOrEmpty();

    if (!stopped && !signal.aborted && processedThrough !== null) {
      try {
        await runPrincipleDiscovery(processedThrough, signal);
        gitAutoCommit('curate: discover principles');
      } catch (error: unknown) {
        throw new CurateRunError(lastCompletedThrough, error);
      }
    }

    // Tag cleanup runs once over all classified notes.
    if (!stopped && !signal.aborted) {
      const cleanupResult = cleanupTags(postClassifyIndex, allCohortSlugs);
      const cleanupTargets = buildCleanupTargets(postClassifyIndex, allCohortSlugs, cleanupResult);
      if (cleanupTargets.length > 0) {
        try {
          await commitMetadataTargets(cleanupTargets);
          gitAutoCommit(`curate: cleanup tags for ${cleanupTargets.length} notes`);
        } catch (error: unknown) {
          throw new CurateRunError(lastCompletedThrough, error);
        }
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
      } catch (error: unknown) {
        if (stopped && runController.signal.aborted) {
          try {
            await clearCurateRetryState();
          } catch (stateError: unknown) {
            backendLog.error('kb_curate: failed to clear stop state', stateError);
          }
          return;
        }
        const runError = error instanceof CurateRunError ? error : new CurateRunError(null, error);
        backendLog.error('kb_curate: run failed', runError.cause);
        try {
          await recordCurateFailure(runError.through, runError.cause);
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
      setTimeout(() => {
        launchQueuedRun();
      }, 0);
    } else {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        launchQueuedRun();
      }, scheduleDebounceMs);
    }
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
      claimCurateRun,
      runClassificationBatches,
      commitMetadataTargets,
      runPrincipleDiscovery,
      recordCurateFailure,
      clearCurateRetryState,
      recordDiscoveryAttempt,
      addPendingDiscovery,
      removePendingDiscovery,
      async migrateCurateStateIfNeeded() {
        await migrateCurateStateIfNeeded(kb);
      },
    },
  };
}
