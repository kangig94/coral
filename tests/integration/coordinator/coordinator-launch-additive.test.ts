import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { getBackendStatusFull } from '#src/cli/backend-status.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';
import { launchAdmissionPath } from '#src/infra/launch-admission-record.js';
import { readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { createRealRuntime } from '#src/runtime/real.js';

it('preserves unknown diagnostic fields when another launch hold is written', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-status-additive-'));
  try {
    const path = join(runDir, 'launch-status.v1.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        futureStatus: { generation: 2 },
        inheritedHolds: [{ launchId: 'launch-1', pid: 201 }],
        signalHolds: [],
        hold: { kind: 'inherited-child-unresponsive', launchId: 'launch-1', pid: 201 },
      }),
    );
    updateLaunchStatus(runDir, (status) => ({
      ...status,
      hold: { kind: 'target-indeterminate', requestId: 'request-1' },
    }));
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: {
        futureStatus: { generation: 2 },
        hold: { kind: 'target-indeterminate', requestId: 'request-1' },
        inheritedHolds: [{ launchId: 'launch-1', pid: 201 }],
      },
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('forwards every durable exact-child hold through backend status', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coral-launch-status-'));
  const previousHome = process.env.HOME;
  const previousTmpdir = process.env.TMPDIR;
  process.env.HOME = home;
  process.env.TMPDIR = home;
  try {
    const runDir = createRealRuntime('prod').paths.coral.coordinator.runDir;
    mkdirSync(runDir, { recursive: true });
    updateLaunchStatus(runDir, () => ({
      version: 1,
      hold: { kind: 'target-indeterminate', requestId: 'request-1' },
      inheritedHolds: [{ launchId: 'launch-1', pid: 201 }],
      signalHolds: [
        { launchId: 'launch-1', pid: 201, incarnation: 'child' },
        { launchId: 'replacement:301:replacement', pid: 301, incarnation: 'replacement' },
      ],
    }));
    const status = await getBackendStatusFull('/plugin-root');
    expect(status.launchHold).toEqual({ kind: 'target-indeterminate', requestId: 'request-1' });
    expect(status.launchInheritedHolds).toEqual([{ launchId: 'launch-1', pid: 201 }]);
    expect(status.launchSignalHolds).toHaveLength(2);
    const rendered = formatBackendStatus(status, { kind: 'absent' }, null);
    expect(rendered).toContain('request-1');
    expect(rendered).toContain('launch-1');
    expect(rendered).not.toContain('Run the start command below');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(home, { recursive: true, force: true });
  }
});

it('reports unreadable diagnostics and admission identity without using either as a boot veto', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coral-unreadable-launch-status-'));
  const previousHome = process.env.HOME;
  const previousTmpdir = process.env.TMPDIR;
  process.env.HOME = home;
  process.env.TMPDIR = home;
  try {
    const runDir = createRealRuntime('prod').paths.coral.coordinator.runDir;
    mkdirSync(runDir, { recursive: true });
    const absent = await getBackendStatusFull('/plugin-root');
    expect(absent.launchStatusProblem).toBeUndefined();
    writeFileSync(join(runDir, 'launch-status.v1.json'), 'unreadable');
    const unreadable = await getBackendStatusFull('/plugin-root');
    expect(unreadable.launchStatusProblem).toBe('unreadable');
    expect(formatBackendStatus(unreadable, { kind: 'absent' }, null)).toContain(
      'cannot authorize a signal or prevent startup',
    );
    const launchId = '00000000-0000-4000-8000-000000000001';
    mkdirSync(join(runDir, 'launch-admissions.v2'));
    writeFileSync(launchAdmissionPath(runDir, launchId), 'unreadable');
    const admission = await getBackendStatusFull('/plugin-root');
    expect(admission.launchHold).toEqual({ kind: 'admission-unreadable', path: launchAdmissionPath(runDir, launchId) });
    expect(formatBackendStatus(admission, { kind: 'absent' }, null)).toContain(
      'cannot veto startup or authorize a signal',
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(home, { recursive: true, force: true });
  }
});
