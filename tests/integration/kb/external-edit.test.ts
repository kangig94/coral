import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { noteEntryId, sourceEntryId } from '#src/kb/entry-types.js';
import { nowDate } from '#src/infra/time.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { persistCorpusState, readCorpusState } from '#src/kb/state/corpus-state.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { bindEmbedding, bindOramaFtsForTest, type OramaFtsBinding } from '#tests/unit/kb/expansion-test-helpers.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

type StoredOramaDocument = {
  title: string;
  body: string;
  contentHash: string;
  metadataHash: string;
};

type BaseProjectionSpyTarget = {
  oramaBinding: OramaFtsBinding;
};

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];
const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof openKbTestStoreDb>>();

function embedText(text: string): Float32Array {
  const buckets = [0, 0, 0, 0];
  for (let index = 0; index < text.length; index += 1) {
    buckets[index % buckets.length] += text.charCodeAt(index) * (index + 1);
  }

  let magnitude = 0;
  for (const bucket of buckets) {
    magnitude += bucket * bucket;
  }

  const scale = magnitude === 0 ? 1 : 1 / Math.sqrt(magnitude);
  return Float32Array.from(buckets.map((bucket) => bucket * scale));
}

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-external-edit-'));
  tempRoots.push(root);
  return root;
}

async function createRegisteredRuntime(root: string): Promise<KbRuntime> {
  const db = openKbTestStoreDb(join(root, 'store.db'));
  const { kb } = createKbTestRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db,
  });
  writableDbByRuntime.set(kb, db);
  openDatabases.push(db);
  const ftsBinding = bindOramaFtsForTest(kb);
  (kb as unknown as BaseProjectionSpyTarget).oramaBinding = ftsBinding;
  await bindEmbedding(kb, {
    embedDocuments: async (texts) => texts.map(embedText),
    embedQuery: async (text) => embedText(text),
  });
  kb.register({
    persistCorpusState: (snapshot) =>
      persistCorpusState(writableDbByRuntime.get(kb)!, snapshot, {
        now: () => nowDate(kb.time),
      }),
    notifyCorpusMutation: () => {},
  });
  return kb;
}

async function bootLikeCoordinator(kb: KbRuntime): Promise<void> {
  await kb.retryPendingCorpusPublication();
  await kb.ensureCorpusFreshness();
  await applyBaseProjection(kb);
  await kb.retryPendingCorpusPublication();
}

async function applyBaseProjection(kb: KbRuntime): Promise<void> {
  await applyBoundCorpusConsumerForTest(kb, writableDbByRuntime.get(kb)!);
}

function persistCurrentSnapshot(kb: KbRuntime): void {
  persistCorpusState(writableDbByRuntime.get(kb)!, kb.captureCorpusSnapshot(), { now: () => nowDate(kb.time) });
  kb.invalidateCorpusStateSnapshot();
}

function touchFileAfter(path: string, thresholdMs: number): void {
  const touchedAt = new Date(thresholdMs + 1);
  utimesSync(path, touchedAt, touchedAt);
}

