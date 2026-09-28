import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
import { coordinatorLaunchPath } from '#src/infra/path/index.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';

describe('coordinator launch durable compatibility', () => {
  it('preserves unknown request and launch fields through their transitions', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-nested-shape-'));
    try {
      const record = new CoordinatorLaunchRecord(runDir);
      const now = Date.now();
      const owner = record.acquire(
        {
          id: 'owner',
          process: { pid: 1, incarnation: 'known-process' as ProcessIncarnation },
          buildSetId: 'known-build',
        },
        now,
      );
      if (owner === null) throw new Error('owner was not acquired');
      const request = record.request('/known/backend', 'known-build');
      const reservation = record.reserve(owner, 'known-build', 'startup', now);
      if (reservation === null) throw new Error('launch was not reserved');
      record.close();

      const database = new DatabaseSync(coordinatorLaunchPath(runDir));
      const row = database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
      const state = JSON.parse(row.state) as {
        launch: Record<string, unknown>;
        requests: Record<string, unknown>[];
      };
      state.launch.futureAdmissionProof = { generation: 2 };
      state.requests[0].futureRequestProof = { generation: 3 };
      database.prepare('UPDATE control SET state = ? WHERE id = 1').run(JSON.stringify(state));
      database.close();

      const reopened = new CoordinatorLaunchRecord(runDir);
      const child = { pid: 2, incarnation: 'known-child' as ProcessIncarnation };
      expect(reopened.accept(owner, request.id, now + 1)).toBe(true);
      expect(reopened.admit(reservation, owner.process, child, now + 1)).toBe(true);
      expect(reopened.serving(reservation, child)).toBe(true);
      expect(reopened.complete(owner, request.id, now + 1)).toBe(true);
      expect(reopened.exited(reservation, child)).toBe(true);
      const settled = reopened.read();
      expect((settled.launch as unknown as Record<string, unknown>).futureAdmissionProof).toEqual({ generation: 2 });
      expect((settled.requests[0] as unknown as Record<string, unknown>).futureRequestProof).toEqual({
        generation: 3,
      });
      reopened.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('preserves an unknown owner field while renewing the lease', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-owner-shape-'));
    try {
      const record = new CoordinatorLaunchRecord(runDir);
      const owner = record.acquire(
        {
          id: 'owner',
          process: { pid: 1, incarnation: 'known-process' as ProcessIncarnation },
          buildSetId: 'known-build',
        },
        1_000,
      );
      if (owner === null) throw new Error('owner was not acquired');
      record.close();

      const database = new DatabaseSync(coordinatorLaunchPath(runDir));
      const row = database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
      const state = JSON.parse(row.state) as { owner: Record<string, unknown> | null };
      if (state.owner === null) throw new Error('durable owner is missing');
      state.owner.futureLeaseProof = { generation: 2 };
      database.prepare('UPDATE control SET state = ? WHERE id = 1').run(JSON.stringify(state));
      database.close();

      const reopened = new CoordinatorLaunchRecord(runDir);
      expect(reopened.renew(owner, 1_001)).not.toBeNull();
      expect((reopened.read().owner as unknown as Record<string, unknown>).futureLeaseProof).toEqual({ generation: 2 });
      reopened.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
