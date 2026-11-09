import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { runNamespaceSupervisor } from '#src/coordinator-launch/supervisor.js';
import type { PendingAttempt } from '#src/coordinator-launch/active-child-router.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  select: vi.fn(),
  spawn: vi.fn(),
  watch: vi.fn(),
  pending: null as { value: PendingAttempt | null } | null,
}));
const manifest = {
  version: '0.10.27',
  buildSetId: 'build-A',
  flavor: 'prod',
  bundleHash: 'hash-A',
};

vi.mock('#src/infra/failure-domain.js', () => ({
  acquireFailureDomainRoot: async () => ({ kind: 'unavailable', reason: 'test' }),
}));
vi.mock('#src/coordinator-launch/ownership.js', () => ({ acquireLaunchOwnership: mocks.acquire }));
vi.mock('#src/coordinator-launch/candidate-selection.js', () => ({ selectNextCandidate: mocks.select }));
vi.mock('#src/coordinator-launch/executable.js', () => ({
  validatedExecutable: () => manifest,
  admitSupervisorExecutable: (executable: string) => ({ kind: 'admitted', executable, manifest }),
}));
vi.mock('#src/coordinator-launch/inherited-children.js', () => ({
  reconcileInheritedChildren: async () => ({ inherited: [], repairBridge: null }),
}));
vi.mock('#src/coordinator-launch/child-process.js', () => ({ spawnAdmittedChild: mocks.spawn }));
vi.mock('#src/coordinator-launch/child-watch.js', () => ({ watchChild: mocks.watch }));
vi.mock('#src/coordinator-launch/active-child-router.js', () => ({
  createActiveChildRouter: (input: { pending: { value: PendingAttempt | null } }) => {
    mocks.pending = input.pending;
    return vi.fn();
  },
}));

it('does not exhaust after two failures, a serving launch, and an unserved promoted contender', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-served-chain-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const owner = { current: { id: 'owner' }, lost: false, release: vi.fn() };
  const incarnation = testIncarnation('supervisor');
  const record = {
    reconcileAdmissions: vi.fn(),
    hasAuthority: () => true,
    normalize: vi.fn(),
    read: vi.fn(() => ({ launch: null as unknown, attempt: null })),
    reserve: vi.fn(() => ({ id: 'selected' })),
    clearHold: vi.fn(),
    childRetirement: vi.fn(),
    release: vi.fn(() => true),
  };
  const child = { exitCode: null, signalCode: null };
  const running = { child, manifest, identity: { pid: 12345, incarnation } };
  const failed = { served: false, exitCode: 1, signal: null, wedged: false };
  mocks.acquire.mockResolvedValue({ record, owner, incarnation, replacement: false });
  mocks.select
    .mockResolvedValueOnce({ kind: 'candidate', candidate: { executable: '/test/backend', buildSetId: 'build-A' } })
    .mockResolvedValueOnce({ kind: 'candidate', candidate: { executable: '/test/backend', buildSetId: 'build-A' } })
    .mockResolvedValueOnce({ kind: 'candidate', candidate: { executable: '/test/backend', buildSetId: 'build-A' } })
    .mockResolvedValue({ kind: 'released' });
  mocks.spawn.mockReturnValue(running);
  mocks.watch
    .mockResolvedValueOnce(failed)
    .mockResolvedValueOnce(failed)
    .mockImplementationOnce(async () => {
      if (mocks.pending === null) throw new Error('Active supervision did not install its router');
      const reservation = { id: 'contender', phase: 'exited', parent: { pid: process.pid, incarnation } };
      record.read.mockReturnValue({ launch: reservation, attempt: null });
      mocks.pending.value = {
        running: { ...running, child: { ...child } },
        reservation,
        watch: Promise.resolve(failed),
      } as PendingAttempt;
      return { ...failed, served: true };
    });
  try {
    expect(await runNamespaceSupervisor('/test/backend', [], runDir)).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    expect(mocks.watch).toHaveBeenCalledTimes(3);
    expect(mocks.select).toHaveBeenCalledTimes(4);
    expect(record.release).not.toHaveBeenCalled();
    expect(owner.release).toHaveBeenCalledOnce();
  } finally {
    process.chdir(cwd);
    process.env = env;
    rmSync(runDir, { recursive: true, force: true });
  }
});
