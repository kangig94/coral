import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';

import { watchChild } from '#src/coordinator-launch/child-watch.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { createRealRuntime } from '#src/runtime/real.js';

it.each(['oversized', 'malformed', 'truncated', 'running', 'starting'])(
  'uses a %s health response without confusing unknown with a failed direct-child startup',
  async (reply) => {
    const root = mkdtempSync('/tmp/coral-direct-health-');
    const runtime = createRealRuntime('prod', { baseDir: root });
    const runDir = runtime.paths.coral.coordinator.runDir;
    mkdirSync(runDir, { recursive: true });
    const incarnation = probeProcessIncarnation(process.pid)!;
    const identity = { pid: process.pid, incarnation };
    const record = new SupervisorLaunchMemory(runDir, identity, 'build-A');
    const owner = { current: record.read().owner, lost: false, release: () => {} };
    const reservation = record.reserve(owner.current, 'build-A', 'startup')!;
    expect(record.spawned(reservation, identity, identity)).toBe(true);
    const server = createServer((socket) =>
      socket.once('data', () => {
        if (reply === 'malformed') socket.end('{\n');
        else if (reply === 'truncated') socket.end('{');
        else
          socket.end(
            JSON.stringify({
              kind: 'response',
              id: 1,
              result: {
                pid: process.pid,
                status: reply === 'starting' ? 'starting' : 'ok',
                ...(reply === 'oversized' ? { padding: 'x'.repeat(70 * 1024) } : {}),
              },
            }) + '\n',
          );
      }),
    );
    await new Promise<void>((resolve) => server.listen(runtime.paths.coral.coordinator.socketPath, resolve));
    writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify({ pid: process.pid, bootToken: 'token' }));
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      connected: true,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const manifest = {
      flavor: 'prod',
      version: '0.10.16',
      buildSetId: 'build-A',
      bundleHash: 'hash',
    } as StrictBundleManifest;
    let answers = 0;
    child.send = ((message: { kind: string; id?: string }) => {
      if (message.kind === 'coral-launch-admit') {
        publishLaunchAdmission(runDir, {
          version: 1,
          launchId: reservation.id,
          child: identity,
          parent: identity,
          admittedAt: Date.now(),
          admittedMonotonicMs: Number(process.hrtime.bigint() / 1000000n),
          build: manifest,
          purpose: 'startup',
        });
        queueMicrotask(() => {
          child.emit('message', { kind: 'coral-launch-admitted', launchId: reservation.id, pid: child.pid });
          child.emit('message', { kind: 'coral-sentinel-hello', id: 'sentinel' });
        });
      }
      if (message.kind === 'coral-sentinel-challenge') {
        answers++;
        queueMicrotask(() => child.emit('message', { kind: 'coral-sentinel-answer', id: message.id }));
      }
      return true;
    }) as ChildProcess['send'];
    child.kill = vi.fn(() => true);
    const watched = watchChild({
      running: { child, identity, sentinelId: 'sentinel', manifest, executable: 'mock' },
      record,
      reservation,
      owner,
      runDir,
      timing: { challengeMs: 20, schedulingGapMs: 1000, lapseMs: 10000, graceMs: 30000, dStateDeferralMs: 1000 },
      startupBudgetMs: 600,
      retirement: { at: null },
      forwardParentMessages: false,
    });
    try {
      child.emit('spawn');
      await delay(900);
      expect(answers).toBeGreaterThan(5);
      if (reply === 'starting') expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      else expect(child.kill).not.toHaveBeenCalled();
      expect(record.childWatch(reservation, 600).served).toBe(reply === 'running');
    } finally {
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
      await watched;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
