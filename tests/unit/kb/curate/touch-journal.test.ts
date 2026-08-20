import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { noteEntryId, wikiEntryId, type KbIndex } from '#src/kb/entry-types.js';
import {
  appendTouchEvent,
  drainTouchJournal,
  drainTouchJournalBatch,
  markTouchJournalWikiApplied,
  resolveTouchJournalWorkState,
  touchJournalPath,
  touchJournalProgressPath,
  touchJournalTombstonePath,
  truncateTouchJournal,
} from '#src/kb/curate/touch-journal.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';

const realRuntime = createRealRuntime('prod');
const realStorage = realRuntime.storage;

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'coral-touch-journal-'));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function indexWithWikis(map: Record<string, string[]>): KbIndex {
  return {
    entries: Object.fromEntries(
      Object.entries(map).map(([slug, knowledgeSlugs]) => [
        wikiEntryId(slug),
        {
          kind: 'wiki' as const,
          slug,
          title: slug,
          tags: [],
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
          knowledge: knowledgeSlugs.map(noteEntryId),
        },
      ]),
    ),
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

const STATIC_NOW = (): number => new Date('2026-05-04T00:00:00.000Z').getTime();

describe('touch-journal', () => {
  it('appends events, drains them through the tombstone, and coalesces affected wikis', () => {
    const targetA = noteEntryId('alpha');
    const targetB = noteEntryId('beta');
    appendTouchEvent(runtimeDir, targetA, 'evt-1', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, targetB, 'evt-2', { storage: realStorage, now: STATIC_NOW });

    const index = indexWithWikis({
      'wiki-one': ['alpha', 'gamma'],
      'wiki-two': ['beta'],
      'wiki-three': ['gamma'],
    });

    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });

    expect([...result.keys()].sort()).toEqual(['wiki-one', 'wiki-two']);
    expect(result.get('wiki-one')!).toEqual([targetA]);
    expect(result.get('wiki-two')!).toEqual([targetB]);
    expect(existsSync(touchJournalPath(runtimeDir))).toBe(false);
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(true);
  });

  it('dedupes duplicate eventIds within a single drain', () => {
    const target = noteEntryId('alpha');
    appendTouchEvent(runtimeDir, target, 'evt-1', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, target, 'evt-1', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, target, 'evt-1', { storage: realStorage, now: STATIC_NOW });

    const index = indexWithWikis({ 'wiki-one': ['alpha'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });

    expect(result.size).toBe(1);
    expect(result.get('wiki-one')!).toEqual([target]);
  });

  it('preserves distinct touch events for the same target in batch order (per-event semantics)', () => {
    const target = noteEntryId('alpha');
    appendTouchEvent(runtimeDir, target, 'evt-1', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, target, 'evt-2', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, target, 'evt-3', { storage: realStorage, now: STATIC_NOW });

    const index = indexWithWikis({ 'wiki-one': ['alpha', 'beta'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });

    // Three distinct eventIds → three swap requests; downstream bubble-up
    // performs one swap per entry (Rivest 1976 transposition heuristic).
    expect(result.get('wiki-one')!).toEqual([target, target, target]);
  });

  it('atomic rotation: renames jsonl to tombstone before reading, leaving canonical absent', () => {
    appendTouchEvent(runtimeDir, noteEntryId('alpha'), 'evt-1', { storage: realStorage, now: STATIC_NOW });
    expect(existsSync(touchJournalPath(runtimeDir))).toBe(true);
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(false);

    drainTouchJournal(runtimeDir, indexWithWikis({ 'wiki-one': ['alpha'] }), { storage: realStorage });

    expect(existsSync(touchJournalPath(runtimeDir))).toBe(false);
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(true);
  });

  it('truncate removes the tombstone idempotently and leaves no segments behind', () => {
    appendTouchEvent(runtimeDir, noteEntryId('alpha'), 'evt-1', { storage: realStorage, now: STATIC_NOW });
    drainTouchJournal(runtimeDir, indexWithWikis({ 'wiki-one': ['alpha'] }), { storage: realStorage });
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(true);

    truncateTouchJournal(runtimeDir, { storage: realStorage });
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(false);
    expect(existsSync(touchJournalProgressPath(runtimeDir))).toBe(false);

    truncateTouchJournal(runtimeDir, { storage: realStorage });
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(false);
    expect(existsSync(touchJournalProgressPath(runtimeDir))).toBe(false);
  });

  it('records per-wiki completion and skips completed work on retry', () => {
    const targetA = noteEntryId('alpha');
    const targetB = noteEntryId('beta');
    appendTouchEvent(runtimeDir, targetA, 'evt-1', { storage: realStorage, now: STATIC_NOW });
    appendTouchEvent(runtimeDir, targetB, 'evt-2', { storage: realStorage, now: STATIC_NOW });

    const index = indexWithWikis({ 'wiki-one': ['root', 'alpha'], 'wiki-two': ['root', 'beta'] });
    const batch = drainTouchJournalBatch(runtimeDir, index, { storage: realStorage });

    expect(batch.pending.map((work) => work.slug)).toEqual(['wiki-one', 'wiki-two']);
    markTouchJournalWikiApplied(runtimeDir, batch, batch.pending[0], { storage: realStorage });

    const retry = drainTouchJournalBatch(runtimeDir, index, { storage: realStorage });
    expect(retry.pending.map((work) => work.slug)).toEqual(['wiki-two']);
  });

  it('auto-completes work when the expected post-drain order is already present', () => {
    const target = noteEntryId('gamma');
    appendTouchEvent(runtimeDir, target, 'evt-1', { storage: realStorage, now: STATIC_NOW });

    const beforeIndex = indexWithWikis({ 'wiki-one': ['alpha', 'beta', 'gamma'] });
    const batch = drainTouchJournalBatch(runtimeDir, beforeIndex, { storage: realStorage });
    const work = batch.pending[0];
    expect(resolveTouchJournalWorkState(beforeIndex, work)).toBe('pending');

    const afterIndex = indexWithWikis({ 'wiki-one': ['alpha', 'gamma', 'beta'] });
    const retry = drainTouchJournalBatch(runtimeDir, afterIndex, { storage: realStorage });

    expect(resolveTouchJournalWorkState(afterIndex, work)).toBe('applied');
    expect(retry.pending).toEqual([]);
  });

  it('orphan segment recovery: drains wiki-touches.orphan.*.jsonl files into the dedupe map and deletes them', () => {
    const targetA = noteEntryId('alpha');
    const targetB = noteEntryId('beta');
    const orphanA = join(runtimeDir, 'wiki-touches.orphan.evt-1.jsonl');
    const orphanB = join(runtimeDir, 'wiki-touches.orphan.evt-2.jsonl');
    writeFileSync(
      orphanA,
      `${JSON.stringify({ eventId: 'evt-1', wiki_target: targetA, ts: '2026-05-04T00:00:00.000Z' })}\n`,
      'utf-8',
    );
    writeFileSync(
      orphanB,
      `${JSON.stringify({ eventId: 'evt-2', wiki_target: targetB, ts: '2026-05-04T00:00:01.000Z' })}\n`,
      'utf-8',
    );

    const index = indexWithWikis({ 'wiki-one': ['alpha'], 'wiki-two': ['beta'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });

    expect([...result.keys()].sort()).toEqual(['wiki-one', 'wiki-two']);
    expect(existsSync(orphanA)).toBe(false);
    expect(existsSync(orphanB)).toBe(false);
  });

  it('keeps orphan-only work durable through progress after orphan cleanup', () => {
    const target = noteEntryId('alpha');
    const orphanPath = join(runtimeDir, 'wiki-touches.orphan.evt-1.jsonl');
    writeFileSync(
      orphanPath,
      `${JSON.stringify({ eventId: 'evt-1', wiki_target: target, ts: '2026-05-04T00:00:00.000Z' })}\n`,
      'utf-8',
    );

    const index = indexWithWikis({ 'wiki-one': ['root', 'alpha'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });
    expect(result.get('wiki-one')).toEqual([target]);
    expect(existsSync(orphanPath)).toBe(false);

    const retry = drainTouchJournal(runtimeDir, index, { storage: realStorage });
    expect(retry.get('wiki-one')).toEqual([target]);
  });

  it('does not rotate a new canonical journal while previous progress is still cleaning up', () => {
    const targetA = noteEntryId('alpha');
    const orphanPath = join(runtimeDir, 'wiki-touches.orphan.evt-1.jsonl');
    writeFileSync(
      orphanPath,
      `${JSON.stringify({ eventId: 'evt-1', wiki_target: targetA, ts: '2026-05-04T00:00:00.000Z' })}\n`,
      'utf-8',
    );

    const index = indexWithWikis({ 'wiki-one': ['root', 'alpha'], 'wiki-two': ['root', 'beta'] });
    const batch = drainTouchJournalBatch(runtimeDir, index, { storage: realStorage });
    markTouchJournalWikiApplied(runtimeDir, batch, batch.pending[0], { storage: realStorage });

    const targetB = noteEntryId('beta');
    appendTouchEvent(runtimeDir, targetB, 'evt-2', { storage: realStorage, now: STATIC_NOW });

    const cleanupRetry = drainTouchJournalBatch(runtimeDir, index, { storage: realStorage });
    expect(cleanupRetry.pending).toEqual([]);
    expect(existsSync(touchJournalPath(runtimeDir))).toBe(true);

    truncateTouchJournal(runtimeDir, { storage: realStorage });
    const nextBatch = drainTouchJournal(runtimeDir, index, { storage: realStorage });
    expect(nextBatch.get('wiki-two')).toEqual([targetB]);
  });

  it('orphan segment dedupes against tombstone events using shared eventId', () => {
    appendTouchEvent(runtimeDir, noteEntryId('alpha'), 'evt-1', { storage: realStorage, now: STATIC_NOW });
    // Force the canonical → tombstone rotation so the tombstone holds evt-1.
    renameSync(touchJournalPath(runtimeDir), touchJournalTombstonePath(runtimeDir));
    const targetB = noteEntryId('beta');
    const orphanPath = join(runtimeDir, 'wiki-touches.orphan.evt-1.jsonl');
    writeFileSync(
      orphanPath,
      `${JSON.stringify({ eventId: 'evt-1', wiki_target: targetB, ts: '2026-05-04T00:00:01.000Z' })}\n`,
      'utf-8',
    );

    const index = indexWithWikis({ 'wiki-one': ['alpha'], 'wiki-two': ['beta'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: realStorage });

    // evt-1 deduped to alpha (tombstone wins by reading first), so wiki-two not touched.
    expect([...result.keys()]).toEqual(['wiki-one']);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('size-stability: re-reads the tombstone when its size grows mid-read', () => {
    // Use the simulation storage so we can intercept readFileSync via a wrapper.
    const memory = new InMemoryStorage(realRuntime.time);
    memory.mkdirSync(runtimeDir, { recursive: true });
    const tombstonePath = touchJournalTombstonePath(runtimeDir);
    const initialEvent = `${JSON.stringify({ eventId: 'evt-1', wiki_target: noteEntryId('alpha'), ts: '2026-05-04T00:00:00.000Z' })}\n`;
    memory.writeAtomicSync(tombstonePath, initialEvent, { encoding: 'utf-8' });

    let readCalls = 0;
    const wrapped = {
      ...memory,
      appendFileWithCanonicalCheckSync: memory.appendFileWithCanonicalCheckSync.bind(memory),
      existsSync: memory.existsSync.bind(memory),
      mkdirSync: memory.mkdirSync.bind(memory),
      renameSync: memory.renameSync.bind(memory),
      rmSync: memory.rmSync.bind(memory),
      readdirSync: memory.readdirSync.bind(memory),
      statSync: memory.statSync.bind(memory),
      writeAtomicSync: memory.writeAtomicSync.bind(memory),
      readFileSync: ((path: string, encoding: 'utf-8'): string => {
        const result = memory.readFileSync(path, encoding);
        if (path === tombstonePath && readCalls === 0) {
          readCalls += 1;
          // Simulate a concurrent appender growing the tombstone between our
          // stat-before and stat-after; the next stat will see new content.
          memory.appendFileSync(
            tombstonePath,
            `${JSON.stringify({ eventId: 'evt-2', wiki_target: noteEntryId('beta'), ts: '2026-05-04T00:00:01.000Z' })}\n`,
          );
        }
        return result;
      }) as typeof memory.readFileSync,
    } as unknown as Parameters<typeof drainTouchJournal>[2]['storage'];

    const index = indexWithWikis({ 'wiki-one': ['alpha'], 'wiki-two': ['beta'] });
    const result = drainTouchJournal(runtimeDir, index, { storage: wrapped });

    expect([...result.keys()].sort()).toEqual(['wiki-one', 'wiki-two']);
  });

  it('truncate failure leaves the tombstone in place for the next-tick recovery', () => {
    appendTouchEvent(runtimeDir, noteEntryId('alpha'), 'evt-1', { storage: realStorage, now: STATIC_NOW });
    drainTouchJournal(runtimeDir, indexWithWikis({ 'wiki-one': ['alpha'] }), { storage: realStorage });

    const failingStorage = {
      ...realStorage,
      rmSync: () => {
        throw new Error('forced rmSync failure');
      },
    } as unknown as Parameters<typeof truncateTouchJournal>[1]['storage'];

    // truncate is best-effort: must not throw even when rm fails.
    expect(() => truncateTouchJournal(runtimeDir, { storage: failingStorage })).not.toThrow();

    // Tombstone remains for the next drain to absorb idempotently.
    expect(existsSync(touchJournalTombstonePath(runtimeDir))).toBe(true);
    const raw = readFileSync(touchJournalTombstonePath(runtimeDir), 'utf-8');
    expect(raw).toContain('evt-1');
  });
});
