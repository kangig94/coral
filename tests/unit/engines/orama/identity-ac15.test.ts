import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import {
  ORAMA_INTL_TOKENIZER_IDENTITY,
  ORAMA_PROJECTION_IDENTITY_HASH,
  type OramaProjectionMetadata,
  createOramaArtifactPort,
  createOramaProjectionIdentityInput,
} from '#src/engines/orama/artifact-port.js';
import { KiwiAnalyzerManager, __setKiwiAnalyzerManagerForTests } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import { CORAL_KB_EXTRA_LANGS_ENV } from '#src/kb/extra-langs.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const managers: KiwiAnalyzerManager[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  __setKiwiAnalyzerManagerForTests(null);
  while (managers.length > 0) {
    await managers.pop()!.close();
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function withRuntimeEnv(runtime: Runtime, values: Readonly<Record<string, string>>): Runtime {
  const coralValues = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('CORAL_')));
  return {
    ...runtime,
    env: {
      ...runtime.env,
      get: (key) => values[key] ?? runtime.env.get(key),
      fullSnapshot: () => ({ ...runtime.env.fullSnapshot(), ...values }),
      coralSnapshot: () => ({ ...runtime.env.coralSnapshot(), ...coralValues }),
    },
  };
}

function createRuntime(root: string, runtime: Runtime): KbRuntime {
  return createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
    runtime,
  });
}

function renderNote(): string {
  return [
    '---',
    'tags: []',
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    'entrySeq: 1',
    '---',
    '# Korean Note',
    '',
    'Korean analyzer identity marker.',
    '',
  ].join('\n');
}

function seedKoreanNote(kb: KbRuntime): void {
  rmSync(kb.notesDir(), { recursive: true, force: true });
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(kb.notePath('korean-note'), renderNote(), 'utf-8');

  const entries: KbIndex['entries'] = {
    [noteEntryId('korean-note')]: buildNoteIndexEntry({
      slug: 'korean-note',
      title: 'Korean Note',
      tags: [],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      body: 'Korean analyzer identity marker.',
      entrySeq: 1,
    }),
  };

  kb.writeIndex({
    entries,
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed analyzer identity');
}

async function installFullSnapshot(kb: KbRuntime): Promise<void> {
  const projection = createOramaBaseProjection(kb);
  const prepared = await projection.prepareFullSnapshot(createKbProjectionInput(kb));
  await projection.installFullSnapshot(kb.captureCorpusSnapshot(), prepared);
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function createLoadedAnalyzer(): KiwiAnalyzer {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: 'test-kiwi',
      modelVersion: 'test-model',
      modelType: 'cong-global',
    },
    kiwi: {} as KiwiAnalyzer['kiwi'],
    tokenize: () => [],
    tokens: () => [],
    async dispose(): Promise<void> {},
  };
}

describe('Orama AC15 projection identity', () => {
  it('changes when declared analyzers, ICU, or tokenizer identity changes', () => {
    const baseInput = {
      schemaVersion: 999,
      schema: { body: 'string' },
      tokenizerIdentity: ORAMA_INTL_TOKENIZER_IDENTITY,
      declaredAnalyzers: [],
      nodeVersion: 'node-test',
      icuVersion: 'icu-test',
    };
    const baseline = ORAMA_PROJECTION_IDENTITY_HASH(baseInput);

    expect(ORAMA_PROJECTION_IDENTITY_HASH({ ...baseInput, declaredAnalyzers: ['ko'] })).not.toBe(baseline);
    expect(ORAMA_PROJECTION_IDENTITY_HASH({ ...baseInput, icuVersion: 'icu-test-2' })).not.toBe(baseline);
    expect(ORAMA_PROJECTION_IDENTITY_HASH({ ...baseInput, tokenizerIdentity: 'mock-tokenizer-v2' })).not.toBe(baseline);
  });

  it('persists projection identity from the declared analyzer env config', async () => {
    const runtime = withRuntimeEnv(createRealRuntime('prod'), { [CORAL_KB_EXTRA_LANGS_ENV]: ' Ko ' });
    const kb = createRuntime(allocateRoot('coral-orama-declared-analyzers-'), runtime);
    expect(kb.declaredAnalyzers).toEqual(['ko']);
    seedKoreanNote(kb);

    await installFullSnapshot(kb);

    const metadata = readMetadata(kb);
    expect(metadata.projectionIdentityHash).toBe(
      ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'])),
    );
    expect(Object.values(metadata.entryManifest).map((entry) => entry.documentId)).toEqual([
      noteEntryId('korean-note'),
    ]);
  });

  it('keeps expected identity stable across Kiwi unloaded and loaded states for the same declared set', async () => {
    const runtime = createRealRuntime('prod');
    const manager = new KiwiAnalyzerManager({
      idleTtlMs: 60_000,
      loadAnalyzer: async () => createLoadedAnalyzer(),
      logger: () => {},
    });
    managers.push(manager);
    __setKiwiAnalyzerManagerForTests(manager);

    const files = {
      existsSync: (_path: string) => false,
      readFileSync: (_path: string, _encoding: BufferEncoding) => {
        throw new Error('metadata should not be read for a missing projection artifact');
      },
    };
    const port = createOramaArtifactPort(files, '/tmp/coral-orama-ac15', ['ko']);

    expect(manager.status().state).toBe('unloaded');
    const [beforeLoad] = await port.describeArtifacts();
    const unloadedIdentity = beforeLoad?.expectedProjectionIdentityHash;

    await manager.withAnalyzerLease(runtime, ['ko'], () => {});

    expect(manager.status().state).toBe('loaded');
    const [afterLoad] = await port.describeArtifacts();
    const loadedIdentity = afterLoad?.expectedProjectionIdentityHash;

    expect(loadedIdentity).toBe(unloadedIdentity);
    expect(loadedIdentity).toBe(ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko'])));
  });
});
