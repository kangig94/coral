import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from '#src/kb/corpus/file-atomic.js';
import { createRealRuntime } from '#src/runtime/real.js';

describe('file-atomic', () => {
  it('should keep the default file mode governed by the process umask', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coral-file-atomic-'));
    const originalUmask = process.umask(0o022);

    try {
      const runtime = createRealRuntime('prod');
      const filePath = join(tempDir, 'atomic-default.md');
      writeFileAtomic({ storagePort: runtime.storage, ids: runtime.ids }, filePath, 'content');

      expect(statSync(filePath).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(originalUmask);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
