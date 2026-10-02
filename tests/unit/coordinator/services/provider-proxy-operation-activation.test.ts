import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { createProviderOperationRetryHarness } from '#tests/helpers/provider-operation-retry-harness.js';
import { describe, expect, it } from 'vitest';
import { type OperationIdentity, type ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  authorizeProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  prepareProviderOperation,
  providerOperationPrepareAttempt,
  settleProviderOperation,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFault,
  type ProviderProxyAuthorityIncident,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { readProviderOperation } from '#src/store/provider-operation-journal.js';
import { controlExchangeForTest } from '#src/provider-proxy/control-client.js';

const SET_IDENTITY: ProviderProxySetIdentity = {
  buildSetId: randomUUID(),
  hostFingerprint: 'a'.repeat(64),
  guardianInstanceId: randomUUID(),
  guardianPid: 100,
  guardianIncarnation: testIncarnation(1),
  guardianControlEndpoint: '/tmp/guardian.sock',
  proxyInstanceId: randomUUID(),
  proxyPid: 200,
  reaperInstanceId: randomUUID(),
  reaperPid: 300,
  reaperIncarnation: testIncarnation(2),
  reaperControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-group',
  proxyIncarnation: testIncarnation(3),
  proxyProcessGroupId: 200,
  canonicalEndpoint: '/tmp/proxy.sock',
};
const OPERATION: OperationIdentity = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  proxyInstanceId: SET_IDENTITY.proxyInstanceId,
  buildSetId: SET_IDENTITY.buildSetId,
};
const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: fixtureCanonicalWorkDir('/project'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};
const ACTIVATION_ACK = {
  state: 'executing' as const,
  activationFingerprint: 'c'.repeat(64),
  startedAt: '2026-08-09T12:34:56.000Z',
  hostRef: {
    provider: 'codex',
    fingerprint: SET_IDENTITY.hostFingerprint,
    instanceId: randomUUID(),
    leaseMode: 'job-exclusive' as const,
    ownerJobId: OPERATION.jobId,
  },
  committedThroughProviderSeq: 0,
};

function scriptedClient(answers: Record<string, unknown>): {
  client: OperationControlClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    client: {
      exchange: async (method, params) => {
        calls.push({ method, params });
        if (!(method in answers)) throw new Error(`unscripted call to ${method}`);
        return controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: answers[method] },
        });
      },
    },
  };
}

function deps(proxy: OperationControlClient, guardian: OperationControlClient): ProviderProxyOperationActivationDeps {
  return {
    proxyClient: proxy,
    guardianClient: guardian,
    setIdentity: SET_IDENTITY,
    mutationRpcTimeoutMs: 5_000,
    faultAuthority: () => {},
    reportIncident: () => {},
  };
}

function faultRoutingDeps(
  client: OperationControlClient,
  guardianClient: OperationControlClient = client,
): Readonly<{
  activationDeps: ProviderProxyOperationActivationDeps;
  faults: ProviderProxyAuthorityFault[];
  incidents: ProviderProxyAuthorityIncident[];
}> {
  const latch = createProviderProxyAuthorityFaultLatch();
  const faults: ProviderProxyAuthorityFault[] = [];
  const incidents: ProviderProxyAuthorityIncident[] = [];
  latch.onFault((fault) => faults.push(fault));
  latch.onIncident((observation) => incidents.push(observation));
  return {
    activationDeps: {
      ...deps(client, guardianClient),
      faultAuthority: latch.latch,
      reportIncident: latch.reportIncident,
    },
    faults,
    incidents,
  };
}

