import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { RunStartupRecoveryOrchestratorFn } from '#src/coordinator/lifecycle.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';

const tempDirs: string[] = [];
const coordinators: CoordinatorCoreResult[] = [];

function createCoordinator(runStartupRecovery: RunStartupRecoveryOrchestratorFn) {
  const root = mkdtempSync(join(tmpdir(), 'coral-starting-handoff-'));
  tempDirs.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const db = openTestStoreDb(runtime, ':memory:');
  const storeServices = {
    storeDb: db,
    progressStore: new JobStore('starting-handoff-test', runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    }),
    consumerDriver: null,
  };
  const core = createCoordinatorCore(
    {
      runtime,
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: join(process.cwd(), 'clients'),
      backendNamespace: 'starting-handoff-test',
      bootSnapshot: {
        instanceId: 'starting-handoff-instance',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        log: () => {},
      },
      createStoreServicesFromDbFn: () => storeServices,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
      onFatalShutdownError: vi.fn(),
    },
    runStartupRecovery,
  );
  setStoreServicesForTest(core.storeServicesRef, storeServices);
  coordinators.push(core);
  return { core, socketPath: runtime.paths.coral.coordinator.socketPath };
}

async function requestShutdown(
  { core, socketPath }: ReturnType<typeof createCoordinator>,
  transport: 'http' | 'ipc',
): Promise<unknown> {
  if (transport === 'ipc') {
    const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: core.identity.bootToken });
    return client.shutdown({ timeoutMs: 1_000 });
  }
  const address = core.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a bound HTTP listener');
  const response = await fetch(`http://127.0.0.1:${address.port}/admin/shutdown`, {
    method: 'POST',
    headers: { 'X-Coral-Shutdown-Token': core.identity.shutdownToken },
    signal: AbortSignal.timeout(1_000),
  });
  expect(response.status).toBe(200);
  return response.json();
}

afterEach(async () => {
  for (const core of coordinators.splice(0)) {
    if (core.runtimeState.getLifecycle() !== 'stopped') await core.lifecycleController.shutdown('test-teardown');
  }
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('starting-incumbent shutdown handoff', () => {
  it.each(['http', 'ipc'] as const)(
    '%s shutdown stops a coordinator during never-settling Era II',
    async (transport) => {
      const recoveryEntered = createDeferred<AbortSignal>();
      const fixture = createCoordinator(({ signal }) => {
        recoveryEntered.resolve(signal);
        return new Promise(() => {});
      });
      const { core } = fixture;
      void core.lifecycleController.start().catch(() => {});
      const startupSignal = await recoveryEntered.promise;
      expect(core.runtimeState.getLifecycle()).toBe('kernel-ready');
      expect(startupSignal.aborted).toBe(false);

      await expect(requestShutdown(fixture, transport)).resolves.toMatchObject({ status: 'draining' });

      expect(startupSignal.aborted).toBe(true);
      await core.lifecycleController.waitForShutdown();
      expect(core.runtimeState.getLifecycle()).toBe('stopped');
    },
  );

  it.each(['http', 'ipc'] as const)('%s shutdown drains a running coordinator', async (transport) => {
    const fixture = createCoordinator(async () => []);
    const { core } = fixture;
    await core.lifecycleController.start();
    expect(core.runtimeState.getLifecycle()).toBe('running');

    core.idleTimer.beginRequest();
    try {
      await expect(requestShutdown(fixture, transport)).resolves.toMatchObject({ status: 'draining' });
      expect(core.runtimeState.getLifecycle()).toBe(transport === 'http' ? 'running' : 'draining');
    } finally {
      core.idleTimer.endRequest();
    }

    await core.lifecycleController.waitForShutdown();
    expect(core.runtimeState.getLifecycle()).toBe('stopped');
  });
});
