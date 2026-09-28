import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
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
