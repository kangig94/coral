import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { listLaunchAdmissions, publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import * as nodeProcess from '#src/infra/node-process.js';

describe('namespace supervisor ownership', () => {
  it('keeps actual recovery through slot promotion until the parented successor serves', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-parenthood-normalization-'));
    const incarnation = 'original' as ProcessIncarnation;
    const parent = { pid: 999_997, incarnation };
    const predecessor = { pid: 999_995, incarnation };
    const probe = vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(incarnation);
    vi.spyOn(nodeProcess, 'observeProcessLiveness').mockReturnValue('alive');
    try {
      publishLaunchAdmission(runDir, {
        version: 1,
        launchId: '00000000-0000-4000-8000-000000000001',
        child: predecessor,
        parent: { pid: 999_998, incarnation },
        admittedAt: Date.now(),
        purpose: 'startup',
        build: { version: '0.10.14', buildSetId: 'build-A', bundleHash: 'hash-A', flavor: 'prod' },
      });
      const state = new SupervisorLaunchMemory(runDir, parent, 'build-A');
      state.observeInheritedHealth(state.read().launch!, Date.now());
      expect(state.reserve(state.read().owner, 'build-A', 'succession')).toBeNull();
      const repair = state.reserveRepairSuccession(state.read().owner, 'build-A', predecessor)!;
      expect(repair).not.toBeNull();
      const child = { pid: 999_994, incarnation };
      expect(state.spawned(repair, parent, child)).toBe(true);
      expect(state.admit(repair, parent, child, Date.now())).toBe(true);
      probe.mockImplementation((pid) => (pid === predecessor.pid ? ('different' as ProcessIncarnation) : incarnation));
      state.reconcileAdmissions();
      expect(state.read().launch?.id).toBe(repair.id);
      expect(state.read().owner.mode).toBe('recovering');
      expect(state.serving(repair, child)).toBe(true);
      expect(state.read().owner.mode).toBe('supervised');
    } finally {
      vi.restoreAllMocks();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
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
  it('keeps an inherited child and refuses authority while its incarnation is unknown', () => {
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
      expect(state.reserve(state.read().owner, 'build-A', 'succession')).toBeNull();
      expect(state.reserveRepairSuccession(state.read().owner, 'build-A', child)).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
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
});
