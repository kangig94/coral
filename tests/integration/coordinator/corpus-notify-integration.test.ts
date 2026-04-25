import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { createCurateScheduler, type CurateHandle } from '#src/kb/curate/scheduler.js';
import { commitMetadataTargets, commitMetadataTargetsLocked } from '#src/kb/curate/metadata-commit.js';
import { readCurateState } from '#src/kb/curate/state.js';
import { applyNoteUpdateLocked, update } from '#src/kb/ops/update.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { persistCorpusState, readCorpusState, type CorpusStateSnapshot } from '#src/kb/state/corpus-state.js';
import { ConsumerDriver, type CorpusConsumerRegistration } from '#src/coordinator/consumer-driver.js';
import { createNotifyCorpusMutation } from '#src/coordinator/corpus-notify.js';

type ObservedSnapshot = Pick<CorpusStateSnapshot, 'contentSeq' | 'metadataSeq'>;

const nodeStorage = {
  readFileSync(path: string, encoding: BufferEncoding): string {
    return readFileSync(path, encoding);
  },
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[] {
    return readdirSync(path, options);
  },
};

const BASE_CREATED_AT = '2026-04-19T00:00:00.000Z';
const BASE_UPDATED_AT = '2026-04-19T00:00:00.000Z';
const GITIGNORE_CONTENT = '# Coral KB runtime (device-local, auto-managed)\ndata/\n.obsidian/\n';

