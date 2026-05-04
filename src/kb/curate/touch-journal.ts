import { join } from 'node:path';

import { backendLog } from '../../infra/backend-log.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import type { StoragePort } from '../../infra/port-types.js';
import { nowIsoString } from '../../infra/time.js';
import { isWikiEntry, parseKbEntryId, type KbEntryId, type KbIndex } from '../entry-types.js';

const TOUCH_JOURNAL_FILENAME = 'wiki-touches.jsonl';
const TOUCH_JOURNAL_TOMBSTONE_FILENAME = `${TOUCH_JOURNAL_FILENAME}.tombstone`;
const TOUCH_JOURNAL_ORPHAN_PREFIX = 'wiki-touches.orphan.';
const TOUCH_JOURNAL_ORPHAN_SUFFIX = '.jsonl';
const DEFAULT_APPEND_RETRIES = 3;

export type TouchJournalStorage = Pick<
  StoragePort,
  | 'appendFileWithCanonicalCheckSync'
  | 'existsSync'
  | 'mkdirSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'rmSync'
  | 'statSync'
>;

export interface AppendTouchEventOptions {
  storage: TouchJournalStorage;
  now: () => number;
}

export interface TouchJournalOptions {
  storage: TouchJournalStorage;
}

type TouchJournalEvent = {
  eventId: string;
  wiki_target: KbEntryId;
  ts: string;
};

export function touchJournalPath(runtimeDir: string): string {
  return join(runtimeDir, TOUCH_JOURNAL_FILENAME);
}

export function touchJournalTombstonePath(runtimeDir: string): string {
  return join(runtimeDir, TOUCH_JOURNAL_TOMBSTONE_FILENAME);
}

function touchJournalOrphanPath(runtimeDir: string, eventId: string): string {
  return join(runtimeDir, `${TOUCH_JOURNAL_ORPHAN_PREFIX}${eventId}${TOUCH_JOURNAL_ORPHAN_SUFFIX}`);
}

export function appendTouchEvent(
  runtimeDir: string,
  target: KbEntryId,
  eventId: string,
  options: AppendTouchEventOptions,
): void {
  const { storage, now } = options;
  const canonicalPath = touchJournalPath(runtimeDir);
  const event: TouchJournalEvent = {
    wiki_target: target,
    ts: nowIsoString(now()),
    eventId,
  };

  try {
    const result = storage.appendFileWithCanonicalCheckSync(canonicalPath, `${JSON.stringify(event)}\n`, {
      canonicalPath,
      maxRetries: DEFAULT_APPEND_RETRIES,
    });
    if (!result.ok) {
      backendLog.warn(
        `touch-journal: append exhausted retries (${result.retries}) for ${canonicalPath}; orphanPath=${result.orphanPath ?? 'unknown'}`,
      );
      // Move the orphan inode aside so subsequent appends to the canonical
      // path can succeed and drainTouchJournal can recover the segment.
      if (result.orphanPath !== undefined && result.orphanPath !== canonicalPath) {
        try {
          storage.renameSync(result.orphanPath, touchJournalOrphanPath(runtimeDir, eventId));
        } catch {
          // Best-effort rotation; if rename fails the orphan stays where it is
          // and will be skipped by drain (its name does not match the glob).
        }
      }
    }
  } catch {
    // KB reads must stay fail-open: an unwritable runtime journal must not break read-class operations.
  }
}

