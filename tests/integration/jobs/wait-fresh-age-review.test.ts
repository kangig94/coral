import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

describe('fresh terminal whose post-commit recording did not run, in a store with any pruned journal row', () => {
  it('publishes a fresh terminal recovered after unrelated pruning', () => {
    const f = createTerminalExportFixture('provider');
    fixtures.push(f);

    f.db
      .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
      .run(new Date(f.runtime.time.now()).toISOString(), 'fixture.pruned', 'workflow', 'unrelated', Buffer.from('{}'));
    f.db
      .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
      .run(new Date(f.runtime.time.now()).toISOString(), 'fixture.kept', 'workflow', 'unrelated', Buffer.from('{}'));
    f.db.prepare("DELETE FROM events WHERE type = 'fixture.pruned'").run();

    const seq = commitJobTerminal(f.store, f.jobId, 'session-1', {
      content: 'fresh result',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    const detail = f.store.loadJobProjectionDetail(f.jobId);
    if (!detail.status) throw new Error('no status');

    f.index.recordTerminal(
      f.jobId,
      {
        status: detail.status,
        events: f.store.readJobEvents(f.jobId),
        exit: detail.exit,
        readiness: deriveLaunchReadiness(detail),
      },
      f.resultPath,
      seq,
      f.db,
    );
    f.store.ensureResultArtifact(f.jobId);

    f.advance(30 * 86_400_000);

    expect(existsSync(f.resultPath)).toBe(true);
    expect(f.index.read(f.jobId)?.terminalAge).toMatchObject({ kind: 'known' });
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });
});