describe('provider proxy operation mutations', () => {
  it('derives one stable prepare attempt and validates the exact prepare reply', async () => {
    const pending = {
      state: 'pending-activation',
      reservation: randomUUID(),
      leaseExpiresInMs: 15_000,
      providerRoot: { pid: 701, incarnation: testIncarnation(800) },
      jointContainmentReceipt: 'joint-1',
    } as const;
    const proxy = scriptedClient({ 'operation.prepare.v1': pending });
    const guardian = scriptedClient({});
    const activationDeps = deps(proxy.client, guardian.client);

    const first = providerOperationPrepareAttempt(activationDeps, OPERATION, PREPARED);
    const second = providerOperationPrepareAttempt(activationDeps, OPERATION, PREPARED);
    await expect(
      prepareProviderOperation(activationDeps, { ...first, prepareAttemptKey: 'd'.repeat(64) }),
    ).rejects.toThrow('Provider operation prepare attempt fingerprint does not match its exact request.');
    await expect(prepareProviderOperation(activationDeps, first)).resolves.toEqual(pending);

    expect(first.prepareAttemptKey).toBe(second.prepareAttemptKey);
    expect(proxy.calls).toEqual([{ method: 'operation.prepare.v1', params: first.request }]);
  });

  it('keeps guardian authorization and semantic activation as separate replayable mutations', async () => {
    const reservation = randomUUID();
    const proxy = scriptedClient({
      'operation.activate.v1': ACTIVATION_ACK,
    });
    const guardian = scriptedClient({
      'guardian.operation-activate.v1': {
        state: 'activation-authorized',
        jointActivationReceipt: 'joint-activation-1',
      },
    });
    const activationDeps = deps(proxy.client, guardian.client);
    const preparation = {
      reservation,
      providerRoot: { pid: 701, incarnation: testIncarnation(800) },
      jointContainmentReceipt: 'joint-1',
    };

    const authorized = await authorizeProviderOperation(activationDeps, OPERATION, preparation);
    await expect(
      activateProviderOperation(activationDeps, OPERATION, {
        reservation,
        jointContainmentReceipt: preparation.jointContainmentReceipt,
        jointActivationReceipt: authorized.jointActivationReceipt,
      }),
    ).resolves.toEqual(ACTIVATION_ACK);

    expect(guardian.calls[0]?.method).toBe('guardian.operation-activate.v1');
    expect(proxy.calls[0]).toEqual({
      method: 'operation.activate.v1',
      params: {
        operation: OPERATION,
        reservation,
        jointContainmentReceipt: 'joint-1',
        jointActivationReceipt: 'joint-activation-1',
      },
    });
  });

  it('faults authority when activation returns a schema-invalid acknowledgement after semantic start', async () => {
    const proxy = scriptedClient({
      'operation.activate.v1': { state: 'executing' },
    });
    const guardian = scriptedClient({});
    const faults: unknown[] = [];
    const activationDeps: ProviderProxyOperationActivationDeps = {
      ...deps(proxy.client, guardian.client),
      faultAuthority: (fault) => faults.push(fault),
    };

    await expect(
      activateProviderOperation(activationDeps, OPERATION, {
        reservation: randomUUID(),
        jointContainmentReceipt: 'joint-1',
        jointActivationReceipt: 'joint-activation-1',
      }),
    ).rejects.toThrow();

    expect(faults).toEqual([
      expect.objectContaining({
        policy: expect.objectContaining({ method: 'operation.activate.v1', phase: 'proxy-activation-pending' }),
      }),
    ]);
  });

  it('reports a settlement timeout without consuming the authority fault latch', async () => {
    const timeout = Object.assign(new Error('settlement timed out'), { code: 'control_call_failed' });
    const routing = faultRoutingDeps({ exchange: () => Promise.reject(timeout) });

    await expect(settleProviderOperation(routing.activationDeps, OPERATION, 7)).rejects.toBe(timeout);

    expect(routing.faults).toEqual([]);
    expect(routing.incidents).toEqual([
      {
        kind: 'operation-control-failed',
        policy: expect.objectContaining({
          method: 'operation.settle.v1',
          effect: 'mutation',
          indeterminate: 'retry-safe',
        }),
        error: timeout,
      },
    ]);
  });

  it.each([
    { method: 'attach', ordering: 'after-effect' },
    { method: 'stop', ordering: 'after-effect' },
  ] as const)(
    'reconciles $method after a lost $ordering response without losing retry ownership',
    async ({ method, ordering }) => {
      const harness = createProviderOperationRetryHarness(method, ordering);
      const { authority, claims, endpoint, incidents, progressStore, reconciler, record, registry } = harness;

      try {
        await reconciler.reconcile(record, authority);
        const retryOwned = readProviderOperation(progressStore.getDb(), record.operation);

        const targetEffectCount = method === 'attach' ? endpoint.attachmentEffectCount() : endpoint.stopEffectCount();
        expect(targetEffectCount).toBe(1);
        expect(retryOwned).toEqual(
          expect.objectContaining({
            phase: 'executing',
            committedThroughProviderSeq: record.committedThroughProviderSeq,
            controlIntent: record.controlIntent,
            retryCount: 1,
            retryNotBeforeMs: expect.any(Number),
            lastError: expect.objectContaining({
              code: endpoint.failure.code,
              message: endpoint.failure.message,
            }),
          }),
        );
        expect(retryOwned?.retryNotBeforeMs).toBeGreaterThan(100);
        expect(claims.claimFor(record.operation)).not.toBeNull();
        expect(harness.terminalFaults).toEqual([]);
        expect(incidents).toEqual([
          {
            kind: 'operation-control-failed',
            policy: expect.objectContaining({
              method: method === 'attach' ? 'operation.attach.v1' : 'operation.stop.v1',
              phase: 'executing',
              effect: 'mutation',
              indeterminate: 'retry-safe',
            }),
            error: endpoint.failure,
          },
        ]);
        expect(harness.stopAndReap).not.toHaveBeenCalled();

        if (retryOwned?.phase !== 'executing') throw new Error('retry did not retain the executing record');
        await reconciler.reconcile(retryOwned, authority);
        const converged = readProviderOperation(progressStore.getDb(), record.operation);

        expect(converged).toEqual(
          expect.objectContaining({
            phase: 'executing',
            committedThroughProviderSeq: record.committedThroughProviderSeq,
            controlIntent: record.controlIntent,
          }),
        );
        if (method === 'stop') {
          expect(converged).toMatchObject({
            retryCount: 2,
            retryNotBeforeMs: 150,
            lastError: { code: 'provider_stop_pending' },
          });
        } else {
          expect(converged).toMatchObject({ retryCount: 0, retryNotBeforeMs: 100, lastError: null });
        }
        expect(claims.claimFor(record.operation)).not.toBeNull();
        expect(endpoint.attachmentWatermarks).toEqual([
          record.committedThroughProviderSeq,
          record.committedThroughProviderSeq,
        ]);
        expect(endpoint.stopIntents).toEqual(method === 'stop' ? ['user_abort', 'user_abort'] : []);
        expect(endpoint.attachmentEffectCount()).toBe(1);
        expect(endpoint.stopEffectCount()).toBe(method === 'stop' ? 1 : 0);
        expect(registry.attach).toHaveBeenCalledOnce();
        expect(harness.stopAndReap).not.toHaveBeenCalled();
      } finally {
        harness.unsubscribeClaims();
      }
    },
  );

  it('uses fenced cancel v2 for prestart cleanup while retaining the executing stop capability', async () => {
    const prepareAttemptKey = 'b'.repeat(64);
    const proxy = scriptedClient({
      'operation.cancel.v1': {
        state: 'released-never-started',
        operation: OPERATION,
        prepareAttemptNumber: 2,
        prepareAttemptKey,
      },
      'operation.stop.v1': { state: 'terminal-awaiting-journal-ack', committedThroughProviderSeq: 0 },
    });
    const guardian = scriptedClient({});
    const activationDeps = deps(proxy.client, guardian.client);

    await expect(cancelProviderOperation(activationDeps, OPERATION, 2, prepareAttemptKey)).resolves.toEqual({
      state: 'released-never-started',
      operation: OPERATION,
      prepareAttemptNumber: 2,
      prepareAttemptKey,
    });
    const control = buildProviderOperationControl(activationDeps, OPERATION);
    await control.stop('user_abort');

    expect(proxy.calls.map((call) => call.method)).toEqual(['operation.cancel.v1', 'operation.stop.v1']);
    expect(proxy.calls[0]?.params).toEqual({ operation: OPERATION, prepareAttemptNumber: 2, prepareAttemptKey });
    expect(guardian.calls).toEqual([]);
  });

  it('sends cumulative settlement through the proxy with the final provider sequence', async () => {
    const proxy = scriptedClient({
      'operation.settle.v1': { state: 'released-after-terminal', settledThroughProviderSeq: 7 },
    });
    const guardian = scriptedClient({});

    await expect(settleProviderOperation(deps(proxy.client, guardian.client), OPERATION, 7)).resolves.toEqual({
      state: 'released-after-terminal',
      settledThroughProviderSeq: 7,
    });
    expect(proxy.calls).toEqual([
      { method: 'operation.settle.v1', params: { operation: OPERATION, finalProviderSeq: 7 } },
    ]);
    expect(guardian.calls).toEqual([]);
  });
});
