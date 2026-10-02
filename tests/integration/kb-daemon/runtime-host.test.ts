import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/constants.js';
import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import { parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import type { Backed, FtsRetrieval } from '#src/kb/contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { resolvedStoreEpoch, STORE_EPOCH_METADATA_FILE_NAME } from '#src/store/epoch/index.js';
import {
  advanceSuccessionWriterGeneration,
  handbackSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
} from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openSettledTestStoreDb, openTestStoreDb } from '#tests/helpers/store-db.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type CorpusSnapshotRow = {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
};

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-daemon-write-'));
  tempRoots.push(root);
  return root;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function writeImportSource(runtime: Runtime, path: string): void {
  runtime.storage.mkdirSync(dirname(path), { recursive: true });
  runtime.storage.writeFileSync(
    path,
    ['# Daemon Projection Readiness', '', 'This source should be searchable after daemon import completion.', ''].join(
      '\n',
    ),
  );
}

function readOramaCursor(db: Database): CorpusSnapshotRow {
  const row = db
    .prepare<[string], CorpusSnapshotRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    )
    .get(ORAMA_BASE_CONSUMER_ID);
  if (row === undefined) {
    throw new Error('orama-base consumer cursor missing');
  }
  return row;
}

function readImportPath(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof (value as { path?: unknown }).path === 'string'
  ) {
    return (value as { path: string }).path;
  }
  throw new Error('source import result path missing');
}

