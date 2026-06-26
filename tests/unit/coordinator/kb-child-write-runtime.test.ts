import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createKbChildWriteRuntimeHost } from '#src/coordinator/kb-child/write-runtime.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/backend.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import { parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import type { Backed, FtsRetrieval } from '#src/kb/contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';

type CorpusSnapshotRow = {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
};

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-child-write-'));
  tempRoots.push(root);
  return root;
}

function writeImportSource(runtime: Runtime, path: string): void {
  runtime.storage.mkdirSync(dirname(path), { recursive: true });
  runtime.storage.writeFileSync(
    path,
    ['# Child Projection Readiness', '', 'This source should be searchable after child import completion.', ''].join(
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

describe('KB child write runtime', () => {
  it('waits for the child Orama corpus consumer before completing source imports', async () => {
    const root = createTempRoot();
    const runtime = createRealRuntime('prod', { baseDir: root });
    const db = openTestStoreDb(runtime, ':memory:');
    const projectRoot = join(root, 'project-a');
    const pluginRoot = join(root, 'plugin');
    const sourcePath = join(projectRoot, 'paper.md');
    writeImportSource(runtime, sourcePath);
    const host = createKbChildWriteRuntimeHost({
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
          slug: 'child-projection-readiness',
          readiness: 'base-search',
          async: false,
        },
        { projectRoot, pluginRoot, coralEnv: {}, authority: 'user' },
      );
      expect(importResult).toMatchObject({
        ok: true,
        data: {
          status: 'completed',
          readiness: 'base-search',
          slug: 'child-projection-readiness',
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
          `${runtime.paths.coral.corpus.sourcesDir}/child-projection-readiness.md`,
        );
        expect(parseSourceFrontmatter(runtime.storage.readFileSync(readImportPath(importResult.data), 'utf-8'))).toEqual(
          expect.objectContaining({ title: 'Child Projection Readiness' }),
        );
      }
      expect(runtime.storage.readdirSync(runtime.paths.coral.corpus.sourcesDir)).toContain(
        'child-projection-readiness.md',
      );

      await host.withKb(async ({ kbSubsystem }) => {
        expect(Object.keys(kbSubsystem.kb.readIndexOrEmpty().entries)).toContain('source:child-projection-readiness');
        const projectionInput = await kbSubsystem.kb.corpusProjectionReader.prepareCurrentProjectionInput();
        expect(projectionInput.records.map((record) => record.entry.slug)).toContain('child-projection-readiness');
        const metadata = JSON.parse(runtime.storage.readFileSync(oramaIndexMetadataPath(kbSubsystem.kb.runtimeDir), 'utf-8')) as {
          entryManifest?: Record<string, unknown>;
        };
        expect(Object.keys(metadata.entryManifest ?? {})).toContain('source:child-projection-readiness');
        const fts = kbSubsystem.kb.capabilityRegistry
          .runtimeView()
          .read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY)
          .read();
        const result = await fts.search('searchable', 5);
        expect(result.hits.map((hit) => hit.documentId)).toContain('source:child-projection-readiness');
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
          { projectRoot, pluginRoot, coralEnv: {}, authority: 'user' },
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: 'kb_unavailable',
        message: expect.stringContaining('disposed'),
      });
    } finally {
      db.close();
      while (tempRoots.length > 0) {
        rmSync(tempRoots.pop()!, { recursive: true, force: true });
      }
    }
  });
});
