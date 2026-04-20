import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../search/embedding.js', () => ({
  createEmbeddingProvider: async () => ({
    name: 'test-embedding-provider',
    model: 'test-embedding-model',
    dims: 4,
    async embedDocuments(texts: string[]) {
      return texts.map(embedText);
    },
    async embedQuery(text: string) {
      return embedText(text);
    },
  }),
}));

import type { KbRuntime } from '../contracts.js';
import { noteEntryId, sourceEntryId } from '../entry-types.js';
import { captureKbCorpusSnapshot, createKbRuntime } from '../runtime.js';
import { persistCorpusState, readCorpusState } from '../../store/corpus-state.js';

type StoredOramaDocument = {
  title: string;
  body: string;
  contentHash: string;
  metadataHash: string;
};

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

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

function createRegisteredRuntime(root: string): KbRuntime {
  const kb = createKbRuntime({
    markdownRoot: root,
    runtimeDir: root,
  });
  openDatabases.push(kb.db);
  kb.register({
    persistCorpusState: (snapshot) => persistCorpusState(kb.db, snapshot),
    notifyCorpusMutation: () => {},
  });
  return kb;
}

async function bootLikeCoordinator(kb: KbRuntime): Promise<void> {
  await kb.retryPendingCorpusPublication();
  await kb.withMutationLock(async () => {
    kb.runEntrySeqUpgradeGuardIfNeeded();
    await kb.ensureOramaIndex();
  });
  await kb.retryPendingCorpusPublication();
}

function persistCurrentSnapshot(kb: KbRuntime): void {
  persistCorpusState(kb.db, captureKbCorpusSnapshot(kb));
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
}: {
  title: string;
  tags: string[];
  body: string;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    'entrySeq: 1',
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
}: {
  title: string;
  tags: string[];
  body: string;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: article',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-04-01',
    'entrySeq: 1',
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
  const orama = await kb.loadOramaSnapshotIfPresent();
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
}> {
  const kb = createRegisteredRuntime(root);
  const paths = seedCorpus(kb);
  await bootLikeCoordinator(kb);
  persistCurrentSnapshot(kb);
  return {
    kb,
    ...paths,
    snapshot: readCorpusState(kb.db),
    docs: await readStoredOramaDocuments(kb),
  };
}

afterEach(() => {
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

describe('external edit absorption (AC28)', () => {
  it('bumps only metadata_seq for a note frontmatter-only edit after restart', async () => {
    const root = allocateRoot();
    const initial = await bootstrapSeededCorpus(root);
    const beforeNote = initial.docs.get(noteEntryId('coral-note'));
    const initialIndexMtime = statSync(join(root, 'index.json')).mtimeMs;
    expect(beforeNote).toBeDefined();

    initial.kb.db.close();

    writeFileSync(
      initial.notePath,
      renderNote({
        title: 'Coral Note',
        tags: ['coral', 'metadata-only'],
        body: 'Original note body.',
      }),
      'utf-8',
    );
    touchFileAfter(initial.notePath, initialIndexMtime);

    const restarted = createRegisteredRuntime(root);
    await bootLikeCoordinator(restarted);

    const afterSnapshot = readCorpusState(restarted.db);
    const afterNote = (await readStoredOramaDocuments(restarted)).get(noteEntryId('coral-note'));

    expect(afterSnapshot.contentSeq).toBe(initial.snapshot.contentSeq);
    expect(afterSnapshot.metadataSeq).toBe(initial.snapshot.metadataSeq + 1);
    expect(afterSnapshot.contentManifestHash).toBe(initial.snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).not.toBe(initial.snapshot.metadataManifestHash);
    expect(afterNote?.contentHash).toBe(beforeNote?.contentHash);
    expect(afterNote?.metadataHash).not.toBe(beforeNote?.metadataHash);
    expect(restarted.readIndexState().textStaleReason).toBeUndefined();
  });

  it('bumps only content_seq for a source title edit after restart', async () => {
    const root = allocateRoot();
    const initial = await bootstrapSeededCorpus(root);
    const beforeSource = initial.docs.get(sourceEntryId('sqlite-source'));
    const initialIndexMtime = statSync(join(root, 'index.json')).mtimeMs;
    expect(beforeSource).toBeDefined();

    initial.kb.db.close();

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

    const restarted = createRegisteredRuntime(root);
    await bootLikeCoordinator(restarted);

    const afterSnapshot = readCorpusState(restarted.db);
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

    initial.kb.db.close();

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

    const restarted = createRegisteredRuntime(root);
    await bootLikeCoordinator(restarted);

    const afterSnapshot = readCorpusState(restarted.db);
    const afterSource = (await readStoredOramaDocuments(restarted)).get(sourceEntryId('sqlite-source'));

    expect(afterSnapshot.contentSeq).toBe(initial.snapshot.contentSeq);
    expect(afterSnapshot.metadataSeq).toBe(initial.snapshot.metadataSeq + 1);
    expect(afterSnapshot.contentManifestHash).toBe(initial.snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).not.toBe(initial.snapshot.metadataManifestHash);
    expect(afterSource?.contentHash).toBe(beforeSource?.contentHash);
    expect(afterSource?.metadataHash).not.toBe(beforeSource?.metadataHash);
    expect(restarted.readIndexState().textStaleReason).toBeUndefined();
  });

  it('reapplies Orama on the runInboundSync lock-held path for live note body edits', async () => {
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

    const afterSnapshot = readCorpusState(initial.kb.db);
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
