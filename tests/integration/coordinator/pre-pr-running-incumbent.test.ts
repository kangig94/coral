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
import { createRealTimePort } from '#src/infra/time.js';
import { bindWithHandoff } from '#src/coordinator/handoff.js';
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
  it('a newer contender concedes to a serving older incumbent without sending shutdown', async () => {
    const socketPath = makeSocketPath('serving');
    const methods: string[] = [];
    const server = await startScriptedIncumbent(socketPath, async (req) => {
      methods.push(req.method);
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
    });
    const kill = vi.fn();
    const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
      time: createRealTimePort(),
      process: { kill, observeLiveness: () => 'alive' } as unknown as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    };

    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '0.9.1', bundleHash: 'new', flavor: 'prod', namespace: 'ns' },
        bindAttempt: async () => ({ kind: 'incumbent', reason: 'live-listener' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);

    expect(methods).toEqual(['transport.ping']);
    expect(server.listening).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

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
