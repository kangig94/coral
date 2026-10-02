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
  it.each(['admissionHolds'] as const)(
    'merges local %s additions and deletions over remote snapshots during publication failure',
    async (key) => {
      vi.useFakeTimers();
      const runDir = mkdtempSync(join(tmpdir(), 'coral-status-local-list-'));
      const lockDir = join(runDir, 'launch-status.v1.lock');
      mkdirSync(lockDir);
      for (const id of ['one', 'two']) writeFileSync(join(lockDir, `owner-${id}.lock`), '{}');
      const entry = { path: '/source', disposition: 'unknown' as const };
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
