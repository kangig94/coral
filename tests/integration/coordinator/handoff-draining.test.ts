import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bindWithHandoff, HandoffEscalationError } from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { Runtime } from '#src/runtime/ports.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('administratively draining coordinator', () => {
  it('does not classify a repeatedly answering holder as unverified at the bind deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-draining-incumbent-'));
    roots.push(root);
    const socketPath = join(root, 'incumbent.sock');
    let pings = 0;
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => {
        for (const line of chunk
          .toString()
          .split('\n')
          .filter((frame) => frame.length > 0)) {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method !== 'transport.ping') continue;
          pings++;
          socket.write(
            `${JSON.stringify({
              kind: 'response',
              id: request.id,
              result: { status: 'draining', instanceId: 'administrative-drain', pid: process.pid },
            })}\n`,
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const runtime = {
      time: createRealTimePort(),
      env: { platform: () => 'linux' },
      process: { observeLiveness: () => 'alive' },
    } as unknown as Pick<Runtime, 'time' | 'env' | 'process'>;

    let thrown: unknown;
    try {
      await bindWithHandoff({
        socketPath,
        desired: { version: '0.10.14', bundleHash: 'branch', flavor: 'prod', namespace: 'branch' },
        bindAttempt: async () => ({ kind: 'incumbent', reason: 'live-listener' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 300,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HandoffEscalationError);
    expect(pings).toBeGreaterThan(1);
    expect(thrown).toMatchObject({ code: 'handoff_administrative_drain_timeout' });
  });
});

describe('IPC-saturated coordinator', () => {
  it('classifies explicit connection-cap refusals as an answering holder at the bind deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-saturated-incumbent-'));
    roots.push(root);
    const socketPath = join(root, 'incumbent.sock');
    let pings = 0;
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => {
        for (const line of chunk
          .toString()
          .split('\n')
          .filter((frame) => frame.length > 0)) {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method !== 'transport.ping') continue;
          pings++;
          socket.write(
            `${JSON.stringify({
              kind: 'error',
              id: request.id,
              error: {
                code: -32603,
                message: 'Too many IPC connections',
                data: { code: 'too_many_ipc_connections' },
              },
            })}\n`,
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const runtime = {
      time: createRealTimePort(),
      env: { platform: () => 'linux' },
      process: { observeLiveness: () => 'alive' },
    } as unknown as Pick<Runtime, 'time' | 'env' | 'process'>;

    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '0.10.14', bundleHash: 'branch', flavor: 'prod', namespace: 'branch' },
        bindAttempt: async () => ({ kind: 'incumbent', reason: 'live-listener' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => null,
        totalBudgetMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'handoff_ipc_capacity_timeout' });
    expect(pings).toBeGreaterThan(1);
  });
});
