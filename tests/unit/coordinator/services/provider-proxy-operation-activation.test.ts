import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type OperationIdentity } from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  authorizeProviderOperation,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
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

describe('provider proxy operation mutations', () => {
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
});
