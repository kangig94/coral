import { expect, it } from 'vitest';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

it('an undecodable launch row cannot stop recovery of the rows after it', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    f.index.markUncertified(f.jobId);
    f.db
      .prepare(
        "INSERT INTO events(seq, ts, type, stream_kind, stream_id, body) VALUES (0, ?, 'job.launch.requested', 'job', 'job-0', ?)",
      )
      .run(new Date(TERMINAL_EXPORT_CUTOFF).toISOString(), Buffer.from('not json'));
    expect(() => recoverJobLocations(f.index, f.epochKey, f.store)).toThrow();
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(f.index.unknownLocationHold(f.epochKey)).not.toBeNull();
  } finally {
    f.close();
  }
});
