import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../../shared/utils.js';
import { replaceFrontmatter, replaceSourceFrontmatter } from '../frontmatter.js';
import { sortedMarkdownEntries } from '../markdown-entries.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex, writeFileAtomic } from '../mutation-helpers.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import type { KbRuntime } from '../contracts.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../entry-types.js';
import { parseNonNegativeInteger, parsePositiveInteger } from '../validation.js';
import { backendLog } from '../../shared/backend-log.js';

export const CURATE_STATE_FILE = 'curate-state.json';
export const CURATE_STATE_MIGRATION_VERSION = 4;
const CLAIM_STALE_MS = 15 * 60 * 1000;
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;
const LENIENT_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)(?:\r?\n---(?:\r?\n|$)|$)/;
const LENIENT_ENTRY_SEQ_PATTERN = /(?:^|\r?\n)\s*entrySeq:\s*(?:['"])?(\d+)(?:['"])?\s*(?:#.*)?(?=\r?\n|$)/;

type CurateStateTarget = Pick<KbRuntime, 'curateStatePath'> | string;
type CurateStateRuntime = Pick<
  KbRuntime,
  | 'curateStatePath'
  | 'notesDir'
  | 'notePath'
  | 'sourcesDir'
  | 'sourcePath'
  | 'withMutationLock'
  | 'readIndex'
  | 'writeIndex'
  | 'readIndexState'
  | 'writeIndexState'
>;

export type CurateCursor = {
  entrySeq: number;
  entryId: KbEntryId;
};

export type PendingRepair = {
  entrySeq: number | null;
  entryId: KbEntryId;
  detectedAt: string;
};

export type CurateState = {
  processedThrough: CurateCursor | null;
  discoveryHighSeq: number;
  discoveryOffset: number;
  lastRunDay: string | null;
  lastAttemptedThrough: CurateCursor | null;
  retryNotBefore: string | null;
  activeClaim: {
    through: CurateCursor;
    startedAt: string;
  } | null;
  pendingDiscoveries: Array<{
    principle: string;
    statement: string;
    notes: string[];
    createdAt: string;
  }>;
  pendingRepair: PendingRepair[] | null;
  communityTopologyHash?: string;
  communitySummaryTopologyHash?: string;
  communitySummaryInputFingerprints?: Record<string, string>;
  consecutiveFailures: number;
  initialized: boolean;
  migrationVersion: number;
};

export type PendingDiscovery = CurateState['pendingDiscoveries'][number];
export type CurateRepairFrontier =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | {
      kind: 'known';
      cursor: CurateCursor;
    };

const kbEntryIdSchema = z.string().transform((value, ctx): KbEntryId => {
  const entryId = parseKbEntryId(value);
  if (entryId !== null) {
    return entryId;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'must be a KB entry ID',
  });
  return z.NEVER;
});

const pendingRepairEntrySchema = z.object({
  entrySeq: z.number().int().positive().nullable(),
  entryId: kbEntryIdSchema,
  detectedAt: z.string().datetime({ offset: true }),
});

const pendingRepairSchema = z.array(pendingRepairEntrySchema).nullable();

type ScannedNote = {
  note: string;
  path: string;
  content: string;
  title: string;
  frontmatter: KbNoteFrontmatter;
};

type ScannedSource = {
  slug: string;
  path: string;
  content: string;
  frontmatter: KbSourceFrontmatter;
};

function defaultCurateState(): CurateState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    pendingRepair: null,
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    communitySummaryInputFingerprints: undefined,
    consecutiveFailures: 0,
    initialized: false,
    migrationVersion: 0,
  };
}

function retryBaseCooldownMs(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes('Failed to spawn claude:') && (message.includes('ENOENT') || message.includes('not found'))) {
    return CURATE_MISSING_CLI_RETRY_MS;
  }

  return CURATE_TRANSIENT_RETRY_MS;
}

function calculateRetryCooldownMs(baseCooldownMs: number, consecutiveFailures: number): number {
  return Math.min(baseCooldownMs * 2 ** consecutiveFailures, CURATE_MAX_RETRY_MS);
}

function samePendingDiscovery(left: PendingDiscovery, right: PendingDiscovery): boolean {
  return left.principle === right.principle && left.statement === right.statement;
}

function parseOptionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string or null`);
  }
  return value;
}

function parseOptionalDefinedString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseOptionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  const entries: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string' || entryValue.trim() === '') {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
    entries[key] = entryValue.trim();
  }

  return entries;
}

function parseEntryId(value: unknown, label: string): KbEntryId {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  const entryId = parseKbEntryId(value);
  if (entryId === null) {
    throw new Error(`${label} must be a KB entry ID`);
  }

  return entryId;
}

function parseCursor(value: unknown, label: string): CurateCursor | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object or null`);
  }

  return {
    entryId: parseEntryId(value.entryId, `${label}.entryId`),
    entrySeq: parsePositiveInteger(value.entrySeq, `${label}.entrySeq`),
  };
}

function parsePendingDiscoveries(value: unknown): CurateState['pendingDiscoveries'] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('pendingDiscoveries must be an array');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`pendingDiscoveries[${index}] must be an object`);
    }
    if (typeof entry.principle !== 'string') {
      throw new Error(`pendingDiscoveries[${index}].principle must be a string`);
    }
    if (typeof entry.statement !== 'string') {
      throw new Error(`pendingDiscoveries[${index}].statement must be a string`);
    }
    if (!isStringArray(entry.notes)) {
      throw new Error(`pendingDiscoveries[${index}].notes must be a string array`);
    }
    if (typeof entry.createdAt !== 'string') {
      throw new Error(`pendingDiscoveries[${index}].createdAt must be a string`);
    }
    return {
      principle: entry.principle,
      statement: entry.statement,
      notes: [...entry.notes],
      createdAt: entry.createdAt,
    };
  });
}

function parsePendingRepair(value: unknown): CurateState['pendingRepair'] {
  if (value === undefined) {
    return null;
  }

  return pendingRepairSchema.parse(value);
}

function parseActiveClaim(value: unknown): CurateState['activeClaim'] {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('activeClaim must be an object or null');
  }

  const through = parseCursor(value.through, 'activeClaim.through');
  if (through === null) {
    throw new Error('activeClaim.through must be present');
  }
  if (typeof value.startedAt !== 'string') {
    throw new Error('activeClaim.startedAt must be a string');
  }

  return {
    through,
    startedAt: value.startedAt,
  };
}

function parseCurateState(value: unknown): CurateState {
  if (!isRecord(value)) {
    throw new Error('Invalid curate state');
  }

  return normalizeCurateStateRepairFrontier({
    processedThrough: parseCursor(value.processedThrough, 'processedThrough'),
    discoveryHighSeq: parseNonNegativeInteger(value.discoveryHighSeq ?? 0, 'discoveryHighSeq'),
    discoveryOffset: parseNonNegativeInteger(value.discoveryOffset ?? 0, 'discoveryOffset'),
    lastRunDay: parseOptionalString(value.lastRunDay, 'lastRunDay'),
    lastAttemptedThrough: parseCursor(value.lastAttemptedThrough, 'lastAttemptedThrough'),
    retryNotBefore: parseOptionalString(value.retryNotBefore, 'retryNotBefore'),
    activeClaim: parseActiveClaim(value.activeClaim),
    pendingDiscoveries: parsePendingDiscoveries(value.pendingDiscoveries),
    pendingRepair: parsePendingRepair(value.pendingRepair),
    communityTopologyHash: parseOptionalDefinedString(
      value.communityTopologyHash ?? value.communityGraphHash,
      'communityTopologyHash',
    ),
    communitySummaryTopologyHash: parseOptionalDefinedString(
      value.communitySummaryTopologyHash ?? value.communityGraphHash,
      'communitySummaryTopologyHash',
    ),
    communitySummaryInputFingerprints: parseOptionalStringRecord(
      value.communitySummaryInputFingerprints ?? value.communityMembershipFingerprints,
      'communitySummaryInputFingerprints',
    ),
    consecutiveFailures: parseNonNegativeInteger(value.consecutiveFailures ?? 0, 'consecutiveFailures'),
    initialized: value.initialized === true,
    migrationVersion: parseNonNegativeInteger(value.migrationVersion ?? 0, 'migrationVersion'),
  });
}

