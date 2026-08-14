import { randomUUID } from 'node:crypto';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

import { describe, expect, it } from 'vitest';

import {
  PROXY_CONTROL_PROTOCOL_ERROR_CODES,
  type OperationIdentity,
  type ProxyControlProtocolErrorCode,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  attachProviderOperation,
  authorizeProviderOperation,
  buildProviderOperationControl,
  cancelProviderOperation,
  inspectProviderOperation,
  prepareProviderOperation,
  providerOperationPrepareAttempt,
  settleProviderOperation,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import {
  createProviderProxyAuthorityFaultLatch,
  type ProviderProxyAuthorityFault,
  type ProviderProxyOperationIncident,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set-identity.js';

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
      call: async (method, params) => {
        calls.push({ method, params });
        if (!(method in answers)) throw new Error(`unscripted call to ${method}`);
        return answers[method];
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

function faultRoutingDeps(client: OperationControlClient): Readonly<{
  activationDeps: ProviderProxyOperationActivationDeps;
  faults: ProviderProxyAuthorityFault[];
  incidents: ProviderProxyOperationIncident[];
}> {
  const latch = createProviderProxyAuthorityFaultLatch();
  const faults: ProviderProxyAuthorityFault[] = [];
  const incidents: ProviderProxyOperationIncident[] = [];
  latch.onFault((fault) => faults.push(fault));
  latch.onIncident((incident) => incidents.push(incident));
  return {
    activationDeps: {
      ...deps(client, scriptedClient({}).client),
      faultAuthority: latch.latch,
      reportIncident: latch.reportIncident,
    },
    faults,
    incidents,
  };
}

async function expectRetrySafeFailureKeepsAuthorityLatchAvailable(
  method: 'operation.attach.v1' | 'operation.stop.v1',
  failure: Error,
  invoke: (activationDeps: ProviderProxyOperationActivationDeps) => Promise<unknown>,
): Promise<void> {
  const closed = Object.assign(new Error('control client closed'), { code: 'control_client_closed' });
  const failures = [failure, closed];
  const routing = faultRoutingDeps({
    call: () => {
      const nextFailure = failures.shift();
      return Promise.reject(nextFailure instanceof Error ? nextFailure : new Error('unexpected extra call'));
    },
  });

  await expect(invoke(routing.activationDeps)).rejects.toBe(failure);
  expect(routing.faults).toEqual([]);
  expect(routing.incidents).toEqual([
    {
      kind: 'operation-control-failed',
      policy: expect.objectContaining({ method, effect: 'mutation', indeterminate: 'retry-safe' }),
      error: failure,
    },
  ]);

  await expect(invoke(routing.activationDeps)).rejects.toBe(closed);
  expect(routing.faults).toEqual([{ kind: 'control-channel-fault', role: 'proxy', error: closed }]);
  expect(routing.incidents).toHaveLength(1);
}

describe('provider proxy operation mutations', () => {
  it('routes every closed operation client call as a role-specific channel fault', async () => {
    const closed = Object.assign(new Error('control client closed'), { code: 'control_client_closed' });
    const rejectingClient: OperationControlClient = { call: () => Promise.reject(closed) };
    const faults: ProviderProxyAuthorityFault[] = [];
    const activationDeps: ProviderProxyOperationActivationDeps = {
      ...deps(rejectingClient, rejectingClient),
      faultAuthority: (fault) => faults.push(fault),
    };
    const prepareAttempt = providerOperationPrepareAttempt(activationDeps, OPERATION, PREPARED);
    const calls = [
      () => prepareProviderOperation(activationDeps, prepareAttempt),
      () => inspectProviderOperation(activationDeps, OPERATION, prepareAttempt.prepareAttemptKey),
      () =>
        authorizeProviderOperation(activationDeps, OPERATION, {
          reservation: randomUUID(),
          providerRoot: { pid: 701, processStartedAtSeconds: 800 },
          jointContainmentReceipt: 'joint-1',
        }),
      () =>
        activateProviderOperation(activationDeps, OPERATION, {
          reservation: randomUUID(),
          jointContainmentReceipt: 'joint-1',
          jointActivationReceipt: 'joint-activation-1',
        }),
      () => attachProviderOperation(activationDeps, OPERATION, 0),
      () => cancelProviderOperation(activationDeps, OPERATION, 1, prepareAttempt.prepareAttemptKey),
      () => settleProviderOperation(activationDeps, OPERATION, 0),
      () => buildProviderOperationControl(activationDeps, OPERATION).stop('user_abort'),
    ];

    for (const call of calls) await expect(call()).rejects.toBe(closed);

    expect(faults).toEqual([
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'guardian', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
      { kind: 'control-channel-fault', role: 'proxy', error: closed },
    ]);
  });

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
    await expect(
      prepareProviderOperation(activationDeps, { ...first, prepareAttemptKey: 'd'.repeat(64) }),
    ).rejects.toThrow('Provider operation prepare attempt fingerprint does not match its exact request.');
    await expect(prepareProviderOperation(activationDeps, first)).resolves.toEqual(pending);

    expect(first.prepareAttemptKey).toBe(second.prepareAttemptKey);
    expect(proxy.calls).toEqual([{ method: 'operation.prepare.v1', params: first.request }]);
  });

  it('uses observation-only inspect v2 with the full operation identity and attempt key', async () => {
    const proxy = scriptedClient({ 'operation.inspect.v1': { state: 'absent' } });
    const guardian = scriptedClient({});
    const prepareAttemptKey = 'b'.repeat(64);

    await expect(
      inspectProviderOperation(deps(proxy.client, guardian.client), OPERATION, prepareAttemptKey),
    ).resolves.toEqual({
      state: 'absent',
    });
    expect(proxy.calls).toEqual([
      { method: 'operation.inspect.v1', params: { operation: OPERATION, prepareAttemptKey } },
    ]);
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
    const routing = faultRoutingDeps({ call: () => Promise.reject(timeout) });

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

  it('reports a malformed settlement reply without consuming the authority fault latch', async () => {
    const routing = faultRoutingDeps({ call: () => Promise.resolve({ state: 'released-after-terminal' }) });

    await expect(settleProviderOperation(routing.activationDeps, OPERATION, 7)).rejects.toThrow();

    expect(routing.faults).toEqual([]);
    expect(routing.incidents).toEqual([
      {
        kind: 'operation-control-failed',
        policy: expect.objectContaining({
          method: 'operation.settle.v1',
          effect: 'mutation',
          indeterminate: 'retry-safe',
        }),
        error: expect.any(Error),
      },
    ]);
  });

  it('faults authority for a closed settlement channel without reporting an incident', async () => {
    const closed = Object.assign(new Error('control client closed'), { code: 'control_client_closed' });
    const routing = faultRoutingDeps({ call: () => Promise.reject(closed) });

    await expect(settleProviderOperation(routing.activationDeps, OPERATION, 7)).rejects.toBe(closed);

    expect(routing.faults).toEqual([
      {
        kind: 'control-channel-fault',
        role: 'proxy',
        error: closed,
      },
    ]);
    expect(routing.incidents).toEqual([]);
  });

  it('allows a closed settlement channel to latch after a retry-safe incident is preserved', async () => {
    const timeout = Object.assign(new Error('settlement timed out'), { code: 'control_call_failed' });
    const closed = Object.assign(new Error('control client closed'), { code: 'control_client_closed' });
    const failures = [timeout, closed];
    const routing = faultRoutingDeps({
      call: () => {
        const failure = failures.shift();
        return Promise.reject(failure instanceof Error ? failure : new Error('unexpected extra call'));
      },
    });

    await expect(settleProviderOperation(routing.activationDeps, OPERATION, 7)).rejects.toBe(timeout);
    expect(routing.faults).toEqual([]);
    expect(routing.incidents).toHaveLength(1);

    await expect(settleProviderOperation(routing.activationDeps, OPERATION, 7)).rejects.toBe(closed);
    expect(routing.faults).toEqual([
      expect.objectContaining({
        kind: 'control-channel-fault',
        role: 'proxy',
        error: closed,
      }),
    ]);
    expect(routing.incidents).toHaveLength(1);
  });

  it.each(['timeout before effect', 'response loss after effect'])(
    'routes attach %s as retry-safe without consuming the authority latch',
    async (ordering) => {
      const failure = Object.assign(new Error(`attach ${ordering}`), { code: 'control_call_failed' });

      // The routing seam cannot distinguish the orderings; replaying the durable watermark keeps attach retry-owned.
      await expectRetrySafeFailureKeepsAuthorityLatchAvailable('operation.attach.v1', failure, (activationDeps) =>
        attachProviderOperation(activationDeps, OPERATION, 7),
      );
    },
  );

  it.each(['timeout before effect', 'response loss after effect'])(
    'routes stop %s as retry-safe without consuming the authority latch',
    async (ordering) => {
      const failure = Object.assign(new Error(`stop ${ordering}`), { code: 'control_call_failed' });

      // The routing seam cannot distinguish the orderings; executing attachment replays durable stop intent.
      await expectRetrySafeFailureKeepsAuthorityLatchAvailable('operation.stop.v1', failure, (activationDeps) =>
        buildProviderOperationControl(activationDeps, OPERATION).stop('user_abort'),
      );
    },
  );

  it('keeps exactly the four audited activation codes non-faulting across the complete protocol code set', async () => {
    const auditedPreEffectCodes = new Set<ProxyControlProtocolErrorCode>([
      'method_not_found',
      'identity_mismatch',
      'operation_not_found',
      'unauthorized_control',
    ]);
    const failure = (protocolCode: ProxyControlProtocolErrorCode): Error & { code: string; protocolCode: string } =>
      Object.assign(new Error(protocolCode), { code: 'control_call_failed', protocolCode });
    const observed: Array<readonly [ProxyControlProtocolErrorCode, number]> = [];

    for (const protocolCode of PROXY_CONTROL_PROTOCOL_ERROR_CODES) {
      const faults: unknown[] = [];
      const proxy: OperationControlClient = {
        call: () => Promise.reject(failure(protocolCode)),
      };
      const activationDeps: ProviderProxyOperationActivationDeps = {
        ...deps(proxy, scriptedClient({}).client),
        faultAuthority: (fault) => faults.push(fault),
      };
      await expect(
        activateProviderOperation(activationDeps, OPERATION, {
          reservation: randomUUID(),
          jointContainmentReceipt: 'joint-1',
          jointActivationReceipt: 'joint-activation-1',
        }),
      ).rejects.toThrow(protocolCode);
      observed.push([protocolCode, faults.length]);
    }

    expect(observed).toEqual(
      PROXY_CONTROL_PROTOCOL_ERROR_CODES.map((code) => [code, auditedPreEffectCodes.has(code) ? 0 : 1]),
    );
  });

  it('strictly validates attachment before and after the wire call', async () => {
    const proxy = scriptedClient({
      'operation.attach.v1': { state: 'attached', replayFromProviderSeq: 0 },
    });
    const guardian = scriptedClient({});
    const activationDeps = deps(proxy.client, guardian.client);

    await expect(attachProviderOperation(activationDeps, OPERATION, 4)).rejects.toThrow();
    await expect(attachProviderOperation(activationDeps, OPERATION, -1)).rejects.toThrow();

    expect(proxy.calls).toEqual([
      {
        method: 'operation.attach.v1',
        params: { operation: OPERATION, committedThroughProviderSeq: 4 },
      },
    ]);
  });

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
