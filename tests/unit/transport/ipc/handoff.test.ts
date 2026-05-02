// Unit coverage for the transport-owned `requestIncumbentShutdown` helper:
// absolute deadline behavior across connect+health+shutdown, compatible-incumbent
// detection, and the IpcDeadlineExceededError surface.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IncumbentMatchesError,
  isCompatibleIncumbent,
  IpcDeadlineExceededError,
  requestIncumbentShutdown,
  type IncumbentHealth,
  type DesiredIncumbentIdentity,
} from '#src/transport/ipc/handoff.js';
import { decode, encode, type JsonRpcRequestEnvelope, type JsonRpcResponseEnvelope } from '#src/transport/ipc/json-rpc.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-handoff-test-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

async function startScriptedServer(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => Promise<JsonRpcResponseEnvelope | null>,
): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
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
          if (response === null) return; // server hangs
          socket.end(`${encode(response)}\n`);
        }
      })().catch(() => {
        socket.destroy();
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('isCompatibleIncumbent', () => {
  it('matches on bundleHash + flavor + namespace', () => {
    const desired: DesiredIncumbentIdentity = { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    expect(isCompatibleIncumbent(health, desired)).toBe(true);
  });

  it('rejects on bundleHash mismatch', () => {
    const desired: DesiredIncumbentIdentity = { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { bundleHash: 'h2', flavor: 'prod', namespace: 'ns' };
    expect(isCompatibleIncumbent(health, desired)).toBe(false);
  });
});

describe('requestIncumbentShutdown', () => {
  it('throws IncumbentMatchesError on compatible non-draining incumbent', async () => {
    const socketPath = makeSocketPath('compat');
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.health') {
        return {
          kind: 'response',
          id: request.id,
          result: { bundleHash: 'h1', flavor: 'prod', namespace: 'ns', status: 'ok' } satisfies IncumbentHealth,
        };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    await expect(
      requestIncumbentShutdown({
        socketPath,
        desired: { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);
  });

  it('mismatched bundle: returns last health and forwards transport.shutdown', async () => {
    const socketPath = makeSocketPath('mismatch');
    let receivedShutdown = false;
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.health') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            bundleHash: 'old',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 4242,
            processStartedAt: 9_999,
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        receivedShutdown = true;
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { bundleHash: 'new', flavor: 'prod', namespace: 'ns' },
      timeoutMs: 1_000,
    });
    expect(receivedShutdown).toBe(true);
    expect(result.health?.bundleHash).toBe('old');
    expect(result.verifiedIdentity).toEqual({ pid: 4242, processStartedAt: 9_999, source: 'health' });
  });

  it('compatible draining incumbent does NOT throw IncumbentMatchesError', async () => {
    const socketPath = makeSocketPath('draining');
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.health') {
        return {
          kind: 'response',
          id: request.id,
          result: { bundleHash: 'h1', flavor: 'prod', namespace: 'ns', status: 'draining' } satisfies IncumbentHealth,
        };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
      timeoutMs: 500,
    });
    expect(result.health?.status).toBe('draining');
  });

  it('absolute deadline: slow connect+hung-response does NOT receive a fresh full timeout', async () => {
    const socketPath = makeSocketPath('hung');
    await startScriptedServer(socketPath, async () => {
      // Hang forever on every request.
      return null;
    });

    const start = Date.now();
    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    // Both health and shutdown share the same 500ms budget. A buggy
    // implementation that gives EACH step a fresh full timeout would run
    // for ~500+500=1000ms (or 1500ms with retries); an absolute-deadline
    // implementation bounds to a single budget multiple. Allow ample slack
    // for parallel-test event-loop contention.
    expect(elapsed).toBeLessThan(900);
    // Health was unreachable; helper returns null health and null verifiedIdentity.
    expect(result.health).toBeNull();
    expect(result.verifiedIdentity).toBeNull();
  });

  it('IpcDeadlineExceededError class exists and carries name', () => {
    const e = new IpcDeadlineExceededError('budget exhausted');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('IpcDeadlineExceededError');
    expect(e.message).toBe('budget exhausted');
  });
});
