import { rmSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Database } from '#src/store/db.js';
import * as epochObservation from '#src/store/epoch/observation.js';
import { withTerminalSource, readAcceptedTerminal } from '#src/jobs/terminal/source.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

it.each(['present', 'absent', 'identity mismatch', 'open failure'])(
  'only observed source absence returns null: %s',
  (scenario) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete();
      if (scenario === 'absent') rmSync(f.epoch.path);
      if (scenario === 'identity mismatch')
        vi.spyOn(epochObservation, 'inspectResolvedStoreEpochKey').mockReturnValue('other epoch');
      if (scenario === 'open failure')
        vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
          throw new Error('temporary open failure');
        });
      const read = vi.fn((db: Database) => readAcceptedTerminal(db, f.jobId)?.type);
      const observe = () => withTerminalSource(f.runtime, f.epochKey, read);
      if (scenario === 'present') {
        expect(observe()).toBe('job.terminal.recorded');
        expect(read).toHaveBeenCalledTimes(1);
      } else if (scenario === 'absent') {
        expect(observe()).toBeNull();
        expect(read).not.toHaveBeenCalled();
      } else expect(observe).toThrow();
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
);
