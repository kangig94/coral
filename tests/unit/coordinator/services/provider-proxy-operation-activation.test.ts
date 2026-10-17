import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type OperationIdentity } from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  authorizeProviderOperation,
  attachProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  inspectProviderOperation,
  prepareProviderOperation,
  providerOperationPrepareAttempt,
  sendProviderOperation,
  settleProviderOperation,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlExchange,
  type ControlClientRemoteFailure,
} from '#src/provider-proxy/control-client.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

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

describe('provider send uncertainty policy', () => {
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };

  function failure(jsonRpcCode: number, protocolCode: 'method_not_found' | 'invalid_request' | null): ControlExchange {
    const failure: ControlClientRemoteFailure = {
      kind: 'json-rpc-error',
      jsonRpcCode,
      protocolCode,
      admissionReason: null,
      heartbeatRefusal: null,
    };
    return controlExchangeForTest({
      kind: 'response',
      response: {
        kind: 'refusal',
        failure,
        error: new ControlClientError('control_call_failed', 'Proxy handler failed', 'remote-response', failure),
      },
    });
  }

  function setup(answer: ControlExchange | Error) {
    const exchange = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const faultAuthority = vi.fn();
    const reportIncident = vi.fn();
    return {
      exchange,
      faultAuthority,
      reportIncident,
      deps: {
        ...deps({ exchange }, { exchange }),
        faultAuthority,
        reportIncident,
      },
    };
  }

  it.each([
    { state: 'delivered', providerTurnId: 'turn-1' },
    { state: 'refused', code: 'turn_ended', reason: 'Turn ended' },
    { state: 'unknown', reason: 'Provider did not answer' },
  ])('returns the answered result unchanged: %j', async (value) => {
    const h = setup(controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } }));
    await expect(sendProviderOperation(h.deps, OPERATION, input)).resolves.toEqual(value);
    expect(h.exchange).toHaveBeenCalledExactlyOnceWith(
      'operation.send.v1',
      {
        operation: OPERATION,
        input: input.text,
        clientMessageId: input.clientMessageId,
      },
      15_000,
    );
    expect(h.reportIncident).not.toHaveBeenCalled();
    expect(h.faultAuthority).not.toHaveBeenCalled();
  });

  it.each([
    failure(-32600, 'invalid_request'),
    failure(-32603, null),
    controlExchangeForTest({
      kind: 'no-response',
      cause: 'timeout',
      error: new ControlClientError('control_call_failed', 'Timed out', 'timeout'),
    }),
    controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: { state: 'delivered' } } }),
    controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: null } }),
    new Error('exchange failed after dispatch'),
  ])('returns unknown without an incident, fault or replay for an uncertain send: %j', async (answer) => {
    const h = setup(answer);
    await expect(sendProviderOperation(h.deps, OPERATION, input)).resolves.toMatchObject({ state: 'unknown' });
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(h.reportIncident).not.toHaveBeenCalled();
    expect(h.faultAuthority).not.toHaveBeenCalled();
  });

  it.each(['method_not_found', null] as const)(
    'replaces older-proxy method-not-found with restart guidance without a fault or replay: %s',
    async (protocolCode) => {
      const h = setup(failure(-32601, protocolCode));
      await expect(sendProviderOperation(h.deps, OPERATION, input)).resolves.toMatchObject({
        state: 'refused',
        code: 'unsupported_by_running_build',
        reason:
          'The running Coral build predates jobs send. Restart the session so the current Coral plugin loads; the coordinator follows the installed build.',
      });
      expect(h.exchange).toHaveBeenCalledTimes(1);
      expect(h.reportIncident).not.toHaveBeenCalled();
      expect(h.faultAuthority).not.toHaveBeenCalled();
    },
  );

  it('keeps a closed-channel fact on its channel incident without an operation incident or fault', async () => {
    const error = new ControlClientError('control_client_closed', 'Channel closed', 'closed');
    const h = setup(controlExchangeForTest({ kind: 'no-response', cause: 'connection-closed-after-write', error }));
    await expect(sendProviderOperation(h.deps, OPERATION, input)).resolves.toMatchObject({ state: 'unknown' });
    expect(h.reportIncident).toHaveBeenCalledExactlyOnceWith({
      kind: 'control-channel-fault',
      role: 'proxy',
      cause: 'closed',
      error,
    });
    expect(h.faultAuthority).not.toHaveBeenCalled();
  });

  it('validates send input before proxy contact', async () => {
    const h = setup(failure(-32603, null));
    await expect(sendProviderOperation(h.deps, OPERATION, { ...input, clientMessageId: 'invalid' })).rejects.toThrow();
    expect(h.exchange).not.toHaveBeenCalled();
  });
});

it('keeps the exhaustive operation policy dispositions separate from send uncertainty', async () => {
  const error = new Error('No decisive answer');
  const client: OperationControlClient = {
    exchange: async () => {
      throw error;
    },
  };
  const faultAuthority = vi.fn();
  const reportIncident = vi.fn();
  const activationDeps = { ...deps(client, client), faultAuthority, reportIncident };
  const attempt = providerOperationPrepareAttempt(activationDeps, OPERATION, {
    version: 1,
    provider: 'codex',
    binding: { provider: 'codex', kind: 'account', binding: {} },
    request: {
      action: 'exec',
      sessionId: 'session-1',
      prompt: 'hello',
      cwd: fixtureCanonicalWorkDir('/tmp'),
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: {},
    protectedEnv: {},
    platform: 'linux',
  });
  const calls = [
    () => prepareProviderOperation(activationDeps, attempt),
    () => inspectProviderOperation(activationDeps, OPERATION, attempt.prepareAttemptKey),
    () =>
      authorizeProviderOperation(activationDeps, OPERATION, {
        reservation: randomUUID(),
        providerRoot: { pid: 701, incarnation: testIncarnation(800) },
        jointContainmentReceipt: 'joint-1',
      }),
    () =>
      activateProviderOperation(activationDeps, OPERATION, {
        reservation: randomUUID(),
        jointContainmentReceipt: 'joint-1',
        jointActivationReceipt: 'activation-1',
      }),
    () => attachProviderOperation(activationDeps, OPERATION, 0),
    () => cancelProviderOperation(activationDeps, OPERATION, 1, attempt.prepareAttemptKey),
    () => settleProviderOperation(activationDeps, OPERATION, 0),
    () => buildProviderOperationControl(activationDeps, OPERATION).stop('user_abort'),
  ];
  for (const call of calls) await expect(call()).rejects.toBe(error);
  expect(faultAuthority.mock.calls.map(([fault]) => [fault.policy.method, fault.policy.indeterminate])).toEqual([
    ['operation.prepare.v1', 'requires-containment'],
    ['guardian.operation-activate.v1', 'requires-containment'],
    ['operation.activate.v1', 'requires-containment'],
    ['operation.cancel.v1', 'requires-containment'],
  ]);
  expect(
    reportIncident.mock.calls.map(([incident]) => [incident.policy.method, incident.policy.indeterminate]),
  ).toEqual([
    ['operation.attach.v1', 'retry-safe'],
    ['operation.settle.v1', 'retry-safe'],
    ['operation.stop.v1', 'retry-safe'],
  ]);
  const send = await sendProviderOperation(activationDeps, OPERATION, {
    text: 'Change direction',
    clientMessageId: '33333333-3333-4333-8333-333333333333',
  });
  expect(send).toEqual({ state: 'unknown', reason: error.message });
  expect(faultAuthority).toHaveBeenCalledTimes(4);
  expect(reportIncident).toHaveBeenCalledTimes(3);
});
