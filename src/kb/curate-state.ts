import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { replaceFrontmatter, replaceSourceFrontmatter } from './frontmatter.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex, writeFileAtomic } from './mutation-helpers.js';
import { loadKbNote, loadKbSource } from './read.js';
import type { KbRuntime } from './runtime.js';
import { sortedMarkdownEntries } from './text-artifacts.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from './types.js';
import { backendLog } from '../shared/backend-log.js';

export const CURATE_STATE_FILE = 'curate-state.json';
export const CURATE_STATE_MIGRATION_VERSION = 2;
const CLAIM_STALE_MS = 15 * 60 * 1000;
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;

type CurateStateTarget = Pick<KbRuntime, 'curateStatePath'> | string;
type CurateStateRuntime = Pick<
  KbRuntime,
  | 'markdownRoot'
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
  consecutiveFailures: number;
  initialized: boolean;
  migrationVersion: number;
};

type PendingDiscovery = CurateState['pendingDiscoveries'][number];

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

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
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

  return {
    processedThrough: parseCursor(value.processedThrough, 'processedThrough'),
    discoveryHighSeq: parseNonNegativeInteger(value.discoveryHighSeq ?? 0, 'discoveryHighSeq'),
    discoveryOffset: parseNonNegativeInteger(value.discoveryOffset ?? 0, 'discoveryOffset'),
    lastRunDay: parseOptionalString(value.lastRunDay, 'lastRunDay'),
    lastAttemptedThrough: parseCursor(value.lastAttemptedThrough, 'lastAttemptedThrough'),
    retryNotBefore: parseOptionalString(value.retryNotBefore, 'retryNotBefore'),
    activeClaim: parseActiveClaim(value.activeClaim),
    pendingDiscoveries: parsePendingDiscoveries(value.pendingDiscoveries),
    consecutiveFailures: parseNonNegativeInteger(value.consecutiveFailures ?? 0, 'consecutiveFailures'),
    initialized: value.initialized === true,
    migrationVersion: parseNonNegativeInteger(value.migrationVersion ?? 0, 'migrationVersion'),
  };
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

function recoverOptionalString(value: unknown): string | null {
  try {
    return parseOptionalString(value, 'value');
  } catch {
    return null;
  }
}

function recoverCurateState(value: unknown): CurateState {
  const defaults = defaultCurateState();
  if (!isRecord(value)) {
    return defaults;
  }

  let discoveryHighSeq = 0;
  try {
    discoveryHighSeq = parseNonNegativeInteger(value.discoveryHighSeq ?? 0, 'discoveryHighSeq');
  } catch {
    discoveryHighSeq = recoverCursor(value.discoveredThrough)?.entrySeq ?? 0;
  }

  let discoveryOffset = 0;
  try {
    discoveryOffset = parseNonNegativeInteger(value.discoveryOffset ?? 0, 'discoveryOffset');
  } catch {
    discoveryOffset = 0;
  }

  let consecutiveFailures = 0;
  try {
    consecutiveFailures = parseNonNegativeInteger(value.consecutiveFailures ?? 0, 'consecutiveFailures');
  } catch {
    consecutiveFailures = 0;
  }

  let migrationVersion = 0;
  try {
    migrationVersion = parseNonNegativeInteger(value.migrationVersion ?? 0, 'migrationVersion');
  } catch {
    migrationVersion = 0;
  }

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

  return {
    processedThrough: recoverCursor(value.processedThrough),
    discoveryHighSeq,
    discoveryOffset,
    lastRunDay: recoverOptionalString(value.lastRunDay),
    lastAttemptedThrough: recoverCursor(value.lastAttemptedThrough),
    retryNotBefore: recoverOptionalString(value.retryNotBefore),
    activeClaim,
    pendingDiscoveries: recoverPendingDiscoveries(value.pendingDiscoveries),
    consecutiveFailures,
    initialized: value.initialized === true,
    migrationVersion,
  };
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
  return sortedMarkdownEntries(kb.notesDir()).map((entry) => entry.slice(0, -3));
}

function sortedSourceNames(kb: Pick<KbRuntime, 'sourcesDir'>): string[] {
  return sortedMarkdownEntries(kb.sourcesDir()).map((entry) => entry.slice(0, -3));
}

