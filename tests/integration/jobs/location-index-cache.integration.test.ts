import { expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminalExportFixture, TERMINAL_EXPORT_NOW } from '#tests/helpers/terminal-export.js';

it('cost of a no-op repair for an expired, retained-away job', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_NOW - 20 * 86_400_000 });
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    const owner = f.store.getResultExportOwner();

    owner.ensureResultMarkdownArtifact(f.jobId);
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
    for (let i = 0; i < 32; i++) owner.ensureResultMarkdownArtifact(f.jobId);
    expect(open).not.toHaveBeenCalled();
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('retained-away');
  } finally {
    f.close();
  }
});
