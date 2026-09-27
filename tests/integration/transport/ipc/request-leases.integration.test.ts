import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestLeaseOwner } from '#src/coordinator/live/request-leases.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { IpcRpcError, requestIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';

const directories: string[] = [];

function socketPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-red-request-lease-'));
  directories.push(directory);
  return join(directory, 'coordinator.sock');
}

function ports(): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'unused-for-ipc',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: '0.10.13',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(),
    },
    health: {
      read: () => ({
        status: 'ok',
        kernel: { phase: 'running', readyAt: 0 },
        version: '0.10.13',
        bundleHash: 'test-hash',
        flavor: 'prod',
        namespace: 'test-namespace',
        instanceId: 'test-instance',
        pid: 12345,
        uptimeMs: 1,
        active: 0,
        liveDiscuss: 0,
        queueDepth: 0,
        inflightRequests: 0,
        textProjectionState: 'idle',
        env: {},
        components: [],
      }),
    },
  } as unknown as HttpHandlerPorts;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('IPC request leases', () => {
  it('bounds a never-settling KB daemon restart request', async () => {
    const serverPorts = ports();
    serverPorts.admin.beginRequestLease = createRequestLeaseOwner({
      time: createRealTimePort(),
      begin: serverPorts.admin.beginRequest,
      end: serverPorts.admin.endRequest,
      timing: { defaultMs: 40, kbMutationMs: 400, settleMs: 10, checkMs: 2, schedulingGapMs: 20 },
    }).begin;
    serverPorts.admin.restartKbDaemon = async () => new Promise<never>(() => {});
    const listener = createIpcServer(serverPorts);
    const address = socketPath();
    await listenIpcServer(listener, address);
    try {
      const request = requestIpcMethod(
        address,
        'transport.kb.restart',
        {},
        { auth: { kind: 'boot', token: 'boot-token' } },
      );
      const outcome = await Promise.race([
        request.then(
          () => ({ kind: 'response' as const }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
      ]);
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') {
        expect(outcome.error).toBeInstanceOf(IpcRpcError);
        expect(outcome.error).toMatchObject({ code: 'request_deadline_exceeded' });
      }
      expect(serverPorts.admin.endRequest).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });
});
