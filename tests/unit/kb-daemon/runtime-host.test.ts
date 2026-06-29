import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/constants.js';
import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import { parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { CorpusFreshnessService } from '#src/kb/corpus/freshness-service.js';
import type { Backed, FtsRetrieval } from '#src/kb/contract.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import { kbRuntimeDir } from '#src/kb/paths.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('cleans orphaned source import runtime artifacts during boot', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = kbRuntimeDir(runtime.flavor, runtime.paths.configSlot);
    const stagedDir = join(runtimeDir, 'source-import-staging');
    const pdfDir = join(runtimeDir, 'source-import-pdf');
    runtime.storage.mkdirSync(stagedDir, { recursive: true });
    runtime.storage.mkdirSync(pdfDir, { recursive: true });
    runtime.storage.writeFileSync(join(stagedDir, 'orphan.md'), '# Orphan\n');
    runtime.storage.writeFileSync(join(pdfDir, 'artifact.md'), '# Artifact\n');
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      runtime,
      db,
    });

    try {
      await host.withKb(() => undefined);

      expect(runtime.storage.existsSync(stagedDir)).toBe(false);
      expect(runtime.storage.existsSync(pdfDir)).toBe(false);
    } finally {
      await host.dispose().catch(() => undefined);
      db.close();
      rmSync(runtimeDir, { recursive: true, force: true });
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });

  it('does not block ordinary KB mutations on a preflight corpus rebuild', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = kbRuntimeDir(runtime.flavor, runtime.paths.configSlot);
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      runtime,
      db,
    });

    try {
      let ensureFreshness: ReturnType<typeof vi.spyOn> | undefined;
      let invalidateCache: ReturnType<typeof vi.spyOn> | undefined;
      await host.withKb(({ kbRuntime }) => {
        ensureFreshness = vi
          .spyOn(kbRuntime.kb, 'ensureCorpusFreshness')
          .mockRejectedValue(new Error('unexpected preflight corpus rebuild'));
        invalidateCache = vi.spyOn(kbRuntime.kb, 'invalidateKbCache');
      });

      let invoked = false;
      await expect(
        host.withKb(() => {
          invoked = true;
        }),
      ).resolves.toBeUndefined();

      expect(invoked).toBe(true);
      expect(ensureFreshness).not.toHaveBeenCalled();
      expect(invalidateCache).not.toHaveBeenCalled();
    } finally {
      await host.dispose().catch(() => undefined);
      db.close();
      rmSync(runtimeDir, { recursive: true, force: true });
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });

  it('does not block write runtime initialization on corpus rebuild or consumer drain', async () => {
    const root = createTempRoot();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const pluginRoot = join(root, 'plugin');
    const runtimeDir = kbRuntimeDir(runtime.flavor, runtime.paths.configSlot);
    const delayedIndex: KbIndex = { entries: {}, principles: {}, entityMeta: {}, relationships: [] };
    const ensureFreshness = vi
      .spyOn(CorpusFreshnessService.prototype, 'ensureCorpusFreshness')
      .mockImplementation(
        () =>
          new Promise<KbIndex>((resolve) => {
            setTimeout(() => resolve(delayedIndex), 50);
          }),
      );
    const drainAll = vi
      .spyOn(ConsumerDriver.prototype, 'drainAll')
      .mockRejectedValue(new Error('unexpected boot consumer drain'));
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
      runtime,
      db,
    });

    try {
      const result = await Promise.race([
        host.withKb(() => 'ready'),
        new Promise<'blocked'>((resolve) => {
          setTimeout(() => resolve('blocked'), 10);
        }),
      ]);

      expect(result).toBe('ready');
      expect(drainAll).not.toHaveBeenCalled();
    } finally {
      if (ensureFreshness.mock.calls.length > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
      }
      await host.dispose().catch(() => undefined);
      db.close();
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
    const runtimeDir = kbRuntimeDir(runtime.flavor, runtime.paths.configSlot);
    const sourcePath = join(projectRoot, 'paper.md');
    writeImportSource(runtime, sourcePath);
    const host = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
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
        { projectRoot, pluginRoot, coralEnv: {}, principal: testProjectPrincipal(projectRoot) },
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
          { projectRoot, pluginRoot, coralEnv: {}, principal: testProjectPrincipal(projectRoot) },
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
    const runtimeDir = kbRuntimeDir(runtime.flavor, runtime.paths.configSlot);
    const sourcePath = join(projectRoot, 'repair.md');
    writeImportSource(runtime, sourcePath);
    const firstHost = createKbDaemonWriteRuntimeHost({
      pluginRoot,
      backendNamespace: 'test-namespace',
      bundleHash: 'test-bundle',
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
        { projectRoot, pluginRoot, coralEnv: {}, principal: testProjectPrincipal(projectRoot) },
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
