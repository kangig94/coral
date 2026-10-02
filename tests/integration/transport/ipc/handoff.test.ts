import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { probeIncumbent } from '#src/transport/ipc/handoff.js';
import { decode, encode } from '#src/transport/ipc/json-rpc.js';

const servers: NetServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('probeIncumbent', () => {
  it('preserves an explicit IPC connection-cap refusal as an answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-ipc-probe-'));
    roots.push(root);
    const socketPath = join(root, 'incumbent.sock');
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        const request = decode(data.toString().trim());
        if (request.kind !== 'request') return;
        socket.end(
          `${encode({
            kind: 'error',
            id: request.id,
            error: {
              code: -32603,
              message: 'Too many IPC connections',
              data: { code: 'too_many_ipc_connections' },
            },
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(probeIncumbent({ socketPath, timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'too_many_ipc_connections',
    });
  });
});
