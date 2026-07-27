import { join } from 'node:path';

import { backendLog } from '../../infra/backend-log.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { sha256Hex } from '../../infra/hash.js';
import type { StoragePort } from '../../infra/port-types.js';
import { nowIsoString } from '../../infra/time.js';
import { isWikiEntry, parseKbEntryId, wikiEntryId, type KbEntryId, type KbIndex } from '../entry-types.js';
import { KB_RUNTIME_AUTHORITY } from '../../runtime/kb-runtime-authority.js';

const TOUCH_JOURNAL_FILENAME = KB_RUNTIME_AUTHORITY.touchJournal;
const TOUCH_JOURNAL_TOMBSTONE_FILENAME = KB_RUNTIME_AUTHORITY.touchJournalTombstone;
const TOUCH_JOURNAL_PROGRESS_FILENAME = KB_RUNTIME_AUTHORITY.touchJournalProgress;
const TOUCH_JOURNAL_ORPHAN_PREFIX = 'wiki-touches.orphan.';
const TOUCH_JOURNAL_ORPHAN_SUFFIX = '.jsonl';
const DEFAULT_APPEND_RETRIES = 3;
const TOUCH_JOURNAL_PROGRESS_VERSION = 1;

type TouchJournalStorage = Pick<
  StoragePort,
  | 'appendFileWithCanonicalCheckSync'
  | 'existsSync'
  | 'mkdirSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'rmSync'
  | 'statSync'
  | 'writeAtomicSync'
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

export type TouchJournalWorkItem = {
  key: string;
  slug: string;
  targets: KbEntryId[];
  beforeKnowledgeHash: string;
  afterKnowledgeHash: string;
};

export type TouchJournalDrainBatch = {
  batchId: string | null;
  workItems: TouchJournalWorkItem[];
  pending: TouchJournalWorkItem[];
};

type TouchJournalProgress = {
  version: typeof TOUCH_JOURNAL_PROGRESS_VERSION;
  batchId: string;
  workItems: TouchJournalWorkItem[];
  completed: string[];
};

export type TouchJournalWorkState = 'pending' | 'applied' | 'obsolete' | 'conflict';

export function touchJournalPath(runtimeDir: string): string {
  return join(runtimeDir, TOUCH_JOURNAL_FILENAME);
}

export function touchJournalTombstonePath(runtimeDir: string): string {
  return join(runtimeDir, TOUCH_JOURNAL_TOMBSTONE_FILENAME);
}

export function touchJournalProgressPath(runtimeDir: string): string {
  return join(runtimeDir, TOUCH_JOURNAL_PROGRESS_FILENAME);
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
): Map<string, KbEntryId[]> {
  const batch = drainTouchJournalBatch(runtimeDir, kbIndex, options);
  return mapWorkItemsBySlug(batch.pending);
}

