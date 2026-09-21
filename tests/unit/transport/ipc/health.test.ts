import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import type { TimePort } from '#src/infra/port-types.js';
import type { CoordinatorHealthIdentity } from '#src/transport/ipc/health.js';

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  health: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

const timePort = {} as TimePort;

function discovery(overrides: Partial<CoordinatorDiscoveryRecord> = {}): CoordinatorDiscoveryRecord {
  return {
    pid: 4242,
    port: 4312,
    socketPath: '/tmp/coral.sock',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'namespace',
    startedAt: 1,
    token: 'token',
    bootToken: 'boot-token',
    version: '1.2.3',
    instanceId: 'instance-id',
    ...overrides,
  };
}

function identity(overrides: Partial<CoordinatorHealthIdentity> = {}): CoordinatorHealthIdentity {
  return {
    instanceId: 'instance-id',
    version: '1.2.3',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'namespace',
    pid: 4242,
    ...overrides,
  };
}

describe('readIdentityCheckedAuthenticatedHealth', () => {
  beforeEach(() => {
    mockState.createIpcClient.mockReset().mockReturnValue({ health: mockState.health, ping: mockState.ping });
    mockState.health.mockReset();
    mockState.ping.mockReset();
  });

  it('uses the discovery boot token and verifies the expected identity before and after health.read', async () => {
    const reply = { value: 'health' };
    const decode = vi.fn(() => ({ health: reply, identity: identity() }));
    mockState.health.mockResolvedValue(reply);

    const { readIdentityCheckedAuthenticatedHealth } = await import('#src/transport/ipc/health.js');
    const result = await readIdentityCheckedAuthenticatedHealth(
      discovery(),
      '/tmp/coral.sock',
      identity(),
      timePort,
      decode,
    );

    expect(result).toEqual({ kind: 'health', health: reply });
    expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral.sock', timePort, {
      kind: 'boot',
      token: 'boot-token',
    });
    expect(mockState.health).toHaveBeenCalledWith({ timeoutMs: 3_000 });
    expect(mockState.ping).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledWith(reply);
  });

  it.each([
    ['a missing instance id', discovery({ instanceId: undefined }), '/tmp/coral.sock', null],
    ['a missing version', discovery({ version: undefined }), '/tmp/coral.sock', null],
    ['a different expected socket', discovery(), '/tmp/other.sock', identity()],
    ['a discovery identity mismatch', discovery(), '/tmp/coral.sock', identity({ instanceId: 'other' })],
  ] as const)('refuses %s before dialing', async (_name, record, expectedSocketPath, expectedIdentity) => {
    const { readIdentityCheckedAuthenticatedHealth } = await import('#src/transport/ipc/health.js');

    await expect(
      readIdentityCheckedAuthenticatedHealth(record, expectedSocketPath, expectedIdentity, timePort, () => ({
        health: {},
        identity: identity(),
      })),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(mockState.createIpcClient).not.toHaveBeenCalled();
  });

  it('rejects an authenticated answer whose identity changed after the call', async () => {
    mockState.health.mockResolvedValue({});

    const { readIdentityCheckedAuthenticatedHealth } = await import('#src/transport/ipc/health.js');

    await expect(
      readIdentityCheckedAuthenticatedHealth(discovery(), '/tmp/coral.sock', identity(), timePort, () => ({
        health: {},
        identity: identity({ instanceId: 'replacement' }),
      })),
    ).resolves.toEqual({ kind: 'unavailable', cause: 'identity-mismatch' });
    expect(mockState.createIpcClient).toHaveBeenCalledOnce();
  });

  it('returns neutral unavailability when authenticated transport fails', async () => {
    mockState.health.mockRejectedValue(new Error('boot token rejected'));
    const decode = vi.fn();

    const { readIdentityCheckedAuthenticatedHealth } = await import('#src/transport/ipc/health.js');

    await expect(
      readIdentityCheckedAuthenticatedHealth(discovery(), '/tmp/coral.sock', identity(), timePort, decode),
    ).resolves.toEqual({ kind: 'unavailable', cause: 'transport-failure' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('returns neutral unavailability when the caller cannot validate the health projection', async () => {
    mockState.health.mockResolvedValue({ malformed: true });

    const { readIdentityCheckedAuthenticatedHealth } = await import('#src/transport/ipc/health.js');

    await expect(
      readIdentityCheckedAuthenticatedHealth(discovery(), '/tmp/coral.sock', identity(), timePort, () => null),
    ).resolves.toEqual({ kind: 'unavailable', cause: 'health-shape-rejected' });
  });
});
