import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import {
  insertProviderOperation,
  providerOperationMutationAdmission,
  ProviderOperationMutationAdmission,
} from '#src/store/provider-operation-journal.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createHandoffCoresHarness } from './handoff-cores-harness.js';

describe('coordinator startup after host reboot', () => {
  it('reaches running with an operation row and leftover v4 capsule whose entire proxy set is absent', async () => {
    const harness = createHandoffCoresHarness({ observeLiveness: () => 'absent' });
    vi.stubEnv('HOME', harness.homeDir);
    const { runtime, db } = harness;
    let elapsedMs = runtime.time.monotonicNow();
    vi.spyOn(runtime.time, 'monotonicNow').mockImplementation(() => elapsedMs);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms, options) => {
      options?.signal?.throwIfAborted();
      elapsedMs += BigInt(ms);
    });
    const readIncarnation = runtime.process.readProcessIncarnation;
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid, platform) =>
      pid === runtime.env.pid() ? readIncarnation(pid, platform) : null,
    );
    const fixture = providerOperationRecord('executing');
    const record = providerOperationRecord('executing', {
      operation: { ...fixture.operation, buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
      locator: {
        ...fixture.locator,
        guardian: { ...fixture.locator.guardian, controlEndpoint: join(harness.homeDir, 'guardian.sock') },
        reaper: { ...fixture.locator.reaper, controlEndpoint: join(harness.homeDir, 'reaper.sock') },
        proxy: { ...fixture.locator.proxy, controlEndpoint: join(harness.homeDir, 'proxy.sock') },
      },
    });
    const { operation, locator } = record;
    const capsulePath = providerHandoffCapsulePath(
      {
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: operation.buildSetId,
        hostFingerprint: locator.hostFingerprint,
        proxyInstanceId: operation.proxyInstanceId,
      },
      4,
    );
    runtime.storage.mkdirSync(dirname(capsulePath), { recursive: true });
    runtime.storage.writeAtomicDurableSync(
      capsulePath,
      JSON.stringify({
        version: 4,
        controllerBuildSetId: operation.buildSetId,
        guardianPid: locator.guardian.pid,
        guardianIncarnation: locator.guardian.incarnation,
        reaperPid: locator.reaper.pid,
        reaperIncarnation: locator.reaper.incarnation,
        proxyPid: locator.proxy.pid,
        proxyIncarnation: locator.proxy.incarnation,
        proxyProcessGroupId: locator.containment.processGroupId,
        containmentKind: locator.containment.kind,
        grantId: randomUUID(),
        secret: 'f'.repeat(64),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: operation.buildSetId,
        hostFingerprint: locator.hostFingerprint,
        guardianInstanceId: locator.guardian.instanceId,
        reaperInstanceId: locator.reaper.instanceId,
        proxyInstanceId: operation.proxyInstanceId,
        guardianControlEndpoint: locator.guardian.controlEndpoint,
        reaperControlEndpoint: locator.reaper.controlEndpoint,
        proxyEndpoint: locator.proxy.controlEndpoint,
        orphanTimeoutMs: 30_000,
        teardownReserveMs: 14_000,
      }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    const sessionId = randomUUID();
    const progressStore = new JobStore('handoff-cores', runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });
    seedTestSessionProjection(db, {
      sessionId,
      provider: 'codex',
      projectRoot: harness.homeDir,
      backendNamespace: 'handoff-cores',
      activeJobId: operation.jobId,
    });
    progressStore.appendLaunchRequested(operation.jobId, {
      jobId: operation.jobId,
      owner: { kind: 'provider-session', id: sessionId },
      sessionId,
      provider: 'codex',
      projectRoot: harness.homeDir,
      backendNamespace: 'handoff-cores',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: { prompt: 'reboot fixture', cwd: harness.homeDir, bypassPermissions: false, coralEnv: {} },
      createdAt: '2026-08-09T12:34:55.000Z',
    });
    insertProviderOperation(db, record);
    const reconcileAtStartup = ProviderOperationReconciler.prototype.reconcileAtStartup;
    // Keep the pre-#391 nested startup admission that deadlocked after a reboot.
    const reconciliation = vi
      .spyOn(ProviderOperationReconciler.prototype, 'reconcileAtStartup')
      .mockImplementation(function (this: ProviderOperationReconciler, ownership, signal) {
        return providerOperationMutationAdmission(db).run('reboot-startup', () =>
          reconcileAtStartup.call(this, ownership, signal),
        );
      });
    const closeSet = vi.spyOn(ProviderOperationMutationAdmission.prototype, 'closeSet');
    const kill = vi.spyOn(runtime.process, 'kill');

    try {
      const booted = await harness.bootCore({ instanceId: randomUUID() });

      expect(booted.core.runtimeState.getLifecycle()).toBe('running');
      expect(reconciliation).toHaveBeenCalledOnce();
      expect(await reconciliation.mock.results[0]?.value).toMatchObject({ setsVisited: 1, operationsVisited: 1 });
      expect(closeSet).toHaveBeenCalled();
      expect(closeSet.mock.results).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ kind: 'drained' }) })]),
      );
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 5_000);
});
