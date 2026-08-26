import { testIncarnation } from '#tests/helpers/process-incarnation.js';
// AC2/AC3 happy-path handoff integration coverage. No real daemon spawn —
// uses VirtualTime + node:net listener fakes.

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
import { backendLog } from '#src/infra/backend-log.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { IncumbentHealth } from '#src/transport/ipc/handoff.js';

const tempDirs: string[] = [];
const liveServers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-handoff-int-test-'));
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
  liveServers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const server of liveServers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff integration (AC2 + AC3 happy path)', () => {
  it('mismatched bundle: shutdown RPC → incumbent exits → contender binds → no EADDRINUSE log', async () => {
    const socketPath = makeSocketPath('full-swap');
    let incumbentServer: NetServer | null = null;
    let socketReleased = false;

    incumbentServer = await startScriptedIncumbent(socketPath, async (req) => {
      if (req.method === 'transport.ping') {
        return {
          kind: 'response',
          id: req.id,
          result: {
            bundleHash: 'old-bundle',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 12345,
            incarnation: testIncarnation(999_999),
          } satisfies IncumbentHealth,
        };
      }
      if (req.method === 'transport.shutdown') {
        expect(req.auth).toEqual({ kind: 'boot', token: 'boot-token' });
        expect(req.params).toEqual({});
        queueMicrotask(() => {
          incumbentServer?.close();
        });
        return { kind: 'response', id: req.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: req.id, result: null };
    });
    incumbentServer.on('close', () => {
      socketReleased = true;
    });

    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);

    try {
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

      const handoffPromise = bindWithHandoff({
        socketPath,
        desired: { version: '0.9.1', bundleHash: 'new-bundle', flavor: 'prod', namespace: 'ns' },
        bindAttempt: async () =>
          socketReleased ? { kind: 'bound' as const } : { kind: 'incumbent' as const, reason: 'live-listener' },
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => ({
          pid: 12345,
          incarnation: testIncarnation(999_999),
          source: 'discovery',
          instanceId: 'incumbent',
          token: 'token',
          bootToken: 'boot-token',
          shutdownToken: 'shutdown-token',
        }),
        totalBudgetMs: 5_000,
      });

      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        time.tick(200);
      }

      const result = await handoffPromise;
      expect(result.acquiredViaHandoff).toBe(true);

      // No `Fatal startup error: listen EADDRINUSE` was logged on the
      // contender side: the EADDRINUSE was caught and routed to handoff,
      // not surfaced as a fatal error. (AC2)
      const errorCalls = errorSpy.mock.calls.map((c) => String(c[0] ?? ''));
      expect(errorCalls.some((m) => m.includes('Fatal startup error') && m.includes('EADDRINUSE'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  }, 15_000);
});
