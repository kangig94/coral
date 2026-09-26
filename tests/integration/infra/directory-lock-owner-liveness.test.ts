import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireDirectoryLock, type DirectoryLockLease, type DirectoryLockOwnerProbe } from '#src/infra/fs-lock.js';
import {
  createRecordedProcessObserver,
  observeProcessLiveness,
  probeProcessIncarnation,
  readPidNamespace,
} from '#src/infra/node-process.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const leases: DirectoryLockLease[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) lease();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spawnHolder(): { child: ChildProcess; pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
  children.push(child);
  if (child.pid === undefined) throw new Error('Holder process did not start.');
  return { child, pid: child.pid };
}

function ownerProbeFor(pid: number): DirectoryLockOwnerProbe {
  return {
    self: { pid, incarnation: probeProcessIncarnation(pid), pidNamespace: readPidNamespace() },
    observe: createRecordedProcessObserver({
      readIncarnation: (candidate) => probeProcessIncarnation(candidate),
      observeLiveness: observeProcessLiveness,
    }),
  };
}

async function holdRevisionLock(
  runtime: ReturnType<typeof createRealRuntime>,
  stateRoot: string,
  epochKey: string,
  holderPid: number,
): Promise<void> {
  const lockDir = join(stateRoot, 'job-locations.v1', 'epochs', runtime.ids.sha256(epochKey), 'revision.lock');
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  leases.push(
    await acquireDirectoryLock(
      lockDir,
      { storage: runtime.storage, time: runtime.time, owner: ownerProbeFor(holderPid) },
      1_000,
    ),
  );
}

const SUBJECT = { projectRoot: '/workspace/project', workDir: '/workspace/project', jobKind: 'provider' } as const;

describe('job-locations revision lock owner liveness', () => {
  it('lets the next writer proceed promptly once the lock holder has been killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-revision-lock-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const holder = spawnHolder();
    await holdRevisionLock(runtime, root, 'lineage:1', holder.pid);
    holder.child.kill('SIGKILL');
    await once(holder.child, 'exit');

    const startedAt = Date.now();
    const location = new JobLocationIndex(runtime, root).register('job-after-kill', 'lineage:1', SUBJECT);

    expect(location.jobId).toBe('job-after-kill');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('still refuses the next writer while the lock holder is alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-revision-lock-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const holder = spawnHolder();
    await holdRevisionLock(runtime, root, 'lineage:1', holder.pid);

    expect(() => new JobLocationIndex(runtime, root).register('job-while-held', 'lineage:1', SUBJECT)).toThrow(
      /Directory lock timeout/u,
    );
  });
});
