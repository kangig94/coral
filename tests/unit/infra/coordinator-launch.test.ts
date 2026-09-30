import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { createSharedFileLockSync, attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { listLaunchAdmissions, publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/index.js';
import * as backendDiscovery from '#src/infra/backend-discovery.js';
import * as nodeProcess from '#src/infra/node-process.js';
import * as upgradeIntent from '#src/infra/upgrade-intent.js';

describe('namespace supervisor ownership', () => {
  it('ignores corrupt branch-only v1 records beside a live unrelated process', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-v1-ignored-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    const path = join(runDir, 'launch-admissions.v1', '00000000-0000-4000-8000-000000000001.json');
    try {
      mkdirSync(join(runDir, 'launch-admissions.v1'));
      writeFileSync(path, '{');
      const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-A');
      expect(memory.reserve(memory.read().owner, 'build-A', 'startup')).not.toBeNull();
      expect(listLaunchAdmissions(runDir)).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe('{');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps incomplete v2 envelopes in recovery instead of normalizing empty occupancy', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-v2-unknown-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      mkdirSync(join(runDir, 'launch-admissions.v2'));
      writeFileSync(join(runDir, 'launch-admissions.v2', '00000000-0000-4000-8000-000000000001.json'), '{');
      const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-A');
      expect(memory.read().owner.mode).toBe('recovering');
      expect(memory.release()).toBe(false);
      expect(memory.reserve(memory.read().owner, 'build-A', 'startup')).toBeNull();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it.each(['timing', 'build', 'parent'] as const)(
    'retains conflicting discovery %s without creating a new admission envelope',
    (evidence) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-conflicting-envelope-'));
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process incarnation is unavailable');
      const child = { pid: process.pid, incarnation };
      const parent = { pid: 999_998, incarnation };
      const admittedAt = Date.now() - 1_000;
      const launchId = '00000000-0000-4000-8000-000000000001';
      try {
        const admission = {
          version: 1 as const,
          launchId,
          child,
          parent,
          admittedAt,
          build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' as const },
          purpose: 'startup' as const,
        };
        publishLaunchAdmission(runDir, admission);
        expect(() => publishLaunchAdmission(runDir, { ...admission, admittedAt: admittedAt + 1 })).toThrow();
        vi.spyOn(backendDiscovery, 'readDiscoveryRecordDisposition').mockReturnValue({
          kind: 'record',
          record: {
            pid: child.pid,
            incarnation,
            port: 12345,
            socketPath: '/tmp/conflict.sock',
            bundleHash: evidence === 'build' ? 'hash-conflict' : 'hash-A',
            flavor: 'prod',
            namespace: 'test',
            startedAt: Date.now(),
            token: 'token',
            bootToken: 'boot',
            supervision: {
              version: 1,
              launchId,
              admittedAt: evidence === 'timing' ? admittedAt + 1 : admittedAt,
              buildSetId: 'build-A',
              purpose: 'startup',
              parent: evidence === 'parent' ? { ...parent, pid: 999_996 } : parent,
            },
          },
        });
        const memory = new SupervisorLaunchMemory(runDir, { pid: 999_997, incarnation }, 'build-B');
        memory.reconcileAdmissions();
        const launch = memory.read().launch;
        if (launch === null) throw new Error('Conflicting subject was discarded');
        expect(launch.admittedAt).toBe(admittedAt);
        expect(memory.release()).toBe(false);
        expect(memory.commitTermination(memory.read().owner, launch, child, Date.now(), 30_000)).toBe(false);
        memory.observeInheritedHealth(launch, Date.now());
        expect(memory.reserve(memory.read().owner, 'build-B', 'succession')).toBeNull();
      } finally {
        vi.restoreAllMocks();
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it('keeps heartbeat and retirement observations in the launch memory across authority epochs', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-heartbeat-memory-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      const child = { pid: process.pid, incarnation };
      const memory = new SupervisorLaunchMemory(runDir, child, 'build-A');
      const reservation = memory.reserve(memory.read().owner, 'build-A', 'startup');
      if (reservation === null) throw new Error('Missing child reservation');
      expect(memory.spawned(reservation, child, child)).toBe(true);
      const watch = memory.childWatch(reservation, 1_000);
      watch.lastAnswer = 123;
      watch.outstanding = 7;
      const retirement = memory.childRetirement(reservation);
      retirement.at = 456;
      memory.inheritedWatch.set(reservation.id, {
        firstSeen: 100,
        lastHealthy: 123,
        uninterruptibleSince: null,
        terminationAt: null,
      });
      memory.suspendAuthority();
      memory.resumeAuthority();
      expect(memory.childWatch(reservation, 1_000)).toBe(watch);
      expect(watch).toMatchObject({ lastAnswer: 123, outstanding: 7 });
      expect(memory.childRetirement(reservation)).toBe(retirement);
      expect(retirement.at).toBe(456);
      expect(memory.inheritedWatch.get(reservation.id)?.lastHealthy).toBe(123);
      expect(memory.exited(reservation, child)).toBe(true);
      expect(memory.inheritedWatch.has(reservation.id)).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('suspends pending requests before release and fences callbacks after reacquisition', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-authority-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-A');
      const previous = memory.read().owner;
      memory.suspendAuthority();
      expect(memory.reserve(previous, 'build-B', 'startup')).toBeNull();
      memory.resumeAuthority();
      expect(memory.reserve(previous, 'build-B', 'startup')).toBeNull();
      expect(memory.reserve(memory.read().owner, 'build-B', 'startup')).not.toBeNull();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it.each(['replacement', 'reacquisition'] as const)(
    'fences a pending launch callback across %s lock acquisition',
    async (takeover) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-pending-launch-'));
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process incarnation is unavailable');
      try {
        const path = supervisorLockPath(runDir);
        createSharedFileLockSync(path)();
        const first = attemptExclusiveFileLockSync(path);
        if (first.kind !== 'acquired') throw new Error('Missing namespace lease');
        const memory = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-A');
        const authority = memory.read().owner;
        const release = memory.authorityLease(first.lease);
        let observe: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
          observe = resolve;
        }).then(() => memory.reserve(authority, 'build-B', 'startup'));
        release();
        const acquired = attemptExclusiveFileLockSync(path);
        if (acquired.kind !== 'acquired') throw new Error('Replacement did not acquire');
        try {
          const current =
            takeover === 'replacement'
              ? new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-B')
              : memory;
          if (takeover === 'reacquisition') memory.resumeAuthority();
          observe?.();
          expect(await pending).toBeNull();
          release();
          expect(current.reserve(current.read().owner, 'build-B', 'startup')).not.toBeNull();
          expect(memory.hasAuthority(authority)).toBe(false);
        } finally {
          acquired.lease();
        }
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it('recovers a discovered predecessor after later intents replace its upgrade intent', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-discovered-predecessor-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      publishLaunchAdmission(runDir, {
        version: 1,
        launchId: '00000000-0000-4000-8000-000000000001',
        child: { pid: process.pid, incarnation },
        parent: { pid: 999_998, incarnation },
        admittedAt: Date.now() - 10_000,
        discoveredAt: Date.now() - 5_000,
        build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' },
        purpose: 'startup',
      });
      const state = new SupervisorLaunchMemory(runDir, { pid: 999_997, incarnation }, 'build-B');
      expect(state.read().launch).toMatchObject({ phase: 'serving', child: { pid: process.pid, incarnation } });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  it('recovers the intent incumbent after discovery was overwritten and its admission is unavailable', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-intent-incumbent-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      vi.spyOn(upgradeIntent, 'readUpgradeIntent').mockReturnValue({
        kind: 'readable',
        intent: {
          version: 'v1',
          requestId: 'overlap',
          revision: 0,
          incumbent: {
            instanceId: 'A',
            pid: process.pid,
            incarnation,
            version: '0.10.14',
            bundleHash: 'hash-A',
            flavor: 'prod',
          },
          target: {
            build: {
              version: '0.10.15',
              buildSetId: 'build-B',
              bundleHash: 'hash-B',
              flavor: 'prod',
              storeFormatFingerprint: 'format',
              cliBundleHash: 'cli',
              claudeAppserverBundleHash: 'claude',
              durableWrapperBundleHash: 'wrapper',
            },
            pluginRootLabel: '/missing',
          },
          attemptId: null,
          attemptOwner: null,
          disposition: 'pending',
          blockers: [],
          retryCondition: null,
          attemptDeadline: null,
          completionReceipt: null,
        },
      });
      const state = new SupervisorLaunchMemory(runDir, { pid: 999_997, incarnation }, 'build-B');
      expect(state.read().owner.mode).toBe('recovering');
      expect(state.read().launch).toMatchObject({ phase: 'serving', child: { pid: process.pid, incarnation } });
      expect(state.reserve(state.read().owner, 'build-B', 'startup')).toBeNull();
    } finally {
      vi.restoreAllMocks();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  it.each(['admission', 'discovery'] as const)(
    'keeps an inherited %s child and refuses authority while its incarnation is unknown',
    (source) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-unknown-child-'));
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process incarnation is unavailable');
      try {
        const child = { pid: process.pid, incarnation };
        const admittedAt = Date.now();
        publishLaunchAdmission(runDir, {
          version: 1,
          launchId: '00000000-0000-4000-8000-000000000001',
          child,
          parent: { pid: 999_998, incarnation },
          admittedAt,
          build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' },
          purpose: 'startup',
        });
        if (source === 'discovery')
          writeFileSync(
            join(runDir, 'coordinator.json'),
            JSON.stringify({
              pid: child.pid,
              incarnation,
              port: 12345,
              socketPath: '/tmp/unknown.sock',
              bundleHash: 'hash-A',
              flavor: 'prod',
              namespace: 'test',
              startedAt: Date.now(),
              token: 'token',
              bootToken: 'boot',
              supervision: {
                version: 1,
                launchId: '00000000-0000-4000-8000-000000000001',
                admittedAt,
                buildSetId: 'build-A',
                purpose: 'startup',
                parent: { pid: 999_998, incarnation },
              },
            }),
          );
        const probe = vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null);
        const state = new SupervisorLaunchMemory(runDir, { pid: 999_997, incarnation }, 'build-A');
        expect(state.read().owner.mode).toBe('recovering');
        expect(state.read().launch?.child).toEqual(child);
        const launch = state.read().launch;
        if (launch === null) throw new Error('Inherited child was discarded');
        expect(state.settleAbsentChild(launch)).toBe(false);
        expect(state.commitTermination(state.read().owner, launch, child, Date.now(), 30_000)).toBe(false);
        expect(state.read().launch?.terminationAt).toBeUndefined();
        expect(state.reserve(state.read().owner, 'build-A', 'startup')).toBeNull();
        state.observeInheritedHealth(launch, Date.now());
        expect(state.read().launch?.observedHealthyAt).toBeUndefined();
        expect(state.reserve(state.read().owner, 'build-A', 'succession')).toBeNull();
        probe.mockReturnValue(incarnation);
        state.observeInheritedHealth(launch, Date.now());
        expect(state.reserve(state.read().owner, 'build-A', 'succession')).not.toBeNull();
      } finally {
        vi.restoreAllMocks();
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it('serializes two launch authorities until the lock holder releases its kernel lock', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-supervisor-lock-'));
    try {
      const path = supervisorLockPath(runDir);
      createSharedFileLockSync(path)();
      const first = attemptExclusiveFileLockSync(path);
      expect(first.kind).toBe('acquired');
      if (first.kind !== 'acquired') return;
      expect(attemptExclusiveFileLockSync(path).kind).toBe('contended');
      first.lease();
      const second = attemptExclusiveFileLockSync(path);
      expect(second.kind).toBe('acquired');
      if (second.kind === 'acquired') second.lease();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('admits only the exact child from its own private parent and commits termination in memory', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-supervisor-memory-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      const parent = { pid: process.pid, incarnation };
      const state = new SupervisorLaunchMemory(runDir, parent, 'build-A');
      const owner = state.read().owner;
      const launch = state.reserve(owner, 'build-A', 'startup');
      if (launch === null) throw new Error('Launch was not reserved');
      expect(state.reserve(owner, 'build-B', 'startup')).toBeNull();
      const child = { pid: 999_997, incarnation: 'child' as ProcessIncarnation };
      expect(state.spawned(launch, parent, child)).toBe(true);
      expect(state.admit(launch, { pid: 999_998, incarnation }, child, Date.now())).toBe(false);
      expect(state.admit(launch, parent, child, Date.now())).toBe(true);
      expect(state.serving(launch, child)).toBe(true);
      expect(state.commitTermination(owner, launch, { ...child, pid: 999_996 }, Date.now(), 30_000)).toBe(false);
      expect(state.read().launch?.terminationAt).toBeUndefined();
      expect(state.commitTermination(owner, launch, child, Date.now(), 30_000)).toBe(true);
      expect(state.read().launch).toMatchObject({ child, phase: 'serving', terminationAt: expect.any(Number) });
      expect(state.exited(launch, child)).toBe(true);
      expect(state.release()).toBe(true);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('recovers an admitted pre-discovery child from its self-record without a supervisor database', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-admitted-recovery-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process incarnation is unavailable');
    try {
      const launchId = '00000000-0000-4000-8000-000000000001';
      publishLaunchAdmission(runDir, {
        version: 1,
        launchId,
        child: { pid: process.pid, incarnation },
        parent: { pid: 999_998, incarnation: 'lost-parent' as ProcessIncarnation },
        admittedAt: Date.now(),
        build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'build-A-hash', flavor: 'prod' },
        purpose: 'startup',
      });
      const replacement = new SupervisorLaunchMemory(
        runDir,
        { pid: 999_997, incarnation: 'replacement' as ProcessIncarnation },
        'build-A',
      );
      expect(replacement.read().owner.mode).toBe('recovering');
      expect(replacement.read().launch).toMatchObject({
        id: launchId,
        phase: 'admitted',
        child: { pid: process.pid, incarnation },
        parent: { pid: 999_998 },
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
