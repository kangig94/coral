import { testIncarnation } from '#tests/helpers/process-incarnation.js';
// Unit coverage for the transport-owned `requestIncumbentShutdown` helper:
// absolute deadline behavior across connect+ping+shutdown, compatible-incumbent
// detection, and the IpcDeadlineExceededError surface.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IncumbentMatchesError,
  incumbentOutranksContender,
  IpcDeadlineExceededError,
  requestIncumbentShutdown,
  type IncumbentHealth,
  type DesiredIncumbentIdentity,
} from '#src/transport/ipc/handoff.js';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';

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

describe('incumbentOutranksContender', () => {
  it('outranks on exact version match regardless of bundleHash', () => {
    const desired: DesiredIncumbentIdentity = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    expect(incumbentOutranksContender(health, desired)).toBe(true);
  });

  it('outranks at equal version even with a different bundleHash — the BLOCKING-1 cycle trigger', () => {
    // A rebuild without a version bump: same version, different bundleHash.
    // A version difference alone must never be an eviction reason, so the
    // incumbent still outranks the contender here — evicting it would trade
    // a healthy coordinator for one that is not an upgrade.
    const desired: DesiredIncumbentIdentity = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { version: '0.9.1', bundleHash: 'h2', flavor: 'prod', namespace: 'ns' };
    expect(incumbentOutranksContender(health, desired)).toBe(true);
  });

  it('does not outrank when the contender is strictly newer', () => {
    const desired: DesiredIncumbentIdentity = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { version: '0.8.7', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    expect(incumbentOutranksContender(health, desired)).toBe(false);
  });

  it('outranks when the incumbent is strictly newer — an older build must not evict a healthy newer incumbent', () => {
    const desired: DesiredIncumbentIdentity = { version: '0.8.7', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    expect(incumbentOutranksContender(health, desired)).toBe(true);
  });

  it('does not outrank on flavor or namespace mismatch even at a same-or-newer version', () => {
    const desired: DesiredIncumbentIdentity = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    expect(
      incumbentOutranksContender({ version: '0.9.1', bundleHash: 'h1', flavor: 'dev', namespace: 'ns' }, desired),
    ).toBe(false);
    expect(
      incumbentOutranksContender(
        { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'other-ns' },
        desired,
      ),
    ).toBe(false);
  });

  it('does not outrank when the incumbent reported no version at all', () => {
    // The one guard the cases above leave open, and the only one that is not a comparison: an incumbent whose
    // health reply carried no version cannot be ranked against anything. Deferring to it would hand the socket
    // to a coordinator that never proved it was an upgrade, so the unrankable answer is "does not outrank" —
    // and it must come from this guard, not from feeding `undefined` into the version comparison.
    const desired: DesiredIncumbentIdentity = { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };
    const health: IncumbentHealth = { bundleHash: 'h1', flavor: 'prod', namespace: 'ns' };

    expect(incumbentOutranksContender(health, desired)).toBe(false);
  });

  it('is total: equal-version contenders racing for the same socket both defer, never both evict', () => {
    // The exact BLOCKING-1 shape, viewed from both sides at once: build A
    // contends against B's incumbent and build B contends against A's
    // incumbent. If both calls returned false, both would proceed to
    // eviction and mutually destroy each other's coordinator every lap.
    const a: DesiredIncumbentIdentity = { version: '1.4.0', bundleHash: 'hash-a', flavor: 'prod', namespace: 'ns' };
    const b: DesiredIncumbentIdentity = { version: '1.4.0', bundleHash: 'hash-b', flavor: 'prod', namespace: 'ns' };
    const healthA: IncumbentHealth = { ...a };
    const healthB: IncumbentHealth = { ...b };

    expect(incumbentOutranksContender(healthA, b)).toBe(true);
    expect(incumbentOutranksContender(healthB, a)).toBe(true);
  });
});

describe('requestIncumbentShutdown', () => {
  it('throws IncumbentMatchesError on compatible non-draining incumbent', async () => {
    const socketPath = makeSocketPath('compat');
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '0.9.1',
            bundleHash: 'h1',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
          } satisfies IncumbentHealth,
        };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    await expect(
      requestIncumbentShutdown({
        socketPath,
        desired: { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);
  });

  it('mismatched bundle: returns last health and forwards transport.shutdown', async () => {
    const socketPath = makeSocketPath('mismatch');
    let receivedShutdown = false;
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            bundleHash: 'old',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 4242,
            incarnation: testIncarnation(9_999),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        receivedShutdown = true;
        expect(request.auth).toEqual({ kind: 'boot', token: 'boot-token' });
        expect(request.params).toEqual({});
        return { kind: 'response', id: request.id, result: { status: 'draining' } };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { version: '0.9.1', bundleHash: 'new', flavor: 'prod', namespace: 'ns' },
      bootToken: 'boot-token',
      timeoutMs: 1_000,
    });
    expect(receivedShutdown).toBe(true);
    expect(result.shutdownAttempted).toBe(true);
    expect(result.shutdownUnauthorized).toBe(false);
    expect(result.health?.bundleHash).toBe('old');
    expect(result.verifiedIdentity).toEqual({ pid: 4242, incarnation: testIncarnation(9_999), source: 'health' });
  });

  it('skips transport.shutdown when no boot token is available', async () => {
    const socketPath = makeSocketPath('no-token');
    let receivedShutdown = false;
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            bundleHash: 'old',
            version: '0.8.7',
            flavor: 'prod',
            namespace: 'ns',
            status: 'ok',
            pid: 4242,
            incarnation: testIncarnation(9_999),
          } satisfies IncumbentHealth,
        };
      }
      if (request.method === 'transport.shutdown') {
        receivedShutdown = true;
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { version: '0.9.1', bundleHash: 'new', flavor: 'prod', namespace: 'ns' },
      timeoutMs: 1_000,
    });
    expect(receivedShutdown).toBe(false);
    expect(result.shutdownAttempted).toBe(false);
    expect(result.verifiedIdentity).toEqual({ pid: 4242, incarnation: testIncarnation(9_999), source: 'health' });
  });

  it('compatible draining incumbent does NOT throw IncumbentMatchesError', async () => {
    const socketPath = makeSocketPath('draining');
    await startScriptedServer(socketPath, async (request) => {
      if (request.method === 'transport.ping') {
        return {
          kind: 'response',
          id: request.id,
          result: {
            version: '0.9.1',
            bundleHash: 'h1',
            flavor: 'prod',
            namespace: 'ns',
            status: 'draining',
          } satisfies IncumbentHealth,
        };
      }
      return { kind: 'response', id: request.id, result: null };
    });

    const result = await requestIncumbentShutdown({
      socketPath,
      desired: { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
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
      desired: { version: '0.9.1', bundleHash: 'h1', flavor: 'prod', namespace: 'ns' },
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