export function drainTouchJournalBatch(
  runtimeDir: string,
  kbIndex: KbIndex,
  options: TouchJournalOptions,
): TouchJournalDrainBatch {
  const { storage } = options;
  const journalPath = touchJournalPath(runtimeDir);
  const tombstonePath = touchJournalTombstonePath(runtimeDir);
  const progressPath = touchJournalProgressPath(runtimeDir);

  try {
    storage.mkdirSync(runtimeDir, { recursive: true });
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return emptyDrainBatch();
    }
    throw error;
  }

  const existingProgress = readTouchJournalProgress(storage, progressPath);
  if (existingProgress !== null) {
    return batchFromProgress(runtimeDir, kbIndex, existingProgress, options, { autoCompleteApplied: true });
  }

  try {
    if (!storage.existsSync(tombstonePath) && storage.existsSync(journalPath)) {
      storage.renameSync(journalPath, tombstonePath);
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return emptyDrainBatch();
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
  if (!storage.existsSync(tombstonePath) && targetsByEventId.size === 0) {
    return emptyDrainBatch();
  }

  const progress = createTouchJournalProgress(kbIndex, targetsByEventId);
  writeTouchJournalProgress(storage, progressPath, progress);

  // Delete orphan segments only after all reads succeed: a throw above leaves
  // the orphan in place for the next drain cycle to retry. The durable progress
  // file is written first so orphan-only events survive a later scheduler
  // failure or process crash.
  for (const orphanPath of orphanPaths) {
    try {
      storage.rmSync(orphanPath, { force: true });
    } catch {
      // Best-effort cleanup; the orphan is safe to re-drain on the next cycle.
    }
  }

  return batchFromProgress(runtimeDir, kbIndex, progress, options, { autoCompleteApplied: false });
}

export function truncateTouchJournal(runtimeDir: string, options: TouchJournalOptions): void {
  const { storage } = options;
  try {
    storage.rmSync(touchJournalTombstonePath(runtimeDir), { force: true });
  } catch {
    // Best-effort cleanup; the tombstone is safe to re-drain on the next curate cycle.
  }
  try {
    storage.rmSync(touchJournalProgressPath(runtimeDir), { force: true });
  } catch {
    // Best-effort cleanup; progress is safe to re-read on the next curate cycle.
  }
  for (const orphanPath of listOrphanSegments(storage, runtimeDir)) {
    try {
      storage.rmSync(orphanPath, { force: true });
    } catch {
      // Best-effort cleanup; a leftover orphan will be recovered by a later drain.
    }
  }
}

export function markTouchJournalWikiApplied(
  runtimeDir: string,
  batch: TouchJournalDrainBatch,
  work: TouchJournalWorkItem,
  options: TouchJournalOptions,
): void {
  const { storage } = options;
  if (batch.batchId === null) {
    return;
  }

  const progressPath = touchJournalProgressPath(runtimeDir);
  const progress =
    readTouchJournalProgress(storage, progressPath) ??
    ({
      version: TOUCH_JOURNAL_PROGRESS_VERSION,
      batchId: batch.batchId,
      workItems: batch.workItems,
      completed: [],
    } satisfies TouchJournalProgress);

  if (progress.batchId !== batch.batchId) {
    throw new Error(`touch-journal: progress batch mismatch for ${work.slug}`);
  }
  const completed = new Set(progress.completed);
  completed.add(work.key);
  writeTouchJournalProgress(storage, progressPath, {
    ...progress,
    completed: [...completed].sort(),
  });
}

export function resolveTouchJournalWorkState(kbIndex: KbIndex, work: TouchJournalWorkItem): TouchJournalWorkState {
  const entry = kbIndex.entries[wikiEntryId(work.slug)];
  if (entry === undefined || !isWikiEntry(entry)) {
    return 'obsolete';
  }

  const currentHash = knowledgeOrderHash(entry.knowledge);
  if (currentHash === work.afterKnowledgeHash) {
    return 'applied';
  }
  if (currentHash === work.beforeKnowledgeHash) {
    return 'pending';
  }
  return 'conflict';
}

function emptyDrainBatch(): TouchJournalDrainBatch {
  return {
    batchId: null,
    workItems: [],
    pending: [],
  };
}

function mapWorkItemsBySlug(workItems: readonly TouchJournalWorkItem[]): Map<string, KbEntryId[]> {
  const result = new Map<string, KbEntryId[]>();
  for (const work of workItems) {
    result.set(work.slug, work.targets);
  }
  return result;
}

function batchFromProgress(
  runtimeDir: string,
  kbIndex: KbIndex,
  progress: TouchJournalProgress,
  options: TouchJournalOptions,
  behavior: { autoCompleteApplied: boolean },
): TouchJournalDrainBatch {
  const completed = new Set(progress.completed);
  let completedChanged = false;

  if (behavior.autoCompleteApplied) {
    for (const work of progress.workItems) {
      if (completed.has(work.key)) {
        continue;
      }
      const state = resolveTouchJournalWorkState(kbIndex, work);
      if (state === 'applied' || state === 'obsolete') {
        completed.add(work.key);
        completedChanged = true;
      }
    }
  }

  if (completedChanged) {
    writeTouchJournalProgress(options.storage, touchJournalProgressPath(runtimeDir), {
      ...progress,
      completed: [...completed].sort(),
    });
  }

  return {
    batchId: progress.batchId,
    workItems: progress.workItems,
    pending: progress.workItems.filter((work) => !completed.has(work.key)),
  };
}

function createTouchJournalProgress(
  kbIndex: KbIndex,
  targetsByEventId: ReadonlyMap<string, KbEntryId>,
): TouchJournalProgress {
  const batchSeed = [...targetsByEventId.entries()];
  const batchId = sha256Hex(JSON.stringify(batchSeed));
  const affectedWikis = groupTouchEventsByWiki(kbIndex, targetsByEventId.values());
  const workItems: TouchJournalWorkItem[] = [];

  for (const [slug, targets] of affectedWikis) {
    const entry = kbIndex.entries[wikiEntryId(slug)];
    if (entry === undefined || !isWikiEntry(entry)) {
      continue;
    }
    const before = entry.knowledge;
    const after = applyTouchTranspositions(before, targets);
    const beforeKnowledgeHash = knowledgeOrderHash(before);
    const afterKnowledgeHash = knowledgeOrderHash(after);
    const key = touchJournalWorkKey(slug, targets, beforeKnowledgeHash, afterKnowledgeHash);
    workItems.push({
      key,
      slug,
      targets: [...targets],
      beforeKnowledgeHash,
      afterKnowledgeHash,
    });
  }

  return {
    version: TOUCH_JOURNAL_PROGRESS_VERSION,
    batchId,
    workItems,
    completed: [],
  };
}

function applyTouchTranspositions(knowledge: readonly KbEntryId[], targets: readonly KbEntryId[]): KbEntryId[] {
  const next = [...knowledge];
  for (const target of targets) {
    const index = next.indexOf(target);
    if (index <= 0) {
      continue;
    }
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
  }
  return next;
}

function touchJournalWorkKey(
  slug: string,
  targets: readonly KbEntryId[],
  beforeKnowledgeHash: string,
  afterKnowledgeHash: string,
): string {
  return sha256Hex(JSON.stringify({ slug, targets, beforeKnowledgeHash, afterKnowledgeHash }));
}

function knowledgeOrderHash(knowledge: readonly KbEntryId[]): string {
  return sha256Hex(JSON.stringify(knowledge));
}

function readTouchJournalProgress(storage: TouchJournalStorage, progressPath: string): TouchJournalProgress | null {
  let raw: string;
  try {
    raw = storage.readFileSync(progressPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`touch-journal: invalid progress JSON at ${progressPath}`);
  }

  const progress = parseTouchJournalProgress(parsed);
  if (progress === null) {
    throw new Error(`touch-journal: invalid progress schema at ${progressPath}`);
  }
  return progress;
}

function writeTouchJournalProgress(
  storage: TouchJournalStorage,
  progressPath: string,
  progress: TouchJournalProgress,
): void {
  const ok = storage.writeAtomicSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`, { encoding: 'utf-8' });
  if (!ok) {
    throw new Error(`touch-journal: failed to write progress at ${progressPath}`);
  }
}

function parseTouchJournalProgress(parsed: unknown): TouchJournalProgress | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== TOUCH_JOURNAL_PROGRESS_VERSION ||
    typeof record.batchId !== 'string' ||
    record.batchId.length === 0 ||
    !Array.isArray(record.workItems) ||
    !Array.isArray(record.completed)
  ) {
    return null;
  }

  const workItems: TouchJournalWorkItem[] = [];
  for (const item of record.workItems) {
    const work = parseTouchJournalWorkItem(item);
    if (work === null) {
      return null;
    }
    workItems.push(work);
  }

  const completed: string[] = [];
  for (const key of record.completed) {
    if (typeof key !== 'string' || key.length === 0) {
      return null;
    }
    completed.push(key);
  }

  return {
    version: TOUCH_JOURNAL_PROGRESS_VERSION,
    batchId: record.batchId,
    workItems,
    completed,
  };
}

function parseTouchJournalWorkItem(parsed: unknown): TouchJournalWorkItem | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.key !== 'string' ||
    record.key.length === 0 ||
    typeof record.slug !== 'string' ||
    record.slug.length === 0 ||
    typeof record.beforeKnowledgeHash !== 'string' ||
    record.beforeKnowledgeHash.length === 0 ||
    typeof record.afterKnowledgeHash !== 'string' ||
    record.afterKnowledgeHash.length === 0 ||
    !Array.isArray(record.targets)
  ) {
    return null;
  }

  const targets: KbEntryId[] = [];
  for (const target of record.targets) {
    if (typeof target !== 'string') {
      return null;
    }
    const parsedTarget = parseKbEntryId(target);
    if (parsedTarget === null) {
      return null;
    }
    targets.push(parsedTarget);
  }

  return {
    key: record.key,
    slug: record.slug,
    targets,
    beforeKnowledgeHash: record.beforeKnowledgeHash,
    afterKnowledgeHash: record.afterKnowledgeHash,
  };
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
  const orphanPaths: string[] = [];
  for (const name of entries) {
    if (name.startsWith(TOUCH_JOURNAL_ORPHAN_PREFIX) && name.endsWith(TOUCH_JOURNAL_ORPHAN_SUFFIX)) {
      orphanPaths.push(join(runtimeDir, name));
    }
  }
  return orphanPaths;
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

/**
 * Reverse-map touch events to affected wikis, preserving event order and
 * count. Each touch event in the input becomes one entry in the per-wiki
 * list — the downstream bubble-up helper performs one swap per entry, so
 * 5 reads of the same link produce 5 swaps (Rivest 1976 transposition
 * heuristic). eventId-level dedup against rotation/segment overlap has
 * already been applied by the caller (`targetsByEventId`).
 */
function groupTouchEventsByWiki(kbIndex: KbIndex, targets: Iterable<KbEntryId>): Map<string, KbEntryId[]> {
  const affected = new Map<string, KbEntryId[]>();
  const targetList = [...targets];
  if (targetList.length === 0) {
    return affected;
  }

  const wikisByTarget = new Map<KbEntryId, string[]>();
  for (const entry of Object.values(kbIndex.entries)) {
    if (!isWikiEntry(entry)) {
      continue;
    }
    for (const knowledgeId of entry.knowledge) {
      let slugs = wikisByTarget.get(knowledgeId);
      if (slugs === undefined) {
        slugs = [];
        wikisByTarget.set(knowledgeId, slugs);
      }
      slugs.push(entry.slug);
    }
  }

  for (const target of targetList) {
    const slugs = wikisByTarget.get(target);
    if (slugs === undefined) {
      continue;
    }
    for (const slug of slugs) {
      let events = affected.get(slug);
      if (events === undefined) {
        events = [];
        affected.set(slug, events);
      }
      events.push(target);
    }
  }

  return affected;
}
