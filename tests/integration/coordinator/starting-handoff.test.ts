// Phase C: when a contender's `transport.shutdown` arrives at a still-`starting`
// incumbent, lifecycle shutdown must fire IMMEDIATELY via the
// `onShutdownRequest` callback — not defer until idle-timer drain
// (`startWatching`) is installed.
//
// This is an integration-level concern but does not need a real daemon: the
// IPC server's contract is "invoke `onShutdownRequest` synchronously when
// `transport.shutdown` is dispatched, regardless of lifecycle state".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closeIpcServer, createIpcServer, listenIpcServer, type IpcListener } from '#src/transport/ipc/server.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts, HealthSnapshot } from '#src/transport/server-ports.js';

const tempDirs: string[] = [];
const liveListeners: IpcListener[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-starting-handoff-test-'));
  tempDirs.push(root);
  const path = join(root, `${name}.sock`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function buildPorts(opts: {
  isLifecycleRunning: () => boolean;
  isDrainRequested: () => boolean;
  onRequestDrain: (reason: string) => void;
}): HttpHandlerPorts {
  const health: HealthSnapshot = {
    status: 'starting',
    kernel: { phase: 'starting', readyAt: null },
    version: '0.0.0',
    bundleHash: 'h',
    flavor: 'prod',
    namespace: 'ns',
    instanceId: 'i',
    pid: 1,
    uptimeMs: 0,
    active: 0,
    activeJobs: 0,
    liveDiscuss: 0,
    queueDepth: 0,
    inflightRequests: 0,
    textProjectionState: 'idle',
    env: {},
    subsystems: [{ id: 'kb', phase: 'offline', reason: 'test' }],
  };
  return {
    identity: {
      pluginRoot: '/p',
      token: 't',
      shutdownToken: 'shutdown-token',
      version: '0.0.0',
      bundleHash: 'h',
      flavor: 'prod',
      namespace: 'ns',
      instanceId: 'i',
      now: () => 0,
      log: () => undefined,
    },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: opts.isLifecycleRunning,
      isDrainRequested: opts.isDrainRequested,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: opts.onRequestDrain,
    },
    health: { read: () => health },
    events: {
      addResponse: vi.fn(),
      removeResponse: vi.fn(),
      bus: {
        on: vi.fn().mockReturnThis(),
        off: vi.fn().mockReturnThis(),
      } as unknown as HttpHandlerPorts['events']['bus'],
      createStreamId: () => 's',
      nowIsoString: () => '0',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    sessions: {} as never,
    jobs: {} as never,
    workflows: {} as never,
    kb: {} as never,
    discuss: {} as never,
    expansion: {} as never,
  };
}

afterEach(async () => {
  for (const listener of liveListeners.splice(0)) {
    try {
      await closeIpcServer(listener);
    } catch {
      // best-effort
    }
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('starting-incumbent transport.shutdown handoff', () => {
  it('invokes onShutdownRequest immediately while lifecycle is still starting', async () => {
    const socketPath = makeSocketPath('starting');
    let drainCalled = false;
    let onShutdownCalled = false;
    let lifecycle: 'starting' | 'running' | 'draining' = 'starting';

    const ports = buildPorts({
      isLifecycleRunning: () => lifecycle === 'running',
      isDrainRequested: () => lifecycle === 'draining',
      onRequestDrain: () => {
        drainCalled = true;
      },
    });
    const ipcServer = createIpcServer(ports);
    ipcServer.onShutdownRequest = (reason) => {
      onShutdownCalled = true;
      // Composition wires this to `lifecycleController.shutdown(reason)`.
      // For the assertion we just flip lifecycle to 'draining'.
      lifecycle = 'draining';
      void reason;
    };
    await listenIpcServer(ipcServer, socketPath);
    liveListeners.push(ipcServer);

    // Contender sends transport.shutdown.
    const client = createIpcClient(socketPath);
    const result = await client.shutdown<{ status: string }>(
      { shutdownToken: 'shutdown-token' },
      { timeoutMs: 1_000 },
    );
    expect(result).toMatchObject({ status: 'draining' });
    // The callback ran synchronously alongside requestDrain.
    expect(onShutdownCalled).toBe(true);
    expect(drainCalled).toBe(true);
    expect(lifecycle).toBe('draining');
  });

  it('also invokes onShutdownRequest while lifecycle is running', async () => {
    const socketPath = makeSocketPath('running');
    let onShutdownCalled = false;
    let lifecycle: 'running' | 'draining' = 'running';

    const ports = buildPorts({
      isLifecycleRunning: () => lifecycle === 'running',
      isDrainRequested: () => lifecycle === 'draining',
      onRequestDrain: () => undefined,
    });
    const ipcServer = createIpcServer(ports);
    ipcServer.onShutdownRequest = () => {
      onShutdownCalled = true;
      lifecycle = 'draining';
    };
    await listenIpcServer(ipcServer, socketPath);
    liveListeners.push(ipcServer);

    const client = createIpcClient(socketPath);
    await client.shutdown<{ status: string }>({ shutdownToken: 'shutdown-token' }, { timeoutMs: 1_000 });
    expect(onShutdownCalled).toBe(true);
  });
});
