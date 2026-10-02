import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { observeProcessLiveness, probeProcessIncarnation, readPidNamespace } from '#src/infra/node-process.js';
import { currentLaunchStatus, readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { tryAcquireDiagnosticDirectoryLock } from '#src/infra/fs-lock.js';
import { listLaunchAdmissions } from '#src/infra/launch-admission-record.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HealthSnapshot } from '#src/transport/server-ports.js';
import { createPluginFixture, waitForDiscoveryRecord } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof nodeFs>()) }));

it.each(['directory read', 'inode observation', 'marker population', 'marker observation', 'quarantine rename'])(
  'resumes an abandoned reclamation after transient %s and failed restoration',
  async (fault) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-abandoned-claim-'));
    const lockDir = join(runDir, 'launch-status.v1.lock');
    const rename = nodeFs.renameSync;
    const readDirectory = nodeFs.readdirSync;
    const read = nodeFs.readFileSync;
    const stat = nodeFs.statSync;
    let claimed = false;
    let injected = false;
    let retry = false;
    const fail = (): never => {
      injected = true;
      throw Object.assign(new Error('Transient reclamation failure'), { code: 'EIO' });
    };
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, 'owner-dead.lock'),
      JSON.stringify({ pid: 2_147_483_647, pidNamespace: readPidNamespace() }),
    );
    vi.spyOn(nodeFs, 'renameSync').mockImplementation((source, destination) => {
      if (!retry && String(source).includes('/claim-reclaim-')) throw new Error('Restoration unavailable');
      if (claimed && !injected && fault === 'quarantine rename' && String(source) === lockDir) fail();
      rename(source, destination);
      if (String(destination).includes('/claim-reclaim-')) claimed = true;
    });
    vi.spyOn(nodeFs, 'readdirSync').mockImplementation((...args) => {
      if (claimed && !injected && String(args[0]) === lockDir) {
        if (fault === 'directory read') fail();
        if (fault === 'marker population') {
          injected = true;
          writeFileSync(join(lockDir, 'claim-conflict.lock'), 'unknown');
        }
      }
      return readDirectory(...args);
    });
    vi.spyOn(nodeFs, 'statSync').mockImplementation((...args) => {
      if (claimed && !injected && fault === 'inode observation' && String(args[0]) === lockDir) fail();
      return stat(...args);
    });
    vi.spyOn(nodeFs, 'readFileSync').mockImplementation((...args) => {
      if (claimed && !injected && fault === 'marker observation' && String(args[0]).includes('/claim-reclaim-')) fail();
      return read(...args);
    });
    try {
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        admissionHolds: [{ path: '/child', disposition: 'unknown' }],
      }));
      expect(injected).toBe(true);
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
      expect(readdirSync(lockDir)).toContainEqual(expect.stringMatching(/^claim-reclaim-/u));
      retry = true;
      rmSync(join(lockDir, 'claim-conflict.lock'), { force: true });
      await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 3_000);
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { admissionHolds: [{ path: '/child', disposition: 'unknown' }] },
      });
    } finally {
      retry = true;
      vi.restoreAllMocks();
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')('republishes after an old UUID-only reclaimer crashes', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-old-reclaimer-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const claimPath = join(lockDir, 'claim-' + randomUUID() + '.lock');
  const markerContent = JSON.stringify({ pid: 2_147_483_647, pidNamespace: readPidNamespace() });
  mkdirSync(lockDir);
  const claimant = spawn(
    process.execPath,
    [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2]); process.send('claimed'); setInterval(() => {}, 1000);",
      claimPath,
      markerContent,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  let claimed = false;
  claimant.on('message', (message) => {
    if (message === 'claimed') claimed = true;
  });
  try {
    await waitForCondition(() => claimed, 5_000);
    expect(readdirSync(lockDir)).toEqual([expect.stringMatching(/^claim-[0-9a-f-]{36}\.lock$/u)]);
    expect(readFileSync(claimPath, 'utf8')).toBe(markerContent);
    claimant.kill('SIGKILL');
    await waitForCondition(() => claimant.signalCode !== null, 5_000);
    expect(observeProcessLiveness(claimant.pid!)).toBe('absent');
    updateLaunchStatus(runDir, (status) => ({
      ...status,
      admissionHolds: [{ path: '/child', disposition: 'unknown' }],
    }));
    await waitForCondition(() => readLaunchStatus(runDir).kind === 'readable', 3_000);
    expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: { admissionHolds: [{ path: '/child', disposition: 'unknown' }] },
    });
  } finally {
    claimant.kill('SIGKILL');
    await waitForCondition(() => claimant.signalCode !== null, 5_000);
    rmSync(runDir, { recursive: true, force: true });
  }
});

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

