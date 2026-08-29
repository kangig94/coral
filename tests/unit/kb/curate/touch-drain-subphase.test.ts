import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractBody, parseWikiBody } from '#src/kb/corpus/frontmatter.js';
import { appendTouchEvent, touchJournalProgressPath, touchJournalTombstonePath } from '#src/kb/curate/touch-journal.js';
import { runTouchDrainSubphase } from '#src/kb/curate/scheduler.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createWiki } from '#src/kb/ops/wiki/create.js';
import { linkWikiKnowledge } from '#src/kb/ops/wiki/link.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

const STATIC_NOW = (): number => new Date('2026-05-04T00:00:00.000Z').getTime();

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'coral-touch-drain-subphase-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function createRuntime(): KbRuntime {
  const markdownRoot = join(rootDir, 'vault');
  const runtimeDir = join(rootDir, 'runtime');
  mkdirSync(markdownRoot, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  return createTestKbRuntime({
    markdownRoot,
    runtimeDir,
    db: openKbTestStoreDb(':memory:'),
  });
}

async function seedWiki(kb: KbRuntime, slug: string, refs: readonly string[]): Promise<void> {
  await createWiki(kb, { slug });
  await linkWikiKnowledge(kb, { slug, refs });
}

function readKnowledge(kb: KbRuntime, slug: string): string {
  const raw = readFileSync(kb.wikiPath(slug), 'utf-8');
  return parseWikiBody(extractBody(raw)).knowledge;
}

describe('runTouchDrainSubphase', () => {
  it('does not replay completed wiki swaps after a later wiki fails in the same drain batch', async () => {
    const kb = createRuntime();
    await seedWiki(kb, 'wiki-one', ['note:a', 'note:b', 'note:c']);
    await seedWiki(kb, 'wiki-two', ['note:x', 'note:y', 'note:z']);

    appendTouchEvent(kb.runtimeDir, noteEntryId('c'), 'evt-1', { storage: kb.storagePort, now: STATIC_NOW });
    appendTouchEvent(kb.runtimeDir, noteEntryId('z'), 'evt-2', { storage: kb.storagePort, now: STATIC_NOW });

    const wikiTwoPath = kb.wikiPath('wiki-two');
    const wikiTwoRaw = readFileSync(wikiTwoPath, 'utf-8');
    rmSync(wikiTwoPath, { force: true });

    await expect(runTouchDrainSubphase(kb)).rejects.toThrow('KB wiki not found');

    expect(readKnowledge(kb, 'wiki-one')).toBe('- [[notes/a]]\n- [[notes/c]]\n- [[notes/b]]');
    expect(existsSync(touchJournalTombstonePath(kb.runtimeDir))).toBe(true);
    expect(existsSync(touchJournalProgressPath(kb.runtimeDir))).toBe(true);

    writeFileSync(wikiTwoPath, wikiTwoRaw, 'utf-8');
    await expect(runTouchDrainSubphase(kb)).resolves.toBe(true);

    expect(readKnowledge(kb, 'wiki-one')).toBe('- [[notes/a]]\n- [[notes/c]]\n- [[notes/b]]');
    expect(readKnowledge(kb, 'wiki-two')).toBe('- [[notes/x]]\n- [[notes/z]]\n- [[notes/y]]');
    expect(existsSync(touchJournalTombstonePath(kb.runtimeDir))).toBe(false);
    expect(existsSync(touchJournalProgressPath(kb.runtimeDir))).toBe(false);
  });
});