function renderNote({
  title = 'Alpha',
  updatedAt = BASE_UPDATED_AT,
  body = 'Body.',
}: {
  title?: string;
  updatedAt?: string;
  body?: string;
} = {}): string {
  return [
    '---',
    'tags: [coral]',
    'principles: []',
    'source:',
    '  - kangig94/coral',
    `createdAt: ${BASE_CREATED_AT}`,
    `updatedAt: ${updatedAt}`,
    'entrySeq: 1',
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderPrinciple(statement: string): string {
  return ['---', 'createdAt: 2026-04-19', 'updatedAt: 2026-04-19', '---', '', statement, ''].join('\n');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await wait(25);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for condition.');
}

function readCursor(db: InstanceType<typeof Database>, consumerId: string): CorpusStateSnapshot {
  const row = db
    .prepare(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM equipment_cursors
         WHERE consumer_id = ?
      `,
    )
    .get(consumerId) as
    | {
        snapshot_id: string | null;
        content_seq: number | null;
        metadata_seq: number | null;
        content_manifest_hash: string | null;
        metadata_manifest_hash: string | null;
      }
    | undefined;
  return {
    snapshotId: row?.snapshot_id ?? '',
    contentSeq: row?.content_seq ?? 0,
    metadataSeq: row?.metadata_seq ?? 0,
    contentManifestHash: row?.content_manifest_hash ?? '',
    metadataManifestHash: row?.metadata_manifest_hash ?? '',
  };
}

function snapshotSeqView(snapshot: ObservedSnapshot): ObservedSnapshot {
  return {
    contentSeq: snapshot.contentSeq,
    metadataSeq: snapshot.metadataSeq,
  };
}

function snapshotSeqViews(snapshots: readonly ObservedSnapshot[]): ObservedSnapshot[] {
  return snapshots.map(snapshotSeqView);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
}

async function settleScheduler(handle: CurateHandle): Promise<void> {
  await waitFor(() => {
    expect(handle.isRunning()).toBe(false);
  }, 5000);
}

type Harness = {
  rootDir: string;
  vaultDir: string;
  runtimeDir: string;
  db: InstanceType<typeof Database>;
  driver: ConsumerDriver;
  kb: ReturnType<typeof createKbRuntime>;
  contentCalls: ObservedSnapshot[];
  metadataCalls: ObservedSnapshot[];
  notifyCalls: CorpusStateSnapshot[];
  persistCalls: CorpusStateSnapshot[];
  failures: Array<{ stage: 'persist' | 'notify'; snapshot: CorpusStateSnapshot }>;
  cleanup(): Promise<void>;
};

async function createHarness(options?: {
  failPersist?: (snapshot: CorpusStateSnapshot, attempt: number) => boolean;
  failNotify?: (snapshot: CorpusStateSnapshot, attempt: number) => boolean;
}): Promise<Harness> {
  const rootDir = mkdtempSync(join(tmpdir(), 'corpus-notify-e2e-'));
  const vaultDir = join(rootDir, 'vault');
  const runtimeDir = join(rootDir, 'runtime');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const db = new Database(':memory:');
  applyStoreSchemas({
    db,
    storage: nodeStorage,
  });

  const driver = new ConsumerDriver({
    db,
    now: () => new Date(BASE_UPDATED_AT),
  });
  const contentCalls: ObservedSnapshot[] = [];
  const metadataCalls: ObservedSnapshot[] = [];
  const notifyCalls: CorpusStateSnapshot[] = [];
  const persistCalls: CorpusStateSnapshot[] = [];
  const failures: Array<{ stage: 'persist' | 'notify'; snapshot: CorpusStateSnapshot }> = [];
  let persistAttempt = 0;
  let notifyAttempt = 0;

  const contentConsumer: CorpusConsumerRegistration = {
    id: 'content-proj',
    authority: 'corpus',
    corpusInterest: 'content',
    async apply({ snapshot }) {
      contentCalls.push({ ...snapshot });
    },
  };
  const metadataConsumer: CorpusConsumerRegistration = {
    id: 'metadata-proj',
    authority: 'corpus',
    corpusInterest: 'metadata',
    async apply({ snapshot }) {
      metadataCalls.push({ ...snapshot });
    },
  };
  driver.register(contentConsumer);
  driver.register(metadataConsumer);

  const notifyCorpusMutation = createNotifyCorpusMutation(driver);
  const kb = createKbRuntime({
    markdownRoot: vaultDir,
    runtimeDir,
    db,
    corpusPublishCallbacks: {
      async persistCorpusState(snapshot) {
        persistAttempt += 1;
        persistCalls.push({ ...snapshot });
        if (options?.failPersist?.(snapshot, persistAttempt) === true) {
          throw new Error(`persist rejected for ${snapshot.contentSeq}/${snapshot.metadataSeq}`);
        }
        return persistCorpusState(db, snapshot, {
          now: () => new Date(BASE_UPDATED_AT),
        });
      },
      async notifyCorpusMutation(publication) {
        notifyAttempt += 1;
        notifyCalls.push({ ...publication.snapshot });
        if (options?.failNotify?.(publication.snapshot, notifyAttempt) === true) {
          throw new Error(`notify rejected for ${publication.snapshot.contentSeq}/${publication.snapshot.metadataSeq}`);
        }
        notifyCorpusMutation(publication);
      },
      onPublishFailure(failure) {
        failures.push({
          stage: failure.stage,
          snapshot: failure.snapshot,
        });
      },
    },
  });

  await kb.retryPendingCorpusPublication();
  await kb.withMutationLock(() => {
  });

  return {
    rootDir,
    vaultDir,
    runtimeDir,
    db,
    driver,
    kb,
    contentCalls,
    metadataCalls,
    notifyCalls,
    persistCalls,
    failures,
    async cleanup() {
      await driver.shutdown();
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function notePath(harness: Harness): string {
  return join(harness.vaultDir, 'notes', 'coral-alpha.md');
}

function readNoteUpdatedAt(harness: Harness): string {
  const raw = readFileSync(notePath(harness), 'utf-8');
  return /updatedAt:\s*(.+)/.exec(raw)?.[1]?.trim() ?? BASE_UPDATED_AT;
}

async function seedIndexedNote(harness: Harness): Promise<void> {
  mkdirSync(join(harness.vaultDir, 'notes'), { recursive: true });
  writeFileSync(notePath(harness), renderNote(), 'utf-8');
  await reindex(harness.kb);
}

describe('Corpus notify E2E', () => {
  it('flushes a lock-bound content mutation through kb_corpus_state and the content consumer exactly once', async () => {
    const harness = await createHarness();

    try {
      await seedIndexedNote(harness);

      await update(harness.kb, {
        note: 'coral-alpha',
        content: 'Updated body.',
      });

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 1, metadataSeq: 0 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(1);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(0);
      });

      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 1, metadataSeq: 0 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([{ contentSeq: 1, metadataSeq: 0 }]);
      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([{ contentSeq: 1, metadataSeq: 0 }]);
    } finally {
      await harness.cleanup();
    }
  });

  it('routes metadata-only mutations only to metadata-lane consumers', async () => {
    const harness = await createHarness();

    try {
      await seedIndexedNote(harness);

      await commitMetadataTargets(harness.kb, [
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 1,
          claimTimeUpdatedAt: BASE_UPDATED_AT,
          addTags: ['database'],
        },
      ]);

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 0, metadataSeq: 1 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(0);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(1);
      });

      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
    } finally {
      await harness.cleanup();
    }
  });

  it('absorbs external drift through ensureCorpusFreshness without any direct notify call', async () => {
    const harness = await createHarness();

    try {
      await seedIndexedNote(harness);

      writeFileSync(
        notePath(harness),
        renderNote({
          updatedAt: '2026-04-20T00:00:00.000Z',
          body: 'Edited outside the runtime.',
        }),
        'utf-8',
      );
      const driftMtime = new Date('2026-04-20T00:00:05.000Z');
      utimesSync(notePath(harness), driftMtime, driftMtime);

      await harness.kb.ensureCorpusFreshness();

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 0, metadataSeq: 1 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(0);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(1);
      });

      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
    } finally {
      await harness.cleanup();
    }
  });

  it('routes inbound git sync through the runtime-owned wrapper and advances only the matching lane once', async () => {
    const harness = await createHarness();
    let scheduler: CurateHandle | null = null;

    try {
      const remoteDir = join(harness.rootDir, 'remote.git');
      const remoteWorkDir = join(harness.rootDir, 'remote-work');
      mkdirSync(harness.vaultDir, { recursive: true });
      writeFileSync(join(harness.vaultDir, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');
      git(harness.vaultDir, ['init']);
      git(harness.vaultDir, ['branch', '-M', 'main']);
      git(harness.vaultDir, ['config', 'user.email', 'test@example.com']);
      git(harness.vaultDir, ['config', 'user.name', 'Test User']);
      git(harness.rootDir, ['init', '--bare', remoteDir]);
      git(harness.vaultDir, ['add', '-A']);
      git(harness.vaultDir, ['commit', '-m', 'initial']);
      git(harness.vaultDir, ['remote', 'add', 'origin', remoteDir]);
      git(harness.vaultDir, ['push', '-u', 'origin', 'main']);
      git(harness.rootDir, ['--git-dir', remoteDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

      git(harness.rootDir, ['clone', remoteDir, remoteWorkDir]);
      git(remoteWorkDir, ['config', 'user.email', 'test@example.com']);
      git(remoteWorkDir, ['config', 'user.name', 'Remote User']);
      mkdirSync(join(remoteWorkDir, 'principles'), { recursive: true });
      writeFileSync(join(remoteWorkDir, 'principles', 'remote-sync.md'), renderPrinciple('Remote principle.'), 'utf-8');
      git(remoteWorkDir, ['add', '-A']);
      git(remoteWorkDir, ['commit', '-m', 'remote principle']);
      git(remoteWorkDir, ['push', 'origin', 'main']);

      scheduler = createCurateScheduler({
        kb: harness.kb,
        spawnCli: async () => ({
          stdout: '[]',
          stderr: '',
          code: 0,
          aborted: false,
        }),
        processPort: createRealRuntime('prod').process,
        storagePort: createRealRuntime('prod').storage,
        envPort: {
          get(name: string) {
            return name === 'CORAL_KB_GIT_SYNC' ? '1' : undefined;
          },
        },
        scheduleDebounceMs: 0,
      });

      await scheduler.start();
      await settleScheduler(scheduler);

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 0, metadataSeq: 1 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(0);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(1);
      }, 5000);

      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([{ contentSeq: 0, metadataSeq: 1 }]);
    } finally {
      await scheduler?.stop();
      await harness.cleanup();
    }
  });

  it('blocks notify behind a persist rejection and preserves FIFO order on retry', async () => {
    const harness = await createHarness({
      failPersist(snapshot, attempt) {
        return snapshot.contentSeq === 1 && snapshot.metadataSeq === 0 && attempt === 1;
      },
    });

    try {
      await seedIndexedNote(harness);

      await update(harness.kb, {
        note: 'coral-alpha',
        content: 'Persist will fail once.',
      });

      await waitFor(() => {
        expect(harness.failures.map((failure) => ({ stage: failure.stage, snapshot: snapshotSeqView(failure.snapshot) }))).toEqual([
          { stage: 'persist', snapshot: { contentSeq: 1, metadataSeq: 0 } },
        ]);
      });
      expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 0, metadataSeq: 0 });
      expect(harness.notifyCalls).toEqual([]);
      expect(harness.contentCalls).toEqual([]);
      const updatedAt = readNoteUpdatedAt(harness);

      await commitMetadataTargets(harness.kb, [
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 1,
          claimTimeUpdatedAt: updatedAt,
          addTags: ['retried'],
        },
      ]);

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 1, metadataSeq: 2 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(1);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(2);
      });

      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 1, metadataSeq: 0 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps persisted kb_corpus_state authoritative when notify fails after persist', async () => {
    const harness = await createHarness({
      failNotify(snapshot, attempt) {
        return snapshot.contentSeq === 1 && snapshot.metadataSeq === 0 && attempt === 1;
      },
    });

    try {
      await seedIndexedNote(harness);

      await update(harness.kb, {
        note: 'coral-alpha',
        content: 'Notify will fail once.',
      });

      await waitFor(() => {
        expect(harness.failures.map((failure) => ({ stage: failure.stage, snapshot: snapshotSeqView(failure.snapshot) }))).toEqual([
          { stage: 'notify', snapshot: { contentSeq: 1, metadataSeq: 0 } },
        ]);
      });
      expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 1, metadataSeq: 0 });
      expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(0);
      expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(0);
      const updatedAt = readNoteUpdatedAt(harness);

      await commitMetadataTargets(harness.kb, [
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 1,
          claimTimeUpdatedAt: updatedAt,
          addTags: ['notified-later'],
        },
      ]);

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 1, metadataSeq: 2 });
        expect(readCursor(harness.db, 'content-proj').contentSeq).toBe(1);
        expect(readCursor(harness.db, 'metadata-proj').metadataSeq).toBe(2);
      });

      expect(snapshotSeqViews(harness.persistCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
      expect(snapshotSeqViews(harness.contentCalls)).toEqual([{ contentSeq: 1, metadataSeq: 0 }]);
      expect(snapshotSeqViews(harness.metadataCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it('flushes concurrent lock snapshots in acquisition order', async () => {
    const harness = await createHarness();

    try {
      await seedIndexedNote(harness);

      let releaseFirstLock!: () => void;
      const firstLockReleased = new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
      let firstMutationReady!: () => void;
      const firstMutationStarted = new Promise<void>((resolve) => {
        firstMutationReady = resolve;
      });

      const first = harness.kb.withMutationLock(async (mutation) => {
        await applyNoteUpdateLocked(harness.kb, mutation, {
          note: 'coral-alpha',
          content: 'First lock mutation.',
        });
        firstMutationReady();
        await firstLockReleased;
      });

      await firstMutationStarted;
      const updatedAt = readNoteUpdatedAt(harness);
      const second = harness.kb.withMutationLock(async (mutation) => {
        await commitMetadataTargetsLocked(
          harness.kb,
          mutation,
          [
            {
              kind: 'note',
              entryId: noteEntryId('coral-alpha'),
              slug: 'coral-alpha',
              entrySeq: 1,
              claimTimeUpdatedAt: updatedAt,
              addTags: ['queued-second'],
            },
          ],
          readCurateState(harness.kb),
        );
      });

      releaseFirstLock();
      await Promise.all([first, second]);

      await waitFor(async () => {
        await harness.driver.drainAll();
        expect(snapshotSeqView(readCorpusState(harness.db))).toEqual({ contentSeq: 1, metadataSeq: 2 });
      });

      expect(snapshotSeqViews(harness.notifyCalls)).toEqual([
        { contentSeq: 1, metadataSeq: 0 },
        { contentSeq: 1, metadataSeq: 2 },
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
