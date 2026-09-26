import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntentChange } from '#src/infra/upgrade-intent.js';
import { createRealUpgradeWaiterPorts, type UpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import { runUpgradeWaiter } from '#src/upgrade-waiter/index.js';

const build = {
  version: '0.11.0',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

function pendingIntent(incumbentPid: number): UpgradeIntentChange {
  return {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'legacy',
      pid: incumbentPid,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/installed/target' },
    attemptId: null,
    attemptOwner: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: { kind: 'incumbent-retirement', evidence: 'idle exit' },
    attemptDeadline: null,
    completionReceipt: null,
  };
}

function waiterPorts(now: () => number, sleep: (ms: number) => Promise<void>): UpgradeWaiterPorts {
  return { ...createRealUpgradeWaiterPorts(), time: { now, sleep } };
}

/** A pid whose process has exited, so its absence is decisive. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.pid === undefined) throw new Error('exited child has no pid');
  return child.pid;
}

/** A socket whose coordinator answers ping as `identity`. */
async function answeringCoordinator(socketPath: string, identity: Record<string, unknown>): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      for (const line of chunk
        .toString()
        .split('\n')
        .filter((frame) => frame.trim().length > 0)) {
        const request = JSON.parse(line) as { id: number };
        socket.write(`${JSON.stringify({ kind: 'response', id: request.id, result: identity })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

describe('upgrade waiter natural-retirement observation', () => {
  const directories: string[] = [];
  function runDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'coral-upgrade-waiter-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('should release its attempt to the coordinator that serves once the recorded incumbent is proven gone', async () => {
    const dir = runDir();
    const retired = await exitedPid();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent(retired));
    const socketPath = join(dir, 'coordinator.sock');
    const server = await answeringCoordinator(socketPath, { instanceId: 'successor', pid: process.pid });
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let polls = 0;
    const launch = vi.fn(async () => undefined);
    try {
      const result = await runUpgradeWaiter({
        runDir: dir,
        socketPath,
        targetRoot: '/installed/target',
        validateTarget: () => true,
        launchTarget: launch,
        ports: waiterPorts(
          () => time,
          async (ms) => {
            time += ms;
            if (++polls > 20) throw new Error('waiter still holds the attempt');
          },
        ),
      });

      expect(result).toEqual({ kind: 'replaced' });
      expect(launch).not.toHaveBeenCalled();
      expect(readUpgradeIntent(dir)).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'pending', attemptId: null, attemptOwner: null, retryCondition: null },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
