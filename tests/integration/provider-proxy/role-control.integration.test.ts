import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { establishRoleControl, type ControlTimer } from '#src/coordinator/live/provider-proxy/role-control.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { RoleConnectRetryOptions } from '#src/provider-proxy/role-spawn.js';
import { runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A bare stand-in for the far end of the channel: raw accept, raw write, raw destroy — no protocol logic. */
async function startTestServer(): Promise<{ socketPath: string; sockets: Socket[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-role-control-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'r.sock');
  const sockets: Socket[] = [];
  const server: NetServer = createServer((socket) => {
    sockets.push(socket);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return { socketPath, sockets };
}

async function waitForAccept(sockets: Socket[]): Promise<Socket> {
  const deadline = Date.now() + 5_000;
  while (sockets.length === 0) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the test server to accept a connection.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sockets[0];
}

async function nextRequest(socket: Socket): Promise<{ id: number; method: string }> {
  return new Promise((resolve) => {
    socket.once('data', (chunk: Buffer) => {
      resolve(JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number; method: string });
    });
  });
}

const TIMER: ControlTimer = runtimeControlTimer({ time: createRealTimePort() });
const RETRY: RoleConnectRetryOptions = {
  connectTimeoutMs: 5_000,
  retryIntervalMs: 10,
  overallDeadlineMs: 5_000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const openParamsSchema = z.object({}).strict();
const openResultSchema = z
  .object({ controlEpoch: z.number(), heartbeatChallenge: z.string(), roleId: z.string() })
  .strict();

describe('role control establishment against a real socket', () => {
  // Pins the ordering `establishHeartbeatOrChannelFault` depends on but cannot enforce (see its own comment in
  // role-control.ts) against a real socket, a real pending heartbeat call, and a real malformed reply — not a
  // hand-resolved `faulted` promise. If that ordering is ever inverted, this test starts observing
  // `ProviderProxyRoleControlUnavailableError` (`role-heartbeat-indeterminate`) instead of the decisive error
  // below.
  it('classifies a malformed frame that arrives while the opening heartbeat is in flight as decisive, not indeterminate', async () => {
    const { socketPath, sockets } = await startTestServer();
    const establishing = establishRoleControl([], TIMER, RETRY, {
      role: 'guardian',
      endpoint: socketPath,
      openMethod: 'guardian.open.v1',
      openParams: {},
      openParamsSchema,
      openResultSchema,
      identity: (opened) => ({ roleId: opened.roleId }),
      heartbeatMethod: 'guardian.heartbeat.v1',
      expectedIdentity: { roleId: 'guardian-1' },
    });
    const socket = await waitForAccept(sockets);

    const open = await nextRequest(socket);
    expect(open.method).toBe('guardian.open.v1');
    socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: open.id,
        result: { controlEpoch: 1, heartbeatChallenge: 'challenge-1', roleId: 'guardian-1' },
      })}\n`,
    );

    const heartbeat = await nextRequest(socket);
    expect(heartbeat.method).toBe('guardian.heartbeat.v1');
    // A complete, newline-terminated frame this build's own strict JSON-RPC parsing must reject, sent while the
    // heartbeat call above is still pending — see faultInvalidFrame in control-client.ts.
    socket.write('this is not a json-rpc frame\n');

    await expect(establishing).rejects.toMatchObject({
      name: 'ProviderProxyRoleControlRemoteError',
      role: 'guardian',
      stage: 'heartbeat',
      method: 'guardian.heartbeat.v1',
      remoteFailure: { kind: 'invalid-frame' },
    });
  });
});
