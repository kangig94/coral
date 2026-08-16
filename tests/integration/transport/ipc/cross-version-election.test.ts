import { testIncarnation } from '#tests/helpers/process-incarnation.js';
// Daemon-side bind-path election (BLOCKING 1 / BLOCKING 2 from the
// cross-version-coordinator-continuity review): `bindWithHandoff`
// (`src/coordinator/handoff.ts`) must apply the same product-version
// precedence the CLI target-routing path already applies
// (`src/infra/backend-routing.ts`), so that:
//   - two same-version builds with different bundle hashes never both
//     conclude the other side should be evicted (the data-destroying loop);
//   - an older build never evicts a healthy newer incumbent;
//   - a newer build still takes over from a healthy older incumbent.
//
// Uses real sockets end to end: a scripted "incumbent" IPC server plus the
// real `bindSocket`/`bindWithHandoff` implementation. No mocked
// `requestIncumbentShutdown`.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindWithHandoff } from '#src/coordinator/handoff.js';
import { bindSocket } from '#src/transport/ipc/server.js';
import { IncumbentMatchesError, type IncumbentHealth } from '#src/transport/ipc/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import type { Runtime } from '#src/runtime/ports.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-cross-version-election-'));
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
          const request = decode(frame);
          if (request.kind !== 'request') continue;
          const response = await reply(request);
          socket.end(`${encode(response)}\n`);
        }
      })().catch(() => socket.destroy());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

function noSignalRuntime(): Pick<Runtime, 'time' | 'process' | 'env'> {
  return {
    time: createRealTimePort(),
    process: {
      kill: () => {
        throw new Error('signal escalation must not be reached in this scenario');
      },
      observeLiveness: () => 'alive' as const,
    } as unknown as Runtime['process'],
    env: { platform: () => 'linux' } as unknown as Runtime['env'],
  };
}

/** A `bindAttempt` that performs a real socket bind against `socketPath`. */
function realBindAttempt(socketPath: string): () => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }> {
  return async () => {
    const probe = createServer();
    const result = await bindSocket(probe, socketPath);
    if (result.kind === 'bound') {
      servers.push(probe);
    }
    return result;
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-version election on the daemon bind path', () => {
  it('two same-version builds with different bundle hashes converge on a single owner without evicting each other', async () => {
    const socketPath = makeSocketPath('same-version');
    let shutdownRequests = 0;
    const incumbent = await startScriptedIncumbent(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '2.1.0',
            bundleHash: 'build-A-hash',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 111,
            incarnation: testIncarnation(222),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        shutdownRequests += 1;
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    // Contender B: same product version as the running incumbent A, but a
    // different bundleHash — exactly what an ordinary rebuild without a
    // version bump produces.
    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '2.1.0', bundleHash: 'build-B-hash', flavor: 'prod', namespace: 'ns' },
        bindAttempt: realBindAttempt(socketPath),
        runStartupRecovery: async () => [],
        runtime: noSignalRuntime(),
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);

    // The defining property: A was never asked to step down, and stays the
    // one listening incumbent. Two builds racing this same scenario forever
    // (repeated rebuilds) therefore converge on whichever build bound first
    // instead of alternating SIGTERM/SIGKILL evictions that reset the store
    // on every lap.
    expect(shutdownRequests).toBe(0);
    expect(incumbent.listening).toBe(true);
  });

  it('the same convergence holds from the other side of the pair', async () => {
    // Same shape as above with the roles' bundle hashes swapped, proving the
    // deferral is not an artifact of which build happened to bind the
    // real socket first in this test file.
    const socketPath = makeSocketPath('same-version-reverse');
    let shutdownRequests = 0;
    const incumbent = await startScriptedIncumbent(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '2.1.0',
            bundleHash: 'build-B-hash',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 333,
            incarnation: testIncarnation(444),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        shutdownRequests += 1;
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '2.1.0', bundleHash: 'build-A-hash', flavor: 'prod', namespace: 'ns' },
        bindAttempt: realBindAttempt(socketPath),
        runStartupRecovery: async () => [],
        runtime: noSignalRuntime(),
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);

    expect(shutdownRequests).toBe(0);
    expect(incumbent.listening).toBe(true);
  });

  it('an older build does not evict a healthy newer incumbent', async () => {
    const socketPath = makeSocketPath('older-contender');
    let shutdownRequests = 0;
    const incumbent = await startScriptedIncumbent(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '3.0.0',
            bundleHash: 'newer-hash',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 555,
            incarnation: testIncarnation(666),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        shutdownRequests += 1;
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '2.9.0', bundleHash: 'older-hash', flavor: 'prod', namespace: 'ns' },
        bindAttempt: realBindAttempt(socketPath),
        runStartupRecovery: async () => [],
        runtime: noSignalRuntime(),
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);

    expect(shutdownRequests).toBe(0);
    expect(incumbent.listening).toBe(true);
  });

  it('a newer build still takes over from a healthy older incumbent', async () => {
    const socketPath = makeSocketPath('newer-contender');
    let shutdownRequests = 0;
    let incumbentServer: NetServer | null = null;
    incumbentServer = await startScriptedIncumbent(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '1.0.0',
            bundleHash: 'old-hash',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 777,
            incarnation: testIncarnation(888),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        shutdownRequests += 1;
        expect(request.auth).toEqual({ kind: 'boot', token: 'boot-token' });
        // Release the socket so the contender's next bind attempt succeeds —
        // the accepted proxy for "the older daemon actually drained".
        queueMicrotask(() => incumbentServer?.close());
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await bindWithHandoff({
      socketPath,
      desired: { version: '2.0.0', bundleHash: 'new-hash', flavor: 'prod', namespace: 'ns' },
      bindAttempt: realBindAttempt(socketPath),
      runStartupRecovery: async () => [],
      runtime: noSignalRuntime(),
      readVerifiedIncumbentFromDiscovery: () => ({
        pid: 777,
        incarnation: testIncarnation(888),
        source: 'discovery',
        instanceId: 'older-incumbent',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
      totalBudgetMs: 5_000,
    });

    expect(result.acquiredViaHandoff).toBe(true);
    expect(shutdownRequests).toBeGreaterThanOrEqual(1);
  });
});
