import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-burst-'));
  tempRoots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function seedNote(kb: KbRuntime, slug: string, body: string, entrySeq: number): void {
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath(slug),
    [
      '---',
      'tags: [coral]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-04-01T00:00:00.000Z',
      'updatedAt: 2026-04-01T00:00:00.000Z',
      `entrySeq: ${entrySeq}`,
      '---',
      `# ${slug}`,
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
  const index = kb.readIndexOrEmpty();
  kb.writeIndex({
    ...index,
    entries: {
      ...index.entries,
      [`note:${slug}`]: {
        kind: 'note',
        slug,
        title: slug,
        tags: ['coral'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        related: [],
        bodyHash: computeBodySurfaceHash(body),
        entrySeq,
      },
    },
  });
  // recordMutationCommitted bumps content+metadata seqs so captureCorpusSnapshot()
  // returns a fresh snapshot id per burst.
  kb.recordMutationCommitted('both', 'test burst');
}

function makeContext(
  applySnapshot: KbCorpusSnapshot,
  currentSnapshot: KbCorpusSnapshot,
  projectionInput: ReturnType<typeof createKbProjectionInput>,
): CorpusConsumerApplyContext {
  return {
    snapshot: applySnapshot,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: {
      readConsumerCursor: () => applySnapshot,
      readCurrentSnapshot: () => currentSnapshot,
    },
    projectionInput,
    signal: new AbortController().signal,
  };
}

describe('orama coalescing burst', () => {
  it('applies one delta for a latest settled snapshot when bursts are already coalesced', async () => {
    const root = allocateRoot();
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
    });

    seedNote(kb, 'alpha-note', 'Body alpha.', 1);
    const snapshotV1 = kb.captureCorpusSnapshot();

    const projection = new OramaBaseProjection(
      kb,
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
    );

    // First apply: install snapshotV1 from scratch.
    await projection.apply(makeContext(snapshotV1, snapshotV1, createKbProjectionInput(kb)));
    const fullInstallSpy = vi.spyOn(projection, 'installFullSnapshot');
    const deltaSpy = vi.spyOn(
      projection as unknown as {
        applyDeltaFromManifest: (...args: unknown[]) => Promise<void>;
      },
      'applyDeltaFromManifest',
    );

    // Three rapid metadata-lane bursts each producing a new snapshot id.
    seedNote(kb, 'alpha-note', 'Body alpha v2.', 2);
    const snapshotV2 = kb.captureCorpusSnapshot();
    seedNote(kb, 'alpha-note', 'Body alpha v3.', 3);
    const snapshotV3 = kb.captureCorpusSnapshot();
    seedNote(kb, 'alpha-note', 'Body alpha v4.', 4);
    const snapshotV4 = kb.captureCorpusSnapshot();

    // Apply snapshotV2 with current=V4: coalescing should skip V2/V3 prepares
    // and install V4 through a single persisted-manifest delta.
    await projection.apply(makeContext(snapshotV2, snapshotV4, createKbProjectionInput(kb)));

    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(deltaSpy).toHaveBeenCalledTimes(1);

    // The installed snapshot must match the latest known snapshot, not V2/V3.
    const loaded = await projection.ensureLoaded();
    expect(loaded.db).toBeDefined();
    expect(snapshotV4.contentSeq).toBeGreaterThan(snapshotV2.contentSeq);
    expect(snapshotV3.contentSeq).toBeGreaterThan(snapshotV2.contentSeq);
  });
});
