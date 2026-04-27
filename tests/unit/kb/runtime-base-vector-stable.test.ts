import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reindex } from '#src/kb/ops/reindex.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/kb/search/orama/index.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-runtime-base-vector-'));
  tempRoots.push(root);
  return root;
}

function writeNote(root: string, entrySeq: number, body: string): void {
  const notesDir = join(root, 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    join(notesDir, 'stable-base-vector.md'),
    [
      '---',
      'tags: [coral]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-04-22T00:00:00.000Z',
      'updatedAt: 2026-04-22T00:00:00.000Z',
      `entrySeq: ${entrySeq}`,
      '---',
      '# Stable Base Vector',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
}

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) {
    try {
      db.close();
    } catch {
      // Ignore redundant cleanup for already-closed SQLite handles.
    }
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KbRuntime base vector binding stability', () => {
  it('keeps the same base vector and fts defaults across a corpus rebuild', async () => {
    const root = allocateRoot();
    writeNote(root, 1, 'Initial corpus body.');

    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
    });
    openDatabases.push(kb.db);

    await reindex(kb);
    const beforeVector = kb.vector.read();
    const beforeFts = kb.fts.read();

    writeNote(root, 2, 'Updated corpus body after rebuild.');
    await reindex(kb);

    expect(kb.vector.read()).toBe(beforeVector);
    expect(kb.fts.read()).toBe(beforeFts);
  });

  it('defaults vector and fts to Orama while leaving embedding unbound', () => {
    const root = allocateRoot();
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
    });
    openDatabases.push(kb.db);

    const firstVector = kb.vector.read();
    const secondVector = kb.vector.read();
    const fts = kb.fts.read();

    expect(firstVector).toBe(secondVector);
    expect(firstVector.consumer.id).toBe(ORAMA_BASE_CONSUMER_ID);
    expect(fts.consumer.id).toBe(ORAMA_BASE_CONSUMER_ID);
    expect(() => kb.embedding.read()).toThrow(CoralSetupError);
  });
});
