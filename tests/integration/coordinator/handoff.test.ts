import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { bindWithHandoff } from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { decode, encode } from '#src/transport/ipc/json-rpc.js';

const servers: NetServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('administrative drain handoff', () => {
  it('waits for socket release without sending shutdown or a process signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-drain-handoff-'));
    roots.push(root);
    const socketPath = join(root, 'incumbent.sock');
    const methods: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        const request = decode(data.toString().trim());
        if (request.kind !== 'request') return;
        methods.push(request.method);
        socket.end(
          `${encode({
            kind: 'response',
            id: request.id,
            result: {
              version: '0.10.13',
              bundleHash: 'incumbent',
              flavor: 'prod',
              namespace: 'incumbent',
              status: 'draining',
            },
          })}\n`,
        );
        if (methods.length === 2) queueMicrotask(() => server.close());
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const kill = vi.fn();
    const runtime = {
      time: createRealTimePort(),
      process: { kill },
      env: { platform: () => 'linux' },
    } as unknown as Pick<Runtime, 'time' | 'process' | 'env'>;
    const bound = await bindWithHandoff({
      socketPath,
      desired: { version: '0.10.14', bundleHash: 'branch', flavor: 'prod', namespace: 'branch' },
      bindAttempt: async () => (server.listening ? { kind: 'incumbent', reason: 'live-listener' } : { kind: 'bound' }),
      runStartupRecovery: async () => [],
      runtime,
      readVerifiedIncumbentFromDiscovery: () => null,
      totalBudgetMs: 2_000,
    });

    expect(bound.acquiredViaHandoff).toBe(true);
    expect(methods).toEqual(['transport.ping', 'transport.ping']);
    expect(kill).not.toHaveBeenCalled();
  });
});
