import { describe, expect, it, vi } from 'vitest';

import { createNeedleArtifactPort } from '#src/engines/needle/artifact-port.js';
import {
  needleActivePointerPath,
  needleSnapshotDbPath,
  needleSnapshotDir,
  needleSnapshotManifestPath,
} from '#src/engines/needle/paths.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('NeedleArtifactPort', () => {
  it('bounds native store validation while describing projection freshness', async () => {
    const runtime = new SimulationRuntime();
    const runtimeDir = '/runtime';
    const snapshotId = 'snapshot-1';
    const snapshotDir = needleSnapshotDir(runtimeDir, snapshotId);
    const activePointerPath = needleActivePointerPath(runtimeDir);
    const storePath = needleSnapshotDbPath(runtimeDir, snapshotId);
    const manifestPath = needleSnapshotManifestPath(snapshotDir);
    const projected = {
      snapshotId,
      contentSeq: 3,
      metadataSeq: 4,
      contentManifestHash: 'content-hash',
      metadataManifestHash: 'metadata-hash',
      projectionIdentityHash: 'identity-hash',
    };
    const manifest = {
      snapshot: projected,
      specId: 'mock-small:3:l2',
      entryCount: 1,
      chunkCount: 1,
    };
    const existing = new Set([activePointerPath, snapshotDir, manifestPath, storePath]);
    const files = {
      existsSync: vi.fn((path: string) => existing.has(path)),
      readFileSync: vi.fn((path: string) => {
        if (path === activePointerPath) {
          return snapshotId;
        }
        if (path === manifestPath) {
          return JSON.stringify(manifest);
        }
        throw new Error(`unexpected read: ${path}`);
      }),
    };
    const storeFactory = vi.fn(
      () =>
        ({
          init: vi.fn(
            () =>
              new Promise<void>(() => {
                // Deliberately unresolved to exercise native validation timeout.
              }),
          ),
          stats: vi.fn(),
          getActiveSpec: vi.fn(),
          close: vi.fn(async () => {}),
        }) as never,
    );
    const port = createNeedleArtifactPort({ runtimeDir, time: runtime.time }, files, {
      addonPath: '/addon',
      expectedProjectionIdentityHash: 'identity-hash',
      storeFactory,
    });

    const descriptorsPromise = port.describeArtifacts();
    await Promise.resolve();
    runtime.time.tick(30_000);
    const descriptors = await descriptorsPromise;

    expect(storeFactory).toHaveBeenCalledOnce();
    expect(descriptors[0]?.freshness).toMatchObject({
      status: 'corrupt',
      diagnostic: expect.stringContaining('timed out after 30000ms'),
    });
  });
});
