import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { createSharedFileLockSync, attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/index.js';
import * as nodeProcess from '#src/infra/node-process.js';
import * as upgradeIntent from '#src/infra/upgrade-intent.js';

describe('namespace supervisor ownership', () => {
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
        publishLaunchAdmission(runDir, {
          version: 1,
          launchId: '00000000-0000-4000-8000-000000000001',
          child,
          parent: { pid: 999_998, incarnation },
          admittedAt: Date.now(),
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
                admittedAt: Date.now(),
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
