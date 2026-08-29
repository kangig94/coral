import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsumerDriver } from '#src/projection-consumers/index.js';
import {
  createOramaProjectionReconcileRequester,
  type OramaProjectionReconcileRuntime,
} from '#src/kb-daemon/expansion/projection-reconcile.js';
import { kiwiArtifactStateKey } from '#src/engines/kiwi/artifact.js';
import { KiwiAnalyzerManager, isKiwiAnalyzerTerminalLoadError } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  oramaProjectionTokenizerTier,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/constants.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { persistCorpusState } from '#src/kb/state/corpus-state.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { createScope } from '#src/infra/disposable-scope.js';
import { createEmptyGeneratedCommunityProjectionStore, createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import { installedKiwiArtifactState, missingKiwiArtifactState } from '#tests/helpers/kiwi-artifact-state.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];
const CONVERGENCE_SLUG = 'orama-degrade-convergence';
const CONVERGENCE_ENTRY_ID = noteEntryId(CONVERGENCE_SLUG);
const CONVERGENCE_BODY = '검색 coordinator degrade convergence marker.';

type PromiseResolvers<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

type ForcedApplyResult = {
  readonly generation: number;
  readonly consumers: readonly string[];
};

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-reconcile-'));
  tempRoots.push(root);
  return root;
}

function createSnapshot(id = 'snapshot-1'): KbCorpusSnapshot {
  return {
    snapshotId: id,
    contentSeq: 1,
    metadataSeq: 2,
    contentManifestHash: 'content-1',
    metadataManifestHash: 'metadata-2',
  };
}

function createReconcileRuntime(events: string[], snapshot = createSnapshot()): OramaProjectionReconcileRuntime {
  return {
    generatedCommunityProjectionStore: createEmptyGeneratedCommunityProjectionStore(),
    getCorpusStateSnapshot: () => {
      events.push(`snapshot:${snapshot.snapshotId}`);
      return snapshot;
    },
    invalidateTextSnapshot: (reason) => {
      events.push(`invalidate:${reason}`);
      return { contentSeq: snapshot.contentSeq, metadataSeq: snapshot.metadataSeq, textStaleReason: reason };
    },
  };
}

function createRuntime(): Runtime {
  return {
    time: {
      now: () => 1_000,
      setTimeout: (fn: () => void, ms: number) => ({ fn, ms, unref: () => {} }) as TimerHandle,
      clearTimeout: () => {},
      sleep: async () => {},
      setInterval: (fn: () => void, ms: number) => ({ fn, ms, unref: () => {} }) as TimerHandle,
      clearInterval: () => {},
    },
    paths: {
      coral: {
        engine: {
          dataDir: (name: string) => `/tmp/coral/engines/${name}`,
        },
      },
    },
  } as unknown as Runtime;
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

function createKiwiAnalyzer(): KiwiAnalyzer {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
    },
    kiwi: {} as KiwiAnalyzer['kiwi'],
    tokenize: () => [],
    tokens: (text) => [`kiwi_${text}`],
    async dispose(): Promise<void> {},
  };
}

function createKiwiAnalyzerManagerPort(manager: KiwiAnalyzerManager): OramaAnalyzerManager {
  return {
    withAnalyzerLease: (runtime, declaredAnalyzers, run) => manager.withAnalyzerLease(runtime, declaredAnalyzers, run),
    effectiveDeclaredAnalyzers: (declaredAnalyzers, runtime) =>
      manager.effectiveDeclaredAnalyzers(declaredAnalyzers, runtime),
    currentAnalyzer: () => manager.currentAnalyzer(),
    isTerminalLoadError: isKiwiAnalyzerTerminalLoadError,
  };
}

function createKbFixture(): { readonly db: Database; readonly kb: KbRuntime; readonly runtime: Runtime } {
  const root = allocateRoot();
  const runtime = withKoEnv(createRealRuntime('prod'));
  const db = createKbTestDb(join(root, '.runtime'));
  return {
    db,
    runtime,
    kb: createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db,
      runtime,
    }),
  };
}

