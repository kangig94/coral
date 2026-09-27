import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CoordinatorLaunchRecord, LAUNCH_OWNER_LEASE_MS } from '#src/infra/coordinator-launch.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coordinator launch admission', () => {
  it('revokes a live stalled holder before child admission and preserves an already admitted child', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-record-'));
    roots.push(runDir);
    const first = new CoordinatorLaunchRecord(runDir);
    const second = new CoordinatorLaunchRecord(runDir);
    const stalled = spawn(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'], {
      stdio: 'ignore',
    });
    await once(stalled, 'spawn');
    if (stalled.pid === undefined) throw new Error('stalled holder has no PID');
    const stalledIncarnation = probeProcessIncarnation(stalled.pid);
    if (stalledIncarnation === null) throw new Error('stalled holder has no incarnation');
    const incarnation = (value: string) => value as ProcessIncarnation;
    const at = 1_000;
    const old = first.acquire(
      {
        id: 'old',
        process: { pid: stalled.pid, incarnation: stalledIncarnation },
        buildSetId: 'A',
      },
      at,
    );
    expect(old).not.toBeNull();
    if (old === null) throw new Error('first owner was not admitted');
    const stale = first.reserve(old, 'A', 'startup', at);
    expect(stale).not.toBeNull();
    if (stale === null) throw new Error('first launch was not reserved');

    const nextAt = at + LAUNCH_OWNER_LEASE_MS + 1;
    expect(observeProcessLiveness(stalled.pid)).toBe('alive');
    const next = second.acquire(
      {
        id: 'new',
        process: { pid: 200, incarnation: incarnation('new-process') },
        buildSetId: 'B',
      },
      nextAt,
    );
    expect(next?.epoch).toBe(old.epoch + 1);
    expect(first.admit(stale, old.process, { pid: 101, incarnation: incarnation('stale-child') }, nextAt)).toBe(false);
    expect(first.read().launch).toBeNull();

    if (next === null) throw new Error('replacement owner was not admitted');
    const replacement = second.reserve(next, 'B', 'startup', nextAt);
    if (replacement === null) throw new Error('replacement launch was not reserved');
    const child = { pid: 201, incarnation: incarnation('replacement-child') };
    expect(second.admit(replacement, next.process, child, nextAt)).toBe(true);
    expect(
      second.acquire(
        {
          id: 'third',
          process: { pid: 300, incarnation: incarnation('third-process') },
          buildSetId: 'C',
        },
        nextAt + LAUNCH_OWNER_LEASE_MS + 1,
      ),
    ).not.toBeNull();
    expect(first.read().launch).toMatchObject({ id: replacement.id, phase: 'admitted', child });
    expect(first.reserve(old, 'A', 'recovery', nextAt + LAUNCH_OWNER_LEASE_MS + 1)).toBeNull();
    first.close();
    second.close();
    stalled.kill('SIGKILL');
    await once(stalled, 'exit');
  });
});
