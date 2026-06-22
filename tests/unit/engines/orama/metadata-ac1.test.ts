import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORAMA_INTL_TOKENIZER_IDENTITY,
  ORAMA_PROJECTION_IDENTITY_HASH,
  ORAMA_PROJECTION_IDENTITY_SCHEMA_VERSION,
  createOramaArtifactPort,
  createOramaProjectionIdentityInput,
  hasCompleteOramaProjectionIdentityMetadata,
  oramaProjectionTokenizerTier,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection, ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/backend.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { ORAMA_SCHEMA } from '#src/engines/orama/schema.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { sha256Hex } from '#src/infra/hash.js';
import { detectProjectionArtifactLag } from '#src/kb/corpus/rescan/drift.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index-records.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime(root: string): KbRuntime {
  return createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
  });
}

function seedNote(kb: KbRuntime): KbCorpusSnapshot {
  const body = 'Projection metadata AC1 searchable marker.';
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath('projection-metadata-ac1'),
    [
      '---',
      'tags: [orama]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-20T00:00:00.000Z',
      'updatedAt: 2026-06-20T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Projection Metadata AC1',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );

  const entries: KbIndex['entries'] = {
    [noteEntryId('projection-metadata-ac1')]: buildNoteIndexEntry({
      slug: 'projection-metadata-ac1',
      title: 'Projection Metadata AC1',
      tags: ['orama'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
      body,
      entrySeq: 1,
    }),
  };

  kb.writeIndex({
    entries,
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed Orama metadata AC1 corpus');
  return kb.captureCorpusSnapshot();
}

function makeContext(kb: KbRuntime, snapshot: KbCorpusSnapshot): CorpusConsumerApplyContext {
  return {
    snapshot,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: {
      readConsumerCursor: () => snapshot,
      readCurrentSnapshot: () => snapshot,
    },
    projectionInput: createKbProjectionInput(kb),
    signal: new AbortController().signal,
  };
}

async function applyCurrentSnapshot(kb: KbRuntime): Promise<{
  readonly snapshotStore: OramaSnapshotStore;
  readonly snapshot: KbCorpusSnapshot;
}> {
  const snapshot = seedNote(kb);
  const snapshotStore = new OramaSnapshotStore(
    { files: kb.projectionArtifacts.files },
    kb.projectionArtifacts.runtimeDir,
  );
  const projection = new OramaBaseProjection(kb, snapshotStore);
  await projection.apply(makeContext(kb, snapshot));
  return { snapshotStore, snapshot };
}

function metadataPath(kb: KbRuntime): string {
  return oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir);
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(readFileSync(metadataPath(kb), 'utf-8')) as OramaProjectionMetadata;
}

function writeMetadata(kb: KbRuntime, metadata: Record<string, unknown>): void {
  writeFileSync(metadataPath(kb), `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
}

function legacyOramaProjectionIdentityHash(): string {
  return sha256Hex(
    JSON.stringify({
      schemaVersion: 2,
      schema: ORAMA_SCHEMA,
      tokenizerIdentity: ORAMA_INTL_TOKENIZER_IDENTITY,
      declaredAnalyzers: [],
      nodeVersion: process.versions.node,
      icuVersion: process.versions.icu ?? null,
    }),
  );
}

describe('Orama AC1 projection metadata', () => {
  it('parses an old sidecar, treats its tier as unknown, and detects it as projection lag', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-old-sidecar-'));
    const { snapshot } = await applyCurrentSnapshot(kb);
    const currentMetadata = readMetadata(kb);
    const oldSidecar: Record<string, unknown> = {
      ...currentMetadata,
      projectionIdentityHash: legacyOramaProjectionIdentityHash(),
    };
    for (const key of [
      'identitySchemaVersion',
      'schemaVersion',
      'schemaDigest',
      'nodeVersion',
      'icuVersion',
      'tokenizerIdentity',
      'declaredAnalyzers',
    ]) {
      delete oldSidecar[key];
    }
    writeMetadata(kb, oldSidecar);

    const loaded = await new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    ).load();

    expect(loaded.metadata).toBeDefined();
    const loadedMetadata = loaded.metadata!;
    expect(loadedMetadata.projectionIdentityHash).toBe(legacyOramaProjectionIdentityHash());
    expect(hasCompleteOramaProjectionIdentityMetadata(loadedMetadata)).toBe(false);
    expect(oramaProjectionTokenizerTier(loadedMetadata)).toBe('unknown');

    const artifactPort = createOramaArtifactPort(kb.projectionArtifacts.files, kb.projectionArtifacts.runtimeDir, []);
    const [descriptor] = await artifactPort.describeArtifacts();
    expect(descriptor).toBeDefined();
    const lag = detectProjectionArtifactLag({ getCorpusStateSnapshot: () => snapshot }, [
      { ...descriptor, targetConsumerIds: [ORAMA_BASE_CONSUMER_ID] },
    ]);

    expect(descriptor?.expectedProjectionIdentityHash).toBe(
      ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput([])),
    );
    expect(lag).toEqual([
      {
        artifactId: 'orama:projection-cache',
        targetConsumerIds: [ORAMA_BASE_CONSUMER_ID],
        diagnostic: 'projection identity differs from the currently registered projection',
      },
    ]);
  });

  it('round-trips new sidecar identity fields and installs written metadata in cache', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-new-sidecar-'));
    const { snapshotStore } = await applyCurrentSnapshot(kb);
    const sidecar = readMetadata(kb);
    const loaded = await new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    ).load();

    expect(sidecar.identitySchemaVersion).toBe(ORAMA_PROJECTION_IDENTITY_SCHEMA_VERSION);
    expect(sidecar.schemaVersion).toBe(2);
    expect(sidecar.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar.nodeVersion).toBe(process.versions.node);
    expect(sidecar.icuVersion).toBe(process.versions.icu ?? null);
    expect(sidecar.tokenizerIdentity).toBe(ORAMA_INTL_TOKENIZER_IDENTITY);
    expect(sidecar.declaredAnalyzers).toEqual([]);
    expect(hasCompleteOramaProjectionIdentityMetadata(sidecar)).toBe(true);
    expect(oramaProjectionTokenizerTier(sidecar)).toBe('intl');
    expect(loaded.metadata).toEqual(sidecar);
    expect(snapshotStore.getCache()?.metadata).toEqual(sidecar);
  });
});
