import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  currentLaunchStatus,
  readLaunchStatus,
  receiveLaunchStatus,
  updateLaunchStatus,
} from '#src/infra/launch-status.js';

describe('launch status diagnostics', () => {
  it.each(['admissionHolds', 'inheritedHealth'] as const)(
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
          : {
              launchId: 'source',
              supervisor: { pid: 101, incarnation: 'parent' },
              child: { pid: 202, incarnation: 'child' },
              observedHealthyAt: 1,
            };
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
