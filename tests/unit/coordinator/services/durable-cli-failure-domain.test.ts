import type { JobStore } from '#src/jobs/store.js';
import { observeRecordedContainment, reapRecordedContainment } from '#src/infra/process-containment.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { expect, it, vi } from 'vitest';
import { durableCliFailureDomain } from '#src/coordinator/services/durable-cli-failure-domain.js';
import {
  recordDurableCliExecution,
  readDurableCliExecution,
  readDurableCliExecutionReceipt,
  markDurableCliExecutionEntered,
} from '#src/jobs/durable-cli-execution.js';
import { writeDurableCliProvisionalProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const jobId = '00000000-0000-4000-8000-000000000001';
const identity = { pid: 100, incarnation: testIncarnation(1) };

function setup() {
  const runtime = new SimulationRuntime();
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  const lookup = vi.spyOn(runtime.process, 'failureDomainContainment');
  const db = newRawDatabase(':memory:');
  db.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE projection_jobs (job_id TEXT, execution INTEGER, phase TEXT)',
  );
  return { runtime, lookup, db };
}

it('uses the immutable process-execution association without reading the latest ordinal', () => {
  const { runtime, lookup, db } = setup();
  try {
    recordDurableCliExecution(db, { jobId, execution: 1, ...identity });
    db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?)').run(jobId, 2, 'launching');
    const populated = {
      observe: () => ({ kind: 'populated' as const }),
      kill: vi.fn(() => ({ kind: 'entered' as const })),
    };
    lookup.mockImplementation((name) => (name === `job-${jobId}-1` ? populated : undefined));
    expect(durableCliFailureDomain(runtime, db, jobId, identity)?.observe().kind).toBe('populated');
    expect(lookup).toHaveBeenCalledExactlyOnceWith(`job-${jobId}-1`);
    expect(populated.kill).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it.each(['launching', 'failed'])(
  'uses legacy process evidence when execution 2 is %s and no association exists',
  (phase) => {
    const { runtime, lookup, db } = setup();
    try {
      writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...identity, processGroupId: identity.pid });
      db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?)').run(jobId, 2, phase);
      const domain = durableCliFailureDomain(runtime, db, jobId, identity);
      expect(domain).toBeUndefined();
      expect(durableCliFailureDomain(runtime, db, jobId)?.observe().kind).toBe('unresolved');
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it('never reassigns a recorded process incarnation to a newer execution', () => {
  const { db } = setup();
  try {
    recordDurableCliExecution(db, { jobId, execution: 1, ...identity });
    recordDurableCliExecution(db, { jobId, execution: 1, ...identity });
    expect(() => recordDurableCliExecution(db, { jobId, execution: 2, ...identity })).toThrow(/conflicts/);
    expect(readDurableCliExecution(db, jobId, identity)).toBe(1);
  } finally {
    db.close();
  }
});

it('treats unreadable identity association as unknown without a speculative leaf lookup', () => {
  const { runtime, lookup, db } = setup();
  try {
    expect(durableCliFailureDomain(runtime, db, jobId)?.observe().kind).toBe('unresolved');
    recordDurableCliExecution(db, { jobId, execution: 1, ...identity });
    db.prepare('UPDATE meta SET value = ?').run('not-json');
    const domain = durableCliFailureDomain(runtime, db, jobId, identity);
    expect(domain?.observe().kind).toBe('unresolved');
    expect(domain?.kill().kind).toBe('refused');
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('settles a legacy record with no receipt when every recorded process and group is absent', async () => {
  const { runtime, lookup, db } = setup();
  try {
    const clock = createMonotonicClock(Symbol('legacy-job'));
    const environment = {
      failureDomain: durableCliFailureDomain(runtime, db, jobId, identity),
      process: {
        kill: vi.fn(() => true),
        observeLiveness: () => 'absent' as const,
        observeRecordedProcessAsync: async () => 'absent' as const,
      },
      platform: 'linux' as const,
      readProcessIncarnation: () => null,
      clock,
      maxRecordedRoots: 0,
    };
    const containment = { ...identity, processGroupId: identity.pid };
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment).kind).toBe('absent');
    await expect(
      reapRecordedContainment(containment, [], clock.shiftMilliseconds(clock.now(), 2000), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(lookup).not.toHaveBeenCalled();
    expect(environment.process.kill).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('never chooses the latest job leaf without an expected recorded process identity', () => {
  const { runtime, lookup, db } = setup();
  const later = { pid: 200, incarnation: testIncarnation(2) };
  const kill = vi.fn(() => ({ kind: 'entered' as const }));
  try {
    writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...later, processGroupId: later.pid });
    recordDurableCliExecution(db, { jobId, execution: 2, ...later });
    db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?)').run(jobId, 2, 'launching');
    lookup.mockReturnValue({ observe: () => ({ kind: 'absent' }), kill });
    const failureDomain = durableCliFailureDomain(runtime, db, jobId);
    expect(failureDomain?.observe().kind).toBe('unresolved');
    expect(failureDomain?.kill().kind).toBe('refused');
    expect(
      observeRecordedContainment(
        { ...identity, processGroupId: identity.pid, childRoot: null },
        {
          failureDomain,
          platform: 'linux',
          process: { observeLiveness: () => 'absent' },
          readProcessIncarnation: () => null,
        },
      ).kind,
    ).toBe('unobservable');
    expect(kill).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it.each(['planned', 'entered'] as const)('uses empty leaf authority only for an %s receipt', async (phase) => {
  const { runtime, lookup, db } = setup();
  try {
    const record = { jobId, execution: 1, ...identity };
    recordDurableCliExecution(db, record);
    if (phase === 'entered') markDurableCliExecutionEntered(db, record);
    const kill = vi.fn(() => ({ kind: 'entered' as const }));
    lookup.mockReturnValue({ observe: () => ({ kind: 'absent' }), kill });
    const failureDomain = durableCliFailureDomain(runtime, db, jobId, identity);
    const clock = createMonotonicClock(Symbol('entry-evidence'));
    const environment = {
      failureDomain,
      clock,
      maxRecordedRoots: 0,
      platform: 'linux' as const,
      process: {
        kill: vi.fn(() => true),
        observeLiveness: (pid: number) => (pid < 0 ? ('alive' as const) : ('absent' as const)),
        observeRecordedProcessAsync: async () => 'absent' as const,
      },
      readProcessIncarnation: () => null,
    };
    expect(readDurableCliExecutionReceipt(db, jobId, identity)?.phase).toBe(phase);
    const observed = observeRecordedContainment(
      { ...identity, processGroupId: identity.pid, childRoot: null },
      environment,
    );
    if (phase === 'entered') expect(observed.kind).toBe('absent');
    else expect(observed.kind).not.toBe('absent');
    await expect(
      reapRecordedContainment(
        { ...identity, processGroupId: identity.pid },
        [],
        clock.shiftMilliseconds(clock.now(), 2000),
        environment,
      ),
    ).resolves.toMatchObject({
      kind: phase === 'entered' ? 'containment-absent' : 'recorded-group-unattributable',
    });
    expect(failureDomain?.hasEntered?.()).toBe(phase === 'entered');
    expect(kill).not.toHaveBeenCalled();
    expect(environment.process.kill).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('retains planned evidence after entry when the entered write fails and vetoes populated trees', async () => {
  const { runtime, lookup, db } = setup();
  try {
    const record = { jobId, execution: 1, ...identity };
    recordDurableCliExecution(db, record);
    db.exec("CREATE TRIGGER refuse_entry BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'entered write failed'); END");
    expect(() => markDurableCliExecutionEntered(db, record)).toThrow(/entered write failed/);
    const kill = vi.fn(() => ({ kind: 'refused' as const, errno: 'EACCES' }));
    lookup.mockReturnValue({ observe: () => ({ kind: 'populated' }), kill });
    const failureDomain = durableCliFailureDomain(runtime, db, jobId, identity);
    expect(failureDomain?.hasEntered?.()).toBe(false);
    expect(readDurableCliExecutionReceipt(db, jobId, identity)?.phase).toBe('planned');
    const clock = createMonotonicClock(Symbol('planned-population'));
    const result = await reapRecordedContainment(
      { ...identity, processGroupId: identity.pid },
      [],
      clock.shiftMilliseconds(clock.now(), 2000),
      {
        failureDomain,
        clock,
        maxRecordedRoots: 0,
        platform: 'linux',
        process: {
          kill: vi.fn(() => true),
          observeLiveness: () => 'absent',
          observeRecordedProcessAsync: async () => 'absent',
        },
        readProcessIncarnation: () => null,
      },
    );
    expect(result.kind).not.toBe('containment-absent');
  } finally {
    db.close();
  }
});

it('preserves entered evidence when ready publication repeats the planned receipt', () => {
  const { db } = setup();
  try {
    const record = { jobId, execution: 1, ...identity };
    recordDurableCliExecution(db, record);
    markDurableCliExecutionEntered(db, record);
    recordDurableCliExecution(db, record);
    expect(readDurableCliExecutionReceipt(db, jobId, identity)?.phase).toBe('entered');
  } finally {
    db.close();
  }
});

it('retains positive entry proof through later unreadable receipt data', () => {
  const { runtime, lookup, db } = setup();
  try {
    const record = { jobId, execution: 1, ...identity };
    recordDurableCliExecution(db, record);
    markDurableCliExecutionEntered(db, record);
    lookup.mockReturnValue({ observe: () => ({ kind: 'absent' }), kill: () => ({ kind: 'entered' }) });
    const domain = durableCliFailureDomain(runtime, db, jobId, identity);
    expect(domain?.hasEntered?.()).toBe(true);
    db.prepare('UPDATE meta SET value = ?').run('unreadable');
    expect(domain?.hasEntered?.()).toBe(true);
  } finally {
    db.close();
  }
});

it('carries entered proof through the recovery observation adapter when the leaf is empty', async () => {
  const { observeDurableRecoveryContainmentFor } = await import('#src/coordinator/services/recovery/lifecycle.js');
  const { runtime, lookup, db } = setup();
  try {
    const record = { jobId, execution: 1, ...identity };
    writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...identity, processGroupId: identity.pid });
    recordDurableCliExecution(db, record);
    markDurableCliExecutionEntered(db, record);
    lookup.mockReturnValue({ observe: () => ({ kind: 'absent' }), kill: () => ({ kind: 'entered' }) });
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) => (pid < 0 ? 'alive' : 'absent'));
    const progressStore = { getDb: () => db } as JobStore;
    const proof = observeDurableRecoveryContainmentFor(progressStore, runtime, jobId, {
      transport: 'durable-cli',
      pid: identity.pid,
      stdoutPath: '/stdout',
      stderrPath: '/stderr',
      startTime: 'now',
    });
    expect(proof.observation.kind).toBe('absent');
    expect(proof.refresh().kind).toBe('absent');
    expect(proof.permitsIndependentAbsenceDecision()).toBe(true);
  } finally {
    db.close();
  }
});

it.each(['planned', 'entered'] as const)(
  'retains validated %s receipt authority after its database closes',
  (phase) => {
    const { runtime, lookup, db } = setup();
    const record = { jobId, execution: 1, ...identity };
    recordDurableCliExecution(db, record);
    if (phase === 'entered') markDurableCliExecutionEntered(db, record);
    lookup.mockReturnValue({ observe: () => ({ kind: 'absent' }), kill: () => ({ kind: 'refused', errno: 'EPERM' }) });
    const failureDomain = durableCliFailureDomain(runtime, db, jobId, identity);
    db.close();
    expect(failureDomain?.hasEntered?.()).toBe(phase === 'entered');
    expect(
      observeRecordedContainment(
        { ...identity, processGroupId: identity.pid, childRoot: null },
        {
          failureDomain,
          platform: 'linux',
          process: { observeLiveness: (pid) => (pid < 0 ? 'alive' : 'absent') },
          readProcessIncarnation: () => null,
        },
      ).kind,
    ).toBe(phase === 'entered' ? 'absent' : 'alive');
  },
);
