import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INDEX_FILE, INDEX_STATE_FILE } from '#src/kb/corpus/index-store.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import { listPrinciples } from '#src/kb/ops/principles-list.js';
import { listSources } from '#src/kb/ops/source-store.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const openDbs = new Set<Database>();

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeMarkdownFixture(markdownRoot: string): void {
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  mkdirSync(join(markdownRoot, 'principles'), { recursive: true });
  mkdirSync(join(markdownRoot, 'sources'), { recursive: true });

  writeFileSync(
    join(markdownRoot, 'notes', 'coral-kb-mode.md'),
    `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - sqlite/overview
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode

Keep read paths direct.
`,
    'utf8',
  );

  writeFileSync(
    join(markdownRoot, 'principles', 'contract-first-design.md'),
    `---
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
Make the contract explicit first.
`,
    'utf8',
  );

  writeFileSync(
    join(markdownRoot, 'sources', 'sqlite-overview.md'),
    `---
title: SQLite Overview
type: reference
source: sqlite/overview
importedAt: 2026-03-20T00:00:00.000Z
tags: [sqlite, storage]
entrySeq: 7
---
# SQLite Overview
`,
    'utf8',
  );
}

function createRuntime() {
  const root = createTempRoot('coral-kb-direct-read-');
  const markdownRoot = join(root, 'kb');
  const runtimeDir = join(root, 'runtime');
  const db = createKbTestDb(root);
  openDbs.add(db);
  return {
    markdownRoot,
    runtimeDir,
    kb: createKbRuntime({
      markdownRoot,
      runtimeDir,
      db,
      readOnlyOrama: true,
    }),
  };
}

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KB direct read index', () => {
  it('builds a transient list view from markdown without writing derived artifacts', async () => {
    const { kb, markdownRoot, runtimeDir } = createRuntime();
    writeMarkdownFixture(markdownRoot);

    expect(listPrinciples(kb, { verbose: true })).toEqual({
      principles: [
        {
          name: 'contract-first-design',
          statement: 'Make the contract explicit first.',
          notes: ['coral-kb-mode'],
        },
      ],
      total: 1,
    });
    await expect(listSources(kb)).resolves.toEqual({
      sources: [
        {
          slug: 'sqlite-overview',
          title: 'SQLite Overview',
          type: 'reference',
          tags: ['sqlite', 'storage'],
          importedAt: '2026-03-20T00:00:00.000Z',
        },
      ],
    });

    expect(existsSync(join(runtimeDir, INDEX_FILE))).toBe(false);
    expect(existsSync(join(runtimeDir, INDEX_STATE_FILE))).toBe(false);
  });

  it('uses the persisted list index when one exists', () => {
    const { kb, markdownRoot } = createRuntime();
    writeMarkdownFixture(markdownRoot);

    const persisted: KbIndex = {
      entries: {},
      principles: {
        persisted: 'Persisted statement.',
      },
      entityMeta: {},
      relationships: [],
    };
    kb.writeIndex(persisted);

    expect(listPrinciples(kb, {})).toEqual({
      principles: ['persisted'],
      total: 1,
    });
  });
});
