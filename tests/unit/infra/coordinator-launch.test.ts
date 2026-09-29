import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { createSharedFileLockSync, attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/index.js';

describe('namespace supervisor ownership', () => {
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
