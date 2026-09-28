import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CoordinatorLaunchRecord,
  LAUNCH_OWNER_LEASE_MS,
  readCoordinatorLaunchState,
} from '#src/infra/coordinator-launch.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coordinator launch admission', () => {
  it('holds a replacement signal refusal by process identity', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const incarnation = (value: string) => value as ProcessIncarnation;
    const owner = record.acquire(
      { id: 'supervisor', process: { pid: 101, incarnation: incarnation('supervisor') }, buildSetId: 'A' },
      1_000,
    );
    if (owner === null) throw new Error('owner not admitted');
    const launch = record.reserve(owner, 'A', 'startup', 1_000);
    if (launch === null) throw new Error('launch not reserved');
    const source = { pid: 201, incarnation: incarnation('source') };
    const replacement = { pid: 301, incarnation: incarnation('replacement') };
    expect(record.admit(launch, owner.process, source, 1_001)).toBe(true);
    expect(record.serving(launch, source)).toBe(true);
    expect(record.holdReplacementSignalRefusal(source, replacement)).toBe(true);
    expect(record.read().signalHolds).toEqual([
      { launchId: `replacement:${replacement.pid}:${replacement.incarnation}`, ...replacement },
    ]);
    record.clearReplacementSignalRefusal(replacement);
    expect(record.read().signalHolds).toEqual([]);
    record.close();
  });
  it.each(['admitted launch', 'admitted attempt', 'serving attempt'] as const)(
    'holds a replacement signal refusal from an %s child',
    (sourceState) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-source-hold-'));
      roots.push(runDir);
      const record = new CoordinatorLaunchRecord(runDir);
      const incarnation = (value: string) => value as ProcessIncarnation;
      const owner = record.acquire(
        { id: 'supervisor', process: { pid: 101, incarnation: incarnation('supervisor') }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const original = { pid: 201, incarnation: incarnation('original') };
      expect(record.admit(launch, owner.process, original, 1_001)).toBe(true);
      if (sourceState !== 'admitted launch') expect(record.serving(launch, original)).toBe(true);
      const source = sourceState === 'admitted launch' ? original : { pid: 202, incarnation: incarnation('source') };
      if (sourceState !== 'admitted launch') {
        const attempt = record.reserve(owner, 'B', 'succession', 1_002);
        if (attempt === null) throw new Error('attempt not reserved');
        expect(record.admit(attempt, owner.process, source, 1_003)).toBe(true);
        if (sourceState === 'serving attempt') expect(record.serving(attempt, source)).toBe(true);
      }
      const replacement = { pid: 301, incarnation: incarnation('replacement') };
      expect(record.holdReplacementSignalRefusal({ ...source, incarnation: incarnation('other') }, replacement)).toBe(
        false,
      );
      expect(record.holdReplacementSignalRefusal(source, replacement)).toBe(true);
      expect(record.read().signalHolds).toEqual([
        { launchId: `replacement:${replacement.pid}:${replacement.incarnation}`, ...replacement },
      ]);
      record.close();
    },
  );
  it('makes rejected launch-hold writes observable', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-rejected-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const owner = record.acquire(
      { id: 'supervisor', process: { pid: 101, incarnation: 'supervisor' as ProcessIncarnation }, buildSetId: 'A' },
      1_000,
    );
    if (owner === null) throw new Error('owner not admitted');
    const launch = record.reserve(owner, 'A', 'startup', 1_000);
    if (launch === null) throw new Error('launch not reserved');
    const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
    expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
    const expired = owner.leaseUntil;
    expect(() => record.hold(owner, 'unknown', expired)).toThrow('launch hold');
    expect(() => record.holdUnreadableCustody(owner, '/custody', expired)).toThrow('launch hold');
    expect(() => record.holdTarget(owner, 'request-1', expired)).toThrow('launch hold');
    expect(() => record.holdInheritedChild(owner, { ...launch, child }, expired)).toThrow('launch hold');
    expect(record.read().hold).toBeUndefined();
    record.close();
  });
  it('keeps a refused KILL visible for the exact launch until that child exits', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-signal-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    const owner = record.acquire(
      { id: 'supervisor', process: { pid: process.pid, incarnation: 'parent' as ProcessIncarnation }, buildSetId: 'A' },
      Date.now(),
    );
    if (owner === null) throw new Error('Owner was not admitted');
    const reservation = record.reserve(owner, 'A', 'succession', Date.now());
    if (reservation === null) throw new Error('Attempt was not reserved');
    const child = { pid: 2001, incarnation: 'child' as ProcessIncarnation };
    expect(record.admit(reservation, owner.process, child, Date.now())).toBe(true);
    expect(record.holdSignalRefusal(owner, reservation, child, Date.now())).toBe(true);
    expect(record.read().signalHolds).toEqual([
      { launchId: reservation.id, pid: child.pid, incarnation: child.incarnation },
    ]);
    expect(record.exited(reservation, child)).toBe(true);
    expect(record.read().signalHolds).toEqual([]);
    record.close();
  });
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
    const recoveryId = record.nominateRecovery(child, nominee, 'private-challenge');
    if (recoveryId === null) throw new Error('nomination was refused');
    expect(record.holdReplacementSignalRefusal(child, nominee)).toBe(true);
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
    expect(record.read().signalHolds).toEqual([]);
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
  it('transfers a serving child to its nominee while the disconnected supervisor is still alive', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-live-supervisor-transfer-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process has no incarnation');
      const owner = record.acquire(
        { id: 'supervisor', process: { pid: process.pid, incarnation }, buildSetId: 'A' },
        Date.now(),
      );
      if (owner === null) throw new Error('Supervisor did not acquire');
      const launch = record.reserve(owner, 'A', 'startup', Date.now());
      if (launch === null) throw new Error('Launch was not reserved');
      const child = { pid: 211, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, child, Date.now())).toBe(true);
      expect(record.serving(launch, child)).toBe(true);
      const nominee = { pid: 311, incarnation: 'nominee' as ProcessIncarnation };
      const recoveryId = record.nominateRecovery(child, nominee, 'private-challenge');
      expect(recoveryId).not.toBeNull();
      if (recoveryId === null) return;
      const accepted = record.acceptRecoveryTransfer(
        { id: 'nominee', process: nominee, buildSetId: 'A' },
        recoveryId,
        'private-challenge',
        Date.now(),
      );
      expect(accepted?.mode).toBe('recovering');
      expect(record.renew(owner, Date.now())).toBeNull();
      expect(record.read().launch).toMatchObject({ id: launch.id, phase: 'serving', child });
    } finally {
      record.close();
    }
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
  it('names the evidence change that retries an indeterminate controller hold', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-controller-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process has no incarnation');
      const owner = record.acquire(
        { id: 'supervisor', process: { pid: process.pid, incarnation }, buildSetId: 'A' },
        Date.now(),
      );
      if (owner === null) throw new Error('Supervisor did not acquire');
      record.hold(owner, 'unknown', Date.now());
      expect(readCoordinatorLaunchState(runDir).hold).toEqual({
        kind: 'no-eligible-build',
        controller: 'unknown',
        retry: 'controller-evidence-change',
      });
    } finally {
      record.close();
    }
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
