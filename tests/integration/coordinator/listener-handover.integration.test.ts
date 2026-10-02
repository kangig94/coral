import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSuccessionAttemptChannel } from '#src/coordinator/succession/attempt-child.js';
import { createRealSuccessionAttemptPorts } from '#src/runtime/succession-attempt.js';
import type { IpcListener } from '#src/transport/ipc/server.js';

const fixture = fileURLToPath(new URL('./fixtures/listener-handover-child.cjs', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'coral-listener-handover-'));
  roots.push(path);
  return path;
}

async function messageFrom(child: ChildProcess, kind: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${kind}`)), 5_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== kind) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolve();
    };
    child.on('message', onMessage);
  });
}

async function responseAt(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(path);
    let response = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('IPC response timed out')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

async function expectBusy(path: string): Promise<void> {
  const contender = createServer();
  await new Promise<void>((resolve, reject) => {
    contender.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve();
      else reject(error);
    });
    contender.listen(path, () => {
      contender.close();
      reject(new Error(`Third-party contender bound ${path}`));
    });
  });
}

async function listen(path: string, listener: (socket: Socket) => void): Promise<Server> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return server;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('succession listening-handle handover', () => {
  it('keeps every claimed address bound and forwards an overlap connection', async () => {
    const runDir = root();
    const paths = [join(runDir, 'primary.sock'), join(runDir, 'guard.sock')];
    const forwarding = new Map<string, ((socket: Socket, pendingFrame: string) => void) | null>();
    const heldSockets = new Map<string, Set<Socket>>();
    const listeners: IpcListener[] = [];
    for (const path of paths) {
      forwarding.set(path, null);
      heldSockets.set(path, new Set());
      const server = await listen(path, (socket) => {
        const forward = forwarding.get(path);
        if (forward) forward(socket, '');
        else heldSockets.get(path)?.add(socket);
      });
      listeners.push({
        server,
        sockets: new Set(),
        socketPath: path,
        forwardConnections: (forward) => {
          forwarding.set(path, forward);
          for (const socket of heldSockets.get(path) ?? []) forward(socket, '');
          heldSockets.get(path)?.clear();
          return () => forwarding.set(path, null);
        },
      });
    }
    const primary: IpcListener = { ...listeners[0], compatibilityListeners: [listeners[1]] };
    const child = spawn(process.execPath, [fixture, 'successor', 'attempt-1'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const attempt = await createSuccessionAttemptChannel(
      createRealSuccessionAttemptPorts(),
      child,
      'attempt-1',
      primary,
      'boot-token',
      {
        epochKey: 'fixture-epoch',
        receipts: [],
      },
    );
    expect(attempt.childIdentity.pid).toBe(child.pid);
    expect(attempt.childIdentity.incarnation.length).toBeGreaterThan(0);
    const overlapAccepted = new Promise<void>((resolve) => primary.server.once('connection', () => resolve()));
    const overlapSocket = createConnection(paths[0]);
    const overlapResponse = new Promise<string>((resolve, reject) => {
      let body = '';
      overlapSocket.on('data', (chunk) => {
        body += chunk.toString();
      });
      overlapSocket.once('end', () => resolve(body));
      overlapSocket.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      overlapSocket.once('connect', resolve);
      overlapSocket.once('error', reject);
    });
    await overlapAccepted;
    const transfer = attempt.transferListeners(primary);
    for (let sample = 0; sample < 20; sample++) {
      for (const path of paths) await expectBusy(path);
      await Promise.resolve();
    }
    await transfer;
    const stopForwarding = attempt.forwardConnections(primary);
    expect(await overlapResponse).toBe('forwarded\n');
    expect(['forwarded\n', 'successor\n']).toContain(await responseAt(paths[1]));
    stopForwarding();
    for (const path of paths) await expectBusy(path);
  });

  it('answers from the incumbent a connection an aborted attempt child had parked', async () => {
    const path = join(root(), 'primary.sock');
    let forward: ((socket: Socket, pendingFrame: string) => void) | null = null;
    const answer = (socket: Socket) => socket.end('incumbent\n');
    const server = await listen(path, (socket) => (forward === null ? answer(socket) : forward(socket, '')));
    const listener: IpcListener = {
      server,
      sockets: new Set(),
      socketPath: path,
      acceptSocket: answer,
      forwardConnections: (next) => {
        forward = next;
        return () => {
          forward = null;
        };
      },
    };
    const child = spawn(process.execPath, [fixture, 'successor', 'attempt-parked'], {
      env: { ...process.env, PARK_CONNECTIONS: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const attempt = await createSuccessionAttemptChannel(
      createRealSuccessionAttemptPorts(),
      child,
      'attempt-parked',
      listener,
      'boot-token',
      { epochKey: 'fixture-epoch', receipts: [] },
    );
    await attempt.transferListeners(listener);
    const stopForwarding = attempt.forwardConnections(listener);
    const parked = messageFrom(child, 'parked');
    const response = responseAt(path);
    await parked;
    stopForwarding();

    await attempt.abort();

    expect(await response).toBe('incumbent\n');
  });
});
