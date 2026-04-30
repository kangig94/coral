import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOramaDb } from '#src/engines/orama/backend.js';
import { createOramaArtifactPort } from '#src/engines/orama/artifact-port.js';
import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { createNeedleArtifactPort } from '#src/engines/needle/artifact-port.js';
import { needleIndexDir } from '#src/engines/needle/paths.js';
import {
  NEEDLE_STORE_MIN_NAPI_VERSION,
  NEEDLE_STORE_SCHEMA_VERSION,
  type NeedleStore,
} from '#src/engines/needle/store.js';
import { EngineArtifactRegistry } from '#src/kb/corpus/artifact-registry.js';
import type { EngineArtifactPort } from '#src/kb/corpus/artifact-port.js';
import type { ConsumerHandle } from '#src/store/consumer-contract.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-artifact-port-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function filesPort() {
  return {
    existsSync,
    readFileSync: (path: string, encoding: 'utf-8') => readFileSync(path, encoding),
    rmSync,
    writeJsonAtomic(path: string, value: unknown) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    },
  };
}

function consumerHandle(id: string): ConsumerHandle {
  return {
    id,
    registrationKind: 'base',
    lastApplyError: null,
    async stop() {},
    async unregister() {},
    status: () => ({
      authority: 'corpus',
      corpusInterest: 'content',
      snapshotId: null,
      contentSeq: 0,
      metadataSeq: 0,
      contentManifestHash: null,
      metadataManifestHash: null,
      pending: false,
      lastApplyError: null,
    }),
  };
}

function fakeNeedleStore(specId: string): NeedleStore {
  return {
    async init() {},
    async close() {},
    async upsertChunks() {},
    async removeByEntryId() {},
    async searchVector() {
      return [];
    },
    async buildIndex() {},
    async getActiveSpec() {
      return {
        specId,
        provider: 'provider',
        model: 'model',
        dims: 4,
        normalization: 'l2',
        createdAt: '2026-04-01T00:00:00.000Z',
      };
    },
    async setActiveSpec() {},
    async stats() {
      return {
        chunkCount: 0,
        specId,
        engineName: 'fake',
        addonVersion: '0.0.0',
        napiVersion: NEEDLE_STORE_MIN_NAPI_VERSION,
        schemaVersion: NEEDLE_STORE_SCHEMA_VERSION,
      };
    },
  };
}

