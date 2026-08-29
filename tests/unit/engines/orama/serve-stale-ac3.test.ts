import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { OramaSearchPort } from '#src/engines/orama/search-port.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import type { OramaReconcileReason } from '#src/engines/orama/constants.js';
import type { OramaTokenizerAnalyzer } from '#src/engines/orama/document-builder.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import type { KbEngineRuntime, KbRuntime } from '#src/kb/contract.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const NOTE_SLUG = 'orama-serve-stale-ac3';
const NOTE_ENTRY_ID = noteEntryId(NOTE_SLUG);
const NOTE_BODY = 'AC3 searchable marker text for serve stale tests. 검색 토큰';

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-ac3-'));
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
    kb.notePath(NOTE_SLUG),
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
      '# Orama Serve Stale AC3',
      '',
      NOTE_BODY,
      '',
    ].join('\n'),
    'utf-8',
  );
  kb.writeIndex({
    entries: {
      [NOTE_ENTRY_ID]: buildNoteIndexEntry({
        slug: NOTE_SLUG,
        title: 'Orama Serve Stale AC3',
        tags: ['orama'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        body: NOTE_BODY,
        entrySeq: 1,
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed Orama AC3 corpus');

  return { kb, runtime };
}

function engineRuntime(kb: KbRuntime): KbEngineRuntime {
  return {
    runtimeDir: kb.runtimeDir,
    ownProjectionDir: join(kb.runtimeDir, 'orama'),
    ownProjectionStagingDir: join(kb.runtimeDir, 'orama-staging'),
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

function createSnapshotStore(kb: KbRuntime): OramaSnapshotStore {
  return new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir);
}

function createKiwiAnalyzer(): OramaTokenizerAnalyzer {
  return {
    tokens: (raw) => [`kiwi_${raw}`],
  };
}

function createManager(analyzer: OramaTokenizerAnalyzer | null, effectiveKo: boolean): OramaAnalyzerManager {
  return {
    withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
      run({
        analyzer,
        activeAnalyzers: effectiveKo ? declaredAnalyzers : [],
      }),
    effectiveDeclaredAnalyzers: (declaredAnalyzers) => (effectiveKo ? declaredAnalyzers : []),
    currentAnalyzer: () => analyzer,
    isTerminalLoadError: () => false,
  };
}

function createLeaseOnlyManager(analyzer: OramaTokenizerAnalyzer, effectiveKo: boolean): OramaAnalyzerManager {
  return {
    withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
      run({
        analyzer,
        activeAnalyzers: effectiveKo ? declaredAnalyzers : [],
      }),
    effectiveDeclaredAnalyzers: (declaredAnalyzers) => (effectiveKo ? declaredAnalyzers : []),
    currentAnalyzer: () => null,
    isTerminalLoadError: () => false,
  };
}

async function installProjection(kb: KbRuntime, manager: OramaAnalyzerManager, runtime: Runtime): Promise<void> {
  const projection = new OramaBaseProjection(kb, createSnapshotStore(kb), {
    analyzerManager: manager,
    kiwiRuntime: runtime,
  });
  await projection.installFullSnapshot(
    kb.captureCorpusSnapshot(),
    await projection.prepareFullSnapshot(createKbProjectionInput(kb)),
  );
}

function createSearchPort(
  kb: KbRuntime,
  runtime: Runtime,
  manager: OramaAnalyzerManager,
  requestProjectionReconcile: (reason: OramaReconcileReason) => void,
  snapshotStore: OramaSnapshotStore = createSnapshotStore(kb),
): OramaSearchPort {
  const engine = engineRuntime(kb);
  return new OramaSearchPort(snapshotStore, {
    runtime: engine,
    kiwiRuntime: runtime,
    analyzerManager: manager,
    projectionIdentityInput: () =>
      createOramaProjectionIdentityInput(
        engine.declaredAnalyzers,
        manager.effectiveDeclaredAnalyzers(engine.declaredAnalyzers, runtime),
      ),
    requestProjectionReconcile,
  });
}

function currentApplyContext(kb: KbRuntime): CorpusConsumerApplyContext {
  const snapshot = kb.captureCorpusSnapshot();
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

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe('Orama AC3 serve-stale read path', () => {
  it('routes projection reconcile through the injected callback without persisting on the read path', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(null, false), runtime);
    const intlIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);

    const requestedReasons: OramaReconcileReason[] = [];
    const kiwiManager = createManager(createKiwiAnalyzer(), true);
    const searchStore = createSnapshotStore(kb);
    const searchingProjection = new OramaBaseProjection(engineRuntime(kb), searchStore, {
      analyzerManager: kiwiManager,
      kiwiRuntime: runtime,
      requestProjectionReconcile: (reason) => {
        requestedReasons.push(reason);
      },
    });
    const persistSpy = vi.spyOn(searchStore, 'persist');
    const installFullSnapshotSpy = vi.spyOn(searchingProjection, 'installFullSnapshot');

    const result = await withTimeout(searchingProjection.search('searchable marker', 5, 'all'), 1000);

    expect(result.hits.map((hit) => hit.documentId)).toContain(NOTE_ENTRY_ID);
    expect(requestedReasons).toEqual(['stale-tier']);
    expect(persistSpy).not.toHaveBeenCalled();
    expect(installFullSnapshotSpy).not.toHaveBeenCalled();
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);
  });

  it('serves a tier-only-upgrade Intl index immediately, warns stale tier, and does not await reconcile', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(null, false), runtime);
    const intlIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);

    const requestedReasons: OramaReconcileReason[] = [];
    const kiwiManager = createManager(createKiwiAnalyzer(), true);
    const searchStore = createSnapshotStore(kb);
    const port = createSearchPort(
      kb,
      runtime,
      kiwiManager,
      (reason) => {
        requestedReasons.push(reason);
        // A reconcile request that never settles must not block the read path.
        void new Promise<never>(() => {});
      },
      searchStore,
    );

    const result = await withTimeout(port.search('searchable marker', 5, 'all'), 1000);

    expect(result.hits.map((hit) => hit.documentId)).toContain(NOTE_ENTRY_ID);
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);
    expect(port.warnings()).toContain('fts_index_stale_tier');
    expect(port.warnings()).not.toContain('fts_index_uninitialized');
    expect(requestedReasons).toEqual(['stale-tier']);

    const repeated = await withTimeout(port.search('searchable marker', 5, 'all'), 1000);

    expect(repeated.hits.map((hit) => hit.documentId)).toContain(NOTE_ENTRY_ID);
    expect(requestedReasons).toEqual(['stale-tier']);

    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    const reconciledProjection = new OramaBaseProjection(kb, searchStore, {
      analyzerManager: kiwiManager,
      kiwiRuntime: runtime,
    });
    await reconciledProjection.installFullSnapshot(
      kb.captureCorpusSnapshot(),
      await reconciledProjection.prepareFullSnapshot(createKbProjectionInput(kb)),
    );

    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(port.warnings()).not.toContain('fts_index_stale_tier');
  });

  it('serves a cold-loaded Kiwi match when the analyzer is only available from the active lease', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(createKiwiAnalyzer(), true), runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const requestedReasons: OramaReconcileReason[] = [];
    const leaseOnlyManager = createLeaseOnlyManager(createKiwiAnalyzer(), true);
    const port = createSearchPort(kb, runtime, leaseOnlyManager, (reason) => {
      requestedReasons.push(reason);
    });

    const result = await port.search('검색', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain(NOTE_ENTRY_ID);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(port.warnings()).not.toContain('fts_index_uninitialized');
    expect(port.warnings()).not.toContain('fts_index_stale_tier');
    expect(requestedReasons).toEqual([]);
  });

  it('applies a Kiwi delta when the persisted base analyzer is only available from the active lease', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(createKiwiAnalyzer(), true), runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const updatedBody = 'AC3 searchable marker text after lease delta. 갱신검색 토큰';
    writeFileSync(
      kb.notePath(NOTE_SLUG),
      [
        '---',
        'tags: [orama]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-06-20T00:00:00.000Z',
        'updatedAt: 2026-06-20T00:00:00.000Z',
        'entrySeq: 2',
        '---',
        '# Orama Serve Stale AC3',
        '',
        updatedBody,
        '',
      ].join('\n'),
      'utf-8',
    );
    kb.writeIndex({
      entries: {
        [NOTE_ENTRY_ID]: buildNoteIndexEntry({
          slug: NOTE_SLUG,
          title: 'Orama Serve Stale AC3',
          tags: ['orama'],
          principles: [],
          source: ['kangig94/coral'],
          createdAt: '2026-06-20T00:00:00.000Z',
          updatedAt: '2026-06-20T00:00:00.000Z',
          body: updatedBody,
          entrySeq: 2,
        }),
      },
      principles: {},
      entityMeta: {},
      relationships: [],
    });
    kb.recordMutationCommitted('both', 'update Orama AC3 corpus');

    const projection = new OramaBaseProjection(kb, createSnapshotStore(kb), {
      analyzerManager: createLeaseOnlyManager(createKiwiAnalyzer(), true),
      kiwiRuntime: runtime,
    });
    const fullInstallSpy = vi.spyOn(projection, 'installFullSnapshot');

    await projection.apply(currentApplyContext(kb));
    const result = await projection.search('갱신검색', 5, 'all');

    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(result.hits.map((hit) => hit.documentId)).toContain(NOTE_ENTRY_ID);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
  });

  it('refuses a cold-loaded Kiwi match without a live Kiwi analyzer and requests reconcile', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(createKiwiAnalyzer(), true), runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const requestedReasons: OramaReconcileReason[] = [];
    const unavailableKiwiManager = createManager(null, true);
    const port = createSearchPort(kb, runtime, unavailableKiwiManager, (reason) => {
      requestedReasons.push(reason);
    });

    const result = await port.search('searchable marker', 5, 'all');

    expect(result.hits).toEqual([]);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(port.warnings()).toContain('fts_index_uninitialized');
    expect(port.warnings()).not.toContain('fts_index_stale_tier');
    expect(requestedReasons).toEqual(['incompatible']);
  });

  it('serves the degraded path for a Kiwi-tier Hangul index under an Intl query tokenizer', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(createKiwiAnalyzer(), true), runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const requestedReasons: OramaReconcileReason[] = [];
    const degradedIntlManager = createManager(null, false);
    const port = createSearchPort(kb, runtime, degradedIntlManager, (reason) => {
      requestedReasons.push(reason);
    });

    const result = await port.search('검색', 5, 'all');

    expect(result.hits).toEqual([]);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(port.warnings()).toContain('fts_index_uninitialized');
    expect(port.warnings()).not.toContain('fts_index_stale_tier');
    expect(requestedReasons).toEqual(['incompatible']);
  });

  it('handles a terminal analyzer load error by requesting reconcile and retrying through the serve guard', async () => {
    const { kb, runtime } = createKbFixture();
    await installProjection(kb, createManager(createKiwiAnalyzer(), true), runtime);
    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);

    const terminalError = new Error('Kiwi terminal failure');
    let degraded = false;
    const manager: OramaAnalyzerManager = {
      withAnalyzerLease: async (_runtime, declaredAnalyzers, run) => {
        if (!degraded) {
          degraded = true;
          throw terminalError;
        }
        return run({ analyzer: null, activeAnalyzers: [] });
      },
      effectiveDeclaredAnalyzers: (declaredAnalyzers) => (degraded ? [] : declaredAnalyzers),
      currentAnalyzer: () => (degraded ? null : createKiwiAnalyzer()),
      isTerminalLoadError: (error) => error === terminalError,
    };
    const requestedReasons: OramaReconcileReason[] = [];
    const port = createSearchPort(kb, runtime, manager, (reason) => {
      requestedReasons.push(reason);
    });

    const result = await port.search('searchable marker', 5, 'all');

    expect(result.hits).toEqual([]);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(port.warnings()).toContain('fts_index_uninitialized');
    expect(requestedReasons).toEqual(['terminal-analyzer-failure', 'incompatible']);
  });
});