function recoverCursor(value: unknown): CurateCursor | null {
  try {
    return parseCursor(value, 'cursor');
  } catch {
    /* fall through */
  }

  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.note !== 'string') {
    return null;
  }

  try {
    const entryId = parseKbEntryId(noteEntryId(value.note));
    if (entryId === null) {
      return null;
    }
    return {
      entryId,
      entrySeq: parsePositiveInteger(value.mutationSeqAtPromote, 'cursor.mutationSeqAtPromote'),
    };
  } catch {
    return null;
  }
}

function recoverPendingDiscoveries(value: unknown): CurateState['pendingDiscoveries'] {
  try {
    return parsePendingDiscoveries(value);
  } catch {
    return [];
  }
}

function recoverPendingRepair(value: unknown): CurateState['pendingRepair'] {
  try {
    return parsePendingRepair(value);
  } catch {
    return null;
  }
}

function recoverOptionalString(value: unknown): string | null {
  try {
    return parseOptionalString(value, 'value');
  } catch {
    return null;
  }
}

function recoverOptionalDefinedString(value: unknown): string | undefined {
  try {
    return parseOptionalDefinedString(value, 'value');
  } catch {
    return undefined;
  }
}

function recoverOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  try {
    return parseOptionalStringRecord(value, 'value');
  } catch {
    return undefined;
  }
}

function recoverCurateState(value: unknown): CurateState {
  const defaults = defaultCurateState();
  if (!isRecord(value)) {
    return defaults;
  }

  const discoveryHighSeq = (() => {
    try {
      return parseNonNegativeInteger(value.discoveryHighSeq ?? 0, 'discoveryHighSeq');
    } catch {
      return recoverCursor(value.discoveredThrough)?.entrySeq ?? 0;
    }
  })();

  const discoveryOffset = (() => {
    try {
      return parseNonNegativeInteger(value.discoveryOffset ?? 0, 'discoveryOffset');
    } catch {
      return 0;
    }
  })();

  const consecutiveFailures = (() => {
    try {
      return parseNonNegativeInteger(value.consecutiveFailures ?? 0, 'consecutiveFailures');
    } catch {
      return 0;
    }
  })();

  const migrationVersion = (() => {
    try {
      return parseNonNegativeInteger(value.migrationVersion ?? 0, 'migrationVersion');
    } catch {
      return 0;
    }
  })();

  let activeClaim: CurateState['activeClaim'] = null;
  if (isRecord(value.activeClaim)) {
    const through = recoverCursor(value.activeClaim.through);
    if (through !== null && typeof value.activeClaim.startedAt === 'string') {
      activeClaim = {
        through,
        startedAt: value.activeClaim.startedAt,
      };
    }
  }

  return normalizeCurateStateRepairFrontier({
    processedThrough: recoverCursor(value.processedThrough),
    discoveryHighSeq,
    discoveryOffset,
    lastRunDay: recoverOptionalString(value.lastRunDay),
    lastAttemptedThrough: recoverCursor(value.lastAttemptedThrough),
    retryNotBefore: recoverOptionalString(value.retryNotBefore),
    activeClaim,
    pendingDiscoveries: recoverPendingDiscoveries(value.pendingDiscoveries),
    pendingRepair: recoverPendingRepair(value.pendingRepair),
    communityTopologyHash: recoverOptionalDefinedString(value.communityTopologyHash ?? value.communityGraphHash),
    communitySummaryTopologyHash: recoverOptionalDefinedString(
      value.communitySummaryTopologyHash ?? value.communityGraphHash,
    ),
    communitySummaryInputFingerprints: recoverOptionalStringRecord(
      value.communitySummaryInputFingerprints ?? value.communityMembershipFingerprints,
    ),
    consecutiveFailures,
    initialized: value.initialized === true,
    migrationVersion,
  });
}

