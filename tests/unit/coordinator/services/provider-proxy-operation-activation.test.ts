import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { OperationIdentity, ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  authorizeProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  inspectProviderOperation,
  prepareProviderOperation,
  providerOperationPrepareAttempt,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
  type ProviderProxySetIdentity,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';

const SET_IDENTITY: ProviderProxySetIdentity = {
  buildSetId: randomUUID(),
  hostFingerprint: 'a'.repeat(64),
  guardianInstanceId: randomUUID(),
  guardianPid: 100,
  guardianProcessStartedAtSeconds: 1,
  guardianControlEndpoint: '/tmp/guardian.sock',
  proxyInstanceId: randomUUID(),
  proxyPid: 200,
  reaperInstanceId: randomUUID(),
  reaperPid: 300,
  reaperProcessStartedAtSeconds: 2,
  reaperControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-group',
  proxyProcessStartedAtSeconds: 3,
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
    cwd: '/project',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

function scriptedClient(answers: Record<string, unknown>): {
  client: OperationControlClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    client: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (!(method in answers)) throw new Error(`unscripted call to ${method}`);
        return answers[method];
      },
    },
  };
}

function deps(proxy: OperationControlClient, guardian: OperationControlClient): ProviderProxyOperationActivationDeps {
  return { proxyClient: proxy, guardianClient: guardian, setIdentity: SET_IDENTITY, mutationRpcTimeoutMs: 5_000 };
}

describe('provider proxy operation mutations', () => {
  it('derives one stable prepare attempt and validates the exact prepare reply', async () => {
    const pending = {
      state: 'pending-activation',
      reservation: randomUUID(),
      leaseExpiresInMs: 15_000,
      providerRoot: { pid: 701, processStartedAtSeconds: 800 },
      jointContainmentReceipt: 'joint-1',
    } as const;
    const proxy = scriptedClient({ 'operation.prepare.v1': pending });
    const guardian = scriptedClient({});
    const activationDeps = deps(proxy.client, guardian.client);

    const first = providerOperationPrepareAttempt(activationDeps, OPERATION, PREPARED);
    const second = providerOperationPrepareAttempt(activationDeps, OPERATION, PREPARED);
    await expect(prepareProviderOperation(activationDeps, OPERATION, PREPARED)).resolves.toEqual(pending);

    expect(first.prepareAttemptKey).toBe(second.prepareAttemptKey);
    expect(proxy.calls).toEqual([{ method: 'operation.prepare.v1', params: first.request }]);
  });

  it('uses observation-only inspect v2 with the full operation identity and attempt key', async () => {
    const proxy = scriptedClient({ 'operation.inspect.v2': { state: 'absent' } });
    const guardian = scriptedClient({});
    const prepareAttemptKey = 'b'.repeat(64);

    await expect(
      inspectProviderOperation(deps(proxy.client, guardian.client), OPERATION, prepareAttemptKey),
    ).resolves.toEqual({
      state: 'absent',
    });
    expect(proxy.calls).toEqual([
      { method: 'operation.inspect.v2', params: { operation: OPERATION, prepareAttemptKey } },
    ]);
  });

  it('keeps guardian authorization and semantic activation as separate replayable mutations', async () => {
    const reservation = randomUUID();
    const proxy = scriptedClient({
      'operation.activate.v1': { state: 'executing', committedThroughProviderSeq: 0 },
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
      providerRoot: { pid: 701, processStartedAtSeconds: 800 },
      jointContainmentReceipt: 'joint-1',
    };

    const authorized = await authorizeProviderOperation(activationDeps, OPERATION, preparation);
    await expect(
      activateProviderOperation(activationDeps, OPERATION, {
        reservation,
        jointContainmentReceipt: preparation.jointContainmentReceipt,
        jointActivationReceipt: authorized.jointActivationReceipt,
      }),
    ).resolves.toEqual({ state: 'executing', committedThroughProviderSeq: 0 });

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

  it('uses fenced cancel v2 for prestart cleanup while retaining the executing stop capability', async () => {
    const reservation = randomUUID();
    const prepareAttemptKey = 'b'.repeat(64);
    const proxy = scriptedClient({
      'operation.cancel.v2': { state: 'released-never-started', prepareAttemptKey },
      'operation.stop.v1': { state: 'terminal-awaiting-journal-ack', committedThroughProviderSeq: 0 },
    });
    const guardian = scriptedClient({
      'guardian.operation-release.v1': { state: 'membership-released' },
    });
    const activationDeps = deps(proxy.client, guardian.client);

    await expect(cancelProviderOperation(activationDeps, OPERATION, prepareAttemptKey, reservation)).resolves.toEqual({
      state: 'released-never-started',
      prepareAttemptKey,
    });
    const control = buildProviderOperationControl(activationDeps, OPERATION, {
      reservation,
      jointContainmentReceipt: 'joint-1',
    });
    await control.stop('user_abort');
    await control.releaseMembership?.();

    expect(proxy.calls.map((call) => call.method)).toEqual(['operation.cancel.v2', 'operation.stop.v1']);
    expect(guardian.calls.map((call) => call.method)).toEqual(['guardian.operation-release.v1']);
  });
});