describe('engine artifact port blindness', () => {
  it('registry decorates normalized descriptors with scoped target consumer ids and removes them before consumer cleanup', async () => {
    const registry = new EngineArtifactRegistry();
    const scope = { [Symbol.dispose]() {} };
    const port: EngineArtifactPort = {
      async describeArtifacts() {
        return [
          {
            artifactId: 'engine:test',
            kind: 'projection-cache',
            targetConsumerIds: [],
            corpusInterest: 'content',
            artifactPaths: ['/tmp/test-artifact'],
            expectedProjectionIdentityHash: 'expected',
            freshness: { status: 'missing' },
          },
        ];
      },
    };

    registry.register(port, { targetConsumerHandles: [consumerHandle('consumer-a')] }, scope);

    expect(await registry.describeArtifacts()).toMatchObject([
      {
        artifactId: 'engine:test',
        targetConsumerIds: ['consumer-a'],
        freshness: { status: 'missing' },
      },
    ]);

    registry.unregisterScope(scope);
    expect(await registry.describeArtifacts()).toEqual([]);
  });

  it('isolates per-port faults — a throwing port does not abort the rest of the registry', async () => {
    const registry = new EngineArtifactRegistry();
    const scope = { [Symbol.dispose]() {} };
    const throwingPort: EngineArtifactPort = {
      async describeArtifacts() {
        throw new Error('synthetic engine failure');
      },
    };
    const healthyPort: EngineArtifactPort = {
      async describeArtifacts() {
        return [
          {
            artifactId: 'engine:healthy',
            kind: 'projection-cache',
            targetConsumerIds: [],
            corpusInterest: 'content',
            artifactPaths: ['/tmp/healthy-artifact'],
            expectedProjectionIdentityHash: 'expected',
            freshness: { status: 'missing' },
          },
        ];
      },
    };

    registry.register(throwingPort, { targetConsumerHandles: [consumerHandle('throwing-consumer')] }, scope);
    registry.register(healthyPort, { targetConsumerHandles: [consumerHandle('healthy-consumer')] }, scope);

    const descriptors = await registry.describeArtifacts();
    expect(descriptors).toMatchObject([
      {
        artifactId: 'engine:healthy',
        targetConsumerIds: ['healthy-consumer'],
      },
    ]);
  });

  it('Orama persists full projected identity in a sidecar and reports legacy sidecars as corrupt', async () => {
    const root = tempRoot();
    const portFiles = filesPort();
    const snapshot = {
      snapshotId: 'snapshot-a',
      contentSeq: 1,
      metadataSeq: 2,
      contentManifestHash: 'content-hash',
      metadataManifestHash: 'metadata-hash',
    };
    const store = new OramaSnapshotStore({ files: portFiles }, root);
    const { db } = await createOramaDb();
    store.persist(snapshot, db);

    const present = await createOramaArtifactPort(portFiles, root).describeArtifacts();
    expect(present[0]?.freshness).toEqual({
      status: 'present',
      projected: expect.objectContaining(snapshot),
    });

    writeFileSync(oramaIndexMetadataPath(root), `${JSON.stringify({ snapshotId: 'legacy-only' })}\n`, 'utf-8');
    const corrupt = await createOramaArtifactPort(portFiles, root).describeArtifacts();
    expect(corrupt[0]?.freshness).toMatchObject({
      status: 'corrupt',
      diagnostic: expect.stringContaining('required identity fields'),
    });
    expect(existsSync(oramaIndexPath(root))).toBe(true);
  });

  it('Needle validates ACTIVE, manifest identity, and native store spec without KB parsing engine files', async () => {
    const root = tempRoot();
    const active = join(needleIndexDir(root), 'ACTIVE');
    const snapshotDir = join(needleIndexDir(root), 'snapshots', 'snapshot-a');
    const manifestPath = join(snapshotDir, 'manifest.json');
    const storePath = join(snapshotDir, 'store.db');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(active, 'snapshot-a\n', 'utf-8');
    writeFileSync(storePath, '', 'utf-8');
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          snapshot: {
            snapshotId: 'snapshot-a',
            contentSeq: 1,
            metadataSeq: 1,
            contentManifestHash: 'content-hash',
            metadataManifestHash: 'metadata-hash',
            projectionIdentityHash: 'persisted-projection',
          },
          specId: 'spec-a',
          entryCount: 1,
          chunkCount: 2,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const present = await createNeedleArtifactPort(
      { runtimeDir: root },
      {
        addonPath: resolve(root, 'addon.node'),
        expectedProjectionIdentityHash: 'current-projection',
        storeFactory: () => fakeNeedleStore('spec-a'),
      },
    ).describeArtifacts();
    expect(present[0]?.freshness).toEqual({
      status: 'present',
      projected: expect.objectContaining({
        snapshotId: 'snapshot-a',
        projectionIdentityHash: 'persisted-projection',
      }),
    });
    expect(present[0]?.expectedProjectionIdentityHash).toBe('current-projection');

    const corrupt = await createNeedleArtifactPort(
      { runtimeDir: root },
      {
        addonPath: resolve(root, 'addon.node'),
        expectedProjectionIdentityHash: 'current-projection',
        storeFactory: () => fakeNeedleStore('other-spec'),
      },
    ).describeArtifacts();
    expect(corrupt[0]?.freshness).toMatchObject({
      status: 'corrupt',
      diagnostic: expect.stringContaining('specId'),
    });
  });

  it('KB drift detection consumes registry descriptors without hardcoded engine artifact paths', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/kb/corpus/rescan/drift.ts'), 'utf-8');

    expect(source).not.toContain('orama-index.json');
    expect(source).not.toContain('ACTIVE');
    expect(source).not.toContain('manifest.json');
    expect(source).toContain('engineArtifactRegistry.describeArtifacts()');
  });
});
