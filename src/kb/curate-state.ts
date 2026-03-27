import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { replaceFrontmatter } from './frontmatter.js';
import { buildNoteIndexEntry, cloneKbIndex, writeFileAtomic } from './mutation-helpers.js';
import { loadKbNote } from './read.js';
import type { KbRuntime } from './runtime.js';
import { sortedMarkdownEntries } from './text-artifacts.js';
import type { KbNoteFrontmatter } from './types.js';

export const CURATE_STATE_FILE = 'curate-state.json';
const CLAIM_STALE_MS = 15 * 60 * 1000;
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;

type CurateStateTarget = Pick<KbRuntime, 'curateStatePath'> | string;
type CurateStateRuntime = Pick<
  KbRuntime,
  'markdownRoot' | 'curateStatePath' | 'notesDir' | 'notePath' | 'withMutationLock' | 'readIndex' | 'writeIndex' | 'readIndexState' | 'writeIndexState'
>;

export type CurateCursor = {
  mutationSeqAtPromote: number;
  note: string;
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
};

type PendingDiscovery = CurateState['pendingDiscoveries'][number];

type ScannedNote = {
  note: string;
  path: string;
  content: string;
  title: string;
  frontmatter: KbNoteFrontmatter;
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
  return Math.min(baseCooldownMs * (2 ** consecutiveFailures), CURATE_MAX_RETRY_MS);
}

