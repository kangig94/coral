import { rmSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { recordPendingProtection, readPendingProtections } from '#src/store/epoch/pending-protection.js';
import { loadReleasedWait } from '#tests/helpers/released-wait.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['v0.10.16', 'v0.10.17'] as const)(
  'keeps unpublished pending-protection stages invisible to current and %s scanners',
  async (tag) => {
    const released = await loadReleasedWait(tag, directories);
    const f = createTerminalExportFixture('provider', true);
    try {
      const write = f.runtime.storage.writeAtomicDurableSync;
      let inspected = false;
      vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, body, options) =>
        write(path, body, {
          ...options,
          beforeRename: () => {
            inspected = true;
            expect(readPendingProtections(f.runtime)).toMatchObject({ records: [], unreadableNames: [] });
            expect(released.readPendingProtections?.(f.runtime)).toMatchObject({ records: [], unreadableNames: [] });
            return true;
          },
        }),
      );
      expect(recordPendingProtection(f.runtime, f.epoch.storeRoot, '1', 'guard held')).toEqual({ kind: 'recorded' });
      expect(inspected).toBe(true);
      expect(readPendingProtections(f.runtime).records).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
