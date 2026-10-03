import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readLaunchAdmission, launchAdmissionPath } from '#src/infra/launch-admission-record.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';

import {
  currentLaunchStatus,
  recordControllerEvidenceRefusals,
  parseLaunchStatus,
  readLaunchStatus,
  receiveLaunchStatus,
  updateLaunchStatus,
} from '#src/infra/launch-status.js';

describe('launch status diagnostics', () => {
  it.each(['admissionHolds', 'controllerEvidenceRefusals'] as const)(
    'merges local %s additions and deletions over remote snapshots during publication failure',
    async (key) => {
      vi.useFakeTimers();
      const runDir = mkdtempSync(join(tmpdir(), 'coral-status-local-list-'));
      const lockDir = join(runDir, 'launch-status.v1.lock');
      mkdirSync(lockDir);
      for (const id of ['one', 'two']) writeFileSync(join(lockDir, `owner-${id}.lock`), '{}');
      const entry =
        key === 'admissionHolds'
          ? { path: '/source', disposition: 'unknown' as const }
          : { path: '/source', observation: 'capsule-unreadable' };
      try {
        updateLaunchStatus(runDir, (status) => ({ ...status, [key]: [entry] }));
        receiveLaunchStatus(runDir, { version: 1, [key]: [] });
        expect(currentLaunchStatus(runDir)?.[key]).toEqual([entry]);
        expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
        rmSync(lockDir, { recursive: true });
        await vi.advanceTimersByTimeAsync(200);
        expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { [key]: [entry] } });
        expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
        mkdirSync(lockDir);
        for (const id of ['one', 'two']) writeFileSync(join(lockDir, `owner-${id}.lock`), '{}');
        receiveLaunchStatus(runDir, { version: 1, [key]: [entry] });
        updateLaunchStatus(runDir, (status) => ({ ...status, [key]: [] }));
        receiveLaunchStatus(runDir, { version: 1, [key]: [entry] });
        expect(currentLaunchStatus(runDir)?.[key]).toEqual([]);
        expect(currentLaunchStatus(runDir)?.publicationFailure).toBeDefined();
        rmSync(lockDir, { recursive: true });
        await vi.advanceTimersByTimeAsync(200);
        expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { [key]: [] } });
        expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
        receiveLaunchStatus(runDir, { version: 1, [key]: [entry] });
        expect(currentLaunchStatus(runDir)?.[key]).toEqual([]);
      } finally {
        vi.useRealTimers();
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it('does not let a local diagnostic snapshot hide a newer supervisor hold', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-serving-'));
    try {
      writeFileSync(
        join(runDir, 'launch-status.v1.json'),
        JSON.stringify({
          version: 1,
          hold: { kind: 'custody-unreadable', path: '/old', retry: 'restore-readable-custody-record' },
        }),
      );
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        signalHolds: [{ launchId: 'local', pid: 101, incarnation: 'child' }],
      }));
      receiveLaunchStatus(runDir, {
        version: 1,
        hold: { kind: 'custody-unreadable', path: '/current', retry: 'restore-readable-custody-record' },
      });
      expect(currentLaunchStatus(runDir)).toMatchObject({
        hold: { path: '/current' },
        signalHolds: [{ launchId: 'local' }],
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

it('rejects unsafe launch process identities while accepting additive diagnostics', () => {
  expect(
    parseLaunchStatus({ version: 1, inheritedHolds: [{ launchId: 'launch', pid: Number.MAX_SAFE_INTEGER + 1 }] }),
  ).toBeUndefined();
  expect(
    parseLaunchStatus({ version: 1, inheritedHolds: [{ launchId: 'launch', pid: 100 }], futureDiagnostic: true }),
  ).toMatchObject({ futureDiagnostic: true });
});

it('retains a launch admission with an unsafe process identity as unreadable', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-admission-semantics-'));
  const launchId = '00000000-0000-4000-8000-000000000001';
  const path = launchAdmissionPath(runDir, launchId);
  const admission = {
    version: 1,
    launchId,
    child: { pid: 100, incarnation: 'linux:boot:2' },
    parent: { pid: 200, incarnation: 'linux:boot:3' },
    admittedAt: 1,
    build: { version: '0.10.16', buildSetId: 'build', bundleHash: 'hash', flavor: 'prod' },
    purpose: 'startup',
    futureField: true,
  };
  try {
    mkdirSync(join(runDir, 'launch-admissions.v2'));
    writeFileSync(path, JSON.stringify(admission));
    expect(readLaunchAdmission(runDir, launchId)).toMatchObject({ kind: 'readable', admission: { futureField: true } });
    writeFileSync(
      path,
      JSON.stringify({ ...admission, child: { ...admission.child, pid: Number.MAX_SAFE_INTEGER + 1 } }),
    );
    expect(readLaunchAdmission(runDir, launchId).kind).toBe('unreadable');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('dates a retained capsule refusal even after the same path becomes readable', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-status-history-'));
  const path = join(runDir, 'capsule');
  const observedAt = '2026-10-04T00:00:00.000Z';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(observedAt));
  try {
    recordControllerEvidenceRefusals(runDir, [{ path, observation: 'capsule-unreadable', observedAt }]);
    writeFileSync(path, 'readable');
    vi.advanceTimersByTime(60_000);
    const status = currentLaunchStatus(runDir)!;
    expect(status.controllerEvidenceRefusals).toEqual([{ path, observation: 'capsule-unreadable', observedAt }]);
    const rendered = formatBackendStatus(
      {
        status: 'no_record_no_socket',
        launchStatusSource: 'authenticated-owner',
        controllerEvidenceRefusals: status.controllerEvidenceRefusals,
      },
      { kind: 'absent' },
      null,
    );
    expect(rendered).toContain(`Controller evidence refusal observed ${observedAt} at ${path}`);
    expect(rendered).toContain('This retained observation is history; current readability may have changed.');
    recordControllerEvidenceRefusals(runDir, status.controllerEvidenceRefusals!);
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: { controllerEvidenceRefusals: [{ observedAt }] },
    });
  } finally {
    vi.useRealTimers();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('renders an older refusal as history with an unknown time and retains other subjects', () => {
  const status = parseLaunchStatus({
    version: 1,
    controllerEvidenceRefusals: [{ path: '/other-owner', observation: 'capsule-unreadable', futureKey: true }],
  })!;
  expect(status.controllerEvidenceRefusals?.[0]).toMatchObject({ path: '/other-owner', futureKey: true });
  expect(
    formatBackendStatus(
      { status: 'no_record_no_socket', controllerEvidenceRefusals: status.controllerEvidenceRefusals },
      { kind: 'absent' },
      null,
    ),
  ).toContain('observed at an unknown time at /other-owner');
});
