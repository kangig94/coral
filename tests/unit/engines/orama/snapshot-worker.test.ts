import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RawData } from '@orama/orama';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeOramaArtifactDigest,
  createOramaEntryManifestFromArtifact,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { createOramaDb } from '#src/engines/orama/document-builder.js';
import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import {
  serializeOramaSnapshotArtifactInWorker,
  ORAMA_SNAPSHOT_SERIALIZE_WORKER_TIMEOUT_MS,
} from '#src/engines/orama/snapshot-worker.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-snapshot-worker-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function fakeRawArtifact(): RawData {
  return {
    docs: {
      docs: {
        'note:graph-rag': {
          id: 'note:graph-rag',
          entryId: 'note:graph-rag',
          contentHash: 'content-a',
          metadataHash: 'metadata-a',
          kind: 'note',
          freshness: 'fresh',
        },
      },
    },
  } as unknown as RawData;
}

function filesPort() {
  const textWrites: string[] = [];
  return {
    textWrites,
    existsSync,
    readFileSync: (path: string, encoding: 'utf-8') => readFileSync(path, encoding),
    rmSync,
    writeTextAtomic(path: string, content: string) {
      mkdirSync(dirname(path), { recursive: true });
      textWrites.push(path);
      writeFileSync(path, content, 'utf-8');
    },
    writeJsonAtomic(path: string, value: unknown) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    },
  };
}

describe('Orama snapshot artifact worker', () => {
  it('serializes artifact JSON, digest, and entry manifest off-thread', async () => {
    const artifact = fakeRawArtifact();
    const serialized = await serializeOramaSnapshotArtifactInWorker(artifact);
    const expectedRaw = `${JSON.stringify(artifact, null, 2)}\n`;

    expect(ORAMA_SNAPSHOT_SERIALIZE_WORKER_TIMEOUT_MS).toBe(60_000);
    expect(serialized.artifactRaw).toBe(expectedRaw);
    expect(serialized.artifactDigest).toBe(computeOramaArtifactDigest(expectedRaw));
    expect(serialized.entryManifest).toEqual(createOramaEntryManifestFromArtifact(artifact));
  });

  it('persists snapshot artifacts through the async worker path when text writes are available', async () => {
    const root = tempRoot();
    const files = filesPort();
    const store = new OramaSnapshotStore({ files }, root);
    const { db } = await createOramaDb();
    const snapshot = {
      snapshotId: 'snapshot-a',
      contentSeq: 1,
      metadataSeq: 2,
      contentManifestHash: 'content-hash',
      metadataManifestHash: 'metadata-hash',
    };

    const metadata = await store.persistAsync(snapshot, db, { tokenizerIdentity: 'intl-baseline' });
    const artifactRaw = readFileSync(oramaIndexPath(root), 'utf-8');
    const persistedMetadata = JSON.parse(readFileSync(oramaIndexMetadataPath(root), 'utf-8')) as OramaProjectionMetadata;

    expect(files.textWrites).toEqual([oramaIndexPath(root)]);
    expect(metadata.artifactDigest).toBe(computeOramaArtifactDigest(artifactRaw));
    expect(persistedMetadata).toEqual(metadata);
    expect(metadata).toMatchObject({
      snapshotId: 'snapshot-a',
      artifactDigest: computeOramaArtifactDigest(artifactRaw),
      entryManifest: {},
    });
  });

  it('yields once before the synchronous Orama save during async persistence', async () => {
    const root = tempRoot();
    const files = filesPort();
    const store = new OramaSnapshotStore({ files }, root);
    const { db } = await createOramaDb();
    const snapshot = {
      snapshotId: 'snapshot-yield',
      contentSeq: 1,
      metadataSeq: 2,
      contentManifestHash: 'content-hash',
      metadataManifestHash: 'metadata-hash',
    };
    let immediateObserved = false;
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateObserved = true;
        resolve();
      });
    });

    await store.persistAsync(snapshot, db, { tokenizerIdentity: 'intl-baseline' });

    expect(immediateObserved).toBe(true);
    await immediate;
  });
});