function readRawCurateState(target: CurateStateTarget): unknown | undefined {
  try {
    return JSON.parse(readFileSync(curateStatePath(target), 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export function curateStatePath(target: CurateStateTarget): string {
  return typeof target === 'string' ? join(target, CURATE_STATE_FILE) : target.curateStatePath();
}

function sortedNoteNames(kb: Pick<KbRuntime, 'notesDir'>): string[] {
  return sortedMarkdownEntries(kb.notesDir()).map((entry) => stripMdExt(entry));
}

function sortedSourceNames(kb: Pick<KbRuntime, 'sourcesDir'>): string[] {
  return sortedMarkdownEntries(kb.sourcesDir()).map((entry) => stripMdExt(entry));
}

function syncIndexNote(
  note: string,
  title: string,
  frontmatter: KbNoteFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildNoteIndexEntry({
    slug: note,
    title,
    ...frontmatter,
  });
  const existingEntry = nextIndex.entries[noteEntryId(note)];
  const existing = existingEntry !== undefined && isNoteEntry(existingEntry) ? existingEntry : undefined;
  if (
    existing !== undefined &&
    existing.title === nextEntry.title &&
    existing.entrySeq === nextEntry.entrySeq &&
    sameStringList(existing.tags, nextEntry.tags) &&
    sameStringList(existing.principles, nextEntry.principles) &&
    sameStringList(existing.source, nextEntry.source) &&
    sameStringList(existing.related ?? [], nextEntry.related ?? []) &&
    existing.createdAt === nextEntry.createdAt &&
    existing.updatedAt === nextEntry.updatedAt
  ) {
    return false;
  }

  nextIndex.entries[noteEntryId(note)] = nextEntry;
  return true;
}

function syncIndexSource(
  slug: string,
  frontmatter: KbSourceFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildSourceIndexEntry({
    slug,
    ...frontmatter,
  });
  const existingEntry = nextIndex.entries[sourceEntryId(slug)];
  const existing = existingEntry !== undefined && isSourceEntry(existingEntry) ? existingEntry : undefined;
  if (
    existing !== undefined &&
    existing.title === nextEntry.title &&
    existing.type === nextEntry.type &&
    existing.url === nextEntry.url &&
    existing.importedAt === nextEntry.importedAt &&
    existing.entrySeq === nextEntry.entrySeq &&
    sameStringList(existing.tags, nextEntry.tags) &&
    sameStringList(existing.related ?? [], nextEntry.related ?? [])
  ) {
    return false;
  }

  nextIndex.entries[sourceEntryId(slug)] = nextEntry;
  return true;
}

function scanNote(kb: Pick<KbRuntime, 'notePath'>, note: string): ScannedNote {
  const path = kb.notePath(note);
  const loaded = loadKbNote(path);
  return {
    note,
    path,
    content: loaded.raw,
    title: loaded.title,
    frontmatter: loaded.frontmatter,
  };
}

function scanSource(kb: Pick<KbRuntime, 'sourcePath'>, slug: string): ScannedSource {
  const path = kb.sourcePath(slug);
  const loaded = loadKbSource(path);
  return {
    slug,
    path,
    content: loaded.raw,
    frontmatter: loaded.frontmatter,
  };
}

function hasCuratedNoteMetadata(frontmatter: KbNoteFrontmatter): boolean {
  return frontmatter.tags.length > 0 || frontmatter.principles.length > 0 || (frontmatter.related ?? []).length > 0;
}

function hasCuratedSourceMetadata(frontmatter: KbSourceFrontmatter): boolean {
  return frontmatter.tags.length > 0 || (frontmatter.related ?? []).length > 0;
}

function inferProcessedThrough(
  state: CurateState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
): CurateCursor | null {
  if (state.processedThrough !== null) {
    return state.processedThrough;
  }

  let highestCuratedCursor: CurateCursor | null = null;
  for (const scannedNote of scannedNotes) {
    const entrySeq = scannedNote.frontmatter.entrySeq;
    if (entrySeq === undefined || !hasCuratedNoteMetadata(scannedNote.frontmatter)) {
      continue;
    }

    const cursor: CurateCursor = {
      entryId: noteEntryId(scannedNote.note),
      entrySeq,
    };
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  for (const scannedSource of scannedSources) {
    const entrySeq = scannedSource.frontmatter.entrySeq;
    if (entrySeq === undefined || !hasCuratedSourceMetadata(scannedSource.frontmatter)) {
      continue;
    }

    const cursor: CurateCursor = {
      entryId: sourceEntryId(scannedSource.slug),
      entrySeq,
    };
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  return highestCuratedCursor;
}

export function readCurateState(target: CurateStateTarget): CurateState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(curateStatePath(target), 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return defaultCurateState();
    }
    throw error;
  }

  try {
    return parseCurateState(raw);
  } catch {
    // Pre-migration or corrupt state — recover gracefully instead of crashing.
    // migrateCurateStateIfNeeded will run later and write the canonical format.
    return recoverCurateState(raw);
  }
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  writeFileAtomic(curateStatePath(target), `${JSON.stringify(normalizeCurateStateRepairFrontier(state), null, 2)}\n`);
}

/**
 * Reset the curate cursor so the next scheduler claim reprocesses the corpus with the current prompt
 * and consolidation path. AC8 topology and summary fingerprint state is preserved and continues to be
 * normalized by writeCurateState/parseCurateState.
 */
export function resetCurateStateForBackfill(state: CurateState): CurateState {
  return normalizeCurateStateRepairFrontier({
    ...state,
    processedThrough: null,
    activeClaim: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    lastRunDay: null,
    consecutiveFailures: 0,
  });
}

export function compareCursor(left: CurateCursor, right: CurateCursor): number {
  if (left.entrySeq !== right.entrySeq) {
    return left.entrySeq - right.entrySeq;
  }
  return left.entryId.localeCompare(right.entryId);
}

export function noteCursor(note: string, entrySeq: number): CurateCursor {
  return {
    entryId: noteEntryId(note),
    entrySeq,
  };
}

export function compareOptionalCursor(left: CurateCursor | null, right: CurateCursor): number {
  if (left === null) {
    return -1;
  }

  return compareCursor(left, right);
}

export function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function comparePendingRepair(left: PendingRepair, right: PendingRepair): number {
  if (left.entrySeq === null || right.entrySeq === null) {
    if (left.entrySeq === null && right.entrySeq === null) {
      return left.entryId.localeCompare(right.entryId);
    }

    return left.entrySeq === null ? -1 : 1;
  }

  return compareCursor(
    {
      entryId: left.entryId,
      entrySeq: left.entrySeq,
    },
    {
      entryId: right.entryId,
      entrySeq: right.entrySeq,
    },
  );
}

function effectivePendingRepair(pendingRepair: CurateState['pendingRepair']): PendingRepair[] | null {
  if (pendingRepair === null || pendingRepair.length === 0) {
    return null;
  }

  return [...pendingRepair].sort(comparePendingRepair);
}

export function getCurateRepairFrontier(pendingRepair: CurateState['pendingRepair']): CurateRepairFrontier {
  const normalizedPendingRepair = effectivePendingRepair(pendingRepair);
  if (normalizedPendingRepair === null) {
    return { kind: 'none' };
  }

  if (normalizedPendingRepair.some((entry) => entry.entrySeq === null)) {
    return { kind: 'unknown' };
  }

  const first = normalizedPendingRepair[0];
  if (first === undefined || first.entrySeq === null) {
    return { kind: 'none' };
  }

  return {
    kind: 'known',
    cursor: {
      entryId: first.entryId,
      entrySeq: first.entrySeq,
    },
  };
}

function clampCursorToRepairFrontier(cursor: CurateCursor | null, frontier: CurateRepairFrontier): CurateCursor | null {
  if (cursor === null || frontier.kind === 'none') {
    return cursor;
  }
  if (frontier.kind === 'unknown') {
    return null;
  }

  return compareCursor(cursor, frontier.cursor) >= 0 ? null : cursor;
}

export function normalizeCurateStateRepairFrontier(state: CurateState): CurateState {
  const pendingRepair = effectivePendingRepair(state.pendingRepair);
  const frontier = getCurateRepairFrontier(pendingRepair);

  if (frontier.kind === 'unknown') {
    return {
      ...state,
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      pendingRepair,
    };
  }

  if (frontier.kind === 'known' && state.discoveryHighSeq >= frontier.cursor.entrySeq) {
    return {
      ...state,
      processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
      lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
      discoveryHighSeq: Math.max(frontier.cursor.entrySeq - 1, 0),
      discoveryOffset: 0,
      pendingRepair,
    };
  }

  return {
    ...state,
    processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
    lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
    pendingRepair,
  };
}

type MalformedEntryKind = 'note' | 'source';

function extractLenientFrontmatterRegion(content: string): string {
  const match = content.match(LENIENT_FRONTMATTER_PATTERN);
  if (match !== null) {
    return match[1];
  }

  if (!content.startsWith('---')) {
    return content.slice(0, 2048);
  }

  return content.slice(4, 2048);
}

function extractLenientEntrySeq(content: string): number | null {
  const match = extractLenientFrontmatterRegion(content).match(LENIENT_ENTRY_SEQ_PATTERN);
  if (match === null) {
    return null;
  }

  const entrySeq = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(entrySeq) || entrySeq < 1) {
    return null;
  }

  return entrySeq;
}

function parseMalformedEntryId(kind: MalformedEntryKind, slug: string): KbEntryId | null {
  return parseKbEntryId(kind === 'note' ? noteEntryId(slug) : sourceEntryId(slug));
}

export function extractMalformedEntryRepair(
  kind: MalformedEntryKind,
  slug: string,
  raw: string,
  detectedAt: string,
): PendingRepair | null {
  const entryId = parseMalformedEntryId(kind, slug);
  if (entryId === null) {
    return null;
  }

  return {
    entryId,
    entrySeq: extractLenientEntrySeq(raw),
    detectedAt,
  };
}

function readMalformedEntryRepair(
  path: string,
  kind: MalformedEntryKind,
  slug: string,
  detectedAt: string,
): PendingRepair | null {
  try {
    return extractMalformedEntryRepair(kind, slug, readFileSync(path, 'utf-8'), detectedAt);
  } catch {
    return null;
  }
}

export function applyRecordCurateFailure(
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
): CurateState | null {
  const attemptedThrough = through ?? state.lastAttemptedThrough;
  if (attemptedThrough === null) {
    if (state.activeClaim === null) {
      return null;
    }

    return {
      ...state,
      activeClaim: null,
    };
  }

  const sameAttempt =
    state.lastAttemptedThrough !== null && compareCursor(state.lastAttemptedThrough, attemptedThrough) === 0;
  const priorFailures = sameAttempt ? state.consecutiveFailures : 0;

  return {
    ...state,
    lastAttemptedThrough: attemptedThrough,
    retryNotBefore: new Date(
      Date.now() + calculateRetryCooldownMs(retryBaseCooldownMs(error), priorFailures),
    ).toISOString(),
    activeClaim: null,
    consecutiveFailures: priorFailures + 1,
  };
}

export function applyClearCurateRetryState(state: CurateState): CurateState | null {
  if (state.activeClaim === null && state.retryNotBefore === null && state.consecutiveFailures === 0) {
    return null;
  }

  return {
    ...state,
    retryNotBefore: null,
    activeClaim: null,
    consecutiveFailures: 0,
  };
}

export function applyRecordDiscoveryAttempt(state: CurateState, highSeq: number, nextOffset: number): CurateState {
  return {
    ...state,
    discoveryHighSeq: Math.max(state.discoveryHighSeq, highSeq),
    discoveryOffset: nextOffset,
  };
}

export function applyAddPendingDiscovery(state: CurateState, entry: PendingDiscovery): CurateState | null {
  const alreadyPending = state.pendingDiscoveries.some(
    (pending) => pending.principle === entry.principle && pending.statement === entry.statement,
  );
  if (alreadyPending) {
    return null;
  }

  return {
    ...state,
    pendingDiscoveries: [...state.pendingDiscoveries, entry],
  };
}

export function applyRemovePendingDiscovery(state: CurateState, entry: PendingDiscovery): CurateState | null {
  const nextPendingDiscoveries = state.pendingDiscoveries.filter((pending) => !samePendingDiscovery(pending, entry));
  if (nextPendingDiscoveries.length === state.pendingDiscoveries.length) {
    return null;
  }

  return {
    ...state,
    pendingDiscoveries: nextPendingDiscoveries,
  };
}

export function isClaimStale(state: CurateState, now: string): boolean {
  if (state.activeClaim === null) {
    return false;
  }

  const startedAt = Date.parse(state.activeClaim.startedAt);
  if (Number.isNaN(startedAt)) {
    return true;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return false;
  }

  return nowMs - startedAt >= CLAIM_STALE_MS;
}

export async function migrateCurateStateIfNeeded(kb: CurateStateRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const rawState = readRawCurateState(kb);
    const strictState =
      rawState === undefined
        ? defaultCurateState()
        : (() => {
            try {
              return parseCurateState(rawState);
            } catch {
              return null;
            }
          })();

    if (strictState !== null && strictState.migrationVersion >= CURATE_STATE_MIGRATION_VERSION) {
      return;
    }

    const recoveredState = strictState ?? recoverCurateState(rawState);
    const nextIndex = cloneKbIndex(kb.readIndex());
    const indexState = kb.readIndexState();
    const scannedNotes: ScannedNote[] = [];
    const scannedSources: ScannedSource[] = [];
    const pendingRepair: PendingRepair[] = [];
    const detectedAt = new Date().toISOString();

    for (const note of sortedNoteNames(kb)) {
      try {
        scannedNotes.push(scanNote(kb, note));
      } catch (error: unknown) {
        const repair = readMalformedEntryRepair(kb.notePath(note), 'note', note, detectedAt);
        if (repair !== null) {
          pendingRepair.push(repair);
        }
        backendLog.warn(`Skipping malformed KB note ${note} during migration: ${errorMessage(error)}`);
      }
    }

    for (const slug of sortedSourceNames(kb)) {
      try {
        scannedSources.push(scanSource(kb, slug));
      } catch (error: unknown) {
        const repair = readMalformedEntryRepair(kb.sourcePath(slug), 'source', slug, detectedAt);
        if (repair !== null) {
          pendingRepair.push(repair);
        }
        backendLog.warn(`Skipping malformed KB source ${slug} during migration: ${errorMessage(error)}`);
      }
    }

    let highestExistingEntrySeq = indexState.mutationSeq;
    for (const scannedNote of scannedNotes) {
      if (scannedNote.frontmatter.entrySeq !== undefined) {
        highestExistingEntrySeq = Math.max(highestExistingEntrySeq, scannedNote.frontmatter.entrySeq);
      }
    }
    for (const scannedSource of scannedSources) {
      if (scannedSource.frontmatter.entrySeq !== undefined) {
        highestExistingEntrySeq = Math.max(highestExistingEntrySeq, scannedSource.frontmatter.entrySeq);
      }
    }
    for (const repair of pendingRepair) {
      if (repair.entrySeq !== null) {
        highestExistingEntrySeq = Math.max(highestExistingEntrySeq, repair.entrySeq);
      }
    }

    let nextEntrySeq = highestExistingEntrySeq + 1;
    let highestAssignedEntrySeq = highestExistingEntrySeq;
    let indexChanged = false;

    for (const scannedNote of scannedNotes) {
      if (scannedNote.frontmatter.entrySeq === undefined) {
        scannedNote.frontmatter = {
          ...scannedNote.frontmatter,
          entrySeq: nextEntrySeq,
        };
        nextEntrySeq += 1;
        writeFileAtomic(scannedNote.path, replaceFrontmatter(scannedNote.content, scannedNote.frontmatter));
      }

      highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedNote.frontmatter.entrySeq ?? 0);
      indexChanged =
        syncIndexNote(scannedNote.note, scannedNote.title, scannedNote.frontmatter, nextIndex) || indexChanged;
    }

    for (const scannedSource of scannedSources) {
      if (scannedSource.frontmatter.entrySeq === undefined) {
        scannedSource.frontmatter = {
          ...scannedSource.frontmatter,
          entrySeq: nextEntrySeq,
        };
        nextEntrySeq += 1;
        writeFileAtomic(scannedSource.path, replaceSourceFrontmatter(scannedSource.content, scannedSource.frontmatter));
      }

      highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedSource.frontmatter.entrySeq ?? 0);
      indexChanged = syncIndexSource(scannedSource.slug, scannedSource.frontmatter, nextIndex) || indexChanged;
    }

    if (indexChanged) {
      kb.writeIndex(nextIndex);
    }

    if (highestAssignedEntrySeq > indexState.mutationSeq) {
      const nextIndexState = {
        ...indexState,
        contentSeq: highestAssignedEntrySeq,
        metadataSeq: highestAssignedEntrySeq,
        mutationSeq: highestAssignedEntrySeq,
        textIndexedSeq: highestAssignedEntrySeq,
      };
      kb.writeIndexState(nextIndexState);
    }

    writeCurateState(kb, {
      ...recoveredState,
      processedThrough: inferProcessedThrough(recoveredState, scannedNotes, scannedSources),
      pendingRepair: pendingRepair.length === 0 ? null : pendingRepair,
      initialized: true,
      migrationVersion: CURATE_STATE_MIGRATION_VERSION,
    });
  });
}
