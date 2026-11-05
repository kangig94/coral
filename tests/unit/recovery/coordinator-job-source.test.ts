import { describe, expect, it } from 'vitest';

import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import { RecoveryContainment } from '#src/recovery/containment.js';
import { executionHarness, EXECUTION_JOB_ID, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';

const signal = new AbortController().signal;

describe('coordinator job recovery discovery', () => {
  it('omits validated terminal history while keeping explicit subject scans available', async () => {
    const h = executionHarness();
    try {
      h.append(openedJob(), requestedExecution());
      h.complete();
      let reads = 0;
      const source = coordinatorJobRecoverySource(h.db, {
        observation: { record: (_source, counts) => (reads += counts.reads ?? 0) },
      });
      expect(await RecoveryContainment.count(source, { signal })).toBe(0);
      expect(reads).toBe(1);
      expect(
        await RecoveryContainment.count(coordinatorJobRecoverySource(h.db, { subjectKey: EXECUTION_JOB_ID }), {
          signal,
        }),
      ).toBe(1);
      h.append(requestedExecution(2));
      expect(await RecoveryContainment.count(coordinatorJobRecoverySource(h.db), { signal })).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it.each([
    ['terminal', '{broken'],
    ['execution_owner', JSON.stringify({ kind: 'future-owner', id: EXECUTION_JOB_ID })],
    ['facet', '{broken'],
    ['phase', 'future-terminal'],
  ])('keeps unreadable terminal %s evidence on the full recovery path', async (column, value) => {
    const h = executionHarness();
    try {
      h.append(openedJob(), requestedExecution());
      h.complete();
      h.db.prepare(`UPDATE projection_jobs SET ${column} = ? WHERE job_id = ?`).run(value, EXECUTION_JOB_ID);
      expect(await RecoveryContainment.count(coordinatorJobRecoverySource(h.db), { signal })).toBe(1);
    } finally {
      h.db.close();
    }
  });
});
