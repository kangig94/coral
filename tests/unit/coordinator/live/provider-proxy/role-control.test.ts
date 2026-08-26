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

  it('keeps an opening heartbeat JSON-RPC error fatal to that acquisition attempt', async () => {
    let calls = 0;
    const fake = client(async () => {
      calls += 1;
      if (calls === 1) {
        return { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' };
      }
      throw remoteFailure('invalid_state', 'control-active');
    });

    await expect(establishWith(fake)).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlRemoteError',
      role: 'guardian',
      stage: 'heartbeat',
      method: 'guardian.heartbeat.v1',
    });
  });

  it('keeps an invalid remote frame fatal', async () => {
    const failure = new ControlClientError('control_call_failed', 'invalid frame', 'remote-response', {
      kind: 'invalid-frame',
    });

    await expect(establishWith(client(async () => Promise.reject(failure)))).rejects.toBeInstanceOf(
      ProviderProxyRoleControlRemoteError,
    );
  });

  it('exposes availability and remote refusal as distinct typed errors', () => {
    expect(ProviderProxyRoleControlUnavailableError).not.toBe(ProviderProxyRoleControlRemoteError);
  });
});
