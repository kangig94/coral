import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reindex } from '#src/kb/ops/reindex.js';
import { createKbRuntime } from '#src/kb/runtime.js';

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

describe('KbRuntime base vector surface stability', () => {
  it('keeps the same base vector surface across a corpus rebuild', async () => {
    const root = allocateRoot();
    writeNote(root, 1, 'Initial corpus body.');

    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
    });
    openDatabases.push(kb.db);

    await reindex(kb);
    const before = kb.getBaseRetrievalSurface();

    writeNote(root, 2, 'Updated corpus body after rebuild.');
    await reindex(kb);

    expect(kb.getBaseRetrievalSurface()).toBe(before);
  });

  it('returns a frozen cached empty equipment snapshot when no equipment resolver is present', () => {
    const root = allocateRoot();
    const kb = createKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
    });
    openDatabases.push(kb.db);

    const first = kb.getEquipmentView();
    const second = kb.getEquipmentView();

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.retrieval).toBe(kb.getBaseRetrievalSurface());
    expect(kb.getActiveVectorSurface()).toBe(kb.getBaseRetrievalSurface());
  });
});
