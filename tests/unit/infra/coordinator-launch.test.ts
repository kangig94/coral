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
  it('normalizes a surviving attempt and re-accepts requests in the acquiring epoch', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-normalize-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const incarnation = (value: string) => value as ProcessIncarnation;
    const original = record.acquire(
      { id: 'original', process: { pid: 101, incarnation: incarnation('original') }, buildSetId: 'A' },
      1_000,
    );
    if (original === null) throw new Error('original owner was not admitted');
    const launch = record.reserve(original, 'A', 'startup', 1_000);
    if (launch === null) throw new Error('original launch was not reserved');
    const firstChild = { pid: 201, incarnation: incarnation('first-child') };
    expect(record.admit(launch, original.process, firstChild, 1_001)).toBe(true);
    expect(record.serving(launch, firstChild)).toBe(true);
    const attempt = record.reserve(original, 'B', 'succession', 1_002);
    if (attempt === null) throw new Error('succession attempt was not reserved');
    const secondChild = { pid: 202, incarnation: incarnation('second-child') };
    expect(record.admit(attempt, original.process, secondChild, 1_003)).toBe(true);
    expect(record.serving(attempt, secondChild)).toBe(true);
    const request = record.request('/bundle/B', 'B');
    expect(record.accept(original, request.id, 1_004)).toBe(true);
    expect(record.exited(launch, firstChild)).toBe(true);

    const takeoverAt = original.leaseUntil + 1;
    const replacement = record.acquire(
      { id: 'replacement', process: { pid: 102, incarnation: incarnation('replacement') }, buildSetId: 'B' },
      takeoverAt,
    );
    if (replacement === null) throw new Error('replacement owner was not admitted');
    const state = record.read();
    expect(replacement.mode).toBe('recovering');
    expect(state.launch).toMatchObject({ id: attempt.id, phase: 'serving', parent: original.process });
    expect(state.attempt).toBeNull();
    expect(state.requests.find((entry) => entry.id === request.id)).toMatchObject({
      status: 'accepted',
      acceptedEpoch: replacement.epoch,
    });
    expect(record.reserve(original, 'C', 'succession', takeoverAt)).toBeNull();
    expect(record.reserve(replacement, 'C', 'startup', takeoverAt)).toBeNull();
    expect(record.reserve(replacement, 'C', 'succession', takeoverAt)?.purpose).toBe('succession');
    record.close();
  });

  it('transfers recovery directly to a nominated child without resetting obligations', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-transfer-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const incarnation = (value: string) => value as ProcessIncarnation;
    const first = record.acquire(
      { id: 'first', process: { pid: 111, incarnation: incarnation('first') }, buildSetId: 'A' },
      1_000,
    );
    if (first === null) throw new Error('first owner was not admitted');
    const launch = record.reserve(first, 'A', 'startup', 1_000);
    if (launch === null) throw new Error('launch was not reserved');
    const child = { pid: 211, incarnation: incarnation('child') };
    expect(record.admit(launch, first.process, child, 1_001)).toBe(true);
    expect(record.serving(launch, child)).toBe(true);
    const request = record.request('/bundle/B', 'B');
    expect(record.accept(first, request.id, 1_002)).toBe(true);
    const takeoverAt = first.leaseUntil + 1;
    const provisional = record.acquire(
      { id: 'provisional', process: { pid: 112, incarnation: incarnation('provisional') }, buildSetId: 'B' },
      takeoverAt,
    );
    if (provisional === null) throw new Error('provisional owner was not admitted');
    expect(provisional.mode).toBe('recovering');
    const nominee = { pid: 113, incarnation: incarnation('nominee') };
    const recoveryId = record.nominateRecovery(child, nominee, 'private-challenge', takeoverAt + 1);
    if (recoveryId === null) throw new Error('nomination was refused');
    expect(
      record.acceptRecoveryTransfer(
        { id: 'wrong', process: { pid: 114, incarnation: incarnation('wrong') }, buildSetId: 'A' },
        recoveryId,
        'private-challenge',
        takeoverAt + 1,
      ),
    ).toBeNull();
    const accepted = record.acceptRecoveryTransfer(
      { id: 'nominee', process: nominee, buildSetId: 'A' },
      recoveryId,
      'private-challenge',
      takeoverAt + 1,
    );
    if (accepted === null) throw new Error('nominated owner did not accept');
    expect(accepted.mode).toBe('recovering');
    expect(record.read().launch).toMatchObject({ id: launch.id, admittedAt: 1_001, parent: first.process });
    expect(record.read().requests.find((entry) => entry.id === request.id)?.acceptedEpoch).toBe(accepted.epoch);
    expect(record.renew(provisional, takeoverAt + 2)).toBeNull();
    expect(record.commitTermination(accepted, launch, takeoverAt + 2, 30_000)).toBe(true);
    expect(record.read().launch).toMatchObject({
      terminationAt: takeoverAt + 2,
      killAt: takeoverAt + 30_002,
    });
    record.close();
  });
  it('fences an unavailable receipt to the current owner epoch', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-unavailable-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const incarnation = (value: string) => value as ProcessIncarnation;
    const first = record.acquire(
      { id: 'first', process: { pid: 1, incarnation: incarnation('first') }, buildSetId: 'A' },
      1_000,
    );
    if (first === null) throw new Error('first owner was not admitted');
    const request = record.request('/missing/backend', 'B');
    const second = record.acquire(
      { id: 'second', process: { pid: 2, incarnation: incarnation('second') }, buildSetId: 'A' },
      1_000 + LAUNCH_OWNER_LEASE_MS + 1,
    );
    if (second === null) throw new Error('replacement owner was not admitted');
    expect(record.unavailable(first, request.id, second.leaseUntil - 1)).toBe(false);
    expect(record.read().requests[0]).toMatchObject({ status: 'accepted', acceptedEpoch: second.epoch });
    record.holdTarget(second, request.id, second.leaseUntil - 1);
    expect(record.read().hold).toEqual({ kind: 'target-indeterminate', requestId: request.id });
    record.clearHold(second, second.leaseUntil - 1);
    expect(record.read().hold).toEqual({ kind: 'target-indeterminate', requestId: request.id });
    expect(record.unavailable(second, request.id, second.leaseUntil - 1)).toBe(true);
    expect(record.read().requests[0]?.status).toBe('unavailable');
    record.clearTargetHold(second, second.leaseUntil - 1);
    expect(record.read().hold).toBeUndefined();
    record.close();
  });

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
