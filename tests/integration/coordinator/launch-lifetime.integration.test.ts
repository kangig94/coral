import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync } from '#src/infra/fs-lock.js';
import * as fileLocks from '#src/infra/fs-lock.js';
import * as nodeProcess from '#src/infra/node-process.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import {
  launchAdmissionPath,
  listLaunchSubjects,
  observeLaunchSubject,
  publishLaunchAdmission,
  readLaunchAdmission,
  removeAbsentLaunchSubject,
} from '#src/infra/launch-admission-record.js';
import { currentLaunchStatus } from '#src/infra/launch-status.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof nodeFs>()) }));

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', receive);
      reject(new Error(`Missing ${kind}`));
    }, 3_000);
    const receive = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== kind) return;
      clearTimeout(timeout);
      child.off('message', receive);
      resolve(value as Record<string, unknown>);
    };
    child.on('message', receive);
  });
}

async function launch(runDir: string, pause: boolean | 'directory', parented = false) {
  const executable = join(runDir, 'child.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/launch-lifetime-child.ts', import.meta.url))],
    outfile: executable,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    plugins: pause
      ? [
          {
            name: 'first-acquisition-window',
            setup(builder) {
              builder.onLoad({ filter: /\/infra\/(fs-lock|launch-admission-record)\.ts$/ }, ({ path }) => ({
                contents:
                  pause === 'directory'
                    ? readFileSync(path, 'utf8').replace(
                        /mkdirSync\(dirname\((\w+)\), \{ recursive: true, mode: 0o700 \}\);/u,
                        `if ($1.includes('launch-lifetimes.v1')) {
                    const parts = dirname($1).split('/');
                    mkdirSync(parts.slice(0, parts.indexOf('launch-lifetimes.v1') + 2).join('/'), { recursive: true });
                    process.send?.({ kind: 'window' });
                    process.kill(process.pid, 'SIGSTOP');
                  }
                  mkdirSync(dirname($1), { recursive: true, mode: 0o700 });`,
                      )
                    : readFileSync(path, 'utf8').replace(
                        "db.exec('PRAGMA busy_timeout = 5000; BEGIN; SELECT count(*) FROM sqlite_schema');",
                        `if (path.includes('launch-lifetimes.v1')) { process.send?.({ kind: 'window' }); process.kill(process.pid, 'SIGSTOP'); }
           db.exec('PRAGMA busy_timeout = 5000; BEGIN; SELECT count(*) FROM sqlite_schema');`,
                      ),
                loader: 'ts',
              }));
            },
          },
        ]
      : [],
  });
  let releaseNamespace: (() => void) | undefined;
  if (!parented) {
    createSharedFileLockSync(supervisorLockPath(runDir))();
    const namespace = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
    if (namespace.kind !== 'acquired') throw new Error('Test parent did not acquire namespace ownership');
    releaseNamespace = namespace.lease;
    if (process.platform === 'linux') expect(new SupervisorEvidence(runDir).lockHolder()?.pid).toBe(process.pid);
  }
  const child = spawn(process.execPath, [executable, ...(parented ? ['parent'] : [])], {
    env: { ...process.env, CORAL_LAUNCH_ADMISSION: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const launchId = pause === 'directory' ? randomUUID().toUpperCase() : randomUUID();
  const parentIncarnation = probeProcessIncarnation(process.pid);
  if (parentIncarnation === null) throw new Error('No test parent incarnation');
  const admitted = parented || pause === 'directory' ? Promise.resolve({}) : message(child, 'coral-launch-admitted');
  child.on('message', (value: unknown) => {
    if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'coral-launch-admitted')
      return;
    child.send({ kind: 'coral-launch-acknowledged', launchId });
    child.send({ kind: 'coral-sentinel-armed' });
  });
  const window = pause ? message(child, 'window') : null;
  child.send({
    kind: 'coral-launch-admit',
    runDir,
    launchId,
    parent: { pid: process.pid, incarnation: parentIncarnation },
    purpose: 'startup',
    build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' },
  });
  return { child, admitted, window, launchId, parentIncarnation, releaseNamespace };
}

async function stop(child: ChildProcess, signal?: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (signal === undefined) child.send('exit');
  else {
    child.kill(signal);
  }
  await exit;
}

describe('child lifetime admission', () => {
  it('retains conflicting published prefixes when another publication is attempted', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-incomplete-published-'));
    const launchId = randomUUID();
    const published = join(runDir, 'launch-lifetimes.v1', launchId);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('No test publisher incarnation');
    mkdirSync(join(published, 'unknown-envelope'), { recursive: true });
    try {
      expect(() =>
        publishLaunchAdmission(runDir, {
          version: 1,
          launchId,
          child: { pid: process.pid, incarnation },
          parent: { pid: process.pid, incarnation },
          admittedAt: Date.now(),
          purpose: 'startup',
          build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' },
        }),
      ).toThrow('Coordinator admission envelope is incomplete or conflicting');
      expect(readdirSync(published)).toEqual(['unknown-envelope']);
      expect(readLaunchAdmission(runDir, launchId).kind).toBe('absent');
      expect(listLaunchSubjects(runDir)).toMatchObject([{ problem: 'envelope-unavailable' }]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('retains newly conflicting lifetime evidence during stale-subject cleanup', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-cleanup-conflict-'));
    const running = await launch(runDir, false);
    try {
      await running.admitted;
      const [subject] = listLaunchSubjects(runDir);
      if (subject === undefined) throw new Error('Missing lifetime subject');
      await stop(running.child, 'SIGKILL');
      const conflict = join(runDir, 'launch-lifetimes.v1', running.launchId, 'unknown-envelope');
      mkdirSync(conflict);
      expect(removeAbsentLaunchSubject(subject)).toBe(false);
      expect(existsSync(conflict)).toBe(true);
      expect(readLaunchAdmission(runDir, running.launchId).kind).toBe('readable');
    } finally {
      await stop(running.child, 'SIGKILL');
      running.releaseNamespace?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('normalizes a new owner after lifetime cleanup is interrupted', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-cleanup-interrupted-'));
    const running = await launch(runDir, false);
    const removeTree = nodeFs.rmSync;
    try {
      await running.admitted;
      await stop(running.child, 'SIGKILL');
      vi.spyOn(nodeFs, 'rmSync').mockImplementation((path, options) => {
        if (String(path).includes('launch-lifetimes.v1')) throw new Error('Interrupted hierarchy cleanup');
        removeTree(path, options);
      });
      const owner = { pid: process.pid, incarnation: running.parentIncarnation };
      const memory = new SupervisorLaunchMemory(runDir, owner, 'build-A');
      memory.reconcileAdmissions();
      expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
        path: launchAdmissionPath(runDir, running.launchId),
        disposition: 'cleanup-pending',
      });
      const replacement = new SupervisorLaunchMemory(runDir, owner, 'build-A');
      replacement.reconcileAdmissions();
      expect(replacement.read().owner.mode).toBe('supervised');
      expect(replacement.hasUnknownOccupancy()).toBe(false);
      expect(replacement.reserve(replacement.read().owner, 'build-A', 'startup')).not.toBeNull();
      vi.restoreAllMocks();
      replacement.reconcileAdmissions();
      expect(readdirSync(join(runDir, 'launch-lifetimes.v1'))).toEqual([]);
      expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await stop(running.child, 'SIGKILL');
      running.releaseNamespace?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('normalizes and launches after a crash before lifetime directory creation completes', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-directory-crash-'));
    const interrupted = await launch(runDir, 'directory');
    let recovered: Awaited<ReturnType<typeof launch>> | undefined;
    let release: (() => void) | undefined;
    try {
      await interrupted.window;
      expect.soft(listLaunchSubjects(runDir)).toEqual([]);
      const preparation = readdirSync(join(runDir, 'launch-lifetimes.v1'));
      const probe = vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null);
      try {
        const memory = new SupervisorLaunchMemory(
          runDir,
          { pid: process.pid, incarnation: interrupted.parentIncarnation },
          'build-A',
        );
        memory.reconcileAdmissions();
        expect(readdirSync(join(runDir, 'launch-lifetimes.v1'))).toEqual(preparation);
      } finally {
        probe.mockRestore();
      }
      await stop(interrupted.child, 'SIGKILL');
      interrupted.releaseNamespace?.();
      const namespace = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (namespace.kind !== 'acquired') throw new Error('Recovery did not acquire namespace ownership');
      release = namespace.lease;
      const memory = new SupervisorLaunchMemory(
        runDir,
        { pid: process.pid, incarnation: interrupted.parentIncarnation },
        'build-A',
      );
      memory.reconcileAdmissions();
      expect(memory.read().owner.mode).toBe('supervised');
      expect(memory.hasUnknownOccupancy()).toBe(false);
      expect(memory.reserve(memory.read().owner, 'build-A', 'startup')).not.toBeNull();
      expect(readdirSync(join(runDir, 'launch-lifetimes.v1'))).toEqual([]);
      release();
      release = undefined;
      recovered = await launch(runDir, false);
      await recovered.admitted;
      expect(readLaunchAdmission(runDir, recovered.launchId).kind).toBe('readable');
      expect(listLaunchSubjects(runDir)).toHaveLength(1);
    } finally {
      release?.();
      interrupted.releaseNamespace?.();
      if (recovered !== undefined) {
        await stop(recovered.child, 'SIGKILL');
        recovered.releaseNamespace?.();
      }
      await stop(interrupted.child, 'SIGKILL');
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it.each(['matching', 'unknown'] as const)(
    'retains a %s first-acquisition subject after its actual supervisor dies, then settles only on exit',
    async (identity) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-parent-loss-'));
      const running = await launch(runDir, true, true);
      let childPid: number | undefined;
      let release: (() => void) | undefined;
      try {
        const window = await running.window;
        childPid = window?.childPid as number;
        const [subject] = listLaunchSubjects(runDir);
        if (subject?.lifetimePath === undefined || subject.admission === undefined) throw new Error('Missing subject');
        const namespaceInode = statSync(supervisorLockPath(runDir));
        expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
        await stop(running.child, 'SIGKILL');
        const namespace = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
        expect(namespace.kind).toBe('acquired');
        if (namespace.kind !== 'acquired') throw new Error('Replacement did not acquire namespace');
        release = namespace.lease;
        expect(statSync(supervisorLockPath(runDir)).ino).toBe(namespaceInode.ino);
        expect(statSync(supervisorLockPath(runDir)).dev).toBe(namespaceInode.dev);
        if (process.platform === 'linux') expect(new SupervisorEvidence(runDir).lockHolder()?.pid).toBe(process.pid);
        expect(nodeProcess.observeProcessLiveness(childPid)).toBe('alive');
        const probe =
          identity === 'unknown' ? vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null) : null;
        const exclusive = attemptExclusiveFileLockSync(subject.lifetimePath);
        expect(exclusive.kind).toBe('acquired');
        if (exclusive.kind === 'acquired') exclusive.lease();
        const memory = new SupervisorLaunchMemory(
          runDir,
          { pid: process.pid, incarnation: running.parentIncarnation },
          'build-A',
        );
        memory.reconcileAdmissions();
        expect(memory.read().owner.mode).toBe('recovering');
        expect(memory.read().launch).toMatchObject({
          child: subject.admission.child,
          admittedAt: subject.admission.admittedAt,
        });
        expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).toBeNull();
        expect(memory.release()).toBe(false);
        expect(existsSync(subject.lifetimePath)).toBe(true);
        expect(readLaunchAdmission(runDir, running.launchId).kind).toBe('absent');
        expect(removeAbsentLaunchSubject(subject)).toBe(false);
        if (identity === 'unknown')
          expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
            path: subject.path,
            disposition: 'acquisition-window',
          });
        probe?.mockRestore();
        process.kill(childPid, 'SIGCONT');
        await vi.waitFor(() => expect(nodeProcess.probeProcessIncarnation(childPid!)).toBeNull(), { timeout: 3_000 });
        memory.reconcileAdmissions();
        expect(memory.read().launch?.phase).toBe('exited');
        expect(memory.read().owner.mode).toBe('supervised');
        expect(existsSync(subject.lifetimePath)).toBe(false);
        memory.reconcileAdmissions();
        expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
      } finally {
        release?.();
        vi.restoreAllMocks();
        if (childPid !== undefined && nodeProcess.probeProcessIncarnation(childPid) !== null)
          process.kill(childPid, 'SIGKILL');
        await stop(running.child, 'SIGKILL');
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );
  it('retains a live first-acquisition window and an unknown identity despite exclusive probes', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-window-'));
    const running = await launch(runDir, true);
    try {
      await running.window;
      const [subject] = listLaunchSubjects(runDir);
      if (subject?.lifetimePath === undefined || subject.admission === undefined)
        throw new Error('Missing lifetime envelope');
      const originalTime = subject.admission.admittedAt;
      expect(subject.acquisitionComplete).toBe(false);
      expect(readFileSync(subject.lifetimePath)).toHaveLength(0);
      expect(readLaunchAdmission(runDir, running.launchId).kind).toBe('absent');
      const exclusive = attemptExclusiveFileLockSync(subject.lifetimePath);
      expect(exclusive.kind).toBe('acquired');
      if (exclusive.kind === 'acquired') exclusive.lease();
      expect(observeLaunchSubject(subject)).toBe('occupied');
      const memory = new SupervisorLaunchMemory(
        runDir,
        { pid: process.pid, incarnation: running.parentIncarnation },
        'build-A',
      );
      expect(memory.read().launch?.admittedAt).toBe(originalTime);
      expect(memory.read().owner.mode).toBe('recovering');
      expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).toBeNull();
      const probe = vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null);
      expect(observeLaunchSubject(subject)).toBe('acquisition-window');
      memory.reconcileAdmissions();
      expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
        path: subject.path,
        disposition: 'acquisition-window',
      });
      expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).toBeNull();
      expect(memory.read().owner.mode).toBe('recovering');
      expect(existsSync(subject.lifetimePath)).toBe(true);
      probe.mockRestore();
      running.child.kill('SIGCONT');
      await running.admitted;
      const json = readLaunchAdmission(runDir, running.launchId);
      expect(json).toMatchObject({ kind: 'readable', admission: { admittedAt: originalTime } });
      expect(attemptExclusiveFileLockSync(subject.lifetimePath).kind).toBe('contended');
      await stop(running.child);
      expect(readLaunchAdmission(runDir, running.launchId).kind).toBe('absent');
      memory.reconcileAdmissions();
      expect(existsSync(subject.lifetimePath)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await stop(running.child, 'SIGKILL');
      running.releaseNamespace?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('cleans corrupt abrupt-exit admissions under the namespace owner and retries failed cleanup without reopening occupancy', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-cleanup-'));
    const running = await launch(runDir, false);
    try {
      await running.admitted;
      const [subject] = listLaunchSubjects(runDir);
      if (subject?.lifetimePath === undefined) throw new Error('Missing lifetime subject');
      writeFileSync(launchAdmissionPath(runDir, running.launchId), '{');
      const memory = new SupervisorLaunchMemory(
        runDir,
        { pid: process.pid, incarnation: running.parentIncarnation },
        'build-A',
      );
      expect(memory.read().launch?.child?.pid).toBe(running.child.pid);
      expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).toBeNull();
      await stop(running.child, 'SIGKILL');
      const probe = vi
        .spyOn(fileLocks, 'attemptExclusiveFileLockSync')
        .mockReturnValue({ kind: 'unobservable', cause: new Error('cleanup unavailable') });
      memory.reconcileAdmissions();
      expect(memory.read().launch?.phase).toBe('exited');
      expect(memory.read().owner.mode).toBe('supervised');
      expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
        path: subject.path,
        disposition: 'cleanup-pending',
      });
      expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).not.toBeNull();
      expect(existsSync(subject.path)).toBe(true);
      probe.mockRestore();
      memory.reconcileAdmissions();
      expect(existsSync(subject.path)).toBe(false);
      expect(existsSync(subject.lifetimePath)).toBe(false);
      memory.reconcileAdmissions();
      expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await stop(running.child, 'SIGKILL');
      running.releaseNamespace?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps the lifetime descriptor out of a descendant and releases it only at the admitted child exit', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-lifetime-descriptor-'));
    const running = await launch(runDir, false);
    let descendant: number | undefined;
    try {
      await running.admitted;
      const reply = message(running.child, 'descendant');
      running.child.send('spawn-descendant');
      descendant = (await reply).pid as number;
      const [subject] = listLaunchSubjects(runDir);
      if (subject?.lifetimePath === undefined) throw new Error('Missing lifetime subject');
      expect(attemptExclusiveFileLockSync(subject.lifetimePath).kind).toBe('contended');
      await stop(running.child);
      expect(nodeProcess.observeProcessLiveness(descendant)).toBe('alive');
      const exclusive = attemptExclusiveFileLockSync(subject.lifetimePath);
      expect(exclusive.kind).toBe('acquired');
      if (exclusive.kind === 'acquired') exclusive.lease();
    } finally {
      if (descendant !== undefined) process.kill(descendant, 'SIGKILL');
      await stop(running.child, 'SIGKILL');
      running.releaseNamespace?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
