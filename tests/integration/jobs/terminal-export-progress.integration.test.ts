import { JobAddressing } from '#src/jobs/addressing.js';
import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminalExportFixture, TERMINAL_EXPORT_NOW } from '#tests/helpers/terminal-export.js';

it('legacy past-window job: progress-retention signal', () => {
  for (const legacy of [false, true]) {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete({ terminalAt: TERMINAL_EXPORT_NOW - 20 * 86_400_000 });
      if (legacy) {
        const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
        delete stored.terminalAge;
        writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
      }
      rmSync(dirname(f.resultPath), { recursive: true, force: true });
      const owner = f.store.getResultExportOwner();
      const expired = owner.progressRetentionExpired(f.jobId);
      expect(owner.observeResultAvailability(f.jobId).kind).toBe('retained-away');
      expect(expired).toBe(true);
      const addressing = new JobAddressing(
        f.index.readOnlyView(),
        {
          epochKey: () => f.epochKey,
          detail: () => ({
            ...f.store.loadJobProjectionDetail(f.jobId),
            status: f.store.readStatus(f.jobId)!,
            events: [],
            readiness: 'ready' as const,
          }),
          visitProgress: progressVisitFromDetails(() => null),
          abort: () => ({ kind: 'answered' as const, result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'decided',
        undefined,
        (id) => owner.observeResultAvailability(id),
        undefined,
        (id) => owner.progressRetentionExpired(id),
      );
      const snapshot = addressing.snapshot({ jobIds: [f.jobId] });
      expect(snapshot.notices).toContain(`earlier progress for ${f.jobId} is no longer kept`);
    } finally {
      f.close();
    }
  }
});