function syncIndexNote(note: string, title: string, frontmatter: KbNoteFrontmatter, nextIndex: ReturnType<typeof cloneKbIndex>): boolean {
  const nextEntry = buildNoteIndexEntry({
    slug: note,
    title,
    tags: frontmatter.tags,
    principles: frontmatter.principles,
    source: frontmatter.source,
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
    related: frontmatter.related ?? [],
    ...(frontmatter.entrySeq === undefined ? {} : { entrySeq: frontmatter.entrySeq }),
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
    title: frontmatter.title,
    type: frontmatter.type,
    tags: frontmatter.tags,
    ...(frontmatter.url === undefined ? {} : { url: frontmatter.url }),
    importedAt: frontmatter.importedAt,
    related: frontmatter.related ?? [],
    ...(frontmatter.entrySeq === undefined ? {} : { entrySeq: frontmatter.entrySeq }),
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

function inferProcessedThrough(state: CurateState, scannedNotes: ScannedNote[]): CurateCursor | null {
  if (state.processedThrough !== null) {
    return state.processedThrough;
  }

  let highestCuratedCursor: CurateCursor | null = null;
  for (const scannedNote of scannedNotes) {
    const entrySeq = scannedNote.frontmatter.entrySeq;
    if (entrySeq === undefined) {
      continue;
    }
    if (
      scannedNote.frontmatter.tags.length <= 1 &&
      scannedNote.frontmatter.principles.length === 0 &&
      (scannedNote.frontmatter.related ?? []).length === 0
    ) {
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

  return highestCuratedCursor;
}

export function readCurateState(target: CurateStateTarget): CurateState {
  try {
    return parseCurateState(JSON.parse(readFileSync(curateStatePath(target), 'utf-8')) as unknown);
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return defaultCurateState();
    }
    throw error;
  }
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  writeFileAtomic(curateStatePath(target), `${JSON.stringify(state, null, 2)}\n`);
}

export function compareCursor(left: CurateCursor, right: CurateCursor): number {
  if (left.entrySeq !== right.entrySeq) {
    return left.entrySeq - right.entrySeq;
  }
  return left.entryId.localeCompare(right.entryId);
}

export function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
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
    const legacyPath = join(kb.markdownRoot, CURATE_STATE_FILE);
    const currentPath = kb.curateStatePath();
    if (legacyPath !== currentPath && existsSync(legacyPath) && !existsSync(currentPath)) {
      try {
        renameSync(legacyPath, currentPath);
      } catch {
        /* best-effort */
      }
    }

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
      writeCurateState(kb, strictState);
      return;
    }

    const recoveredState = strictState ?? recoverCurateState(rawState);
    const nextIndex = cloneKbIndex(kb.readIndex());
    const indexState = kb.readIndexState();
    const scannedNotes: ScannedNote[] = [];
    const scannedSources: ScannedSource[] = [];

    for (const note of sortedNoteNames(kb)) {
      try {
        scannedNotes.push(scanNote(kb, note));
      } catch (error: unknown) {
        backendLog.warn(`Skipping malformed KB note ${note} during migration: ${errorMessage(error)}`);
      }
    }

    for (const slug of sortedSourceNames(kb)) {
      try {
        scannedSources.push(scanSource(kb, slug));
      } catch (error: unknown) {
        backendLog.warn(`Skipping malformed KB source ${slug} during migration: ${errorMessage(error)}`);
      }
    }

    if (scannedNotes.length === 0 && scannedSources.length === 0) {
      writeCurateState(kb, {
        ...recoveredState,
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
      });
      return;
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
      indexChanged = syncIndexNote(scannedNote.note, scannedNote.title, scannedNote.frontmatter, nextIndex) || indexChanged;
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
      kb.writeIndexState({
        ...indexState,
        mutationSeq: highestAssignedEntrySeq,
      });
    }

    writeCurateState(kb, {
      ...recoveredState,
      processedThrough: inferProcessedThrough(recoveredState, scannedNotes),
      initialized: true,
      migrationVersion: CURATE_STATE_MIGRATION_VERSION,
    });
  });
}
