import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import type { OramaTokenizerAnalyzer } from '#src/engines/orama/document-builder.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import type { KbEngineRuntime, KbRuntime } from '#src/kb/contract.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const KOREAN_SLUG = 'served-tokenizer-korean';
const KOREAN_ENTRY_ID = noteEntryId(KOREAN_SLUG);
const KOREAN_BODY = '검색 토큰 스니펫';

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-ac4-'));
  tempRoots.push(root);
  return root;
}

function withKoEnv(runtime: Runtime): Runtime {
  return {
    ...runtime,
    env: {
      ...runtime.env,
      get: (key) => (key === 'CORAL_KB_EXTRA_LANGS' ? 'ko' : runtime.env.get(key)),
      fullSnapshot: () => ({ ...runtime.env.fullSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
      coralSnapshot: () => ({ ...runtime.env.coralSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
    },
  };
}

function createKbFixture(): { kb: KbRuntime; runtime: Runtime } {
  const root = allocateRoot();
  const runtime = withKoEnv(createRealRuntime('prod'));
  const kb = createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
    runtime,
  });

  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath(KOREAN_SLUG),
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
      '# Served Tokenizer Korean',
      '',
      KOREAN_BODY,
      '',
    ].join('\n'),
    'utf-8',
  );
  kb.writeIndex({
    entries: {
      [KOREAN_ENTRY_ID]: buildNoteIndexEntry({
        slug: KOREAN_SLUG,
        title: 'Served Tokenizer Korean',
        tags: ['orama'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        body: KOREAN_BODY,
        entrySeq: 1,
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed Orama AC4 corpus');

  return { kb, runtime };
}

function engineRuntime(kb: KbRuntime): KbEngineRuntime {
  return {
    runtimeDir: kb.runtimeDir,
    time: kb.time,
    ids: kb.ids,
    declaredAnalyzers: kb.declaredAnalyzers,
    projectionArtifacts: kb.projectionArtifacts,
    corpusProjectionReader: kb.corpusProjectionReader,
    capabilities: kb.capabilities,
    roleCatalog: kb.roleCatalog,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: {
      readConsumerCursor: () => kb.captureCorpusSnapshot(),
      readCurrentSnapshot: () => kb.captureCorpusSnapshot(),
    },
  };
}

function createKiwiAnalyzer(): OramaTokenizerAnalyzer {
  return {
    tokens: (raw) => [`kiwi_${raw}`],
  };
}

function createMutableManager(): {
  readonly manager: OramaAnalyzerManager;
  setAnalyzer(analyzer: OramaTokenizerAnalyzer | null): void;
} {
  let currentAnalyzer: OramaTokenizerAnalyzer | null = null;
  return {
    manager: {
      withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
        run({
          analyzer: currentAnalyzer,
          activeAnalyzers: currentAnalyzer === null ? [] : declaredAnalyzers,
        }),
      effectiveDeclaredAnalyzers: (declaredAnalyzers) => (currentAnalyzer === null ? [] : declaredAnalyzers),
      currentAnalyzer: () => currentAnalyzer,
      isTerminalLoadError: () => false,
    },
    setAnalyzer(analyzer) {
      currentAnalyzer = analyzer;
    },
  };
}

function createFixedManager(analyzer: OramaTokenizerAnalyzer): OramaAnalyzerManager {
  return {
    withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
      run({ analyzer, activeAnalyzers: declaredAnalyzers }),
    effectiveDeclaredAnalyzers: (declaredAnalyzers) => declaredAnalyzers,
    currentAnalyzer: () => analyzer,
    isTerminalLoadError: () => false,
  };
}

function createKiwiExpectedUnavailableManager(): OramaAnalyzerManager {
  return {
    withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
      run({ analyzer: null, activeAnalyzers: declaredAnalyzers }),
    effectiveDeclaredAnalyzers: (declaredAnalyzers) => declaredAnalyzers,
    currentAnalyzer: () => null,
    isTerminalLoadError: () => false,
  };
}

async function installCurrentProjection(
  kb: KbRuntime,
  manager: OramaAnalyzerManager,
  runtime: Runtime,
): Promise<OramaBaseProjection> {
  const snapshotStore = new OramaSnapshotStore(
    { files: kb.projectionArtifacts.files },
    kb.projectionArtifacts.runtimeDir,
  );
  const projection = new OramaBaseProjection(kb, snapshotStore, { analyzerManager: manager, kiwiRuntime: runtime });
  await projection.installFullSnapshot(
    kb.captureCorpusSnapshot(),
    await projection.prepareFullSnapshot(createKbProjectionInput(kb)),
  );
  return projection;
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function coldProjection(kb: KbRuntime, manager: OramaAnalyzerManager, runtime: Runtime): OramaBaseProjection {
  return new OramaBaseProjection(
    engineRuntime(kb),
    new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
    { analyzerManager: manager, kiwiRuntime: runtime },
  );
}

describe('Orama AC4 served-tier tokenization', () => {
  it('keeps a same-process cached Intl index searchable with Intl tokenization after Kiwi becomes active', async () => {
    const { kb, runtime } = createKbFixture();
    const mutable = createMutableManager();
    const projection = await installCurrentProjection(kb, mutable.manager, runtime);
    const intlIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);

    mutable.setAnalyzer(createKiwiAnalyzer());
    const result = await projection.search('검색', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain(KOREAN_ENTRY_ID);
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);
  });

  it('tokenize and tokenizeBatch use tokens matching the served Intl index during a Kiwi upgrade window', async () => {
    const { kb, runtime } = createKbFixture();
    const mutable = createMutableManager();
    const projection = await installCurrentProjection(kb, mutable.manager, runtime);

    mutable.setAnalyzer(createKiwiAnalyzer());

    await expect(projection.tokenize('검색 API')).resolves.toEqual(['검색', 'api']);
    await expect(projection.tokenizeBatch(['검색 API', '토큰'])).resolves.toEqual([['검색', 'api'], ['토큰']]);
  });

  it('cold-loads a Kiwi match with Kiwi tokenization and refuses that artifact when no live Kiwi lease exists', async () => {
    const { kb, runtime } = createKbFixture();
    const kiwiAnalyzer = createKiwiAnalyzer();
    const kiwiManager = createFixedManager(kiwiAnalyzer);
    await installCurrentProjection(kb, kiwiManager, runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const loadedWithKiwi = coldProjection(kb, kiwiManager, runtime);
    const hit = await loadedWithKiwi.search('검색', 5, 'all');
    expect(hit.hits.map((entry) => entry.documentId)).toContain(KOREAN_ENTRY_ID);
    await expect(loadedWithKiwi.tokenize('검색 API')).resolves.toEqual(['kiwi_검색', 'api']);

    const loadedWithoutKiwi = coldProjection(kb, createKiwiExpectedUnavailableManager(), runtime);
    const refused = await loadedWithoutKiwi.search('검색', 5, 'all');
    expect(refused.hits).toEqual([]);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
  });
});
