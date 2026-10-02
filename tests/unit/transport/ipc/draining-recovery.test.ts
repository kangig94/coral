import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { createIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const setIdentity = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};

function createDrainingPorts(): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'token',
      bootToken: 'boot-token',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      getLifecycleState: () => 'draining',
      isLifecycleRunning: () => false,
      isDrainRequested: () => true,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
    },
    jobs: { list: vi.fn(() => []) },
    providerProxySets: { contain: vi.fn() },
  } as unknown as HttpHandlerPorts;
}

function socketDouble(): Socket {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    resume: vi.fn(),
    write: vi.fn(() => true),
    end() {
      socket.writableEnded = true;
      socket.emit('finish');
      socket.destroy();
    },
    destroy() {
      if (socket.destroyed) return;
      socket.destroyed = true;
      socket.emit('close');
    },
  });
  return socket as unknown as Socket;
}

function sendRequest(socket: Socket, method: string, params: unknown): void {
  socket.emit(
    'data',
    Buffer.from(
      `${JSON.stringify({
        kind: 'request',
        id: 1,
        method,
        params,
        auth: { kind: 'boot', token: 'boot-token' },
      })}\n`,
    ),
  );
}

describe('draining IPC recovery ingress', () => {
  it('wakes retained shutdown once after a disconnected admitted operation completes', async () => {
    const ports = createDrainingPorts();
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    let finishContainment!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishContainment = resolve;
    });
    ports.providerProxySets!.contain = vi.fn(async () => {
      markAdmitted();
      await completion;
      return {
        kind: 'contained',
        setIdentity,
        disappearanceReceipt: 'receipt',
        claimDischarge: { kind: 'completed' },
        effect: { signalsSent: [], containmentAbsent: true, representationAction: 'absence-release-started' },
      } as const;
    });
    const listener = createIpcServer(ports);
    let resumeShutdown!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resumeShutdown = resolve;
    });
    const wakeRetainedShutdown = vi.fn(resumeShutdown);
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const socket = socketDouble();
    listener.acceptSocket!(socket);

    try {
      sendRequest(socket, 'coordinator.provider_proxy_set.contain.v2', { setIdentity, mode: 'contain' });
      await admitted;
      socket.destroy();
      expect(wakeRetainedShutdown).not.toHaveBeenCalled();
      finishContainment();
      await resumed;
      socket.emit('finish');
      socket.emit('close');
      expect(wakeRetainedShutdown).toHaveBeenCalledOnce();
      expect(listener.sockets.size).toBe(0);
    } finally {
      finishContainment();
      socket.destroy();
    }
  });

  it('rejects a non-admitted route before invoking its port', async () => {
    const ports = createDrainingPorts();
    const listener = createIpcServer(ports);
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const socket = socketDouble();
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    listener.acceptSocket!(socket);

    try {
      sendRequest(socket, 'jobs.list', { projectRoot: '/project' });
      await closed;
      const response = JSON.parse(String(vi.mocked(socket.write).mock.calls[0][0]));
      expect(response.result).toMatchObject({ code: 'backend_shutting_down' });
      expect(ports.jobs.list).not.toHaveBeenCalled();
      expect(wakeRetainedShutdown).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
    }
  });
});
