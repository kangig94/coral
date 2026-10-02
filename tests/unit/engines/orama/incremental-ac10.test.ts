import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

it('persists a mixed insert, update, and delete delta across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-incremental-'));
  const db = openKbTestStoreDb(':memory:');
  const kb = createTestKbRuntime({ markdownRoot: root, runtimeDir: join(root, '.runtime'), db });
  const projection = () =>
    new OramaBaseProjection(
      kb,
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
    );
  const seed = (notes: Record<string, string>) => {
    rmSync(kb.notesDir(), { recursive: true, force: true });
    mkdirSync(kb.notesDir(), { recursive: true });
    const entries: KbIndex['entries'] = {};
    for (const [slug, body] of Object.entries(notes)) {
      writeFileSync(
        kb.notePath(slug),
        `---\ntags: []\nprinciples: []\nsource: []\ncreatedAt: 2026-04-01T00:00:00.000Z\nupdatedAt: 2026-04-01T00:00:00.000Z\n---\n# ${slug}\n\n${body}\n`,
      );
      entries[noteEntryId(slug)] = buildNoteIndexEntry({
        slug,
        title: slug,
        body,
        tags: [],
        principles: [],
        source: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      });
    }
    kb.writeIndex({ entries, principles: {}, entityMeta: {}, relationships: [] });
    kb.recordMutationCommitted('both', 'mixed delta');
  };
  const apply = async (target: OramaBaseProjection) => {
    const snapshot = kb.captureCorpusSnapshot();
    await target.apply({
      snapshot,
      journalReader: { readCursor: () => 0 },
      corpusStateReader: { readConsumerCursor: () => snapshot, readCurrentSnapshot: () => snapshot },
      projectionInput: createKbProjectionInput(kb),
      signal: new AbortController().signal,
    });
  };

  try {
    seed({ updated: 'baseline oldonly', deleted: 'baseline deletedonly' });
    const live = projection();
    await apply(live);
    seed({ updated: 'survivor updatedonly', inserted: 'survivor insertedonly' });
    await apply(live);

    const restarted = projection();
    expect((await restarted.search('survivor', 10, 'all')).hits.map((hit) => hit.documentId).sort()).toEqual([
      'note:inserted',
      'note:updated',
    ]);
    expect((await restarted.search('oldonly', 10, 'all')).hits).toEqual([]);
    expect((await restarted.search('deletedonly', 10, 'all')).hits).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
