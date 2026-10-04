import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

describe('legacy unknown-age terminal with a pruned export', () => {
  it('releases an unknown-age legacy terminal without recreating its export directory', () => {
    const f = createTerminalExportFixture('provider');
    try {
      f.complete();
      f.store.publishTerminalResult(f.jobId);

      initTestJob(f.store, {
        jobId: 'legacy',
        sessionId: 'legacy',
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      f.db.prepare('DELETE FROM events WHERE seq = 1').run();
      const seq = commitJobTerminal(f.store, 'legacy', 'legacy', {
        content: 'legacy result',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const d = f.store.loadJobProjectionDetail('legacy');
      if (!d.status) throw new Error('no status');
      f.advance(30 * 86_400_000);
      f.index.recordTerminal(
        'legacy',
        {
          status: d.status,
          events: f.store.readJobEvents('legacy'),
          exit: d.exit,
          readiness: deriveLaunchReadiness(d),
        },
        f.index.resultPathFor('legacy'),
        seq,
        f.db,
      );

      const high = (f.db.prepare("SELECT MAX(seq) AS s FROM events WHERE stream_kind = 'job'").get() as { s: number })
        .s;
      expect(f.index.certify(f.epochKey, high)?.jobIds).toEqual([f.jobId, 'legacy']);
      expect(existsSync(f.index.resultPathFor('legacy'))).toBe(false);

      expect(f.index.resultsReleased(f.epochKey)).toBe(true);
      f.advance(400 * 86_400_000);
      const sync = vi.spyOn(f.runtime.storage, 'syncDirectoryDurableSync');
      for (let sweep = 0; sweep < 3; sweep++) expect(f.index.resultsReleased(f.epochKey)).toBe(true);
      expect(sync).not.toHaveBeenCalled();
      expect(existsSync(f.index.resultPathFor('legacy'))).toBe(false);
    } finally {
      f.close();
    }
  });
});
