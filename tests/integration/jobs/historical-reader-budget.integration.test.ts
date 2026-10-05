import { it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { resultPathFor } from '#src/jobs/terminal/export.js';

it('one 16-subject sweep slice reads every retained location of an uncertified epoch', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const ids: string[] = [f.jobId];
    f.complete();
    for (let i = 0; i < 17; i++) {
      const jobId = `job-x${i}`;
      initTestJob(f.store, {
        jobId,
        sessionId: `s-${i}`,
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      const seq = commitJobTerminal(f.store, jobId, `s-${i}`, {
        content: 'x',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const d = f.store.loadJobProjectionDetail(jobId);
      f.index.recordTerminal(
        jobId,
        { status: d.status!, events: f.store.readJobEvents(jobId), exit: d.exit, readiness: deriveLaunchReadiness(d) },
        f.index.resultPathFor(jobId),
        seq,
        f.db,
        true,
      );
      ids.push(jobId);
    }
    for (const id of ids) {
      const p = resultPathFor(f.runtime.paths.coral.exports.jobsRoot, id);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'r');
    }
    // restart: fresh index, epoch not certified
    const restarted = new JobLocationIndex(f.runtime, f.root);
    const read = vi.spyOn(restarted, 'read');
    const budget = { remaining: 16 };
    const result = seedHistoricalEpoch(
      f.runtime,
      restarted,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
      [],
      false,
      budget,
    );

    expect(result.kind).toBe('uncertified');
    expect(budget.remaining).toBe(0);
    expect(read.mock.calls.length).toBeLessThanOrEqual(16);
  } finally {
    f.close();
  }
});
