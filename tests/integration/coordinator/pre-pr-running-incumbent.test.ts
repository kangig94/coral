import { testIncarnation } from '#tests/helpers/process-incarnation.js';
// R6: cross-version handoff. The new daemon must:
//   DEGRADED: handle a journal that already contains a terminal record
//             (pre-PR daemon crashed mid-finalizer) — finalizeInterruptedAppServerJob
//             must early-return with a backendLog.warn rather than re-finalizing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { bindWithHandoff } from '#src/coordinator/handoff.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { IncumbentMatchesError, type IncumbentHealth, type IncumbentIdentity } from '#src/transport/ipc/handoff.js';
import { backendLog } from '#src/infra/backend-log.js';

const tempDirs: string[] = [];
const ipcServers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-pre-pr-incumbent-test-'));
  tempDirs.push(root);
  const path = join(root, `${name}.sock`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function startScriptedIncumbent(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => Promise<JsonRpcResponseEnvelope>,
): Promise<NetServer> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      void (async () => {
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.trim().length === 0) continue;
          const req = decode(frame);
          if (req.kind !== 'request') continue;
          const resp = await reply(req);
          socket.end(`${encode(resp)}\n`);
        }
      })().catch(() => socket.destroy());
    });
  });
  ipcServers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const server of ipcServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('pre-PR running incumbent (R6)', () => {
  it('HAPPY: contender reads verified discovery, sends transport.shutdown, incumbent exits, contender binds', async () => {
    const socketPath = makeSocketPath('happy');
    let shutdownReceived = false;
    let server: NetServer | null = null;
    server = await startScriptedIncumbent(socketPath, async (req) => {
      if (req.method === 'transport.ping') {
        return {
          kind: 'response',
          id: req.id,
          result: {
            bundleHash: 'old',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 9999,
            incarnation: testIncarnation(1_111_111),
          } satisfies IncumbentHealth,
        };
      }
      if (req.method === 'transport.shutdown') {
        shutdownReceived = true;
        expect(req.auth).toEqual({ kind: 'boot', token: 'boot-token' });
        expect(req.params).toEqual({});
        queueMicrotask(() => {
          server?.close();
        });
        return { kind: 'response', id: req.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: req.id, result: null };
    });

    const time = new VirtualTime();
    let bindCallCount = 0;
    let socketReleased = false;
    server.on('close', () => {
      socketReleased = true;
    });

    const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
      time,
      process: {
        kill: () => undefined,
        observeLiveness: () => 'alive' as const,
        readProcessIncarnation: probeProcessIncarnation,
      } as unknown as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    };

    const handoffPromise = bindWithHandoff({
      socketPath,
      desired: { version: '0.9.1', bundleHash: 'new', flavor: 'prod', namespace: 'ns' },
      bindAttempt: async () => {
        bindCallCount += 1;
        return socketReleased ? { kind: 'bound' as const } : { kind: 'incumbent' as const, reason: 'live-listener' };
      },
      runStartupRecovery: async () => [],
      runtime,
      readVerifiedIncumbentFromDiscovery: () => ({
        pid: 9999,
        incarnation: testIncarnation(1_111_111),
        source: 'discovery',
        instanceId: 'incumbent',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
      totalBudgetMs: 5_000,
    });

    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      time.tick(200);
    }

    const result = await handoffPromise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(shutdownReceived).toBe(true);
    expect(bindCallCount).toBeGreaterThan(1);
  }, 15_000);

  it('HAPPY: same version+bundle → IncumbentMatchesError (treat as redundant, not handoff)', async () => {
    const socketPath = makeSocketPath('compat');
    await startScriptedIncumbent(socketPath, async (req) => {
      if (req.method === 'transport.ping') {
        return {
          kind: 'response',
          id: req.id,
          result: {
            bundleHash: 'h1',
            version: '0.9.1',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 1,
            incarnation: testIncarnation(1),
          } satisfies IncumbentHealth,
        };
      }
      return { kind: 'response', id: req.id, result: null };
    });

    const time = new VirtualTime();
    const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
      time,
      process: {
        kill: () => undefined,
        observeLiveness: () => 'alive' as const,
        readProcessIncarnation: probeProcessIncarnation,
      } as unknown as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    };

    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
        bindAttempt: async () => ({ kind: 'incumbent' as const, reason: 'live-listener' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);
  }, 15_000);

  it('HAPPY: same bundle but older version → shutdown RPC and contender binds', async () => {
    const socketPath = makeSocketPath('same-bundle-old-version');
    let shutdownReceived = false;
    let server: NetServer | null = null;
    server = await startScriptedIncumbent(socketPath, async (req) => {
      if (req.method === 'transport.ping') {
        return {
          kind: 'response',
          id: req.id,
          result: {
            bundleHash: 'h1',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 2,
            incarnation: testIncarnation(2),
          } satisfies IncumbentHealth,
        };
      }
      if (req.method === 'transport.shutdown') {
        shutdownReceived = true;
        expect(req.auth).toEqual({ kind: 'boot', token: 'boot-token' });
        queueMicrotask(() => {
          server?.close();
        });
        return { kind: 'response', id: req.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: req.id, result: null };
    });

    const time = new VirtualTime();
    let socketReleased = false;
    server.on('close', () => {
      socketReleased = true;
    });

    const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
      time,
      process: {
        kill: () => undefined,
        observeLiveness: () => 'alive' as const,
        readProcessIncarnation: probeProcessIncarnation,
      } as unknown as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    };

    const handoffPromise = bindWithHandoff({
      socketPath,
      desired: { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
      bindAttempt: async () =>
        socketReleased ? { kind: 'bound' as const } : { kind: 'incumbent' as const, reason: 'live-listener' },
      runStartupRecovery: async () => [],
      runtime,
      readVerifiedIncumbentFromDiscovery: () => ({
        pid: 2,
        incarnation: testIncarnation(2),
        source: 'discovery',
        instanceId: 'old-version-incumbent',
        token: 'token',
        bootToken: 'boot-token',
      }),
      totalBudgetMs: 5_000,
    });

    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      time.tick(200);
    }

    const result = await handoffPromise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(shutdownReceived).toBe(true);
  }, 15_000);

  it('DEGRADED: finalizeInterruptedAppServerJob early-returns with warn when phase is already terminal', async () => {
    // We don't need a full RecoveryService instance — the warn behavior is
    // testable from a unit harness. But to keep this in the integration
    // suite (where AC4 cross-version is documented), we exercise the actual
    // method via a minimal dependency stub.
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    try {
      const { RecoveryService } = await import('#src/coordinator/services/recovery/service.js');

      const progressStore = {
        readStatus: () => ({ jobId: 'j1', phase: 'completed' as const }),
      };
      const deps = {
        progressStore,
        providerRegistry: { get: () => undefined },
        sessionManager: { get: () => undefined },
        runtime: { storage: {} },
      } as unknown as ConstructorParameters<typeof RecoveryService>[0];

      const service = new RecoveryService(deps);

      const authority = {
        launchRecord: { jobId: 'j1' },
        session: {},
        boundProvider: {},
      } as unknown as Parameters<typeof service.finalizeInterruptedAppServerJob>[0];
      const runtimeRecord = {
        kind: 'app-server' as const,
        providerMeta: { leaseState: 'acquired' },
      } as unknown as Parameters<typeof service.finalizeInterruptedAppServerJob>[1];

      await service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
        reason: 'handoff',
        signal: new AbortController().signal,
        onCommitStart: vi.fn(),
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0][0];
      expect(warnArg).toContain('skipping finalize for already-terminal job j1');
      expect(warnArg).toContain('during handoff recovery');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('DEGRADED: warn does NOT fire when reason is restart (only handoff path)', async () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    try {
      const { RecoveryService } = await import('#src/coordinator/services/recovery/service.js');
      const progressStore = {
        readStatus: () => ({ jobId: 'j1', phase: 'completed' as const }),
      };
      const deps = {
        progressStore,
        providerRegistry: { get: () => undefined },
        sessionManager: { get: () => undefined },
        runtime: { storage: {} },
      } as unknown as ConstructorParameters<typeof RecoveryService>[0];

      const service = new RecoveryService(deps);

      const authority = {
        launchRecord: { jobId: 'j1' },
        session: {},
        boundProvider: {},
      } as unknown as Parameters<typeof service.finalizeInterruptedAppServerJob>[0];
      const runtimeRecord = {
        kind: 'app-server' as const,
        providerMeta: { leaseState: 'acquired' },
      } as unknown as Parameters<typeof service.finalizeInterruptedAppServerJob>[1];

      await service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
        reason: 'restart',
        signal: new AbortController().signal,
        onCommitStart: vi.fn(),
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// Use the IncumbentIdentity type so unused-import does not get flagged when
// future tests expand to discovery-fed cases.
const _identityShape: IncumbentIdentity = { pid: 1, incarnation: testIncarnation(1), source: 'health' };
void _identityShape;
