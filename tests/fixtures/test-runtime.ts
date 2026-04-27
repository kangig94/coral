import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import type { ExpansionHost } from '#src/expansion/contract.js';
import { createExpansionHost } from '#src/expansion/host.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';
import type { ConsumerHandle, ConsumerHandleStatus, ConsumerRegistration } from '#src/store/consumer-contract.js';
import type { Disposable } from '#src/runtime/ports.js';
import { SimulationRuntime } from '../../tools/simulation/runtime.js';

function createHandle(reg: ConsumerRegistration): ConsumerHandle {
  const status: ConsumerHandleStatus =
    reg.authority === 'corpus'
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
  makeHost: (id: string, scope: Disposable) => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (id: string, scope: Disposable) => ExpansionHost;
};
export function createTestRuntime(options: CreateTestRuntimeOptions = {}): {
  runtime: Runtime;
  kb: KbRuntime;
  registerConsumer: (reg: ConsumerRegistration) => ConsumerHandle;
  makeHost: (id: string, scope: Disposable) => ExpansionHost;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-test-'));
  const runtime = options.runtime ?? new SimulationRuntime({ roots: { coralRoot: root } });
  const kb = options.kb ?? (() => {
    const db = openStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
      schemasDir: ensureStoreSchemasDir(runtime.storage),
    });
    return createKbRuntime({
      markdownRoot: runtime.paths.coral.corpus.kbRoot,
      runtimeDir: join(root, 'kb-runtime'),
      db,
      time: runtime.time,
      ids: runtime.ids,
      env: runtime.env,
    });
  })();
  const registerConsumer = options.registerConsumer ?? ((reg: ConsumerRegistration): ConsumerHandle => createHandle(reg));
  const consumerDriver = { register: registerConsumer } as Pick<ConsumerDriver, 'register'> as ConsumerDriver;

  // Tests model fake backends as Expansions and load them through the same
  // makeHost/manifest path as production code.
  const makeHost = (id: string, scope: Disposable): ExpansionHost =>
    createExpansionHost({
      runtime,
      kb,
      scope,
      id,
      consumerDriver,
    });

  return {
    runtime,
    kb,
    registerConsumer,
    makeHost,
  };
}