it('keeps publisher identity recoverable when status lease release is interrupted', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-release-crash-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const removeDirectory = nodeFs.rmSync;
  let interrupted = false;
  vi.spyOn(nodeFs, 'rmSync').mockImplementation((path, options) => {
    if (!interrupted && String(path).includes('.publisher-')) {
      interrupted = true;
      throw new Error('Interrupted directory release');
    }
    removeDirectory(path, options);
  });
  const release = tryAcquireDiagnosticDirectoryLock(lockDir);
  if (release === null) throw new Error('Missing publisher lease');
  try {
    release();
    expect(interrupted).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
    const [prepared] = readdirSync(runDir);
    expect(prepared).toContain('.publisher-');
    const [claim] = readdirSync(join(runDir, prepared));
    expect(claim).toMatch(/^claim-release-/u);
    expect(JSON.parse(readFileSync(join(runDir, prepared, claim), 'utf8'))).toMatchObject({ pid: process.pid });
    const next = tryAcquireDiagnosticDirectoryLock(lockDir);
    expect(next).not.toBeNull();
    next?.();
    await waitForCondition(() => readdirSync(runDir).length === 0, 3_000);
  } finally {
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux').each(['resumes', 'exits'] as const)(
  'protects a live stale reclaimer until it %s',
  async (outcome) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-reclaimer-race-'));
    const lockDir = join(runDir, 'launch-status.v1.lock');
    const executable = join(runDir, 'reclaimer.cjs');
    await build({
      stdin: {
        contents: `import { tryAcquireDiagnosticDirectoryLock } from '${fileURLToPath(new URL('../../../src/infra/fs-lock.ts', import.meta.url))}'; const lease = tryAcquireDiagnosticDirectoryLock(process.argv[2]); lease?.assertOwned(); process.send?.({ acquired: lease !== null }); setInterval(() => {}, 1000);`,
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
          name: 'pause-verified-reclaimer',
          setup(builder) {
            builder.onLoad({ filter: /\/infra\/fs-lock\.ts$/ }, ({ path }) => ({
              contents: readFileSync(path, 'utf8').replace(
                'deps.storage.renameSync(lockDir, quarantinePath);',
                "process.send?.('verified-claim'); process.kill(process.pid, 'SIGSTOP'); deps.storage.renameSync(lockDir, quarantinePath);",
              ),
              loader: 'ts',
            }));
          },
        },
      ],
    });
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, 'owner-dead.lock'),
      JSON.stringify({
        pid: 2_147_483_647,
        pidNamespace: readPidNamespace(),
      }),
    );
    const claimant = spawn(process.execPath, [executable, lockDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let verified = false;
    let acquired = false;
    claimant.on('message', (message) => {
      if (message === 'verified-claim') verified = true;
      if (typeof message === 'object' && message !== null && 'acquired' in message)
        acquired = message.acquired === true;
    });
    let next: ReturnType<typeof tryAcquireDiagnosticDirectoryLock> = null;
    try {
      await waitForCondition(() => verified, 5_000);
      const inode = statSync(lockDir).ino;
      next = tryAcquireDiagnosticDirectoryLock(lockDir);
      expect(next).toBeNull();
      expect(statSync(lockDir).ino).toBe(inode);
      if (outcome === 'resumes') {
        claimant.kill('SIGCONT');
        await waitForCondition(() => acquired, 5_000);
        expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
      }
      claimant.kill('SIGKILL');
      await waitForCondition(() => claimant.signalCode !== null, 5_000);
      next = tryAcquireDiagnosticDirectoryLock(lockDir);
      expect(next).not.toBeNull();
      next?.assertOwned();
    } finally {
      claimant.kill('SIGKILL');
      await waitForCondition(() => claimant.signalCode !== null, 5_000);
      next?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('refuses to quarantine a replaced directory after verifying a stale marker', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-reclaimer-inode-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const retired = join(runDir, 'retired');
  const read = nodeFs.readFileSync;
  const rename = nodeFs.renameSync;
  const next: { lease: ReturnType<typeof tryAcquireDiagnosticDirectoryLock> } = { lease: null };
  let replaced = false;
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, 'owner-dead.lock'),
    JSON.stringify({ pid: 2_147_483_647, pidNamespace: readPidNamespace() }),
  );
  vi.spyOn(nodeFs, 'readFileSync').mockImplementation((...args) => {
    const content = read(...args);
    if (!replaced && String(args[0]).includes('/claim-')) {
      replaced = true;
      rename(lockDir, retired);
      next.lease = tryAcquireDiagnosticDirectoryLock(lockDir);
    }
    return content;
  });
  try {
    expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
    expect(replaced).toBe(true);
    expect(next.lease).not.toBeNull();
    next.lease?.assertOwned();
  } finally {
    next.lease?.();
    vi.restoreAllMocks();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each(['unidentifiable', 'malformed', 'foreign namespace'] as const)(
  'preserves a reclamation claim with %s claimant identity',
  (identity) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-unknown-reclaimer-'));
    const lockDir = join(runDir, 'launch-status.v1.lock');
    const claimant =
      identity === 'malformed'
        ? 'invalid'
        : Buffer.from(JSON.stringify([2_147_483_647, null, 'foreign'])).toString('base64url');
    const name =
      identity === 'unidentifiable'
        ? 'claim-interrupted.lock'
        : `claim-reclaim-${claimant}-00000000-0000-0000-0000-000000000000.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, name), JSON.stringify({ pid: 2_147_483_647, pidNamespace: readPidNamespace() }));
    const inode = statSync(lockDir).ino;
    try {
      expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
      expect(statSync(lockDir).ino).toBe(inode);
      expect(readdirSync(lockDir)).toEqual([name]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it.each(['live', 'unknown'] as const)('preserves UUID-only residue with %s publisher evidence', (evidence) => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-uuid-residue-'));
  const lockDir = join(runDir, 'launch-status.v1.lock');
  const name = 'claim-00000000-0000-0000-0000-000000000000.lock';
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, name),
    evidence === 'live' ? JSON.stringify({ pid: process.pid, pidNamespace: readPidNamespace() }) : '{}',
  );
  const inode = statSync(lockDir).ino;
  try {
    expect(tryAcquireDiagnosticDirectoryLock(lockDir)).toBeNull();
    expect(statSync(lockDir).ino).toBe(inode);
    expect(readdirSync(lockDir)).toEqual([name]);
  } finally {
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
      await stopRecordedProcesses(
        children.map((child) => ({ pid: child.pid, incarnation: child.incarnation ?? null })),
      );
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
