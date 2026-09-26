import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterEach, beforeAll, describe, it } from 'vitest';

import { createSuccessionAttemptChannel, type SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import { createRealSuccessionAttemptPorts } from '#src/runtime/succession-attempt.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import { terminateChildProcess } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const ATTEMPT_ID = '00000000-0000-4000-8000-00000000c0de';
const FRAME = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const clients: Socket[] = [];
let childBundle = '';

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-attempt-child-bundle-'));
  roots.push(root);
  childBundle = join(root, 'succession-attempt-child.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/succession-attempt-child.ts', import.meta.url))],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__importMetaUrl' },
  });
}, 60_000);

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(children.splice(0).map((child) => terminateChildProcess(child, 'SIGKILL')));
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(1)) rmSync(root, { recursive: true, force: true });
});

/** An incumbent listener that records every request byte it receives on a connection it serves itself. */
function incumbentListener(socketPath: string): Readonly<{ listener: IpcListener; received: () => string }> {
  let received = '';
  let forward: ((socket: Socket, pendingFrameBase64: string) => void) | null = null;
  const serve = (socket: Socket, pendingFrameBase64 = ''): void => {
    if (forward !== null) {
      forward(socket, pendingFrameBase64);
      return;
    }
    received += Buffer.from(pendingFrameBase64, 'base64').toString();
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.resume();
  };
  const server = createServer({ pauseOnConnect: true }, serve);
  servers.push(server);
  const listener: IpcListener = {
    server,
    sockets: new Set(),
    compatibilityListeners: [],
    socketPath,
    acceptSocket: serve,
    forwardConnections: (next) => {
      forward = next;
      return () => {
        forward = null;
      };
    },
    drainConnections: async () => undefined,
  };
  return { listener, received: () => received };
}

async function launchAttemptChild(): Promise<
  Readonly<{ attempt: SuccessionAttempt; listener: IpcListener; received: () => string; socketPath: string }>
> {
  const root = mkdtempSync(join(tmpdir(), 'coral-attempt-child-'));
  roots.push(root);
  const socketPath = join(root, 'coral.sock');
  const incumbent = incumbentListener(socketPath);
  await new Promise<void>((resolve, reject) => {
    incumbent.listener.server.once('error', reject);
    incumbent.listener.server.listen(socketPath, resolve);
  });
  const child = spawn(process.execPath, [childBundle], {
    env: { ...process.env, CORAL_SUCCESSION_ATTEMPT_ID: ATTEMPT_ID },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const attempt = await createSuccessionAttemptChannel(
    createRealSuccessionAttemptPorts(),
    child,
    ATTEMPT_ID,
    incumbent.listener,
    'boot-token',
    { epochKey: 'lineage:1', receipts: [] },
  );
  await attempt.transferListeners(incumbent.listener);
  return { attempt, listener: incumbent.listener, received: incumbent.received, socketPath };
}

function sendFrame(socketPath: string): void {
  const client = createConnection(socketPath, () => client.write(FRAME));
  client.on('error', () => undefined);
  clients.push(client);
}

describe('succession attempt child connection custody', () => {
  it('should hand a parked connection back to its incumbent with the request its client already sent', async () => {
    const { attempt, listener, received, socketPath } = await launchAttemptChild();
    await attempt.setDeadline(Date.now() + 30_000);
    const stopForwarding = attempt.forwardConnections(listener);
    const requests = 8;
    for (let index = 0; index < requests; index++) sendFrame(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 500));

    stopForwarding();
    await attempt.abort();

    await waitForCondition(() => received() === FRAME.repeat(requests), 5_000);
  });

  it('should leave its incumbent answering every connection until the commit window opens', async () => {
    const { received, socketPath } = await launchAttemptChild();
    const requests = 12;
    for (let index = 0; index < requests; index++) sendFrame(socketPath);

    await waitForCondition(() => received() === FRAME.repeat(requests), 5_000);
  });

  it('should stop forwarding before returning a parked connection at the child deadline', async () => {
    const { attempt, listener, received, socketPath } = await launchAttemptChild();
    await attempt.setDeadline(Date.now() + 400);
    attempt.forwardConnections(listener);
    sendFrame(socketPath);

    await waitForCondition(() => received() === FRAME, 5_000);
  });
});
