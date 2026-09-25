import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

  it('keeps the incumbent serving when the attempt child dies before listener acknowledgment', async () => {
    const path = join(root(), 'primary.sock');
    const server = await listen(path, (socket) => socket.end('incumbent\n'));
    const listener: IpcListener = { server, sockets: new Set(), socketPath: path };
    const child = spawn(process.execPath, [fixture, 'successor', 'attempt-2'], {
      env: { ...process.env, DIE_BEFORE_LISTENER_ACK: '1' },
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
      'attempt-2',
      listener,
      'boot-token',
      {
        epochKey: 'fixture-epoch',
        receipts: [],
      },
    );
    await expect(attempt.transferListeners(listener)).rejects.toThrow();
    await expectBusy(path);
    expect(await responseAt(path)).toBe('incumbent\n');
  });

  it('reports an attempt child open hold over the private channel while the incumbent retains its address', async () => {
    const path = join(root(), 'primary.sock');
    const server = await listen(path, (socket) => socket.end('incumbent\n'));
    const listener: IpcListener = { server, sockets: new Set(), socketPath: path };
    const child = spawn(process.execPath, [fixture, 'successor', 'attempt-hold'], {
      env: { ...process.env, REPORT_OPEN_HOLD: '1' },
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
      'attempt-hold',
      listener,
      'boot-token',
      {
        epochKey: 'agreed-epoch',
        receipts: [],
      },
    );
    const observedAck = messageFrom(child, 'ack');
    await attempt.allowCommittedOpen();
    await observedAck;
    const hold = new Promise<string>((resolve) => {
      attempt.onAcknowledgment((acknowledgment) => {
        if (acknowledgment.kind === 'hold') resolve(acknowledgment.reason);
      });
    });
    expect(await hold).toBe('open-failed');
    await expectBusy(path);
    expect(await responseAt(path)).toBe('incumbent\n');
  });

  it('preserves the canonical socket after the incumbent exits without closing it', async () => {
    const path = join(root(), 'canonical.sock');
    const incumbent = spawn(process.execPath, [fixture, 'incumbent', path], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(incumbent);
    await messageFrom(incumbent, 'transferred');
    await expectBusy(path);
    const exited = new Promise<void>((resolve) => incumbent.once('exit', () => resolve()));
    incumbent.send({ kind: 'exit' });
    await exited;
    expect(existsSync(path)).toBe(true);
    await expectBusy(path);
    expect(await responseAt(path)).toBe('successor\n');
  });
});
