import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '../../src/store/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EngineManifest, ExpansionHost } from '#src/expansion/contract.js';
import { createExpansionHost, type ConsumerDriverPort } from '#src/expansion/host.js';
import type { KbCorpusPublishCallbacks, KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { GeneratedCommunityProjectionStore } from '#src/kb/curate/community/generated-projection-store.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime, Disposable } from '#src/runtime/ports.js';
import { openStoreDatabase } from '#src/store/db.js';
import type { ConsumerHandle, ConsumerHandleStatus, ConsumerRegistration } from '#src/store/consumer-contract.js';
import { SimulationRuntime } from '../../tools/simulation/runtime.js';

/**
 * Benign default curate assistant for KB tests: returns empty output. Tests that
 * exercise provider-launching code paths must override this explicitly so
 * accidental real launches surface as test-time mismatches, not silent successes.
 */
const TEST_CURATE_ASSISTANT_NOOP: CurateAssistantPort = {
  complete: async () => '',
};

export interface CreateTestKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  /** Daemon version stamped on KB commits; defaults to a test sentinel. */
  version?: string;
  db: Database;
  /**
   * Source for the port slots (`storage`/`processPort`/`envPort`).
   * Defaults to a fresh `SimulationRuntime`. Pass an explicit runtime when the
   * test exercises gitSync or shares state across kb instances.
   */
  runtime?: Runtime;
  corpusPublishCallbacks?: KbCorpusPublishCallbacks;
  readOnlyOrama?: boolean;
  curateAssistant?: CurateAssistantPort;
}

/**
 * Constructs a `KbRuntime` for tests, sourcing storage/process/env ports from
 * a real-FS-backed runtime by default — the kb runtime now reads corpus
 * markdown through `corpusStorage`, so tests that write fixture files via
 * `node:fs` need the port to read from the same disk. Tests pass their own
 * `runtime` to share state with surrounding fixture code or to opt into
 * `SimulationRuntime`.
 * `time`/`ids` defer to `createKbRuntime`'s `SYSTEM_TIME_PORT` / `randomUUID`
 * defaults so existing tests that rely on `vi.setSystemTime` keep working
 * without re-injecting clock ports through the helper.
 */
export function createTestKbRuntime(options: CreateTestKbRuntimeOptions): KbRuntime {
  const runtime = options.runtime ?? createRealRuntime('prod');
  return createKbRuntime({
    markdownRoot: options.markdownRoot,
    runtimeDir: options.runtimeDir,
    version: options.version ?? 'dev',
    db: options.db,
    ...(options.corpusPublishCallbacks === undefined ? {} : { corpusPublishCallbacks: options.corpusPublishCallbacks }),
    ...(options.readOnlyOrama === undefined ? {} : { readOnlyOrama: options.readOnlyOrama }),
    time: runtime.time,
    envPort: runtime.env,
    ids: runtime.ids,
    storage: runtime.storage,
    curateAssistant: options.curateAssistant ?? TEST_CURATE_ASSISTANT_NOOP,
    processPort: runtime.process,
  });
}

function createHandle(reg: ConsumerRegistration): ConsumerHandle {
  const status: ConsumerHandleStatus =
    reg.kind === 'stateless'
      ? { kind: 'stateless', pending: false }
      : reg.authority === 'corpus'
        ? {
            authority: 'corpus',
            corpusInterest: reg.corpusInterest,
            snapshotId: null,
            contentSeq: 0,
            metadataSeq: 0,
            contentManifestHash: null,
            metadataManifestHash: null,
            pending: false,
            lastApplyError: null,
          }
        : {
            authority: 'journal',
            cursor: 0,
            pending: false,
            lastApplyError: null,
          };

  return {
    id: reg.id,
    registrationKind: reg.registrationKind ?? 'base',
    lastApplyError: null,
    async stop() {},
    async unregister() {},
    status: () => status,
  };
}

export interface CreateTestRuntimeOptions {
  runtime?: Runtime;
  kb?: KbRuntime;
  registerConsumer?: (reg: ConsumerRegistration) => ConsumerHandle;
}

export function createEmptyGeneratedCommunityProjectionStore(
  options: {
    runtimeDir?: string;
    runtime?: Runtime;
  } = {},
): GeneratedCommunityProjectionStore {
  const root = options.runtimeDir ?? mkdtempSync(join(tmpdir(), 'coral-generated-community-store-'));
  const runtime = options.runtime ?? createRealRuntime('prod');
  return new GeneratedCommunityProjectionStore({
    runtimeDir: root,
    storage: runtime.storage,
    ids: runtime.ids,
    time: runtime.time,
  });
}

export function createTestRuntime(): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (manifest: EngineManifest, scope: Disposable) => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (manifest: EngineManifest, scope: Disposable) => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions = {}): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (manifest: EngineManifest, scope: Disposable) => ExpansionHost;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-test-'));
  const runtime = options.runtime ?? new SimulationRuntime({ roots: { coralRoot: root } });
  const kb =
    options.kb ??
    (() => {
      const db = openStoreDatabase({
        storeFormat: currentCoralStoreFormat(),
        path: ':memory:',
        storage: runtime.storage,
      });
      return createTestKbRuntime({
        markdownRoot: runtime.paths.coral.corpus.kbRoot,
        runtimeDir: join(root, 'kb-runtime'),
        db,
        runtime,
      });
    })();
  const registerConsumer =
    options.registerConsumer ?? ((reg: ConsumerRegistration): ConsumerHandle => createHandle(reg));
  const consumerDriver: ConsumerDriverPort = {
    register: registerConsumer,
    getJournalReader: () => ({
      readCursor: () => 0,
    }),
    getCorpusStateReader: () => ({
      readConsumerCursor: () => ({
        snapshotId: '',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      }),
      readCurrentSnapshot: () => kb.getCorpusStateSnapshot(),
    }),
  };

  // Tests model fake backends as Expansions and load them through the same
  // makeHost/manifest path as production code.
  const makeHost = (manifest: EngineManifest, scope: Disposable): ExpansionHost =>
    createExpansionHost({
      runtime,
      kb,
      roleRegistry: kb.roleRegistry,
      scope,
      manifest,
      consumerDriver,
    });

  return {
    runtime,
    kb,
    registerConsumer,
    makeHost,
  };
}
