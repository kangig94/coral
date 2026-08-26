import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('#src/provider-proxy/role-spawn.js', () => ({
  connectRoleControlWithRetry: vi.fn(),
}));

import {
  establishRoleControl,
  ProviderProxyRoleControlRemoteError,
  ProviderProxyRoleControlUnavailableError,
} from '#src/coordinator/live/provider-proxy/role-control.js';
import { ControlClientError, type ControlClient, type ControlClientTimer } from '#src/provider-proxy/control-client.js';
import {
  PROXY_CONTROL_PROTOCOL_ERROR_CODES,
  type ProxyControlProtocolErrorCode,
} from '#src/provider-proxy/protocol.js';
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';

const mockedConnect = vi.mocked(connectRoleControlWithRetry);
const NEVER = new Promise<ControlClientError>(() => undefined);
const TIMER: ControlClientTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};
const RETRY = {
  connectTimeoutMs: 1,
  retryIntervalMs: 1,
  overallDeadlineMs: 1,
  now: () => 0,
  sleep: async () => undefined,
};
const openParamsSchema = z.object({}).strict();
const openResultSchema = z
  .object({ controlEpoch: z.number(), heartbeatChallenge: z.string(), roleId: z.string() })
  .strict();

function client(call: ControlClient['call']): ControlClient {
  return { call, faulted: NEVER, onFault: () => () => undefined, close: () => undefined };
}

function remoteFailure(
  protocolCode: ProxyControlProtocolErrorCode | null,
  admissionReason: 'control-active' | 'invalid-state' | 'teardown-latched' | null,
): ControlClientError {
  return new ControlClientError('control_call_failed', 'remote refusal', 'remote-response', {
    kind: 'json-rpc-error',
    jsonRpcCode: -32_600,
    protocolCode,
    admissionReason,
    heartbeatRefusal: null,
  });
}

function heartbeatRefusal(
  refusal:
    | Readonly<{ reason: 'challenge-mismatch'; nextHeartbeatChallenge: string }>
    | Readonly<{ reason: 'teardown-latched'; nextHeartbeatChallenge: null }>,
): ControlClientError {
  return new ControlClientError('control_call_failed', `heartbeat ${refusal.reason}`, 'remote-response', {
    kind: 'json-rpc-error',
    jsonRpcCode: -32_600,
    protocolCode: 'invalid_request',
    admissionReason: null,
    heartbeatRefusal: refusal,
  });
}

async function establishWith(fake: ControlClient): Promise<unknown> {
  mockedConnect.mockResolvedValueOnce(fake);
  return establishRoleControl([], TIMER, RETRY, {
    role: 'guardian',
    endpoint: '/tmp/guardian.sock',
    openMethod: 'guardian.handoff-redeem.v1',
    openParams: {},
    openParamsSchema,
    openResultSchema,
    identity: (opened) => ({ roleId: opened.roleId }),
    heartbeatMethod: 'guardian.heartbeat.v1',
    expectedIdentity: { roleId: 'guardian-1' },
  });
}