export function drainTouchJournal(
  runtimeDir: string,
  kbIndex: KbIndex,
  options: TouchJournalOptions,
): Map<string, Set<KbEntryId>> {
  const { storage } = options;
  const journalPath = touchJournalPath(runtimeDir);
  const tombstonePath = touchJournalTombstonePath(runtimeDir);

  try {
    storage.mkdirSync(runtimeDir, { recursive: true });
    if (!storage.existsSync(tombstonePath) && storage.existsSync(journalPath)) {
      storage.renameSync(journalPath, tombstonePath);
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return new Map();
    }
    throw error;
  }

  const targetsByEventId = new Map<string, KbEntryId>();
  if (storage.existsSync(tombstonePath)) {
    readTombstoneWithSizeStability(storage, tombstonePath, targetsByEventId);
  }

  const orphanPaths = listOrphanSegments(storage, runtimeDir);
  for (const orphanPath of orphanPaths) {
    readSegmentInto(storage, orphanPath, targetsByEventId);
  }
  // Delete orphan segments only after all reads succeed: a throw above leaves
  // the orphan in place for the next drain cycle to retry.
  for (const orphanPath of orphanPaths) {
    try {
      storage.rmSync(orphanPath, { force: true });
    } catch {
      // Best-effort cleanup; the orphan is safe to re-drain on the next cycle.
    }
  }

  return coalesceTouchedWikis(kbIndex, targetsByEventId.values());
}

export function truncateTouchJournal(runtimeDir: string, options: TouchJournalOptions): void {
  const { storage } = options;
  try {
    storage.rmSync(touchJournalTombstonePath(runtimeDir), { force: true });
  } catch {
    // Best-effort cleanup; the tombstone is safe to re-drain on the next curate cycle.
  }
}

function readTombstoneWithSizeStability(
  storage: TouchJournalStorage,
  tombstonePath: string,
  targetsByEventId: Map<string, KbEntryId>,
): void {
  // Re-read until two consecutive stat sizes match the post-read size: a
  // concurrent appender that lost the canonical-inode race may have grown the
  // tombstone between our stat and read, and we must not silently drop those
  // events.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sizeBefore = safeFileSize(storage, tombstonePath);
    if (sizeBefore === null) {
      return;
    }
    targetsByEventId.clear();
    readSegmentInto(storage, tombstonePath, targetsByEventId);
    const sizeAfter = safeFileSize(storage, tombstonePath);
    if (sizeAfter === sizeBefore) {
      return;
    }
  }
}

function safeFileSize(storage: TouchJournalStorage, path: string): number | null {
  try {
    return storage.statSync(path).size;
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

function listOrphanSegments(storage: TouchJournalStorage, runtimeDir: string): string[] {
  let entries: string[];
  try {
    entries = storage.readdirSync(runtimeDir);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((name) => name.startsWith(TOUCH_JOURNAL_ORPHAN_PREFIX) && name.endsWith(TOUCH_JOURNAL_ORPHAN_SUFFIX))
    .map((name) => join(runtimeDir, name));
}

function readSegmentInto(
  storage: TouchJournalStorage,
  segmentPath: string,
  targetsByEventId: Map<string, KbEntryId>,
): void {
  let raw: string;
  try {
    raw = storage.readFileSync(segmentPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
  for (const line of raw.split(/\r?\n/u)) {
    const event = parseTouchJournalEvent(line);
    if (event === null || targetsByEventId.has(event.eventId)) {
      continue;
    }
    targetsByEventId.set(event.eventId, event.wiki_target);
  }
}

function parseTouchJournalEvent(line: string): TouchJournalEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.eventId !== 'string' || record.eventId.length === 0 || typeof record.ts !== 'string') {
    return null;
  }
  if (typeof record.wiki_target !== 'string') {
    return null;
  }
  const target = parseKbEntryId(record.wiki_target);
  if (target === null) {
    return null;
  }

  return {
    eventId: record.eventId,
    wiki_target: target,
    ts: record.ts,
  };
}

function coalesceTouchedWikis(kbIndex: KbIndex, targets: Iterable<KbEntryId>): Map<string, Set<KbEntryId>> {
  const affected = new Map<string, Set<KbEntryId>>();
  const targetSet = new Set(targets);
  if (targetSet.size === 0) {
    return affected;
  }

  for (const entry of Object.values(kbIndex.entries)) {
    if (!isWikiEntry(entry)) {
      continue;
    }
    for (const target of targetSet) {
      if (!entry.knowledge.includes(target)) {
        continue;
      }
      let touchedTargets = affected.get(entry.slug);
      if (touchedTargets === undefined) {
        touchedTargets = new Set<KbEntryId>();
        affected.set(entry.slug, touchedTargets);
      }
      touchedTargets.add(target);
    }
  }

  return affected;
}
