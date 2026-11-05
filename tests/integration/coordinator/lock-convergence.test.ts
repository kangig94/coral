import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { childHasExited } from '#src/coordinator-launch/child-state.js';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { coordinatorFilesForHome, createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { supervisorLockPath } from '#src/infra/path/index.js';

const execute = promisify(execFile);

function setup() {
  const roots: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'coral-lock-convergence-'));
  roots.push(root);
  const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.25' });
  const harness = join(root, 'harness.mjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('./fixtures/lock-convergence.ts', import.meta.url))],
    outfile: harness,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['node:*'],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const runDir = coordinatorFilesForHome(root, 'prod').runDir;
  mkdirSync(runDir, { recursive: true });
  const registry = join(root, 'registry.json');
  writeFileSync(registry, JSON.stringify({ plugins: {} }));
  const env = {
    ...process.env,
    HOME: root,
    CORAL_KB_ENABLE: '0',
    CORAL_PLUGIN_REGISTRY: registry,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'no-bus')}`,
    XDG_RUNTIME_DIR: root,
  };
  const executable = join(fixture.root, 'bridge', 'coral-backend.cjs');
  const commands: { child: ChildProcess; settled: Promise<unknown> }[] = [];
  const createdPids = () =>
    existsSync(join(runDir, 'fixture-pids.json'))
      ? (JSON.parse(readFileSync(join(runDir, 'fixture-pids.json'), 'utf8')) as {
          pid: number;
          incarnation: ProcessIncarnation | null;
          exited: boolean;
          processGroup: number | null;
        }[])
      : [];
  const running = (owned: ReturnType<typeof createdPids>) =>
    owned.filter(
      (entry) =>
        !entry.exited &&
        entry.incarnation !== null &&
        probeProcessIncarnation(entry.pid) === entry.incarnation &&
        !childHasExited(entry.pid),
    );
  function signalGroup(group: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-group, signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  async function stopRecordedChildren(): Promise<void> {
    const owned = createdPids().filter((entry) => !entry.exited);
    if (process.platform !== 'linux') {
      if (owned.length > 0)
        console.warn('Skipping recorded descendant cleanup: no owned child handle remains on this platform.');
      return;
    }
    const members = owned.filter((entry) => entry.processGroup !== null);
    for (const entry of running(members)) signalGroup(entry.processGroup!, 'SIGTERM');
    let deadline = Date.now() + 1_000;
    while (running(members).length > 0 && Date.now() < deadline) await sleep(20);
    for (const entry of running(members)) signalGroup(entry.processGroup!, 'SIGKILL');
    deadline = Date.now() + 2_000;
    while (running(members).length > 0 && Date.now() < deadline) await sleep(20);
    if (running(members).length > 0) throw new Error('Fixture-created processes did not exit');
  }
  function run(mode: string, timeout: number, alternatives: readonly string[] = []) {
    const execution = execute(process.execPath, [harness, mode, executable, runDir, ...alternatives], { env, timeout });
    let termination: Promise<void> | undefined;
    execution.child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) termination = stopRecordedChildren();
    });
    const result = Object.assign(
      execution.catch(async (error: unknown) => {
        await termination;
        throw error;
      }),
      { child: execution.child },
    );
    commands.push({ child: result.child, settled: result.catch((error: unknown) => error) });
    return result;
  }
  async function cleanup(): Promise<void> {
    for (const { child } of commands) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await stopRecordedChildren();
    await Promise.all(commands.map((entry) => entry.settled));
    for (const path of roots) rmSync(path, { recursive: true, force: true });
  }
  return { roots, root, fixture, harness, runDir, registry, env, executable, run, cleanup, createdPids };
}

it.each(['fail', 'fail-held'])(
  'releases after persistent spawn failure (%s) and lets a fresh supervisor serve',
  async (mode) => {
    const f = setup();
    try {
      const alternatives =
        mode === 'fail-held'
          ? Array.from({ length: 3 }, () => createPluginFixture(f.roots, { flavor: 'prod', version: '0.10.25' }))
          : [];
      writeFileSync(
        f.registry,
        JSON.stringify({ plugins: { 'coral@test': alternatives.map((fixture) => ({ installPath: fixture.root })) } }),
      );
      const paths = alternatives.map((fixture) => join(fixture.root, 'bridge', 'coral-backend.cjs'));
      const result = await f
        .run(mode, 15_000, paths)
        .catch((error: { code: number; stdout: string; stderr: string }) => error);
      expect(result).toMatchObject({
        code: 1,
        stderr: expect.stringContaining('releasing namespace ownership'),
        ...(mode === 'fail-held'
          ? {
              stdout: expect.stringMatching(/release-refused[\s\S]*ownership-held-while-refused[\s\S]*release-settled/),
            }
          : {}),
      });
      const attempts = [...result.stdout.matchAll(/^spawn-failed:(.+)$/gm)].map((match) => match[1]);
      expect(attempts).toHaveLength(3);
      if (mode === 'fail-held') expect(new Set(attempts).size).toBe(3);
      writeFileSync(f.registry, JSON.stringify({ plugins: {} }));
      const status = JSON.parse(readFileSync(join(f.runDir, 'launch-status.v1.json'), 'utf8'));
      expect(status.relaunchOutcome).toMatchObject({
        kind: 'relaunch-failed',
        failedLaunches: 3,
        retry: 'next-ensure',
      });
      const acquired = await f.run('select', 10_000);
      expect(JSON.parse(acquired.stdout)).toMatchObject({ kind: 'candidate', candidate: { executable: f.executable } });
      const fresh = await f.run('launch', 20_000);
      expect(fresh.stdout).toContain('fresh-supervisor-serving');
    } finally {
      await f.cleanup();
    }
  },
);

it('preserves a successor hold interleaved before the departing supervisor terminal outcome', async () => {
  const f = setup();
  try {
    const result = await f
      .run('fail-interleaved', 15_000)
      .catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result).toMatchObject({ code: 1 });
    const status = JSON.parse(readFileSync(join(f.runDir, 'launch-status.v1.json'), 'utf8'));
    expect(status.relaunchOutcome).toMatchObject({ kind: 'relaunch-failed', failedLaunches: 3 });
    expect(status.hold).toEqual({ kind: 'target-indeterminate', requestId: 'successor-request' });
    expect(status.signalHolds).toMatchObject([{ launchId: 'successor' }]);
  } finally {
    await f.cleanup();
  }
});

it.skipIf(process.platform !== 'linux')(
  'retains ownership for a real live unidentified child until its obligation settles',
  async () => {
    const f = setup();
    try {
      const alternatives = Array.from({ length: 3 }, () =>
        createPluginFixture(f.roots, { flavor: 'prod', version: '0.10.25' }),
      );
      writeFileSync(
        f.registry,
        JSON.stringify({ plugins: { 'coral@test': alternatives.map((entry) => ({ installPath: entry.root })) } }),
      );
      const result = await f
        .run(
          'fail-unsettled',
          15_000,
          alternatives.map((entry) => join(entry.root, 'bridge/coral-backend.cjs')),
        )
        .catch((error: { code: number; stdout: string; stderr: string }) => error);
      expect(result).toMatchObject({
        code: 1,
        stdout: expect.stringMatching(
          /release-blocked-by-live-unidentified-child[\s\S]*ownership-held-with-unsettled-child[\s\S]*real-obligation-settled/,
        ),
      });
      expect([...result.stdout.matchAll(/^spawn-failed:/gm)]).toHaveLength(3);
      const probe = await f.run('probe-lock', 5_000);
      expect(probe.stdout.trim()).toBe('acquired');
      expect(f.createdPids().every((entry) => entry.exited)).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

it('an older-origin lock winner selects the newer installed build and never falls back after its failure', async () => {
  const f = setup();
  try {
    const newer = createPluginFixture(f.roots, { flavor: 'prod', version: '0.10.27' });
    writeFileSync(f.registry, JSON.stringify({ plugins: { 'coral@test': [{ installPath: newer.root }] } }));
    const result = await f.run('select', 10_000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'candidate',
      candidate: { executable: join(newer.root, 'bridge', 'coral-backend.cjs') },
    });
    const retry = await f.run('retry', 10_000);
    expect(JSON.parse(retry.stdout)).toEqual({ kind: 'retry' });
  } finally {
    await f.cleanup();
  }
});

it.each(['brief', 'blocked'])(
  'publishes terminal relaunch history after releasing ownership (diagnostic lock=%s)',
  async (duration) => {
    const f = setup();
    try {
      const result = await f
        .run(`fail-publication-${duration}`, 15_000)
        .catch((error: { code: number; stdout: string; stderr: string }) => error);
      expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('terminal-publication-blocked') });
      expect(result.stdout).toContain('namespace-available-before-publication');
      if (duration === 'brief') {
        const status = JSON.parse(readFileSync(join(f.runDir, 'launch-status.v1.json'), 'utf8'));
        expect(status.relaunchOutcome).toMatchObject({ kind: 'relaunch-failed', failedLaunches: 3 });
        expect(result.stderr).not.toContain('Terminal launch outcome publication failed');
      } else {
        expect(result.stderr).toContain('Terminal launch outcome publication failed after 2000 ms');
      }
    } finally {
      await f.cleanup();
    }
  },
);

it('publishes an expired waiter outcome before immediate process exit, or reports the bounded failure', async () => {
  await Promise.all(
    ['brief', 'blocked'].map(async (duration) => {
      const f = setup();
      const path = supervisorLockPath(f.runDir);
      createSharedFileLockSync(path)();
      const incumbent = attemptExclusiveFileLockSync(path);
      if (incumbent.kind !== 'acquired') throw new Error('Fixture namespace lock unavailable');
      try {
        const result = await f
          .run(`wait-publication-${duration}`, 40_000)
          .catch((error: { code: number; stdout: string; stderr: string }) => error);
        expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('terminal-publication-blocked') });
        if (duration === 'brief') {
          const status = JSON.parse(readFileSync(join(f.runDir, 'launch-status.v1.json'), 'utf8'));
          expect(status.ownershipWaitOutcome.kind).toBe('supervisor-lock-wait-expired');
          expect(result.stderr).not.toContain('Terminal launch outcome publication failed');
        } else expect(result.stderr).toContain('Terminal launch outcome publication failed after 2000 ms');
        expect(attemptExclusiveFileLockSync(path).kind).toBe('contended');
      } finally {
        incumbent.lease();
        await f.cleanup();
      }
    }),
  );
});

it('keeps a contending waiter viable until the incumbent releases within the ownership budget', async () => {
  const f = setup();
  const path = supervisorLockPath(f.runDir);
  createSharedFileLockSync(path)();
  const incumbent = attemptExclusiveFileLockSync(path);
  if (incumbent.kind !== 'acquired') throw new Error('Fixture namespace lock unavailable');
  const waiting = f.run('wait-acquire', 40_000);
  const result = waiting.catch((error: unknown) => error);
  try {
    const [started] = await once(waiting.child.stdout!, 'data', { signal: AbortSignal.timeout(5_000) });
    expect(String(started)).toContain('wait-started');
    await sleep(25_000);
    expect(waiting.child.exitCode).toBeNull();
    expect(waiting.child.signalCode).toBeNull();
    incumbent.lease();
    await expect(result).resolves.toMatchObject({ stdout: expect.stringContaining('ownership-acquired') });
    expect(waiting.child.exitCode).toBe(0);
  } finally {
    incumbent.lease();
    if (waiting.child.exitCode === null && waiting.child.signalCode === null) waiting.child.kill('SIGTERM');
    await result;
    await f.cleanup();
  }
});

it('all contending waiters exit within the bound without disturbing the incumbent lock', async () => {
  const f = setup();
  const lock = supervisorLockPath(f.runDir);
  createSharedFileLockSync(lock)();
  const incumbent = attemptExclusiveFileLockSync(lock);
  if (incumbent.kind !== 'acquired') throw new Error('Fixture lock unavailable');
  try {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.run('wait', 40_000)));
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 1, stderr: expect.stringContaining('within 30 seconds') });
    }
    expect(attemptExclusiveFileLockSync(lock).kind).toBe('contended');
    expect(JSON.parse(readFileSync(join(f.runDir, 'launch-status.v1.json'), 'utf8')).ownershipWaitOutcome.kind).toBe(
      'supervisor-lock-wait-expired',
    );
  } finally {
    incumbent.lease();
    await f.cleanup();
  }
});
