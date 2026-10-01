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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { currentLaunchStatus, readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { tryAcquireDiagnosticDirectoryLock } from '#src/infra/fs-lock.js';
import { listLaunchAdmissions } from '#src/infra/launch-admission-record.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { createPluginFixture, waitForDiscoveryRecord } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof nodeFs>()) }));

it.each(['owner-foreign.lock', 'claim-foreign.lock'])(
  'preserves a conflicting %s during diagnostic release and resumes publication after repair',
  async (marker) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-release-conflict-'));
    const lockDir = join(runDir, 'launch-status.v1.lock');
    const release = tryAcquireDiagnosticDirectoryLock(lockDir);
    if (release === null) throw new Error('Missing publisher lease');
    const inode = statSync(lockDir).ino;
    const foreign = join(lockDir, marker);
    writeFileSync(foreign, 'unresolved publisher');
    try {
      release();
      expect(existsSync(foreign)).toBe(true);
      expect(statSync(lockDir).ino).toBe(inode);
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        admissionHolds: [{ path: '/child', disposition: 'unknown' }],
      }));
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
      unlinkSync(foreign);
      await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 3_000);
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
      expect(readdirSync(runDir).some((name) => name.includes('.publisher-'))).toBe(false);
    } finally {
      rmSync(foreign, { force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('keeps publisher identity recoverable when status lease release is interrupted', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-release-crash-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const removeDirectory = nodeFs.rmdirSync;
  vi.spyOn(nodeFs, 'rmdirSync').mockImplementation((path, options) => {
    if (String(path) === lockDir) throw new Error('Interrupted directory release');
    removeDirectory(path, options);
  });
  const release = tryAcquireDiagnosticDirectoryLock(lockDir);
  if (release === null) throw new Error('Missing publisher lease');
  try {
    release();
    expect(existsSync(lockDir)).toBe(false);
    const next = tryAcquireDiagnosticDirectoryLock(lockDir);
    expect(next).not.toBeNull();
    next?.();
  } finally {
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('retries a refused status directory release while publication reports the closed publisher hold', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-release-retry-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const rename = nodeFs.renameSync;
  let blocked = false;
  vi.spyOn(nodeFs, 'renameSync').mockImplementation((source, destination) => {
    if (blocked && String(source) === lockDir)
      throw Object.assign(new Error('Release unavailable'), { code: 'EACCES' });
    rename(source, destination);
  });
  const release = tryAcquireDiagnosticDirectoryLock(lockDir);
  if (release === null) throw new Error('Missing publisher lease');
  try {
    blocked = true;
    release();
    expect(readdirSync(lockDir)).toEqual([expect.stringMatching(/^claim-release-/u)]);
    updateLaunchStatus(runDir, (status) => ({
      ...status,
      admissionHolds: [{ path: '/child', disposition: 'unknown' }],
    }));
    expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
    blocked = false;
    await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 3_000);
    expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
    expect(readdirSync(runDir).some((name) => name.includes('.publisher-'))).toBe(false);
  } finally {
    blocked = false;
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('retries private release cleanup without displacing a new status publisher', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-private-release-retry-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const remove = nodeFs.rmSync;
  let blocked = false;
  vi.spyOn(nodeFs, 'rmSync').mockImplementation((path, options) => {
    if (blocked && String(path).includes('.publisher-'))
      throw Object.assign(new Error('Cleanup unavailable'), { code: 'EACCES' });
    remove(path, options);
  });
  let next: ReturnType<typeof tryAcquireDiagnosticDirectoryLock> = null;
  try {
    const release = tryAcquireDiagnosticDirectoryLock(lockDir);
    if (release === null) throw new Error('Missing publisher lease');
    blocked = true;
    release();
    expect(existsSync(lockDir)).toBe(false);
    expect(readdirSync(runDir).some((name) => name.includes('.publisher-'))).toBe(true);
    next = tryAcquireDiagnosticDirectoryLock(lockDir);
    if (next === null) throw new Error('New publisher was blocked by private cleanup');
    const inode = statSync(lockDir).ino;
    blocked = false;
    await waitForCondition(() => !readdirSync(runDir).some((name) => name.includes('.publisher-')), 3_000);
    next.assertOwned();
    expect(statSync(lockDir).ino).toBe(inode);
  } finally {
    blocked = false;
    next?.();
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('syncs the publisher marker and prepared directory before publishing serialization ownership', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-durable-owner-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const open = nodeFs.openSync;
  const sync = nodeFs.fsyncSync;
  const rename = nodeFs.renameSync;
  const opened = new Map<number, string>();
  const synced: string[] = [];
  vi.spyOn(nodeFs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    opened.set(fd, String(path));
    return fd;
  });
  vi.spyOn(nodeFs, 'fsyncSync').mockImplementation((fd) => {
    synced.push(opened.get(fd)!);
    sync(fd);
  });
  vi.spyOn(nodeFs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination) === lockDir) {
      expect(synced).toContain(String(source));
      const marker = readdirSync(source.toString()).find((name) => name.startsWith('owner-'));
      expect(marker).toBeDefined();
      expect(synced).toContain(join(String(source), marker!));
    }
    rename(source, destination);
  });
  let release: ReturnType<typeof tryAcquireDiagnosticDirectoryLock> = null;
  try {
    release = tryAcquireDiagnosticDirectoryLock(lockDir);
    expect(release).not.toBeNull();
  } finally {
    release?.();
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each([
  'before writing its owner marker',
  'before publishing its directory',
  'after publishing its directory',
] as const)('recovers durable status after a publisher crashes %s', async (boundary) => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-owner-crash-'));
  const executable = join(runDir, 'publisher.cjs');
  await build({
    stdin: {
      contents: `import { updateLaunchStatus } from '${fileURLToPath(new URL('../../../src/infra/launch-status.ts', import.meta.url))}'; updateLaunchStatus(process.argv[2], status => status);`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    outfile: executable,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
    plugins: [
      {
        name: 'before-owner-marker',
        setup(builder) {
          builder.onLoad({ filter: /\/infra\/fs-lock\.ts$/ }, ({ path }) => ({
            contents: readFileSync(path, 'utf8').replace(
              boundary === 'before writing its owner marker'
                ? 'storage.writeFileSync(lockOwnerMarkerPath(lockDir, ownerToken)'
                : boundary === 'before publishing its directory'
                  ? 'deps.storage.renameSync(prepared, lockDir);'
                  : 'return createDirectoryLockLease(lockDir, ownerToken, markerContent, identity, deps, undefined, prepared);',
              `process.send?.('publication-boundary'); process.kill(process.pid, 'SIGSTOP'); ` +
                (boundary === 'before writing its owner marker'
                  ? 'storage.writeFileSync(lockOwnerMarkerPath(lockDir, ownerToken)'
                  : boundary === 'before publishing its directory'
                    ? 'deps.storage.renameSync(prepared, lockDir);'
                    : 'return createDirectoryLockLease(lockDir, ownerToken, markerContent, identity, deps, undefined, prepared);'),
            ),
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const publisher = spawn(process.execPath, [executable, runDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Publisher did not reach marker boundary')), 3_000);
      publisher.once('message', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const hold = { path: '/fixture/exact-child', disposition: 'unknown' as const };
    updateLaunchStatus(runDir, (status) => ({ ...status, admissionHolds: [hold] }));
    if (boundary === 'after publishing its directory')
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
    else {
      expect(readLaunchStatus(runDir).kind).toBe('readable');
      expect(readdirSync(runDir).some((name) => name.includes('.publisher-'))).toBe(true);
    }
    const exit = new Promise<void>((resolve) => publisher.once('exit', () => resolve()));
    publisher.kill('SIGKILL');
    await exit;
    if (boundary !== 'after publishing its directory') updateLaunchStatus(runDir, (status) => status);
    await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 3_000);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { admissionHolds: [hold] } });
    expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
    expect(readdirSync(runDir).some((name) => name.includes('.publisher-'))).toBe(false);
  } finally {
    publisher.kill('SIGKILL');
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('preserves an anonymous or live status serialization directory regardless of age', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-preserve-owner-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  try {
    mkdirSync(lockDir);
    utimesSync(lockDir, new Date(0), new Date(0));
    const anonymous = statSync(lockDir);
    expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
    expect(statSync(lockDir).ino).toBe(anonymous.ino);
    rmSync(lockDir, { recursive: true });
    const owner = tryAcquireDiagnosticDirectoryLock(lockDir);
    if (owner === null) throw new Error('Missing status publisher lease');
    const live = statSync(lockDir);
    try {
      for (const name of readdirSync(lockDir)) utimesSync(join(lockDir, name), new Date(0), new Date(0));
      expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
      expect(statSync(lockDir).ino).toBe(live.ino);
    } finally {
      owner();
    }
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each(['owner', 'claim'])(
  'keeps serving through multiple %s status markers and republishes current holds after recovery',
  async (marker) => {
    const roots: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'coral-status-publication-'));
    const otherHome = mkdtempSync(join(tmpdir(), 'coral-status-independent-'));
    roots.push(home, otherHome);
    const fixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const runDir = coordinatorPaths('prod', { baseDir: join(home, '.coral') }).runDir;
    const lockDir = join(runDir, 'launch-status.v1.lock');
    mkdirSync(lockDir, { recursive: true });
    for (const id of ['one', 'two']) writeFileSync(join(lockDir, `${marker}-${id}.lock`), '{}');
    mkdirSync(join(runDir, 'launch-admissions.v1'));
    const oldAdmission = join(runDir, 'launch-admissions.v1', '00000000-0000-4000-8000-000000000001.json');
    writeFileSync(oldAdmission, '{');
    const oldDatabase = join(runDir, 'coordinator-launch.v1.sqlite');
    writeFileSync(oldDatabase, 'leftover branch database');
    const harness = join(home, 'supervisor.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/namespace-supervisor-harness.ts', import.meta.url))],
      outfile: harness,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node:*'],
    });
    const supervisors: ChildProcess[] = [];
    const children: { pid: number; incarnation?: string }[] = [];
    const start = (root: string) => {
      const child = spawn(process.execPath, [harness, join(fixture.root, 'bridge', 'coral-backend.cjs')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          CORAL_FIXTURE_REAL_BACKEND: '1',
          CORAL_SENTINEL_RUN_DIR: coordinatorPaths('prod', { baseDir: join(root, '.coral') }).runDir,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      supervisors.push(child);
      return child;
    };
    try {
      const supervisor = start(home);
      const serving = await waitForDiscoveryRecord(home, 'prod', 15_000);
      children.push(serving);
      supervisor.send('fixture-status-hold');
      const other = start(otherHome);
      const independent = await waitForDiscoveryRecord(otherHome, 'prod', 15_000);
      children.push(independent);
      const health = () =>
        requestIpcMethod<HealthSnapshot>(serving.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: serving.bootToken },
          timeoutMs: 1_000,
        });
      let current = await health();
      for (let retry = 0; retry < 30 && current.launchStatus?.hold?.kind !== 'custody-unreadable'; retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        current = await health();
      }
      expect(current.status).toBe('ok');
      expect(current.launchStatus).toMatchObject({
        hold: { kind: 'custody-unreadable', path: '/fixture/custody' },
        publicationFailure: { code: 'status-publication-unavailable' },
      });
      expect(supervisor.exitCode).toBeNull();
      expect(other.exitCode).toBeNull();
      expect(readdirSync(lockDir).sort()).toEqual([`${marker}-one.lock`, `${marker}-two.lock`]);
      await expect(
        requestIpcMethod(independent.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: independent.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
      const admissions = listLaunchAdmissions(runDir);
      expect(admissions).toHaveLength(1);
      expect(admissions[0]).toMatchObject({
        kind: 'readable',
        admission: { admittedAt: serving.supervision?.admittedAt },
      });
      expect(readFileSync(oldAdmission, 'utf8')).toBe('{');
      expect(readFileSync(oldDatabase, 'utf8')).toBe('leftover branch database');
      expect(probeProcessIncarnation(process.pid)).not.toBeNull();
      const retryStarted = Date.now();
      rmSync(lockDir, { recursive: true });
      await waitForCondition(() => {
        const status = readLaunchStatus(runDir);
        return status.kind === 'readable' && status.status.hold?.kind === 'custody-unreadable';
      }, 3_000);
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { hold: { path: '/fixture/custody' } },
      });
      current = await health();
      while (current.launchStatus?.publicationFailure !== undefined && Date.now() - retryStarted < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        current = await health();
      }
      expect(current).toMatchObject({ status: 'ok', launchStatus: { hold: { path: '/fixture/custody' } } });
      expect(current.launchStatus?.publicationFailure).toBeUndefined();
      expect(Date.now() - retryStarted).toBeLessThan(3_000);
      expect(readdirSync(runDir).some((name) => name.includes('fallback'))).toBe(false);
    } finally {
      for (const supervisor of supervisors) supervisor.kill('SIGKILL');
      for (const child of children) {
        if (probeProcessIncarnation(child.pid) === child.incarnation) process.kill(child.pid, 'SIGKILL');
      }
      await Promise.all(
        supervisors.map((supervisor) =>
          supervisor.exitCode !== null || supervisor.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) => supervisor.once('exit', () => resolve())),
        ),
      );
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
  35_000,
);
