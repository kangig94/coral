import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { connectControlClient, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import {
  createProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { readProviderOperation, readProviderOperationsDue } from '#src/store/provider-operation-journal.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { strictControlExchangeResult } from '#tests/support/control-exchange.js';

it('settles an aborted job after real proxy control loss and confirmed containment absence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-stop-'));
  const endpoint = join(directory, 'proxy.sock');
  const fixture = providerOperationRecord('executing');
  const { operation, locator } = fixture;
  const timer = {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as NodeJS.Timeout),
  };
  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: operation.buildSetId,
    hostFingerprint: locator.hostFingerprint,
    guardianInstanceId: locator.guardian.instanceId,
    reaperInstanceId: locator.reaper.instanceId,
    proxyInstanceId: operation.proxyInstanceId,
    bootstrapNonce: 'a'.repeat(64),
  };
  const stop = vi.fn();
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...shared,
      canonicalEndpoint: endpoint,
      guardianControlEndpoint: join(directory, 'guardian.sock'),
      proxyGuardianAuthSecret: 'b'.repeat(64),
    },
    identity: {
      ...shared,
      pid: locator.proxy.pid,
      incarnation: locator.proxy.incarnation,
      processGroupId: locator.containment.processGroupId,
      canonicalEndpoint: endpoint,
    },
    clock: createMonotonicClock(Symbol('aborted-stop'), { readMilliseconds: () => 0n }),
    timer,
    mintChallenge: randomUUID,
    mintReceipt: randomUUID,
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => Date.parse('2026-08-09T12:34:56.000Z'),
    host: {
      start: () => ({
        result: Promise.resolve({
          kind: 'started',
          hostRef: {
            provider: 'codex',
            fingerprint: locator.hostFingerprint,
            instanceId: 'shared',
            leaseMode: 'shared',
          },
        }),
        abortAndRelease: async () => {},
      }),
      stop,
    },
    containment: {
      stageProviderRoot: () => ({
        result: Promise.resolve({
          state: 'staged',
          providerRoot: { pid: 104, incarnation: testIncarnation(1003) },
          receipt: asJointContainmentReceipt('contained'),
        }),
        confirmActivation: async () => {},
        abortAndRelease: async () => {},
      }),
    },
  });
  await proxy.listen();
  const control = await connectControlClient(endpoint, timer, 1_000);
  const harness = createProviderOperationReconcilerHarness({
    authorityFor: () => authority,
    prepareOperation: (...args) => authority.prepareOperation(...args),
    authorizeOperation: (...args) => authority.authorizeOperation(...args),
    activatePreparedOperation: (...args) => authority.activatePreparedOperation(...args),
    attachOperation: (...args) => authority.attachOperation(...args),
    settleOperation: (...args) => authority.settleOperation(...args),
    stopOperation: (cause) => authority.buildOperationControl(operation).stop(cause),
  });
  const guardian = {
    exchange: async () =>
      controlExchangeForTest({
        kind: 'response',
        response: { kind: 'result', value: { state: 'activation-authorized', jointActivationReceipt: 'activated' } },
      }),
    faulted: new Promise<never>(() => {}),
    onFault: () => () => {},
    close: () => {},
  };
  const authority: DurableProviderProxyOperationAuthority = createProviderProxyOperationAuthority({
    base: { ...harness.authority, controlReattachment: {} as never },
    setIdentity: harness.authority.setIdentity,
    clients: { proxy: control, guardian, reaper: guardian },
    faults: createProviderProxyAuthorityFaultLatch(),
    mutationRpcTimeoutMs: 1_000,
  });
  try {
    const opened = (await strictControlExchangeResult(
      control,
      'control.open.v1',
      {
        bootstrapNonce: shared.bootstrapNonce,
        coordinator: {
          instanceId: randomUUID(),
          pid: process.pid,
          incarnation: testIncarnation(1),
          generation: 'gen2',
          flavor: 'prod',
          buildSetId: operation.buildSetId,
        },
      },
      1_000,
    )) as { controlEpoch: number; heartbeatChallenge: string };
    await strictControlExchangeResult(
      control,
      'control.heartbeat.v1',
      { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
      1_000,
    );
    const begun = await harness.begin();
    expect(begun).toMatchObject({ kind: 'remote-executing' });
    harness.reconciler.requestStops([operation.jobId], 'signal_abort');
    await vi.waitFor(() =>
      expect(readProviderOperation(harness.db, operation)?.lastError?.code).toBe('provider_stop_pending'),
    );
    expect(stop).toHaveBeenCalledOnce();
    await proxy.close();
    await control.faulted;
    const pending = readProviderOperation(harness.db, operation)!;
    harness.advance(2_000);
    await harness.reconciler.reconcile(pending, authority);
    expect(readProviderOperation(harness.db, operation)?.lastError?.code).toBe('control_client_closed');
    expect(readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 10)).toHaveLength(1);
    expect(harness.appended).not.toContainEqual(expect.objectContaining({ type: 'job.terminal.recorded' }));
    await harness.reconciler.containmentDisappeared({
      operation,
      setIdentity: authority.setIdentity,
      disappearanceReceipt: 'guardian-group-and-roots-absent',
    });
    expect(readProviderOperation(harness.db, operation)).toBeNull();
    expect(readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        type: 'job.terminal.recorded',
        body: expect.objectContaining({
          terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'signal_abort' } }),
        }),
      }),
    );
    expect(harness.fatalErrors).toEqual([]);
  } finally {
    control.close();
    await proxy.close();
    harness.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 5_000);
