import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { bindWithHandoff } from '#src/coordinator/handoff.js';
import { bindPublishedSocket, bindSocket } from '#src/transport/ipc/server.js';
import { createCoordinatorSocketAddressClaim } from '#src/coordinator/socket-address-claim.js';
import { v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { IncumbentMatchesError, type IncumbentHealth } from '#src/transport/ipc/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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
      readProcessIncarnation: probeProcessIncarnation,
    } as unknown as Runtime['process'],
    env: { platform: () => 'linux' } as unknown as Runtime['env'],
  };
}

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
  it('claims a v0.10.3 fallback socket published under another TMPDIR before binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-cross-version-legacy-'));
    tempDirs.push(root);
    const oldTemp = join(root, 'old');
    const newTemp = join(root, 'new');
    mkdirSync(oldTemp);
    mkdirSync(newTemp);
    const runtime = createRealRuntime('prod', { baseDir: join(root, 'long'.repeat(30)) });
    const paths = runtime.paths.coral.coordinator;
    const legacy = v0109CoordinatorSocketGuardSetForRunDir(paths.legacyRunDir, 'prod', {
      platform: 'linux',
      configuredTempDirectory: oldTemp,
      systemTempDirectory: oldTemp,
    });
    if (legacy.kind !== 'guarded-addresses') throw new Error('expected a legacy fallback socket');
    const legacySocketPath = legacy.paths[0];
    if (legacySocketPath === undefined) throw new Error('expected a legacy fallback address');
    const incumbent = await startScriptedIncumbent(legacySocketPath, async (request) => ({
      kind: 'response',
      id: request.id,
      result: null,
    }));
    mkdirSync(paths.legacyRunDir, { recursive: true });
    const discovery = {
      pid: process.pid,
      port: 1,
      socketPath: legacySocketPath,
      bundleHash: 'legacy',
      flavor: 'prod',
      namespace: 'legacy',
      startedAt: Date.now(),
      token: 'token',
      bootToken: 'boot-token',
    };
    writeFileSync(paths.legacyInfoFile, JSON.stringify(discovery));
    const contenderRuntime = {
      ...runtime,
      env: {
        ...runtime.env,
        get: (name: string) => (name === 'TMPDIR' ? newTemp : runtime.env.get(name)),
        tmpdir: () => newTemp,
      },
    };
    const claim = createCoordinatorSocketAddressClaim(contenderRuntime, 'cross-version election');
    const result = await claim.acquire(async (additional, published) => {
      const bound: NetServer[] = [];
      for (const socketPath of [paths.socketPath, ...additional]) {
        const server = createServer();
        const attempt = await bindSocket(server, socketPath);
        if (attempt.kind === 'incumbent') return { kind: 'incumbent' as const, socketPath };
        bound.push(server);
        servers.push(server);
      }
      for (const address of published) {
        const server = createServer();
        const attempt = await bindPublishedSocket(server, address);
        if (attempt.kind === 'incumbent') return { kind: 'incumbent' as const, socketPath: address.socketPath };
        bound.push(server);
        servers.push(server);
      }
      return {
        kind: 'held' as const,
        release: async () =>
          Promise.all(bound.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(
            () => undefined,
          ),
      };
    });

    expect(result).toEqual({ kind: 'incumbent', socketPath: legacySocketPath });
    expect(incumbent.listening).toBe(true);

    writeFileSync(paths.legacyInfoFile, JSON.stringify({ ...discovery, socketPath: join(oldTemp, 'foreign.sock') }));
    expect(() => createCoordinatorSocketAddressClaim(contenderRuntime, 'cross-version election')).toThrow(
      /outside Coral's coordinator namespace/u,
    );
  });

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
});
