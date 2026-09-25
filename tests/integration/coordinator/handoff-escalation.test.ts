import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { bindWithHandoff, HandoffEscalationError } from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { Runtime } from '#src/runtime/ports.js';

const servers: NetServer[] = [];
const sockets: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unresponsive incumbent', () => {
  it('refuses a verified live owner that cannot answer without sending shutdown or a process signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-unresponsive-incumbent-'));
    roots.push(root);
    const socketPath = join(root, 'incumbent.sock');
    const server = createServer((socket) => sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const kill = vi.fn();
    const runtime = {
      time: createRealTimePort(),
      process: { kill, observeLiveness: () => 'alive' },
      env: { platform: () => 'linux' },
    } as unknown as Pick<Runtime, 'time' | 'process' | 'env'>;
    const startedAt = Date.now();
    await expect(
      bindWithHandoff({
        socketPath,
        desired: { version: '0.10.14', bundleHash: 'branch', flavor: 'prod', namespace: 'branch' },
        bindAttempt: async () => ({ kind: 'incumbent', reason: 'live-listener' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => ({ pid: 9999, source: 'discovery' }),
        totalBudgetMs: 300,
      }),
    ).rejects.toBeInstanceOf(HandoffEscalationError);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(kill).not.toHaveBeenCalled();
    expect(server.listening).toBe(true);
  });
});