describe('role control recovery classification', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['timeout', 'write', 'closed'] as const)('classifies %s transport origin as availability', async (origin) => {
    const failure = new ControlClientError('control_call_failed', 'transport failed', origin);

    await expect(establishWith(client(async () => Promise.reject(failure)))).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-control-unavailable',
        role: 'guardian',
        stage: 'open',
        method: 'guardian.handoff-redeem.v1',
        origin,
        controlCode: 'control_call_failed',
      },
    });
  });

  it('classifies only open invalid_state plus control-active as a busy availability fact', async () => {
    await expect(
      establishWith(client(async () => Promise.reject(remoteFailure('invalid_state', 'control-active')))),
    ).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-control-busy',
        role: 'guardian',
        method: 'guardian.handoff-redeem.v1',
        protocolCode: 'invalid_state',
        admissionReason: 'control-active',
      },
    });
  });

  it.each(PROXY_CONTROL_PROTOCOL_ERROR_CODES)(
    'keeps open remote protocol code %s fatal without the exact busy reason',
    async (protocolCode) => {
      await expect(
        establishWith(client(async () => Promise.reject(remoteFailure(protocolCode, null)))),
      ).rejects.toBeInstanceOf(ProviderProxyRoleControlRemoteError);
    },
  );

  it('names an unclassified opening heartbeat as indeterminate availability', async () => {
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw remoteFailure('invalid_state', 'control-active');
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-heartbeat-indeterminate',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unclassified',
        origin: 'remote-response',
        controlCode: 'control_call_failed',
      },
    });
  });

  it('names an unanswered opening heartbeat as indeterminate availability, distinctly from an unclassified one', async () => {
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw new ControlClientError('control_call_failed', 'heartbeat timed out', 'timeout');
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-heartbeat-indeterminate',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unanswered',
        origin: 'timeout',
        controlCode: 'control_call_failed',
      },
    });
  });

  it('resynchronizes the opening heartbeat through the canonical disposition', async () => {
    const calls: Array<Readonly<{ heartbeatChallenge?: unknown }>> = [];
    const fake = client(async (_method, params) => {
      calls.push(params as Readonly<{ heartbeatChallenge?: unknown }>);
      if (calls.length === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      if (calls.length === 2) {
        throw heartbeatRefusal({ reason: 'challenge-mismatch', nextHeartbeatChallenge: 'challenge-2' });
      }
      return { state: 'active', nextHeartbeatChallenge: 'challenge-3' };
    });

    await expect(establishWith(fake)).resolves.toMatchObject({ nextHeartbeatChallenge: 'challenge-3' });
    expect(calls.slice(1)).toEqual([
      { controlEpoch: 1, heartbeatChallenge: 'challenge-1' },
      { controlEpoch: 1, heartbeatChallenge: 'challenge-2' },
    ]);
  });

  it('names the successor when opening heartbeat resynchronization is exhausted', async () => {
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw heartbeatRefusal({
        reason: 'challenge-mismatch',
        nextHeartbeatChallenge: `challenge-${calls}`,
      });
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-heartbeat-indeterminate',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'challenge-resynchronized',
        origin: 'remote-response',
        controlCode: 'control_call_failed',
      },
    });
    expect(calls).toBe(3);
  });

  it('keeps a teardown-latched opening heartbeat terminal', async () => {
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw heartbeatRefusal({ reason: 'teardown-latched', nextHeartbeatChallenge: null });
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlRemoteError',
      role: 'guardian',
      stage: 'heartbeat',
      method: 'guardian.heartbeat.v1',
      remoteFailure: {
        heartbeatRefusal: { reason: 'teardown-latched', nextHeartbeatChallenge: null },
      },
    });
  });

  it('routes an invalid opening-heartbeat frame through the canonical unclassified disposition', async () => {
    const failure = new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
      kind: 'invalid-frame',
    });
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw failure;
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-heartbeat-indeterminate',
        role: 'guardian',
        method: 'guardian.heartbeat.v1',
        incidentReason: 'unclassified',
        origin: 'remote-response',
        controlCode: 'control_call_failed',
      },
    });
  });

  it('exposes availability and remote refusal as distinct typed errors', () => {
    expect(ProviderProxyRoleControlUnavailableError).not.toBe(ProviderProxyRoleControlRemoteError);
  });

  it('rethrows a non-ControlClientError from the opening heartbeat unwrapped, as a local failure', async () => {
    // Not a disposition about the peer — this process's own encode/decode bug, guaranteed to recur
    // identically on retry. `establishHeartbeat` must not wrap it into a retryable availability error.
    const localBug = new Error('cannot encode heartbeat');
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw localBug;
    });

    await expect(establishWith(fake)).rejects.toBe(localBug);
  });

  it('treats a channel fault that arrives mid-establishment as decisive, not an indeterminate hold', async () => {
    // `control-client.ts`'s own `faulted` promise resolves the instant the channel permanently faults —
    // strictly before the same event rejects whatever call was pending. Nothing subscribes to it via
    // `observeControlClient` this early, so `establishRoleControl` must race it directly, or an open-stage
    // channel death would otherwise reach only the generic indeterminate disposition a lone RPC rejection
    // carries — and retry unboundedly against a socket that has already been destroyed.
    let resolveFaulted!: (fault: ControlClientError) => void;
    const faulted = new Promise<ControlClientError>((resolve) => {
      resolveFaulted = resolve;
    });
    let calls = 0;
    let heartbeatCallStarted = false;
    const fake: ControlClient = {
      call: async () => {
        calls += 1;
        if (calls === 1) {
          return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
        }
        heartbeatCallStarted = true;
        return new Promise(() => undefined);
      },
      faulted,
      onFault: () => () => undefined,
      close: () => undefined,
    };

    const resultPromise = establishWith(fake);
    for (let index = 0; index < 20 && !heartbeatCallStarted; index += 1) await Promise.resolve();
    expect(heartbeatCallStarted).toBe(true);

    const invalidFrame = new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
      kind: 'invalid-frame',
    });
    resolveFaulted(invalidFrame);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlRemoteError',
      role: 'guardian',
      stage: 'heartbeat',
      method: 'guardian.heartbeat.v1',
      remoteFailure: { kind: 'invalid-frame' },
    });
  });

  it('treats an ordinary channel close that arrives mid-establishment as decisive too', async () => {
    let resolveFaulted!: (fault: ControlClientError) => void;
    const faulted = new Promise<ControlClientError>((resolve) => {
      resolveFaulted = resolve;
    });
    let calls = 0;
    let heartbeatCallStarted = false;
    const fake: ControlClient = {
      call: async () => {
        calls += 1;
        if (calls === 1) {
          return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
        }
        heartbeatCallStarted = true;
        return new Promise(() => undefined);
      },
      faulted,
      onFault: () => () => undefined,
      close: () => undefined,
    };

    const resultPromise = establishWith(fake);
    for (let index = 0; index < 20 && !heartbeatCallStarted; index += 1) await Promise.resolve();
    expect(heartbeatCallStarted).toBe(true);

    const closed = new ControlClientError('control_client_closed', 'The control channel closed.', 'closed');
    resolveFaulted(closed);

    // `closed` origin cannot build a `ProviderProxyRoleControlRemoteError` (it requires `remote-response`), so
    // this routes through the same classifier `connect`/`open` failures use — a retryable
    // `ProviderProxyRoleControlUnavailableError` at the `heartbeat` stage, carrying the origin it observed.
    await expect(resultPromise).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlUnavailableError',
      incident: {
        kind: 'role-control-unavailable',
        role: 'guardian',
        stage: 'heartbeat',
        method: 'guardian.heartbeat.v1',
        origin: 'closed',
        controlCode: 'control_client_closed',
      },
    });
  });
});