function seedConvergenceNote(kb: KbRuntime): KbCorpusSnapshot {
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath(CONVERGENCE_SLUG),
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
      '# Orama Degrade Convergence',
      '',
      CONVERGENCE_BODY,
      '',
    ].join('\n'),
    'utf-8',
  );
  kb.writeIndex({
    entries: {
      [CONVERGENCE_ENTRY_ID]: buildNoteIndexEntry({
        slug: CONVERGENCE_SLUG,
        title: 'Orama Degrade Convergence',
        tags: ['orama'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        body: CONVERGENCE_BODY,
        entrySeq: 1,
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed Orama degrade convergence corpus');
  return kb.captureCorpusSnapshot();
}

function publishSnapshot(db: Database, kb: KbRuntime, snapshot: KbCorpusSnapshot): void {
  persistCorpusState(db, snapshot, { now: realConsumerDriverNow });
  kb.invalidateCorpusStateSnapshot();
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function readCacheMetadata(snapshotStore: OramaSnapshotStore): OramaProjectionMetadata {
  const metadata = snapshotStore.getCache()?.metadata;
  expect(metadata).toBeDefined();
  return metadata!;
}

function intlIdentityHash(): string {
  return ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
}

function kiwiIdentityHash(): string {
  return ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function withResolvers<T>(): PromiseResolvers<T> {
  return (Promise as unknown as { withResolvers<TValue>(): PromiseResolvers<TValue> }).withResolvers<T>();
}

describe('Orama coordinator reconcile ownership', () => {
  it('single-flights concurrent read-path reconcile requests above ConsumerDriver', async () => {
    const events: string[] = [];
    const forceCalls: KbCorpusSnapshot[] = [];
    const forcedApply = withResolvers<ForcedApplyResult>();
    const requester = createOramaProjectionReconcileRequester({
      kb: createReconcileRuntime(events),
      driver: {
        forceCorpusApply: (snapshot, options) => {
          events.push(`force:${options.consumers.join(',')}`);
          forceCalls.push(snapshot);
          return forcedApply.promise;
        },
      },
      log: (message) => {
        events.push(`log:${message}`);
      },
    });

    requester.requestProjectionReconcile('stale-tier');
    requester.requestProjectionReconcile('stale-tier');
    requester.requestProjectionReconcile('incompatible');
    requester.requestProjectionReconcile('terminal-analyzer-failure');
    expect(forceCalls).toEqual([]);
    await flushMicrotasks();
    requester.requestProjectionReconcile('incompatible');
    requester.requestProjectionReconcile('terminal-analyzer-failure');
    expect(forceCalls).toEqual([createSnapshot()]);
    forcedApply.resolve({ generation: 1, consumers: [ORAMA_BASE_CONSUMER_ID] });
    await requester.waitForIdle();

    expect(forceCalls).toEqual([createSnapshot()]);
    expect(events).toEqual([`snapshot:snapshot-1`, `force:${ORAMA_BASE_CONSUMER_ID}`]);
  });

  it('re-triggers a later tier change after the previous reconcile completes', async () => {
    const events: string[] = [];
    const forceCalls: KbCorpusSnapshot[] = [];
    const requester = createOramaProjectionReconcileRequester({
      kb: createReconcileRuntime(events),
      driver: {
        forceCorpusApply: (snapshot, options) => {
          events.push(`force:${options.consumers.join(',')}`);
          forceCalls.push(snapshot);
          return { generation: forceCalls.length, consumers: [...options.consumers] };
        },
      },
    });

    requester.requestProjectionReconcile('stale-tier');
    await requester.waitForIdle();
    requester.requestKiwiDegradedReconcile({
      reason: 'Kiwi model missing',
      artifactStateKey: 'missing:model',
    });
    await requester.waitForIdle();

    expect(forceCalls).toEqual([createSnapshot(), createSnapshot()]);
    expect(events).toEqual([
      'snapshot:snapshot-1',
      `force:${ORAMA_BASE_CONSUMER_ID}`,
      'invalidate:kiwi-degraded',
      'snapshot:snapshot-1',
      `force:${ORAMA_BASE_CONSUMER_ID}`,
    ]);
  });

  it('re-triggers the same stale-tier reason after the previous reconcile completes', async () => {
    const events: string[] = [];
    const forceCalls: KbCorpusSnapshot[] = [];
    const requester = createOramaProjectionReconcileRequester({
      kb: createReconcileRuntime(events),
      driver: {
        forceCorpusApply: (snapshot, options) => {
          events.push(`force:${options.consumers.join(',')}`);
          forceCalls.push(snapshot);
          return { generation: forceCalls.length, consumers: [...options.consumers] };
        },
      },
    });

    requester.requestProjectionReconcile('stale-tier');
    await requester.waitForIdle();
    requester.requestProjectionReconcile('stale-tier');
    await requester.waitForIdle();

    expect(forceCalls).toEqual([createSnapshot(), createSnapshot()]);
    expect(events).toEqual([
      'snapshot:snapshot-1',
      `force:${ORAMA_BASE_CONSUMER_ID}`,
      'snapshot:snapshot-1',
      `force:${ORAMA_BASE_CONSUMER_ID}`,
    ]);
  });

  it('invalidates text before a coordinator-owned Kiwi degrade reconcile', async () => {
    const events: string[] = [];
    const requester = createOramaProjectionReconcileRequester({
      kb: createReconcileRuntime(events),
      driver: {
        forceCorpusApply: (snapshot, options) => {
          events.push(`force:${snapshot.snapshotId}:${options.consumers.join(',')}`);
          return { generation: 1, consumers: [...options.consumers] };
        },
      },
    });

    requester.requestKiwiDegradedReconcile({
      reason: 'Kiwi model missing',
      artifactStateKey: 'missing:model',
    });
    await requester.waitForIdle();

    expect(events).toEqual([
      'invalidate:kiwi-degraded',
      'snapshot:snapshot-1',
      `force:snapshot-1:${ORAMA_BASE_CONSUMER_ID}`,
    ]);
  });

  it('converges a runtime Kiwi failure to the Intl tier without corpus mutation or restart', async () => {
    const { db, kb, runtime } = createKbFixture();
    seedConvergenceNote(kb);
    await kb.ensureCorpusFreshness({ wait: true });
    const snapshot = kb.captureCorpusSnapshot();
    publishSnapshot(db, kb, snapshot);
    let failKiwiLoad = false;
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => (failKiwiLoad ? missingKiwiArtifactState() : installedKiwiArtifactState()),
      loadAnalyzer: async () => {
        if (failKiwiLoad) {
          throw new Error('Kiwi model deleted');
        }
        return createKiwiAnalyzer();
      },
      logger: () => {},
    });
    const snapshotStore = new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    );
    const projection = new OramaBaseProjection(kb, snapshotStore, {
      analyzerManager: createKiwiAnalyzerManagerPort(manager),
      kiwiRuntime: runtime,
    });
    await projection.installFullSnapshot(snapshot, await projection.prepareFullSnapshot(createKbProjectionInput(kb)));
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentityHash());
    expect(oramaProjectionTokenizerTier(readMetadata(kb))).toBe('kiwi');

    const driver = new ConsumerDriver({
      db,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: realConsumerDriverNow,
      corpusProjectionReader: kb.corpusProjectionReader,
    });
    driver.register({
      id: projection.id,
      authority: projection.authority,
      corpusInterest: projection.corpusInterest,
      kind: projection.kind,
      registrationKind: projection.registrationKind,
      projectionSync: projection.projectionSync,
      projectionIdentityHash: () => projection.projectionIdentityHash(),
      readAuthoritativeFreshness: (target) => projection.readAuthoritativeFreshness(target),
      apply: (ctx) => projection.apply(ctx),
    });
    const requester = createOramaProjectionReconcileRequester({
      kb: {
        generatedCommunityProjectionStore: kb.generatedCommunityProjectionStore,
        getCorpusStateSnapshot: () => kb.getCorpusStateSnapshot(),
        invalidateTextSnapshot: (reason) => kb.invalidateTextSnapshot(reason),
      },
      driver,
    });
    manager.observeDegraded(createScope(), requester.requestKiwiDegradedReconcile);
    await manager.evictIdleNow();
    failKiwiLoad = true;

    const degradedSearch = await projection.search('검색', 5, 'all');
    await flushMicrotasks();
    await requester.waitForIdle();
    await driver.drainAll();

    expect(degradedSearch.hits).toEqual([]);
    expect(manager.effectiveDeclaredAnalyzers(kb.declaredAnalyzers, runtime)).toEqual([]);
    const diskMetadata = readMetadata(kb);
    const cacheMetadata = readCacheMetadata(snapshotStore);
    expect(diskMetadata.snapshotId).toBe(snapshot.snapshotId);
    expect(diskMetadata.contentSeq).toBe(snapshot.contentSeq);
    expect(diskMetadata.metadataSeq).toBe(snapshot.metadataSeq);
    expect(diskMetadata.projectionIdentityHash).toBe(intlIdentityHash());
    expect(oramaProjectionTokenizerTier(diskMetadata)).toBe('intl');
    expect(cacheMetadata.snapshotId).toBe(snapshot.snapshotId);
    expect(cacheMetadata.projectionIdentityHash).toBe(intlIdentityHash());
    const afterSnapshot = kb.captureCorpusSnapshot();
    expect(afterSnapshot.contentSeq).toBe(snapshot.contentSeq);
    expect(afterSnapshot.metadataSeq).toBe(snapshot.metadataSeq);
    expect(afterSnapshot.contentManifestHash).toBe(snapshot.contentManifestHash);
    expect(afterSnapshot.metadataManifestHash).toBe(snapshot.metadataManifestHash);
  });

  it('does not fire a Kiwi degraded observer after its scope is disposed', async () => {
    const runtime = createRuntime();
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => missingKiwiArtifactState(),
      loadAnalyzer: async () => {
        throw new Error('Kiwi model missing');
      },
      logger: () => {},
    });
    const activeScope = createScope();
    const disposedScope = createScope();
    const events: string[] = [];

    manager.observeDegraded(activeScope, (event) => {
      events.push(`active:${event.artifactStateKey}`);
    });
    manager.observeDegraded(disposedScope, (event) => {
      events.push(`disposed:${event.artifactStateKey}`);
    });
    disposedScope[Symbol.dispose]();

    try {
      await manager.withAnalyzerLease(runtime, ['ko'], () => {});
      throw new Error('expected terminal Kiwi load failure');
    } catch (error: unknown) {
      expect(isKiwiAnalyzerTerminalLoadError(error)).toBe(true);
    }
    await flushMicrotasks();

    expect(events).toEqual([`active:${kiwiArtifactStateKey(missingKiwiArtifactState())}`]);
  });

  it('isolates Kiwi degraded observer exceptions from the terminal load error path', async () => {
    const runtime = createRuntime();
    const manager = new KiwiAnalyzerManager({
      inspectArtifact: () => missingKiwiArtifactState(),
      loadAnalyzer: async () => {
        throw new Error('Kiwi model missing');
      },
      logger: () => {},
    });
    manager.observeDegraded(createScope(), () => {
      throw new Error('observer failed');
    });

    try {
      await manager.withAnalyzerLease(runtime, ['ko'], () => {});
      throw new Error('expected terminal Kiwi load failure');
    } catch (error: unknown) {
      expect(isKiwiAnalyzerTerminalLoadError(error)).toBe(true);
    }
    await flushMicrotasks();
  });
});