function samePendingDiscovery(left: PendingDiscovery, right: PendingDiscovery): boolean {
  return left.principle === right.principle
    && left.statement === right.statement;
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

function parseCursor(value: unknown, label: string): CurateCursor | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object or null`);
  }
  if (typeof value.note !== 'string') {
    throw new Error(`${label}.note must be a string`);
  }
  return {
    note: value.note,
    mutationSeqAtPromote: parsePositiveInteger(value.mutationSeqAtPromote, `${label}.mutationSeqAtPromote`),
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
    discoveryHighSeq: value.discoveryHighSeq === undefined
      ? (parseCursor(value.discoveredThrough, 'discoveredThrough')?.mutationSeqAtPromote ?? 0)
      : parseNonNegativeInteger(value.discoveryHighSeq, 'discoveryHighSeq'),
    discoveryOffset: value.discoveryOffset === undefined
      ? 0
      : parseNonNegativeInteger(value.discoveryOffset, 'discoveryOffset'),
    lastRunDay: parseOptionalString(value.lastRunDay, 'lastRunDay'),
    lastAttemptedThrough: parseCursor(value.lastAttemptedThrough, 'lastAttemptedThrough'),
    retryNotBefore: parseOptionalString(value.retryNotBefore, 'retryNotBefore'),
    activeClaim: parseActiveClaim(value.activeClaim),
    pendingDiscoveries: parsePendingDiscoveries(value.pendingDiscoveries),
    consecutiveFailures: value.consecutiveFailures === undefined
      ? 0
      : parseNonNegativeInteger(value.consecutiveFailures, 'consecutiveFailures'),
    initialized: value.initialized === true || (typeof value.migrationVersion === 'number' && value.migrationVersion >= 1),
  };
}

export function curateStatePath(target: CurateStateTarget): string {
  return typeof target === 'string'
    ? join(target, CURATE_STATE_FILE)
    : target.curateStatePath();
}

function sortedNoteNames(kb: Pick<KbRuntime, 'notesDir'>): string[] {
  return sortedMarkdownEntries(kb.notesDir()).map((entry) => entry.slice(0, -3));
}

function syncIndexNote(
  note: string,
  title: string,
  frontmatter: KbNoteFrontmatter,
  mutationSeqAtPromote: number,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const existing = nextIndex.notes[note];
  if (existing === undefined) {
    nextIndex.notes[note] = buildNoteIndexEntry({ ...frontmatter, title, mutationSeqAtPromote });
    return true;
  }

  if (existing.mutationSeqAtPromote === mutationSeqAtPromote) {
    return false;
  }

  nextIndex.notes[note] = buildNoteIndexEntry({ ...existing, mutationSeqAtPromote });
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

export function readCurateState(target: CurateStateTarget): CurateState {
  try {
    return parseCurateState(JSON.parse(readFileSync(curateStatePath(target), 'utf-8')) as unknown);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return defaultCurateState();
    }
    throw error;
  }
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  writeFileAtomic(curateStatePath(target), `${JSON.stringify(state, null, 2)}\n`);
}

export function compareCursor(left: CurateCursor, right: CurateCursor): number {
  if (left.mutationSeqAtPromote !== right.mutationSeqAtPromote) {
    return left.mutationSeqAtPromote - right.mutationSeqAtPromote;
  }
  return left.note.localeCompare(right.note);
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

  const sameAttempt = state.lastAttemptedThrough !== null
    && compareCursor(state.lastAttemptedThrough, attemptedThrough) === 0;
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

export function applyRecordDiscoveryAttempt(
  state: CurateState,
  highSeq: number,
  nextOffset: number,
): CurateState {
  return {
    ...state,
    discoveryHighSeq: Math.max(state.discoveryHighSeq, highSeq),
    discoveryOffset: nextOffset,
  };
}

export function applyAddPendingDiscovery(
  state: CurateState,
  entry: PendingDiscovery,
): CurateState | null {
  const alreadyPending = state.pendingDiscoveries.some((pending) => (
    pending.principle === entry.principle
    && pending.statement === entry.statement
  ));
  if (alreadyPending) {
    return null;
  }

  return {
    ...state,
    pendingDiscoveries: [...state.pendingDiscoveries, entry],
  };
}

export function applyRemovePendingDiscovery(
  state: CurateState,
  entry: PendingDiscovery,
): CurateState | null {
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
    // Move curate-state.json from KB content dir to runtime dir if it exists at the old location
    const legacyPath = join(kb.markdownRoot, CURATE_STATE_FILE);
    const currentPath = kb.curateStatePath();
    if (legacyPath !== currentPath && existsSync(legacyPath) && !existsSync(currentPath)) {
      try { renameSync(legacyPath, currentPath); } catch { /* best-effort */ }
    }

    const state = readCurateState(kb);
    if (state.initialized) {
      return;
    }

    const noteNames = sortedNoteNames(kb);
    if (noteNames.length === 0) {
      writeCurateState(kb, {
        ...state,
        initialized: true,
      });
      return;
    }

    const currentIndex = kb.readIndex();
    if (currentIndex === null) {
      throw new Error('KB index must exist before curate migration.');
    }

    const nextIndex = cloneKbIndex(currentIndex);
    const indexState = kb.readIndexState();
    const scannedNotes = noteNames.map((note) => scanNote(kb, note));
    let highestExistingMutationSeq = 0;
    for (const scannedNote of scannedNotes) {
      if (scannedNote.frontmatter.mutationSeqAtPromote !== undefined) {
        highestExistingMutationSeq = Math.max(
          highestExistingMutationSeq,
          scannedNote.frontmatter.mutationSeqAtPromote,
        );
      }
    }

    const baseMutationSeq = Math.max(indexState.mutationSeq, highestExistingMutationSeq);
    let nextMutationSeqAtPromote = baseMutationSeq + 1;
    let highestAssignedMutationSeq = highestExistingMutationSeq;
    let indexChanged = false;

    for (const scannedNote of scannedNotes) {
      let mutationSeqAtPromote = scannedNote.frontmatter.mutationSeqAtPromote;
      if (mutationSeqAtPromote === undefined) {
        mutationSeqAtPromote = nextMutationSeqAtPromote;
        nextMutationSeqAtPromote += 1;
        scannedNote.frontmatter = {
          ...scannedNote.frontmatter,
          mutationSeqAtPromote,
        };
        writeFileAtomic(
          scannedNote.path,
          replaceFrontmatter(scannedNote.content, scannedNote.frontmatter),
        );
      }

      highestAssignedMutationSeq = Math.max(highestAssignedMutationSeq, mutationSeqAtPromote);
      indexChanged = syncIndexNote(
        scannedNote.note,
        scannedNote.title,
        scannedNote.frontmatter,
        mutationSeqAtPromote,
        nextIndex,
      ) || indexChanged;
    }

    if (indexChanged) {
      kb.writeIndex(nextIndex);
    }

    if (highestAssignedMutationSeq > indexState.mutationSeq) {
      kb.writeIndexState({
        ...indexState,
        mutationSeq: highestAssignedMutationSeq,
      });
    }

    // Infer processedThrough for synced KBs: if notes already show curation
    // evidence (tags > 1 or principles > 0), set watermark to the highest
    // curated cursor so curate skips the already-classified corpus.
    let processedThrough = state.processedThrough;
    if (processedThrough === null) {
      let highestCuratedCursor: CurateCursor | null = null;
      for (const scannedNote of scannedNotes) {
        const seq = scannedNote.frontmatter.mutationSeqAtPromote;
        if (seq === undefined) continue;
        if (scannedNote.frontmatter.tags.length <= 1 && scannedNote.frontmatter.principles.length === 0) continue;
        const cursor: CurateCursor = { note: scannedNote.note, mutationSeqAtPromote: seq };
        if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
          highestCuratedCursor = cursor;
        }
      }
      if (highestCuratedCursor !== null) {
        processedThrough = highestCuratedCursor;
      }
    }

    writeCurateState(kb, {
      ...state,
      processedThrough,
      initialized: true,
    });
  });
}
