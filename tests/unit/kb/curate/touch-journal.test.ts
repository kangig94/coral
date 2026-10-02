import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  touchJournalTombstonePath,
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
});