describe('KB daemon runtime host', () => {
  beforeEach(() => {
    // Neutralize an ambient CORAL_KB_EXTRA_LANGS=ko so build()'s background Kiwi
    // boot fetch can never reach real ~89MB artifact downloads from a unit test,
    // regardless of the runner's shell.
    vi.stubEnv('CORAL_KB_EXTRA_LANGS', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('opens the epoch selected by its parent even when newer metadata is readable', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const storeFormat = currentCoralStoreFormat();
    for (const epoch of ['1', '3']) {
      const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, '.lock'), '');
      const db = openTestStoreDb(runtime, join(directory, 'store.db'));
      db.exec('CREATE TABLE epoch_marker (epoch TEXT NOT NULL)');
      db.prepare('INSERT INTO epoch_marker (epoch) VALUES (?)').run(epoch);
      db.close();
      writeFileSync(
        join(directory, STORE_EPOCH_METADATA_FILE_NAME),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'unavailable' },
          build: {
            version: storeFormat.productVersion,
            buildSetId: '123e4567-e89b-42d3-a456-426614174000',
            bundleHash: '0123456789abcdef',
            flavor: 'prod',
            storeFormatFingerprint: storeFormat.fingerprint,
          },
          publishedAt: '2026-09-15T00:00:00.000Z',
        }),
      );
    }
    const store = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot: join(root, 'plugin'),
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
      store,
    });

    try {
      await host.withKb(({ db }) => {
        expect(db.prepare<[], { epoch: string }>('SELECT epoch FROM epoch_marker').get()?.epoch).toBe('1');
      });
      const parking = host.parkWriterTurn();
      expect(await host.createSource({}, {} as Parameters<typeof host.createSource>[1])).toMatchObject({
        ok: false,
        code: 'succession_admission_paused',
      });
      await parking;
      expect(await host.createSource({}, {} as Parameters<typeof host.createSource>[1])).toMatchObject({
        ok: false,
        code: 'succession_admission_paused',
      });
      expect(await host.reindex({}, {} as Parameters<typeof host.reindex>[1])).toMatchObject({
        ok: false,
        code: 'succession_admission_paused',
      });
      await expect(
        host.withKb(({ db }) => db.prepare('INSERT INTO epoch_marker (epoch) VALUES (?)').run('parked')),
      ).rejects.toThrow(/parked|closed/u);
      const parkedWriter = joinSuccessionWriterGeneration(runtime, store);
      const failed = advanceSuccessionWriterGeneration(runtime, parkedWriter.generation, store);
      const handedBack = handbackSuccessionWriterGeneration(runtime, failed, store);
      host.reclaimWriterTurn(handedBack);
      await host.withKb(({ db }) => {
        db.prepare('INSERT INTO epoch_marker (epoch) VALUES (?)').run('reclaimed');
        expect(db.prepare<[], { total: number }>('SELECT count(*) AS total FROM epoch_marker').get()?.total).toBe(2);
      });
    } finally {
      await host.dispose().catch(() => undefined);
    }
  });

  it('refuses to park its writer turn while a KB job the succession inventory did not see still runs', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const storeFormat = currentCoralStoreFormat();
    const directory = join(runtime.paths.coral.store.dbDir, 'epoch-1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.lock'), '');
    openTestStoreDb(runtime, join(directory, 'store.db')).close();
    writeFileSync(
      join(directory, STORE_EPOCH_METADATA_FILE_NAME),
      JSON.stringify({
        supersedes: null,
        classification: { kind: 'unavailable' },
        build: {
          version: storeFormat.productVersion,
          buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          bundleHash: '0123456789abcdef',
          flavor: 'prod',
          storeFormatFingerprint: storeFormat.fingerprint,
        },
        publishedAt: '2026-09-15T00:00:00.000Z',
      }),
    );
    const store = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot: join(root, 'plugin'),
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
      store,
    });

    try {
      await host.withKb(() => undefined);
      vi.spyOn(AbortRegistry.prototype, 'listActive').mockReturnValue(['kb-job-started-after-preparation']);
      await expect(host.parkWriterTurn()).rejects.toThrow(/cannot park while 1 KB job/u);
      await host.withKb(({ db }) => {
        db.exec('CREATE TABLE written_after_refused_park (value TEXT)');
      });
    } finally {
      await host.dispose().catch(() => undefined);
    }
  });

  it('waits for in-flight corpus mutations before closing an owned database during dispose', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    openSettledTestStoreDb(runtime).close();
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = runtime.paths.coral.kbRuntime.root;
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
    });
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    let mutation: Promise<void> | undefined;
    let disposeSettled = false;
    let dispose: Promise<void> | undefined;
    let withMutationLock: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await host.withKb(async ({ consumerDriver, kbRuntime }) => {
        await consumerDriver.drainAll();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        withMutationLock = vi.spyOn(kbRuntime.kb, 'withMutationLock');
        mutation = kbRuntime.kb.withMutationLock(async () => {
          mutationEntered.resolve();
          await releaseMutation.promise;
          kbRuntime.readDb.prepare('SELECT 1').get();
        });
      });
      await mutationEntered.promise;

      dispose = host.dispose().then(() => {
        disposeSettled = true;
      });
      await flushMicrotasks(32);

      expect(disposeSettled).toBe(false);
      expect(withMutationLock).toHaveBeenCalledTimes(2);

      releaseMutation.resolve();
      await vi.advanceTimersByTimeAsync(50);

      if (mutation === undefined) {
        throw new Error('test mutation was not started');
      }
      await expect(mutation).resolves.toBeUndefined();
      await expect(dispose).resolves.toBeUndefined();
      expect(host.health()).toEqual({ phase: 'disposed', initializedAt: expect.any(Number) });
    } finally {
      releaseMutation.resolve();
      await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      await mutation?.catch(() => undefined);
      if (disposeSettled) {
        await host.dispose().catch(() => undefined);
      } else {
        void dispose?.catch(() => undefined);
      }
      rmSync(runtimeDir, { recursive: true, force: true });
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });

  it('waits for the daemon Orama corpus consumer before completing source imports', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const projectRoot = join(root, 'project-a');
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = runtime.paths.coral.kbRuntime.root;
    const sourcePath = join(projectRoot, 'paper.md');
    writeImportSource(runtime, sourcePath);
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
      db,
    });

    try {
      const importResult = await host.createSource(
        {
          filePath: sourcePath,
          slug: 'daemon-projection-readiness',
          readiness: 'base-search',
          async: false,
        },
        {
          projectRoot: fixtureCanonicalWorkDir(projectRoot),
          pluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
        },
      );
      expect(importResult).toMatchObject({
        ok: true,
        data: {
          status: 'completed',
          readiness: 'base-search',
          slug: 'daemon-projection-readiness',
        },
      });

      const cursor = readOramaCursor(db);
      expect(cursor.snapshot_id).toBeTruthy();
      expect(cursor.content_seq).toBeGreaterThan(0);
      expect(cursor.content_manifest_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(cursor.content_manifest_hash).not.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(importResult.ok).toBe(true);
      if (importResult.ok) {
        expect(runtime.storage.existsSync(readImportPath(importResult.data))).toBe(true);
        expect(readImportPath(importResult.data)).toBe(
          `${runtime.paths.coral.corpus.sourcesDir}/daemon-projection-readiness.md`,
        );
        expect(
          parseSourceFrontmatter(runtime.storage.readFileSync(readImportPath(importResult.data), 'utf-8')),
        ).toEqual(expect.objectContaining({ title: 'Daemon Projection Readiness' }));
      }
      expect(runtime.storage.readdirSync(runtime.paths.coral.corpus.sourcesDir)).toContain(
        'daemon-projection-readiness.md',
      );

      await host.withKb(async ({ kbRuntime }) => {
        expect(Object.keys(kbRuntime.kb.readIndexOrEmpty().entries)).toContain('source:daemon-projection-readiness');
        const projectionInput = await kbRuntime.kb.corpusProjectionReader.prepareCurrentProjectionInput();
        expect(projectionInput.records.map((record) => record.entry.slug)).toContain('daemon-projection-readiness');
        const metadata = JSON.parse(
          runtime.storage.readFileSync(oramaIndexMetadataPath(kbRuntime.kb.runtimeDir), 'utf-8'),
        ) as {
          entryManifest?: Record<string, unknown>;
        };
        expect(Object.keys(metadata.entryManifest ?? {})).toContain('source:daemon-projection-readiness');
        const fts = kbRuntime.kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).read();
        const result = await fts.search('searchable', 5);
        expect(result.hits.map((hit) => hit.documentId)).toContain('source:daemon-projection-readiness');
      });

      await host.dispose();
      expect(host.health()).toEqual({ phase: 'disposed', initializedAt: expect.any(Number) });
      await expect(
        host.createSource(
          {
            filePath: sourcePath,
            slug: 'after-dispose',
            readiness: 'commit',
            async: false,
          },
          {
            projectRoot: fixtureCanonicalWorkDir(projectRoot),
            pluginRoot,
            coralEnv: {},
            principal: testProjectPrincipal(projectRoot),
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: 'kb_unavailable',
        message: expect.stringContaining('disposed'),
      });
    } finally {
      await host.dispose().catch(() => undefined);
      db.close();
      rmSync(runtimeDir, { recursive: true, force: true });
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });

  it('repairs missing daemon Orama projection artifacts during boot', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const projectRoot = join(root, 'project-a');
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = runtime.paths.coral.kbRuntime.root;
    const sourcePath = join(projectRoot, 'repair.md');
    writeImportSource(runtime, sourcePath);
    const firstHost = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
      db,
    });

    try {
      const importResult = await firstHost.createSource(
        {
          filePath: sourcePath,
          slug: 'daemon-boot-artifact-repair',
          readiness: 'base-search',
          async: false,
        },
        {
          projectRoot: fixtureCanonicalWorkDir(projectRoot),
          pluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
        },
      );
      expect(importResult).toMatchObject({ ok: true });
      await firstHost.dispose();

      rmSync(oramaIndexPath(runtimeDir), { force: true });
      rmSync(oramaIndexMetadataPath(runtimeDir), { force: true });
      expect(runtime.storage.existsSync(oramaIndexMetadataPath(runtimeDir))).toBe(false);

      const secondHost = createKbDaemonWriteRuntimeHost({
        pluginRoot,
        backendNamespace: 'test-namespace',
        bundleHash: 'test-bundle',
        curateUsageBudget: { isExhausted: async () => false },
        runtime,
        db,
      });

      try {
        await secondHost.withKb(async ({ consumerDriver, kbRuntime }) => {
          await consumerDriver.drainAll({ timeoutMs: 5_000 });
          const metadata = JSON.parse(
            runtime.storage.readFileSync(oramaIndexMetadataPath(kbRuntime.kb.runtimeDir), 'utf-8'),
          ) as {
            entryManifest?: Record<string, unknown>;
          };
          expect(Object.keys(metadata.entryManifest ?? {})).toContain('source:daemon-boot-artifact-repair');

          const fts = kbRuntime.kb.capabilityRegistry
            .runtimeView()
            .read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY)
            .read();
          const result = await fts.search('searchable', 5);
          expect(result.hits.map((hit) => hit.documentId)).toContain('source:daemon-boot-artifact-repair');
        });
      } finally {
        await secondHost.dispose().catch(() => undefined);
      }
    } finally {
      await firstHost.dispose().catch(() => undefined);
      db.close();
      rmSync(runtimeDir, { recursive: true, force: true });
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });
});
