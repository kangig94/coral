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
  it('keeps a request pending when its serving child exits cleanly before completion', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-clean-exit-request-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'B', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
      expect(record.serving(launch, child)).toBe(true);
      const request = record.request('/bundle/B', 'B');

      expect(record.exited(launch, child)).toBe(true);
      expect(record.accept(owner, request.id, 1_002)).toBe(false);
      expect(record.complete(owner, request.id, 1_002)).toBe(false);
      expect(record.read().requests.find((entry) => entry.id === request.id)?.status).toBe('recorded');
      expect(record.release(owner)).toBe(false);
      expect(record.reserve(owner, 'B', 'recovery', 1_003)).not.toBeNull();
    } finally {
      record.close();
    }
  });
  it('writes a legacy serving receipt only while the matching child serves', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-serving-receipt-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'B', 'legacy-retirement', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      const request = record.request('/bundle/B', 'B', {
        instanceId: 'incumbent',
        pid: 301,
        incarnation: 'incumbent' as ProcessIncarnation,
        version: '0.10.13',
        bundleHash: 'incumbent',
        flavor: 'prod',
      });
      const receipt = {
        launchId: launch.id,
        successor: { instanceId: 'successor', ...child },
        epochKey: 'epoch-1',
        controlGeneration: 1,
        recordedAt: '2026-09-29T00:00:00.000Z',
      };
      expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
      expect(record.recordLegacyReceipt(child, request.id, receipt)).toBe(false);
      expect(record.serving(launch, child)).toBe(true);
      expect(record.recordLegacyReceipt(child, request.id, receipt)).toBe(true);
      expect(record.accept(owner, request.id, 1_002)).toBe(true);
      expect(record.complete(owner, request.id, 1_002)).toBe(true);
      expect(record.accept(owner, request.id, 1_003)).toBe(false);
      expect(record.complete(owner, request.id, 1_003)).toBe(false);
      const late = record.request('/bundle/B', 'B', request.incumbent);
      expect(record.exited(launch, child)).toBe(true);
      expect(record.recordLegacyReceipt(child, late.id, receipt)).toBe(false);
    } finally {
      record.close();
    }
  });
  it('rejects an in-flight serving probe after termination commits and keeps the request pending', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-terminating-probe-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'B', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
      const request = record.request('/bundle/B', 'B');
      expect(record.accept(owner, request.id, 1_001)).toBe(false);
      let resolveProbe: (ready: boolean) => void = () => {};
      const probe = new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      });
      const promotion = probe.then((ready) => ready && record.serving(launch, child));

      expect(record.commitTermination(owner, launch, child, 1_002, 100)).toBe(true);
      resolveProbe(true);
      expect(await promotion).toBe(false);
      expect(record.accept(owner, request.id, 1_003)).toBe(false);
      expect(record.complete(owner, request.id, 1_003)).toBe(false);
      expect(record.read().requests.find((entry) => entry.id === request.id)?.status).toBe('recorded');
      expect(record.exited(launch, child)).toBe(true);
      expect(record.complete(owner, request.id, 1_004)).toBe(false);
    } finally {
      record.close();
    }
  });
  it('holds a refused signal for a termination-committed reserved child until exit', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-reserved-signal-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.holdSignalRefusal(owner, launch, child, 1_001)).toBe(false);
      expect(record.commitTermination(owner, launch, child, 1_002, 100)).toBe(true);
      expect(record.holdSignalRefusal(owner, launch, child, 1_003)).toBe(true);
      expect(record.read().signalHolds).toEqual([{ launchId: launch.id, ...child }]);
      const successor = record.acquire(
        { id: 'second', process: { pid: 301, incarnation: 'second' as ProcessIncarnation }, buildSetId: 'A' },
        owner.leaseUntil + 1,
      );
      expect(successor).not.toBeNull();
      expect(record.read().launch).toMatchObject({ id: launch.id, phase: 'reserved', terminationAt: 1_002 });
      expect(record.exited(launch, child)).toBe(true);
      expect(record.read().signalHolds).toEqual([]);
    } finally {
      record.close();
    }
  });
  it('reconciles orphaned replacement holds only on decisive absence', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-orphan-replacement-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const source = { pid: 201, incarnation: 'source' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, source, 1_001)).toBe(true);
      const live = { pid: process.pid, incarnation: probeProcessIncarnation(process.pid)! };
      const gone = { pid: 999_999, incarnation: 'gone' as ProcessIncarnation };
      expect(record.holdReplacementSignalRefusal(source, live)).toBe(true);
      expect(record.holdReplacementSignalRefusal(source, gone)).toBe(true);

      record.reconcileReplacementSignalHolds();

      expect(record.read().signalHolds).toEqual([{ launchId: `replacement:${live.pid}:${live.incarnation}`, ...live }]);
    } finally {
      record.close();
    }
  });
  it('orders recovery transfer and termination for the exact serving child', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-termination-transfer-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const first = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (first === null) throw new Error('first owner not admitted');
      const launch = record.reserve(first, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, first.process, child, 1_001)).toBe(true);
      expect(record.serving(launch, child)).toBe(true);
      const nominee = { pid: 301, incarnation: 'nominee' as ProcessIncarnation };
      const recovery = record.nominateRecovery(child, nominee, 'challenge');
      if (recovery === null) throw new Error('recovery not nominated');
      expect(record.commitTermination(first, launch, child, 1_002, 100)).toBe(true);
      expect(record.read().launch?.terminationOwnerEpoch).toBe(first.epoch);
      expect(record.nominateRecovery(child, nominee, 'after-termination')).toBeNull();
      expect(record.reserve(first, 'B', 'succession', 1_003)).toBeNull();
      expect(
        record.acceptRecoveryTransfer(
          { id: 'nominee', process: nominee, buildSetId: 'A' },
          recovery,
          'challenge',
          1_003,
        ),
      ).toBeNull();
      expect(record.read().owner?.epoch).toBe(first.epoch);
    } finally {
      record.close();
    }
  });
  it('does not transfer an expired owner while it can still signal a committed child', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-expired-termination-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const parent = { pid: process.pid, incarnation: probeProcessIncarnation(process.pid)! };
      const owner = record.acquire({ id: 'first', process: parent, buildSetId: 'A' }, 1_000);
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, parent, child, 1_001)).toBe(true);
      expect(record.commitTermination(owner, launch, child, 1_002, 100)).toBe(true);
      expect(
        record.acquire(
          {
            id: 'replacement',
            process: { pid: 301, incarnation: 'replacement' as ProcessIncarnation },
            buildSetId: 'A',
          },
          owner.leaseUntil + 1,
        ),
      ).toBeNull();
      expect(record.read().owner?.epoch).toBe(owner.epoch);
      const reacquired = record.acquire({ id: 'first', process: parent, buildSetId: 'A' }, owner.leaseUntil + 1);
      expect(reacquired).not.toBeNull();
      if (reacquired === null) throw new Error('original parent did not reacquire');
      expect(
        record.acquire(
          {
            id: 'replacement',
            process: { pid: 301, incarnation: 'replacement' as ProcessIncarnation },
            buildSetId: 'A',
          },
          reacquired.leaseUntil + 1,
        ),
      ).toBeNull();
      expect(record.commitTermination(reacquired, launch, child, owner.leaseUntil + 2, 100)).toBe(true);
      expect(record.read().launch?.terminationOwnerEpoch).toBe(reacquired.epoch);
    } finally {
      record.close();
    }
  });

  it('commits termination of a reserved spawned child without admitting it', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-reserved-termination-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.commitTermination(owner, launch, child, 1_001, 100)).toBe(true);
      expect(record.read().launch).toMatchObject({
        id: launch.id,
        phase: 'reserved',
        child,
        terminationAt: 1_001,
        terminationOwnerEpoch: owner.epoch,
      });
      expect(record.admit(launch, owner.process, child, 1_002)).toBe(false);
      expect(record.cancelReservation(owner, launch, 1_002)).toBe(false);
      expect(record.exited(launch, child)).toBe(true);
    } finally {
      record.close();
    }
  });

  it('does not permit the former owner to commit termination after transfer', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-transfer-termination-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const first = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (first === null) throw new Error('first owner not admitted');
      const launch = record.reserve(first, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, first.process, child, 1_001)).toBe(true);
      expect(record.serving(launch, child)).toBe(true);
      const nominee = { pid: 301, incarnation: 'nominee' as ProcessIncarnation };
      const recovery = record.nominateRecovery(child, nominee, 'challenge');
      if (recovery === null) throw new Error('recovery not nominated');
      expect(
        record.acceptRecoveryTransfer(
          { id: 'nominee', process: nominee, buildSetId: 'A' },
          recovery,
          'challenge',
          1_002,
        ),
      ).not.toBeNull();
      expect(record.commitTermination(first, launch, child, 1_003, 100)).toBe(false);
      expect(record.read().launch?.terminationAt).toBeUndefined();
    } finally {
      record.close();
    }
  });
  it('keeps a transferred child alive when transfer commits between owner check and signal', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-transfer-signal-race-'));
    roots.push(runDir);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const first = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (first === null || child.pid === undefined) throw new Error('fixture not admitted');
      const launch = record.reserve(first, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const identity = { pid: child.pid, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, first.process, identity, 1_001)).toBe(true);
      expect(record.serving(launch, identity)).toBe(true);
      const nominee = { pid: 301, incarnation: 'nominee' as ProcessIncarnation };
      const recovery = record.nominateRecovery(identity, nominee, 'challenge');
      if (recovery === null) throw new Error('recovery not nominated');
      const checkedEpoch = record.read().owner?.epoch;
      expect(
        record.acceptRecoveryTransfer(
          { id: 'nominee', process: nominee, buildSetId: 'A' },
          recovery,
          'challenge',
          1_002,
        ),
      ).not.toBeNull();
      if (checkedEpoch === first.epoch && record.commitTermination(first, launch, identity, 1_003, 100))
        child.kill('SIGTERM');
      expect(observeProcessLiveness(child.pid)).toBe('alive');
      expect(record.read().launch?.terminationAt).toBeUndefined();
    } finally {
      record.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  it('cancels a pending replacement before signaling and refuses cancellation after transfer', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-cancellation-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'first', process: { pid: 101, incarnation: 'first' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('owner not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('launch not reserved');
      const source = { pid: 201, incarnation: 'source' as ProcessIncarnation };
      const nominee = { pid: 301, incarnation: 'nominee' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, source, 1_001)).toBe(true);
      expect(record.serving(launch, source)).toBe(true);
      const recovery = record.nominateRecovery(source, nominee, 'challenge');
      if (recovery === null) throw new Error('recovery not nominated');
      expect(record.cancelRecoveryForTermination(source, nominee)).toBe(true);
      expect(
        record.acceptRecoveryTransfer(
          { id: 'nominee', process: nominee, buildSetId: 'A' },
          recovery,
          'challenge',
          1_002,
        ),
      ).toBeNull();
      const second = record.nominateRecovery(source, nominee, 'challenge-2');
      if (second === null) throw new Error('second recovery not nominated');
      expect(
        record.acceptRecoveryTransfer(
          { id: 'nominee', process: nominee, buildSetId: 'A' },
          second,
          'challenge-2',
          1_003,
        ),
      ).not.toBeNull();
      expect(record.cancelRecoveryForTermination(source, nominee)).toBe(false);
    } finally {
      record.close();
    }
  });
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
    expect(record.hold(owner, 'unknown', expired)).toBe(false);
    expect(record.holdUnreadableCustody(owner, '/custody', expired)).toBe(false);
    expect(record.holdTarget(owner, 'request-1', expired)).toBe(false);
    expect(record.holdInheritedChild(owner, { ...launch, child }, expired)).toBe(false);
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
    expect(record.accept(first, request.id, 1_002)).toBe(false);
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
    expect(record.read().requests.find((entry) => entry.id === request.id)?.status).toBe('recorded');
    expect(record.renew(provisional, takeoverAt + 2)).toBeNull();
    expect(record.commitTermination(accepted, launch, child, takeoverAt + 2, 30_000)).toBe(true);
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
  it('transfers recovery from a serving attempt while the first child remains live', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-attempt-transfer-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'owner', process: { pid: 101, incarnation: 'owner' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('Owner was not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('Launch was not reserved');
      const first = { pid: 201, incarnation: 'first' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, first, 1_001)).toBe(true);
      expect(record.serving(launch, first)).toBe(true);
      const attempt = record.reserve(owner, 'B', 'succession', 1_002);
      if (attempt === null) throw new Error('Attempt was not reserved');
      const second = { pid: 202, incarnation: 'second' as ProcessIncarnation };
      expect(record.admit(attempt, owner.process, second, 1_003)).toBe(true);
      expect(record.serving(attempt, second)).toBe(true);
      const nominee = { pid: 301, incarnation: 'nominee' as ProcessIncarnation };
      const recoveryId = record.nominateRecovery(second, nominee, 'challenge');
      expect(recoveryId).not.toBeNull();
      if (recoveryId === null) return;
      const accepted = record.acceptRecoveryTransfer(
        { id: 'nominee', process: nominee, buildSetId: 'B' },
        recoveryId,
        'challenge',
        1_004,
      );
      expect(accepted?.mode).toBe('recovering');
      expect(record.read().launch).toMatchObject({ id: launch.id, phase: 'serving', child: first });
      expect(record.read().attempt).toMatchObject({ id: attempt.id, phase: 'serving', child: second });
      expect(record.renew(owner, 1_005)).toBeNull();
    } finally {
      record.close();
    }
  });
  it('tracks both inherited children and clears each hold atomically on exit or absence', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-inherited-holds-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'owner', process: { pid: 101, incarnation: 'owner' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('Owner was not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('Launch was not reserved');
      const first = { pid: 201, incarnation: 'first' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, first, 1_001)).toBe(true);
      expect(record.serving(launch, first)).toBe(true);
      const attempt = record.reserve(owner, 'B', 'succession', 1_002);
      if (attempt === null) throw new Error('Attempt was not reserved');
      const second = { pid: 202, incarnation: 'second' as ProcessIncarnation };
      expect(record.admit(attempt, owner.process, second, 1_003)).toBe(true);
      expect(record.holdInheritedChild(owner, { ...launch, child: first }, 1_004)).toBe(true);
      expect(record.holdInheritedChild(owner, { ...attempt, child: second }, 1_004)).toBe(true);
      expect(record.read().inheritedHolds).toEqual([
        { launchId: launch.id, pid: first.pid },
        { launchId: attempt.id, pid: second.pid },
      ]);
      expect(record.exited(launch, first)).toBe(true);
      expect(record.read().inheritedHolds).toEqual([{ launchId: attempt.id, pid: second.pid }]);
      expect(record.holdInheritedChild(owner, { ...launch, child: first }, 1_005)).toBe(false);
      expect(record.settleAbsentChild(owner, { ...attempt, child: second }, 1_005)).toBe(true);
      expect(record.read().inheritedHolds).toEqual([]);
      expect(record.holdInheritedChild(owner, { ...attempt, child: second }, 1_006)).toBe(false);
    } finally {
      record.close();
    }
  });
  it('refuses a signal hold after the child has exited', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-exited-signal-hold-'));
    roots.push(runDir);
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        { id: 'owner', process: { pid: 101, incarnation: 'owner' as ProcessIncarnation }, buildSetId: 'A' },
        1_000,
      );
      if (owner === null) throw new Error('Owner was not admitted');
      const launch = record.reserve(owner, 'A', 'startup', 1_000);
      if (launch === null) throw new Error('Launch was not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
      expect(record.exited(launch, child)).toBe(true);
      expect(record.holdSignalRefusal(owner, launch, child, 1_002)).toBe(false);
      expect(record.read().signalHolds ?? []).toEqual([]);
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
    expect(record.read().requests[0]).toMatchObject({ status: 'recorded' });
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
