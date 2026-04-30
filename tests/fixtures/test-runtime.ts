import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExpansionHost } from '#src/expansion/contract.js';
import { createExpansionHost, type ConsumerDriverPort } from '#src/expansion/host.js';
import type { KbCorpusPublishCallbacks, KbRuntime } from '#src/kb/contract.js';
import type { SpawnCliFn } from '#src/kb/curate/pipeline-types.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';
import type { ConsumerHandle, ConsumerHandleStatus, ConsumerRegistration } from '#src/store/consumer-contract.js';
import type { Disposable } from '#src/runtime/ports.js';
import { SimulationRuntime } from '../../tools/simulation/runtime.js';

/**
 * Benign default `spawnCli` for KB tests: returns a clean exit. Tests that exercise
 * provider-launching code paths must override this explicitly so accidental real
 * spawns surface as test-time mismatches, not silent successes.
 */
const TEST_SPAWN_CLI_NOOP: SpawnCliFn = async () => ({
  stdout: '',
  stderr: '',
  code: 0,
  aborted: false,
});

export interface CreateTestKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  db: BetterSqlite3.Database;
  /**
   * Source for the four port slots (`storage`/`spawnCli`/`processPort`/`envPort`).
   * Defaults to a fresh `SimulationRuntime`. Pass an explicit runtime when the
   * test exercises gitSync or shares state across kb instances.
   */
  runtime?: Runtime;
  corpusPublishCallbacks?: KbCorpusPublishCallbacks;
  readOnlyOrama?: boolean;
  spawnCli?: SpawnCliFn;
}

/**
 * Constructs a `KbRuntime` for tests, sourcing the four port slots
 * (`storage`, `spawnCli`, `processPort`, `envPort`) from a real-FS-backed
 * runtime by default — the kb runtime now reads corpus markdown through
 * `corpusStorage`, so tests that write fixture files via `node:fs` need the
 * port to read from the same disk. Tests pass their own `runtime` to share
 * state with surrounding fixture code or to opt into `SimulationRuntime`.
 * `time`/`ids` defer to `createKbRuntime`'s `SYSTEM_TIME_PORT` / `randomUUID`
 * defaults so existing tests that rely on `vi.setSystemTime` keep working
 * without re-injecting clock ports through the helper.
 */
export function createTestKbRuntime(options: CreateTestKbRuntimeOptions): KbRuntime {
  const runtime = options.runtime ?? createRealRuntime('prod');
  return createKbRuntime({
    markdownRoot: options.markdownRoot,
    runtimeDir: options.runtimeDir,
    db: options.db,
    ...(options.corpusPublishCallbacks === undefined ? {} : { corpusPublishCallbacks: options.corpusPublishCallbacks }),
    ...(options.readOnlyOrama === undefined ? {} : { readOnlyOrama: options.readOnlyOrama }),
    time: runtime.time,
    envPort: runtime.env,
    ids: runtime.ids,
    storage: runtime.storage,
    spawnCli: options.spawnCli ?? TEST_SPAWN_CLI_NOOP,
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

export function createTestRuntime(): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (id: string, scope: Disposable, tier?: 'bundled' | 'installed') => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (id: string, scope: Disposable, tier?: 'bundled' | 'installed') => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions = {}): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (id: string, scope: Disposable, tier?: 'bundled' | 'installed') => ExpansionHost;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-test-'));
  const runtime = options.runtime ?? new SimulationRuntime({ roots: { coralRoot: root } });
  const kb =
    options.kb ??
    (() => {
      const db = openStoreDatabase({
        path: ':memory:',
        storage: runtime.storage,
        schemasDir: ensureStoreSchemasDir(runtime.storage),
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
  const makeHost = (id: string, scope: Disposable, tier: 'bundled' | 'installed' = 'installed'): ExpansionHost =>
    createExpansionHost({
      runtime,
      kb,
      scope,
      id,
      tier,
      consumerDriver,
    });

  return {
    runtime,
    kb,
    registerConsumer,
    makeHost,
  };
}
