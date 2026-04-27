import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { noteEntryId, sourceEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { nowDate } from '#src/infra/time.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { persistCorpusState, readCorpusState } from '#src/kb/state/corpus-state.js';
import { bindEmbedding } from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

type StoredOramaDocument = {
  title: string;
  body: string;
  contentHash: string;
  metadataHash: string;
};

type BaseProjectionSpyTarget = {
  baseProjection: {
    apply: (...args: unknown[]) => Promise<void>;
  };
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

async function createRegisteredRuntime(root: string): Promise<KbRuntime> {
  const kb = createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db: createKbTestDb(root),
  });
  openDatabases.push(kb.db);
  await bindEmbedding(kb, {
    embedDocuments: async (texts) => texts.map(embedText),
    embedQuery: async (text) => embedText(text),
  });
  kb.register({
    persistCorpusState: (snapshot) => persistCorpusState(kb.db, snapshot, { now: () => nowDate(kb.time) }),
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
  await kb.fts.read().consumer.apply?.({
    snapshot: kb.captureCorpusSnapshot(),
    db: kb.db,
  });
}

function persistCurrentSnapshot(kb: KbRuntime): void {
  persistCorpusState(kb.db, kb.captureCorpusSnapshot(), { now: () => nowDate(kb.time) });
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

function renderPrinciple(statement: string): string {
  return `${statement.trim()}\n`;
}

function renderCommunity({
  title,
  members,
  summary,
  body,
}: {
  title: string;
  members: string[];
  summary: string;
  body: string;
}): string {
  return [
    '---',
    'createdAt: 2026-04-02',
    'updatedAt: 2026-04-02',
    'level: 1',
    '---',
    `# ${title}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Members',
    ...members.map((member) => `- #${member}`),
    '',
    body,
    '',
  ].join('\n');
}

function renderEntityGraph(graph: EntityGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
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
    snapshot: readCorpusState(kb.db),
    docs: await readStoredOramaDocuments(kb),
  };
}

function spyOnFullInstall(kb: KbRuntime) {
  return vi.spyOn(
    (kb as unknown as BaseProjectionSpyTarget).baseProjection,
    'apply',
  );
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

    const restarted = await createRegisteredRuntime(root);
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

    const restarted = await createRegisteredRuntime(root);
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

    const restarted = await createRegisteredRuntime(root);
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

  it('reapplies a full snapshot through the base CorpusConsumer for live principle edits', async () => {
    const root = allocateRoot();
    const principle = 'deterministic-ordering';
    const originalStatement = 'Deterministic ordering keeps index rebuilds stable.';
    const updatedStatement = 'Deterministic ordering keeps inbound sync rebuilds stable.';
    const initial = await bootstrapSeededCorpus(root, (kb) => {
      mkdirSync(kb.principlesDir(), { recursive: true });
      writeFileSync(kb.principlePath(principle), renderPrinciple(originalStatement), 'utf-8');
    });
    const installSpy = spyOnFullInstall(initial.kb);

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.principlePath(principle), renderPrinciple(originalStatement), 'utf-8');
    });
    expect(installSpy).not.toHaveBeenCalled();

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.principlePath(principle), renderPrinciple(updatedStatement), 'utf-8');
    });
    await initial.kb.retryPendingCorpusPublication();
    await applyBaseProjection(initial.kb);

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(initial.kb.readIndexState().textStaleReason).toBeUndefined();
  });

  it('reapplies a full snapshot through the base CorpusConsumer for live community edits', async () => {
    const root = allocateRoot();
    const community = 'retrieval-community';
    const seededCommunity = renderCommunity({
      title: 'Retrieval Community',
      members: ['coral-note', 'sqlite-source'],
      summary: 'Shared retrieval patterns across notes and sources.',
      body: 'Community body describing retrieval themes.',
    });
    const initial = await bootstrapSeededCorpus(root);
    mkdirSync(initial.kb.communitiesDir(), { recursive: true });
    writeFileSync(initial.kb.communityPath(community), seededCommunity, 'utf-8');
    const baselineCommunity = readFileSync(initial.kb.communityPath(community), 'utf-8');
    const updatedCommunity = `${baselineCommunity.trimEnd()}\n\nInbound sync updated the community body.\n`;
    const installSpy = spyOnFullInstall(initial.kb);

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.communityPath(community), baselineCommunity, 'utf-8');
    });
    expect(installSpy).not.toHaveBeenCalled();

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.communityPath(community), updatedCommunity, 'utf-8');
    });
    await initial.kb.retryPendingCorpusPublication();
    await applyBaseProjection(initial.kb);

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(initial.kb.readIndexState().textStaleReason).toBeUndefined();
  });

  it('reapplies a full snapshot through the base CorpusConsumer for live entity-graph edits', async () => {
    const root = allocateRoot();
    const originalGraph: EntityGraph = {
      entityMeta: {
        coral: {
          type: 'technology',
          description: 'The Coral KB runtime.',
        },
      },
      relationships: [],
    };
    const updatedGraph: EntityGraph = {
      entityMeta: {
        coral: {
          type: 'technology',
          description: 'The Coral KB runtime with inbound sync coverage.',
        },
      },
      relationships: [
        {
          source: 'coral',
          target: 'inbound-sync',
          type: 'enables',
          description: 'Coral enables inbound sync correctness checks.',
          evidence: ['note:coral-note'],
        },
      ],
    };
    const initial = await bootstrapSeededCorpus(root, (kb) => {
      writeFileSync(kb.entityGraphPath(), renderEntityGraph(originalGraph), 'utf-8');
    });
    const installSpy = spyOnFullInstall(initial.kb);

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.entityGraphPath(), renderEntityGraph(originalGraph), 'utf-8');
    });
    expect(installSpy).not.toHaveBeenCalled();

    await initial.kb.runInboundSync(async () => {
      writeFileSync(initial.kb.entityGraphPath(), renderEntityGraph(updatedGraph), 'utf-8');
    });
    await initial.kb.retryPendingCorpusPublication();
    await applyBaseProjection(initial.kb);

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(initial.kb.readIndexState().textStaleReason).toBeUndefined();
  });
});
