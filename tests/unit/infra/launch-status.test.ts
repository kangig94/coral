import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  currentLaunchStatus,
  readLaunchStatus,
  receiveLaunchStatus,
  updateLaunchStatus,
} from '#src/infra/launch-status.js';

describe('launch status diagnostics', () => {
  it('does not resurrect a cleared inherited hold from an unrelated publisher snapshot or serving memory', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-cleared-hold-'));
    try {
      writeFileSync(
        join(runDir, 'launch-status.v1.json'),
        JSON.stringify({
          version: 1,
          inheritedHolds: [{ launchId: 'inherited', pid: 202 }],
          signalHolds: [],
        }),
      );
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        signalHolds: [{ launchId: 'parent:101', pid: 101, incarnation: 'parent' }],
      }));
      writeFileSync(
        join(runDir, 'launch-status.v1.json'),
        JSON.stringify({
          version: 1,
          inheritedHolds: [],
          signalHolds: [{ launchId: 'parent:101', pid: 101, incarnation: 'parent' }],
        }),
      );
      receiveLaunchStatus(runDir, { version: 1, inheritedHolds: [], signalHolds: [] });
      expect(currentLaunchStatus(runDir)?.inheritedHolds).toEqual([]);
      expect(currentLaunchStatus(runDir)?.signalHolds).toHaveLength(1);
      updateLaunchStatus(runDir, (status) => ({ ...status, signalHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { inheritedHolds: [], signalHolds: [] },
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('republishes its current holds after unrelated reconstruction erases the durable status', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-status-republish-'));
    try {
      updateLaunchStatus(runDir, (status) => ({
        ...status,
        hold: { kind: 'custody-unreadable', path: '/custody', retry: 'restore-readable-custody-record' },
        signalHolds: [{ launchId: 'exact', pid: 101, incarnation: 'child' }],
      }));
      writeFileSync(
        join(runDir, 'launch-status.v1.json'),
        JSON.stringify({
          version: 1,
          previousStatus: 'unavailable',
          inheritedHolds: [],
          signalHolds: [],
        }),
      );
      updateLaunchStatus(runDir, (status) => ({ ...status, admissionHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: {
          previousStatus: 'unavailable',
          hold: { path: '/custody' },
          signalHolds: [{ launchId: 'exact' }],
        },
      });
      expect(currentLaunchStatus(runDir)?.publicationFailure).toBeUndefined();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

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

  it('preserves previous-status-unavailable after an unrelated update reconstructs corrupt status', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-status-'));
    try {
      writeFileSync(join(runDir, 'launch-status.v1.json'), '{');
      updateLaunchStatus(runDir, (status) => ({ ...status, signalHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { previousStatus: 'unavailable' },
      });
      updateLaunchStatus(runDir, (status) => ({ ...status, inheritedHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { previousStatus: 'unavailable' },
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
