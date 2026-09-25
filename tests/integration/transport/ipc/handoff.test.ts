import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { incumbentOutranksContender, probeIncumbent } from '#src/transport/ipc/handoff.js';
import { decode, encode } from '#src/transport/ipc/json-rpc.js';

const servers: NetServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('incumbentOutranksContender', () => {
  const contender = { version: '0.10.14', bundleHash: 'new', flavor: 'prod' as const, namespace: 'new' };

  it.each([
    ['0.10.13', false],
    ['0.10.14', true],
    ['0.10.15', true],
  ])('ranks incumbent version %s', (version, expected) => {
    expect(
      incumbentOutranksContender(
        { version, bundleHash: 'old', flavor: 'prod', namespace: 'old' },
        contender,
      ),
    ).toBe(expected);
  });

  it('does not rank an unknown version or a different flavor', () => {
    expect(incumbentOutranksContender({ bundleHash: 'old', flavor: 'prod', namespace: 'old' }, contender)).toBe(false);
    expect(
      incumbentOutranksContender(
        { version: '0.10.15', bundleHash: 'old', flavor: 'dev', namespace: 'old' },
        contender,
      ),
    ).toBe(false);
  });
});

describe('probeIncumbent', () => {
  it('reads health without sending transport.shutdown, even with an older incumbent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-ipc-probe-'));
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
              bundleHash: 'old',
              flavor: 'prod',
              namespace: 'old',
              status: 'ok',
            },
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    expect((await probeIncumbent({ socketPath, timeoutMs: 1_000 }))?.version).toBe('0.10.13');
    expect(methods).toEqual(['transport.ping']);
  });
});
