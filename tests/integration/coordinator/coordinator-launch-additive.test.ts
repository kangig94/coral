import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
import { getBackendStatusFull } from '#src/cli/backend-status.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { coordinatorLaunchPath } from '#src/infra/path/index.js';

it('keeps additive SQLite columns and JSON fields across a launch-state transition', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-additive-'));
  const record = new CoordinatorLaunchRecord(runDir);
  const database = new DatabaseSync(coordinatorLaunchPath(runDir));
  try {
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
    const request = record.request('/fixture', 'A');
    database.exec('ALTER TABLE control ADD COLUMN future_column TEXT');
    database.prepare('UPDATE control SET future_column = ? WHERE id = 1').run('keep');
    const state = record.read();
    database.prepare('UPDATE control SET state = ? WHERE id = 1').run(
      JSON.stringify({
        ...state,
        futureState: 'keep',
        launch: { ...state.launch, futureLaunch: 'keep' },
        requests: state.requests.map((entry) => ({ ...entry, futureRequest: 'keep' })),
      }),
    );
    expect(record.holdReplacementSignalRefusal(source, replacement)).toBe(true);
    expect(record.accept(owner, request.id, 1_002)).toBe(true);
    expect(record.read()).toMatchObject({
      futureState: 'keep',
      launch: { futureLaunch: 'keep' },
      requests: [{ futureRequest: 'keep', status: 'accepted' }],
      signalHolds: [{ launchId: `replacement:${replacement.pid}:${replacement.incarnation}`, ...replacement }],
    });
    expect(
      (database.prepare('SELECT future_column FROM control WHERE id = 1').get() as { future_column: string })
        .future_column,
    ).toBe('keep');
  } finally {
    database.close();
    record.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('preserves an inherited hold from the previous state shape when another hold is written', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-inherited-hold-'));
  const record = new CoordinatorLaunchRecord(runDir);
  const database = new DatabaseSync(coordinatorLaunchPath(runDir));
  try {
    const owner = record.acquire(
      { id: 'supervisor', process: { pid: 101, incarnation: 'supervisor' as ProcessIncarnation }, buildSetId: 'A' },
      1_000,
    );
    if (owner === null) throw new Error('Owner was not admitted');
    const launch = record.reserve(owner, 'A', 'startup', 1_000);
    if (launch === null) throw new Error('Launch was not reserved');
    const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
    expect(record.admit(launch, owner.process, child, 1_001)).toBe(true);
    database.prepare('UPDATE control SET state = ? WHERE id = 1').run(
      JSON.stringify({
        ...record.read(),
        hold: { kind: 'inherited-child-unresponsive', launchId: launch.id, pid: 201 },
      }),
    );
    record.holdTarget(owner, 'request-1', 1_002);
    expect(record.read().hold).toEqual({ kind: 'target-indeterminate', requestId: 'request-1' });
    expect(record.read().inheritedHolds).toEqual([{ launchId: launch.id, pid: 201 }]);
  } finally {
    database.close();
    record.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('forwards every durable launch hold through backend status', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coral-launch-status-'));
  const previousHome = process.env.HOME;
  const previousTmpdir = process.env.TMPDIR;
  process.env.HOME = home;
  process.env.TMPDIR = home;
  try {
    const runDir = createRealRuntime('prod').paths.coral.coordinator.runDir;
    const record = new CoordinatorLaunchRecord(runDir);
    try {
      const owner = record.acquire(
        {
          id: 'supervisor',
          process: { pid: process.pid, incarnation: 'supervisor' as ProcessIncarnation },
          buildSetId: 'A',
        },
        Date.now(),
      );
      if (owner === null) throw new Error('owner not admitted');
      record.holdTarget(owner, 'request-1', Date.now());
      const target = await getBackendStatusFull('/plugin-root');
      expect(target.launchHold).toEqual({ kind: 'target-indeterminate', requestId: 'request-1' });
      expect(formatBackendStatus(target, { kind: 'absent' }, null)).toContain('request-1');

      const launch = record.reserve(owner, 'A', 'startup', Date.now());
      if (launch === null) throw new Error('launch not reserved');
      const child = { pid: 201, incarnation: 'child' as ProcessIncarnation };
      expect(record.admit(launch, owner.process, child, Date.now())).toBe(true);
      record.holdInheritedChild(owner, { ...launch, child }, Date.now());
      const inherited = await getBackendStatusFull('/plugin-root');
      expect(inherited.launchInheritedHolds).toEqual([{ launchId: launch.id, pid: 201 }]);
      expect(formatBackendStatus(inherited, { kind: 'absent' }, null)).toContain(launch.id);
      expect(formatBackendStatus(inherited, { kind: 'absent' }, null)).not.toContain('Run the start command below');
    } finally {
      record.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(home, { recursive: true, force: true });
  }
});

it('reports an unreadable launch record separately from an absent record', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coral-unreadable-launch-status-'));
  const previousHome = process.env.HOME;
  const previousTmpdir = process.env.TMPDIR;
  process.env.HOME = home;
  process.env.TMPDIR = home;
  try {
    const runDir = createRealRuntime('prod').paths.coral.coordinator.runDir;
    const absent = await getBackendStatusFull('/plugin-root');
    expect(absent.launchRecordProblem).toBeUndefined();
    const record = new CoordinatorLaunchRecord(runDir);
    record.close();
    writeFileSync(coordinatorLaunchPath(runDir), 'invalid sqlite');
    const unreadable = await getBackendStatusFull('/plugin-root');
    expect(unreadable.launchRecordProblem).toBe('unreadable');
    expect(formatBackendStatus(unreadable, { kind: 'absent' }, null)).toContain(
      'Coordinator launch record is unreadable',
    );
    expect(formatBackendStatus(unreadable, { kind: 'absent' }, null)).not.toContain('Run the start command below');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(home, { recursive: true, force: true });
  }
});
