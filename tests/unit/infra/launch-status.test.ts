import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';

describe('launch status diagnostics', () => {
  it('preserves previous-status-unavailable after an unrelated update reconstructs corrupt status', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-launch-status-'));
    try {
      writeFileSync(join(runDir, 'launch-status.v1.json'), '{');
      updateLaunchStatus(runDir, (status) => ({ ...status, signalHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { previousStatus: 'unavailable' },
      });
      updateLaunchStatus(runDir, (status) => ({ ...status, inheritedHolds: [] }));
      expect(readLaunchStatus(runDir)).toMatchObject({
        kind: 'readable',
        status: { previousStatus: 'unavailable' },
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
