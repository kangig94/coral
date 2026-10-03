import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  ProviderOperationReconciler,
  StartupSetRecoveryProducer,
  PROVIDER_OPERATION_STARTUP_BOUND_MS,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import {
  insertProviderOperation,
  readProviderOperation,
  providerOperationMutationAdmission,
  ProviderOperationMutationAdmission,
} from '#src/store/provider-operation-journal.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { parseBackendHealth } from '#src/transport/http/backend/health.js';
import { statusFromParsedHealth } from '#src/cli/backend-status.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';
import type { CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import { ScenarioHttpRequest, ScenarioHttpResponse } from '#tools/simulation/scenario-http.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { createHandoffCoresHarness } from './handoff-cores-harness.js';

function rebootFixture(observation: 'absent' | 'unknown' = 'absent') {
  const harness = createHandoffCoresHarness({ observeLiveness: () => observation });
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
    pid === runtime.env.pid()
      ? readIncarnation(pid, platform)
      : observation === 'absent'
        ? null
        : record.locator.proxy.incarnation,
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
  return {
    harness,
    record,
    capsulePath,
    progressStore,
  };
}

async function readHealth(core: CoordinatorCoreResult) {
  const req = new ScenarioHttpRequest('GET', '/health?detailed=1', core.identity.token, undefined);
  req.headers['x-coral-boot-token'] = core.identity.bootToken;
  const res = new ScenarioHttpResponse();
  const pending = core.handleRequest(req as never, res as never);
  req.start();
  await pending;
  expect(res.statusCode).toBe(200);
  const parsed = parseBackendHealth(JSON.parse(res.body));
  if (parsed === null) throw new Error('detailed health was unreadable');
  return parsed;
}

describe('coordinator startup after host reboot', () => {
  it('reaches running with an operation row and leftover v4 capsule whose entire proxy set is absent', async () => {
    const { harness } = rebootFixture();
    const { runtime, db } = harness;
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

  it.each(['release', 'held', 'automatic'] as const)(
    'detaches a never-settling startup mutation and fence, then applies %s ownership',
    async (outcome) => {
      const { harness, record, capsulePath } = rebootFixture();
      vi.spyOn(harness.runtime.process, 'observeRecordedProcessAsync').mockResolvedValue('absent');
      const time = new VirtualTime(harness.runtime.time.now());
      const startedAtMs = time.now();
      const monotonicStartedAt = harness.runtime.time.monotonicNow();
      vi.spyOn(harness.runtime.time, 'now').mockImplementation(() => time.now());
      vi.spyOn(harness.runtime.time, 'monotonicNow').mockImplementation(
        () => monotonicStartedAt + BigInt(time.now() - startedAtMs),
      );
      vi.spyOn(harness.runtime.time, 'sleep').mockImplementation(async (ms, options) => {
        options?.signal?.throwIfAborted();
        time.tick(ms);
      });
      vi.spyOn(harness.runtime.time, 'clearTimeout').mockImplementation((handle) => time.clearTimeout(handle));
      vi.spyOn(harness.runtime.time, 'setInterval').mockImplementation((callback, ms) =>
        time.setInterval(callback, ms),
      );
      vi.spyOn(harness.runtime.time, 'clearInterval').mockImplementation((handle) => time.clearInterval(handle));
      const admission = () => providerOperationMutationAdmission(harness.db);
      const duePoll = vi.spyOn(ProviderOperationMutationAdmission.prototype, 'runDetached');
      let enterStartup!: () => void;
      const startupEntered = new Promise<void>((resolve) => {
        enterStartup = resolve;
      });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lateMutation = vi.fn();
      let staleWriteError: unknown;
      let core!: CoordinatorCoreResult;
      let deadline!: () => void;
      vi.spyOn(harness.runtime.time, 'setTimeout').mockImplementation((callback, delay) => {
        if (delay === PROVIDER_OPERATION_STARTUP_BOUND_MS) deadline = callback;
        return time.setTimeout(callback, delay);
      });
      const stalled = vi
        .spyOn(StartupSetRecoveryProducer.prototype, 'recoverSetAtStartup')
        .mockImplementationOnce((work) =>
          admission().run(
            'injected-startup-mutation',
            async () => {
              const fence = admission().closeSet(work.identity);
              enterStartup();
              try {
                await wait;
                try {
                  admission().runSync(
                    'late-startup-write',
                    () => {
                      lateMutation();
                    },
                    work.identity,
                  );
                } catch (error: unknown) {
                  staleWriteError = error;
                }
                return { kind: 'retry-scheduled' as const, reason: 'stale startup completion', nextAttemptAtMs: 0 };
              } finally {
                fence.release();
              }
            },
            work.identity,
          ),
        );
      let bootSettled = false;
      const boot = harness.bootCore({
        instanceId: randomUUID(),
        onCoreCreated: (created) => {
          core = created;
        },
      });
      void boot.then(
        () => {
          bootSettled = true;
        },
        () => undefined,
      );
      try {
        await startupEntered;
        expect(stalled).toHaveBeenCalledOnce();
        const starting = await readHealth(core);
        expect(starting.health.status).toBe('starting');
        const status = starting.health.diagnostics?.providerOperationStartupReconciliation;
        expect(status).toMatchObject({
          phase: 'recovering',
          boundMs: PROVIDER_OPERATION_STARTUP_BOUND_MS,
          sets: [
            expect.objectContaining({
              state: 'recovering',
              pendingMutations: expect.arrayContaining(['injected-startup-mutation']),
              pendingFences: ['provider-operation-mutation-set-fence'],
              incident: null,
            }),
          ],
        });
        const printed = formatBackendStatus(statusFromParsedHealth(starting), { kind: 'absent' }, null);
        expect(printed).toContain('injected-startup-mutation');
        expect(printed).toContain('provider-operation-mutation-set-fence');
        expect(printed).toContain(`boundMs=${PROVIDER_OPERATION_STARTUP_BOUND_MS}`);

        // Negative control: a timer wake without elapsed monotonic time cannot end the hold.
        if (outcome !== 'automatic') deadline();
        await Promise.resolve();
        expect(bootSettled).toBe(false);
        expect(core.runtimeState.getLifecycle()).toBe('kernel-ready');
        expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
        expect(harness.runtime.storage.existsSync(capsulePath)).toBe(true);

        time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS - 1);
        await setImmediate();
        expect(bootSettled).toBe(false);
        expect(core.runtimeState.getLifecycle()).toBe('kernel-ready');
        time.tick(1);
        const booted = await boot;
        expect(booted.core.runtimeState.getLifecycle()).toBe('running');
        const expired = await readHealth(core);
        expect(expired.health.diagnostics?.providerOperationStartupReconciliation).toMatchObject({
          phase: 'detached',
          elapsedMs: PROVIDER_OPERATION_STARTUP_BOUND_MS,
          sets: [
            expect.objectContaining({
              state: 'detached',
              incident: expect.stringContaining('startup-deadline-expired'),
              successor: 'detached-startup-recovery',
            }),
          ],
        });
        // Negative control: the due owner cannot compete with the detached mutator.
        time.tick(25);
        await setImmediate();
        expect(duePoll).toHaveBeenCalledWith('provider-operation-due-poll', expect.any(Function));
        await Promise.all(duePoll.mock.results.map(({ value }) => value));
        expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
        expect(harness.runtime.storage.existsSync(capsulePath)).toBe(true);
        expect(lateMutation).not.toHaveBeenCalled();
        if (outcome === 'held') {
          expect(
            formatBackendStatus(statusFromParsedHealth(await readHealth(core)), { kind: 'absent' }, null),
          ).toContain('state=detached');
          time.tick(60_000);
          await setImmediate();
          await Promise.all(duePoll.mock.results.map(({ value }) => value));
          expect(core.runtimeState.getLifecycle()).toBe('running');
          expect((await readHealth(core)).health.diagnostics?.providerOperationStartupReconciliation).toMatchObject({
            phase: 'detached',
            elapsedMs: PROVIDER_OPERATION_STARTUP_BOUND_MS + 25 + 60_000,
            sets: [
              expect.objectContaining({
                state: 'detached',
                pendingMutations: expect.arrayContaining(['injected-startup-mutation']),
              }),
            ],
          });
          expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
          return;
        }
        release();
        await stalled.mock.results[0]?.value;
        await setImmediate();
        expect(lateMutation).toHaveBeenCalledOnce();
        expect(staleWriteError).toBeUndefined();
        for (let attempt = 0; attempt < 10 && readProviderOperation(harness.db, record.operation) !== null; attempt++) {
          time.tick(2_000);
          await setImmediate();
          await Promise.all(duePoll.mock.results.map(({ value }) => value));
        }
        expect(readProviderOperation(harness.db, record.operation)).toBeNull();
        await Promise.all(duePoll.mock.results.map(({ value }) => value));
        expect(harness.runtime.storage.existsSync(capsulePath)).toBe(false);
        expect((await readHealth(core)).health.diagnostics?.providerOperationStartupReconciliation).toBeUndefined();
        expect(admission().pendingMutations()).not.toContain('provider-operation-mutation-set-fence');
      } finally {
        release();
        await boot.catch(() => undefined);
        await harness.cleanup();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    },
    10_000,
  );

  it('keeps the operation and capsule when reboot containment is unobservable', async () => {
    const { harness, record, capsulePath } = rebootFixture('unknown');
    const kill = vi.spyOn(harness.runtime.process, 'kill');
    try {
      const booted = await harness.bootCore({ instanceId: randomUUID() });
      expect(booted.core.runtimeState.getLifecycle()).toBe('running');
      expect(readProviderOperation(harness.db, record.operation)).not.toBeNull();
      expect(harness.runtime.storage.existsSync(capsulePath)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