function renderNote({
  title,
  tags,
  body,
  entrySeq = 1,
}: {
  title: string;
  tags: string[];
  body: string;
  entrySeq?: number;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderSource({
  title,
  tags,
  body,
  entrySeq = 2,
}: {
  title: string;
  tags: string[];
  body: string;
  entrySeq?: number;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: article',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-04-01',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function seedCorpus(kb: KbRuntime): {
  notePath: string;
  sourcePath: string;
} {
  mkdirSync(kb.notesDir(), { recursive: true });
  mkdirSync(kb.sourcesDir(), { recursive: true });

  const notePath = join(kb.notesDir(), 'coral-note.md');
  writeFileSync(
    notePath,
    renderNote({
      title: 'Coral Note',
      tags: ['coral'],
      body: 'Original note body.',
    }),
    'utf-8',
  );

  const sourcePath = join(kb.sourcesDir(), 'sqlite-source.md');
  writeFileSync(
    sourcePath,
    renderSource({
      title: 'SQLite Source',
      tags: ['sqlite'],
      body: 'Original source body.',
    }),
    'utf-8',
  );

  return {
    notePath,
    sourcePath,
  };
}

async function readStoredOramaDocuments(kb: KbRuntime): Promise<Map<string, StoredOramaDocument>> {
  const orama = await new OramaSnapshotStore(
    { files: kb.projectionArtifacts.files },
    kb.projectionArtifacts.runtimeDir,
  ).loadIfPresent();
  expect(orama).not.toBeNull();
  if (orama === null) {
    throw new Error('Expected persisted Orama snapshot to exist.');
  }

  const db = orama.db as typeof orama.db & {
    documentsStore: { getAll(docs: unknown): Record<number, Record<string, unknown>> };
    data: { docs: unknown };
  };
  const docs = db.documentsStore.getAll(db.data.docs);

  return new Map(
    Object.values(docs).map((document) => [
      String(document.entryId),
      {
        title: String(document.title),
        body: String(document.body),
        contentHash: String(document.contentHash),
        metadataHash: String(document.metadataHash),
      },
    ]),
  );
}

async function bootstrapSeededCorpus(root: string): Promise<{
  kb: KbRuntime;
  notePath: string;
  sourcePath: string;
  snapshot: ReturnType<typeof readCorpusState>;
  docs: Map<string, StoredOramaDocument>;
}>;
async function bootstrapSeededCorpus(
  root: string,
  seedExtra: (kb: KbRuntime) => void,
): Promise<{
  kb: KbRuntime;
  notePath: string;
  sourcePath: string;
  snapshot: ReturnType<typeof readCorpusState>;
  docs: Map<string, StoredOramaDocument>;
}>;
async function bootstrapSeededCorpus(
  root: string,
  seedExtra?: (kb: KbRuntime) => void,
): Promise<{
  kb: KbRuntime;
  notePath: string;
  sourcePath: string;
  snapshot: ReturnType<typeof readCorpusState>;
  docs: Map<string, StoredOramaDocument>;
}> {
  const kb = await createRegisteredRuntime(root);
  const paths = seedCorpus(kb);
  seedExtra?.(kb);
  await bootLikeCoordinator(kb);
  persistCurrentSnapshot(kb);
  return {
    kb,
    ...paths,
    snapshot: readCorpusState(writableDbByRuntime.get(kb)!),
    docs: await readStoredOramaDocuments(kb),
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const db of openDatabases.splice(0).reverse()) {
    try {
      db.close();
    } catch {
      // Ignore cleanup races from handles that were already closed during the test.
    }
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('external edit absorption', () => {
  it('bumps only content_seq for a source title edit after restart', async () => {
    const root = allocateRoot();
    const initial = await bootstrapSeededCorpus(root);
    const beforeSource = initial.docs.get(sourceEntryId('sqlite-source'));
    const initialIndexMtime = statSync(join(root, 'index.json')).mtimeMs;
    expect(beforeSource).toBeDefined();

    writableDbByRuntime.get(initial.kb)!.close();

    writeFileSync(
      initial.sourcePath,
      renderSource({
        title: 'SQLite Source Updated',
        tags: ['sqlite'],
        body: 'Original source body.',
      }),
      'utf-8',
    );
    touchFileAfter(initial.sourcePath, initialIndexMtime);

    const restarted = await createRegisteredRuntime(root);
    await bootLikeCoordinator(restarted);

    const afterSnapshot = readCorpusState(writableDbByRuntime.get(restarted)!);
    const afterSource = (await readStoredOramaDocuments(restarted)).get(sourceEntryId('sqlite-source'));

    expect(afterSnapshot.contentSeq).toBe(initial.snapshot.contentSeq + 1);
    expect(afterSnapshot.metadataSeq).toBe(initial.snapshot.metadataSeq);
    expect(afterSnapshot.contentManifestHash).not.toBe(initial.snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).toBe(initial.snapshot.metadataManifestHash);
    expect(afterSource?.title).toBe('SQLite Source Updated');
    expect(afterSource?.contentHash).not.toBe(beforeSource?.contentHash);
    expect(afterSource?.metadataHash).toBe(beforeSource?.metadataHash);
    expect(restarted.readIndexState().textStaleReason).toBeUndefined();
  });

  it('bumps only metadata_seq for a non-title source frontmatter edit after restart', async () => {
    const root = allocateRoot();
    const initial = await bootstrapSeededCorpus(root);
    const beforeSource = initial.docs.get(sourceEntryId('sqlite-source'));
    const initialIndexMtime = statSync(join(root, 'index.json')).mtimeMs;
    expect(beforeSource).toBeDefined();

    writableDbByRuntime.get(initial.kb)!.close();

    writeFileSync(
      initial.sourcePath,
      renderSource({
        title: 'SQLite Source',
        tags: ['sqlite', 'metadata-only'],
        body: 'Original source body.',
      }),
      'utf-8',
    );
    touchFileAfter(initial.sourcePath, initialIndexMtime);

    const restarted = await createRegisteredRuntime(root);
    await bootLikeCoordinator(restarted);

    const afterSnapshot = readCorpusState(writableDbByRuntime.get(restarted)!);
    const afterSource = (await readStoredOramaDocuments(restarted)).get(sourceEntryId('sqlite-source'));

    expect(afterSnapshot.contentSeq).toBe(initial.snapshot.contentSeq);
    expect(afterSnapshot.metadataSeq).toBe(initial.snapshot.metadataSeq + 1);
    expect(afterSnapshot.contentManifestHash).toBe(initial.snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).not.toBe(initial.snapshot.metadataManifestHash);
    expect(afterSource?.contentHash).toBe(beforeSource?.contentHash);
    expect(afterSource?.metadataHash).not.toBe(beforeSource?.metadataHash);
    expect(restarted.readIndexState().textStaleReason).toBeUndefined();
  });

  it('reapplies Orama through the base CorpusConsumer for live note body edits', async () => {
    const root = allocateRoot();
    const initial = await bootstrapSeededCorpus(root);
    const beforeNote = initial.docs.get(noteEntryId('coral-note'));
    expect(beforeNote).toBeDefined();

    await initial.kb.runInboundSync(async () => {
      writeFileSync(
        initial.notePath,
        renderNote({
          title: 'Coral Note',
          tags: ['coral'],
          body: 'Inbound sync replaced the note body.',
        }),
        'utf-8',
      );
    });
    await initial.kb.retryPendingCorpusPublication();
    await applyBaseProjection(initial.kb);

    const afterSnapshot = readCorpusState(writableDbByRuntime.get(initial.kb)!);
    const afterNote = (await readStoredOramaDocuments(initial.kb)).get(noteEntryId('coral-note'));

    expect(afterSnapshot.contentSeq).toBe(initial.snapshot.contentSeq + 1);
    expect(afterSnapshot.metadataSeq).toBe(initial.snapshot.metadataSeq);
    expect(afterSnapshot.contentManifestHash).not.toBe(initial.snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).toBe(initial.snapshot.metadataManifestHash);
    expect(afterNote?.body).toBe('Inbound sync replaced the note body.');
    expect(afterNote?.contentHash).not.toBe(beforeNote?.contentHash);
    expect(afterNote?.metadataHash).toBe(beforeNote?.metadataHash);
    expect(initial.kb.readIndexState().textStaleReason).toBeUndefined();
  });
});
